import { HarnessError, InputError } from "../kernel/errors.ts";
import { canonicalHash, deepFreeze, SHA256_HEX_REGEX } from "../kernel/integrity.ts";
import { ISO_TIMESTAMP_PATTERN } from "./extension-validation.ts";
import { memberOf } from "../shared/type-guards.ts";
import { isValidRange, isValidSemver, parseSemver } from "./semver.ts";
// R50 (R49-F3): manifest-validation limits owned by extensions-config.ts
// (single owner — no parallel inline literals, ).
import {
  DEFAULT_MAX_EXTENSION_CAPABILITIES,
  DEFAULT_MAX_EXTENSION_CAPABILITY_LENGTH,
  DEFAULT_MAX_EXTENSION_DEPENDENCIES,
  DEFAULT_MAX_EXTENSION_DESCRIPTION_LENGTH,
  DEFAULT_MAX_EXTENSION_ID_LENGTH,
} from "./extensions-config.ts";
import { schemaId } from "../kernel/product-identity.ts";

/**
 * Extension manifest — the one canonical registry of every installed
 * extension in the harness.
 *
 * Per delivery map item 12 and canonical requirement DER-030:
 * "Define one versioned extension manifest family and registry for provider
 * adapters, model profiles, MCP tools/adapters, agent profiles, quality
 * packs, editor/repository/search capabilities, and future cohesive modules."
 *
 * Per root-policy `selfEvolutionArchitecture`:
 * authority: "single-versioned-extension-manifest-family-and-registry"
 * extensionTypes: provider-adapter, model-profile, mcp-tool-or-adapter,
 * agent-profile, quality-pack, editor-repository-or-search-capability,
 * cohesive-product-module
 * manifestBaseFields: stable-identity-version-and-extension-type,
 * harness-api-and-compatibility-range, capabilities-operations-and-
 * required-provided-ports, config-schema-fragment, allowed-tools-data-
 * classifications-and-effects, dependencies-licenses-provenance-digests-and-
 * signatures, migrations-lifecycle-hooks-and-tests, rollback-deprecation-
 * removal-and-tombstone-policy
 *
 * This module owns the static manifest authority: the versioned schema, the
 * closed registries of extension types and statuses, the entry shape, and
 * the registry that validates and freezes entries. It is the domain layer —
 * it declares contracts and validates them; it performs no filesystem,
 * process, or network effects. Persistence and activation go through the
 * transactional editor and the lifecycle/approval workflow.
 *
 * Per root-policy `runtimeEnforcementAvailable: false`, the OS-enforced
 * privileged update broker is a separate future slice; this manifest is the
 * target-invariant authority and typed tool surface, not a runtime
 * enforcement claim.
 */

export const EXTENSION_MANIFEST_SCHEMA_VERSION = schemaId("extension-manifest", 1);

export const EXTENSION_TYPES = deepFreeze([
  "provider-adapter",
  "model-profile",
  "mcp-tool-or-adapter",
  "agent-profile",
  "quality-pack",
  "editor-repository-or-search-capability",
  "cohesive-product-module",
] as const);

export type ExtensionType = typeof EXTENSION_TYPES[number];

export const EXTENSION_STATUSES = deepFreeze([
  "proposed",
  "staged",
  "active",
  "disabled",
  "deprecated",
  "tombstoned",
] as const);

export type ExtensionStatus = typeof EXTENSION_STATUSES[number];

/**
 * Lifecycle operations (per root-policy selfEvolutionArchitecture.lifecycle):
 * add, edit, deprecate, delete, upgrade, downgrade, enable, disable,
 * rollback. These are the registered mutation operations; the lifecycle
 * state machine in extension-lifecycle.ts owns the legal transitions.
 */
export const EXTENSION_OPERATIONS = deepFreeze([
  "add",
  "edit",
  "deprecate",
  "delete",
  "upgrade",
  "downgrade",
  "enable",
  "disable",
  "rollback",
] as const);

export type ExtensionOperation = typeof EXTENSION_OPERATIONS[number];

