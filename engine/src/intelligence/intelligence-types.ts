import { InputError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { getAllSourceExtensions } from "./language-registry.ts";
import { memberOf } from "../shared/type-guards.ts";
import { DEFAULT_SEARCH_LIMIT, DEFAULT_REUSE_LIMIT } from "./intelligence-config.ts";
import { schemaId } from "../kernel/product-identity.ts";

/**
 * Whole-codebase intelligence types.
 *
 * Implements delivery-map item 7: before every modification, generate/query a
 * trustworthy full-repository map and search for reusable/adaptable logic.
 *
 * This module defines the shared types used by the repository map, symbol
 * search, dependency graph, reuse discovery, and data-flow analysis modules.
 *
 * Per the root policy invariant `retrievalScoreAsTruthAllowed: false`,
 * intelligence results are discovery evidence only. They cannot alone block
 * an attempt, approve an edit, or resolve a conflict.
 */

export const INTELLIGENCE_SCHEMA_VERSION = schemaId("intelligence", 1);

/**
 * All known source-file extensions, derived dynamically from the canonical
 * `language-registry.ts` (ONE owner). Previously this was a hardcoded JS/TS
 * list (`.cjs/.cts/.js/.jsx/.mjs/.mts/.ts/.tsx`); it now spans every
 * registered language so `repository-map.ts` / `symbol-search.ts` /
 * `reuse-discovery.ts` operate across all languages. Adding a language to
 * `language-registry.ts` automatically extends this set.
 */
export const SOURCE_EXTENSIONS = deepFreeze(getAllSourceExtensions());

export type SourceExtension = string;

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "const"
  | "let"
  | "var"
  | "enum"
  | "namespace"
  | "method"
  | "property"
  | "parameter";

export const SYMBOL_KINDS = deepFreeze([
  "function", "class", "interface", "type", "const", "let", "var",
  "enum", "namespace", "method", "property", "parameter",
] as const);

export type SymbolVisibility = "exported" | "local" | "imported";

export type SymbolLocation = Readonly<{
  filePath: string;
  line: number;
  column: number;
}>;

export type SymbolInfo = Readonly<{
  name: string;
  kind: SymbolKind;
  visibility: SymbolVisibility;
  location: SymbolLocation;
  exported: boolean;
  async: boolean;
  generator: boolean;
  parameterCount: number;
  modifiers: readonly string[];
}>;

export type FileInfo = Readonly<{
  path: string;
  extension: SourceExtension | null;
  sizeBytes: number;
  /** Content hash. EMPTY STRING from a stat-only walk (the hash is only
   * known once a file is read); the real digest once the file was read. */
  contentHash: string;
  /** Line count. ZERO from a stat-only walk (counting lines requires the
   * bytes); the real count once the file was parsed. */
  lineCount: number;
  isSource: boolean;
  /** Modification time in ms — the stat-cache key half (with `sizeBytes`).
   * Present when the listing came from a filesystem stat walk; absent from
   * in-memory/mock readers (such files are always treated as changed — the
   * safe fallback re-reads and reuses by content hash). */
  mtimeMs?: number;
}>;

export type ImportInfo = Readonly<{
  specifier: string;
  kind: "direct-import" | "re-export" | "dynamic-import" | "require";
  importedNames: readonly string[];
  resolvedPath: string | null;
}>;

export type ExportInfo = Readonly<{
  name: string;
  kind: "declared" | "re-export" | "default";
  localName: string | null;
  sourceSpecifier: string | null;
}>;

export type ModuleInfo = Readonly<{
  path: string;
  contentHash: string;
  lineCount: number;
  symbols: readonly SymbolInfo[];
  imports: readonly ImportInfo[];
  exports: readonly ExportInfo[];
  architectureModuleId: string | null;
  architectureLayer: string | null;
  architectureRealm: string | null;
  architectureOwner: string | null;
}>;

export type RepositoryMap = Readonly<{
  schemaVersion: typeof INTELLIGENCE_SCHEMA_VERSION;
  rootPath: string;
  generatedAt: string;
  files: readonly FileInfo[];
  modules: readonly ModuleInfo[];
  totalSymbols: number;
  totalDependencies: number;
  mapHash: string;
}>;

export type SymbolSearchQuery = Readonly<{
  name: string | null;
  kind: SymbolKind | null;
  filePath: string | null;
  directory: string | null;
  exported: boolean | null;
  async: boolean | null;
  limit: number;
  matchMode: "exact" | "prefix" | "fuzzy" | "contains";
}>;

export type SymbolSearchResult = Readonly<{
  symbol: SymbolInfo;
  filePath: string;
  score: number;
  matchedFields: readonly string[];
}>;

export type DependencyEdge = Readonly<{
  from: string;
  to: string;
  specifier: string;
}>;

export type DependencyGraph = Readonly<{
  edges: readonly DependencyEdge[];
  forwardAdjacency: ReadonlyMap<string, readonly string[]>;
  reverseAdjacency: ReadonlyMap<string, readonly string[]>;
  nodeCount: number;
  edgeCount: number;
}>;

export type CycleResult = Readonly<{
  hasCycles: boolean;
  cycles: ReadonlyArray<readonly string[]>;
}>;

export type ImpactResult = Readonly<{
  directlyAffected: readonly string[];
  transitivelyAffected: readonly string[];
  totalAffected: number;
}>;

export type ReuseCandidate = Readonly<{
  symbol: SymbolInfo;
  filePath: string;
  score: number;
  reasons: readonly string[];
}>;

export type DuplicateGroup = Readonly<{
  name: string;
  kind: SymbolKind;
  locations: readonly SymbolLocation[];
  count: number;
}>;

export type DataFlowNode = Readonly<{
  symbol: SymbolInfo;
  filePath: string;
  role: "source" | "sink" | "transform" | "pass-through";
}>;

export type DataFlowResult = Readonly<{
  symbol: SymbolInfo;
  sources: readonly DataFlowNode[];
  sinks: readonly DataFlowNode[];
  flowsThrough: readonly DataFlowNode[];
}>;

export type ReuseQuery = Readonly<{
  name: string | null;
  kind: SymbolKind | null;
  signature: string | null;
  directory: string | null;
  limit: number;
}>;

// THE VOCABULARY'S OWN MEMBERSHIP TEST, HELD IN A CLOSURE NOTHING CAN NAME.
// `new Set<string>(X)` erases the element type and hands out a MUTABLE set,
// so a predicate built from a vocabulary could still be made to disagree with
// it — driven: one `.delete(…)` typechecked, left every suite green, and
// silently dropped a live value at a boundary. It also made these predicates
// byte-identical siblings across four modules, carried for months as an
// allowlisted duplicate whose own reason read "to remove this entry, extract
// a shared helper and import at all sites". This is that helper.
export const isSymbolKind = memberOf(SYMBOL_KINDS);

export function isSourceExtension(value: string): value is SourceExtension {
  return (SOURCE_EXTENSIONS as readonly string[]).includes(value);
}

export function getSourceExtension(path: string): SourceExtension | null {
  for (const ext of SOURCE_EXTENSIONS) {
    if (path.endsWith(ext)) return ext;
  }
  return null;
}

export function createSymbolSearchQuery(input: {
  name?: string;
  kind?: SymbolKind;
  filePath?: string;
  directory?: string;
  exported?: boolean;
  async?: boolean;
  limit?: number;
  matchMode?: "exact" | "prefix" | "fuzzy" | "contains";
}): SymbolSearchQuery {
  const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
  if (limit < 1 || !Number.isFinite(limit)) {
    throw new InputError("search limit must be a positive finite number", "intelligence_symbol_query_invalid");
  }
  const matchMode = input.matchMode ?? "exact";
  if (matchMode !== "exact" && matchMode !== "prefix" && matchMode !== "fuzzy" && matchMode !== "contains") {
    throw new InputError(`matchMode must be exact, prefix, fuzzy, or contains; got ${matchMode}`, "intelligence_symbol_match_mode_unknown");
  }
  return deepFreeze({
    name: input.name ?? null,
    kind: input.kind ?? null,
    filePath: input.filePath ?? null,
    directory: input.directory ?? null,
    exported: input.exported ?? null,
    async: input.async ?? null,
    limit,
    matchMode,
  });
}

export function createReuseQuery(input: {
  name?: string;
  kind?: SymbolKind;
  signature?: string;
  directory?: string;
  limit?: number;
}): ReuseQuery {
  const limit = input.limit ?? DEFAULT_REUSE_LIMIT;
  if (limit < 1 || !Number.isFinite(limit)) {
    throw new InputError("reuse limit must be a positive finite number", "intelligence_reuse_query_invalid");
  }
  return deepFreeze({
    name: input.name ?? null,
    kind: input.kind ?? null,
    signature: input.signature ?? null,
    directory: input.directory ?? null,
    limit,
  });
}
