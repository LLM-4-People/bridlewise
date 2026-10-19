/**
 * nanostores shared state: timeline query filter + results + scope.
 *
 * Plain.ts — Node-testable via Vitest. Fed ONLY by client.ts.
 * The filter is backend-query state: components request changes through
 * client.ts (applyTimelineFilter), which calls setFilter + queryTimeline.
 *
 * The scope tracks the current timeline context: per-chat (filtered by
 * that chat's run IDs), per-project (all events, labeled clearly), or one
 * trace (a single request's causal chain, netted by trace id).
 * This fixes the "timeline shows global events" issue — when a chat is
 * selected, only that chat's events are shown.
 *
 * @global-store scope-based, re-scoped on chat switch via scopeTimelineToChat in loadChatHistory (not a snapshot; scopedTimelineEvents filters by the scope's runIds)
 */

import { atom, computed, type ReadableAtom } from "nanostores";

import type {
  TimelineEventSummariesResult,
  TimelineQueryFilter,
} from "../../shared/types";
import { registerReset } from "./store-registry";

/**
 * The web-slice timeline query request. Extends the canonical
 * `TimelineQueryFilter` (the single source of truth for ledger filters)
 * with the web-slice scope fields `chatId` and `projectId`. The route
 * resolves these to run IDs server-side (the authoritative chat↔run
 * mapping lives in the projection DB). This type is the sole client→
 * server contract for `/api/timeline/query` — the scope store carries
 * `chatId`/`projectId` and `applyTimelineFilter` forwards them here.
 */
export type TimelineQueryRequest = TimelineQueryFilter & Readonly<{
  chatId?: string;
  projectId?: string;
}>;

// ── Scope ──

export type TimelineScope = Readonly<{
  kind: "global" | "chat" | "project" | "trace";
  label: string;
  /** Run IDs for this scope. Populated for "chat" (that chat's runs) and
   * "project" (all runs across the project's chats). Empty for "global" and
   * "trace". Sent to the server so the canonical ledger is filtered server-side. */
  readonly runIds: readonly string[];
  /** The chat id for "chat" scope (sent to the server as the scope filter). */
  readonly chatId?: string;
  /** The project id for "project" scope (sent to the server as the scope filter). */
  readonly projectId?: string;
  /** The trace id for "trace" scope — ONE request's causal chain. Sent to
   * the sweep.spectrum block (scope=trace) and used as the client-side net
   * for the streamed window, exactly like runIds is for chat/project. */
  readonly traceId?: string;
}>;

const GLOBAL_SCOPE: TimelineScope = Object.freeze({
  kind: "global",
  label: "All events",
  runIds: [],
});

/**
 * The global scope — the honest ambient default and the way back when a
 * trace filter was set from no context at all. Exported for client.ts (the
 * scope API's owner) so the literal is declared ONCE.
 */
export const GLOBAL_TIMELINE_SCOPE: TimelineScope = GLOBAL_SCOPE;

export const timelineScope = atom<TimelineScope>(GLOBAL_SCOPE);

// ── Stores ──

const EMPTY_FILTER: TimelineQueryRequest = Object.freeze({});

const EMPTY_RESULT: TimelineEventSummariesResult = Object.freeze({
  events: [],
  total: 0,
  hasMore: false,
  // No page has been fetched, so there is no cursor to resume from. `null`
  // is the contract's "last page" value — the honest answer for an empty
  // result, and never a fabricated cursor.
  nextCursor: null,
});

export const timelineFilter = atom<TimelineQueryRequest>(EMPTY_FILTER);
export const timelineResults = atom<TimelineEventSummariesResult>(EMPTY_RESULT);

export const hasNext: ReadableAtom<boolean> = computed(
  timelineResults,
  (r) => r.hasMore,
);

export const timelineEvents: ReadableAtom<readonly TimelineEventSummariesResult["events"][number][]> = computed(
  timelineResults,
  (r) => r.events,
);

export const timelineTotal: ReadableAtom<number> = computed(
  timelineResults,
  (r) => r.total,
);

