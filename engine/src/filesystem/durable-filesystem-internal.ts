import { AsyncLocalStorage } from "node:async_hooks";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { hasErrorCode, HarnessError } from "../kernel/errors.ts";
import { canonicalHash, deepFreeze, sha256 } from "../kernel/integrity.ts";
import { hasSecondName } from "./link-containment.ts";
import { ownedSiblingTemporaryName } from "./private-state.ts";
import {
  compilePinnedProcessProfile,
  runPinnedProcess,
  withBorrowedPinnedProcessBinding,
  withPinnedProcessExecutable,
  type PinnedProcessExecutable,
} from "../process/pinned-process-internal.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { currentAdmittedNodeRuntime } from "../runtime/admitted-node-runtime.ts";
import { isPromiseLike } from "../shared/type-guards.ts";
import type {
  DurableDirectory,
  DurableDirectoryEntry,
  DurableDirectoryIdentity,
  DurableDirectoryRequest,
  DurableExclusiveCreate,
  DurableFileRead,
} from "./durable-filesystem-contracts.ts";
import {
  acceptPinnedDirectoryMutation,
  closePinnedPathChain,
  openPinnedAbsoluteFile,
  openPinnedDirectoryChild,
  openPinnedRepositoryAncestorChain,
  pinnedDescriptorChildPath,
  pinnedDescriptorPath,
  recheckPinnedPathChain,
  samePinnedPathIdentity,
  sameStablePinnedPathIdentity,
  type PinnedRepositoryPathChain,
} from "./pinned-path-internal.ts";

type HeldDirectoryState = {
  active: boolean;
  descriptor: number;
  fileMutationRequested: boolean;
  identity: BigIntStats;
  lexicalPath: string;
  rootDevice: bigint;
};

type MechanismTestRuntimeState = {
  active: boolean;
  executable: PinnedProcessExecutable;
};

type DurableDirectorySession = {
  chain: PinnedRepositoryPathChain;
  closed: boolean;
  directory: DurableDirectory;
  held: DurableDirectory[];
  requestedPath: string;
};

export type PrivateDirectoryWorkerResult = Readonly<{
  disposition: "created" | "existing";
  identity?: Readonly<{
    device: string;
    inode: string;
    ownerUid: string;
    ownerGid: string;
    mode: string;
  }>;
}>;

const POLICY = ROOT_POLICY.filesystemInfrastructure.privateState;
const WORKER = POLICY.directoryWorker;
const HARNESS_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const HELD_DIRECTORIES = new WeakMap<DurableDirectory, HeldDirectoryState>();
const MECHANISM_TEST_RUNTIME = new AsyncLocalStorage<MechanismTestRuntimeState>();

type FilesystemRuntimeHandle = Readonly<{ executable: PinnedProcessExecutable }>;

function currentFilesystemRuntime(): FilesystemRuntimeHandle | undefined {
  const admitted = currentAdmittedNodeRuntime();
  if (admitted !== undefined && admitted.active) {
    return { executable: admitted.executable };
  }
  const mechanismTest = MECHANISM_TEST_RUNTIME.getStore();
  if (mechanismTest !== undefined && mechanismTest.active) {
    return { executable: mechanismTest.executable };
  }
  return undefined;
}

export function withDurableDirectoryInternal<Result>(
  request: DurableDirectoryRequest,
  operation: (directory: DurableDirectory) => Result extends PromiseLike<unknown> ? never : Result,
): Result {
  const session = openDurableDirectorySession(request);
  try {
    const result = operation(session.directory);
    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch(() => undefined);
      throw filesystemError("filesystem_async_callback_requires_async_api", session.requestedPath);
    }
    revalidateDurableDirectorySession(session);
    return result;
  } finally {
    closeDurableDirectorySession(session);
  }
}

export async function withDurableDirectoryAsyncInternal<Result>(
  request: DurableDirectoryRequest,
  operation: (directory: DurableDirectory) => PromiseLike<Result>,
): Promise<Result> {
  const session = openDurableDirectorySession(request);
  try {
    const result = await operation(session.directory);
    revalidateDurableDirectorySession(session);
    return result;
  } finally {
    closeDurableDirectorySession(session);
  }
}

