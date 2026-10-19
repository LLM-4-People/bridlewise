import {
  closeSync,
  fstatSync,
  lstatSync,
  type BigIntStats,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { HarnessError } from "../kernel/errors.ts";
import { canonicalDomainHash, randomBytes } from "../kernel/integrity.ts";
import { relativePathViolationKinds } from "./path-boundary.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { assertNotProxy, isProxyValue } from "../kernel/safe-structural.ts";
import { assertNever } from "../shared/type-guards.ts";
import {
  closePinnedPathChain,
  openPinnedRepositoryAncestorChain,
  openPinnedRepositoryDescendantChain,
  pinnedPathIdentity,
  sameStablePinnedPathIdentity,
  type PinnedRepositoryPathChain,
} from "./pinned-path-internal.ts";
import {
  deriveRepositoryRootCapabilityLeaseIdentity,
  repositoryRootCapabilityBorrowLimitViolation,
  type RepositoryRootCapability,
  type RepositoryRootCapabilityAcquisition,
  type RepositoryRootCapabilityBorrow,
  type RepositoryRootCapabilityLeaseIdentityInput,
  type RepositoryRootCapabilityPurpose,
  type RepositoryRootCapabilityScope,
  type RepositoryRootCapabilityTermination,
} from "./repository-root-capability-contracts.ts";
import { inspectRepositoryRootCapabilityAdapterAvailability } from
  "./repository-root-capability-linux-adapter-internal.ts";

export {
  deriveRepositoryRootCapabilityLeaseIdentity,
  repositoryRootCapabilityAdapterAvailabilityForObservedState,
  repositoryRootCapabilityBorrowLimitViolation,
  repositoryRootCapabilityExpectedRawFileMode,
} from "./repository-root-capability-contracts.ts";
export type {
  RepositoryRootCapability,
  RepositoryRootCapabilityBorrow,
  RepositoryRootCapabilityLeaseIdentityInput,
  RepositoryRootCapabilityRawFileModeCategory,
  RepositoryRootCapabilityTermination,
} from "./repository-root-capability-contracts.ts";
export { inspectRepositoryRootCapabilityAdapterAvailability } from
  "./repository-root-capability-linux-adapter-internal.ts";

const POLICY = ROOT_POLICY.verification.testFixtures.repositoryRootCapability;
const [QUALIFIED_TEST_SCOPE, REPOSITORY_LOCAL_TEST_SCOPE] = POLICY.capabilityScopes;
const [CREATE_LOCAL_ROOT_PURPOSE, SAFE_READ_PURPOSE] = POLICY.capabilityPurposes;
const [MODULE_RELATIVE_ACQUISITION, EXCLUSIVE_CREATE_ACQUISITION] = POLICY.capabilityAcquisitions;
const QUALIFIED_TEST_REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));

type Lifecycle = "active" | RepositoryRootCapabilityTermination;

type RootState = {
  readonly rootPath: string;
  readonly descriptor: number;
  readonly identity: BigIntStats;
  readonly principal: Readonly<{ uid: bigint; gid: bigint }>;
  readonly scope: RepositoryRootCapabilityScope;
  readonly purpose: RepositoryRootCapabilityPurpose;
  readonly acquisition: RepositoryRootCapabilityAcquisition;
  readonly privateLeaseKey: string;
  readonly leaseIdentityReference: string;
  lifecycle: Lifecycle;
  activeBorrows: number;
  borrowOperations: number;
};

const ROOT_STATES = new WeakMap<RepositoryRootCapability, RootState>();
const BORROW_ROOTS = new WeakMap<RepositoryRootCapabilityBorrow, RepositoryRootCapability>();
const BORROW_CHAINS = new WeakMap<RepositoryRootCapabilityBorrow, PinnedRepositoryPathChain>();
const ACTIVE_LEASES = new Map<string, RepositoryRootCapability>();

/**
 * Exact module-relative test-root acquisition. No caller-selected path is
 * accepted, and this internal module is not exported by a production barrel.
 */
