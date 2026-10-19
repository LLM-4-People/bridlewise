/**
 * Shared exposure registrations — `search` module.
 *
 * Owns a small per-process state object that mirrors what a future live
 * search engine would expose. All signals read from this state, all
 * actions mutate it, and all customizations read/set it — through the
 * shared exposure system (`src/shared/exposure/`).
 *
 * Replacing this stub with a real search engine only requires pointing
 * the signal `value` / action `execute` / customization `current|set`
 * callbacks at the engine's state. The exposure surface itself does NOT
 * change.
 */

import {
  registerAction,
  registerCustomization,
  registerExposureModule,
  registerSignal,
  configBoundSet,
  seedFromConfig,
  syncStateFromConfig,
} from "../index.ts";

/**
 * Per-process search state. The tunable knobs (`threshold` … `caseSensitive`)
 * are a LIVE PROJECTION of the `search` config section: each is seeded from
 * `bridlewise.config.json` at module load and its customization `set` writes
 * the config file (through the write gate) and updates this projection, so a
 * settings change is read by the very next query AND survives a restart. The
 * counters (`queryCount`, `cacheHits`, …) are runtime measurements, not config.
 */
/**
 * The search knobs' state-field → config-path map. The single source for both
 * the import-time seed and the registration-time re-sync, so the two cannot
 * drift. `registerSearchExposure` applies it via `syncStateFromConfig`.
 */
const SEARCH_CONFIG_BINDINGS = {
  threshold: "search.threshold",
  maxResults: "search.maxResults",
  fuzzyThreshold: "search.fuzzyThreshold",
  indexFreshnessSeconds: "search.indexFreshnessSeconds",
  queryTimeoutMs: "search.queryTimeoutMs",
  sortBy: "search.sortBy",
  languageFilter: "search.languageFilter",
  caseSensitive: "search.caseSensitive",
} as const;

export const searchState = {
  queryCount: 0,
  resultCount: 0,
  cacheHits: 0,
  cacheMisses: 0,
  totalLatencyMs: 0,
  latencySamples: 0,
  lastLatencyMs: 0,
  indexSize: 0,
  indexVersion: 1,
  reindexCount: 0,
  clearCacheCount: 0,
  threshold: seedFromConfig(SEARCH_CONFIG_BINDINGS.threshold, 0.5) as number,
  maxResults: seedFromConfig(SEARCH_CONFIG_BINDINGS.maxResults, 50) as number,
  fuzzyThreshold: seedFromConfig(SEARCH_CONFIG_BINDINGS.fuzzyThreshold, 0.85) as number,
  indexFreshnessSeconds: seedFromConfig(SEARCH_CONFIG_BINDINGS.indexFreshnessSeconds, 300) as number,
  queryTimeoutMs: seedFromConfig(SEARCH_CONFIG_BINDINGS.queryTimeoutMs, 5000) as number,
  sortBy: seedFromConfig(SEARCH_CONFIG_BINDINGS.sortBy, "relevance") as "relevance" | "recency" | "score",
  languageFilter: seedFromConfig(SEARCH_CONFIG_BINDINGS.languageFilter, "") as string,
  caseSensitive: seedFromConfig(SEARCH_CONFIG_BINDINGS.caseSensitive, false) as boolean,
  /**
   * Epoch-millisecond instant the index was last built. `0` means never
   * built, so the first query builds it; after that `indexFreshnessSeconds`
   * decides when it has gone stale.
   */
  indexBuiltAt: 0,
};

/** One scanned document as stated by the caller: `name:score:language`. */
type SearchCandidate = Readonly<{ name: string; score: number; language: string }>;

/**
 * Parse the caller-stated candidate list. Each entry is `name:score:language`
 * (the language is optional); entries are comma-separated. The scores are
 * STATED, never invented — the stub has no corpus to score against.
 */
