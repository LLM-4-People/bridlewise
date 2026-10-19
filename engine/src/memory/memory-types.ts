import { InputError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { memberOf, refuseUnknownKeys } from "../shared/type-guards.ts";
import { schemaId, cryptoDomain } from "../kernel/product-identity.ts";

/**
 * Shared memory and context management types.
 *
 * Implements delivery-map item 5: searchable present/short/long-term memory,
 * exact attempt/result history, automatic retrieval before retry, and
 * progressive context management that starts trimming/retrieving before a
 * critical limit while preserving old evidence.
 *
 * The memory store uses the existing timeline store
 * (`EventLedgerStoragePort`) for durable persistence of short-term and
 * long-term memory. Present memory is in-memory only (current conversation
 * context, fast access) and is promoted to short-term when it ages out of
 * the active window.
 *
 * Memory tiers align with `ROOT_POLICY.automaticMemoryArchitecture.projections`:
 * - present → "rebuildable-current-working-state-view"
 * - short-term → "rebuildable-task-and-session-horizon-view"
 * - long-term → "rebuildable-durable-decision-fact-attempt-finding-and-evidence-view"
 *
 * Per the root policy invariant `separateLossyHistoriesAllowed: false`, the
 * timeline is the single source of truth; in-memory and reconstructed entries
 * are rebuildable projections, never a parallel history.
 */

export const MEMORY_SCHEMA_VERSION = schemaId("memory", 1);
export const MEMORY_DOMAIN = `${cryptoDomain("memory-entry", 1)}\u0000` as const;

export const MEMORY_TIERS = deepFreeze(["present", "short-term", "long-term"] as const);

export const MEMORY_EVENT_TYPE = "memory" as const;

/**
 * How memory search finds candidates. Both kinds answer the same question and
 * are required to return the same answer — they differ only in how much work
 * they do to get there.
 *
 * - `lexical` scores every stored entry on every query. Cost grows with the
 *   store, and it is paid again for each query.
 * - `inverted-index` folds the corpus once into a token → entries map and then
 *   scores only the entries a query's own words can reach. The fold is reused
 *   until the entry set actually changes.
 *
 * Declared here, beside the rest of the memory configuration, so the config
 * document, the schema owner and the store all name the same two values.
 */
export const MEMORY_SEARCH_ENGINE_KINDS = deepFreeze(["lexical", "inverted-index"] as const);

export type MemorySearchEngineKind = typeof MEMORY_SEARCH_ENGINE_KINDS[number];

const isMemorySearchEngineKind = memberOf(MEMORY_SEARCH_ENGINE_KINDS);

/**
 * The default number of results a memory search returns when the caller
 * omits `limit` is `MEMORY_DEFAULT_CONFIG.searchResultLimit` below — the
 * catalog's own entry, with deliberately no standalone constant for it.
 * This file both declares that default and resolves it (the query
 * builder's absent-limit arm and the resolver's catalog are one fact), and
 * a consumer that read a bare default would stop tracking the resolver the
 * moment a caller supplied any override. Callers that want the plain
 * default read `resolveMemoryConfig({}).searchResultLimit` — the config
 * contract's `memory.searchResultLimit` leaf, the web server's
 * search-route fallback, and the settings row's declared default all cite
 * that resolver, so the value exists in one place only. The number is the
 * effective default the search route has always shipped; a
 * declared-but-unconsumed sibling leaf once carried a different number
 * (20) that no code path ever delivered.
 */

/**
 * Module-private: `resolveMemoryConfig` below is the resolver, so it is the
 * only correct reader. A default whose owner also owns the resolver has no
 * other honest consumer — `resolveMemoryConfig()` returns the same values and
 * keeps tracking configuration when a caller supplies some.
 */
const MEMORY_DEFAULT_CONFIG = deepFreeze({
  contextTokenLimit: 32_768,
  trimThreshold: 0.8,
  recentTurnWindow: 10,
  shortTermTurnLimit: 50,
  longTermFactLimit: 1_000,
  searchResultLimit: 100,
  summaryMaxTokens: 512,
  contentMaxCharacters: 1_048_576,
  maxTagsPerEntry: 64,
  maxTopicCharacters: 512,
  searchEngine: "inverted-index",
} as const);

export type MemoryTier = typeof MEMORY_TIERS[number];

export type MemoryEntry = Readonly<{
  id: string;
  tier: MemoryTier;
  content: string;
  tags: readonly string[];
  agentId: string | null;
  topic: string | null;
  timestamp: string;
  sourceEventId: string | null;
  turnId: string | null;
  runId: string | null;
  metadata: Readonly<Record<string, string>>;
}>;

export type MemorySearchQuery = Readonly<{
  text: string | null;
  agentId: string | null;
  topic: string | null;
  tier: MemoryTier | null;
  tags: readonly string[];
  fromTime: string | null;
  toTime: string | null;
  limit: number;
}>;

export type MemorySearchResult = Readonly<{
  entry: MemoryEntry;
  score: number;
  matchedFields: readonly string[];
}>;

// THE ARRAY OWNS THE VOCABULARY. A union written beside its list is one
// vocabulary in two declarations, and the compiler cannot join them: a list
// holding FEWER members is assignable to `readonly T[]`, so a member added to
// the union and forgotten here compiles with zero errors while every consumer
// built from the list answers for the smaller set. `typeof X[number]` leaves
// one declaration, so the omission is unrepresentable rather than discouraged.
export const ATTEMPT_OUTCOMES = deepFreeze([
  "succeeded",
  "failed",
  "inconclusive",
  "blocked",
  "cancelled",
  "superseded",
] as const);

export type AttemptOutcome = typeof ATTEMPT_OUTCOMES[number];

export const ATTEMPT_KINDS = deepFreeze([
  "prompt",
  "tool-call",
  "edit",
  "research",
  "test",
  "build",
  "git",
  "other",
] as const);

export type AttemptKind = typeof ATTEMPT_KINDS[number];

export type AttemptRecord = Readonly<{
  id: string;
  kind: AttemptKind;
  intent: string;
  target: string | null;
  input: string;
  outcome: AttemptOutcome;
  result: string;
  error: string | null;
  agentId: string | null;
  contextFingerprint: string;
  timestamp: string;
  sourceEventId: string | null;
  metadata: Readonly<Record<string, string>>;
}>;

export type AttemptSearchQuery = Readonly<{
  intent: string | null;
  target: string | null;
  kind: AttemptKind | null;
  outcome: AttemptOutcome | null;
  agentId: string | null;
  text: string | null;
  limit: number;
}>;

export type AttemptSearchResult = Readonly<{
  attempt: AttemptRecord;
  score: number;
  matchedFields: readonly string[];
}>;

export type ContextTurn = Readonly<{
  turnId: string;
  role: string;
  content: string;
  tokenEstimate: number;
  timestamp: string;
  pinned: boolean;
  sourceEventId: string | null;
}>;

export type ContextSummary = Readonly<{
  summaryId: string;
  turnIds: readonly string[];
  content: string;
  tokenEstimate: number;
  createdAt: string;
  sourceTurns: number;
}>;

export type ContextState = Readonly<{
  turns: readonly ContextTurn[];
  summaries: readonly ContextSummary[];
  totalTokens: number;
  tokenLimit: number;
  trimThreshold: number;
  trimmed: boolean;
  lastTrimmedTurnId: string | null;
}>;

export type MemoryConfig = Readonly<{
  contextTokenLimit: number;
  trimThreshold: number;
  recentTurnWindow: number;
  shortTermTurnLimit: number;
  longTermFactLimit: number;
  searchResultLimit: number;
  summaryMaxTokens: number;
  contentMaxCharacters: number;
  maxTagsPerEntry: number;
  maxTopicCharacters: number;
  searchEngine: MemorySearchEngineKind;
}>;

// EACH PREDICATE IS DERIVED FROM ITS VOCABULARY AND HOLDS NO SET ANYONE CAN
// REACH. The previous shape — `const TIER_SET = new Set<string>(MEMORY_TIERS)`
// beside a predicate that reads it — is built from the owner and still able to
// disagree with it: `new Set<string>` erases the element type, and a `Set` is
// mutable, so `TIER_SET.delete("long-term")` typechecks, passes every tier
// suite, and silently drops `?tier=long-term` at the boundary. Driven. There is
// now no expression that names the set, so the disagreement cannot be written.
export const isMemoryTier = memberOf(MEMORY_TIERS);
export const isAttemptOutcome = memberOf(ATTEMPT_OUTCOMES);
export const isAttemptKind = memberOf(ATTEMPT_KINDS);

export function resolveMemoryConfig(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  // An override this resolver does not know is REFUSED, not dropped. The
  // merge below reads a fixed key list and so cannot see a name outside it:
  // a misspelling would pass the write gate, be dropped by the reader that
  // forwards known names, and leave the default in place — accepted at every
  // step and applied at none. This is the last layer that can still tell.
  refuseUnknownKeys(overrides, MEMORY_DEFAULT_CONFIG, "memory", "memory_config_unknown_key");
  const config: MemoryConfig = {
    contextTokenLimit: overrides.contextTokenLimit ?? MEMORY_DEFAULT_CONFIG.contextTokenLimit,
    trimThreshold: overrides.trimThreshold ?? MEMORY_DEFAULT_CONFIG.trimThreshold,
    recentTurnWindow: overrides.recentTurnWindow ?? MEMORY_DEFAULT_CONFIG.recentTurnWindow,
    shortTermTurnLimit: overrides.shortTermTurnLimit ?? MEMORY_DEFAULT_CONFIG.shortTermTurnLimit,
    longTermFactLimit: overrides.longTermFactLimit ?? MEMORY_DEFAULT_CONFIG.longTermFactLimit,
    searchResultLimit: overrides.searchResultLimit ?? MEMORY_DEFAULT_CONFIG.searchResultLimit,
    summaryMaxTokens: overrides.summaryMaxTokens ?? MEMORY_DEFAULT_CONFIG.summaryMaxTokens,
    contentMaxCharacters: overrides.contentMaxCharacters ?? MEMORY_DEFAULT_CONFIG.contentMaxCharacters,
    maxTagsPerEntry: overrides.maxTagsPerEntry ?? MEMORY_DEFAULT_CONFIG.maxTagsPerEntry,
    maxTopicCharacters: overrides.maxTopicCharacters ?? MEMORY_DEFAULT_CONFIG.maxTopicCharacters,
    searchEngine: overrides.searchEngine ?? MEMORY_DEFAULT_CONFIG.searchEngine,
  };
  if (config.contextTokenLimit < 1 || !Number.isFinite(config.contextTokenLimit)) {
    throw new InputError("contextTokenLimit must be a positive finite number", "memory_config_invalid");
  }
  if (config.trimThreshold < 0.5 || config.trimThreshold > 0.99 || !Number.isFinite(config.trimThreshold)) {
    throw new InputError("trimThreshold must be between 0.5 and 0.99", "memory_config_invalid");
  }
  if (config.recentTurnWindow < 1 || !Number.isFinite(config.recentTurnWindow)) {
    throw new InputError("recentTurnWindow must be a positive finite number", "memory_config_invalid");
  }
  if (config.shortTermTurnLimit < 1 || !Number.isFinite(config.shortTermTurnLimit)) {
    throw new InputError("shortTermTurnLimit must be a positive finite number", "memory_config_invalid");
  }
  if (config.longTermFactLimit < 1 || !Number.isFinite(config.longTermFactLimit)) {
    throw new InputError("longTermFactLimit must be a positive finite number", "memory_config_invalid");
  }
  if (config.searchResultLimit < 1 || !Number.isFinite(config.searchResultLimit)) {
    throw new InputError("searchResultLimit must be a positive finite number", "memory_config_invalid");
  }
  if (config.summaryMaxTokens < 1 || !Number.isFinite(config.summaryMaxTokens)) {
    throw new InputError("summaryMaxTokens must be a positive finite number", "memory_config_invalid");
  }
  if (config.contentMaxCharacters < 1 || !Number.isFinite(config.contentMaxCharacters)) {
    throw new InputError("contentMaxCharacters must be a positive finite number", "memory_config_invalid");
  }
  if (config.maxTagsPerEntry < 1 || !Number.isFinite(config.maxTagsPerEntry)) {
    throw new InputError("maxTagsPerEntry must be a positive finite number", "memory_config_invalid");
  }
  if (config.maxTopicCharacters < 1 || !Number.isFinite(config.maxTopicCharacters)) {
    throw new InputError("maxTopicCharacters must be a positive finite number", "memory_config_invalid");
  }
  // An engine name this resolver does not know is REFUSED, not quietly
  // replaced by the default. A misspelling that falls through to a default
  // reads as applied everywhere and takes effect nowhere, which is the one
  // failure a configurable can have that nothing downstream can detect.
  if (!isMemorySearchEngineKind(config.searchEngine)) {
    throw new InputError(
      `searchEngine must be one of: ${MEMORY_SEARCH_ENGINE_KINDS.join(", ")}`,
      "memory_config_invalid",
    );
  }
  return deepFreeze(config);
}

const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / TOKEN_ESTIMATE_CHARS_PER_TOKEN);
}