export function acquireQualifiedTestRepositoryRootCapability(): RepositoryRootCapability {
  if (arguments.length !== 0) throw capabilityError("safe_path_root_capability_acquisition_invalid");
  assertTestAdapterAvailable();
  const chain = openPinnedRepositoryAncestorChain(
    QUALIFIED_TEST_REPOSITORY_ROOT,
    ".",
    "root-is-boundary",
  );
  try {
    const descriptor = chain.descriptors[chain.rootDescriptorIndex]!;
    const identity = fstatSync(descriptor, { bigint: true });
    const retainedDescriptor = duplicateHeldDirectoryDescriptor(chain, descriptor);
    return createCapability({
      rootPath: QUALIFIED_TEST_REPOSITORY_ROOT,
      descriptor: retainedDescriptor,
      identity,
      scope: QUALIFIED_TEST_SCOPE,
      purpose: CREATE_LOCAL_ROOT_PURPOSE,
      acquisition: MODULE_RELATIVE_ACQUISITION,
    });
  } finally {
    closePinnedPathChain(chain);
  }
}

export function deriveQualifiedTestRepositoryReadCapability(
  parent: RepositoryRootCapability,
): RepositoryRootCapability {
  const parentState = assertCapability(
    parent,
    QUALIFIED_TEST_SCOPE,
    CREATE_LOCAL_ROOT_PURPOSE,
  );
  assertCurrentRoot(parentState, "safe_path_root_capability_identity_changed");
  const descriptor = duplicateRootDescriptor(parentState.descriptor, parentState.identity, parentState.rootPath);
  return createCapability({
    rootPath: parentState.rootPath,
    descriptor,
    identity: parentState.identity,
    scope: QUALIFIED_TEST_SCOPE,
    purpose: SAFE_READ_PURPOSE,
    acquisition: MODULE_RELATIVE_ACQUISITION,
  });
}

/** Called only after the fixture owner exclusively created the directory. */
export function acquireRepositoryLocalTestRootCapability(
  parent: RepositoryRootCapability,
  createdRootPath: string,
): RepositoryRootCapability {
  const parentState = assertCapability(
    parent,
    QUALIFIED_TEST_SCOPE,
    CREATE_LOCAL_ROOT_PURPOSE,
  );
  assertCurrentRoot(parentState, "safe_path_root_capability_identity_changed");
  const canonicalCreatedRoot = resolve(createdRootPath);
  const comparableCreatedRoot = createdRootPath === "/" ? createdRootPath : createdRootPath.replace(/\/+$/u, "");
  const relativeRoot = relative(parentState.rootPath, canonicalCreatedRoot).split(sep).join("/");
  const configuredRoot = ROOT_POLICY.verification.testFixtures.repositoryLocalTemporaryRoot;
  if (!isAbsolute(createdRootPath) || canonicalCreatedRoot !== comparableCreatedRoot ||
    relativePathViolationKinds(relativeRoot).length > 0 ||
    !relativeRoot.startsWith(`${configuredRoot}/`)) {
    throw capabilityError("safe_path_root_capability_scope_invalid");
  }
  const child = openPinnedRepositoryDescendantChain(
    parentState.descriptor,
    parentState.identity,
    parentState.rootPath,
    canonicalCreatedRoot,
    ".",
  );
  try {
    const descriptor = child.descriptors[child.rootDescriptorIndex]!;
    const identity = fstatSync(descriptor, { bigint: true });
    const retainedDescriptor = duplicateHeldDirectoryDescriptor(child, descriptor);
    return createCapability({
      rootPath: canonicalCreatedRoot,
      descriptor: retainedDescriptor,
      identity,
      scope: REPOSITORY_LOCAL_TEST_SCOPE,
      purpose: SAFE_READ_PURPOSE,
      acquisition: EXCLUSIVE_CREATE_ACQUISITION,
    });
  } finally {
    closePinnedPathChain(child);
  }
}

export function borrowRepositoryRootCapability(
  capability: RepositoryRootCapability,
  path: string,
): RepositoryRootCapabilityBorrow {
  assertTestAdapterAvailable();
  const state = assertSafeReadCapability(capability);
  const limitViolation = repositoryRootCapabilityBorrowLimitViolation(POLICY, {
    activeBorrows: state.activeBorrows,
    borrowOperations: state.borrowOperations,
    path,
  });
  if (limitViolation !== null) throw capabilityError(limitViolation);
  state.activeBorrows += 1;
  try {
    assertCurrentRoot(state, "safe_path_root_capability_identity_changed");
    const chain = openPinnedRepositoryDescendantChain(
      state.descriptor,
      state.identity,
      state.rootPath,
      state.rootPath,
      path,
    );
    const borrow = nonserializableRecord({});
    BORROW_CHAINS.set(borrow, chain);
    BORROW_ROOTS.set(borrow, capability);
    state.borrowOperations += 1;
    return borrow;
  } catch (error) {
    state.activeBorrows -= 1;
    throw error;
  }
}

