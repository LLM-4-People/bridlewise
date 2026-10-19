import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  type BigIntStats,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { HarnessError } from "../kernel/errors.ts";
import { canonicalHash, deepFreeze } from "../kernel/integrity.ts";
import { readLinuxMountPoints } from "./linux-path.ts";
import { relativePathViolationKinds } from "./path-boundary.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { handleError } from "../shared/debug/debug-system.ts";

export type PinnedPathIdentity = Readonly<{
  device: string;
  inode: string;
  mode: string;
  ownerUid: string;
  ownerGid: string;
  links: string;
  size: string;
  modifiedNanoseconds: string;
  changedNanoseconds: string;
}>;

export type PinnedRepositoryPathChain = Readonly<{
  descriptors: readonly number[];
  identities: readonly BigIntStats[];
  lexicalPaths: readonly string[];
  leafDescriptorPath: string;
  leafLexicalPath: string;
  leafIsHeldRoot: boolean;
  rootDescriptorIndex: number;
  identityBoundary: "repository-root" | "file-leaf";
  rootDevice: bigint;
  mountPoints: ReadonlySet<string>;
}>;

export type PinnedAbsoluteFile = Readonly<{
  chain: PinnedRepositoryPathChain;
  descriptor: number;
  identity: BigIntStats;
}>;

export type PinnedDirectoryChild = Readonly<{
  descriptor: number;
  identity: BigIntStats;
}>;

const PROC_FILE_DESCRIPTOR_ROOT = ROOT_POLICY.verification.safeRepositoryRead.procFileDescriptorRoot;
const ANCESTOR_COMPONENT_FAILURE_CODES = {
  symlink: "safe_path_ancestor_symlink",
  unsafe: "safe_path_ancestor_unsafe",
} as const;
const ROOT_COMPONENT_FAILURE_CODES = {
  symlink: "safe_path_root_symlink",
  unsafe: "safe_path_ancestor_unsafe",
} as const;

type DirectoryComponentFailureCodes = Readonly<{
  symlink: string;
  unsafe: string;
}>;

export function openPinnedRepositoryAncestorChain(
  rootInput: string,
  path: string,
  rootBoundaryPolicy: "reject-root-mountpoints" | "root-is-boundary" = "reject-root-mountpoints",
): PinnedRepositoryPathChain {
  const root = resolve(rootInput);
  const comparableRoot = rootInput === "/" ? rootInput : rootInput.replace(/\/+$/u, "");
  if (!isAbsolute(rootInput) || root !== comparableRoot || root === "/" ||
    (path !== "." && relativePathViolationKinds(path).length > 0)) {
    throw pinnedPathError("safe_path_invalid", path);
  }
  return openPinnedChain(root, path, true, rootBoundaryPolicy);
}

/**
 * Opens a repository chain beneath an already-held trusted directory. This is
 * pathname-assisted descriptor traversal, not an openat2 equivalence claim.
 */
