import { deepFreeze } from "../kernel/integrity.ts";
import { InputError } from "../kernel/errors.ts";
import { resolveIntelligenceConfig, type IntelligenceConfig } from "./intelligence-config.ts";
import { rankWithActionAffinity } from "./action-affinity.ts";
import type {
  ModuleInfo,
  RepositoryMap,
  SymbolInfo,
  SymbolKind,
  SymbolSearchQuery,
  SymbolSearchResult,
} from "./intelligence-types.ts";

/**
 * Symbol search engine.
 *
 * Searches the repository map for symbols by name, kind, location, and usage.
 * Supports exact, prefix, contains, and fuzzy matching modes.
 *
 * Fuzzy matching uses a subsequence-with-consecutiveness-bonus algorithm
 * similar to fzf: each query character must appear in order in the target
 * name, with bonuses for consecutive matches, leading-character matches, and
 * camelCase/snake_case boundary matches.
 *
 * Usage search finds all modules that import a given symbol name, returning
 * the importing module paths and the imported names.
 *
 * Per the root policy invariant `retrievalScoreAsTruthAllowed: false`, search
 * results are discovery evidence only.
 */

export function searchSymbols(
  map: RepositoryMap,
  query: SymbolSearchQuery,
): readonly SymbolSearchResult[] {
  const candidates: SymbolSearchResult[] = [];
  for (const module of map.modules) {
    for (const symbol of module.symbols) {
      const result = scoreSymbol(module, symbol, query);
      if (result !== null) candidates.push(result);
    }
  }
  candidates.sort(compareSearchResults);
  return deepFreeze(candidates.slice(0, query.limit));
}

/**
 * The hard filters a symbol must pass before ANY scorer looks at it: kind,
 * export/async flags, exact file, containing directory. Both rankers — the
 * lexical `scoreSymbol` and the hybrid BM25 path — gate on exactly this set,
 * so it lives in one function rather than as two copies that could drift
 * into disagreeing about what a query even matches.
 */
function matchesHardFilters(
  module: ModuleInfo,
  symbol: SymbolInfo,
  query: SymbolSearchQuery,
): boolean {
  if (query.kind !== null && symbol.kind !== query.kind) return false;
  if (query.exported !== null && symbol.exported !== query.exported) return false;
  if (query.async !== null && symbol.async !== query.async) return false;
  if (query.filePath !== null && module.path !== query.filePath) return false;
  if (query.directory !== null) {
    const prefix = query.directory.endsWith("/") ? query.directory : `${query.directory}/`;
    if (!module.path.startsWith(prefix)) return false;
  }
  return true;
}

function scoreSymbol(
  module: ModuleInfo,
  symbol: SymbolInfo,
  query: SymbolSearchQuery,
): SymbolSearchResult | null {
  if (!matchesHardFilters(module, symbol, query)) return null;
  if (query.name === null) {
    return {
      symbol,
      filePath: module.path,
      score: 0,
      matchedFields: deepFreeze([]),
    };
  }
  const nameScore = matchName(symbol.name, query.name, query.matchMode);
  if (nameScore === null) return null;
  const matchedFields: string[] = ["name"];
  let totalScore = nameScore;
  if (query.kind !== null) {
    totalScore += 0.05;
    matchedFields.push("kind");
  }
  if (query.filePath !== null) {
    totalScore += 0.1;
    matchedFields.push("file");
  }
  if (query.directory !== null) {
    totalScore += 0.05;
    matchedFields.push("directory");
  }
  if (query.exported === true && symbol.exported) {
    totalScore += 0.1;
    matchedFields.push("exported");
  }
  return {
    symbol,
    filePath: module.path,
    score: totalScore,
    matchedFields: deepFreeze(matchedFields),
  };
}

function matchName(symbolName: string, query: string, mode: SymbolSearchQuery["matchMode"]): number | null {
  const lowerSymbol = symbolName.toLowerCase();
  const lowerQuery = query.toLowerCase();
  switch (mode) {
    case "exact":
      return lowerSymbol === lowerQuery ? 1.0 : null;
    case "prefix":
      if (!lowerSymbol.startsWith(lowerQuery)) return null;
      return lowerQuery.length / lowerSymbol.length;
    case "contains":
      const idx = lowerSymbol.indexOf(lowerQuery);
      if (idx === -1) return null;
      return lowerQuery.length / lowerSymbol.length;
    case "fuzzy":
      return fuzzyMatch(lowerSymbol, lowerQuery);
    default:
      return null;
  }
}

