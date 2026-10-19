import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { join } from "node:path";

import { HarnessError } from "../../src/kernel/errors.ts";
import {
  borrowRepositoryRootCapability,
  releaseRepositoryRootCapabilityBorrow,
  repositoryRootCapabilityBorrowChain,
  repositoryRootPathForInternalUse,
  type RepositoryRootCapability,
  type RepositoryRootCapabilityBorrow,
} from "../../src/filesystem/repository-root-capability-internal.ts";
import {
  closePinnedPathChain,
  openPinnedRepositoryAncestorChain,
  pinnedPathIdentityHash as identityHash,
  recheckPinnedPathChain,
  samePinnedPathIdentity as sameIdentity,
  type PinnedRepositoryPathChain,
} from "../../src/filesystem/pinned-path-internal.ts";
import { canonicalHash, deepFreeze } from "../../src/kernel/integrity.ts";
import { relativePathViolationKinds } from "../../src/filesystem/path-boundary.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { shouldRejectSymlinks } from "../../src/shared/source-scan.ts";
import { hasSecondName, refusesSecondNames } from "../../src/filesystem/link-containment.ts";
import { isProxyValue } from "../../src/kernel/safe-structural.ts";

export type SafeRepositoryEntryStatus =
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "unsafe"; code: string }>
  | Readonly<{ status: "present"; kind: "directory" | "file" | "other" }>;

export type SafeRepositoryRootBoundary =
  | Readonly<{ ok: true; code: null }>
  | Readonly<{ ok: false; code: string }>;

export type SafeRepositoryFileRead = Readonly<{
  bytes: Buffer;
  mode: number;
  size: number;
  identityHash: string;
  realPath: string;
  device: string;
  inode: string;
}>;

export type SafeRepositoryTreeEntry = Readonly<{
  path: string;
  kind: "directory" | "file";
  identityHash: string;
}>;

export type SafeRepositoryTreeLimits = Readonly<{
  maximumDepth: number;
  maximumEntries: number;
  excludedDirectoryNames?: readonly string[];
  excludedFileNames?: readonly string[];
  excludedFileSuffixes?: readonly string[];
  /**
   * The CALLER's exclusion of a directory subtree, by its path relative to
   * the walk's root (e.g. this repository's experiment directories,
   * `shouldExcludeExperiment`). The walker holds no repository policy of its
   * own: it used to skip this repository's experiment layout for every
   * caller, so a walk of another tree (the docs lab's) silently lost any
   * directory that happened to be spelled like one.
   */
  excludedDirectory?: (relativePath: string) => boolean;
}>;

export type SafeRepositoryReadHooks = Readonly<{
  afterAncestorTraversal?: () => void;
  afterLeafOpen?: () => void;
  afterRead?: () => void;
}>;

type OpenChain = PinnedRepositoryPathChain;

export type SafeRepositoryRootAccess =
  | Readonly<{
    acquisition: (typeof ROOT_POLICY.verification.testFixtures.repositoryRootCapability.acquisitionModes)[0];
    root: string;
  }>
  | Readonly<{
    acquisition: (typeof ROOT_POLICY.verification.testFixtures.repositoryRootCapability.acquisitionModes)[1];
    capability: RepositoryRootCapability;
  }>;

export type SafeRepositoryRootAccessInput = string | SafeRepositoryRootAccess;

type OpenAccess = Readonly<{
  chain: OpenChain;
  borrow?: RepositoryRootCapabilityBorrow;
}>;

const POLICY = ROOT_POLICY.verification.safeRepositoryRead;
const [RAW_PATH_ACQUISITION, QUALIFIED_CAPABILITY_ACQUISITION] =
  ROOT_POLICY.verification.testFixtures.repositoryRootCapability.acquisitionModes;

export function rawSafeRepositoryRootAccess(root: string): SafeRepositoryRootAccess {
  if (typeof root !== "string") throw rootAccessError();
  return Object.freeze({ acquisition: RAW_PATH_ACQUISITION, root });
}

export function qualifiedSafeRepositoryRootAccess(
  capability: RepositoryRootCapability,
): SafeRepositoryRootAccess {
  return Object.freeze({ acquisition: QUALIFIED_CAPABILITY_ACQUISITION, capability });
}