export function openPinnedRepositoryDescendantChain(
  heldRootDescriptor: number,
  heldRootIdentity: BigIntStats,
  heldRootPath: string,
  repositoryRootPath: string,
  path: string,
): PinnedRepositoryPathChain {
  const canonicalHeldRoot = resolve(heldRootPath);
  const canonicalRepositoryRoot = resolve(repositoryRootPath);
  const comparableHeldRoot = heldRootPath === "/" ? heldRootPath : heldRootPath.replace(/\/+$/u, "");
  const comparableRepositoryRoot = repositoryRootPath === "/"
    ? repositoryRootPath
    : repositoryRootPath.replace(/\/+$/u, "");
  const rootRelativePlatform = relative(canonicalHeldRoot, canonicalRepositoryRoot);
  const rootRelative = rootRelativePlatform.split(sep).join("/");
  if (!isAbsolute(heldRootPath) || canonicalHeldRoot !== comparableHeldRoot ||
    !isAbsolute(repositoryRootPath) || canonicalRepositoryRoot !== comparableRepositoryRoot ||
    canonicalHeldRoot === "/" ||
    (rootRelative !== "" && relativePathViolationKinds(rootRelative).length > 0) ||
    (path !== "." && relativePathViolationKinds(path).length > 0)) {
    throw pinnedPathError("safe_path_invalid", path);
  }

  const descriptors: number[] = [];
  const identities: BigIntStats[] = [];
  const lexicalPaths: string[] = [];
  const mountPoints = readLinuxMountPoints();
  try {
    openHeldDirectoryComponent(
      pinnedDescriptorPath(heldRootDescriptor),
      canonicalHeldRoot,
      path,
      descriptors,
      identities,
      lexicalPaths,
      heldRootIdentity,
    );
    let currentDescriptorPath = pinnedDescriptorPath(descriptors[0]!);
    let lexicalPath = canonicalHeldRoot;
    const rootComponents = rootRelative === "" ? [] : rootRelative.split("/");
    for (const [index, component] of rootComponents.entries()) {
      const isRepositoryRoot = index === rootComponents.length - 1;
      currentDescriptorPath = join(pinnedDescriptorPath(descriptors.at(-1)!), component);
      lexicalPath = join(lexicalPath, component);
      if (mountPoints.has(lexicalPath)) {
        throw pinnedPathError(
          isRepositoryRoot ? "safe_path_root_mountpoint" : "safe_path_root_ancestor_mountpoint",
          path,
        );
      }
      openDirectoryComponent(
        currentDescriptorPath,
        lexicalPath,
        path,
        descriptors,
        identities,
        lexicalPaths,
        isRepositoryRoot ? ROOT_COMPONENT_FAILURE_CODES : ANCESTOR_COMPONENT_FAILURE_CODES,
      );
      if (identities.at(-1)!.dev !== identities[0]!.dev) {
        throw pinnedPathError("safe_path_root_cross_device", path);
      }
    }
    const rootDescriptorIndex = descriptors.length - 1;
    const segments = path === "." ? [] : path.split("/");
    for (const component of segments.slice(0, -1)) {
      currentDescriptorPath = join(pinnedDescriptorPath(descriptors.at(-1)!), component);
      lexicalPath = join(lexicalPath, component);
      if (mountPoints.has(lexicalPath)) throw pinnedPathError("safe_path_boundary", path);
      openDirectoryComponent(
        currentDescriptorPath,
        lexicalPath,
        path,
        descriptors,
        identities,
        lexicalPaths,
        ANCESTOR_COMPONENT_FAILURE_CODES,
      );
      if (identities.at(-1)!.dev !== identities[rootDescriptorIndex]!.dev) {
        throw pinnedPathError("safe_path_boundary", path);
      }
    }
    const leafIsHeldRoot = segments.length === 0;
    const leafName = segments.at(-1);
    return {
      descriptors,
      identities,
      lexicalPaths,
      leafDescriptorPath: leafIsHeldRoot
        ? pinnedDescriptorPath(descriptors[rootDescriptorIndex]!)
        : join(pinnedDescriptorPath(descriptors.at(-1)!), leafName!),
      leafLexicalPath: leafIsHeldRoot ? canonicalRepositoryRoot : join(lexicalPaths.at(-1)!, leafName!),
      leafIsHeldRoot,
      rootDescriptorIndex,
      identityBoundary: "repository-root",
      rootDevice: identities[rootDescriptorIndex]!.dev,
      mountPoints,
    };
  } catch (error) {
    closePinnedPathChain({
      descriptors,
      identities,
      lexicalPaths,
      leafDescriptorPath: "",
      leafLexicalPath: "",
      leafIsHeldRoot: false,
      rootDescriptorIndex: -1,
      identityBoundary: "repository-root",
      rootDevice: 0n,
      mountPoints,
    });
    throw error;
  }
}