export function fuzzyMatch(target: string, query: string): number | null {
  if (query.length === 0) return 0;
  if (query.length > target.length) return null;
  let queryIndex = 0;
  let score = 0;
  let consecutiveBonus = 0;
  let lastMatchIndex = -1;
  for (let i = 0; i < target.length && queryIndex < query.length; i++) {
    if (target[i] === query[queryIndex]) {
      let bonus = 1;
      if (lastMatchIndex === i - 1) {
        consecutiveBonus += 1;
        bonus += consecutiveBonus;
      } else {
        consecutiveBonus = 0;
      }
      if (i === 0) bonus += 2;
      if (i > 0 && /[_A-Z]/.test(target[i - 1]!)) bonus += 1;
      score += bonus;
      lastMatchIndex = i;
      queryIndex += 1;
    }
  }
  if (queryIndex < query.length) return null;
  const coverage = query.length / target.length;
  return score * 0.1 + coverage * 0.9;
}

export type UsageResult = Readonly<{
  symbolName: string;
  importers: readonly Readonly<{ filePath: string; importedAs: string }>[];
}>;

export function findSymbolUsage(
  map: RepositoryMap,
  symbolName: string,
): UsageResult {
  const importers: Readonly<{ filePath: string; importedAs: string }>[] = [];
  const lowerName = symbolName.toLowerCase();
  for (const module of map.modules) {
    for (const imp of module.imports) {
      const matches = imp.importedNames.some((n) => n.toLowerCase() === lowerName);
      if (matches) {
        importers.push(Object.freeze({ filePath: module.path, importedAs: symbolName }));
      }
    }
  }
  return deepFreeze({ symbolName, importers: deepFreeze(importers) });
}

export function searchByKind(
  map: RepositoryMap,
  kind: SymbolKind,
  limit: number = 100,
): readonly SymbolSearchResult[] {
  return searchSymbols(map, {
    name: null, kind, filePath: null, directory: null,
    exported: null, async: null, limit, matchMode: "exact",
  });
}

export function searchByFile(
  map: RepositoryMap,
  filePath: string,
  limit: number = 100,
): readonly SymbolSearchResult[] {
  return searchSymbols(map, {
    name: null, kind: null, filePath, directory: null,
    exported: null, async: null, limit, matchMode: "exact",
  });
}

export function searchByDirectory(
  map: RepositoryMap,
  directory: string,
  limit: number = 100,
): readonly SymbolSearchResult[] {
  return searchSymbols(map, {
    name: null, kind: null, filePath: null, directory,
    exported: null, async: null, limit, matchMode: "exact",
  });
}

export function searchExportedSymbols(
  map: RepositoryMap,
  name: string | null = null,
  limit: number = 100,
): readonly SymbolSearchResult[] {
  return searchSymbols(map, {
    name, kind: null, filePath: null, directory: null,
    exported: true, async: null, limit, matchMode: name ? "prefix" : "exact",
  });
}

function compareSearchResults(a: SymbolSearchResult, b: SymbolSearchResult): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.filePath !== b.filePath) return a.filePath < b.filePath ? -1 : 1;
  if (a.symbol.location.line !== b.symbol.location.line) {
    return a.symbol.location.line - b.symbol.location.line;
  }
  return a.symbol.name < b.symbol.name ? -1 : a.symbol.name > b.symbol.name ? 1 : 0;
}

// ===========================================================================
// Hybrid search: BM25 (specific queries) + fuzzy (vague queries) + bias
// detection + instant-seal. Combines findings from EXP369/383 (BM25 re-ranker),
// EXP397 (hybrid embeddings), EXP380 (bias detection), EXP350 (instant-seal),
// EXP402 (multi-language name forms), EXP332 (token efficiency).
// ===========================================================================

