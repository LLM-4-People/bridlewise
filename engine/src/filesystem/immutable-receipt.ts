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
  readSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { HarnessError } from "../kernel/errors.ts";
import { runPrivateDirectoryCreateWorkerForReceiptInternal } from "./durable-filesystem-internal.ts";
import { hasSecondName } from "./link-containment.ts";
import { isOwnedSiblingTemporary, ownedSiblingTemporaryName } from "./private-state.ts";
import { canonicalHash, canonicalJson, deepFreeze, SHA256_HEX_REGEX, sha256 } from "../kernel/integrity.ts";
import { assertNoDuplicateJsonObjectKeys } from "../kernel/json-integrity.ts";
import { readLinuxMountPoints } from "./linux-path.ts";
import { relativePathViolationKinds } from "./path-boundary.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";

export type ReceiptAuthority = Readonly<{
  repositoryRoot: string;
  relativeRoot: string;
  absoluteRoot: string;
  authorityHash: string;
}>;

export type ReceiptAttempt = Readonly<{
  authority: ReceiptAuthority;
  attemptId: string;
  relativeDirectory: string;
  directoryIdentityHash: string;
}>;

export type ReceiptContentKind = "canonical-json" | "blob";
export type ReceiptWriteDisposition = "created" | "existing-identical";
export type ReceiptFaultStage = typeof ROOT_POLICY.receipts.immutableExecution.faultStages[number];
export type ReceiptDirectoryFaultStage =
  typeof ROOT_POLICY.receipts.immutableExecution.directoryFaultStages[number];

export type ReceiptAuthorityHooks = Readonly<{
  afterStage?: (stage: ReceiptDirectoryFaultStage, lexicalPath: string) => void;
}>;

export type ReceiptWriteHooks = Readonly<{
  beforeStage?: (stage: ReceiptFaultStage) => void;
  afterStage?: (stage: ReceiptFaultStage) => void;
}>;

export type ReceiptWriteRequest = Readonly<{
  bytes: Uint8Array;
  contentKind: ReceiptContentKind;
}> & (
  | Readonly<{ mode: "exclusive-path"; path: string }>
  | Readonly<{ mode: "content-addressed"; namespace: string; extension: string }>
  | Readonly<{
      mode: "unique-attempt";
      attempt: ReceiptAttempt;
      ordinal: number;
      label: string;
      extension: string;
    }>
);

export type ImmutableReceiptWrite = Readonly<{
  path: string;
  byteLength: number;
  sha256: string;
  disposition: ReceiptWriteDisposition;
  authorityStage: "durable-local-creation-unadmitted";
}>;

export type ReceiptModeRemediationRequest = Readonly<{
  authorizedReason: string;
  contentKind: ReceiptContentKind;
  expectedBeforeMode: number;
  expectedByteLength: number;
  expectedSha256: string;
  path: string;
}>;

export type ImmutableReceiptModeRemediation = Readonly<{
  schemaVersion: typeof ROOT_POLICY.receipts.immutableExecution.metadataRemediationSchemaVersion;
  authorityStage: typeof ROOT_POLICY.receipts.immutableExecution.metadataRemediationAuthorityStage;
  authorizedReason: string;
  path: string;
  byteLength: number;
  beforeSha256: string;
  afterSha256: string;
  byteHashUnchanged: true;
  before: ImmutableReceiptFileIdentity;
  after: ImmutableReceiptFileIdentity;
}>;

export type ImmutableReceiptFileIdentity = Readonly<{
  device: string;
  inode: string;
  ownerUid: string;
  ownerGid: string;
  links: string;
  mode: string;
  size: string;
  modifiedNanoseconds: string;
}>;

export type ReceiptAttemptDirectoryEntry = Readonly<{
  name: string;
  kind: "file" | "directory" | "symlink" | "other";
}>;

type DirectoryChain = {
  descriptors: number[];
  identities: BigIntStats[];
  lexicalPaths: string[];
  rootDevice: bigint;
  mountPoints: ReadonlySet<string>;
};

type DirectoryOpenPathAuthority = "lexical-no-follow" | "pinned-proc-descriptor";

const POLICY = ROOT_POLICY.receipts.immutableExecution;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const LABEL = /^[a-z][a-z0-9-]{0,63}$/u;
const EXTENSION = /^\.[a-z0-9]{1,16}$/u;

export function ensureReceiptAuthority(
  repositoryRootInput: string,
  relativeRoot: string,
  hooks: ReceiptAuthorityHooks = {},
): ReceiptAuthority {
  return receiptAuthority(repositoryRootInput, relativeRoot, true, hooks);
}

export function inspectReceiptAuthority(repositoryRootInput: string, relativeRoot: string): ReceiptAuthority {
  return receiptAuthority(repositoryRootInput, relativeRoot, false, {});
}

function receiptAuthority(
  repositoryRootInput: string,
  relativeRoot: string,
  create: boolean,
  hooks: ReceiptAuthorityHooks,
): ReceiptAuthority {
  const repositoryRoot = validateRepositoryRoot(repositoryRootInput);
  validateRelativePath(relativeRoot, "receipt_evidence_root_path_invalid");
  const chain = openPrivateDirectoryChain(repositoryRoot, relativeRoot.split("/"), create, hooks);
  try {
    recheckDirectoryChain(chain, relativeRoot);
    if (create) fsyncSync(chain.descriptors.at(-1)!);
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw receiptError(create ? "receipt_evidence_root_create_failed" : "receipt_evidence_root_inspect_failed", relativeRoot);
  } finally {
    closeDirectoryChain(chain);
  }
  return deepFreeze({
    repositoryRoot,
    relativeRoot,
    absoluteRoot: join(repositoryRoot, ...relativeRoot.split("/")),
    authorityHash: canonicalHash({ repositoryRoot, relativeRoot }),
  });
}

