import { InputError } from "../kernel/errors.ts";
import { reportBestEffortFailure } from "../shared/debug/debug-system.ts";
import { parseJsonExact } from "../kernel/json-integrity.ts";
import { isPlainObject } from "../shared/type-guards.ts";
import { canonicalHash, deepFreeze, generateId, sha256 } from "../kernel/integrity.ts";
import type { EventLedgerStoragePort, TimelineEventRecord } from "../timeline/timeline-types.ts";
import {
  type MemorySearchEngine,
  resolveMemorySearchEngine,
} from "./memory-search.ts";
import {
  createMemorySearchQuery,
  estimateTokens,
  isMemoryTier,
  MEMORY_EVENT_TYPE,
  type MemoryConfig,
  type MemoryEntry,
  type MemorySearchQuery,
  type MemorySearchResult,
  type MemoryTier,
  resolveMemoryConfig,
} from "./memory-types.ts";

/**
 * Memory store: searchable present/short/long-term memory.
 *
 * Three tiers:
 * - present: in-memory Map for the current conversation context.
 * Fast access, not persisted until promoted.
 * - short-term: recent entries persisted to the timeline store as
 * `memory` events. Queryable by keyword, time, agent, topic.
 * - long-term: summarized/compressed facts persisted to the timeline
 * store with tags. Durable decisions and findings.
 *
 * Present entries are promoted to short-term when `promotePresent`
 * is called (typically at turn boundaries). Short-term entries can be
 * promoted to long-term via `promoteToLongTerm` with a summary.
 *
 * The timeline store (`EventLedgerStoragePort`) is the single durable
 * source of truth. On open, short-term and long-term entries are
 * reconstructed by querying the timeline for `memory` events. This
 * makes memory survive process restart and context compaction.
 *
 * Per the root policy invariant `separateLossyHistoriesAllowed: false`,
 * the in-memory present tier is a rebuildable projection of the
 * current working state, never a parallel history.
 */

export type MemoryStoreOptions = Readonly<{
  store: EventLedgerStoragePort;
  config?: Partial<MemoryConfig>;
  searchEngine?: MemorySearchEngine;
  agentId?: string;
  clock?: Clock;
}>;

type Clock = () => string;

const DEFAULT_CLOCK: Clock = () => new Date().toISOString();

export type MemoryStore = Readonly<{
  readonly config: MemoryConfig;
  readonly ledgerId: string;

  add(input: AddMemoryInput): MemoryEntry;
  addPresent(content: string, options?: AddMemoryOptions): MemoryEntry;
  addShortTerm(content: string, options?: AddMemoryOptions): MemoryEntry;
  addLongTerm(content: string, options?: AddMemoryOptions): MemoryEntry;

  promotePresent(): readonly MemoryEntry[];
  promoteToLongTerm(entryId: string, summary: string): MemoryEntry | null;
  demoteToShortTerm(entryId: string): MemoryEntry | null;

  get(id: string): MemoryEntry | null;
  present(): readonly MemoryEntry[];
  shortTerm(): readonly MemoryEntry[];
  longTerm(): readonly MemoryEntry[];
  all(): readonly MemoryEntry[];

  search(query: MemorySearchQuery): readonly MemorySearchResult[];
  searchByText(text: string, limit?: number): readonly MemorySearchResult[];
  searchByAgent(agentId: string, limit?: number): readonly MemorySearchResult[];
  searchByTopic(topic: string, limit?: number): readonly MemorySearchResult[];
  searchByTimeRange(fromTime: string, toTime: string, limit?: number): readonly MemorySearchResult[];
  searchByTags(tags: readonly string[], limit?: number): readonly MemorySearchResult[];
  searchByTier(tier: MemoryTier, limit?: number): readonly MemorySearchResult[];

  count(): number;
  countByTier(tier: MemoryTier): number;
  estimateTotalTokens(): number;
  corruptedEntryCount(): number;

  clearPresent(): void;
  reload(): void;
}>;

export type AddMemoryInput = Readonly<{
  tier: MemoryTier;
  content: string;
  tags?: readonly string[];
  agentId?: string;
  topic?: string;
  turnId?: string;
  runId?: string;
  timestamp?: string;
  metadata?: Readonly<Record<string, string>>;
}>;