export function releaseRepositoryRootCapabilityBorrow(
  borrow: RepositoryRootCapabilityBorrow | undefined,
): void {
  if (borrow === undefined) return;
  if (isProxyValue(borrow)) throw capabilityError("safe_path_root_capability_invalid");
  const capability = BORROW_ROOTS.get(borrow);
  if (capability === undefined) throw capabilityError("safe_path_root_capability_borrow_invalid");
  BORROW_ROOTS.delete(borrow);
  const chain = BORROW_CHAINS.get(borrow);
  BORROW_CHAINS.delete(borrow);
  const state = ROOT_STATES.get(capability);
  let firstError: unknown;
  if (chain !== undefined) {
    try {
      closePinnedPathChain(chain);
    } catch (error) {
      firstError = error;
    }
  }
  if (state === undefined || state.activeBorrows < 1) {
    firstError ??= capabilityError("safe_path_root_capability_borrow_invalid");
  } else {
    try {
      assertCurrentRoot(state, "safe_path_root_capability_identity_changed");
    } catch (error) {
      firstError ??= error;
    }
    state.activeBorrows -= 1;
  }
  if (firstError !== undefined) throw firstError;
}

export function repositoryRootCapabilityBorrowChain(
  borrow: RepositoryRootCapabilityBorrow,
): PinnedRepositoryPathChain {
  if (isProxyValue(borrow)) throw capabilityError("safe_path_root_capability_invalid");
  const chain = BORROW_CHAINS.get(borrow);
  if (chain === undefined) throw capabilityError("safe_path_root_capability_borrow_invalid");
  return chain;
}

export function repositoryRootPathForInternalUse(capability: RepositoryRootCapability): string {
  const state = assertSafeReadCapability(capability);
  assertCurrentRoot(state, "safe_path_root_capability_identity_changed");
  return state.rootPath;
}

export function terminateRepositoryRootCapability(
  capability: RepositoryRootCapability,
  disposition: RepositoryRootCapabilityTermination,
): void {
  assertNotProxy(capability, "safe_path_root_capability_invalid");
  if (!POLICY.terminationDispositions.includes(disposition)) {
    throw capabilityError("safe_path_root_capability_lifecycle_invalid");
  }
  const state = ROOT_STATES.get(capability);
  if (state === undefined || state.lifecycle !== "active" || state.activeBorrows !== 0 ||
    ACTIVE_LEASES.get(state.privateLeaseKey) !== capability) {
    throw capabilityError("safe_path_root_capability_lifecycle_invalid");
  }
  try {
    closeSync(state.descriptor);
  } finally {
    state.lifecycle = disposition;
    ACTIVE_LEASES.delete(state.privateLeaseKey);
  }
}