export function allocateReceiptAttempt(authority: ReceiptAuthority, attemptId: string): ReceiptAttempt {
  validateAuthority(authority);
  if (!UUID_V4.test(attemptId)) throw receiptError("receipt_run_id_invalid", attemptId);
  const attemptsRelative = `${authority.relativeRoot}/attempts`;
  const chain = openPrivateDirectoryChain(authority.repositoryRoot, attemptsRelative.split("/"), true);
  const attemptPath = descriptorChild(chain.descriptors.at(-1)!, attemptId);
  try {
    if (!createPrivateDirectory(chain, attemptId, join(chain.lexicalPaths.at(-1)!, attemptId))) {
      throw receiptError("receipt_run_id_collision", attemptId);
    }
    acceptDirectoryMutation(chain, chain.descriptors.length - 1, attemptId);
    const attemptDescriptor = openPrivateDirectory(attemptPath, chain.rootDevice, join(chain.lexicalPaths.at(-1)!, attemptId), chain.mountPoints);
    try {
      fsyncSync(attemptDescriptor.descriptor);
      recheckDirectoryChain(chain, attemptId);
      return deepFreeze({
        authority,
        attemptId,
        relativeDirectory: `attempts/${attemptId}`,
        directoryIdentityHash: identityHash(attemptDescriptor.identity),
      });
    } finally {
      closeSync(attemptDescriptor.descriptor);
    }
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw receiptError("receipt_run_directory_create_failed", attemptId);
  } finally {
    closeDirectoryChain(chain);
  }
}

export function writeImmutableEvidence(
  authority: ReceiptAuthority,
  request: ReceiptWriteRequest,
  hooks: ReceiptWriteHooks = {},
): ImmutableReceiptWrite {
  validateAuthority(authority);
  const bytes = Buffer.from(request.bytes);
  validateContent(bytes, request.contentKind);
  const digest = sha256(bytes);
  const path = destinationPath(authority, request, digest);
  return publishImmutableBytes(
    authority,
    path,
    bytes,
    request.contentKind,
    request.mode,
    request.mode === "unique-attempt" ? request.attempt : undefined,
    hooks,
  );
}

export function readImmutableEvidence(
  authority: ReceiptAuthority,
  path: string,
  contentKind: ReceiptContentKind,
): Buffer {
  validateAuthority(authority);
  validateRelativePath(path, "receipt_path_invalid");
  const fullRelativePath = `${authority.relativeRoot}/${path}`;
  const chain = openPrivateDirectoryChain(
    authority.repositoryRoot,
    dirname(fullRelativePath).split("/"),
    false,
  );
  let descriptor: number | undefined;
  try {
    const target = descriptorChild(chain.descriptors.at(-1)!, basename(path));
    const before = inspectImmutableFile(target, chain.rootDevice, join(chain.lexicalPaths.at(-1)!, basename(path)), chain.mountPoints);
    descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedBefore = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(before, openedBefore)) throw receiptError("receipt_identity_changed", path);
    const bytes = readFileSync(descriptor);
    const openedAfter = fstatSync(descriptor, { bigint: true });
    const after = inspectImmutableFile(target, chain.rootDevice, join(chain.lexicalPaths.at(-1)!, basename(path)), chain.mountPoints);
    recheckDirectoryChain(chain, path);
    if (!sameIdentity(openedBefore, openedAfter) || !sameIdentity(before, after) ||
      bytes.length !== Number(after.size)) {
      throw receiptError("receipt_identity_changed", path);
    }
    validateContent(bytes, contentKind);
    return bytes;
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw receiptError("receipt_read_failed", path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    closeDirectoryChain(chain);
  }
}

/**
 * THE CONTENT-ADDRESSED READ: the bytes stored under `sha256` in `namespace`
 * (the layout {@link writeImmutableEvidence} publishes in its
 * `content-addressed` mode), PROVED to hash to that digest, or `undefined`
 * when no object is stored there. The object is read like every immutable
 * file — through the private, link-free directory chain, its identity
 * (owner, mode, one name) checked before and after — so a link, a widened
 * mode or a second name anywhere in the store is a typed refusal, never
 * followed; bytes that do not hash to their address are
 * `receipt_content_address_mismatch`.
 */
export function readContentAddressed(
  authority: ReceiptAuthority,
  request: Readonly<{ namespace: string; extension: string; sha256: string }>,
): Buffer | undefined {
  validateAuthority(authority);
  const path = contentAddressedPath(request.namespace, request.sha256, request.extension);
  let bytes: Buffer;
  try {
    bytes = readImmutableEvidence(authority, path, "blob");
  } catch (error) {
    if (isHarnessCode(error, "receipt_file_missing") || isHarnessCode(error, "receipt_parent_missing")) return undefined;
    throw error;
  }
  if (sha256(bytes) !== request.sha256) throw receiptError("receipt_content_address_mismatch", path);
  return bytes;
}

