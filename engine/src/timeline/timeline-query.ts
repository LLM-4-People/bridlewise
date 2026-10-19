import { InputError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { DEFAULT_TIMELINE_QUERY_ASCENDING } from "../kernel/config-contracts.ts";
import { DECIMAL_SEQUENCE_PATTERN } from "./ledger-primitives.ts";
import type {
  EventLedgerStoragePort,
  TimelineEdgeRecord,
  TimelineEventRecord,
  TimelineEventSummariesResult,
  TimelineEventType,
  TimelineFileEffectFacts,
  TimelineFileEffectFactsFilter,
  TimelineCheckStatusFacts,
  TimelineCheckStatusFactsFilter,
  TimelineQueryResult,
  TimelineRecordKind,
  TimelineRunActivitySummary,
} from "./timeline-types.ts";

/**
 * Query API for the durable timeline.
 *
 * Provides typed query methods over the `EventLedgerStoragePort` that
 * return relational views suitable for CLI investigation and a future
 * web interface. All queries go through the store's typed port; no raw
 * SQL is exposed.
 *
 * Per REQ-034: "A transport-neutral query service and command-line
 * interface can query/filter and traverse by time, commit, file,
 * feature, task, agent, turn, tool, provider, model, error, and trace,
 * returning stable typed records suitable for a later web interface."
 */

export function createTimelineQuery(store: EventLedgerStoragePort): TimelineQuery {
  return deepFreeze({
    byRun(runId: string, options?: QueryOptions): TimelineQueryResult {
      return exec(store, { ...options, runId });
    },
    byRuns(runIds: readonly string[], options?: QueryOptions): TimelineQueryResult {
      return exec(store, { ...options, runIds: [...runIds] });
    },
    byTurn(runId: string, turnId: string, options?: QueryOptions): TimelineQueryResult {
      return exec(store, { ...options, runId, turnId });
    },
    byAgent(agentId: string, options?: QueryOptions): TimelineQueryResult {
      return exec(store, { ...options, agentId });
    },
    byTask(taskId: string, options?: QueryOptions): TimelineQueryResult {
      return exec(store, { ...options, taskId });
    },
    byEventType(eventType: TimelineEventType, options?: QueryOptions): TimelineQueryResult {
      return exec(store, { ...options, eventType });
    },
    byRecordKind(recordKind: TimelineRecordKind, options?: QueryOptions): TimelineQueryResult {
      return exec(store, { ...options, recordKind });
    },
    byEffectId(effectId: string, options?: QueryOptions): TimelineQueryResult {
      return exec(store, { ...options, effectId });
    },
    byTrace(traceId: string, options?: QueryOptions): TimelineQueryResult {
      return exec(store, { ...options, traceId });
    },
    byTimeRange(fromWallTime: string, toWallTime: string, options?: QueryOptions): TimelineQueryResult {
      return exec(store, { ...options, fromWallTime, toWallTime });
    },
    bySequenceRange(fromSequence: string, toSequence: string, options?: QueryOptions): TimelineQueryResult {
      return exec(store, { ...options, fromSequence, toSequence });
    },
    all(options?: QueryOptions): TimelineQueryResult {
      return exec(store, options);
    },
    /**
     * The flat-lane page: `TimelineEventSummary` rows in the same envelope
     * as `all` — the list read for consumers that render rows (the web's
     * timeline lane, its sweep, its ancestry walks) and never read the
     * attachments. Attachments stay behind `getEvent`, the detail door.
     */
    eventSummaries(options?: QueryOptions): TimelineEventSummariesResult {
      // An absent limit is the STORE's configured default (`timeline.queryDefaultLimit`).
      const limit = options?.limit;
      const offset = options?.offset ?? 0;
      if (limit !== undefined && (limit < 0 || !Number.isFinite(limit))) throw new InputError("Timeline query limit is invalid", "timeline_query_limit_invalid");
      if (offset < 0 || !Number.isFinite(offset)) throw new InputError("Timeline query offset is invalid", "timeline_query_offset_invalid");
      const filter = buildFilter(options);
      if (limit !== undefined) filter.limit = limit;
      filter.offset = offset;
      filter.ascending = options?.ascending ?? DEFAULT_TIMELINE_QUERY_ASCENDING;
      const events = store.querySummaries(filter);
      // The two counts answer the same two questions as `exec` — see the
      // comment there for why `remaining` and `total` stay distinct.
      const remaining = store.count(filter);
      const { cursor: _cursor, ...withoutCursor } = filter;
      void _cursor;
      const total = filter.cursor === undefined ? remaining : store.count(withoutCursor);
      const hasMore = offset + events.length < remaining;
      const last = events.at(-1);
      return deepFreeze({
        events,
        total,
        hasMore,
        nextCursor: hasMore && last !== undefined ? last.sequence : null,
      });
    },
    getEvent(eventId: string): TimelineEventRecord | undefined {
      return store.getEvent(eventId);
    },
    edges(sourceEventId: string): readonly TimelineEdgeRecord[] {
      const event = store.getEvent(sourceEventId);
      return event === undefined ? deepFreeze([]) : event.edges;
    },
    traverse(eventId: string, edgeType?: string): readonly TimelineEventRecord[] {
      const event = store.getEvent(eventId);
      if (event === undefined) return deepFreeze([]);
      const results: TimelineEventRecord[] = [];
      for (const edge of event.edges) {
        if (edgeType !== undefined && edge.edgeType !== edgeType) continue;
        if (edge.targetEventId === null) continue;
        const target = store.getEvent(edge.targetEventId);
        if (target !== undefined) results.push(target);
      }
      return deepFreeze(results);
    },
    timeline(options?: QueryOptions): readonly TimelineEventRecord[] {
      return store.query(buildFilter(options));
    },
    runActivitySummaries(runIds: readonly string[]): readonly TimelineRunActivitySummary[] {
      return store.runActivitySummaries(runIds);
    },
    fileEffectFacts(filter: TimelineFileEffectFactsFilter): TimelineFileEffectFacts {
      return store.fileEffectFacts(filter);
    },
    checkStatusFacts(filter: TimelineCheckStatusFactsFilter): TimelineCheckStatusFacts {
      return store.checkStatusFacts(filter);
    },
    summary(options?: QueryOptions): TimelineSummary {
      const events = store.query(buildFilter(options));
      const counts = new Map<string, number>();
      let first: string | undefined;
      let last: string | undefined;
      for (const e of events) {
        counts.set(e.eventType, (counts.get(e.eventType) ?? 0) + 1);
        if (first === undefined || e.wallTime < first) first = e.wallTime;
        if (last === undefined || e.wallTime > last) last = e.wallTime;
      }
      const byType: Record<string, number> = {};
      for (const [t, c] of counts) byType[t] = c;
      return deepFreeze({ totalEvents: events.length, byType: deepFreeze(byType), firstWallTime: first ?? null, lastWallTime: last ?? null });
    },
  });
}

export type TimelineQuery = Readonly<{
  byRun(runId: string, options?: QueryOptions): TimelineQueryResult;
  byRuns(runIds: readonly string[], options?: QueryOptions): TimelineQueryResult;
  byTurn(runId: string, turnId: string, options?: QueryOptions): TimelineQueryResult;
  byAgent(agentId: string, options?: QueryOptions): TimelineQueryResult;
  byTask(taskId: string, options?: QueryOptions): TimelineQueryResult;
  byEventType(eventType: TimelineEventType, options?: QueryOptions): TimelineQueryResult;
  byRecordKind(recordKind: TimelineRecordKind, options?: QueryOptions): TimelineQueryResult;
  byEffectId(effectId: string, options?: QueryOptions): TimelineQueryResult;
  /**
   * Every event of one causal chain, in ledger order.
   *
   * REQ-034 already names "trace" as a traversal axis; it was the one axis
   * with no method, because the store had no `trace_id` predicate to call.
   * This is the honest entry point into causality: a trace id can be carried
   * out of the recording context to a reader, whereas an event id exists only
   * for something that actually appended an event.
   */
  byTrace(traceId: string, options?: QueryOptions): TimelineQueryResult;
  byTimeRange(fromWallTime: string, toWallTime: string, options?: QueryOptions): TimelineQueryResult;
  bySequenceRange(fromSequence: string, toSequence: string, options?: QueryOptions): TimelineQueryResult;
  all(options?: QueryOptions): TimelineQueryResult;
  /** The flat-lane page — summary rows in the `all` envelope. */
  eventSummaries(options?: QueryOptions): TimelineEventSummariesResult;
  getEvent(eventId: string): TimelineEventRecord | undefined;
  edges(sourceEventId: string): readonly TimelineEdgeRecord[];
  traverse(eventId: string, edgeType?: string): readonly TimelineEventRecord[];
  timeline(options?: QueryOptions): readonly TimelineEventRecord[];
  /**
   * Per-run activity aggregates and decoded file-change records — the
   * exact-join facts behind the synthesis blocks. Thin passthroughs to the
   * store port (the single owner of the SQL and its EXPLAIN-verified plans;
   * see timeline-synthesis-facts.test.ts).
   */
  runActivitySummaries(runIds: readonly string[]): readonly TimelineRunActivitySummary[];
  fileEffectFacts(filter: TimelineFileEffectFactsFilter): TimelineFileEffectFacts;
  checkStatusFacts(filter: TimelineCheckStatusFactsFilter): TimelineCheckStatusFacts;
  summary(options?: QueryOptions): TimelineSummary;
}>;

export type QueryOptions = Readonly<{
  ledgerId?: string;
  eventType?: TimelineEventType;
  recordKind?: TimelineRecordKind;
  runId?: string;
  runIds?: readonly string[];
  turnId?: string;
  agentId?: string;
  taskId?: string;
  effectId?: string;
  /** Causal-chain scope; see `TimelineQuery.byTrace`. */
  traceId?: string;
  fromSequence?: string;
  toSequence?: string;
  fromWallTime?: string;
  toWallTime?: string;
  limit?: number;
  offset?: number;
  ascending?: boolean;
  /** Keyset cursor — the `sequence` of the last event of the previous page. */
  cursor?: string;
}>;

export type TimelineSummary = Readonly<{
  totalEvents: number;
  byType: Readonly<Record<string, number>>;
  firstWallTime: string | null;
  lastWallTime: string | null;
}>;

function exec(store: EventLedgerStoragePort, options: QueryOptions | undefined): TimelineQueryResult {
  // An absent limit is the STORE's configured default (`timeline.queryDefaultLimit`),
  // never a second default here (a2-design H1).
  const limit = options?.limit;
  const offset = options?.offset ?? 0;
  if (limit !== undefined && (limit < 0 || !Number.isFinite(limit))) throw new InputError("Timeline query limit is invalid", "timeline_query_limit_invalid");
  if (offset < 0 || !Number.isFinite(offset)) throw new InputError("Timeline query offset is invalid", "timeline_query_offset_invalid");
  const filter = buildFilter(options);
  if (limit !== undefined) filter.limit = limit;
  filter.offset = offset;
  // The paginated read is newest-first unless the caller says otherwise. See
  // DEFAULT_TIMELINE_QUERY_ASCENDING: a capped page taken from the ascending
  // end of an append-only ledger shows the oldest events and never the recent
  // ones, which is what a timeline is for.
  filter.ascending = options?.ascending ?? DEFAULT_TIMELINE_QUERY_ASCENDING;
  const events = store.query(filter);
  // TWO counts, because they answer different questions and conflating them
  // makes a paginating UI report a shrinking total as the user reads:
  //  - `remaining` applies the cursor, so it is what is still unread from
  //    here and decides `hasMore`;
  //  - `total` drops the cursor, so it is the size of the matching set and
  //    stays the same on every page.
  const remaining = store.count(filter);
  const { cursor: _cursor, ...withoutCursor } = filter;
  void _cursor;
  const total = filter.cursor === undefined ? remaining : store.count(withoutCursor);
  const hasMore = offset + events.length < remaining;
  const last = events.at(-1);
  return deepFreeze({
    events,
    total,
    hasMore,
    nextCursor: hasMore && last !== undefined ? last.sequence : null,
  });
}

function buildFilter(options: QueryOptions | undefined): MutableFilter {
  const filter: MutableFilter = {};
  if (options !== undefined) {
    if (options.ledgerId !== undefined) filter.ledgerId = options.ledgerId;
    if (options.runId !== undefined) filter.runId = options.runId;
    if (options.runIds !== undefined) filter.runIds = options.runIds;
    if (options.turnId !== undefined) filter.turnId = options.turnId;
    if (options.agentId !== undefined) filter.agentId = options.agentId;
    if (options.taskId !== undefined) filter.taskId = options.taskId;
    if (options.eventType !== undefined) filter.eventType = options.eventType;
    if (options.recordKind !== undefined) filter.recordKind = options.recordKind;
    if (options.effectId !== undefined) filter.effectId = options.effectId;
    if (options.traceId !== undefined) filter.traceId = options.traceId;
    if (options.fromSequence !== undefined) filter.fromSequence = options.fromSequence;
    if (options.toSequence !== undefined) filter.toSequence = options.toSequence;
    if (options.fromWallTime !== undefined) filter.fromWallTime = options.fromWallTime;
    if (options.toWallTime !== undefined) filter.toWallTime = options.toWallTime;
    if (options.ascending !== undefined) filter.ascending = options.ascending;
    if (options.cursor !== undefined) {
      // Deny-by-default: a cursor is a ledger sequence, nothing else. A
      // malformed one is a caller error, not a reason to silently return page
      // one — which would loop a paginating client forever.
      if (!DECIMAL_SEQUENCE_PATTERN.test(options.cursor)) {
        throw new InputError("Timeline query cursor is invalid", "timeline_query_cursor_invalid");
      }
      filter.cursor = options.cursor;
    }
  }
  return filter;
}

type MutableFilter = {
  ledgerId?: string;
  runId?: string;
  runIds?: readonly string[];
  turnId?: string;
  agentId?: string;
  taskId?: string;
  eventType?: TimelineEventType;
  recordKind?: TimelineRecordKind;
  effectId?: string;
  traceId?: string;
  fromSequence?: string;
  toSequence?: string;
  fromWallTime?: string;
  toWallTime?: string;
  limit?: number;
  offset?: number;
  ascending?: boolean;
  cursor?: string;
};