function parseCandidates(raw: string): readonly SearchCandidate[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [name = "", score = "0", language = ""] = entry.split(":");
      return { name: name.trim(), score: Number(score), language: language.trim() };
    });
}

/**
 * How close an inexact candidate is to the search term: the fraction of the
 * term the candidate name shares as a leading run. 1 means the whole term is
 * there, 0 means the two do not even start alike. Both strings arrive already
 * case-folded (or not) according to `caseSensitive`.
 */
function termSimilarity(term: string, name: string): number {
  if (term.length === 0) return 1;
  let shared = 0;
  while (shared < term.length && shared < name.length && term[shared] === name[shared]) {
    shared += 1;
  }
  return shared / term.length;
}

/** Register all search signals, actions, and customizations. Idempotent. */
let searchRegistered = false;
export function registerSearchExposure(): void {
  if (searchRegistered) return;
  searchRegistered = true;
  // Re-seed the knob projection from the config file now that the config
  // store is installed (`registerAllExposure` installs it before this runs),
  // so a persisted value wins over the import-time default.
  syncStateFromConfig(searchState, SEARCH_CONFIG_BINDINGS);

  // The CATEGORY this module's settings live under, in the product's own
  // words — declared here, beside the entries it names, so every surface
  // derives the same grouping instead of authoring a namespace→name table.
  registerExposureModule({
    id: "search",
    title: "Code search",
    purpose:
      "How the assistant looks through your code: how many results come back, how exact a match has to be, and how long one search may take.",
  });

  // --- Signals (10) ---
  registerSignal({
    id: "search.queryCount",
    module: "search",
    name: "Query Count",
    description: "Total number of search queries issued.",
    type: "counter",
    unit: "count",
    value: () => searchState.queryCount,
  });
  registerSignal({
    id: "search.resultCount",
    module: "search",
    name: "Result Count",
    description: "Total number of results returned across all queries.",
    type: "counter",
    unit: "count",
    value: () => searchState.resultCount,
  });
  registerSignal({
    id: "search.cacheHitRate",
    module: "search",
    name: "Cache Hit Rate",
    description: "Fraction of queries served from cache (0..1).",
    type: "gauge",
    unit: "ratio",
    value: () => {
      const total = searchState.cacheHits + searchState.cacheMisses;
      return total === 0 ? 0 : searchState.cacheHits / total;
    },
  });
  registerSignal({
    id: "search.avgLatency",
    module: "search",
    name: "Average Latency",
    description: "Mean query latency in milliseconds.",
    type: "timer",
    unit: "ms",
    value: () =>
      searchState.latencySamples === 0
        ? 0
        : searchState.totalLatencyMs / searchState.latencySamples,
  });
  registerSignal({
    id: "search.lastLatency",
    module: "search",
    name: "Last Latency",
    description: "Most recent query latency in milliseconds.",
    type: "timer",
    unit: "ms",
    value: () => searchState.lastLatencyMs,
  });
  registerSignal({
    id: "search.indexSize",
    module: "search",
    name: "Index Size",
    description: "Number of documents in the search index.",
    type: "gauge",
    unit: "count",
    value: () => searchState.indexSize,
  });
  registerSignal({
    id: "search.indexVersion",
    module: "search",
    name: "Index Version",
    description: "Monotonic version of the search index.",
    type: "counter",
    unit: "version",
    value: () => searchState.indexVersion,
  });
  registerSignal({
    id: "search.reindexCount",
    module: "search",
    name: "Reindex Count",
    description: "Number of times the index has been rebuilt.",
    type: "counter",
    unit: "count",
    value: () => searchState.reindexCount,
  });
  registerSignal({
    id: "search.clearCacheCount",
    module: "search",
    name: "Clear Cache Count",
    description: "Number of times the cache has been cleared.",
    type: "counter",
    unit: "count",
    value: () => searchState.clearCacheCount,
  });
  registerSignal({
    id: "search.thresholdActive",
    module: "search",
    name: "Threshold Active",
    description: "Whether the BM25 score threshold filter is currently applied.",
    type: "boolean",
    value: () => searchState.threshold > 0,
  });

  // --- Actions (5) ---
  registerAction({
    id: "search.clearCache",
    module: "search",
    name: "Clear Cache",
    description: "Clear the search cache and reset hit/miss counters.",
    execute: async () => {
      searchState.cacheHits = 0;
      searchState.cacheMisses = 0;
      searchState.clearCacheCount += 1;
      return { cleared: true, clearCount: searchState.clearCacheCount };
    },
  });
  registerAction({
    id: "search.reindex",
    module: "search",
    name: "Reindex",
    description: "Rebuild the search index from the source documents.",
    execute: async () => {
      searchState.indexVersion += 1;
      searchState.reindexCount += 1;
      searchState.indexBuiltAt = Date.now();
      return { reindexed: true, version: searchState.indexVersion };
    },
  });
  registerAction({
    id: "search.resetCounters",
    module: "search",
    name: "Reset Counters",
    description: "Reset all search counters (queries, results, hits, misses).",
    execute: async () => {
      searchState.queryCount = 0;
      searchState.resultCount = 0;
      searchState.cacheHits = 0;
      searchState.cacheMisses = 0;
      searchState.totalLatencyMs = 0;
      searchState.latencySamples = 0;
      searchState.lastLatencyMs = 0;
      return { reset: true };
    },
  });
  registerAction({
    id: "search.query",
    module: "search",
    name: "Query",
    description: "Run a query through the engine's real freshness, filter, match, order and cap path, and record its measured latency.",
    args: {
      text: { type: "string", required: true, description: "Query text" },
      candidates: {
        type: "string",
        required: false,
        description: "Documents to search, as comma-separated `name:score:language` entries",
      },
      results: { type: "number", required: false, description: "Result count, when no candidates are supplied" },
      cached: { type: "boolean", required: false, description: "Whether this query was served from cache" },
      workMs: {
        type: "number",
        required: false,
        description: "Work this query represents in milliseconds, judged against `search.queryTimeout`",
      },
    },
    // Latency is MEASURED, never invented. The hit/miss counters move only
    // when the caller STATES whether the query was cached: a fabricated
    // coin-flip fed `search.cacheHitRate`, a signal an operator reads as a
    // fact about the system. An unknown cache outcome leaves the counters
    // untouched, so the reported rate is computed from real observations only.
    //
    // `workMs` is a STATED cost, kept strictly separate from the measured
    // latency above for the same reason: it is what the configured time limit
    // judges, and it never feeds a latency signal.
    //
    // Every search knob is read HERE, at query time (the numbered steps
    // below), which is what makes each of them `immediate`.
    execute: async (args) => {
      const startedAt = performance.now();
      const text = String(args?.text ?? "");
      searchState.queryCount += 1;

      // 1. FRESHNESS — an index older than its shelf life (or never built) is
      //    rebuilt before it is searched.
      const ageSeconds = searchState.indexBuiltAt === 0
        ? Number.POSITIVE_INFINITY
        : (Date.now() - searchState.indexBuiltAt) / 1000;
      const reindexed = ageSeconds > searchState.indexFreshnessSeconds;
      if (reindexed) {
        searchState.indexVersion += 1;
        searchState.reindexCount += 1;
        searchState.indexBuiltAt = Date.now();
      }

      const cached = args?.cached;
      if (cached === true) searchState.cacheHits += 1;
      else if (cached === false) searchState.cacheMisses += 1;

      const finish = (extra: Record<string, unknown>): Record<string, unknown> => {
        const latency = performance.now() - startedAt;
        searchState.lastLatencyMs = latency;
        searchState.totalLatencyMs += latency;
        searchState.latencySamples += 1;
        return {
          text,
          latencyMs: latency,
          reindexed,
          ...(cached === undefined ? {} : { cached }),
          ...extra,
        };
      };

      // 2. TIME LIMIT — a query whose stated work exceeds the limit is
      //    abandoned; it returns nothing rather than a partial list dressed
      //    up as a complete one.
      const workMs = Math.max(0, Number(args?.workMs ?? 0));
      if (workMs > searchState.queryTimeoutMs) {
        return finish({ timedOut: true, results: 0, names: [], queryTimeoutMs: searchState.queryTimeoutMs });
      }

      const raw = args?.candidates === undefined ? undefined : String(args.candidates);
      if (raw === undefined) {
        const results = Number(args?.results ?? 0);
        searchState.resultCount += results;
        return finish({ timedOut: false, results });
      }

      const scanned = parseCandidates(raw);
      // 3. LANGUAGE — with a filter set, only that language is searched.
      const inLanguage = scanned.filter(
        (candidate) =>
          searchState.languageFilter === "" || candidate.language === searchState.languageFilter,
      );
      // 4. TERM MATCH — `caseSensitive` decides whether capitalisation counts;
      //    a candidate that does not contain the term outright still matches
      //    when it is close enough for `fuzzyThreshold`.
      const term = searchState.caseSensitive ? text : text.toLowerCase();
      const judged = inLanguage.map((candidate) => {
        const name = searchState.caseSensitive ? candidate.name : candidate.name.toLowerCase();
        const exact = term.length === 0 || name.includes(term);
        return {
          ...candidate,
          exact,
          similarity: exact ? 1 : termSimilarity(term, name),
        };
      });
      const matched = judged
        .filter((candidate) => candidate.exact || candidate.similarity >= searchState.fuzzyThreshold)
        // 5. SCORE — the minimum match score drops loose results.
        .filter((candidate) => candidate.score >= searchState.threshold);

      // 6. ORDER — best match first, newest first, or by raw score.
      const ordered = [...matched];
      if (searchState.sortBy === "relevance") {
        ordered.sort(
          (a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score,
        );
      } else if (searchState.sortBy === "score") {
        ordered.sort((a, b) => b.score - a.score);
      } else {
        ordered.reverse();
      }

      // 7. CAP — the search stops after this many results.
      const kept = ordered.slice(0, searchState.maxResults);
      searchState.resultCount += kept.length;
      return finish({
        timedOut: false,
        scanned: scanned.length,
        matched: matched.length,
        results: kept.length,
        names: kept.map((candidate) => candidate.name),
      });
    },
  });
  registerAction({
    id: "search.configureIndex",
    module: "search",
    name: "Configure Index",
    description: "Set the index size (for testing/simulation).",
    args: {
      size: { type: "number", required: true, description: "New index size" },
    },
    execute: async (args) => {
      const size = Number(args?.size ?? 0);
      searchState.indexSize = size;
      searchState.indexBuiltAt = Date.now();
      return { size };
    },
  });

  // --- Customizations (8) ---
  // Effect timing: all eight are read by `search.query` at query time (the
  // numbered steps above) — freshness before the scan, then language, case,
  // approximate-match strictness, minimum score, order and cap. A change
  // therefore lands on the very next query, which is what `immediate`
  // states; each one is proved behaviourally in
  // test/shared/exposure-customization-liveness.test.ts.
  registerCustomization({
    id: "search.threshold",
    module: "search",
    name: "Minimum match score",
    description:
      "Search results scoring below this are dropped (the underlying relevance score is BM25). Higher = fewer, more exact results; lower = more results, including loose matches.",
    type: "number",
    default: 0.5,
    min: 0,
    max: 1,
    unit: "score",
    current: () => searchState.threshold,
    set: configBoundSet("search.threshold", (v) => { searchState.threshold = Number(v); }),
    contract: { effect: "immediate" },
    measuredBy: "search.thresholdActive",
    configPath: "search.threshold",
  });
  registerCustomization({
    id: "search.maxResults",
    module: "search",
    name: "Most results per search",
    description:
      "A search stops after finding this many results. Higher = more complete lists that take longer to produce.",
    type: "number",
    default: 50,
    min: 1,
    max: 1000,
    unit: "results",
    current: () => searchState.maxResults,
    set: configBoundSet("search.maxResults", (v) => { searchState.maxResults = Number(v); }),
    contract: { effect: "immediate" },
    configPath: "search.maxResults",
  });
  registerCustomization({
    id: "search.fuzzyThreshold",
    module: "search",
    name: "Approximate-match strictness",
    description:
      "How close an inexact search term must be to still count as a match. Higher = misspellings and partial words match less often.",
    type: "number",
    default: 0.85,
    min: 0,
    max: 1,
    unit: "score",
    current: () => searchState.fuzzyThreshold,
    set: configBoundSet("search.fuzzyThreshold", (v) => { searchState.fuzzyThreshold = Number(v); }),
    contract: { effect: "immediate" },
    configPath: "search.fuzzyThreshold",
  });
  registerCustomization({
    id: "search.indexFreshness",
    module: "search",
    name: "Search index shelf life",
    description:
      "After this many seconds the search index counts as out of date and is rebuilt. Lower = fresher results, more rebuild work.",
    type: "number",
    default: 300,
    min: 1,
    max: 86400,
    unit: "seconds",
    current: () => searchState.indexFreshnessSeconds,
    set: configBoundSet("search.indexFreshnessSeconds", (v) => { searchState.indexFreshnessSeconds = Number(v); }),
    contract: { effect: "immediate" },
    configPath: "search.indexFreshnessSeconds",
  });
  registerCustomization({
    id: "search.queryTimeout",
    module: "search",
    name: "Time limit per search",
    description:
      "A single search is abandoned after this many milliseconds. Higher = slow searches get more time to finish.",
    type: "number",
    default: 5000,
    min: 100,
    max: 60000,
    unit: "milliseconds",
    current: () => searchState.queryTimeoutMs,
    set: configBoundSet("search.queryTimeoutMs", (v) => { searchState.queryTimeoutMs = Number(v); }),
    contract: { effect: "immediate" },
    configPath: "search.queryTimeoutMs",
  });
  registerCustomization({
    id: "search.sortBy",
    module: "search",
    name: "Result order",
    description:
      "How search results are sorted: best match first (relevance), newest first (recency), or by raw match score.",
    type: "enum",
    default: "relevance",
    enum: ["relevance", "recency", "score"],
    current: () => searchState.sortBy,
    set: configBoundSet("search.sortBy", (v) => { searchState.sortBy = String(v) as typeof searchState.sortBy; }),
    contract: { effect: "immediate" },
    configPath: "search.sortBy",
  });
  registerCustomization({
    id: "search.languageFilter",
    module: "search",
    name: "Only search one language",
    description:
      "A programming-language code to restrict searches to. Leave empty to search every language.",
    type: "string",
    default: "",
    current: () => searchState.languageFilter,
    set: configBoundSet("search.languageFilter", (v) => { searchState.languageFilter = String(v); }),
    contract: { effect: "immediate" },
    configPath: "search.languageFilter",
  });
  registerCustomization({
    id: "search.caseSensitive",
    module: "search",
    name: "Match capital letters exactly",
    description:
      "On: 'Foo' and 'foo' are different search terms. Off: capitalisation is ignored.",
    type: "boolean",
    default: false,
    current: () => searchState.caseSensitive,
    set: configBoundSet("search.caseSensitive", (v) => { searchState.caseSensitive = Boolean(v); }),
    contract: { effect: "immediate" },
    configPath: "search.caseSensitive",
  });
}

/** Reset the per-module registration flag (test-only). */
export function resetSearchRegistration(): void {
  searchRegistered = false;
}
