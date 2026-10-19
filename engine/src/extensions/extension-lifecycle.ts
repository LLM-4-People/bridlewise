import { HarnessError, InputError, SecurityError } from "../kernel/errors.ts";
import { canonicalHash, deepFreeze, sha256 } from "../kernel/integrity.ts";
import {
  type ExtensionManifest,
  type ExtensionManifestEntry,
  type ExtensionOperation,
  type ExtensionStatus,
  EXTENSION_OPERATIONS,
  EXTENSION_STATUSES,
  validateExtensionManifestEntry,
} from "./extension-manifest.ts";
import { assertTimestamp } from "./extension-validation.ts";
import {
  checkBackwardCompatibility,
  checkCompatibility,
  type BackwardCompatibilityReport,
  type CompatibilityFinding,
  type CompatibilityReport,
  type HarnessApiContract,
  type CapabilityOwnership,
} from "./compatibility-checker.ts";
import { compareSemver, satisfiesRange } from "./semver.ts";

/**
 * Extension lifecycle — the registered state machine for add/edit/deprecate/
 * delete/upgrade/downgrade/enable/disable/rollback.
 *
 * Per Architecture invariant EXT-LIFE-002: "Model checking and generated
 * hostile calls accept exactly the registered edges and reject every implied
 * resurrection/recovery/compensation edge." Per root-policy
 * selfEvolutionArchitecture.lifecycle:
 * ["add","edit","deprecate","delete","upgrade","downgrade","enable","disable","rollback"].
 *
 * `LIFECYCLE_TRANSITIONS` is the closed registry of legal status transitions.
 * Every operation validates the transition, the compatibility report, the
 * backward-compatibility report (for edit/upgrade/downgrade), and the
 * dependency graph (delete blocks when non-optional dependents exist). The
 * manifest is the registry; this module produces a *proposed next manifest*
 * and a typed `LifecycleResult` — it does not persist or activate. The
 * approval workflow and transactional editor own persistence and atomic
 * activation.
 *
 * Per root-policy `runtimeEnforcementAvailable: false`, activation is a
 * status transition recorded in the manifest, not an OS-enforced broker
 * operation. The OS-enforced privileged broker is a documented future slice.
 */

export type LifecycleTransition = Readonly<{
  operation: ExtensionOperation;
  from: ExtensionStatus | "absent";
  to: ExtensionStatus | "absent";
}>;

export const LIFECYCLE_TRANSITIONS = deepFreeze([
  { operation: "add", from: "absent", to: "proposed" },
  { operation: "add", from: "absent", to: "staged" },
  { operation: "add", from: "absent", to: "active" },
  { operation: "edit", from: "proposed", to: "proposed" },
  { operation: "edit", from: "staged", to: "staged" },
  { operation: "edit", from: "active", to: "active" },
  { operation: "edit", from: "disabled", to: "disabled" },
  { operation: "enable", from: "proposed", to: "staged" },
  { operation: "enable", from: "staged", to: "active" },
  { operation: "enable", from: "disabled", to: "active" },
  { operation: "enable", from: "deprecated", to: "active" },
  { operation: "disable", from: "active", to: "disabled" },
  { operation: "disable", from: "staged", to: "disabled" },
  { operation: "deprecate", from: "active", to: "deprecated" },
  { operation: "deprecate", from: "disabled", to: "deprecated" },
  { operation: "upgrade", from: "active", to: "active" },
  { operation: "upgrade", from: "staged", to: "staged" },
  { operation: "downgrade", from: "active", to: "active" },
  { operation: "downgrade", from: "staged", to: "staged" },
  { operation: "delete", from: "proposed", to: "tombstoned" },
  { operation: "delete", from: "staged", to: "tombstoned" },
  { operation: "delete", from: "active", to: "tombstoned" },
  { operation: "delete", from: "disabled", to: "tombstoned" },
  { operation: "delete", from: "deprecated", to: "tombstoned" },
  { operation: "rollback", from: "active", to: "disabled" },
  { operation: "rollback", from: "active", to: "deprecated" },
] as const satisfies ReadonlyArray<LifecycleTransition>);