function openDurableDirectorySession(request: DurableDirectoryRequest): DurableDirectorySession {
  validateDirectoryRequest(request);
  const chain = openPinnedRepositoryAncestorChain(request.absoluteRoot, ".", "root-is-boundary");
  const held: DurableDirectory[] = [];
  try {
    let descriptor = chain.descriptors.at(-1)!;
    let identity = chain.identities.at(-1)!;
    let lexicalPath = request.absoluteRoot;
    held.push(holdDirectory(
      descriptor,
      identity,
      lexicalPath,
      chain.rootDevice,
      request.create && request.relativeSegments.length === 0,
    ));
    for (const [segmentIndex, segment] of request.relativeSegments.entries()) {
      validateSegment(segment);
      lexicalPath = join(lexicalPath, segment);
      const path = pinnedDescriptorChildPath(descriptor, segment);
      if (lstatSync(path, { bigint: true, throwIfNoEntry: false }) === undefined) {
        if (!request.create) throw filesystemError("filesystem_directory_missing", lexicalPath);
        createPrivateDirectoryWithHeldParentInternal(held.at(-1)!, segment);
        if (descriptor === chain.descriptors.at(-1)) {
          acceptPinnedDirectoryMutation(chain, chain.descriptors.length - 1, lexicalPath);
        }
      }
      const child = openPinnedDirectoryChild(descriptor, segment, lexicalPath);
      assertPrivateDirectory(child.identity, lexicalPath, chain.rootDevice);
      descriptor = child.descriptor;
      identity = child.identity;
      held.push(holdDirectory(
        descriptor,
        identity,
        lexicalPath,
        chain.rootDevice,
        request.create && segmentIndex === request.relativeSegments.length - 1,
      ));
    }
    recheckPinnedPathChain(chain, request.relativeSegments.join("/") || ".");
    return {
      chain,
      closed: false,
      directory: held.at(-1)!,
      held,
      requestedPath: request.relativeSegments.join("/") || ".",
    };
  } catch (error) {
    const session = { chain, closed: false, directory: held.at(-1)!, held,
      requestedPath: request.relativeSegments.join("/") || "." };
    closeDurableDirectorySession(session);
    throw error;
  }
}

function revalidateDurableDirectorySession(session: DurableDirectorySession): void {
  for (const directory of session.held) {
    const state = requireHeldDirectory(directory);
    const lexical = lstatSync(state.lexicalPath, { bigint: true, throwIfNoEntry: false });
    if (lexical === undefined || lexical.isSymbolicLink() ||
      !sameStablePinnedPathIdentity(state.identity, lexical)) {
      throw filesystemError("filesystem_directory_identity_changed", state.lexicalPath);
    }
  }
}

function closeDurableDirectorySession(session: DurableDirectorySession): void {
  if (session.closed) return;
  session.closed = true;
  for (const directory of session.held) {
    const state = HELD_DIRECTORIES.get(directory);
    if (state !== undefined) state.active = false;
  }
  for (const directory of session.held.slice(1).toReversed()) {
    const state = HELD_DIRECTORIES.get(directory);
    if (state !== undefined) closeSync(state.descriptor);
  }
  closePinnedPathChain(session.chain);
}

/**
 * Mechanism-test-only capability. It proves the worker protocol without making
 * the ambient executable an admitted production runtime or evidence authority.
 */
export function withCurrentNodeRuntimeForFilesystemMechanismTest<Result>(operation: () => Result): Result {
  if (MECHANISM_TEST_RUNTIME.getStore() !== undefined) {
    throw filesystemError("filesystem_mechanism_test_runtime_nested", "runtime");
  }
  return withPinnedProcessExecutable(process.execPath, 268_435_456, true, (executable) => {
    const state: MechanismTestRuntimeState = { active: true, executable };
    try {
      const result = MECHANISM_TEST_RUNTIME.run(state, operation);
      if (result !== null && typeof result === "object" && "then" in result &&
        typeof (result as { then?: unknown }).then === "function") {
        return Promise.resolve(result).finally(() => { state.active = false; }) as Result;
      }
      state.active = false;
      return result;
    } catch (error) {
      state.active = false;
      throw error;
    }
  });
}