export type AddMemoryOptions = Readonly<{
  tags?: readonly string[];
  agentId?: string;
  topic?: string;
  turnId?: string;
  runId?: string;
  timestamp?: string;
  metadata?: Readonly<Record<string, string>>;
}>;

export function createMemoryStore(options: MemoryStoreOptions): MemoryStore {
  const config = resolveMemoryConfig(options.config ?? {});
  // Which engine answers is a CONFIGURED value, resolved through the search
  // module's own resolver. The store names a kind; it never picks an engine,
  // so a store cannot end up on a different engine from the one the operator
  // configured by virtue of which line was edited last.
  const searchEngine = options.searchEngine ?? resolveMemorySearchEngine(config.searchEngine);
  const defaultAgentId = options.agentId ?? "harness";
  const store = options.store;
  const ledgerId = store.ledgerId;
  const clock = options.clock ?? DEFAULT_CLOCK;

  const presentEntries = new Map<string, MemoryEntry>();
  const shortTermEntries = new Map<string, MemoryEntry>();
  const longTermEntries = new Map<string, MemoryEntry>();
  let corruptedEntries = 0;
  let corruptionWarningEmitted = false;

  reload();

  function validateContent(content: string): void {
    if (content.length === 0) {
      throw new InputError("Memory entry content is empty", "memory_content_empty");
    }
    if (content.length > config.contentMaxCharacters) {
      throw new InputError(
        `Memory entry content exceeds ${config.contentMaxCharacters} characters`,
        "memory_content_too_large",
      );
    }
  }

  function validateTags(tags: readonly string[] | undefined): readonly string[] {
    if (tags === undefined) return deepFreeze([]);
    if (tags.length > config.maxTagsPerEntry) {
      throw new InputError(
        `Memory entry has ${tags.length} tags, exceeding limit of ${config.maxTagsPerEntry}`,
        "memory_tags_excessive",
      );
    }
    return deepFreeze([...tags]);
  }

  function validateTopic(topic: string | undefined): string | null {
    if (topic === undefined || topic.length === 0) return null;
    if (topic.length > config.maxTopicCharacters) {
      throw new InputError(
        `Memory entry topic exceeds ${config.maxTopicCharacters} characters`,
        "memory_topic_too_long",
      );
    }
    return topic;
  }

  function persistToTimeline(entry: MemoryEntry): void {
    if (entry.tier === "present") return;
    const eventId = generateId("mem-evt");
    const contentDoc = JSON.stringify({
      id: entry.id,
      tier: entry.tier,
      content: entry.content,
      tags: entry.tags,
      agentId: entry.agentId,
      topic: entry.topic,
      timestamp: entry.timestamp,
      metadata: entry.metadata,
    });
    const contentDigest = sha256(contentDoc);
    const description = `[${entry.tier}]${entry.topic !== null ? ` ${entry.topic}` : ""}: ${entry.content.slice(0, 200)}`;

    const correlation: Record<string, string> = {};
    if (entry.turnId !== null) correlation["turnId"] = entry.turnId;
    if (entry.runId !== null) correlation["runId"] = entry.runId;
    if (entry.agentId !== null) correlation["agentId"] = entry.agentId;

    store.appendEvent({
      eventId,
      ledgerId,
      eventType: MEMORY_EVENT_TYPE,
      actor: { kind: "harness", id: entry.agentId ?? defaultAgentId },
      ...(Object.keys(correlation).length > 0 ? { correlation } : {}),
      description,
      wallTime: entry.timestamp,
      documents: [
        { name: "memory-entry", contentJson: contentDoc, contentDigest },
      ],
    });
  }

  function reconstructFromTimeline(): void {
    const events = store.query({
      eventType: MEMORY_EVENT_TYPE,
      ascending: true,
      limit: 100_000,
    });
    const allReconstructed: MemoryEntry[] = [];
    for (const event of events) {
      const entry = reconstructEntry(event);
      if (entry !== null) {
        allReconstructed.push(entry);
      }
    }
    const supersededIds = new Set<string>();
    for (const entry of allReconstructed) {
      const promotedFrom = entry.metadata["promotedFrom"];
      if (promotedFrom !== undefined) supersededIds.add(promotedFrom);
      const demotedFrom = entry.metadata["demotedFrom"];
      if (demotedFrom !== undefined) supersededIds.add(demotedFrom);
    }
    for (const entry of allReconstructed) {
      if (supersededIds.has(entry.id)) continue;
      if (entry.tier === "short-term") {
        shortTermEntries.set(entry.id, entry);
      } else if (entry.tier === "long-term") {
        longTermEntries.set(entry.id, entry);
      }
    }
    enforceLimits();
  }

  function reconstructEntry(event: TimelineEventRecord): MemoryEntry | null {
    for (const doc of event.documents) {
      if (doc.name !== "memory-entry") continue;
      if (doc.contentJson === null) continue;
      // Not JSON, or JSON that is not an entry object, is corruption. The fixed
      // central report carries no memory content.
      const parsed = parseJsonExact(doc.contentJson);
      if (parsed === undefined || !isPlainObject(parsed.value)) {
        corruptedEntries++;
        if (!corruptionWarningEmitted) {
          corruptionWarningEmitted = true;
          reportBestEffortFailure();
        }
        return null;
      }
      return deserializeEntry(parsed.value, event.eventId);
    }
    return null;
  }

  function deserializeEntry(parsed: Record<string, unknown>, sourceEventId: string): MemoryEntry | null {
    const id = parsed["id"];
    const tier = parsed["tier"];
    const content = parsed["content"];
    if (typeof id !== "string" || typeof content !== "string" || !isMemoryTier(tier)) {
      return null;
    }
    const tags = Array.isArray(parsed["tags"]) ? (parsed["tags"] as unknown[]).filter((t): t is string => typeof t === "string") : [];
    const agentId = parsed["agentId"];
    const topic = parsed["topic"];
    const timestamp = parsed["timestamp"];
    const metadata = parsed["metadata"];
    return deepFreeze({
      id,
      tier,
      content,
      tags: deepFreeze(tags),
      agentId: typeof agentId === "string" ? agentId : null,
      topic: typeof topic === "string" ? topic : null,
      timestamp: typeof timestamp === "string" ? timestamp : "1970-01-01T00:00:00.000Z",
      sourceEventId,
      turnId: null,
      runId: null,
      metadata: metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
        ? deepFreeze(metadata as Record<string, string>)
        : deepFreeze({}),
    });
  }

  function enforceLimits(): void {
    if (shortTermEntries.size > config.shortTermTurnLimit) {
      const sorted = [...shortTermEntries.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      const toRemove = sorted.slice(0, shortTermEntries.size - config.shortTermTurnLimit);
      for (const entry of toRemove) {
        shortTermEntries.delete(entry.id);
      }
    }
    if (longTermEntries.size > config.longTermFactLimit) {
      const sorted = [...longTermEntries.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      const toRemove = sorted.slice(0, longTermEntries.size - config.longTermFactLimit);
      for (const entry of toRemove) {
        longTermEntries.delete(entry.id);
      }
    }
  }

  function addToTier(entry: MemoryEntry): void {
    if (entry.tier === "present") {
      presentEntries.set(entry.id, entry);
    } else if (entry.tier === "short-term") {
      shortTermEntries.set(entry.id, entry);
      enforceLimits();
    } else {
      longTermEntries.set(entry.id, entry);
      enforceLimits();
    }
  }

  function add(input: AddMemoryInput): MemoryEntry {
    validateContent(input.content);
    if (!isMemoryTier(input.tier)) {
      throw new InputError(`Invalid memory tier: ${input.tier}`, "memory_tier_invalid");
    }
    const entry: MemoryEntry = deepFreeze({
      id: generateId("mem"),
      tier: input.tier,
      content: input.content,
      tags: validateTags(input.tags),
      agentId: input.agentId ?? null,
      topic: validateTopic(input.topic),
      timestamp: input.timestamp ?? clock(),
      sourceEventId: null,
      turnId: input.turnId ?? null,
      runId: input.runId ?? null,
      metadata: input.metadata ? deepFreeze({ ...input.metadata }) : deepFreeze({}),
    });
    addToTier(entry);
    persistToTimeline(entry);
    return entry;
  }

  function buildOptions(input: AddMemoryOptions | undefined): {
    tags: readonly string[];
    agentId: string | null;
    topic: string | null;
    turnId: string | null;
    runId: string | null;
    timestamp: string | null;
    metadata: Readonly<Record<string, string>>;
  } {
    if (input === undefined) {
      return { tags: deepFreeze([]), agentId: null, topic: null, turnId: null, runId: null, timestamp: null, metadata: deepFreeze({}) };
    }
    return {
      tags: validateTags(input.tags),
      agentId: input.agentId ?? null,
      topic: validateTopic(input.topic),
      turnId: input.turnId ?? null,
      runId: input.runId ?? null,
      timestamp: input.timestamp ?? null,
      metadata: input.metadata ? deepFreeze({ ...input.metadata }) : deepFreeze({}),
    };
  }

  function addPresent(content: string, options?: AddMemoryOptions): MemoryEntry {
    const opts = buildOptions(options);
    return add({
      tier: "present",
      content,
      ...(opts.tags.length > 0 ? { tags: opts.tags } : {}),
      ...(opts.agentId !== null ? { agentId: opts.agentId } : {}),
      ...(opts.topic !== null ? { topic: opts.topic } : {}),
      ...(opts.turnId !== null ? { turnId: opts.turnId } : {}),
      ...(opts.runId !== null ? { runId: opts.runId } : {}),
      ...(opts.timestamp !== null ? { timestamp: opts.timestamp } : {}),
      ...(Object.keys(opts.metadata).length > 0 ? { metadata: opts.metadata } : {}),
    });
  }

  function addShortTerm(content: string, options?: AddMemoryOptions): MemoryEntry {
    const opts = buildOptions(options);
    return add({
      tier: "short-term",
      content,
      ...(opts.tags.length > 0 ? { tags: opts.tags } : {}),
      ...(opts.agentId !== null ? { agentId: opts.agentId } : {}),
      ...(opts.topic !== null ? { topic: opts.topic } : {}),
      ...(opts.turnId !== null ? { turnId: opts.turnId } : {}),
      ...(opts.runId !== null ? { runId: opts.runId } : {}),
      ...(opts.timestamp !== null ? { timestamp: opts.timestamp } : {}),
      ...(Object.keys(opts.metadata).length > 0 ? { metadata: opts.metadata } : {}),
    });
  }

  function addLongTerm(content: string, options?: AddMemoryOptions): MemoryEntry {
    const opts = buildOptions(options);
    return add({
      tier: "long-term",
      content,
      ...(opts.tags.length > 0 ? { tags: opts.tags } : {}),
      ...(opts.agentId !== null ? { agentId: opts.agentId } : {}),
      ...(opts.topic !== null ? { topic: opts.topic } : {}),
      ...(opts.turnId !== null ? { turnId: opts.turnId } : {}),
      ...(opts.runId !== null ? { runId: opts.runId } : {}),
      ...(opts.timestamp !== null ? { timestamp: opts.timestamp } : {}),
      ...(Object.keys(opts.metadata).length > 0 ? { metadata: opts.metadata } : {}),
    });
  }

  function promotePresent(): readonly MemoryEntry[] {
    const promoted: MemoryEntry[] = [];
    for (const entry of presentEntries.values()) {
      const promotedEntry: MemoryEntry = deepFreeze({
        ...entry,
        tier: "short-term",
      });
      shortTermEntries.set(promotedEntry.id, promotedEntry);
      persistToTimeline(promotedEntry);
      promoted.push(promotedEntry);
    }
    presentEntries.clear();
    enforceLimits();
    return deepFreeze(promoted);
  }

  function promoteToLongTerm(entryId: string, summary: string): MemoryEntry | null {
    const entry = shortTermEntries.get(entryId) ?? presentEntries.get(entryId);
    if (entry === undefined) return null;
    validateContent(summary);
    const longTermEntry: MemoryEntry = deepFreeze({
      id: generateId("mem"),
      tier: "long-term",
      content: summary,
      tags: deepFreeze([...entry.tags, "promoted"]),
      agentId: entry.agentId,
      topic: entry.topic,
      timestamp: clock(),
      sourceEventId: entry.sourceEventId,
      turnId: entry.turnId,
      runId: entry.runId,
      metadata: deepFreeze({ ...entry.metadata, promotedFrom: entry.id }),
    });
    longTermEntries.set(longTermEntry.id, longTermEntry);
    persistToTimeline(longTermEntry);
    if (shortTermEntries.has(entryId)) shortTermEntries.delete(entryId);
    if (presentEntries.has(entryId)) presentEntries.delete(entryId);
    enforceLimits();
    return longTermEntry;
  }

  function demoteToShortTerm(entryId: string): MemoryEntry | null {
    const entry = longTermEntries.get(entryId);
    if (entry === undefined) return null;
    const demoted: MemoryEntry = deepFreeze({
      id: generateId("mem"),
      tier: "short-term",
      content: entry.content,
      tags: entry.tags,
      agentId: entry.agentId,
      topic: entry.topic,
      timestamp: clock(),
      sourceEventId: entry.sourceEventId,
      turnId: entry.turnId,
      runId: entry.runId,
      metadata: deepFreeze({ ...entry.metadata, demotedFrom: entry.id }),
    });
    shortTermEntries.set(demoted.id, demoted);
    persistToTimeline(demoted);
    longTermEntries.delete(entryId);
    enforceLimits();
    return demoted;
  }

  function get(id: string): MemoryEntry | null {
    return presentEntries.get(id) ?? shortTermEntries.get(id) ?? longTermEntries.get(id) ?? null;
  }

  function present(): readonly MemoryEntry[] {
    return deepFreeze([...presentEntries.values()]);
  }

  function shortTerm(): readonly MemoryEntry[] {
    return deepFreeze([...shortTermEntries.values()]);
  }

  function longTerm(): readonly MemoryEntry[] {
    return deepFreeze([...longTermEntries.values()]);
  }

  function all(): readonly MemoryEntry[] {
    return deepFreeze([...presentEntries.values(), ...shortTermEntries.values(), ...longTermEntries.values()]);
  }

  function search(query: MemorySearchQuery): readonly MemorySearchResult[] {
    return searchEngine.search(all(), query);
  }

  function searchByText(text: string, limit?: number): readonly MemorySearchResult[] {
    return search(createMemorySearchQuery({ text, ...(limit !== undefined ? { limit } : {}) }));
  }

  function searchByAgent(agentId: string, limit?: number): readonly MemorySearchResult[] {
    return search(createMemorySearchQuery({ agentId, ...(limit !== undefined ? { limit } : {}) }));
  }

  function searchByTopic(topic: string, limit?: number): readonly MemorySearchResult[] {
    return search(createMemorySearchQuery({ topic, ...(limit !== undefined ? { limit } : {}) }));
  }

  function searchByTimeRange(fromTime: string, toTime: string, limit?: number): readonly MemorySearchResult[] {
    return search(createMemorySearchQuery({ fromTime, toTime, ...(limit !== undefined ? { limit } : {}) }));
  }

  function searchByTags(tags: readonly string[], limit?: number): readonly MemorySearchResult[] {
    return search(createMemorySearchQuery({ tags, ...(limit !== undefined ? { limit } : {}) }));
  }

  function searchByTier(tier: MemoryTier, limit?: number): readonly MemorySearchResult[] {
    return search(createMemorySearchQuery({ tier, ...(limit !== undefined ? { limit } : {}) }));
  }

  function count(): number {
    return presentEntries.size + shortTermEntries.size + longTermEntries.size;
  }

  function countByTier(tier: MemoryTier): number {
    if (tier === "present") return presentEntries.size;
    if (tier === "short-term") return shortTermEntries.size;
    return longTermEntries.size;
  }

  function estimateTotalTokens(): number {
    let total = 0;
    for (const entry of all()) {
      total += estimateTokens(entry.content);
    }
    return total;
  }

  function clearPresent(): void {
    presentEntries.clear();
  }

  function reload(): void {
    presentEntries.clear();
    shortTermEntries.clear();
    longTermEntries.clear();
    reconstructFromTimeline();
  }

  return deepFreeze({
    config,
    ledgerId,
    add,
    addPresent,
    addShortTerm,
    addLongTerm,
    promotePresent,
    promoteToLongTerm,
    demoteToShortTerm,
    get,
    present,
    shortTerm,
    longTerm,
    all,
    search,
    searchByText,
    searchByAgent,
    searchByTopic,
    searchByTimeRange,
    searchByTags,
    searchByTier,
    count,
    countByTier,
    estimateTotalTokens,
    corruptedEntryCount: () => corruptedEntries,
    clearPresent,
    reload,
  });
}

export function computeMemoryEntryHash(entry: MemoryEntry): string {
  return canonicalHash(entry);
}