/**
 * Caller overrides for the hybrid ranker. Every knob is a field of
 * `IntelligenceConfig` — `satisfies` makes a name that is not one a compile
 * error — so this is a projection of that type rather than a second list of
 * names that could drift from it. The numeric defaults live ONLY in the
 * config owner; this module declares none of its own.
 *
 * The names are a RUNTIME value rather than only a type union, so a test can
 * enumerate the ranking surface and sweep it. Two of the knobs that arrived
 * with this merge turned out to change nothing at all — one gated a branch
 * whose arms were identical, the other was recomputed from its sibling on
 * every path that scored anything — and both were published to operators,
 * validated, and forwarded through four layers before doing nothing. A type
 * union cannot be swept; a list can.
 */
export const HYBRID_SEARCH_KNOBS = [
  "bm25K1",
  "bm25B",
  "hybridBm25Weight",
  "hybridSpecificBm25WeightFloor",
  "hybridVagueBm25WeightCeiling",
  "searchBiasDirectoryThreshold",
  "searchBiasMinResults",
  "searchSealRatio",
  "searchSealMinScore",
] as const satisfies readonly (keyof IntelligenceConfig)[];

export type HybridSearchConfig = Readonly<Pick<IntelligenceConfig, typeof HYBRID_SEARCH_KNOBS[number]>>;

/** Caller overrides; anything omitted comes from the config owner. */
export type HybridSearchOptions = Partial<HybridSearchConfig>;

/**
 * Tokenize a symbol name or path into searchable terms. Splits camelCase,
 * PascalCase, snake_case, kebab-case, and path separators so that
 * `parseStatement`, `parse_statement`, `parse-statement`, and
 * `parser/parseStatement` all produce the same core tokens. This implements
 * multi-language name-form coverage (EXP402) at the search layer.
 */
export function tokenizeSymbolName(name: string): readonly string[] {
  if (name.length === 0) return deepFreeze([]);
  // Split on path separators, then camelCase/PascalCase boundaries, then
  // snake/kebab boundaries. Keep digits attached to the preceding alpha run.
  const split = name
    .replace(/[\\/]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .toLowerCase();
  const tokens: string[] = [];
  const re = /[a-z0-9]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(split)) !== null) {
    if (m[0].length > 0) tokens.push(m[0]);
  }
  return deepFreeze(tokens);
}

/**
 * Classify a query as "specific" (rare/multi-token/exact-ish) or "vague"
 * (single common token or natural-language phrase). Specific queries weight
 * BM25 higher; vague queries weight fuzzy + semantic higher (EXP397).
 */
export function classifyQuerySpecificity(
  query: string,
  options: HybridSearchOptions = {},
): "specific" | "vague" {
  // The options are still RESOLVED rather than ignored: an unknown or
  // out-of-range setting must be refused here exactly as it is on every other
  // entry point, or the one function a caller reaches with a typo is the one
  // that accepts it.
  resolveIntelligenceConfig(options);
  const trimmed = query.trim();
  if (trimmed.length === 0) return "vague";
  const tokens = tokenizeSymbolName(trimmed);
  if (tokens.length === 0) return "vague";
  // Multi-token with camelCase/PascalCase boundaries → specific.
  if (/[A-Z]/.test(trimmed) && tokens.length >= 2) return "specific";
  // Contains path separators or snake/kebab → specific.
  if (/[\\/_.-]/.test(trimmed) && tokens.length >= 2) return "specific";
  // Everything else is vague: a query with no case structure and no separator
  // is a natural-language phrase however many words it has.
  //
  // A `queryPhraseTokenCount` knob used to sit here, gating a branch that
  // returned "vague" ahead of a fallthrough that also returned "vague". It
  // arrived inline in the merged experiment and was promoted to a published,
  // validated, operator-facing setting on the way in — which made an inert
  // line into an inert CONTROL, and that is the worse of the two. Sweeping it
  // from 1 to 99 reclassified no query at all.
  return "vague";
}