function createCapability(input: Readonly<{
  rootPath: string;
  descriptor: number;
  identity: BigIntStats;
  scope: RepositoryRootCapabilityScope;
  purpose: RepositoryRootCapabilityPurpose;
  acquisition: RepositoryRootCapabilityAcquisition;
}>): RepositoryRootCapability {
  try {
    const principal = currentPrincipal();
    assertRootIdentity(input.rootPath, input.descriptor, input.identity, principal);
    if (input.scope === REPOSITORY_LOCAL_TEST_SCOPE &&
      (input.identity.mode & 0o777n).toString(8).padStart(4, "0") !== POLICY.repositoryLocalRootPermissionMode) {
      throw capabilityError("safe_path_root_capability_mode_invalid");
    }
    const commonIdentity = leaseIdentityInput({ ...input, principal, nonceHex: "" });
    const { nonceHex: _excludedNonce, ...exclusiveIdentity } = commonIdentity;
    void _excludedNonce;
    const privateLeaseKey = canonicalDomainHash(
      "repository-root-capability.exclusive-lease-key/v1",
      exclusiveIdentity,
    );
    if (ACTIVE_LEASES.has(privateLeaseKey)) {
      throw capabilityError("safe_path_root_capability_lease_collision");
    }
    const identityInput = leaseIdentityInput({
      ...input,
      principal,
      nonceHex: randomBytes(POLICY.nonceBytes).toString("hex"),
    });
    const leaseIdentityReference = deriveRepositoryRootCapabilityLeaseIdentity(identityInput);
    const capability = nonserializableRecord({
      schemaVersion: POLICY.schemaVersion,
      issuer: POLICY.capabilityIssuer,
      scope: input.scope,
      purpose: input.purpose,
      acquisition: input.acquisition,
      adapter: POLICY.adapter,
      openat2Equivalent: POLICY.openat2Equivalent,
      renameRaceClosure: POLICY.renameRaceClosure,
      leaseIdentityReference,
      lifecycle: POLICY.publicLifecycle,
    });
    const state: RootState = {
      rootPath: input.rootPath,
      descriptor: input.descriptor,
      identity: input.identity,
      principal,
      scope: input.scope,
      purpose: input.purpose,
      acquisition: input.acquisition,
      privateLeaseKey,
      leaseIdentityReference,
      lifecycle: "active",
      activeBorrows: 0,
      borrowOperations: 0,
    };
    ROOT_STATES.set(capability, state);
    ACTIVE_LEASES.set(privateLeaseKey, capability);
    return capability;
  } catch (error) {
    closeSync(input.descriptor);
    throw error;
  }
}

function leaseIdentityInput(input: Readonly<{
  identity: BigIntStats;
  principal: Readonly<{ uid: bigint; gid: bigint }>;
  scope: RepositoryRootCapabilityScope;
  purpose: RepositoryRootCapabilityPurpose;
  acquisition: RepositoryRootCapabilityAcquisition;
  nonceHex: string;
}>): RepositoryRootCapabilityLeaseIdentityInput {
  const identity = pinnedPathIdentity(input.identity);
  return {
    schemaVersion: POLICY.schemaVersion,
    issuer: POLICY.capabilityIssuer,
    scope: input.scope,
    purpose: input.purpose,
    acquisition: input.acquisition,
    adapter: POLICY.adapter,
    openat2Equivalent: POLICY.openat2Equivalent,
    renameRaceClosure: POLICY.renameRaceClosure,
    principal: {
      uid: input.principal.uid.toString(10),
      gid: input.principal.gid.toString(10),
    },
    rootIdentity: {
      device: identity.device,
      inode: identity.inode,
      type: "directory",
      mode: identity.mode,
      ownerUid: identity.ownerUid,
      ownerGid: identity.ownerGid,
    },
    nonceHex: input.nonceHex,
  };
}

function assertCapability(
  capability: RepositoryRootCapability,
  scope: RepositoryRootCapabilityScope,
  purpose: RepositoryRootCapabilityPurpose,
): RootState {
  assertNotProxy(capability, "safe_path_root_capability_invalid");
  const state = ROOT_STATES.get(capability);
  if (state === undefined || state.lifecycle !== "active" || state.scope !== scope || state.purpose !== purpose ||
    state.leaseIdentityReference !== capability.leaseIdentityReference ||
    ACTIVE_LEASES.get(state.privateLeaseKey) !== capability ||
    capability.schemaVersion !== POLICY.schemaVersion || capability.issuer !== POLICY.capabilityIssuer ||
    capability.scope !== scope || capability.purpose !== purpose || capability.acquisition !== state.acquisition ||
    capability.adapter !== POLICY.adapter ||
    capability.openat2Equivalent !== POLICY.openat2Equivalent ||
    capability.renameRaceClosure !== POLICY.renameRaceClosure ||
    capability.lifecycle !== POLICY.publicLifecycle ||
    capability.serializable !== false) {
    throw capabilityError(state === undefined
      ? "safe_path_root_capability_invalid"
      : lifecycleErrorCode(state.lifecycle));
  }
  return state;
}