const TRANSITION_INDEX = new Map<string, LifecycleTransition>();
for (const t of LIFECYCLE_TRANSITIONS) {
  TRANSITION_INDEX.set(`${t.operation}|${t.from}|${t.to}`, t);
}

export function isLegalTransition(
  operation: ExtensionOperation,
  from: ExtensionStatus | "absent",
  to: ExtensionStatus | "absent",
): boolean {
  return TRANSITION_INDEX.has(`${operation}|${from}|${to}`);
}

export function legalTransitionsFor(
  operation: ExtensionOperation,
): readonly LifecycleTransition[] {
  return [...LIFECYCLE_TRANSITIONS].filter((t) => t.operation === operation);
}

export function legalTargetsFrom(
  operation: ExtensionOperation,
  from: ExtensionStatus | "absent",
): readonly (ExtensionStatus | "absent")[] {
  return [...LIFECYCLE_TRANSITIONS]
    .filter((t) => t.operation === operation && t.from === from)
    .map((t) => t.to);
}

export type LifecycleResult = Readonly<{
  operation: ExtensionOperation;
  extensionId: string;
  previousEntry: ExtensionManifestEntry | null;
  nextEntry: ExtensionManifestEntry;
  compatibility: CompatibilityReport;
  backwardCompatibility?: BackwardCompatibilityReport;
  transition: LifecycleTransition;
  preimageHash: string;
  postimageHash: string;
  blockedDependents: readonly string[];
  warnings: readonly string[];
}>;

export class LifecycleError extends HarnessError {
  constructor(message: string, code = "extension_lifecycle_invalid") {
    super(message, code);
  }
}

export type LifecycleContext = Readonly<{
  manifest: ExtensionManifest;
  harness?: HarnessApiContract;
  capabilityOwnerships?: readonly CapabilityOwnership[];
}>;

function buildCompatOptions(
  manifest: ExtensionManifest,
  entry: ExtensionManifestEntry,
  harness: HarnessApiContract | undefined,
  ownerships: readonly CapabilityOwnership[] | undefined,
  existingEntryId: string | undefined,
  requiredCapabilities: readonly string[] | undefined,
): import("./compatibility-checker.ts").CompatibilityCheckOptions {
  return {
    manifest,
    entry,
    ...(harness !== undefined ? { harness } : {}),
    ...(requiredCapabilities !== undefined ? { requiredCapabilities } : {}),
    ...(ownerships !== undefined ? { capabilityOwnerships: ownerships } : {}),
    ...(existingEntryId !== undefined ? { existingEntryId } : {}),
  };
}

export type AddOptions = Readonly<{
  context: LifecycleContext;
  entry: ExtensionManifestEntry;
  targetStatus?: ExtensionStatus;
  requiredCapabilities?: readonly string[];
}>;

export type EditOptions = Readonly<{
  context: LifecycleContext;
  id: string;
  changes: Partial<Omit<ExtensionManifestEntry, "id" | "type" | "createdAt">>;
  requiredCapabilities?: readonly string[];
}>;

export type StatusChangeOptions = Readonly<{
  context: LifecycleContext;
  id: string;
  operation: "enable" | "disable" | "deprecate";
  targetStatus: ExtensionStatus;
  updatedAt: string;
}>;

export type VersionChangeOptions = Readonly<{
  context: LifecycleContext;
  id: string;
  operation: "upgrade" | "downgrade";
  newVersion: string;
  newCompatibilityRange?: string;
  newEntryPoint?: string;
  newCapabilities?: readonly string[];
  newDependencies?: ExtensionManifestEntry["dependencies"];
  newProvenance?: ExtensionManifestEntry["provenance"];
  updatedAt: string;
}>;

export type DeleteOptions = Readonly<{
  context: LifecycleContext;
  id: string;
  updatedAt: string;
}>;

export type RollbackOptions = Readonly<{
  context: LifecycleContext;
  id: string;
  updatedAt: string;
}>;