export function openPinnedAbsoluteFile(path: string, maximumBytes: number): PinnedAbsoluteFile {
  if (!isAbsolute(path) || resolve(path) !== path || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw pinnedPathError("pinned_absolute_file_invalid", path);
  }
  const components = path.slice(1).split("/");
  if (components.length === 0 || components.some((component) => component.length === 0 ||
    component === "." || component === ".." || component.includes("\0"))) {
    throw pinnedPathError("pinned_absolute_file_invalid", path);
  }
  const chain = openPinnedChain("/", components.slice(0, -1).join("/") || ".", false, "root-is-boundary");
  let descriptor: number | undefined;
  try {
    const leafName = components.at(-1)!;
    const leafPath = join(PROC_FILE_DESCRIPTOR_ROOT, String(chain.descriptors.at(-1)!), leafName);
    const before = lstatSync(leafPath, { bigint: true, throwIfNoEntry: false });
    if (!before || before.isSymbolicLink() || !before.isFile() || before.size > BigInt(maximumBytes)) {
      throw pinnedPathError("pinned_absolute_file_unsafe", path);
    }
    descriptor = openSync(leafPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!samePinnedPathIdentity(before, opened)) {
      throw pinnedPathError("pinned_absolute_file_identity_changed", path);
    }
    const descriptors = [...chain.descriptors, descriptor];
    const identities = [...chain.identities, opened];
    const lexicalPaths = [...chain.lexicalPaths, path];
    descriptor = undefined;
    return {
      chain: { ...chain, descriptors, identities, lexicalPaths, identityBoundary: "file-leaf", leafDescriptorPath: path,
        leafLexicalPath: path, leafIsHeldRoot: false },
      descriptor: descriptors.at(-1)!,
      identity: opened,
    };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    closePinnedPathChain(chain);
    throw error;
  }
}