export type ExtensionDependency = Readonly<{
  id: string;
  versionRange: string;
  optional?: boolean;
}>;

export type ExtensionProvenance = Readonly<{
  publisher: string;
  sourceUri: string;
  contentDigest: string;
  declaredLicense?: string;
}>;

export type ExtensionManifestEntry = Readonly<{
  id: string;
  version: string;
  type: ExtensionType;
  status: ExtensionStatus;
  description: string;
  capabilities: readonly string[];
  dependencies: readonly ExtensionDependency[];
  entryPoint: string;
  apiVersion: string;
  compatibilityRange: string;
  provenance: ExtensionProvenance;
  configSchemaFragment?: Readonly<Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
}>;

export type ExtensionManifestSnapshot = Readonly<{
  schemaVersion: typeof EXTENSION_MANIFEST_SCHEMA_VERSION;
  entries: readonly ExtensionManifestEntry[];
  manifestHash: string;
}>;

export type ExtensionManifest = Readonly<{
  register(entry: ExtensionManifestEntry): void;
  get(id: string): ExtensionManifestEntry | undefined;
  has(id: string): boolean;
  entries(): readonly ExtensionManifestEntry[];
  activeEntries(): readonly ExtensionManifestEntry[];
  byType(type: ExtensionType): readonly ExtensionManifestEntry[];
  byStatus(status: ExtensionStatus): readonly ExtensionManifestEntry[];
  ids(): readonly string[];
  size(): number;
  validate(): readonly string[];
  identityHash(): string;
  snapshot(): ExtensionManifestSnapshot;
  dependents(id: string): readonly string[];
  dependencyGraph(): Readonly<Record<string, readonly string[]>>;
  hasCycle(): boolean;
}>;

export class ExtensionManifestError extends HarnessError {
  constructor(message: string, code = "extension_manifest_invalid") {
    super(message, code);
  }
}

// THE VOCABULARY'S OWN MEMBERSHIP TEST, HELD IN A CLOSURE NOTHING CAN NAME.
// `new Set<string>(X)` erases the element type and hands out a MUTABLE set,
// so a predicate built from a vocabulary could still be made to disagree with
// it — driven: one `.delete(…)` typechecked, left every suite green, and
// silently dropped a live value at a boundary. It also made these predicates
// byte-identical siblings across four modules, carried for months as an
// allowlisted duplicate whose own reason read "to remove this entry, extract
// a shared helper and import at all sites". This is that helper.
export const isExtensionType = memberOf(EXTENSION_TYPES);
export const isExtensionStatus = memberOf(EXTENSION_STATUSES);

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
const ENTRY_POINT_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/u;
const SOURCE_URI_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const PUBLISHER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

const MAX_ID_LENGTH = DEFAULT_MAX_EXTENSION_ID_LENGTH;
const MAX_DESCRIPTION_LENGTH = DEFAULT_MAX_EXTENSION_DESCRIPTION_LENGTH;
const MAX_CAPABILITIES = DEFAULT_MAX_EXTENSION_CAPABILITIES;
const MAX_DEPENDENCIES = DEFAULT_MAX_EXTENSION_DEPENDENCIES;
const MAX_CAPABILITY_LENGTH = DEFAULT_MAX_EXTENSION_CAPABILITY_LENGTH;