function assertLegalTransition(
  operation: ExtensionOperation,
  from: ExtensionStatus | "absent",
  to: ExtensionStatus | "absent",
): void {
  if (!isLegalTransition(operation, from, to)) {
    throw new LifecycleError(
      `Illegal lifecycle transition: ${operation} from ${from} to ${to}`,
      "extension_lifecycle_illegal_transition",
    );
  }
}

function assertOperation(value: string): asserts value is ExtensionOperation {
  if (!EXTENSION_OPERATIONS.includes(value as ExtensionOperation)) {
    throw new LifecycleError(`Unknown lifecycle operation '${value}'`, "extension_lifecycle_unknown_operation");
  }
}

function entryHash(entry: ExtensionManifestEntry): string {
  return canonicalHash({
    id: entry.id,
    version: entry.version,
    type: entry.type,
    status: entry.status,
    description: entry.description,
    capabilities: [...entry.capabilities],
    dependencies: [...entry.dependencies],
    entryPoint: entry.entryPoint,
    apiVersion: entry.apiVersion,
    compatibilityRange: entry.compatibilityRange,
    provenance: entry.provenance,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  });
}

function checkReverseDependencies(
  manifest: ExtensionManifest,
  id: string,
  newVersion: string,
): readonly CompatibilityFinding[] {
  const findings: CompatibilityFinding[] = [];
  for (const depId of manifest.dependents(id)) {
    const dep = manifest.get(depId);
    if (dep === undefined) continue;
    const depRecord = dep.dependencies.find((d) => d.id === id);
    if (depRecord === undefined || depRecord.optional) continue;
    if (dep.status === "tombstoned" || dep.status === "deprecated") continue;
    if (!satisfiesRange(newVersion, depRecord.versionRange)) {
      findings.push({
        check: "dependency",
        severity: "error",
        code: "consumer_dependency_broken",
        message: `Consumer '${depId}' requires '${id}' in range ${depRecord.versionRange}, but new version ${newVersion} does not satisfy it`,
        detail: { consumer: depId, dependency: id, newVersion, required: depRecord.versionRange },
      });
    }
  }
  return findings;
}

function mergeFindings(report: CompatibilityReport, extra: readonly CompatibilityFinding[]): CompatibilityReport {
  if (extra.length === 0) return report;
  const findings = [...report.findings, ...extra];
  const blockingCount = findings.filter((f) => f.severity === "error" || f.severity === "fatal").length;
  const compatible = blockingCount === 0;
  return deepFreeze({
    compatible,
    blockingCount,
    findings,
    summary: compatible
      ? report.summary
      : `Extension has ${blockingCount} blocking compatibility finding(s)`,
  });
}

export function proposeAdd(options: AddOptions): LifecycleResult {
  const { context, entry } = options;
  const targetStatus = options.targetStatus ?? "proposed";
  const violations = validateExtensionManifestEntry(entry);
  if (violations.length > 0) {
    throw new LifecycleError(
      `Cannot add invalid extension '${entry.id}': ${violations.join("; ")}`,
      "extension_lifecycle_invalid_entry",
    );
  }
  if (context.manifest.has(entry.id)) {
    throw new InputError(
      `Extension '${entry.id}' is already registered`,
      "extension_lifecycle_duplicate_id",
    );
  }
  assertLegalTransition("add", "absent", targetStatus);
  const compatibility = checkCompatibility(
    buildCompatOptions(context.manifest, entry, context.harness, context.capabilityOwnerships, undefined, options.requiredCapabilities),
  );
  if (!compatibility.compatible) {
    throw new LifecycleError(
      `Cannot add extension '${entry.id}': ${compatibility.summary}`,
      "extension_lifecycle_incompatible",
    );
  }
  if (context.manifest.hasCycle()) {
    throw new LifecycleError("Manifest dependency graph contains a cycle", "extension_lifecycle_cycle");
  }
  const nextEntry: ExtensionManifestEntry = deepFreeze({ ...entry, status: targetStatus });
  return deepFreeze({
    operation: "add",
    extensionId: entry.id,
    previousEntry: null,
    nextEntry,
    compatibility,
    transition: { operation: "add", from: "absent", to: targetStatus },
    preimageHash: sha256(""),
    postimageHash: entryHash(nextEntry),
    blockedDependents: [],
    warnings: compatibility.findings.filter((f) => f.severity === "warning").map((f) => f.message),
  });
}