export function safeRepositoryRootPathForInternalUse(input: SafeRepositoryRootAccessInput): string {
  const access = normalizeSafeRepositoryRootAccess(input);
  switch (access.acquisition) {
    case RAW_PATH_ACQUISITION:
      return access.root;
    case QUALIFIED_CAPABILITY_ACQUISITION:
      return repositoryRootPathForInternalUse(access.capability);
    default:
      return assertNeverRootAccess(access);
  }
}

export function inspectSafeRepositoryRootBoundary(input: SafeRepositoryRootAccessInput): SafeRepositoryRootBoundary {
  let opened: OpenAccess | undefined;
  try {
    opened = openAccess(input, ".");
    recheckPinnedPathChain(opened.chain, ".");
    return deepFreeze({ ok: true, code: null });
  } catch (error) {
    return deepFreeze({
      ok: false,
      code: error instanceof HarnessError ? error.code : "safe_path_root_boundary_unavailable",
    });
  } finally {
    closeAccess(opened);
  }
}

export function safeRepositoryEntryStatus(
  input: SafeRepositoryRootAccessInput,
  path: string,
): SafeRepositoryEntryStatus {
  let opened: OpenAccess | undefined;
  try {
    opened = openAccess(input, path);
    const stats = inspectAnyLeaf(opened.chain, path);
    if (!stats) return deepFreeze({ status: "missing" });
    if (stats.isSymbolicLink()) return deepFreeze({ status: "unsafe", code: "safe_path_symlink" });
    if (stats.dev !== opened.chain.rootDevice || opened.chain.mountPoints.has(opened.chain.leafLexicalPath)) {
      return deepFreeze({ status: "unsafe", code: "safe_path_boundary" });
    }
    const kind: "directory" | "file" | "other" = stats.isFile()
      ? "file"
      : stats.isDirectory() ? "directory" : "other";
    return deepFreeze({
      status: "present",
      kind,
    });
  } catch (error) {
    if (error instanceof HarnessError) {
      if (error.code === "safe_path_missing") return deepFreeze({ status: "missing" });
      return deepFreeze({ status: "unsafe", code: error.code });
    }
    return deepFreeze({ status: "unsafe", code: "safe_path_inspection_failed" });
  } finally {
    closeAccess(opened);
  }
}