export function runPrivateDirectoryCreateWorkerForReceiptInternal(
  parentDescriptor: number,
  parentIdentity: BigIntStats,
  lexicalPath: string,
  segment: string,
): PrivateDirectoryWorkerResult {
  const capability = holdDirectory(parentDescriptor, parentIdentity, lexicalPath, parentIdentity.dev, false);
  try {
    return createPrivateDirectoryWithHeldParentInternal(capability, segment);
  } finally {
    const state = HELD_DIRECTORIES.get(capability);
    if (state !== undefined) state.active = false;
  }
}

export function createExclusiveDurableFileInternal(
  directory: DurableDirectory,
  name: string,
  bytesInput: Uint8Array,
): DurableExclusiveCreate {
  const state = requireFileMutationAuthority(directory);
  validateSegment(name);
  const bytes = Buffer.from(bytesInput);
  if (bytes.length > POLICY.maximumFileBytes) {
    throw filesystemError("filesystem_file_too_large", name);
  }
  const target = pinnedDescriptorChildPath(state.descriptor, name);
  const temporaryName = ownedSiblingTemporaryName(name, "pending");
  const temporary = pinnedDescriptorChildPath(state.descriptor, temporaryName);
  let temporaryDescriptor: number | undefined;
  let published = false;
  try {
    temporaryDescriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      POLICY.fileMode,
    );
    fchmodSync(temporaryDescriptor, POLICY.fileMode);
    writeFileSync(temporaryDescriptor, bytes);
    fsyncSync(temporaryDescriptor);
    try {
      linkSync(temporary, target);
      published = true;
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      unlinkSync(temporary);
      fsyncSync(state.descriptor);
      return deepFreeze({ disposition: "existing", byteLength: bytes.length, sha256: sha256(bytes) });
    }
    fsyncSync(state.descriptor);
    unlinkSync(temporary);
    fsyncSync(state.descriptor);
    return deepFreeze({ disposition: "created", byteLength: bytes.length, sha256: sha256(bytes) });
  } catch (error) {
    if (!published) {
      try {
        if (lstatSync(temporary, { throwIfNoEntry: false }) !== undefined) unlinkSync(temporary);
      } catch {
        throw filesystemError("filesystem_create_ambiguous", name);
      }
    }
    if (error instanceof HarnessError) throw error;
    throw filesystemError(published ? "filesystem_create_ambiguous" : "filesystem_create_failed", name);
  } finally {
    if (temporaryDescriptor !== undefined) closeSync(temporaryDescriptor);
  }
}