export function validateExtensionManifestEntry(entry: ExtensionManifestEntry): readonly string[] {
  const violations: string[] = [];

  if (typeof entry.id !== "string" || entry.id.length === 0 || entry.id.length > MAX_ID_LENGTH) {
    violations.push("id must be a non-empty string within length limits");
  } else if (!ID_PATTERN.test(entry.id)) {
    violations.push(`id '${entry.id}' does not match required pattern`);
  }

  if (typeof entry.version !== "string" || !isValidSemver(entry.version)) {
    violations.push(`version '${String(entry.version)}' is not a valid semantic version`);
  }

  if (!isExtensionType(entry.type)) {
    violations.push(`type '${String(entry.type)}' is not a registered extension type`);
  }

  if (!isExtensionStatus(entry.status)) {
    violations.push(`status '${String(entry.status)}' is not a registered extension status`);
  }

  if (typeof entry.description !== "string" || entry.description.length === 0) {
    violations.push("description must be a non-empty string");
  } else if (entry.description.length > MAX_DESCRIPTION_LENGTH) {
    violations.push("description exceeds maximum length");
  }

  if (!Array.isArray(entry.capabilities)) {
    violations.push("capabilities must be an array");
  } else {
    if (entry.capabilities.length > MAX_CAPABILITIES) {
      violations.push(`capabilities exceed maximum of ${MAX_CAPABILITIES}`);
    }
    const seenCaps = new Set<string>();
    for (const cap of entry.capabilities) {
      if (typeof cap !== "string" || cap.length === 0 || cap.length > MAX_CAPABILITY_LENGTH) {
        violations.push(`capability '${String(cap)}' must be a non-empty string within length limits`);
      } else if (!/^[a-z0-9][a-z0-9._-]*$/u.test(cap)) {
        violations.push(`capability '${cap}' does not match required pattern`);
      }
      if (seenCaps.has(cap)) violations.push(`duplicate capability '${cap}'`);
      seenCaps.add(cap);
    }
  }

  if (!Array.isArray(entry.dependencies)) {
    violations.push("dependencies must be an array");
  } else {
    if (entry.dependencies.length > MAX_DEPENDENCIES) {
      violations.push(`dependencies exceed maximum of ${MAX_DEPENDENCIES}`);
    }
    const seenDeps = new Set<string>();
    for (const dep of entry.dependencies) {
      if (typeof dep !== "object" || dep === null) {
        violations.push("dependency must be an object");
        continue;
      }
      if (typeof dep.id !== "string" || dep.id.length === 0 || !ID_PATTERN.test(dep.id)) {
        violations.push(`dependency id '${String(dep.id)}' is invalid`);
      }
      if (typeof dep.versionRange !== "string" || !isValidRange(dep.versionRange)) {
        violations.push(`dependency '${String(dep.id)}' has invalid version range '${String(dep.versionRange)}'`);
      }
      if (dep.optional !== undefined && typeof dep.optional !== "boolean") {
        violations.push(`dependency '${String(dep.id)}' optional flag must be boolean`);
      }
      if (dep.id !== undefined && seenDeps.has(dep.id)) {
        violations.push(`duplicate dependency id '${dep.id}'`);
      }
      if (dep.id !== undefined) seenDeps.add(dep.id);
    }
  }

  if (typeof entry.entryPoint !== "string" || entry.entryPoint.length === 0) {
    violations.push("entryPoint must be a non-empty string");
  } else if (!ENTRY_POINT_PATTERN.test(entry.entryPoint)) {
    violations.push(`entryPoint '${entry.entryPoint}' does not match required pattern`);
  }

  if (typeof entry.apiVersion !== "string" || !isValidSemver(entry.apiVersion)) {
    violations.push(`apiVersion '${String(entry.apiVersion)}' is not a valid semantic version`);
  }

  if (typeof entry.compatibilityRange !== "string" || !isValidRange(entry.compatibilityRange)) {
    violations.push(`compatibilityRange '${String(entry.compatibilityRange)}' is not a valid version range`);
  }

  if (typeof entry.provenance !== "object" || entry.provenance === null) {
    violations.push("provenance must be an object");
  } else {
    const p = entry.provenance;
    if (typeof p.publisher !== "string" || p.publisher.length === 0 || !PUBLISHER_PATTERN.test(p.publisher)) {
      violations.push("provenance.publisher must be a non-empty identifier");
    }
    if (typeof p.sourceUri !== "string" || p.sourceUri.length === 0 || !SOURCE_URI_PATTERN.test(p.sourceUri)) {
      violations.push("provenance.sourceUri must be a non-empty locator string");
    }
    if (typeof p.contentDigest !== "string" || !SHA256_HEX_REGEX.test(p.contentDigest)) {
      violations.push("provenance.contentDigest must be a SHA-256 hex digest");
    }
    if (p.declaredLicense !== undefined && (typeof p.declaredLicense !== "string" || p.declaredLicense.length === 0)) {
      violations.push("provenance.declaredLicense must be a non-empty string when present");
    }
  }

  if (typeof entry.createdAt !== "string" || !ISO_TIMESTAMP_PATTERN.test(entry.createdAt)) {
    violations.push("createdAt must be an ISO-8601 timestamp");
  }
  if (typeof entry.updatedAt !== "string" || !ISO_TIMESTAMP_PATTERN.test(entry.updatedAt)) {
    violations.push("updatedAt must be an ISO-8601 timestamp");
  }
  if (
    typeof entry.createdAt === "string" &&
    typeof entry.updatedAt === "string" &&
    ISO_TIMESTAMP_PATTERN.test(entry.createdAt) &&
    ISO_TIMESTAMP_PATTERN.test(entry.updatedAt) &&
    entry.updatedAt < entry.createdAt
  ) {
    violations.push("updatedAt must not precede createdAt");
  }

  if (entry.configSchemaFragment !== undefined) {
    if (typeof entry.configSchemaFragment !== "object" || entry.configSchemaFragment === null || Array.isArray(entry.configSchemaFragment)) {
      violations.push("configSchemaFragment must be a JSON object when present");
    }
  }

  return violations;
}