export type Bm25Index = Readonly<{
  /**
   * The `mapHash` of the repository map this index was folded from.
   *
   * An index is only meaningful for the map it was built from: its document
   * frequencies and average document length are properties of that corpus,
   * and scoring a different corpus against them silently returns a plausible
   * ranking computed from the wrong statistics. Measured on a 20k-symbol
   * corpus, handing in an index built from a 10-module subset changed the
   * top-3 without any error, which is the worst shape a bug can take: a
   * confident wrong answer.
   *
   * Carrying the identity here lets the scorer REFUSE a mismatch, which is a
   * runtime choke point rather than the doc-comment convention it replaced.
   * It stops one rung short of unrepresentable because making the type carry
   * the map's identity would mean threading a phantom parameter through the
   * web bridge's generic derived-cache, and the cache is shared by every
   * derived value — a cost paid by all of them for one of them.
   */
  readonly mapHash: string;
  /** Total number of documents (symbols). */
  readonly documentCount: number;
  /** Average document length (tokens). */
  readonly averageDocumentLength: number;
  /** document frequency per token: number of documents containing the token. */
  readonly documentFrequencies: ReadonlyMap<string, number>;
  /** Per-document token counts: docId -> (token -> count). */
  readonly documentTokens: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** Per-document length (token count). */
  readonly documentLengths: ReadonlyMap<string, number>;
}>;

/**
 * Build a BM25 index over all symbols in a repository map. The "document"
 * for each symbol is its name tokens plus its module path tokens. Building
 * the index once allows O(query) scoring without re-walking the map.
 */
export function buildBm25Index(map: RepositoryMap): Bm25Index {
  let totalLength = 0;
  let docCount = 0;
  const documentFrequencies = new Map<string, number>();
  const documentTokens = new Map<string, ReadonlyMap<string, number>>();
  const documentLengths = new Map<string, number>();
  for (const module of map.modules) {
    const pathTokens = tokenizeSymbolName(module.path);
    for (const symbol of module.symbols) {
      const docId = `${module.path}:${symbol.name}:${symbol.location.line}`;
      const nameTokens = tokenizeSymbolName(symbol.name);
      const allTokens = [...nameTokens, ...pathTokens];
      const counts = new Map<string, number>();
      for (const token of allTokens) {
        counts.set(token, (counts.get(token) ?? 0) + 1);
      }
      for (const token of counts.keys()) {
        documentFrequencies.set(token, (documentFrequencies.get(token) ?? 0) + 1);
      }
      documentTokens.set(docId, deepFreeze(counts));
      documentLengths.set(docId, allTokens.length);
      totalLength += allTokens.length;
      docCount += 1;
    }
  }
  return deepFreeze({
    mapHash: map.mapHash,
    documentCount: docCount,
    averageDocumentLength: docCount === 0 ? 0 : totalLength / docCount,
    documentFrequencies: deepFreeze(documentFrequencies),
    documentTokens: deepFreeze(documentTokens),
    documentLengths: deepFreeze(documentLengths),
  });
}

/**
 * Score a single document against a query using BM25.
 */
export function bm25ScoreDocument(
  index: Bm25Index,
  docId: string,
  queryTokens: readonly string[],
  // Takes the ALREADY-RESOLVED config, not raw overrides: this runs once per
  // candidate symbol, and re-resolving (validate + freeze ~40 fields) per
  // document turned a linear scan into a measurable hot loop. The resolution
  // happens once per query in `hybridSearchSymbols`.
  config: HybridSearchConfig,
): number {
  const docTokens = index.documentTokens.get(docId);
  if (docTokens === undefined) return 0;
  const docLength = index.documentLengths.get(docId) ?? 0;
  const avgdl = index.averageDocumentLength > 0 ? index.averageDocumentLength : 1;
  const k1 = config.bm25K1;
  const b = config.bm25B;
  let score = 0;
  for (const term of new Set(queryTokens)) {
    const df = index.documentFrequencies.get(term) ?? 0;
    if (df === 0) continue;
    const tf = docTokens.get(term) ?? 0;
    if (tf === 0) continue;
    // IDF (BM25 variant, always positive): log((N - df + 0.5) / (df + 0.5) + 1).
    const idf = Math.log((index.documentCount - df + 0.5) / (df + 0.5) + 1);
    const denom = tf + k1 * (1 - b + b * (docLength / avgdl));
    score += idf * ((tf * (k1 + 1)) / denom);
  }
  return score;
}

