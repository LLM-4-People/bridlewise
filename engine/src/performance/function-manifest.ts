import { canonicalHash, deepFreeze } from "../kernel/integrity.ts";
import {
  ARCHITECTURE_MANIFEST,
  type ArchitectureModule,
} from "../architecture-manifest.ts";
import { extractErrorMessage, HarnessError } from "../kernel/errors.ts";
import { extractSymbols } from "../intelligence/symbol-extractor.ts";
import { initTreeSitterForExtract } from "../intelligence/tree-sitter-backend.ts";
import type { PerformanceConfig } from "./performance-config.ts";
import { schemaId } from "../kernel/product-identity.ts";

// In-process extract entry: JS/TS extract is unreachable until the
// grammars are loaded. extractSymbols stays sync. Farm-child does not
// import this module (IPC listener must register before WASM load).
await initTreeSitterForExtract(["javascript", "typescript"]);

/**
 * Generated function manifest for performance observability.
 *
 * Enumerates every in-scope function from the architecture-manifest module
 * list or records an explicit reviewed exclusion with owner, rationale,
 * evidence, and affected scope. The manifest is content-hashed for
 * reproducibility and regenerated whenever the architecture manifest changes.
 * A stale or incomplete manifest blocks performance claims.
 *
 * The manifest is derived (generated projection) from the architecture
 * manifest — it is not a separately editable authority.
 */

export const FUNCTION_MANIFEST_SCHEMA_VERSION =
  schemaId("function-manifest", 1);

export type FunctionManifestEntry = Readonly<{
  functionId: string;
  moduleId: string;
  modulePath: string;
  realm: string;
  layer: string;
  owner: string;
  excluded: boolean;
  exclusionRationale: string | undefined;
  exclusionOwner: string | undefined;
  exclusionEvidence: readonly string[] | undefined;
  exclusionScope: string | undefined;
}>;

export type FunctionManifestExclusion = Readonly<{
  moduleId: string;
  functionId: string;
  rationale: string;
  owner: string;
  evidence: readonly string[];
  scope: string;
}>;

export type FunctionManifest = Readonly<{
  schemaVersion: typeof FUNCTION_MANIFEST_SCHEMA_VERSION;
  manifestHash: string;
  architectureManifestHash: string;
  generatedAt: string;
  totalFunctions: number;
  includedFunctions: number;
  excludedFunctions: number;
  entries: readonly FunctionManifestEntry[];
  exclusions: readonly FunctionManifestExclusion[];
}>;

export type FunctionManifestGeneratorOptions = Readonly<{
  config: PerformanceConfig;
  exclusions?: readonly FunctionManifestExclusion[];
  architectureModules?: readonly ArchitectureModule[];
  architectureManifestHash?: string;
  /**
   * Module source text keyed by module path. When provided, real functions
   * are extracted from each module's source via the symbol extractor; the
   * architecture-manifest metadata is used only for owner/scope attribution.
   * When omitted, a module yields no function entries (no source to parse).
   */
  moduleSources?: ReadonlyMap<string, string>;
  clock?: () => string;
}>;

export function generateFunctionManifest(
  options: FunctionManifestGeneratorOptions,
): FunctionManifest {
  const config = options.config;
  const modules = options.architectureModules ?? ARCHITECTURE_MANIFEST.modules;
  const archHash = options.architectureManifestHash ??
    canonicalHash({ modules: modules.map((m) => m.id), schemaVersion: ARCHITECTURE_MANIFEST.schemaVersion });
  const exclusions = options.exclusions ?? [];
  const clock = options.clock ?? (() => new Date().toISOString());
  const moduleSources = options.moduleSources;
  // Exclude-only scope: every declared module is in scope unless the config
  // names it in `excludedModules`. There is no include-list to keep in sync
  // with the architecture manifest — a new module is covered the day it is
  // declared.
  const excludedSet = new Set(config.scope.excludedModules);
  const exclusionMap = new Map<string, FunctionManifestExclusion>();
  for (const exclusion of exclusions) {
    exclusionMap.set(`${exclusion.moduleId}:${exclusion.functionId}`, exclusion);
  }

  const entries: FunctionManifestEntry[] = [];
  for (const module of modules) {
    if (excludedSet.has(module.id)) continue;
    const functions = extractFunctionsFromModule(module, moduleSources?.get(module.path));
    for (const functionId of functions) {
      const exclusionKey = `${module.id}:${functionId}`;
      const exclusion = exclusionMap.get(exclusionKey);
      entries.push(deepFreeze({
        functionId,
        moduleId: module.id,
        modulePath: module.path,
        realm: module.realm,
        layer: module.layer,
        owner: module.owner,
        excluded: exclusion !== undefined,
        exclusionRationale: exclusion?.rationale,
        exclusionOwner: exclusion?.owner,
        exclusionEvidence: exclusion?.evidence,
        exclusionScope: exclusion?.scope,
      }));
    }
  }

  const includedFunctions = entries.filter((e) => !e.excluded).length;
  const excludedFunctions = entries.filter((e) => e.excluded).length;
  const manifestCore = deepFreeze({
    schemaVersion: FUNCTION_MANIFEST_SCHEMA_VERSION,
    architectureManifestHash: archHash,
    generatedAt: clock(),
    totalFunctions: entries.length,
    includedFunctions,
    excludedFunctions,
    entries,
    exclusions,
  });
  const manifestHash = canonicalHash({
    schemaVersion: FUNCTION_MANIFEST_SCHEMA_VERSION,
    architectureManifestHash: archHash,
    totalFunctions: entries.length,
    entries: entries.map((e) => `${e.moduleId}:${e.functionId}:${e.excluded}`),
    exclusions: exclusions.map((e) => `${e.moduleId}:${e.functionId}`),
  });
  return deepFreeze({ ...manifestCore, manifestHash });
}