function freezeEntry(entry: ExtensionManifestEntry): ExtensionManifestEntry {
  return deepFreeze({
    id: entry.id,
    version: entry.version,
    type: entry.type,
    status: entry.status,
    description: entry.description,
    capabilities: deepFreeze([...entry.capabilities]),
    dependencies: deepFreeze(entry.dependencies.map((d) => deepFreeze({ ...d }))),
    entryPoint: entry.entryPoint,
    apiVersion: entry.apiVersion,
    compatibilityRange: entry.compatibilityRange,
    provenance: deepFreeze({ ...entry.provenance }),
    ...(entry.configSchemaFragment !== undefined
      ? { configSchemaFragment: deepFreeze({ ...entry.configSchemaFragment }) as Readonly<Record<string, unknown>> }
      : {}),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  });
}

export function createExtensionManifest(
  initialEntries: readonly ExtensionManifestEntry[] = [],
): ExtensionManifest {
  const byId = new Map<string, ExtensionManifestEntry>();

  function doRegister(entry: ExtensionManifestEntry): void {
    const violations = validateExtensionManifestEntry(entry);
    if (violations.length > 0) {
      throw new ExtensionManifestError(
        `Invalid extension manifest entry '${entry.id ?? "<unknown>"}': ${violations.join("; ")}`,
        "extension_manifest_entry_invalid",
      );
    }
    if (byId.has(entry.id)) {
      throw new InputError(
        `Extension '${entry.id}' is already registered`,
        "extension_manifest_duplicate_id",
      );
    }
    byId.set(entry.id, freezeEntry(entry));
  }

  for (const entry of initialEntries) {
    doRegister(entry);
  }

  function dependents(id: string): readonly string[] {
    const result: string[] = [];
    for (const entry of byId.values()) {
      for (const dep of entry.dependencies) {
        if (dep.id === id) result.push(entry.id);
      }
    }
    return [...new Set(result)].sort();
  }

  function buildDependencyGraph(): Map<string, string[]> {
    const graph = new Map<string, string[]>();
    for (const entry of byId.values()) {
      const deps: string[] = [];
      for (const dep of entry.dependencies) {
        if (byId.has(dep.id)) deps.push(dep.id);
      }
      graph.set(entry.id, deps);
    }
    return graph;
  }

  function detectCycle(): boolean {
    const graph = buildDependencyGraph();
    const visited = new Set<string>();
    const stack = new Set<string>();
    const dfs = (node: string): boolean => {
      if (stack.has(node)) return true;
      if (visited.has(node)) return false;
      visited.add(node);
      stack.add(node);
      const neighbors = graph.get(node) ?? [];
      for (const n of neighbors) {
        if (dfs(n)) return true;
      }
      stack.delete(node);
      return false;
    };
    for (const node of graph.keys()) {
      if (dfs(node)) return true;
    }
    return false;
  }

  return deepFreeze({
    register(entry: ExtensionManifestEntry): void {
      doRegister(entry);
    },
    get(id: string): ExtensionManifestEntry | undefined {
      return byId.get(id);
    },
    has(id: string): boolean {
      return byId.has(id);
    },
    entries(): readonly ExtensionManifestEntry[] {
      return [...byId.values()];
    },
    activeEntries(): readonly ExtensionManifestEntry[] {
      return [...byId.values()].filter((e) => e.status === "active");
    },
    byType(type: ExtensionType): readonly ExtensionManifestEntry[] {
      return [...byId.values()].filter((e) => e.type === type);
    },
    byStatus(status: ExtensionStatus): readonly ExtensionManifestEntry[] {
      return [...byId.values()].filter((e) => e.status === status);
    },
    ids(): readonly string[] {
      return [...byId.keys()].sort();
    },
    size(): number {
      return byId.size;
    },
    validate(): readonly string[] {
      const violations: string[] = [];
      const ids = new Set<string>();
      for (const entry of byId.values()) {
        const entryViolations = validateExtensionManifestEntry(entry);
        for (const v of entryViolations) violations.push(`${entry.id}: ${v}`);
        if (ids.has(entry.id)) violations.push(`duplicate id: ${entry.id}`);
        ids.add(entry.id);
      }
      for (const entry of byId.values()) {
        for (const dep of entry.dependencies) {
          if (!byId.has(dep.id) && !dep.optional) {
            violations.push(`${entry.id}: missing non-optional dependency '${dep.id}'`);
          }
        }
      }
      if (detectCycle()) {
        violations.push("dependency graph contains a cycle");
      }
      return violations;
    },
    identityHash(): string {
      const sorted = [...byId.values()].map((e) => ({
        id: e.id,
        version: e.version,
        type: e.type,
        status: e.status,
        capabilities: [...e.capabilities],
        dependencies: [...e.dependencies],
        apiVersion: e.apiVersion,
      })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return canonicalHash(sorted);
    },
    snapshot(): ExtensionManifestSnapshot {
      const entries = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const manifestHash = canonicalHash({
        schemaVersion: EXTENSION_MANIFEST_SCHEMA_VERSION,
        entries: entries.map((e) => ({
          id: e.id,
          version: e.version,
          type: e.type,
          status: e.status,
          capabilities: [...e.capabilities],
          dependencies: [...e.dependencies],
          entryPoint: e.entryPoint,
          apiVersion: e.apiVersion,
          compatibilityRange: e.compatibilityRange,
          provenance: e.provenance,
          createdAt: e.createdAt,
          updatedAt: e.updatedAt,
        })),
      });
      return deepFreeze({ schemaVersion: EXTENSION_MANIFEST_SCHEMA_VERSION, entries, manifestHash });
    },
    dependents,
    dependencyGraph(): Readonly<Record<string, readonly string[]>> {
      const graph = buildDependencyGraph();
      const result: Record<string, readonly string[]> = {};
      for (const [id, deps] of graph.entries()) {
        result[id] = [...deps].sort();
      }
      return deepFreeze(result);
    },
    hasCycle(): boolean {
      return detectCycle();
    },
  });
}

export function extensionEntryHash(entry: ExtensionManifestEntry): string {
  return canonicalHash({
    id: entry.id,
    version: entry.version,
    type: entry.type,
    status: entry.status,
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

export function normalizeEntryForDiff(entry: ExtensionManifestEntry): Readonly<Record<string, unknown>> {
  const p = parseSemver(entry.version);
  void p;
  return deepFreeze({
    id: entry.id,
    version: entry.version,
    type: entry.type,
    status: entry.status,
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