function assertSafeReadCapability(capability: RepositoryRootCapability): RootState {
  const state = ROOT_STATES.get(capability);
  const scope = state?.scope;
  if (scope !== QUALIFIED_TEST_SCOPE && scope !== REPOSITORY_LOCAL_TEST_SCOPE) {
    throw capabilityError("safe_path_root_capability_invalid");
  }
  return assertCapability(capability, scope, SAFE_READ_PURPOSE);
}

function assertCurrentRoot(state: RootState, code: string): void {
  let opened: BigIntStats;
  let lexical: BigIntStats | undefined;
  try {
    opened = fstatSync(state.descriptor, { bigint: true });
    lexical = lstatSync(state.rootPath, { bigint: true, throwIfNoEntry: false });
  } catch {
    throw capabilityError(code);
  }
  const principal = currentPrincipal();
  if (!lexical || lexical.isSymbolicLink() || !opened.isDirectory() ||
    principal.uid !== state.principal.uid || principal.gid !== state.principal.gid ||
    opened.uid !== state.principal.uid || opened.gid !== state.principal.gid ||
    !sameStablePinnedPathIdentity(state.identity, opened) ||
    !sameStablePinnedPathIdentity(opened, lexical)) {
    throw capabilityError(code);
  }
}

function assertRootIdentity(
  rootPath: string,
  descriptor: number,
  identity: BigIntStats,
  principal: Readonly<{ uid: bigint; gid: bigint }>,
): void {
  const opened = fstatSync(descriptor, { bigint: true });
  const lexical = lstatSync(rootPath, { bigint: true, throwIfNoEntry: false });
  if (!lexical || lexical.isSymbolicLink() || !opened.isDirectory() || !identity.isDirectory() ||
    opened.uid !== principal.uid || opened.gid !== principal.gid ||
    !sameStablePinnedPathIdentity(identity, opened) ||
    !sameStablePinnedPathIdentity(opened, lexical)) {
    throw capabilityError("safe_path_root_capability_identity_changed");
  }
}

function duplicateHeldDirectoryDescriptor(chain: PinnedRepositoryPathChain, descriptor: number): number {
  return duplicateRootDescriptor(
    descriptor,
    fstatSync(descriptor, { bigint: true }),
    chain.lexicalPaths[chain.rootDescriptorIndex]!,
  );
}

function duplicateRootDescriptor(descriptor: number, identity: BigIntStats, rootPath: string): number {
  const duplicate = openPinnedRepositoryDescendantChain(descriptor, identity, rootPath, rootPath, ".");
  const retained = duplicate.descriptors[duplicate.rootDescriptorIndex]!;
  (duplicate.descriptors as number[]).splice(duplicate.rootDescriptorIndex, 1);
  closePinnedPathChain(duplicate);
  return retained;
}

function assertTestAdapterAvailable(): void {
  const availability = inspectRepositoryRootCapabilityAdapterAvailability();
  if (!availability.available) throw capabilityError(availability.code);
}

function lifecycleErrorCode(state: Lifecycle): string {
  switch (state) {
    case "active":
      return "safe_path_root_capability_invalid";
    case "expired":
      return "safe_path_root_capability_expired";
    case "revoked":
      return "safe_path_root_capability_revoked";
    case "closed":
      return "safe_path_root_capability_closed";
    default:
      return assertNever(state, () => capabilityError("safe_path_root_capability_discriminant_invalid"));
  }
}

// The local `assertNever` was unified into `src/shared/type-guards.ts`
// (the canonical owner). The import above aliases the shared
// `assertNever` for the call site in this file.

function currentPrincipal(): Readonly<{ uid: bigint; gid: bigint }> {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    throw capabilityError("safe_path_root_capability_platform_unsupported");
  }
  return Object.freeze({ uid: BigInt(process.getuid()), gid: BigInt(process.getgid()) });
}

function nonserializableRecord<Fields extends Readonly<Record<string, unknown>>>(
  fields: Fields,
): Readonly<Fields & { serializable: false; toJSON: () => never }> {
  const value = { ...fields, serializable: false as const } as Fields & { serializable: false; toJSON: () => never };
  Object.defineProperty(value, "toJSON", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: (): never => {
      throw capabilityError("safe_path_root_capability_serialization_denied");
    },
  });
  return Object.freeze(value);
}

function capabilityError(code: string): HarnessError {
  return new HarnessError("Repository root capability denied", code, false);
}
