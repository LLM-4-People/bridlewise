import { HarnessError } from "../kernel/errors.ts";
import { canonicalDomainHash } from "../kernel/integrity.ts";
import { relativePathViolationKinds } from "./path-boundary.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { isProxyValue } from "../kernel/safe-structural.ts";
import { assertNever } from "../shared/type-guards.ts";
import type { PinnedPathIdentity } from "./pinned-path-internal.ts";

const POLICY = ROOT_POLICY.verification.testFixtures.repositoryRootCapability;
const RAW_FILE_MODES = ROOT_POLICY.filesystem.rawFileModes;
const FILE_MODE_CLASSIFICATION = ROOT_POLICY.filesystem.fileModeClassification;
const LEASE_IDENTITY_FIELDS = [
  "schemaVersion",
  "issuer",
  "scope",
  "purpose",
  "acquisition",
  "adapter",
  "openat2Equivalent",
  "renameRaceClosure",
  "principal",
  "rootIdentity",
  "nonceHex",
] as const;
const NONCE_HEX_PATTERN = new RegExp(`^[0-9a-f]{${POLICY.nonceBytes * 2}}$`, "u");

export type RepositoryRootCapabilityScope = (typeof POLICY.capabilityScopes)[number];
export type RepositoryRootCapabilityPurpose = (typeof POLICY.capabilityPurposes)[number];
export type RepositoryRootCapabilityAcquisition = (typeof POLICY.capabilityAcquisitions)[number];
export type RepositoryRootCapabilityTermination = (typeof POLICY.terminationDispositions)[number];

export type RepositoryRootCapability = Readonly<{
  schemaVersion: typeof POLICY.schemaVersion;
  issuer: typeof POLICY.capabilityIssuer;
  scope: RepositoryRootCapabilityScope;
  purpose: RepositoryRootCapabilityPurpose;
  acquisition: RepositoryRootCapabilityAcquisition;
  adapter: typeof POLICY.adapter;
  openat2Equivalent: typeof POLICY.openat2Equivalent;
  renameRaceClosure: typeof POLICY.renameRaceClosure;
  leaseIdentityReference: string;
  lifecycle: typeof POLICY.publicLifecycle;
  serializable: false;
  toJSON: () => never;
}>;

export type RepositoryRootCapabilityBorrow = Readonly<{
  serializable: false;
  toJSON: () => never;
}>;

export type RepositoryRootCapabilityAdapterAvailability =
  | Readonly<{
    available: true;
    adapter: typeof POLICY.adapter;
    openat2Equivalent: typeof POLICY.openat2Equivalent;
    renameRaceClosure: typeof POLICY.renameRaceClosure;
  }>
  | Readonly<{
    available: false;
    code:
      | "safe_path_root_capability_platform_unsupported"
      | "safe_path_root_capability_procfs_unavailable"
      | "safe_path_root_capability_procfs_invalid";
    fallbackAttempted: false;
  }>;

export type RepositoryRootCapabilityAdapterObservedState =
  | "available"
  | "platform-unsupported"
  | "procfs-unavailable"
  | "procfs-invalid";

export type RepositoryRootCapabilityLeaseIdentityInput = Readonly<{
  schemaVersion: typeof POLICY.schemaVersion;
  issuer: typeof POLICY.capabilityIssuer;
  scope: RepositoryRootCapabilityScope;
  purpose: RepositoryRootCapabilityPurpose;
  acquisition: RepositoryRootCapabilityAcquisition;
  adapter: typeof POLICY.adapter;
  openat2Equivalent: typeof POLICY.openat2Equivalent;
  renameRaceClosure: typeof POLICY.renameRaceClosure;
  principal: Readonly<{ uid: string; gid: string }>;
  rootIdentity: Readonly<Pick<
    PinnedPathIdentity,
    "device" | "inode" | "mode" | "ownerUid" | "ownerGid"
  > & { type: "directory" }>;
  nonceHex: string;
}>;

export type RepositoryRootCapabilityBorrowLimits = Readonly<{
  maximumConcurrentBorrowsPerCapability: number;
  maximumBorrowOperationsPerCapability: number;
  maximumBorrowedPathBytes: number;
  maximumBorrowedPathSegments: number;
}>;

export type RepositoryRootCapabilityBudgetLimits = Readonly<{
  schemaVersion: string;
  maximumConcurrentBorrowsPerCapability: number;
  maximumOperationsPerBorrow: number;
  maximumBorrowOperationsPerCapability: number;
  maximumBorrowOperationsPerTask: number;
  maximumCapabilityRotationsPerTask: number;
  maximumBorrowedPathBytes: number;
  maximumBorrowedPathSegments: number;
}>;

export type RepositoryRootCapabilityBudgetLimitCeilings = Readonly<
  Omit<RepositoryRootCapabilityBudgetLimits, "schemaVersion">