export function createMemorySearchQuery(input: {
  text?: string;
  agentId?: string;
  topic?: string;
  tier?: MemoryTier;
  tags?: readonly string[];
  fromTime?: string;
  toTime?: string;
  limit?: number;
}): MemorySearchQuery {
  const limit = input.limit ?? MEMORY_DEFAULT_CONFIG.searchResultLimit;
  if (limit < 1 || !Number.isFinite(limit)) {
    throw new InputError("search limit must be a positive finite number", "memory_search_query_invalid");
  }
  return deepFreeze({
    text: input.text ?? null,
    agentId: input.agentId ?? null,
    topic: input.topic ?? null,
    tier: input.tier ?? null,
    tags: input.tags ? deepFreeze([...input.tags]) : deepFreeze([]),
    fromTime: input.fromTime ?? null,
    toTime: input.toTime ?? null,
    limit,
  });
}

export function createAttemptSearchQuery(input: {
  intent?: string;
  target?: string;
  kind?: AttemptKind;
  outcome?: AttemptOutcome;
  agentId?: string;
  text?: string;
  limit?: number;
}): AttemptSearchQuery {
  const limit = input.limit ?? MEMORY_DEFAULT_CONFIG.searchResultLimit;
  if (limit < 1 || !Number.isFinite(limit)) {
    throw new InputError("attempt search limit must be a positive finite number", "memory_attempt_query_invalid");
  }
  return deepFreeze({
    intent: input.intent ?? null,
    target: input.target ?? null,
    kind: input.kind ?? null,
    outcome: input.outcome ?? null,
    agentId: input.agentId ?? null,
    text: input.text ?? null,
    limit,
  });
}
