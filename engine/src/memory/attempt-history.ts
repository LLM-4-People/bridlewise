import { InputError } from "../kernel/errors.ts";
import { canonicalJson, canonicalHash, deepFreeze, generateId } from "../kernel/integrity.ts";
import type { MemoryStore } from "./memory-store.ts";
import {
  type MemorySearchEngine,
  computeContextFingerprint,
  resolveMemorySearchEngine,
} from "./memory-search.ts";
import {
  createAttemptSearchQuery,
  isAttemptKind,
  isAttemptOutcome,
  type AttemptKind,
  type AttemptOutcome,
  type AttemptRecord,
  type AttemptSearchQuery,
  type AttemptSearchResult,
} from "./memory-types.ts";

/**
 * Tag stamped on every long-term memory entry that stores an attempt record,
 * so {@link reload} can locate and reconstruct them after a process restart.
 */
const ATTEMPT_TAG = "attempt";

/**
 * Metadata key holding the attempt id. The id is also embedded in the JSON
 * content, but keeping it in metadata lets the memory store's tag/metadata
 * search locate attempts without parsing the content.
 */
const ATTEMPT_ID_METADATA_KEY = "attemptId";

/**
 * Attempt/result history with automatic retrieval before retry.
 *
 * Records every attempt (prompt, tool call, edit, research, test, build,
 * git operation) with its result, outcome, and context fingerprint. When
 * an agent is about to retry something, `retrieveBeforeRetry` searches the
 * history for similar past attempts and returns them with their results.
 *
 * This prevents repeating the same failed approach. Per the canonical
 * requirements (REQ-020): "Persist what was tried, context/tool/result,
 * make it searchable across turns/compaction, and require lookup before
 * retry."
 *
 * Attempt records are persisted through the memory store as long-term
 * memory entries with the "attempt" tag. This ensures they survive
 * context compaction and process restart.
 *
 * Context fingerprints prevent false reuse: changes to relevant source
 * hashes, environment, inputs, dependencies, configuration, permissions,
 * provider/model/tool versions, or test fixtures mark earlier
 * conclusions as potentially stale and trigger revalidation.
 */

export type AttemptHistoryOptions = Readonly<{
  memoryStore: MemoryStore;
  searchEngine?: MemorySearchEngine;
  maxInputCharacters?: number;
  maxResultCharacters?: number;
  maxIntentCharacters?: number;
  maxTargetCharacters?: number;
}>;

export type AttemptHistory = Readonly<{
  record(input: RecordAttemptInput): AttemptRecord;
  retrieveBeforeRetry(input: RetrieveBeforeRetryInput): readonly AttemptSearchResult[];
  search(query: AttemptSearchQuery): readonly AttemptSearchResult[];
  get(id: string): AttemptRecord | null;
  all(): readonly AttemptRecord[];
  count(): number;
  countByOutcome(outcome: AttemptOutcome): number;
  countByKind(kind: AttemptKind): number;
  hasSimilarFailure(input: { intent: string; target?: string }): boolean;
  getRecentFailures(limit?: number): readonly AttemptRecord[];
  getRecentSuccesses(limit?: number): readonly AttemptRecord[];
}>;

export type RecordAttemptInput = Readonly<{
  kind: AttemptKind;
  intent: string;
  target?: string;
  input: string;
  outcome: AttemptOutcome;
  result: string;
  error?: string;
  agentId?: string;
  contextFingerprint?: string;
  timestamp?: string;
  metadata?: Readonly<Record<string, string>>;
}>;

export type RetrieveBeforeRetryInput = Readonly<{
  intent: string;
  target?: string;
  kind?: AttemptKind;
  agentId?: string;
  limit?: number;
}>;

import { DEFAULT_MAX_INPUT_CHARS, DEFAULT_MAX_INTENT_CHARS, DEFAULT_MAX_RESULT_CHARS, DEFAULT_MAX_TARGET_CHARS } from "./memory-config.ts";
import { handleError } from "../shared/debug/debug-system.ts";