>;

export type RepositoryRootCapabilityBudgetState = Readonly<{
  activeBorrowOperations: readonly number[];
  borrowOperationsForCapability: number;
  borrowOperationsForTask: number;
  capabilityRotationsForTask: number;
}>;

export type RepositoryRootCapabilityBudgetOperation =
  | Readonly<{ kind: "borrow"; path: string }>
  | Readonly<{ kind: "operate"; borrowIndex: number }>
  | Readonly<{ kind: "release"; borrowIndex: number }>
  | Readonly<{ kind: "rotate" }>;

export type RepositoryRootCapabilityBudgetExhaustionCode =
  | "safe_path_root_capability_busy"
  | "safe_path_root_capability_borrow_operation_limit"
  | "safe_path_root_capability_capability_operation_limit"
  | "safe_path_root_capability_task_operation_limit"
  | "safe_path_root_capability_rotation_limit"
  | "safe_path_root_capability_path_bytes_limit"
  | "safe_path_root_capability_path_segments_limit";

export type RepositoryRootCapabilityBudgetDecision =
  | Readonly<{
    allowed: true;
    state: RepositoryRootCapabilityBudgetState;
  }>
  | Readonly<{
    allowed: false;
    code: RepositoryRootCapabilityBudgetExhaustionCode;
    state: RepositoryRootCapabilityBudgetState;
  }>;

export type RepositoryRootCapabilityBorrowLimitState = Readonly<{
  activeBorrows: number;
  borrowOperations: number;
  path: string;
}>;

export type RepositoryRootCapabilityRawFileModeCategory =
  | "source" | "test" | "traceability" | "config" | "evidence";

export function repositoryRootCapabilityExpectedRawFileMode(
  path: string,
): number {
  if (typeof path !== "string" || relativePathViolationKinds(path).length > 0) {
    throw contractError("safe_path_root_capability_raw_file_mode_invalid");
  }
  if (FILE_MODE_CLASSIFICATION.configSuffixes.some((suffix) => path.endsWith(suffix))) {
    return RAW_FILE_MODES.config;
  }
  if (path.startsWith(FILE_MODE_CLASSIFICATION.traceabilityPrefix)) {
    if (FILE_MODE_CLASSIFICATION.evidenceSuffixes.some((suffix) => path.endsWith(suffix))) {
      return RAW_FILE_MODES.evidence;
    }
    return RAW_FILE_MODES.traceability;
  }
  if (FILE_MODE_CLASSIFICATION.evidenceSuffixes.some((suffix) => path.endsWith(suffix))) {
    return RAW_FILE_MODES.evidence;
  }
  if (FILE_MODE_CLASSIFICATION.testSuffixes.some((suffix) => path.endsWith(suffix))) {
    return RAW_FILE_MODES.test;
  }
  return RAW_FILE_MODES.source;
}

export function repositoryRootCapabilityAdapterAvailabilityForObservedState(
  state: RepositoryRootCapabilityAdapterObservedState,
): RepositoryRootCapabilityAdapterAvailability {
  switch (state) {
    case "available":
      return Object.freeze({
        available: true,
        adapter: POLICY.adapter,
        openat2Equivalent: POLICY.openat2Equivalent,
        renameRaceClosure: POLICY.renameRaceClosure,
      });
    case "platform-unsupported":
      return unavailableAdapter("safe_path_root_capability_platform_unsupported");
    case "procfs-unavailable":
      return unavailableAdapter("safe_path_root_capability_procfs_unavailable");
    case "procfs-invalid":
      return unavailableAdapter("safe_path_root_capability_procfs_invalid");
    default:
      return assertNever(state, () => contractError("safe_path_root_capability_discriminant_invalid"));
  }
}

export function deriveRepositoryRootCapabilityLeaseIdentity(
  input: RepositoryRootCapabilityLeaseIdentityInput,
): string {
  assertLeaseIdentityInput(input);
  return canonicalDomainHash("repository-root-capability.lease-identity/v1", input);
}

export function repositoryRootCapabilityBorrowLimitViolation(
  limits: RepositoryRootCapabilityBorrowLimits | Readonly<{
    budget: Readonly<{ limitCeilings: RepositoryRootCapabilityBudgetLimitCeilings }>;
  }>,
  state: RepositoryRootCapabilityBorrowLimitState,
): "safe_path_root_capability_busy" | "safe_path_root_capability_operation_limit" | null {
  const effectiveLimits = "budget" in limits ? limits.budget.limitCeilings : limits;
  if (typeof state.path !== "string" ||
    Buffer.byteLength(state.path, "utf8") > effectiveLimits.maximumBorrowedPathBytes ||
    (state.path === "." ? 0 : state.path.split("/").length) >
      effectiveLimits.maximumBorrowedPathSegments ||
    state.borrowOperations >= effectiveLimits.maximumBorrowOperationsPerCapability) {
    return "safe_path_root_capability_operation_limit";
  }
  return state.activeBorrows >= effectiveLimits.maximumConcurrentBorrowsPerCapability
    ? "safe_path_root_capability_busy"
    : null;
}