/**
 * FIX (hardened): events filtered to the current timeline scope.
 * The server now filters by `runIds` server-side (chat and project scope),
 * so this is a client-side safety net — when the scope has runIds, only
 * events whose runId is in the set are shown. The canonical QueryOptions
 * only supports a single runId, so multi-run chat/project scoping is done
 * server-side via `runIds` (`IN (...)`); this client filter guards against
 * any scope leak (e.g. a global fallback query). A TRACE scope nets by
 * traceId the same way — the chain's rows carry the trace id, so rows
 * without it are out (a null traceId is never a member of any trace).
 * This is the store the Timeline tab renders — NOT the raw
 * `timelineEvents` (which would show every event globally).
 */
export const scopedTimelineEvents: ReadableAtom<readonly TimelineEventSummariesResult["events"][number][]> = computed(
  [timelineEvents, timelineScope],
  (events, scope) => {
    if (scope.kind === "trace") {
      const traceId = scope.traceId ?? "";
      return events.filter((e) => e.traceId === traceId);
    }
    if (scope.runIds.length === 0) return events;
    const runIdSet = new Set(scope.runIds);
    return events.filter((e) => e.runId !== null && runIdSet.has(e.runId));
  },
);

/**
 * FIX (hardened): the total count of in-scope events (for the header
 * badge). Reflects the scoped count, not the raw query total. A trace
 * scope counts like a run-scoped one: the raw query total is a different
 * population's, so the count is the netted window's own.
 */
export const scopedTimelineTotal: ReadableAtom<number> = computed(
  [scopedTimelineEvents, timelineScope],
  (events, scope) =>
    scope.runIds.length > 0 || scope.kind === "trace"
      ? events.length
      : timelineResults.get().total,
);

// ── Ingestion (called only by client.ts) ──

export function setFilter(filter: TimelineQueryRequest): void {
  timelineFilter.set(filter);
}

export function ingestResults(result: TimelineEventSummariesResult): void {
  timelineResults.set(result);
}

/**
 * Ingest the NEXT page: keep what is already loaded and add what arrived.
 *
 * The page metadata (`total`, `hasMore`, `nextCursor`) is replaced rather than
 * merged — it describes the tail of the walk, not the accumulated set.
 *
 * Events are de-duplicated by `eventId`. Keyset paging on a unique sequence
 * cannot itself produce a duplicate, but a page fetched while a refresh is in
 * flight can, and a duplicated event in a timeline is a phantom occurrence of
 * something that happened once.
 */
export function appendResults(page: TimelineEventSummariesResult): void {
  const current = timelineResults.get();
  const seen = new Set(current.events.map((e) => e.eventId));
  const added = page.events.filter((e) => !seen.has(e.eventId));
  timelineResults.set({
    events: added.length === 0 ? current.events : [...current.events, ...added],
    total: page.total,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
  });
}

export function setTimelineScope(scope: TimelineScope): void {
  // Evict the raw cached results at the scope choke point so events from
  // the previous scope do not linger until a new query replaces them. The
  // derived `scopedTimelineEvents` already filters by the new scope's
  // runIds (so the view is correct), but the raw `timelineResults` held
  // the previous scope's events — a stale-cache class of bug. Evicting
  // here (the single setter every scope change goes through) means no
  // caller can forget to clear the raw cache. The next query repopulates
  // it via `ingestResults`.
  timelineResults.set(EMPTY_RESULT);
  // The scope keys in the FILTER belong to the scope, not the filter: a
  // standing chatId/projectId/traceId from the previous scope would ride
  // every later request body until something overwrote it. Stripped here
  // (the same choke point), the next refresh re-derives them from the
  // scope it is actually answering.
  const standing = timelineFilter.get();
  if (standing.chatId !== undefined || standing.projectId !== undefined || standing.traceId !== undefined) {
    const { chatId: _c, projectId: _p, traceId: _t, ...rest } = standing;
    void _c; void _p; void _t;
    timelineFilter.set(rest);
  }
  timelineScope.set(scope);
}

// (The scope→filter builder left with its two component consumers at the
// cutover; client.ts owns the one live limit application.)

export function resetTimeline(): void {
  timelineFilter.set(EMPTY_FILTER);
  timelineResults.set(EMPTY_RESULT);
  timelineScope.set(GLOBAL_SCOPE);
}

registerReset("timeline", resetTimeline);