/**
 * Extract real, exported function names from a module's source text using the
 * shared symbol extractor. Returns an empty list when no source is available
 * (nothing to parse) or when the source cannot be parsed. Only `function`
 * declarations (including async/generator) that are exported are enumerated,
 * so a module with no exports yields zero functions. Architecture-manifest
 * metadata is not used to synthesize pseudo-functions here; it is used only
 * for owner/scope attribution by the caller.
 */
function extractFunctionsFromModule(
  module: ArchitectureModule,
  source: string | undefined,
): readonly string[] {
  if (source === undefined) return [];
  let symbols;
  try {
    symbols = extractSymbols(module.path, source).symbols;
  } catch (error) {
    // Surface the failure with module-path context instead of swallowing it;
    // a function manifest that silently drops a module's functions hides bugs.
    throw new HarnessError(
      `function-manifest: symbol extraction failed for ${module.path}: ${extractErrorMessage(error)}`,
      "function_manifest_symbol_extraction_failed",
    );
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const symbol of symbols) {
    if (symbol.kind !== "function" || !symbol.exported) continue;
    if (seen.has(symbol.name)) continue;
    seen.add(symbol.name);
    names.push(symbol.name);
  }
  return names;
}

export type FunctionManifestValidationResult = Readonly<{
  valid: boolean;
  violations: readonly string[];
  stale: boolean;
}>;

export function validateFunctionManifest(
  manifest: FunctionManifest,
  currentArchitectureModules: readonly ArchitectureModule[],
): FunctionManifestValidationResult {
  const violations: string[] = [];
  const currentArchHash = canonicalHash({
    modules: currentArchitectureModules.map((m) => m.id),
    schemaVersion: ARCHITECTURE_MANIFEST.schemaVersion,
  });
  const stale = manifest.architectureManifestHash !== currentArchHash;
  if (stale) {
    violations.push("function_manifest_stale_architecture_hash");
  }
  const seenKeys = new Set<string>();
  for (const entry of manifest.entries) {
    const key = `${entry.moduleId}:${entry.functionId}`;
    if (seenKeys.has(key)) {
      violations.push(`function_manifest_duplicate:${key}`);
    }
    seenKeys.add(key);
  }
  for (const exclusion of manifest.exclusions) {
    const key = `${exclusion.moduleId}:${exclusion.functionId}`;
    const entry = manifest.entries.find(
      (e) => e.moduleId === exclusion.moduleId && e.functionId === exclusion.functionId,
    );
    if (entry === undefined) {
      violations.push(`function_manifest_exclusion_without_entry:${key}`);
    } else if (!entry.excluded) {
      violations.push(`function_manifest_exclusion_not_marked:${key}`);
    }
    if (exclusion.evidence.length === 0) {
      violations.push(`function_manifest_exclusion_no_evidence:${key}`);
    }
    if (exclusion.rationale.length === 0) {
      violations.push(`function_manifest_exclusion_no_rationale:${key}`);
    }
  }
  return deepFreeze({ valid: violations.length === 0 && !stale, violations, stale });
}

export function functionManifestCoverage(manifest: FunctionManifest): Readonly<{
  totalFunctions: number;
  includedFunctions: number;
  excludedFunctions: number;
  coveragePercent: number;
}> {
  const total = manifest.totalFunctions;
  const included = manifest.includedFunctions;
  const excluded = manifest.excludedFunctions;
  const coveragePercent = total === 0 ? 100 : (included / total) * 100;
  return deepFreeze({ totalFunctions: total, includedFunctions: included, excludedFunctions: excluded, coveragePercent });
}