/**
 * Pure finite-budget state transition used to compile the runtime contract
 * before the capability implementation and its consumers migrate. Capability
 * rotation resets only the per-capability counter; the task aggregate is
 * deliberately preserved.
 */
export function decideRepositoryRootCapabilityBudgetOperation(
  limits: RepositoryRootCapabilityBudgetLimits,
  state: RepositoryRootCapabilityBudgetState,
  operation: RepositoryRootCapabilityBudgetOperation,
): RepositoryRootCapabilityBudgetDecision {
  assertBudgetInputs(limits, state, operation);
  switch (operation.kind) {
    case "borrow": {
      if (Buffer.byteLength(operation.path, "utf8") > limits.maximumBorrowedPathBytes) {
        return deniedBudgetDecision("safe_path_root_capability_path_bytes_limit", state);
      }
      const pathSegments = operation.path === "." ? 0 : operation.path.split("/").length;
      if (pathSegments > limits.maximumBorrowedPathSegments) {
        return deniedBudgetDecision("safe_path_root_capability_path_segments_limit", state);
      }
      if (state.activeBorrowOperations.length >= limits.maximumConcurrentBorrowsPerCapability) {
        return deniedBudgetDecision("safe_path_root_capability_busy", state);
      }
      if (state.borrowOperationsForCapability >= limits.maximumBorrowOperationsPerCapability) {
        return deniedBudgetDecision("safe_path_root_capability_capability_operation_limit", state);
      }
      if (state.borrowOperationsForTask >= limits.maximumBorrowOperationsPerTask) {
        return deniedBudgetDecision("safe_path_root_capability_task_operation_limit", state);
      }
      return allowedBudgetDecision({
        activeBorrowOperations: [...state.activeBorrowOperations, 0],
        borrowOperationsForCapability: state.borrowOperationsForCapability + 1,
        borrowOperationsForTask: state.borrowOperationsForTask + 1,
        capabilityRotationsForTask: state.capabilityRotationsForTask,
      });
    }
    case "operate": {
      if (state.activeBorrowOperations[operation.borrowIndex]! >= limits.maximumOperationsPerBorrow) {
        return deniedBudgetDecision("safe_path_root_capability_borrow_operation_limit", state);
      }
      const activeBorrowOperations = [...state.activeBorrowOperations];
      activeBorrowOperations[operation.borrowIndex] = activeBorrowOperations[operation.borrowIndex]! + 1;
      return allowedBudgetDecision({ ...state, activeBorrowOperations });
    }
    case "release": {
      return allowedBudgetDecision({
        ...state,
        activeBorrowOperations: state.activeBorrowOperations.filter(
          (_operations, index) => index !== operation.borrowIndex,
        ),
      });
    }
    case "rotate": {
      if (state.activeBorrowOperations.length > 0) {
        return deniedBudgetDecision("safe_path_root_capability_busy", state);
      }
      if (state.capabilityRotationsForTask >= limits.maximumCapabilityRotationsPerTask) {
        return deniedBudgetDecision("safe_path_root_capability_rotation_limit", state);
      }
      return allowedBudgetDecision({
        activeBorrowOperations: [],
        borrowOperationsForCapability: 0,
        borrowOperationsForTask: state.borrowOperationsForTask,
        capabilityRotationsForTask: state.capabilityRotationsForTask + 1,
      });
    }
    default:
      return assertNever(operation, () => contractError("safe_path_root_capability_discriminant_invalid"));
  }
}