/**
 * Hybrid search combining BM25 (specific queries) with fuzzy matching (vague
 * queries), plus optional bias detection and instant-seal early termination.
 *
 * Returns the ranked results and metadata about whether bias was detected
 * and whether the seal fired (early termination).
 */
export type HybridSearchResult = Readonly<{
  results: readonly SymbolSearchResult[];
  biasDetected: boolean;
  sealFired: boolean;
  queryClass: "specific" | "vague";
  bm25Weight: number;
  fuzzyWeight: number;
}>;

export function hybridSearchSymbols(
  map: RepositoryMap,
  query: SymbolSearchQuery,
  options?: HybridSearchOptions,
  /**
   * A BM25 index previously built from THIS map. The index is a pure fold
   * over the map, so a caller that serves many queries per map (the web
   * bridge, which already caches the map and the dependency graph against
   * the same generation stamp) can build it once instead of re-walking every
   * symbol on every query. Omitted, it is built here — correct either way,
   * only slower.
   */
  prebuiltIndex?: Bm25Index,
): HybridSearchResult {
  const config = resolveIntelligenceConfig(options);
  if (query.name === null) {
    // No text query: fall back to the existing filtered search.
    const results = searchSymbols(map, query);
    return deepFreeze({
      results,
      biasDetected: detectSearchBias(results, options),
      sealFired: false,
      queryClass: "vague",
      bm25Weight: config.hybridBm25Weight,
      fuzzyWeight: 1 - config.hybridBm25Weight,
    });
  }
  const queryClass = classifyQuerySpecificity(query.name, options);
  // Weight BM25 higher for specific queries, fuzzy higher for vague.
  const bm25Weight = queryClass === "specific"
    ? Math.max(config.hybridBm25Weight, config.hybridSpecificBm25WeightFloor)
    : Math.min(config.hybridBm25Weight, config.hybridVagueBm25WeightCeiling);
  // Derived, never configured. The two weights are one degree of freedom —
  // the score is a convex combination, so they must sum to 1 — and there used
  // to be a separate `hybridFuzzyWeight` knob beside this line that nothing on
  // the scoring path ever read. It was published to operators and validated
  // and forwarded through four layers; setting it to 0 or to 1 changed no
  // score and no ordering. Worse than useless: an operator who raised the BM25
  // weight and left the fuzzy knob alone got a REPORTED `fuzzyWeight` that
  // disagreed with the one actually applied, so the signal explaining the
  // ranking described a ranking that did not happen.
  const fuzzyWeight = 1 - bm25Weight;

  // A prebuilt index carries the identity of the corpus it was folded from,
  // and a mismatch is refused rather than scored. Silently accepting one
  // produces a ranking computed from another corpus's term statistics —
  // ordered, populated and wrong, with nothing anywhere to say so.
  if (prebuiltIndex !== undefined && prebuiltIndex.mapHash !== map.mapHash) {
    throw new InputError(
      `The search index was built from a different repository map (index ${prebuiltIndex.mapHash}, map ${map.mapHash}). ` +
        "Rebuild the index for this map, or omit it and let the search build its own.",
      "search_index_map_mismatch",
    );
  }
  const index = prebuiltIndex ?? buildBm25Index(map);
  const queryTokens = tokenizeSymbolName(query.name);
  const candidates: SymbolSearchResult[] = [];

  for (const module of map.modules) {
    for (const symbol of module.symbols) {
      // The same hard filters the lexical ranker applies — one shared gate,
      // so the two rankers cannot disagree about what a query matches.
      if (!matchesHardFilters(module, symbol, query)) continue;

      const docId = `${module.path}:${symbol.name}:${symbol.location.line}`;
      const bm25 = bm25ScoreDocument(index, docId, queryTokens, config);
      const fuzzy = fuzzyMatch(symbol.name.toLowerCase(), query.name.toLowerCase());
      // Normalize fuzzy to a 0..1 scale comparable to BM25.
      const fuzzyNorm = fuzzy === null ? 0 : Math.min(fuzzy, 1);
      const combined = bm25Weight * normalizeBm25(bm25) + fuzzyWeight * fuzzyNorm;
      if (combined <= 0 && fuzzy === null) continue;

      const matchedFields: string[] = [];
      if (bm25 > 0) matchedFields.push("bm25");
      if (fuzzy !== null && fuzzy > 0) matchedFields.push("fuzzy");
      if (query.kind !== null) matchedFields.push("kind");
      if (query.directory !== null) matchedFields.push("directory");
      if (query.exported === true && symbol.exported) matchedFields.push("exported");

      candidates.push({
        symbol,
        filePath: module.path,
        score: combined,
        matchedFields: deepFreeze(matchedFields),
      });
    }
  }

  candidates.sort(compareSearchResults);
  // ── Verb-class re-ranking, applied BEFORE the cut ──
  //
  // BM25 scores term overlap and has no notion of synonymy, so when
  // candidates share their subject tokens and differ only in the verb
  // (`getUserRecord` / `deleteUserRecord` / `renderUserRecord` for "fetch
  // user record") it scores them IDENTICALLY and the tie falls to declaration
  // order. Measured on that shape: BM25 alone picks the intended symbol 0 of
  // 5 times; with this re-ranking, 4 of 5. So the two are not two answers to
  // one question — they are lexical evidence and verb-class evidence, and the
  // second decides precisely the cases the first cannot separate.
  //
  // Applied here, at the ranker every caller reaches, rather than at one
  // consumer: the module had no importers at all, which is why the ranking
  // defect it was written to fix was still present in the live path.
  //
  // Before the slice, so a candidate the affinity promotes can enter the
  // top-N rather than only move around inside it.
  const ranked = rankWithActionAffinity(candidates, query.name).slice(0, query.limit);

  // Instant-seal: if top-1 dominates top-2 by sealRatio and clears sealMinScore,
  // report that the seal fired. We still return the full ranked list (the
  // caller may use sealFired to skip further processing), keeping the
  // evidence intact (per retrievalScoreAsTruthAllowed:false we never truncate
  // evidence based on a score alone — we only signal confidence).
  let sealFired = false;
  if (ranked.length >= 1) {
    const top1 = ranked[0]!.score;
    const top2 = ranked.length >= 2 ? ranked[1]!.score : 0;
    if (top1 >= config.searchSealMinScore && top2 > 0 && top1 / top2 >= config.searchSealRatio) {
      sealFired = true;
    } else if (top1 >= config.searchSealMinScore && top2 === 0) {
      sealFired = true;
    }
  }

  return deepFreeze({
    results: deepFreeze(ranked),
    biasDetected: detectSearchBias(ranked, options),
    sealFired,
    queryClass,
    bm25Weight,
    fuzzyWeight,
  });
}

/**
 * Normalize a raw BM25 score to a 0..1 range via 1 - exp(-score). This keeps
 * ordering while bounding the contribution to the hybrid combination.
 */
function normalizeBm25(score: number): number {
  if (score <= 0) return 0;
  return 1 - Math.exp(-score);
}

/**
 * Detect search bias: when too many results concentrate in a single
 * directory, the search may be over-fitted to one module (EXP380).
 * Returns true if the top-directory share exceeds the threshold.
 */
export function detectSearchBias(
  results: readonly SymbolSearchResult[],
  options: HybridSearchOptions = {},
): boolean {
  const config = resolveIntelligenceConfig(options);
  if (results.length < config.searchBiasMinResults) return false;
  const dirCounts = new Map<string, number>();
  for (const result of results) {
    const dir = directoryOf(result.filePath);
    dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
  }
  let maxShare = 0;
  for (const count of dirCounts.values()) {
    const share = count / results.length;
    if (share > maxShare) maxShare = share;
  }
  return maxShare >= config.searchBiasDirectoryThreshold;
}

function directoryOf(filePath: string): string {
  const lastSlash = filePath.replace(/\\/g, "/").lastIndexOf("/");
  return lastSlash === -1 ? "" : filePath.slice(0, lastSlash);
}