export function createAttemptHistory(options: AttemptHistoryOptions): AttemptHistory {
  const memoryStore = options.memoryStore;
  // The attempt history searches the SAME entries as the store it is built
  // on, so it reads the engine choice from that store's resolved config
  // rather than making its own — one configured value, one answer.
  const searchEngine = options.searchEngine ?? resolveMemorySearchEngine(memoryStore.config.searchEngine);
  const maxInputChars = options.maxInputCharacters ?? DEFAULT_MAX_INPUT_CHARS;
  const maxResultChars = options.maxResultCharacters ?? DEFAULT_MAX_RESULT_CHARS;
  const maxIntentChars = options.maxIntentCharacters ?? DEFAULT_MAX_INTENT_CHARS;
  const maxTargetChars = options.maxTargetCharacters ?? DEFAULT_MAX_TARGET_CHARS;

  const attempts = new Map<string, AttemptRecord>();

  // Reconstruct the in-memory index from the durable memory store so the
  // documented contract ("survive context compaction and process restart")
  // holds: a fresh process that reopens the same timeline-backed memory
  // store must be able to retrieve past attempts via search/retrieveBeforeRetry.
  // The memory store itself reconstructs its long-term tier from the timeline
  // on creation (see memory-store.ts reconstructFromTimeline); this mirror
  // step rebuilds the attempt index from those long-term entries.
  reload();

  function reload(): void {
    for (const entry of memoryStore.longTerm()) {
      if (!entry.tags.includes(ATTEMPT_TAG)) continue;
      const attemptId = entry.metadata[ATTEMPT_ID_METADATA_KEY];
      if (attemptId === undefined) continue;
      // Prefer the lossless JSON content when present; skip entries that
      // do not parse as an AttemptRecord (e.g. legacy joined-text content
      // from an older format — those are not reconstructable losslessly
      // and are left for the memory store's own search to surface).
      let parsed: unknown;
      try {
        parsed = JSON.parse(entry.content);
      } catch (e) {handleError(e, { module: "memory-attempt-history", operation: "catch" });
        continue;
      }
      const reconstructed = reconstructAttemptRecord(parsed, entry.sourceEventId);
      if (reconstructed === null) continue;
      // Don't overwrite a newer in-memory record with a stale one.
      if (!attempts.has(reconstructed.id)) {
        attempts.set(reconstructed.id, reconstructed);
      }
    }
  }

  function reconstructAttemptRecord(value: unknown, sourceEventId: string | null): AttemptRecord | null {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const id = record["id"];
    const kind = record["kind"];
    const intent = record["intent"];
    const input = record["input"];
    const outcome = record["outcome"];
    const result = record["result"];
    if (typeof id !== "string" || typeof intent !== "string" || typeof input !== "string" ||
      typeof result !== "string" || !isAttemptKind(kind) || !isAttemptOutcome(outcome)) {
      return null;
    }
    const target = record["target"];
    const error = record["error"];
    const agentId = record["agentId"];
    const contextFingerprint = record["contextFingerprint"];
    const timestamp = record["timestamp"];
    const metadata = record["metadata"];
    return deepFreeze({
      id,
      kind,
      intent,
      target: typeof target === "string" ? target : null,
      input,
      outcome,
      result,
      error: typeof error === "string" ? error : null,
      agentId: typeof agentId === "string" ? agentId : null,
      contextFingerprint: typeof contextFingerprint === "string" ? contextFingerprint : "",
      timestamp: typeof timestamp === "string" ? timestamp : "1970-01-01T00:00:00.000Z",
      sourceEventId,
      metadata: metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
        ? deepFreeze(metadata as Record<string, string>)
        : deepFreeze({}),
    }) as AttemptRecord;
  }

  function validateString(value: string, maxLen: number, field: string): string {
    if (value.length === 0) {
      throw new InputError(`Attempt ${field} is empty`, `attempt_${field}_empty`);
    }
    if (value.length > maxLen) {
      throw new InputError(
        `Attempt ${field} exceeds ${maxLen} characters`,
        `attempt_${field}_too_large`,
      );
    }
    return value;
  }

  function record(input: RecordAttemptInput): AttemptRecord {
    if (!isAttemptKind(input.kind)) {
      throw new InputError(`Invalid attempt kind: ${input.kind}`, "attempt_kind_invalid");
    }
    if (!isAttemptOutcome(input.outcome)) {
      throw new InputError(`Invalid attempt outcome: ${input.outcome}`, "attempt_outcome_invalid");
    }
    const intent = validateString(input.intent, maxIntentChars, "intent");
    const inputText = validateString(input.input, maxInputChars, "input");
    const resultText = validateString(input.result, maxResultChars, "result");
    const target = input.target !== undefined ? validateString(input.target, maxTargetChars, "target") : null;
    const error = input.error ?? null;

    const id = generateId("att");
    const timestamp = input.timestamp ?? new Date().toISOString();
    const fingerprint = input.contextFingerprint ?? computeContextFingerprint({
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      ...(target !== null ? { targetPath: target } : {}),
    });

    const attempt: AttemptRecord = deepFreeze({
      id,
      kind: input.kind,
      intent,
      target,
      input: inputText,
      outcome: input.outcome,
      result: resultText,
      error,
      agentId: input.agentId ?? null,
      contextFingerprint: fingerprint,
      timestamp,
      sourceEventId: null,
      metadata: input.metadata ? deepFreeze({ ...input.metadata }) : deepFreeze({}),
    });

    attempts.set(id, attempt);

    // Store the full attempt record as canonical JSON in the memory entry
    // content so a fresh process can losslessly reconstruct the in-memory
    // index (see reload). The JSON still contains every searchable text
    // field (intent, input, result, error), so lexical search works across
    // both the attempt index and the memory store's own cross-session search.
    const searchableContent = canonicalJson(attempt);
    const tags = deepFreeze([ATTEMPT_TAG, attempt.outcome, attempt.kind]);
    const metadata: Record<string, string> = {
      [ATTEMPT_ID_METADATA_KEY]: attempt.id,
      kind: attempt.kind,
      outcome: attempt.outcome,
      contextFingerprint: attempt.contextFingerprint,
    };
    memoryStore.addLongTerm(searchableContent, {
      tags,
      topic: attempt.intent.slice(0, 200),
      timestamp: attempt.timestamp,
      metadata: deepFreeze(metadata),
      ...(attempt.agentId !== null ? { agentId: attempt.agentId } : {}),
    });

    return attempt;
  }

  function retrieveBeforeRetry(input: RetrieveBeforeRetryInput): readonly AttemptSearchResult[] {
    // The store's own configured search bound (one configured value, one answer).
    const limit = input.limit ?? memoryStore.config.searchResultLimit;
    const query: AttemptSearchQuery = createAttemptSearchQuery({
      intent: input.intent,
      ...(input.target !== undefined ? { target: input.target } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      limit,
    });
    return search(query);
  }

  function search(query: AttemptSearchQuery): readonly AttemptSearchResult[] {
    const allAttempts = [...attempts.values()];
    const filtered = applyAttemptFilters(allAttempts, query);
    const queryText = query.text ?? query.intent;

    if (queryText === null) {
      const results: AttemptSearchResult[] = [];
      for (const attempt of filtered) {
        const matchedFields: string[] = [];
        if (query.intent !== null && attempt.intent.includes(query.intent)) matchedFields.push("intent");
        if (query.target !== null && attempt.target === query.target) matchedFields.push("target");
        if (query.kind !== null && attempt.kind === query.kind) matchedFields.push("kind");
        if (query.outcome !== null && attempt.outcome === query.outcome) matchedFields.push("outcome");
        if (query.agentId !== null && attempt.agentId === query.agentId) matchedFields.push("agent");
        results.push({
          attempt,
          score: matchedFields.length > 0 ? 1 : 0.5,
          matchedFields: deepFreeze(matchedFields.length > 0 ? matchedFields : ["filter-match"]),
        });
      }
      results.sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        return b.attempt.timestamp > a.attempt.timestamp ? 1 : -1;
      });
      return deepFreeze(results.slice(0, query.limit));
    }

    const searchResults = searchEngine.search(
      filtered.map((a) => ({
        id: a.id,
        tier: "long-term" as const,
        content: `${a.intent} ${a.target ?? ""} ${a.input} ${a.result} ${a.error ?? ""}`,
        tags: [],
        agentId: a.agentId,
        topic: null,
        timestamp: a.timestamp,
        sourceEventId: a.sourceEventId,
        turnId: null,
        runId: null,
        metadata: a.metadata,
      })),
      {
        text: queryText,
        agentId: query.agentId,
        topic: null,
        tier: null,
        tags: [],
        fromTime: null,
        toTime: null,
        limit: query.limit,
      },
    );

    const results: AttemptSearchResult[] = [];
    for (const searchResult of searchResults) {
      const attempt = filtered.find((a) => a.id === searchResult.entry.id);
      if (attempt === undefined) continue;
      results.push({
        attempt,
        score: searchResult.score,
        matchedFields: searchResult.matchedFields,
      });
    }
    return deepFreeze(results.slice(0, query.limit));
  }

  function applyAttemptFilters(
    attempts: readonly AttemptRecord[],
    query: AttemptSearchQuery,
): readonly AttemptRecord[] {
    const result: AttemptRecord[] = [];
    for (const attempt of attempts) {
      if (query.kind !== null && attempt.kind !== query.kind) continue;
      if (query.outcome !== null && attempt.outcome !== query.outcome) continue;
      if (query.agentId !== null && attempt.agentId !== query.agentId) continue;
      if (query.target !== null && attempt.target !== query.target) continue;
      if (query.intent !== null && !attempt.intent.includes(query.intent)) continue;
      result.push(attempt);
    }
    return deepFreeze(result);
  }

  function get(id: string): AttemptRecord | null {
    return attempts.get(id) ?? null;
  }

  function all(): readonly AttemptRecord[] {
    return deepFreeze([...attempts.values()]);
  }

  function count(): number {
    return attempts.size;
  }

  function countByOutcome(outcome: AttemptOutcome): number {
    let count = 0;
    for (const attempt of attempts.values()) {
      if (attempt.outcome === outcome) count++;
    }
    return count;
  }

  function countByKind(kind: AttemptKind): number {
    let count = 0;
    for (const attempt of attempts.values()) {
      if (attempt.kind === kind) count++;
    }
    return count;
  }

  function hasSimilarFailure(input: { intent: string; target?: string }): boolean {
    const results = retrieveBeforeRetry({
      intent: input.intent,
      ...(input.target !== undefined ? { target: input.target } : {}),
      limit: 5,
    });
    return results.some((r) => r.attempt.outcome === "failed" && r.score > 0.3);
  }

  /** The newest attempts with one outcome, newest first. */
  function recentWithOutcome(outcome: AttemptOutcome, limit = memoryStore.config.searchResultLimit): readonly AttemptRecord[] {
    const matching = [...attempts.values()]
      .filter((a) => a.outcome === outcome)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return deepFreeze(matching.slice(0, limit));
  }

  return deepFreeze({
    record,
    retrieveBeforeRetry,
    search,
    get,
    all,
    count,
    countByOutcome,
    countByKind,
    hasSimilarFailure,
    getRecentFailures: (limit?: number) => recentWithOutcome("failed", limit),
    getRecentSuccesses: (limit?: number) => recentWithOutcome("succeeded", limit),
  });
}

export function computeAttemptFingerprint(attempt: AttemptRecord): string {
  return canonicalHash({
    kind: attempt.kind,
    intent: attempt.intent,
    target: attempt.target,
    contextFingerprint: attempt.contextFingerprint,
  });
}

export function isStaleContext(
  previousFingerprint: string,
  currentFingerprint: string,
): boolean {
  return previousFingerprint !== currentFingerprint;
}