export function remediateImmutableEvidenceMode(
  authority: ReceiptAuthority,
  request: ReceiptModeRemediationRequest,
): ImmutableReceiptModeRemediation {
  validateAuthority(authority);
  validateRelativePath(request.path, "receipt_path_invalid");
  if (!/^[a-z][a-z0-9-]{2,127}$/u.test(request.authorizedReason) ||
    !Number.isSafeInteger(request.expectedBeforeMode) || request.expectedBeforeMode < 0 ||
    request.expectedBeforeMode > 0o7777 || request.expectedBeforeMode === POLICY.fileMode ||
    !Number.isSafeInteger(request.expectedByteLength) || request.expectedByteLength < 0 ||
    request.expectedByteLength > POLICY.maximumBytes || !SHA256_HEX_REGEX.test(request.expectedSha256)) {
    throw receiptError("receipt_mode_remediation_request_invalid", request.path);
  }
  const fullRelativePath = `${authority.relativeRoot}/${request.path}`;
  const chain = openPrivateDirectoryChain(
    authority.repositoryRoot,
    dirname(fullRelativePath).split("/"),
    false,
  );
  let descriptor: number | undefined;
  let modeChanged = false;
  let stage = "before-open";
  try {
    const target = descriptorChild(chain.descriptors.at(-1)!, basename(request.path));
    const lexicalPath = join(chain.lexicalPaths.at(-1)!, basename(request.path));
    const before = lstatSync(target, { bigint: true, throwIfNoEntry: false });
    if (!before) throw receiptError("receipt_file_missing", request.path);
    assertRemediableFileIdentity(before, chain.rootDevice, lexicalPath, request.expectedByteLength);
    if (Number(before.mode & 0o7777n) !== request.expectedBeforeMode || chain.mountPoints.has(lexicalPath)) {
      throw receiptError("receipt_mode_remediation_precondition_failed", request.path);
    }
    descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedBefore = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(before, openedBefore)) {
      throw receiptError("receipt_identity_changed", request.path);
    }
    const beforeBytes = readDescriptorBytes(descriptor, request.expectedByteLength);
    validateContent(beforeBytes, request.contentKind);
    if (beforeBytes.length !== request.expectedByteLength || sha256(beforeBytes) !== request.expectedSha256) {
      throw receiptError("receipt_mode_remediation_content_mismatch", request.path);
    }
    stage = "before-fchmod";
    fchmodSync(descriptor, POLICY.fileMode);
    modeChanged = true;
    stage = "after-fchmod";
    fsyncSync(descriptor);
    fsyncSync(chain.descriptors.at(-1)!);
    const openedAfter = fstatSync(descriptor, { bigint: true });
    const after = lstatSync(target, { bigint: true, throwIfNoEntry: false });
    if (!after || !sameStableFileIdentityIgnoringModeAndCtime(openedBefore, openedAfter) ||
      !sameStableFileIdentityIgnoringModeAndCtime(openedAfter, after) ||
      Number(openedAfter.mode & 0o7777n) !== POLICY.fileMode) {
      throw receiptError("receipt_mode_remediation_identity_changed", request.path);
    }
    const afterBytes = readDescriptorBytes(descriptor, request.expectedByteLength);
    const afterSha256 = sha256(afterBytes);
    if (!afterBytes.equals(beforeBytes) || afterSha256 !== request.expectedSha256) {
      throw receiptError("receipt_mode_remediation_bytes_changed", request.path);
    }
    recheckDirectoryChain(chain, request.path);
    return deepFreeze({
      schemaVersion: POLICY.metadataRemediationSchemaVersion,
      authorityStage: POLICY.metadataRemediationAuthorityStage,
      authorizedReason: request.authorizedReason,
      path: request.path,
      byteLength: beforeBytes.length,
      beforeSha256: request.expectedSha256,
      afterSha256,
      byteHashUnchanged: true,
      before: immutableFileIdentity(before),
      after: immutableFileIdentity(after),
    });
  } catch (error) {
    if (modeChanged) {
      throw receiptError("receipt_mode_remediation_ambiguous", `${request.path}:${stage}:${errorCode(error)}`);
    }
    if (error instanceof HarnessError) throw error;
    throw receiptError("receipt_mode_remediation_failed", `${request.path}:${stage}:${errorCode(error)}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    closeDirectoryChain(chain);
  }
}

export function listReceiptAttemptEntries(
  authority: ReceiptAuthority,
  attemptId: string,
): readonly ReceiptAttemptDirectoryEntry[] {
  if (!UUID_V4.test(attemptId)) throw receiptError("receipt_run_id_invalid", attemptId);
  return listReceiptNamespaceEntries(authority, `attempts/${attemptId}`);
}

export function listReceiptNamespaceEntries(
  authority: ReceiptAuthority,
  path: string,
): readonly ReceiptAttemptDirectoryEntry[] {
  return listDirectory(authority, path);
}

export function isPendingReceiptEntry(name: string): boolean {
  return isOwnedSiblingTemporary(name, "pending");
}

function publishImmutableBytes(
  authority: ReceiptAuthority,
  path: string,
  bytes: Buffer,
  contentKind: ReceiptContentKind,
  mode: ReceiptWriteRequest["mode"],
  attempt: ReceiptAttempt | undefined,
  hooks: ReceiptWriteHooks,
): ImmutableReceiptWrite {
  const fullRelativePath = `${authority.relativeRoot}/${path}`;
  const chain = openPrivateDirectoryChain(authority.repositoryRoot, dirname(fullRelativePath).split("/"), true);
  const target = descriptorChild(chain.descriptors.at(-1)!, basename(path));
  const temporaryName = ownedSiblingTemporaryName(basename(path), "pending");
  const temporary = descriptorChild(chain.descriptors.at(-1)!, temporaryName);
  let temporaryDescriptor: number | undefined;
  let temporaryIdentity: BigIntStats | undefined;
  let published = false;
  let cleaned = false;
  let stage = "before-temporary-open";
  try {
    if (attempt !== undefined) {
      if (identityHash(chain.identities.at(-1)!) !== attempt.directoryIdentityHash) {
        throw receiptError("receipt_attempt_identity_changed", attempt.attemptId);
      }
    }
    hooks.beforeStage?.("after-temporary-open");
    temporaryDescriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      POLICY.fileMode,
    );
    fchmodSync(temporaryDescriptor, POLICY.fileMode);
    acceptDirectoryMutation(chain, chain.descriptors.length - 1, path);
    temporaryIdentity = fstatSync(temporaryDescriptor, { bigint: true });
    assertPrivateFileIdentity(temporaryIdentity, chain.rootDevice, temporaryName, 1n, 0n);
    stage = "after-temporary-open";
    hooks.afterStage?.("after-temporary-open");

    hooks.beforeStage?.("after-write");
    writeFileSync(temporaryDescriptor, bytes);
    stage = "after-write";
    hooks.afterStage?.("after-write");

    hooks.beforeStage?.("after-file-fsync");
    fsyncSync(temporaryDescriptor);
    temporaryIdentity = fstatSync(temporaryDescriptor, { bigint: true });
    assertPrivateFileIdentity(temporaryIdentity, chain.rootDevice, temporaryName, 1n, BigInt(bytes.length));
    stage = "after-file-fsync";
    hooks.afterStage?.("after-file-fsync");

    hooks.beforeStage?.("after-publish");
    try {
      linkSync(temporary, target);
      published = true;
      acceptDirectoryMutation(chain, chain.descriptors.length - 1, path);
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      const existing = existingDestination(authority, path, bytes, contentKind, mode);
      cleanupUnpublishedTemporary(chain, temporary);
      cleaned = true;
      return existing;
    }
    stage = "after-publish";
    hooks.afterStage?.("after-publish");

    hooks.beforeStage?.("after-target-verification");
    verifyPublishedTarget(chain, target, path, temporaryIdentity, bytes, 2n);
    stage = "after-target-verification";
    hooks.afterStage?.("after-target-verification");

    hooks.beforeStage?.("after-first-directory-fsync");
    fsyncSync(chain.descriptors.at(-1)!);
    stage = "after-first-directory-fsync";
    hooks.afterStage?.("after-first-directory-fsync");

    hooks.beforeStage?.("after-temporary-unlink");
    unlinkSync(temporary);
    acceptDirectoryMutation(chain, chain.descriptors.length - 1, path);
    stage = "after-temporary-unlink";
    hooks.afterStage?.("after-temporary-unlink");

    hooks.beforeStage?.("after-second-directory-fsync");
    fsyncSync(chain.descriptors.at(-1)!);
    stage = "after-second-directory-fsync";
    hooks.afterStage?.("after-second-directory-fsync");

    verifyPublishedTarget(chain, target, path, temporaryIdentity, bytes, 1n);
    recheckDirectoryChain(chain, path);
    cleaned = true;
    return deepFreeze({
      path,
      byteLength: bytes.length,
      sha256: sha256(bytes),
      disposition: "created",
      authorityStage: POLICY.authorityStage,
    });
  } catch (error) {
    if (published) {
      throw receiptError("receipt_write_ambiguous", `${path}:${stage}:${errorCode(error)}`);
    }
    if (!cleaned && temporaryDescriptor !== undefined) {
      try {
        cleanupUnpublishedTemporary(chain, temporary);
        cleaned = true;
      } catch (cleanupError) {
        throw receiptError("receipt_write_ambiguous", `${path}:${stage}:${errorCode(cleanupError)}`);
      }
    }
    if (error instanceof HarnessError) throw error;
    throw receiptError("receipt_write_failed", `${path}:${stage}:${errorCode(error)}`);
  } finally {
    if (temporaryDescriptor !== undefined) closeSync(temporaryDescriptor);
    closeDirectoryChain(chain);
  }
}

function existingDestination(
  authority: ReceiptAuthority,
  path: string,
  bytes: Buffer,
  contentKind: ReceiptContentKind,
  mode: ReceiptWriteRequest["mode"],
): ImmutableReceiptWrite {
  if (mode !== "content-addressed") throw receiptError("receipt_path_exists", path);
  let existing: Buffer | undefined;
  // A concurrent writer may be mid-publication: the read is retried, bounded,
  // and the last refusal is carried into the collision when none succeeds.
  let lastRefusal: unknown;
  for (let attempt = 0; attempt < POLICY.contentAddressedVerificationAttempts; attempt += 1) {
    try {
      existing = readImmutableEvidence(authority, path, contentKind);
      break;
    } catch (error) {
      lastRefusal = error;
      if (attempt + 1 < POLICY.contentAddressedVerificationAttempts) boundedPublicationWait();
    }
  }
  if (existing === undefined) throw receiptError("receipt_content_address_collision", `${path}:${errorCode(lastRefusal)}`);
  if (!existing.equals(bytes) || sha256(existing) !== sha256(bytes)) {
    throw receiptError("receipt_content_address_collision", path);
  }
  return deepFreeze({
    path,
    byteLength: bytes.length,
    sha256: sha256(bytes),
    disposition: "existing-identical",
    authorityStage: POLICY.authorityStage,
  });
}

function boundedPublicationWait(): void {
  const view = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(view, 0, 0, POLICY.contentAddressedVerificationWaitMilliseconds);
}

function cleanupUnpublishedTemporary(chain: DirectoryChain, temporary: string): void {
  unlinkSync(temporary);
  fsyncSync(chain.descriptors.at(-1)!);
  acceptDirectoryMutation(chain, chain.descriptors.length - 1, temporary);
}

function verifyPublishedTarget(
  chain: DirectoryChain,
  target: string,
  path: string,
  temporaryIdentity: BigIntStats,
  bytes: Buffer,
  expectedLinks: bigint,
): void {
  let descriptor: number | undefined;
  try {
    const before = lstatSync(target, { bigint: true, throwIfNoEntry: false });
    if (!before) throw receiptError("receipt_link_identity_invalid", path);
    assertPrivateFileIdentity(before, chain.rootDevice, path, expectedLinks, BigInt(bytes.length));
    descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedBefore = fstatSync(descriptor, { bigint: true });
    if (!sameInode(temporaryIdentity, openedBefore) || !sameIdentity(before, openedBefore)) {
      throw receiptError("receipt_link_identity_invalid", path);
    }
    const observed = readFileSync(descriptor);
    const openedAfter = fstatSync(descriptor, { bigint: true });
    const after = lstatSync(target, { bigint: true, throwIfNoEntry: false });
    if (!after || !sameIdentity(openedBefore, openedAfter) || !sameIdentity(before, after) ||
      !observed.equals(bytes)) {
      throw receiptError("receipt_link_bytes_invalid", path);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function destinationPath(authority: ReceiptAuthority, request: ReceiptWriteRequest, digest: string): string {
  let path: string;
  if (request.mode === "exclusive-path") {
    path = request.path;
  } else if (request.mode === "content-addressed") {
    path = contentAddressedPath(request.namespace, digest, request.extension);
  } else {
    validateAttempt(authority, request.attempt);
    if (!Number.isSafeInteger(request.ordinal) || request.ordinal < 0 || request.ordinal > 999_999) {
      throw receiptError("receipt_attempt_ordinal_invalid", String(request.ordinal));
    }
    if (!LABEL.test(request.label)) throw receiptError("receipt_attempt_label_invalid", request.label);
    validateExtension(request.extension);
    path = `${request.attempt.relativeDirectory}/${String(request.ordinal).padStart(6, "0")}-${request.label}-${digest}${request.extension}`;
  }
  validateRelativePath(path, "receipt_path_invalid");
  return path;
}

/** A content-addressed object's path under its authority: `<namespace>/sha256/<digest><extension>`, the one layout. */
function contentAddressedPath(namespace: string, digest: string, extension: string): string {
  validateRelativePath(namespace, "receipt_namespace_invalid");
  validateExtension(extension);
  if (!SHA256_HEX_REGEX.test(digest)) throw receiptError("receipt_content_address_invalid", digest);
  return `${namespace}/sha256/${digest}${extension}`;
}

function validateContent(bytes: Buffer, contentKind: ReceiptContentKind): void {
  if (bytes.length > POLICY.maximumBytes) throw receiptError("receipt_content_too_large", String(bytes.length));
  if (contentKind !== "canonical-json") return;
  if (bytes.length === 0 || bytes.includes(0) || bytes.at(-1) !== 0x0a || bytes.at(-2) === 0x0a) {
    throw receiptError("receipt_content_invalid", "json-framing");
  }
  // Every way the bytes fail to be the one canonical spelling is the same typed refusal.
  const notCanonical = (): HarnessError => receiptError("receipt_content_invalid", "json-canonicalization");
  let canonical: boolean;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    assertNoDuplicateJsonObjectKeys(text, "Receipt JSON has duplicate object keys", "receipt_content_invalid");
    canonical = text.charCodeAt(0) !== 0xfeff && `${canonicalJson(JSON.parse(text))}\n` === text;
  } catch {
    throw notCanonical();
  }
  if (!canonical) throw notCanonical();
}

function listDirectory(authority: ReceiptAuthority, path: string): readonly ReceiptAttemptDirectoryEntry[] {
  validateAuthority(authority);
  validateRelativePath(path, "receipt_path_invalid");
  const chain = openPrivateDirectoryChain(
    authority.repositoryRoot,
    `${authority.relativeRoot}/${path}`.split("/"),
    false,
  );
  try {
    const entries = readdirSync(descriptorPath(chain.descriptors.at(-1)!), { withFileTypes: true });
    if (entries.length > POLICY.maximumDirectoryEntries) throw receiptError("receipt_directory_too_large", path);
    recheckDirectoryChain(chain, path);
    const normalized: ReceiptAttemptDirectoryEntry[] = entries.map((entry) => ({
      name: entry.name,
      kind: entry.isFile() ? "file" : entry.isDirectory() ? "directory" :
        entry.isSymbolicLink() ? "symlink" : "other",
    }));
    return deepFreeze(normalized.toSorted((left, right) => left.name.localeCompare(right.name)));
  } finally {
    closeDirectoryChain(chain);
  }
}

function openPrivateDirectoryChain(
  repositoryRoot: string,
  segments: readonly string[],
  create: boolean,
  hooks: ReceiptAuthorityHooks = {},
): DirectoryChain {
  const descriptors: number[] = [];
  const identities: BigIntStats[] = [];
  const lexicalPaths: string[] = [];
  const mountPoints = readLinuxMountPoints();
  try {
    const rootDescriptor = openSync(repositoryRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const rootIdentity = fstatSync(rootDescriptor, { bigint: true });
    assertOwnedDirectory(rootIdentity, repositoryRoot, false);
    descriptors.push(rootDescriptor);
    identities.push(rootIdentity);
    lexicalPaths.push(repositoryRoot);
    let lexicalPath = repositoryRoot;
    for (const segment of segments) {
      if (segment.length === 0) continue;
      const childPath = descriptorChild(descriptors.at(-1)!, segment);
      lexicalPath = join(lexicalPath, segment);
      if (lstatSync(childPath, { bigint: true, throwIfNoEntry: false }) === undefined) {
        if (!create) throw receiptError("receipt_parent_missing", lexicalPath);
        const creationChain = {
          descriptors,
          identities,
          lexicalPaths,
          rootDevice: rootIdentity.dev,
          mountPoints,
        };
        const created = createPrivateDirectory(
          creationChain,
          segment,
          lexicalPath,
          hooks,
        );
        if (created) {
          descriptors.push(created.descriptor);
          identities.push(created.identity);
          lexicalPaths.push(lexicalPath);
          continue;
        }
      }
      const child = openPrivateDirectory(childPath, rootIdentity.dev, lexicalPath, mountPoints);
      descriptors.push(child.descriptor);
      identities.push(child.identity);
      lexicalPaths.push(lexicalPath);
    }
    return { descriptors, identities, lexicalPaths, rootDevice: rootIdentity.dev, mountPoints };
  } catch (error) {
    for (const descriptor of descriptors.toReversed()) closeSync(descriptor);
    if (error instanceof HarnessError) throw error;
    throw receiptError("receipt_parent_unsafe", `${repositoryRoot}:${errorCode(error)}`);
  }
}

function createPrivateDirectory(
  chain: DirectoryChain,
  name: string,
  lexicalPath: string,
  hooks: ReceiptAuthorityHooks = {},
): Readonly<{ descriptor: number; identity: BigIntStats }> | undefined {
  if (process.platform !== "linux") {
    throw receiptError("receipt_linux_path_descriptor_unavailable", lexicalPath);
  }
  const parentDescriptor = chain.descriptors.at(-1)!;
  const path = descriptorChild(parentDescriptor, name);
  const workerResult = runPrivateDirectoryCreateWorkerForReceiptInternal(
    parentDescriptor,
    chain.identities.at(-1)!,
    chain.lexicalPaths.at(-1)!,
    name,
  );
  if (workerResult.disposition === "existing") return undefined;

  let pathDescriptor: number | undefined;
  let durableDescriptor: number | undefined;
  try {
    pathDescriptor = openSync(
      path,
      ROOT_POLICY.receipts.immutableExecution.linuxPathOnlyOpenFlag |
        constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const before = fstatSync(pathDescriptor, { bigint: true });
    if (!workerResult.identity || before.dev.toString(10) !== workerResult.identity.device ||
      before.ino.toString(10) !== workerResult.identity.inode ||
      before.uid.toString(10) !== workerResult.identity.ownerUid ||
      before.gid.toString(10) !== workerResult.identity.ownerGid ||
      (before.mode & 0o7777n).toString(8).padStart(4, "0") !== workerResult.identity.mode) {
      throw receiptError("receipt_parent_identity_changed", lexicalPath);
    }
    hooks.afterStage?.("after-directory-mkdir", lexicalPath);
    assertOwnedDirectory(before, lexicalPath, false);
    if (before.dev !== chain.rootDevice || chain.mountPoints.has(lexicalPath)) {
      throw receiptError("receipt_parent_boundary", lexicalPath);
    }
    const after = fstatSync(pathDescriptor, { bigint: true });
    const lexical = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    assertOwnedDirectory(after, lexicalPath, true);
    if (!lexical || !sameDirectoryInodeOwner(before, after) || !sameDirectoryIdentity(after, lexical)) {
      throw receiptError("receipt_parent_identity_changed", lexicalPath);
    }
    hooks.afterStage?.("after-directory-mode-enforcement", lexicalPath);
    const durable = openPrivateDirectory(
      descriptorPath(pathDescriptor),
      chain.rootDevice,
      lexicalPath,
      chain.mountPoints,
      "pinned-proc-descriptor",
    );
    durableDescriptor = durable.descriptor;
    if (!sameDirectoryIdentity(after, durable.identity)) {
      throw receiptError("receipt_parent_identity_changed", lexicalPath);
    }
    hooks.afterStage?.("after-directory-durable-open", lexicalPath);
    fsyncSync(durableDescriptor);
    fsyncSync(parentDescriptor);
    hooks.afterStage?.("after-directory-fsync", lexicalPath);
    const finalIdentity = fstatSync(durableDescriptor, { bigint: true });
    const finalLexical = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (!finalLexical || finalLexical.isSymbolicLink() ||
      !sameDirectoryIdentity(after, finalIdentity) ||
      !sameDirectoryIdentity(finalIdentity, finalLexical)) {
      throw receiptError("receipt_parent_identity_changed", lexicalPath);
    }
    const result = { descriptor: durableDescriptor, identity: finalIdentity };
    durableDescriptor = undefined;
    return result;
  } catch (error) {
    if (durableDescriptor !== undefined) closeSync(durableDescriptor);
    if (!cleanupCreatedPrivateDirectory(parentDescriptor, path, pathDescriptor)) {
      throw receiptError("receipt_parent_create_ambiguous", `${lexicalPath}:${errorCode(error)}`);
    }
    if (error instanceof HarnessError) throw error;
    throw receiptError("receipt_parent_create_failed", `${lexicalPath}:${errorCode(error)}`);
  } finally {
    if (pathDescriptor !== undefined) closeSync(pathDescriptor);
  }
}

function cleanupCreatedPrivateDirectory(
  parentDescriptor: number,
  path: string,
  pathDescriptor: number | undefined,
): boolean {
  if (pathDescriptor === undefined) return false;
  try {
    const pinned = fstatSync(pathDescriptor, { bigint: true });
    const lexical = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (!lexical || !sameDirectoryIdentity(pinned, lexical)) return false;
    rmdirSync(path);
    fsyncSync(parentDescriptor);
    return true;
  } catch {
    return false;
  }
}

function openPrivateDirectory(
  path: string,
  rootDevice: bigint,
  lexicalPath: string,
  mountPoints: ReadonlySet<string>,
  pathAuthority: DirectoryOpenPathAuthority = "lexical-no-follow",
): Readonly<{ descriptor: number; identity: BigIntStats }> {
  let descriptor: number | undefined;
  try {
    const flags = pathAuthority === "pinned-proc-descriptor"
      ? constants.O_RDONLY | constants.O_DIRECTORY
      : constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    descriptor = openSync(path, flags);
    const identity = fstatSync(descriptor, { bigint: true });
    assertOwnedDirectory(identity, lexicalPath, true);
    if (identity.dev !== rootDevice || mountPoints.has(lexicalPath)) {
      throw receiptError("receipt_parent_boundary", lexicalPath);
    }
    return { descriptor, identity };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (error instanceof HarnessError) throw error;
    if (pathAuthority === "pinned-proc-descriptor") {
      throw receiptError("receipt_parent_unsafe", lexicalPath);
    }
    const stats = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    throw receiptError(stats?.isSymbolicLink() ? "receipt_parent_symlink" : "receipt_parent_unsafe", lexicalPath);
  }
}

function inspectImmutableFile(
  path: string,
  rootDevice: bigint,
  lexicalPath: string,
  mountPoints: ReadonlySet<string>,
): BigIntStats {
  const stats = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!stats) throw receiptError("receipt_file_missing", lexicalPath);
  assertPrivateFileIdentity(stats, rootDevice, lexicalPath, 1n, stats.size);
  if (mountPoints.has(lexicalPath)) throw receiptError("receipt_file_boundary", lexicalPath);
  return stats;
}

function assertPrivateFileIdentity(
  stats: BigIntStats,
  rootDevice: bigint,
  path: string,
  expectedLinks: bigint,
  expectedSize: bigint,
): void {
  const uid = process.getuid?.();
  if (!stats.isFile() || stats.isSymbolicLink() || uid === undefined || stats.uid !== BigInt(uid) ||
    stats.dev !== rootDevice || stats.nlink !== expectedLinks || stats.size !== expectedSize ||
    (stats.mode & 0o7777n) !== BigInt(POLICY.fileMode) || stats.size > BigInt(POLICY.maximumBytes)) {
    throw receiptError("receipt_file_unsafe", path);
  }
}

function assertRemediableFileIdentity(
  stats: BigIntStats,
  rootDevice: bigint,
  path: string,
  expectedSize: number,
): void {
  const uid = process.getuid?.();
  if (!stats.isFile() || stats.isSymbolicLink() || uid === undefined || stats.uid !== BigInt(uid) ||
    stats.dev !== rootDevice || hasSecondName(stats.nlink) || stats.size !== BigInt(expectedSize) ||
    stats.size > BigInt(POLICY.maximumBytes)) {
    throw receiptError("receipt_mode_remediation_file_unsafe", path);
  }
}

function assertOwnedDirectory(stats: BigIntStats, path: string, privateMode: boolean): void {
  const uid = process.getuid?.();
  if (!stats.isDirectory() || stats.isSymbolicLink() || uid === undefined || stats.uid !== BigInt(uid) ||
    (privateMode && (stats.mode & 0o7777n) !== BigInt(POLICY.evidenceRootMode))) {
    throw receiptError("receipt_parent_unsafe", path);
  }
}

function recheckDirectoryChain(chain: DirectoryChain, path: string): void {
  for (let index = 0; index < chain.descriptors.length; index += 1) {
    const opened = fstatSync(chain.descriptors[index]!, { bigint: true });
    const lexical = lstatSync(chain.lexicalPaths[index]!, { bigint: true, throwIfNoEntry: false });
    if (!lexical || lexical.isSymbolicLink() || !sameDirectoryIdentity(opened, chain.identities[index]!) ||
      !sameDirectoryIdentity(opened, lexical)) {
      throw receiptError("receipt_parent_identity_changed", path);
    }
  }
}

function acceptDirectoryMutation(chain: DirectoryChain, index: number, path: string): void {
  const opened = fstatSync(chain.descriptors[index]!, { bigint: true });
  const lexical = lstatSync(chain.lexicalPaths[index]!, { bigint: true, throwIfNoEntry: false });
  if (!lexical || lexical.isSymbolicLink() || !sameDirectoryIdentity(opened, lexical)) {
    throw receiptError("receipt_parent_identity_changed", path);
  }
  assertOwnedDirectory(opened, chain.lexicalPaths[index]!, index !== 0);
  chain.identities[index] = opened;
}

function closeDirectoryChain(chain: DirectoryChain): void {
  for (const descriptor of chain.descriptors.toReversed()) closeSync(descriptor);
}

function validateRepositoryRoot(input: string): string {
  if (!isAbsolute(input) || resolve(input) !== input || input.includes("\0")) {
    throw receiptError("receipt_repository_root_invalid", input);
  }
  let canonical: string;
  try {
    canonical = realpathSync(input);
  } catch {
    throw receiptError("receipt_repository_root_invalid", input);
  }
  if (canonical !== input) throw receiptError("receipt_repository_root_invalid", input);
  const stats = lstatSync(input, { bigint: true, throwIfNoEntry: false });
  if (!stats) throw receiptError("receipt_repository_root_invalid", input);
  assertOwnedDirectory(stats, input, false);
  return input;
}

function validateAuthority(authority: ReceiptAuthority): void {
  if (canonicalHash({ repositoryRoot: authority.repositoryRoot, relativeRoot: authority.relativeRoot }) !==
    authority.authorityHash || authority.absoluteRoot !== join(authority.repositoryRoot, ...authority.relativeRoot.split("/"))) {
    throw receiptError("receipt_authority_invalid", authority.relativeRoot);
  }
}

function validateAttempt(authority: ReceiptAuthority, attempt: ReceiptAttempt): void {
  validateAuthority(attempt.authority);
  if (attempt.authority.authorityHash !== authority.authorityHash || !UUID_V4.test(attempt.attemptId) ||
    attempt.relativeDirectory !== `attempts/${attempt.attemptId}` || !SHA256_HEX_REGEX.test(attempt.directoryIdentityHash)) {
    throw receiptError("receipt_attempt_invalid", attempt.attemptId);
  }
}

function validateRelativePath(path: string, code: string): void {
  if (Buffer.byteLength(path, "utf8") > POLICY.maximumPathBytes || relativePathViolationKinds(path).length > 0) {
    throw receiptError(code, path);
  }
}

function validateExtension(extension: string): void {
  if (!EXTENSION.test(extension)) throw receiptError("receipt_extension_invalid", extension);
}

function descriptorPath(descriptor: number): string {
  return join(POLICY.procFileDescriptorRoot, String(descriptor));
}

function descriptorChild(descriptor: number, child: string): string {
  return join(descriptorPath(descriptor), child);
}

function sameInode(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameDirectoryIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return sameInode(left, right) && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid;
}

function sameDirectoryInodeOwner(left: BigIntStats, right: BigIntStats): boolean {
  return sameInode(left, right) && left.uid === right.uid && left.gid === right.gid;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return sameInode(left, right) && left.mode === right.mode && left.uid === right.uid &&
    left.gid === right.gid && left.nlink === right.nlink && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function sameStableFileIdentityIgnoringModeAndCtime(left: BigIntStats, right: BigIntStats): boolean {
  return sameInode(left, right) && left.uid === right.uid && left.gid === right.gid &&
    left.nlink === right.nlink && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

function immutableFileIdentity(stats: BigIntStats): ImmutableReceiptFileIdentity {
  return deepFreeze({
    device: stats.dev.toString(10),
    inode: stats.ino.toString(10),
    ownerUid: stats.uid.toString(10),
    ownerGid: stats.gid.toString(10),
    links: stats.nlink.toString(10),
    mode: (stats.mode & 0o7777n).toString(8).padStart(4, "0"),
    size: stats.size.toString(10),
    modifiedNanoseconds: stats.mtimeNs.toString(10),
  });
}

function readDescriptorBytes(descriptor: number, expectedByteLength: number): Buffer {
  const bytes = Buffer.alloc(expectedByteLength);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (count === 0) throw receiptError("receipt_descriptor_short_read", String(expectedByteLength));
    offset += count;
  }
  const overflow = Buffer.alloc(1);
  if (readSync(descriptor, overflow, 0, 1, expectedByteLength) !== 0) {
    throw receiptError("receipt_descriptor_length_changed", String(expectedByteLength));
  }
  return bytes;
}

function identityHash(stats: BigIntStats): string {
  return canonicalHash({
    device: stats.dev.toString(10),
    inode: stats.ino.toString(10),
    mode: stats.mode.toString(8),
    ownerUid: stats.uid.toString(10),
    ownerGid: stats.gid.toString(10),
  });
}

function receiptError(code: string, value: string): HarnessError {
  return new HarnessError("Immutable receipt operation failed", code, false, {
    valueSha256: sha256(value),
  });
}

function errorCode(error: unknown): string {
  return error instanceof HarnessError ? error.code :
    error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "unknown";
}

function isHarnessCode(error: unknown, code: string): boolean {
  return error instanceof HarnessError && error.code === code;
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