export function openPinnedDirectoryChild(
  parentDescriptor: number,
  segment: string,
  lexicalPath: string,
): PinnedDirectoryChild {
  let descriptor: number | undefined;
  try {
    const path = pinnedDescriptorChildPath(parentDescriptor, segment);
    const lexical = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (lexical?.isSymbolicLink()) {
      throw pinnedPathError(ANCESTOR_COMPONENT_FAILURE_CODES.symlink, lexicalPath);
    }
    if (!lexical) throw pinnedPathError(ANCESTOR_COMPONENT_FAILURE_CODES.unsafe, lexicalPath);
    descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const identity = fstatSync(descriptor, { bigint: true });
    if (!sameStablePinnedPathIdentity(identity, lexical) || !identity.isDirectory()) {
      throw pinnedPathError(ANCESTOR_COMPONENT_FAILURE_CODES.unsafe, lexicalPath);
    }
    const result = { descriptor, identity };
    descriptor = undefined;
    return result;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function pinnedDescriptorPath(descriptor: number): string {
  return join(PROC_FILE_DESCRIPTOR_ROOT, String(descriptor));
}

export function pinnedDescriptorChildPath(descriptor: number, segment: string): string {
  return join(pinnedDescriptorPath(descriptor), segment);
}

export function recheckPinnedPathChain(chain: PinnedRepositoryPathChain, path: string): void {
  // Immutable files bind every ancestor by stable custody and the leaf by complete metadata.
  // Repository enumeration/mutation chains retain their full directory-boundary checks.
  const boundary = chain.identityBoundary === "file-leaf" ? chain.descriptors.length - 1 : chain.rootDescriptorIndex;
  for (let index = 0; index < chain.descriptors.length; index += 1) {
    const opened = fstatSync(chain.descriptors[index]!, { bigint: true });
    const lexical = lstatSync(chain.lexicalPaths[index]!, { bigint: true, throwIfNoEntry: false });
    const same = index < boundary ? sameStablePinnedPathIdentity : samePinnedPathIdentity;
    if (!lexical || lexical.isSymbolicLink() || !same(opened, chain.identities[index]!) ||
      !same(opened, lexical)) {
      throw pinnedPathError("safe_path_identity_changed", path);
    }
  }
}

export function acceptPinnedDirectoryMutation(
  chain: PinnedRepositoryPathChain,
  descriptorIndex: number,
  path: string,
): void {
  const expected = chain.identities[descriptorIndex];
  const lexicalPath = chain.lexicalPaths[descriptorIndex];
  const descriptor = chain.descriptors[descriptorIndex];
  if (expected === undefined || lexicalPath === undefined || descriptor === undefined) {
    throw pinnedPathError("safe_path_identity_changed", path);
  }
  const opened = fstatSync(descriptor, { bigint: true });
  const lexical = lstatSync(lexicalPath, { bigint: true, throwIfNoEntry: false });
  if (!lexical || lexical.isSymbolicLink() || !sameStablePinnedPathIdentity(expected, opened) ||
    !sameStablePinnedPathIdentity(opened, lexical)) {
    throw pinnedPathError("safe_path_identity_changed", path);
  }
  (chain.identities as BigIntStats[])[descriptorIndex] = opened;
}

export function closePinnedPathChain(chain: PinnedRepositoryPathChain | undefined): void {
  if (chain === undefined) return;
  let firstError: unknown;
  for (const descriptor of chain.descriptors.toReversed()) {
    try {
      closeSync(descriptor);
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) throw firstError;
}

export function samePinnedPathIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

export function sameStablePinnedPathIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.uid === right.uid && left.gid === right.gid;
}

export function pinnedPathIdentity(stats: BigIntStats): PinnedPathIdentity {
  return deepFreeze({
    device: stats.dev.toString(10),
    inode: stats.ino.toString(10),
    mode: stats.mode.toString(8),
    ownerUid: stats.uid.toString(10),
    ownerGid: stats.gid.toString(10),
    links: stats.nlink.toString(10),
    size: stats.size.toString(10),
    modifiedNanoseconds: stats.mtimeNs.toString(10),
    changedNanoseconds: stats.ctimeNs.toString(10),
  });
}

export function pinnedPathIdentityHash(stats: BigIntStats): string {
  return canonicalHash(pinnedPathIdentity(stats));
}

function openPinnedChain(
  root: string,
  path: string,
  enforceRepositoryBoundary: boolean,
  rootBoundaryPolicy: "reject-root-mountpoints" | "root-is-boundary",
): PinnedRepositoryPathChain {
  const segments = path === "." ? [] : path.split("/");
  const ancestors = enforceRepositoryBoundary ? segments.slice(0, -1) : segments;
  const descriptors: number[] = [];
  const identities: BigIntStats[] = [];
  const lexicalPaths: string[] = [];
  const mountPoints = readLinuxMountPoints();
  let currentDescriptorPath = "/";
  let lexicalPath = "/";
  let rootDescriptorIndex = -1;
  try {
    openDirectoryComponent(currentDescriptorPath, lexicalPath, path, descriptors, identities, lexicalPaths,
      ANCESTOR_COMPONENT_FAILURE_CODES);
    const rootComponents = root.split("/").filter(Boolean);
    for (const [componentIndex, component] of rootComponents.entries()) {
      const isRepositoryRoot = componentIndex === rootComponents.length - 1;
      currentDescriptorPath = join(PROC_FILE_DESCRIPTOR_ROOT, String(descriptors.at(-1)!), component);
      lexicalPath = join(lexicalPath, component);
      if (enforceRepositoryBoundary && rootBoundaryPolicy === "reject-root-mountpoints" &&
        mountPoints.has(lexicalPath)) {
        throw pinnedPathError(
          isRepositoryRoot ? "safe_path_root_mountpoint" : "safe_path_root_ancestor_mountpoint",
          path,
        );
      }
      openDirectoryComponent(currentDescriptorPath, lexicalPath, path, descriptors, identities, lexicalPaths,
        isRepositoryRoot ? ROOT_COMPONENT_FAILURE_CODES : ANCESTOR_COMPONENT_FAILURE_CODES);
      if (enforceRepositoryBoundary && rootBoundaryPolicy === "reject-root-mountpoints" &&
        identities.at(-1)!.dev !== identities.at(-2)!.dev) {
        throw pinnedPathError("safe_path_root_cross_device", path);
      }
    }
    rootDescriptorIndex = descriptors.length - 1;
    for (const component of ancestors) {
      currentDescriptorPath = join(PROC_FILE_DESCRIPTOR_ROOT, String(descriptors.at(-1)!), component);
      lexicalPath = join(lexicalPath, component);
      if (enforceRepositoryBoundary && mountPoints.has(lexicalPath)) {
        throw pinnedPathError("safe_path_boundary", path);
      }
      openDirectoryComponent(currentDescriptorPath, lexicalPath, path, descriptors, identities, lexicalPaths,
        ANCESTOR_COMPONENT_FAILURE_CODES);
      if (enforceRepositoryBoundary && identities.at(-1)!.dev !== identities[rootDescriptorIndex]!.dev) {
        throw pinnedPathError("safe_path_boundary", path);
      }
    }
    const leafIsHeldRoot = segments.length === 0;
    const leafName = segments.at(-1);
    return {
      descriptors,
      identities,
      lexicalPaths,
      leafDescriptorPath: leafIsHeldRoot
        ? join(PROC_FILE_DESCRIPTOR_ROOT, String(descriptors[rootDescriptorIndex]!))
        : join(PROC_FILE_DESCRIPTOR_ROOT, String(descriptors.at(-1)!), leafName!),
      leafLexicalPath: leafIsHeldRoot ? root : join(lexicalPaths.at(-1)!, leafName!),
      leafIsHeldRoot,
      rootDescriptorIndex,
      identityBoundary: "repository-root",
      rootDevice: identities[rootDescriptorIndex]!.dev,
      mountPoints,
    };
  } catch (error) {
    closePinnedPathChain({ descriptors, identities, lexicalPaths, leafDescriptorPath: "",
      leafLexicalPath: "", leafIsHeldRoot: false, rootDescriptorIndex, identityBoundary: "repository-root", rootDevice: 0n, mountPoints });
    throw error;
  }
}

function openDirectoryComponent(
  descriptorPath: string,
  lexicalPath: string,
  requestedPath: string,
  descriptors: number[],
  identities: BigIntStats[],
  lexicalPaths: string[],
  failureCodes: DirectoryComponentFailureCodes,
): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(descriptorPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const identity = fstatSync(descriptor, { bigint: true });
    const lexical = lstatSync(lexicalPath, { bigint: true, throwIfNoEntry: false });
    if (lexical?.isSymbolicLink()) throw pinnedPathError(failureCodes.symlink, requestedPath);
    if (!lexical || !identity.isDirectory() || !sameStablePinnedPathIdentity(identity, lexical)) {
      throw pinnedPathError(failureCodes.unsafe, requestedPath);
    }
    descriptors.push(descriptor);
    identities.push(identity);
    lexicalPaths.push(lexicalPath);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (error instanceof HarnessError) throw error;
    let lexical: BigIntStats | undefined;
    try {
      lexical = lstatSync(lexicalPath, { bigint: true, throwIfNoEntry: false });
    } catch (e) {handleError(e, { module: "filesystem-pinned-path-internal", operation: "catch" });
      lexical = undefined;
    }
    throw pinnedPathError(
      lexical?.isSymbolicLink() ? failureCodes.symlink : failureCodes.unsafe,
      requestedPath,
    );
  }
}

/**
 * Reopens a held directory through the qualified Linux `/proc/self/fd`
 * adapter. The proc entry is intentionally a magic symlink, so O_NOFOLLOW
 * cannot be used on this one trusted descriptor reference. Exact descriptor
 * and lexical identities are checked before the reopened descriptor is kept.
 */
function openHeldDirectoryComponent(
  descriptorPath: string,
  lexicalPath: string,
  requestedPath: string,
  descriptors: number[],
  identities: BigIntStats[],
  lexicalPaths: string[],
  expectedIdentity: BigIntStats,
): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(descriptorPath, constants.O_RDONLY | constants.O_DIRECTORY);
    const identity = fstatSync(descriptor, { bigint: true });
    const lexical = lstatSync(lexicalPath, { bigint: true, throwIfNoEntry: false });
    if (!lexical || lexical.isSymbolicLink() || !identity.isDirectory() ||
      !sameStablePinnedPathIdentity(expectedIdentity, identity) ||
      !sameStablePinnedPathIdentity(identity, lexical)) {
      throw pinnedPathError("safe_path_root_capability_identity_changed", requestedPath);
    }
    descriptors.push(descriptor);
    identities.push(identity);
    lexicalPaths.push(lexicalPath);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (error instanceof HarnessError) throw error;
    throw pinnedPathError("safe_path_root_capability_identity_changed", requestedPath);
  }
}

function pinnedPathError(code: string, path: string): HarnessError {
  return new HarnessError("Pinned filesystem path access denied", code, false, {
    pathHash: canonicalHash({ path }),
  });
}