function assertBudgetInputs(
  limits: RepositoryRootCapabilityBudgetLimits,
  state: RepositoryRootCapabilityBudgetState,
  operation: RepositoryRootCapabilityBudgetOperation,
): void {
  const limitFields = [
    "schemaVersion",
    "maximumConcurrentBorrowsPerCapability",
    "maximumOperationsPerBorrow",
    "maximumBorrowOperationsPerCapability",
    "maximumBorrowOperationsPerTask",
    "maximumCapabilityRotationsPerTask",
    "maximumBorrowedPathBytes",
    "maximumBorrowedPathSegments",
  ] as const;
  const stateFields = [
    "activeBorrowOperations",
    "borrowOperationsForCapability",
    "borrowOperationsForTask",
    "capabilityRotationsForTask",
  ] as const;
  const limitValues = [
    limits.maximumConcurrentBorrowsPerCapability,
    limits.maximumOperationsPerBorrow,
    limits.maximumBorrowOperationsPerCapability,
    limits.maximumBorrowOperationsPerTask,
    limits.maximumCapabilityRotationsPerTask,
    limits.maximumBorrowedPathBytes,
    limits.maximumBorrowedPathSegments,
  ];
  const stateValues = [
    ...state.activeBorrowOperations,
    state.borrowOperationsForCapability,
    state.borrowOperationsForTask,
    state.capabilityRotationsForTask,
  ];
  const operationFields = operation.kind === "borrow"
    ? ["kind", "path"]
    : operation.kind === "operate" || operation.kind === "release"
      ? ["kind", "borrowIndex"]
      : ["kind"];
  if (!hasExactDataFields(limits, limitFields) || limits.schemaVersion !== POLICY.budget.schemaVersion ||
    limitValues.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
    !hasExactDataFields(state, stateFields) || !Array.isArray(state.activeBorrowOperations) ||
    stateValues.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    !hasExactDataFields(operation, operationFields) ||
    (operation.kind === "borrow" && typeof operation.path !== "string") ||
    ((operation.kind === "operate" || operation.kind === "release") &&
      (!Number.isSafeInteger(operation.borrowIndex) || operation.borrowIndex < 0 ||
        operation.borrowIndex >= state.activeBorrowOperations.length))) {
    throw contractError("safe_path_root_capability_budget_invalid");
  }
}

function allowedBudgetDecision(
  state: RepositoryRootCapabilityBudgetState,
): RepositoryRootCapabilityBudgetDecision {
  return Object.freeze({ allowed: true as const, state: freezeBudgetState(state) });
}

function deniedBudgetDecision(
  code: RepositoryRootCapabilityBudgetExhaustionCode,
  state: RepositoryRootCapabilityBudgetState,
): RepositoryRootCapabilityBudgetDecision {
  return Object.freeze({ allowed: false as const, code, state: freezeBudgetState(state) });
}

function freezeBudgetState(
  state: RepositoryRootCapabilityBudgetState,
): RepositoryRootCapabilityBudgetState {
  return Object.freeze({
    ...state,
    activeBorrowOperations: Object.freeze([...state.activeBorrowOperations]),
  });
}

function assertLeaseIdentityInput(input: RepositoryRootCapabilityLeaseIdentityInput): void {
  if (!hasExactDataFields(input, LEASE_IDENTITY_FIELDS) ||
    !hasExactDataFields(input.principal, ["uid", "gid"]) ||
    !hasExactDataFields(input.rootIdentity, POLICY.exactPrivateIdentityFields) ||
    input.schemaVersion !== POLICY.schemaVersion || input.issuer !== POLICY.capabilityIssuer ||
    !POLICY.capabilityScopes.includes(input.scope) || !POLICY.capabilityPurposes.includes(input.purpose) ||
    !POLICY.capabilityAcquisitions.includes(input.acquisition) || input.adapter !== POLICY.adapter ||
    input.openat2Equivalent !== POLICY.openat2Equivalent ||
    input.renameRaceClosure !== POLICY.renameRaceClosure ||
    !/^[0-9]+$/u.test(input.principal.uid) || !/^[0-9]+$/u.test(input.principal.gid) ||
    !/^[0-9]+$/u.test(input.rootIdentity.device) || !/^[0-9]+$/u.test(input.rootIdentity.inode) ||
    input.rootIdentity.type !== "directory" || !/^[0-7]+$/u.test(input.rootIdentity.mode) ||
    !/^[0-9]+$/u.test(input.rootIdentity.ownerUid) || !/^[0-9]+$/u.test(input.rootIdentity.ownerGid) ||
    !NONCE_HEX_PATTERN.test(input.nonceHex)) {
    throw contractError("safe_path_root_capability_lease_identity_invalid");
  }
}

function hasExactDataFields(input: unknown, expectedFields: readonly string[]): boolean {
  if (typeof input !== "object" || input === null || isProxyValue(input) ||
    Object.getPrototypeOf(input) !== Object.prototype) {
    return false;
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  return keys.length === expectedFields.length && keys.every((key) => typeof key === "string") &&
    expectedFields.every((field) => descriptors[field] !== undefined) &&
    Object.values(descriptors).every((descriptor) => "value" in descriptor && descriptor.enumerable);
}

function unavailableAdapter(
  code: "safe_path_root_capability_platform_unsupported" |
    "safe_path_root_capability_procfs_unavailable" |
    "safe_path_root_capability_procfs_invalid",
): RepositoryRootCapabilityAdapterAvailability {
  return Object.freeze({ available: false, code, fallbackAttempted: false as const });
}

// The local `assertNever` was unified into `src/shared/type-guards.ts`
// (the canonical owner). The import above aliases the shared
// `assertNever` for the call sites in this file.

function contractError(code: string): HarnessError {
  return new HarnessError("Repository root capability denied", code, false);
}