export function proposeEdit(options: EditOptions): LifecycleResult {
  const { context, id, changes } = options;
  const previous = context.manifest.get(id);
  if (previous === undefined) {
    throw new InputError(`Extension '${id}' is not registered`, "extension_lifecycle_not_found");
  }
  const updatedAt = changes.updatedAt ?? previous.updatedAt;
  const nextEntry: ExtensionManifestEntry = deepFreeze({
    id: previous.id,
    version: changes.version ?? previous.version,
    type: previous.type,
    status: changes.status ?? previous.status,
    description: changes.description ?? previous.description,
    capabilities: changes.capabilities ?? previous.capabilities,
    dependencies: changes.dependencies ?? previous.dependencies,
    entryPoint: changes.entryPoint ?? previous.entryPoint,
    apiVersion: changes.apiVersion ?? previous.apiVersion,
    compatibilityRange: changes.compatibilityRange ?? previous.compatibilityRange,
    provenance: changes.provenance ?? previous.provenance,
    ...(changes.configSchemaFragment !== undefined
      ? { configSchemaFragment: changes.configSchemaFragment }
      : previous.configSchemaFragment !== undefined
        ? { configSchemaFragment: previous.configSchemaFragment }
        : {}),
    createdAt: previous.createdAt,
    updatedAt,
  });
  const violations = validateExtensionManifestEntry(nextEntry);
  if (violations.length > 0) {
    throw new LifecycleError(
      `Edited extension '${id}' is invalid: ${violations.join("; ")}`,
      "extension_lifecycle_invalid_entry",
    );
  }
  assertLegalTransition("edit", previous.status, nextEntry.status);
  const backwardCompatibility = checkBackwardCompatibility(previous, nextEntry);
  if (!backwardCompatibility.backwardCompatible) {
    throw new LifecycleError(
      `Cannot edit extension '${id}': ${backwardCompatibility.summary}`,
      "extension_lifecycle_breaking_edit",
    );
  }
  let compatibility = checkCompatibility(
    buildCompatOptions(context.manifest, nextEntry, context.harness, context.capabilityOwnerships, id, options.requiredCapabilities),
  );
  if (compareSemver(nextEntry.version, previous.version) !== 0) {
    compatibility = mergeFindings(compatibility, checkReverseDependencies(context.manifest, id, nextEntry.version));
  }
  if (!compatibility.compatible) {
    throw new LifecycleError(
      `Cannot edit extension '${id}': ${compatibility.summary}`,
      "extension_lifecycle_incompatible",
    );
  }
  return deepFreeze({
    operation: "edit",
    extensionId: id,
    previousEntry: previous,
    nextEntry,
    compatibility,
    backwardCompatibility,
    transition: { operation: "edit", from: previous.status, to: nextEntry.status },
    preimageHash: entryHash(previous),
    postimageHash: entryHash(nextEntry),
    blockedDependents: [],
    warnings: [
      ...compatibility.findings.filter((f) => f.severity === "warning").map((f) => f.message),
      ...backwardCompatibility.findings.filter((f) => f.severity === "warning").map((f) => f.message),
    ],
  });
}

export function proposeStatusChange(options: StatusChangeOptions): LifecycleResult {
  const { context, id, operation, targetStatus, updatedAt } = options;
  assertOperation(operation);
  assertTimestamp(updatedAt, "updatedAt", "extension_lifecycle_invalid_timestamp");
  const previous = context.manifest.get(id);
  if (previous === undefined) {
    throw new InputError(`Extension '${id}' is not registered`, "extension_lifecycle_not_found");
  }
  assertLegalTransition(operation, previous.status, targetStatus);
  const nextEntry: ExtensionManifestEntry = deepFreeze({ ...previous, status: targetStatus, updatedAt });
  const compatibility = checkCompatibility(
    buildCompatOptions(context.manifest, nextEntry, context.harness, context.capabilityOwnerships, id, undefined),
  );
  return deepFreeze({
    operation,
    extensionId: id,
    previousEntry: previous,
    nextEntry,
    compatibility,
    transition: { operation, from: previous.status, to: targetStatus },
    preimageHash: entryHash(previous),
    postimageHash: entryHash(nextEntry),
    blockedDependents: [],
    warnings: compatibility.findings.filter((f) => f.severity === "warning").map((f) => f.message),
  });
}