export function readSafeRepositoryFile(
  input: SafeRepositoryRootAccessInput,
  path: string,
  maximumBytes: number,
  hooks: SafeRepositoryReadHooks = {},
): SafeRepositoryFileRead {
  let opened: OpenAccess | undefined;
  let leafDescriptor: number | undefined;
  try {
    opened = openAccess(input, path);
    const chain = opened.chain;
    hooks.afterAncestorTraversal?.();
    const before = inspectLeaf(chain, path, maximumBytes);
    try {
      leafDescriptor = openSync(chain.leafDescriptorPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      throw safePathError("safe_path_open_denied", path);
    }
    const openedBefore = fstatSync(leafDescriptor, { bigint: true });
    if (!sameIdentity(before, openedBefore)) throw safePathError("safe_path_identity_changed", path);
    hooks.afterLeafOpen?.();
    const bytes = readFileSync(leafDescriptor);
    hooks.afterRead?.();
    const openedAfter = fstatSync(leafDescriptor, { bigint: true });
    const descriptorRealPath = realpathSync(join(POLICY.procFileDescriptorRoot, String(leafDescriptor)));
    const after = inspectLeaf(chain, path, maximumBytes);
    recheckPinnedPathChain(chain, path);
    if (!sameIdentity(openedBefore, openedAfter) || !sameIdentity(before, after) ||
      bytes.length !== Number(after.size) || descriptorRealPath !== chain.leafLexicalPath) {
      throw safePathError("safe_path_identity_changed", path);
    }
    return Object.freeze({
      bytes,
      mode: Number(after.mode),
      size: bytes.length,
      identityHash: identityHash(after),
      realPath: descriptorRealPath,
      device: after.dev.toString(10),
      inode: after.ino.toString(10),
    });
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw safePathError("safe_path_read_failed", path);
  } finally {
    if (leafDescriptor !== undefined) closeSync(leafDescriptor);
    closeAccess(opened);
  }
}

export function listSafeRepositoryTree(
  input: SafeRepositoryRootAccessInput,
  path: string,
  limits: SafeRepositoryTreeLimits,
): readonly SafeRepositoryTreeEntry[] {
  assertTreeLimits(limits);
  let opened: OpenAccess | undefined;
  let rootDescriptor: number | undefined;
  let rootDescriptorBorrowed = false;
  try {
    opened = openAccess(input, path);
    const chain = opened.chain;
    const before = inspectDirectoryLeaf(chain, path);
    if (chain.leafIsHeldRoot) {
      rootDescriptor = chain.descriptors[chain.rootDescriptorIndex]!;
      rootDescriptorBorrowed = true;
    } else {
      try {
        rootDescriptor = openSync(
          chain.leafDescriptorPath,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
      } catch {
        throw safePathError("safe_path_open_denied", path);
      }
    }
    const openedBefore = fstatSync(rootDescriptor, { bigint: true });
    if (!sameIdentity(before, openedBefore)) throw safePathError("safe_path_identity_changed", path);
    const entries: SafeRepositoryTreeEntry[] = [];
    walkSafeDirectory({
      descriptor: rootDescriptor,
      identity: openedBefore,
      lexicalPath: chain.leafLexicalPath,
      relativePath: path === "." ? "" : path,
      depth: 0,
      rootDevice: chain.rootDevice,
      mountPoints: chain.mountPoints,
      limits,
      entries,
    });
    const openedAfter = fstatSync(rootDescriptor, { bigint: true });
    const after = inspectDirectoryLeaf(chain, path);
    recheckPinnedPathChain(chain, path);
    if (!sameIdentity(openedBefore, openedAfter) || !sameIdentity(before, after)) {
      throw safePathError("safe_path_identity_changed", path);
    }
    if (entries.length < 2) return Object.freeze(entries);
    const ordered = entries.map((entry) => ({ entry, bytes: Buffer.from(entry.path, "utf8") }));
    ordered.sort((left, right) => Buffer.compare(left.bytes, right.bytes));
    return Object.freeze(ordered.map(({ entry }) => entry));
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw safePathError("safe_path_tree_read_failed", path);
  } finally {
    if (rootDescriptor !== undefined && !rootDescriptorBorrowed) closeSync(rootDescriptor);
    closeAccess(opened);
  }
}

function openAccess(input: SafeRepositoryRootAccessInput, path: string): OpenAccess {
  const access = normalizeSafeRepositoryRootAccess(input);
  switch (access.acquisition) {
    case RAW_PATH_ACQUISITION:
      return { chain: openPinnedRepositoryAncestorChain(access.root, path) };
    case QUALIFIED_CAPABILITY_ACQUISITION: {
      const borrow = borrowRepositoryRootCapability(access.capability, path);
      return { chain: repositoryRootCapabilityBorrowChain(borrow), borrow };
    }
    default:
      return assertNeverRootAccess(access);
  }
}

function normalizeSafeRepositoryRootAccess(input: SafeRepositoryRootAccessInput): SafeRepositoryRootAccess {
  if (typeof input === "string") return rawSafeRepositoryRootAccess(input);
  if (typeof input !== "object" || input === null || isProxyValue(input) ||
    Object.getPrototypeOf(input) !== Object.prototype) {
    throw rootAccessError();
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string") ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor) || !descriptor.enumerable)) {
    throw rootAccessError();
  }
  const acquisition = descriptors.acquisition?.value;
  if (acquisition === RAW_PATH_ACQUISITION && keys.length === 2 && descriptors.root !== undefined &&
    typeof descriptors.root.value === "string") {
    return input;
  }
  if (acquisition === QUALIFIED_CAPABILITY_ACQUISITION && keys.length === 2 &&
    descriptors.capability !== undefined &&
    typeof descriptors.capability.value === "object" && descriptors.capability.value !== null) {
    return input;
  }
  throw rootAccessError();
}

function closeAccess(opened: OpenAccess | undefined): void {
  if (opened === undefined) return;
  if (opened.borrow !== undefined) {
    releaseRepositoryRootCapabilityBorrow(opened.borrow);
    return;
  }
  closePinnedPathChain(opened.chain);
}

function inspectAnyLeaf(chain: OpenChain, path: string): BigIntStats | undefined {
  if (!chain.leafIsHeldRoot) {
    return lstatSync(chain.leafDescriptorPath, { bigint: true, throwIfNoEntry: false });
  }
  const opened = fstatSync(chain.descriptors[chain.rootDescriptorIndex]!, { bigint: true });
  const lexical = lstatSync(chain.leafLexicalPath, { bigint: true, throwIfNoEntry: false });
  if (!lexical || lexical.isSymbolicLink() || !sameIdentity(opened, lexical)) {
    throw safePathError("safe_path_identity_changed", path);
  }
  return opened;
}

function inspectLeaf(chain: OpenChain, path: string, maximumBytes: number): BigIntStats {
  const stats = inspectAnyLeaf(chain, path);
  if (!stats) throw safePathError("safe_path_missing", path);
  if (stats.isSymbolicLink()) throw safePathError("safe_path_symlink", path);
  if (!stats.isFile()) throw safePathError("safe_path_special", path);
  // ONE OWNER for the second-name verdict, shared with the repository map and
  // the web UI's filesystem gate, so the three cannot drift apart.
  if (refusesSecondNames() && hasSecondName(stats.nlink)) throw safePathError("safe_path_hardlink", path);
  if (stats.dev !== chain.rootDevice || chain.mountPoints.has(chain.leafLexicalPath)) {
    throw safePathError("safe_path_boundary", path);
  }
  if (stats.size > BigInt(maximumBytes)) throw safePathError("safe_path_too_large", path);
  return stats;
}

function inspectDirectoryLeaf(chain: OpenChain, path: string): BigIntStats {
  const stats = inspectAnyLeaf(chain, path);
  if (!stats) throw safePathError("safe_path_missing", path);
  if (stats.isSymbolicLink()) throw safePathError("safe_path_symlink", path);
  if (!stats.isDirectory()) throw safePathError("safe_path_not_directory", path);
  if (stats.dev !== chain.rootDevice || chain.mountPoints.has(chain.leafLexicalPath)) {
    throw safePathError("safe_path_boundary", path);
  }
  return stats;
}

type SafeDirectoryWalk = {
  descriptor: number;
  identity: BigIntStats;
  lexicalPath: string;
  relativePath: string;
  depth: number;
  rootDevice: bigint;
  mountPoints: ReadonlySet<string>;
  limits: SafeRepositoryTreeLimits;
  entries: SafeRepositoryTreeEntry[];
};

function walkSafeDirectory(walk: SafeDirectoryWalk): void {
  let names: Buffer[];
  try {
    names = readdirSync(join(POLICY.procFileDescriptorRoot, String(walk.descriptor)), {
      encoding: "buffer",
    });
  } catch {
    throw safePathError("safe_path_directory_read_failed", walk.relativePath);
  }
  names.sort(Buffer.compare);
  const decodedNames = new Set<string>();
  for (const rawName of names) {
    const name = decodeDirectoryEntryName(rawName, walk.relativePath);
    if (decodedNames.has(name)) throw safePathError("safe_path_directory_duplicate", walk.relativePath);
    decodedNames.add(name);
    const relativePath = walk.relativePath.length === 0 ? name : `${walk.relativePath}/${name}`;
    if (relativePathViolationKinds(relativePath).length > 0) {
      throw safePathError("safe_path_invalid", relativePath);
    }
    if (walk.entries.length >= walk.limits.maximumEntries) {
      throw safePathError("safe_path_entry_limit", walk.relativePath);
    }
    const descriptorPath = join(POLICY.procFileDescriptorRoot, String(walk.descriptor), name);
    const lexicalPath = join(walk.lexicalPath, name);
    const stats = lstatSync(descriptorPath, { bigint: true, throwIfNoEntry: false });
    if (!stats) throw safePathError("safe_path_identity_changed", relativePath);
    if (walk.limits.excludedDirectoryNames?.includes(name) &&
      (stats.isDirectory() || stats.isSymbolicLink())) continue;
    if ((walk.limits.excludedFileNames?.includes(name) ||
      walk.limits.excludedFileSuffixes?.some((suffix) => name.endsWith(suffix))) &&
      (stats.isFile() || stats.isSymbolicLink())) continue;
    if (stats.isSymbolicLink()) {
      if (shouldRejectSymlinks()) throw safePathError("safe_path_symlink", relativePath);
      continue;
    }
    if (stats.dev !== walk.rootDevice || walk.mountPoints.has(lexicalPath)) {
      throw safePathError("safe_path_boundary", relativePath);
    }
    // The caller's own subtree exclusion (its repository's policy, never the walker's).
    if (stats.isDirectory() && walk.limits.excludedDirectory?.(relativePath) === true) continue;
    if (stats.isFile()) {
      if (refusesSecondNames() && hasSecondName(stats.nlink)) throw safePathError("safe_path_hardlink", relativePath);
      walk.entries.push(Object.freeze({ path: relativePath, kind: "file", identityHash: identityHash(stats) }));
      continue;
    }
    if (!stats.isDirectory()) throw safePathError("safe_path_special", relativePath);
    if (walk.depth >= walk.limits.maximumDepth) {
      throw safePathError("safe_path_depth_limit", relativePath);
    }
    let descriptor: number | undefined;
    try {
      descriptor = openSync(descriptorPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const openedBefore = fstatSync(descriptor, { bigint: true });
      if (!sameIdentity(stats, openedBefore)) throw safePathError("safe_path_identity_changed", relativePath);
      walk.entries.push(Object.freeze({
        path: relativePath,
        kind: "directory",
        identityHash: identityHash(openedBefore),
      }));
      walkSafeDirectory({
        ...walk,
        descriptor,
        identity: openedBefore,
        lexicalPath,
        relativePath,
        depth: walk.depth + 1,
      });
      const openedAfter = fstatSync(descriptor, { bigint: true });
      const lexicalAfter = lstatSync(lexicalPath, { bigint: true, throwIfNoEntry: false });
      if (!lexicalAfter || lexicalAfter.isSymbolicLink() ||
        !sameIdentity(openedBefore, openedAfter) || !sameIdentity(openedBefore, lexicalAfter)) {
        throw safePathError("safe_path_identity_changed", relativePath);
      }
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      throw safePathError("safe_path_directory_open_failed", relativePath);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
  const openedAfter = fstatSync(walk.descriptor, { bigint: true });
  const lexicalAfter = lstatSync(walk.lexicalPath, { bigint: true, throwIfNoEntry: false });
  if (!lexicalAfter || lexicalAfter.isSymbolicLink() ||
    !sameIdentity(walk.identity, openedAfter) || !sameIdentity(walk.identity, lexicalAfter)) {
    throw safePathError("safe_path_identity_changed", walk.relativePath);
  }
}

function decodeDirectoryEntryName(rawName: Buffer, parentPath: string): string {
  let name: string;
  try {
    name = new TextDecoder("utf-8", { fatal: true }).decode(rawName);
  } catch {
    throw safePathError("safe_path_name_invalid_utf8", parentPath);
  }
  if (!Buffer.from(name, "utf8").equals(rawName) || relativePathViolationKinds(name).length > 0) {
    throw safePathError("safe_path_invalid", `${parentPath}/${name}`);
  }
  return name;
}

function assertTreeLimits(limits: SafeRepositoryTreeLimits): void {
  if (!Number.isSafeInteger(limits.maximumDepth) || limits.maximumDepth < 0 ||
    !Number.isSafeInteger(limits.maximumEntries) || limits.maximumEntries < 1) {
    throw new HarnessError("Safe repository tree limits are invalid", "safe_path_limits_invalid");
  }
}

function safePathError(code: string, path: string): HarnessError {
  return new HarnessError("Safe repository path access denied", code, false, {
    pathHash: canonicalHash({ path }),
  });
}

function rootAccessError(): HarnessError {
  return new HarnessError("Safe repository root access denied", "safe_path_root_access_invalid", false);
}

function assertNeverRootAccess(_access: never): never {
  throw rootAccessError();
}
