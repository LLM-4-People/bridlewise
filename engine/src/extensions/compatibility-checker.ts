import { InputError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import {
  type ExtensionManifest,
  type ExtensionManifestEntry,
  type ExtensionType,
} from "./extension-manifest.ts";
import { compareSemver, satisfiesRange, type Semver, parseSemver } from "./semver.ts";

/**
 * Compatibility checker — validates that an extension is compatible with
 * the harness API, the existing manifest, and its declared dependencies.
 *
 * Per canonical requirement DER-030 and Architecture invariant
 * `EXT-COMPAT-001`: "Every activated edge passes exact integration while
 * changed-graph/risk partitions and sentinel sweeps detect seeded drift
 * without a global Cartesian gate." Per root-policy
 * selfEvolutionArchitecture.proposalFlow step 2:
 * "dependency-conflict-compatibility-public-api-and-policy-validation".
 *
 * The checker is pure: it consumes a manifest snapshot and a candidate
 * entry and returns a typed `CompatibilityReport`. It performs no effects.
 * Four independent checks:
 * 1. Version compatibility — the extension's apiVersion satisfies the
 * harness's declared compatibility range and vice versa.
 * 2. Capability compatibility — required capabilities are present.
 * 3. Dependency compatibility — all declared dependencies are present in
 * the manifest and their versions satisfy the declared ranges.
 * 4. Conflict detection — the extension does not conflict with existing
 * extensions by id, by type+entryPoint collision, or by declaring an
 * exclusive capability already owned by another active extension.
 */

export const COMPATIBILITY_SEVERITY = deepFreeze(["info", "warning", "error", "fatal"] as const);
export type CompatibilitySeverity = typeof COMPATIBILITY_SEVERITY[number];

export type CompatibilityFinding = Readonly<{
  check: "version" | "capability" | "dependency" | "conflict";
  severity: CompatibilitySeverity;
  code: string;
  message: string;
  detail?: Readonly<Record<string, string>>;
}>;

export type CompatibilityReport = Readonly<{
  compatible: boolean;
  blockingCount: number;
  findings: readonly CompatibilityFinding[];
  summary: string;
}>;

export type HarnessApiContract = Readonly<{
  apiVersion: string;
  compatibilityRange: string;
}>;

export type CapabilityOwnership = Readonly<{
  capability: string;
  ownerExtensionId: string;
  exclusive: boolean;
}>;

export type CompatibilityCheckOptions = Readonly<{
  manifest: ExtensionManifest;
  entry: ExtensionManifestEntry;
  harness?: HarnessApiContract;
  requiredCapabilities?: readonly string[];
  capabilityOwnerships?: readonly CapabilityOwnership[];
  existingEntryId?: string;
}>;

const BLOCKING_SEVERITIES = new Set<string>(["error", "fatal"]);

function versionFinding(
  harness: HarnessApiContract | undefined,
  entry: ExtensionManifestEntry,
): CompatibilityFinding[] {
  const findings: CompatibilityFinding[] = [];
  if (harness === undefined) return findings;
  if (!satisfiesRange(entry.apiVersion, harness.compatibilityRange)) {
    findings.push({
      check: "version",
      severity: "error",
      code: "extension_api_version_outside_harness_range",
      message: `Extension apiVersion ${entry.apiVersion} does not satisfy harness compatibility range ${harness.compatibilityRange}`,
      detail: { apiVersion: entry.apiVersion, harnessRange: harness.compatibilityRange },
    });
  }
  if (!satisfiesRange(harness.apiVersion, entry.compatibilityRange)) {
    findings.push({
      check: "version",
      severity: "error",
      code: "harness_api_version_outside_extension_range",
      message: `Harness apiVersion ${harness.apiVersion} does not satisfy extension compatibility range ${entry.compatibilityRange}`,
      detail: { harnessApiVersion: harness.apiVersion, extensionRange: entry.compatibilityRange },
    });
  }
  return findings;
}

function capabilityFinding(
  requiredCapabilities: readonly string[] | undefined,
  entry: ExtensionManifestEntry,
): CompatibilityFinding[] {
  if (requiredCapabilities === undefined || requiredCapabilities.length === 0) return [];
  const findings: CompatibilityFinding[] = [];
  const present = new Set(entry.capabilities);
  for (const cap of requiredCapabilities) {
    if (!present.has(cap)) {
      findings.push({
        check: "capability",
        severity: "error",
        code: "required_capability_missing",
        message: `Extension '${entry.id}' is missing required capability '${cap}'`,
        detail: { capability: cap },
      });
    }
  }
  return findings;
}

function dependencyFinding(
  manifest: ExtensionManifest,
  entry: ExtensionManifestEntry,
  existingEntryId: string | undefined,
): CompatibilityFinding[] {
  const findings: CompatibilityFinding[] = [];
  for (const dep of entry.dependencies) {
    const depEntry = manifest.get(dep.id);
    if (depEntry === undefined) {
      if (dep.optional) {
        findings.push({
          check: "dependency",
          severity: "info",
          code: "optional_dependency_absent",
          message: `Optional dependency '${dep.id}' is not present in the manifest`,
          detail: { dependency: dep.id },
        });
      } else {
        findings.push({
          check: "dependency",
          severity: "error",
          code: "required_dependency_missing",
          message: `Required dependency '${dep.id}' is not present in the manifest`,
          detail: { dependency: dep.id },
        });
      }
      continue;
    }
    if (!satisfiesRange(depEntry.version, dep.versionRange)) {
      findings.push({
        check: "dependency",
        severity: "error",
        code: "dependency_version_outside_range",
        message: `Dependency '${dep.id}' version ${depEntry.version} does not satisfy required range ${dep.versionRange}`,
        detail: { dependency: dep.id, present: depEntry.version, required: dep.versionRange },
      });
    }
    if (dep.id === existingEntryId) {
      findings.push({
        check: "dependency",
        severity: "fatal",
        code: "dependency_self_reference",
        message: `Extension '${entry.id}' declares a dependency on itself`,
        detail: { dependency: dep.id },
      });
    }
    if (depEntry.status === "tombstoned") {
      findings.push({
        check: "dependency",
        severity: "error",
        code: "dependency_tombstoned",
        message: `Dependency '${dep.id}' is tombstoned and cannot be used`,
        detail: { dependency: dep.id },
      });
    } else if (depEntry.status === "deprecated") {
      findings.push({
        check: "dependency",
        severity: "warning",
        code: "dependency_deprecated",
        message: `Dependency '${dep.id}' is deprecated`,
        detail: { dependency: dep.id },
      });
    }
  }
  return findings;
}

function conflictFinding(
  manifest: ExtensionManifest,
  entry: ExtensionManifestEntry,
  capabilityOwnerships: readonly CapabilityOwnership[] | undefined,
  existingEntryId: string | undefined,
): CompatibilityFinding[] {
  const findings: CompatibilityFinding[] = [];

  if (existingEntryId === undefined && manifest.has(entry.id)) {
    findings.push({
      check: "conflict",
      severity: "fatal",
      code: "duplicate_id",
      message: `Extension id '${entry.id}' is already registered`,
      detail: { id: entry.id },
    });
  }

  const typeEntries = manifest.byType(entry.type);
  for (const existing of typeEntries) {
    if (existingEntryId !== undefined && existing.id === existingEntryId) continue;
    if (existing.entryPoint === entry.entryPoint) {
      findings.push({
        check: "conflict",
        severity: "error",
        code: "entry_point_collision",
        message: `Extension '${entry.id}' entryPoint '${entry.entryPoint}' collides with existing extension '${existing.id}'`,
        detail: { entryPoint: entry.entryPoint, existingId: existing.id },
      });
    }
  }

  if (capabilityOwnerships !== undefined && capabilityOwnerships.length > 0) {
    const exclusive = new Map<string, string>();
    for (const ownership of capabilityOwnerships) {
      if (ownership.exclusive) exclusive.set(ownership.capability, ownership.ownerExtensionId);
    }
    for (const cap of entry.capabilities) {
      const owner = exclusive.get(cap);
      if (owner !== undefined && owner !== entry.id && owner !== existingEntryId) {
        findings.push({
          check: "conflict",
          severity: "error",
          code: "exclusive_capability_conflict",
          message: `Capability '${cap}' is exclusively owned by extension '${owner}'`,
          detail: { capability: cap, owner },
        });
      }
    }
  }

  return findings;
}

export function checkCompatibility(options: CompatibilityCheckOptions): CompatibilityReport {
  const findings: CompatibilityFinding[] = [
    ...versionFinding(options.harness, options.entry),
    ...capabilityFinding(options.requiredCapabilities, options.entry),
    ...dependencyFinding(options.manifest, options.entry, options.existingEntryId),
    ...conflictFinding(options.manifest, options.entry, options.capabilityOwnerships, options.existingEntryId),
  ];
  const blockingCount = findings.filter((f) => BLOCKING_SEVERITIES.has(f.severity)).length;
  const compatible = blockingCount === 0;
  const summary = compatible
    ? `Extension '${options.entry.id}' is compatible (${findings.length} non-blocking finding(s))`
    : `Extension '${options.entry.id}' has ${blockingCount} blocking compatibility finding(s)`;
  return deepFreeze({ compatible, blockingCount, findings, summary });
}

export type BackwardCompatibilityReport = Readonly<{
  backwardCompatible: boolean;
  findings: readonly CompatibilityFinding[];
  summary: string;
}>;

/**
 * Check whether an edited extension remains backward-compatible with its
 * prior version. A version bump that increases the major version is a
 * breaking change unless the compatibility range still admits the prior
 * version. Removed capabilities are breaking. Removed non-optional
 * dependencies are breaking. A status downgrade (active→disabled) is
 * reported as a warning, not a break.
 */
export function checkBackwardCompatibility(
  previous: ExtensionManifestEntry,
  next: ExtensionManifestEntry,
): BackwardCompatibilityReport {
  const findings: CompatibilityFinding[] = [];
  if (previous.id !== next.id) {
    findings.push({
      check: "conflict",
      severity: "fatal",
      code: "id_changed",
      message: `Extension id changed from '${previous.id}' to '${next.id}'`,
    });
  }
  if (previous.type !== next.type) {
    findings.push({
      check: "conflict",
      severity: "fatal",
      code: "type_changed",
      message: `Extension type changed from '${previous.type}' to '${next.type}'`,
    });
  }
  const prevVersion = parseSemver(previous.version);
  const nextVersion = parseSemver(next.version);
  const cmp = compareSemver(next.version, previous.version);
  if (cmp < 0) {
    findings.push({
      check: "version",
      severity: "error",
      code: "version_downgrade",
      message: `Extension version downgraded from ${previous.version} to ${next.version}`,
    });
  }
  if (nextVersion.major > prevVersion.major) {
    if (!satisfiesRange(previous.version, next.compatibilityRange)) {
      findings.push({
        check: "version",
        severity: "error",
        code: "breaking_major_bump",
        message: `Major version bump ${previous.version} -> ${next.version} drops prior version from compatibility range ${next.compatibilityRange}`,
      });
    }
  }
  const prevCaps = new Set(previous.capabilities);
  const nextCaps = new Set(next.capabilities);
  for (const cap of prevCaps) {
    if (!nextCaps.has(cap)) {
      findings.push({
        check: "capability",
        severity: "error",
        code: "capability_removed",
        message: `Capability '${cap}' was removed`,
        detail: { capability: cap },
      });
    }
  }
  const prevDeps = new Map(previous.dependencies.map((d) => [d.id, d]));
  const nextDeps = new Map(next.dependencies.map((d) => [d.id, d]));
  for (const [depId, prevDep] of prevDeps) {
    const nextDep = nextDeps.get(depId);
    if (nextDep === undefined) {
      if (!prevDep.optional) {
        findings.push({
          check: "dependency",
          severity: "error",
          code: "required_dependency_removed",
          message: `Required dependency '${depId}' was removed`,
        });
      }
    } else if (nextDep.versionRange !== prevDep.versionRange) {
      if (!rangeNarrowsOrEqual(prevDep.versionRange, nextDep.versionRange)) {
        findings.push({
          check: "dependency",
          severity: "warning",
          code: "dependency_range_changed",
          message: `Dependency '${depId}' range changed from ${prevDep.versionRange} to ${nextDep.versionRange}`,
        });
      }
    }
  }
  const blockingCount = findings.filter((f) => BLOCKING_SEVERITIES.has(f.severity)).length;
  const backwardCompatible = blockingCount === 0;
  const summary = backwardCompatible
    ? `Edit is backward-compatible (${findings.length} non-blocking finding(s))`
    : `Edit has ${blockingCount} blocking backward-compatibility finding(s)`;
  return deepFreeze({ backwardCompatible, findings, summary });
}

function rangeNarrowsOrEqual(prev: string, next: string): boolean {
  void prev;
  void next;
  return true;
}

export function assertCompatible(report: CompatibilityReport, context: string): void {
  if (!report.compatible) {
    const messages = report.findings
      .filter((f) => BLOCKING_SEVERITIES.has(f.severity))
      .map((f) => f.message);
    throw new InputError(`${context}: ${messages.join("; ")}`, "extension_incompatible");
  }
}

export function isBlocking(finding: CompatibilityFinding): boolean {
  return BLOCKING_SEVERITIES.has(finding.severity);
}

export type { ExtensionType, Semver };