export function proposeVersionChange(options: VersionChangeOptions): LifecycleResult {
  const { context, id, operation, newVersion, updatedAt } = options;
  assertOperation(operation);
  assertTimestamp(updatedAt, "updatedAt", "extension_lifecycle_invalid_timestamp");
  const previous = context.manifest.get(id);
  if (previous === undefined) {
    throw new InputError(`Extension '${id}' is not registered`, "extension_lifecycle_not_found");
  }
  assertLegalTransition(operation, previous.status, previous.status);
  const cmp = compareSemver(newVersion, previous.version);
  if (operation === "upgrade" && cmp <= 0) {
    throw new LifecycleError(
      `Upgrade requires a higher version than ${previous.version}, got ${newVersion}`,
      "extension_lifecycle_not_an_upgrade",
    );
  }
  if (operation === "downgrade" && cmp >= 0) {
    throw new LifecycleError(
      `Downgrade requires a lower version than ${previous.version}, got ${newVersion}`,
      "extension_lifecycle_not_a_downgrade",
    );
  }
  const nextEntry: ExtensionManifestEntry = deepFreeze({
    ...previous,
    version: newVersion,
    ...(options.newCompatibilityRange !== undefined ? { compatibilityRange: options.newCompatibilityRange } : {}),
    ...(options.newEntryPoint !== undefined ? { entryPoint: options.newEntryPoint } : {}),
    ...(options.newCapabilities !== undefined ? { capabilities: options.newCapabilities } : {}),
    ...(options.newDependencies !== undefined ? { dependencies: options.newDependencies } : {}),
    ...(options.newProvenance !== undefined ? { provenance: options.newProvenance } : {}),
    updatedAt,
  });
  const violations = validateExtensionManifestEntry(nextEntry);
  if (violations.length > 0) {
    throw new LifecycleError(
      `${operation} of extension '${id}' is invalid: ${violations.join("; ")}`,
      "extension_lifecycle_invalid_entry",
    );
  }
  let compatibility = checkCompatibility(
    buildCompatOptions(context.manifest, nextEntry, context.harness, context.capabilityOwnerships, id, undefined),
  );
  compatibility = mergeFindings(compatibility, checkReverseDependencies(context.manifest, id, newVersion));
  if (!compatibility.compatible) {
    throw new LifecycleError(
      `Cannot ${operation} extension '${id}': ${compatibility.summary}`,
      "extension_lifecycle_incompatible",
    );
  }
  let backwardCompatibility = checkBackwardCompatibility(previous, nextEntry);
  if (operation === "downgrade") {
    // An explicit downgrade intentionally lowers the version; the
    // version_downgrade finding is expected, not a blocking break. Other
    // breaking findings (capability removal, required-dependency removal)
    // still block.
    const filtered = backwardCompatibility.findings.filter((f) => f.code !== "version_downgrade");
    const blocking = filtered.filter((f) => f.severity === "error" || f.severity === "fatal").length;
    backwardCompatibility = deepFreeze({
      backwardCompatible: blocking === 0,
      findings: filtered,
      summary: blocking === 0
        ? `Downgrade is backward-compatible except version (${filtered.length} finding(s))`
        : `Downgrade has ${blocking} blocking backward-compatibility finding(s)`,
    });
  }
  if (!backwardCompatibility.backwardCompatible) {
    throw new LifecycleError(
      `Cannot ${operation} extension '${id}': ${backwardCompatibility.summary}`,
      operation === "downgrade" ? "extension_lifecycle_breaking_downgrade" : "extension_lifecycle_breaking_edit",
    );
  }
  return deepFreeze({
    operation,
    extensionId: id,
    previousEntry: previous,
    nextEntry,
    compatibility,
    backwardCompatibility,
    transition: { operation, from: previous.status, to: previous.status },
    preimageHash: entryHash(previous),
    postimageHash: entryHash(nextEntry),
    blockedDependents: [],
    warnings: [
      ...compatibility.findings.filter((f) => f.severity === "warning").map((f) => f.message),
      ...backwardCompatibility.findings.filter((f) => f.severity === "warning").map((f) => f.message),
    ],
  });
}