export function readDurableFileInternal(directory: DurableDirectory, name: string): DurableFileRead {
  const state = requireHeldDirectory(directory);
  validateSegment(name);
  const path = pinnedDescriptorChildPath(state.descriptor, name);
  const before = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (before === undefined) return deepFreeze({ disposition: "missing" });
  if (!privateFileIdentity(before, state.rootDevice)) {
    return deepFreeze({ disposition: "unsafe", reason: "identity" });
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedBefore = fstatSync(descriptor, { bigint: true });
    if (!samePinnedPathIdentity(before, openedBefore)) {
      return deepFreeze({ disposition: "unsafe", reason: "identity-changed" });
    }
    const bytes = readFileSync(descriptor);
    const openedAfter = fstatSync(descriptor, { bigint: true });
    const after = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (after === undefined || !samePinnedPathIdentity(openedBefore, openedAfter) ||
      !samePinnedPathIdentity(before, after) || bytes.length !== Number(after.size)) {
      return deepFreeze({ disposition: "unsafe", reason: "identity-changed" });
    }
    return Object.freeze({ disposition: "present" as const, bytes, byteLength: bytes.length, sha256: sha256(bytes) });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function enumerateDurableDirectoryInternal(
  directory: DurableDirectory,
): readonly DurableDirectoryEntry[] {
  const state = requireHeldDirectory(directory);
  const entries = readdirSync(pinnedDescriptorPath(state.descriptor), { withFileTypes: true });
  if (entries.length > POLICY.maximumDirectoryEntries) {
    throw filesystemError("filesystem_directory_too_large", directory.lexicalPath);
  }
  return deepFreeze(entries.map((entry) => ({
    name: entry.name,
    kind: entry.isFile() ? "file" as const : entry.isDirectory() ? "directory" as const :
      entry.isSymbolicLink() ? "symlink" as const : "other" as const,
  })).toSorted((left, right) => left.name.localeCompare(right.name)));
}

function createPrivateDirectoryWithHeldParentInternal(
  parent: DurableDirectory,
  segment: string,
): PrivateDirectoryWorkerResult {
  const state = requireHeldDirectory(parent);
  validateSegment(segment);
  const runtime = currentFilesystemRuntime();
  if (runtime === undefined) {
    throw filesystemError("filesystem_runtime_not_admitted", segment);
  }
  const sourcePath = join(HARNESS_ROOT, WORKER.sourcePath);
  const sourceFile = openPinnedAbsoluteFile(sourcePath, WORKER.maximumSourceBytes);
  try {
    const source = readFileSync(sourceFile.descriptor);
    if (source.length > WORKER.maximumSourceBytes || sha256(source) !== WORKER.sourceSha256) {
      throw filesystemError("filesystem_worker_source_invalid", WORKER.sourcePath);
    }
    const contract = deepFreeze({
      schemaVersion: WORKER.schemaVersion,
      compositionIdentity: canonicalHash({ sourceSha256: WORKER.sourceSha256, policy: WORKER }),
      procFileDescriptorRoot: POLICY.procFileDescriptorRoot,
      parentDescriptor: WORKER.parentDescriptor,
      directoryMode: POLICY.directoryMode,
      maximumSegmentBytes: POLICY.segmentContract.maximumUtf8Bytes,
      normalization: POLICY.segmentContract.normalization,
      segmentPatternSource: POLICY.segmentContract.patternSource,
    });
    const program = Buffer.concat([
      Buffer.from(`const contract = ${JSON.stringify(contract)};\n`, "utf8"),
      source,
      Buffer.from("\nrunPrivateDirectoryCreateWorker(contract);\n", "utf8"),
    ]);
    const profile = compilePinnedProcessProfile({
      allowedSignals: WORKER.allowedSignals,
      allowedStatuses: WORKER.allowedStatuses,
      bindingTargets: [{ id: WORKER.parentBindingId, targetDescriptor: WORKER.parentDescriptor }],
      environment: WORKER.environment,
      executableTargetDescriptor: WORKER.executableTargetDescriptor,
      maximumErrorBytes: WORKER.maximumErrorBytes,
      maximumInputBytes: WORKER.maximumInputBytes,
      maximumOutputBytes: WORKER.maximumOutputBytes,
      timeoutMilliseconds: WORKER.timeoutMilliseconds,
      workingDirectory: WORKER.workingDirectory,
    });
    const child = withBorrowedPinnedProcessBinding(
      state.descriptor,
      state.identity,
      (binding) => runPinnedProcess(
        profile,
        runtime.executable,
        { [WORKER.parentBindingId]: binding },
        [...WORKER.nodeArguments, segment],
        program,
      ),
    );
    if (!child.terminationAccepted || child.status !== 0 || child.signal !== null || child.stderr.length !== 0) {
      throw filesystemError("filesystem_worker_failed", segment);
    }
    let result: unknown;
    try {
      result = JSON.parse(child.stdout.toString("utf8"));
    } catch {
      throw filesystemError("filesystem_worker_output_invalid", segment);
    }
    if (!validWorkerResult(result, contract.compositionIdentity)) {
      throw filesystemError("filesystem_worker_output_invalid", segment);
    }
    return deepFreeze({
      disposition: result.disposition,
      ...(result.identity === undefined ? {} : { identity: result.identity }),
    });
  } finally {
    closePinnedPathChain(sourceFile.chain);
  }
}

function validateDirectoryRequest(request: DurableDirectoryRequest): void {
  if (!isAbsolute(request.absoluteRoot) || resolve(request.absoluteRoot) !== request.absoluteRoot ||
    request.relativeSegments.some((segment) => typeof segment !== "string")) {
    throw filesystemError("filesystem_directory_request_invalid", request.absoluteRoot);
  }
}

function validateSegment(segment: string): void {
  const policy = POLICY.segmentContract;
  const pattern = new RegExp(policy.patternSource, "u");
  if (segment.length === 0 || segment === "." || segment === ".." || segment.normalize("NFC") !== segment ||
    Buffer.byteLength(segment, "utf8") > policy.maximumUtf8Bytes || !pattern.test(segment)) {
    throw filesystemError("filesystem_segment_invalid", segment);
  }
}

function holdDirectory(
  descriptor: number,
  identity: BigIntStats,
  lexicalPath: string,
  rootDevice: bigint,
  fileMutationRequested: boolean,
): DurableDirectory {
  const capability = deepFreeze({ identity: directoryIdentity(identity), lexicalPath });
  HELD_DIRECTORIES.set(capability, {
    active: true,
    descriptor,
    fileMutationRequested,
    identity,
    lexicalPath,
    rootDevice,
  });
  return capability;
}

function requireHeldDirectory(directory: DurableDirectory): HeldDirectoryState {
  const state = HELD_DIRECTORIES.get(directory);
  if (state === undefined || !state.active) {
    throw filesystemError("filesystem_directory_capability_invalid", directory.lexicalPath);
  }
  const observed = fstatSync(state.descriptor, { bigint: true });
  if (!sameStablePinnedPathIdentity(observed, state.identity)) {
    throw filesystemError("filesystem_directory_identity_changed", state.lexicalPath);
  }
  return state;
}

function requireFileMutationAuthority(directory: DurableDirectory): HeldDirectoryState {
  const state = requireHeldDirectory(directory);
  if (!state.fileMutationRequested) {
    throw filesystemError("filesystem_file_mutation_not_requested", state.lexicalPath);
  }
  assertPrivateDirectory(state.identity, state.lexicalPath, state.rootDevice);
  const runtime = currentFilesystemRuntime();
  if (runtime === undefined) {
    throw filesystemError("filesystem_runtime_not_admitted", state.lexicalPath);
  }
  return state;
}

function assertPrivateDirectory(identity: BigIntStats, path: string, rootDevice: bigint): void {
  const uid = process.getuid?.();
  if (!identity.isDirectory() || identity.isSymbolicLink() || uid === undefined ||
    identity.uid !== BigInt(uid) || identity.dev !== rootDevice ||
    (identity.mode & 0o7777n) !== BigInt(POLICY.directoryMode)) {
    throw filesystemError("filesystem_directory_unsafe", path);
  }
}

function privateFileIdentity(identity: BigIntStats, rootDevice: bigint): boolean {
  const uid = process.getuid?.();
  return identity.isFile() && !identity.isSymbolicLink() && uid !== undefined &&
    identity.uid === BigInt(uid) && identity.dev === rootDevice && !hasSecondName(identity.nlink) &&
    identity.size <= BigInt(POLICY.maximumFileBytes) &&
    (identity.mode & 0o7777n) === BigInt(POLICY.fileMode);
}

function directoryIdentity(identity: BigIntStats): DurableDirectoryIdentity {
  return deepFreeze({
    device: identity.dev.toString(10),
    inode: identity.ino.toString(10),
    mode: (identity.mode & 0o7777n).toString(8).padStart(4, "0"),
    ownerUid: identity.uid.toString(10),
    ownerGid: identity.gid.toString(10),
  });
}

function validWorkerResult(
  value: unknown,
  compositionIdentity: string,
): value is Readonly<{
  schemaVersion: string;
  compositionIdentity: string;
  disposition: "created" | "existing";
  identity?: Readonly<{ device: string; inode: string; ownerUid: string; ownerGid: string; mode: string }>;
}> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  const expected = result.disposition === "created"
    ? ["compositionIdentity", "disposition", "identity", "schemaVersion"]
    : ["compositionIdentity", "disposition", "schemaVersion"];
  if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(expected.sort()) ||
    result.schemaVersion !== WORKER.schemaVersion || result.compositionIdentity !== compositionIdentity ||
    (result.disposition !== "created" && result.disposition !== "existing")) return false;
  if (result.disposition === "existing") return result.identity === undefined;
  if (result.identity === null || typeof result.identity !== "object" || Array.isArray(result.identity)) return false;
  const identity = result.identity as Record<string, unknown>;
  return JSON.stringify(Object.keys(identity).sort()) ===
      JSON.stringify(["device", "inode", "mode", "ownerGid", "ownerUid"].sort()) &&
    [identity.device, identity.inode, identity.ownerUid, identity.ownerGid].every(
      (item) => typeof item === "string" && /^(0|[1-9][0-9]*)$/u.test(item),
    ) && typeof identity.mode === "string" && /^[0-7]{4}$/u.test(identity.mode);
}

function filesystemError(code: string, value: string): HarnessError {
  return new HarnessError("Durable filesystem operation failed", code, false, {
    valueSha256: sha256(value),
  });
}