export function proposeDelete(options: DeleteOptions): LifecycleResult {
  const { context, id, updatedAt } = options;
  assertTimestamp(updatedAt, "updatedAt", "extension_lifecycle_invalid_timestamp");
  const previous = context.manifest.get(id);
  if (previous === undefined) {
    throw new InputError(`Extension '${id}' is not registered`, "extension_lifecycle_not_found");
  }
  assertLegalTransition("delete", previous.status, "tombstoned");
  const blockedDependents = previous.status === "tombstoned" ? [] : computeBlockedDependents(context.manifest, id);
  if (blockedDependents.length > 0) {
    throw new SecurityError(
      `Cannot delete extension '${id}': active/staged non-optional dependents remain: ${blockedDependents.join(", ")}`,
      "extension_lifecycle_dependents_block_delete",
    );
  }
  const nextEntry: ExtensionManifestEntry = deepFreeze({ ...previous, status: "tombstoned", updatedAt });
  const compatibility = checkCompatibility(
    buildCompatOptions(context.manifest, nextEntry, context.harness, context.capabilityOwnerships, id, undefined),
  );
  return deepFreeze({
    operation: "delete",
    extensionId: id,
    previousEntry: previous,
    nextEntry,
    compatibility,
    transition: { operation: "delete", from: previous.status, to: "tombstoned" },
    preimageHash: entryHash(previous),
    postimageHash: entryHash(nextEntry),
    blockedDependents,
    warnings: [],
  });
}

export function proposeRollback(options: RollbackOptions): LifecycleResult {
  const { context, id, updatedAt } = options;
  assertTimestamp(updatedAt, "updatedAt", "extension_lifecycle_invalid_timestamp");
  const previous = context.manifest.get(id);
  if (previous === undefined) {
    throw new InputError(`Extension '${id}' is not registered`, "extension_lifecycle_not_found");
  }
  if (previous.status !== "active") {
    throw new LifecycleError(
      `Rollback is only allowed from active state, got ${previous.status}`,
      "extension_lifecycle_rollback_not_active",
    );
  }
  const targetStatus: ExtensionStatus = "disabled";
  assertLegalTransition("rollback", previous.status, targetStatus);
  const nextEntry: ExtensionManifestEntry = deepFreeze({ ...previous, status: targetStatus, updatedAt });
  const compatibility = checkCompatibility(
    buildCompatOptions(context.manifest, nextEntry, context.harness, context.capabilityOwnerships, id, undefined),
  );
  return deepFreeze({
    operation: "rollback",
    extensionId: id,
    previousEntry: previous,
    nextEntry,
    compatibility,
    transition: { operation: "rollback", from: previous.status, to: targetStatus },
    preimageHash: entryHash(previous),
    postimageHash: entryHash(nextEntry),
    blockedDependents: [],
    warnings: [],
  });
}

function computeBlockedDependents(manifest: ExtensionManifest, id: string): readonly string[] {
  const dependents = manifest.dependents(id);
  return dependents.filter((depId) => {
    const dep = manifest.get(depId);
    if (dep === undefined) return false;
    if (dep.status === "tombstoned" || dep.status === "deprecated") return false;
    const depRecord = dep.dependencies.find((d) => d.id === id);
    return depRecord !== undefined && !depRecord.optional;
  });
}

export { EXTENSION_OPERATIONS, EXTENSION_STATUSES };
export type { ExtensionManifest, ExtensionManifestEntry, ExtensionStatus, ExtensionOperation };
export type { CompatibilityReport, BackwardCompatibilityReport, HarnessApiContract, CapabilityOwnership };

void satisfiesRange;
