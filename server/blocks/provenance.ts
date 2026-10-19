/**
 * The causal-ancestry block — "why does this value exist?"
 *
 * Layer 2 of LENS. Given the ledger event a value was produced by, walk
 * `parent_event_id` backwards and return the chain of causes. Because the
 * ledger records causality as DATA (`trace_id`, `parent_event_id`), this is a
 * query, not an inference — which is the only reason it can be trusted.
 *
 * WHAT THIS IS NOT
 *
 * It is not a trace explorer. There is no run-id search, no span waterfall and
 * no list of everything that happened; those exist in a dozen products
 * already. This read answers exactly one question, always entered from a value
 * the user is pointing at, and returns the smallest chain that explains it.
 * The entry point is a pixel, not a run.
 *
 * OWNERSHIP — THE CHOKE POINT THAT ACTUALLY APPLIES
 *
 * `intelligence.ts` gates on `FsGate` because its data is a project PATH. A
 * causal walk touches no filesystem, so `FsGate` would be ceremony that
 * enforces nothing. The real exposure is different and worse: a
 * `parent_event_id` chain can cross runs, so a walk that authorises only the
 * STARTING event will happily hand back another user's ancestors. The gate is
 * therefore `db.runBelongsToUser` applied at EVERY HOP, denying by default
 * when an event has no run to attribute it to — the same rule
 * `GET /api/timeline/events/:eventId` already applies, applied per step
 * instead of once.
 *
 * HONESTY UNDER A MOVING SCHEMA
 *
 * The write path currently drops `trace_id` and `parent_event_id` for
 * effect-sink events (the recorder never reads the ambient context back out).
 * That is being fixed elsewhere. This block does NOT paper over it: an event
 * with neither a parent nor a trace is reported as `unrecorded`, which is
 * mechanically distinct from `complete` (a genuine root). LENS then says
 * "causality was not recorded for this event" instead of drawing a plausible
 * one-node tree that would look like an answer.
 */

import { z } from "zod";

import {
  ANCESTRY_MAX_DEPTH,
  buildAncestryChain,
  summarizeCausality,
  withWithheld,
  type AncestryChain,
  type AncestryHop,
  type CausalityCoverage,
} from "../../shared/provenance.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
import type { RouteContext } from "../router/router.ts";
import { getTimelineQuery } from "../observability/timeline-bridge.ts";
import { requireUserContext } from "../auth/user-context.ts";
import { defineBlock, type BlockHandlerContext } from "./define.ts";

/**
 * How many recent events the recorder-coverage sample looks at.
 *
 * Big enough that a handful of freshly-written root events cannot dominate
 * the ratio, small enough to stay a single indexed page read.
 */
const RECORDER_SAMPLE_LIMIT = 200;

const RecorderScope = z.object({
  limit: z.coerce.number().int().positive().max(RECORDER_SAMPLE_LIMIT).optional(),
});

/**
 * The two ways in, deliberately exclusive.
 *
 * `eventId` is the direct entry: the caller already has a ledger row.
 * `traceId` is the entry LENS actually uses, because `traceId` is what the
 * block envelope truthfully carries — `eventId` is permanently absent there
 * (see `BlockMeta.eventId` for why that was decided rather than deferred).
 *
 * Exactly one is required. Accepting both would raise the question of which
 * wins, and any answer to that question is a silent policy the caller cannot
 * see. Accepting neither would be a query for "all causality", which is not
 * a question this block answers.
 */
const AncestryScope = z
  .object({
    eventId: z.string().min(1).optional(),
    traceId: z.string().min(1).optional(),
    /** Optional shallower cap; the hard cap always wins. */
    depth: z.coerce.number().int().positive().max(ANCESTRY_MAX_DEPTH).optional(),
  })
  .refine(
    (v) => (v.eventId === undefined) !== (v.traceId === undefined),
    { message: "provide exactly one of eventId or traceId" },
  );

/**
 * The shape a hop is read through.
 *
 * Structural rather than a direct import of `TimelineEventRecord` so the walk
 * can be unit-tested against a fake without constructing a ledger, and so a
 * column that is mid-flight in the real schema surfaces as `null` here rather
 * than as a compile error against a type that has already moved.
 */
export type AncestryEvent = Readonly<{
  eventId: string;
  /**
   * The ledger's total order. Used ONLY to choose a deterministic entry point
   * when a trace is opened — the newest owned event is the one closest to the
   * value the user is pointing at. A string because `sequence` is stored as
   * an integer wider than a JS number.
   */
  sequence: string;
  parentEventId: string | null;
  traceId: string | null;
  eventType: string;
  description: string;
  actorKind: string;
  actorId: string;
  wallTime: string;
  outcome: string | null;
  errorCode: string | null;
  runId: string | null;
}>;

/** The capabilities a walk needs, so all of them can be faked in a test. */
export type AncestryPort = Readonly<{
  getEvent: (eventId: string) => AncestryEvent | undefined;
  /**
   * Every event sharing a trace id. UNFILTERED — a trace can span runs, so
   * what comes back is not necessarily the caller's. `ownsRun` is the only
   * thing that makes it safe to look at, which is why it is a sibling
   * capability on the same port rather than a second gate somewhere else.
   */
  eventsInTrace: (traceId: string) => readonly AncestryEvent[];
  /** Deny-by-default ownership check for one event's run. THE single gate. */
  ownsRun: (runId: string | null) => boolean;
}>;

/** Reduce a ledger row to what an explanation needs. Nothing else travels. */
function toHop(e: AncestryEvent): AncestryHop {
  return Object.freeze({
    eventId: e.eventId,
    ...(e.parentEventId !== null && e.parentEventId.length > 0
      ? { parentEventId: e.parentEventId }
      : {}),
    ...(e.traceId !== null && e.traceId.length > 0 ? { traceId: e.traceId } : {}),
    eventType: e.eventType,
    description: e.description,
    actor: `${e.actorKind}:${e.actorId}`,
    at: e.wallTime,
    ...(e.outcome !== null ? { outcome: e.outcome } : {}),
    ...(e.errorCode !== null && e.errorCode.length > 0 ? { errorCode: e.errorCode } : {}),
  });
}

/**
 * Walk the causal chain backwards from one event.
 *
 * Pure with respect to the port, so every terminating condition — root,
 * unrecorded, denied, truncated, not found, and a cycle — is testable without
 * a database.
 *
 * The `seen` set is not defensive programming: `parent_event_id` is a
 * self-referencing foreign key with no cycle constraint, so a corrupt or
 * hand-written row can point at an ancestor of itself. A cycle terminates the
 * walk as `truncated` — the chain genuinely cannot be completed, and calling
 * it `complete` would assert a root that does not exist.
 */
export function walkAncestry(
  startEventId: string,
  port: AncestryPort,
  maxDepth: number = ANCESTRY_MAX_DEPTH,
): AncestryChain {
  const hops: AncestryHop[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = startEventId;

  while (cursor !== undefined) {
    if (hops.length >= maxDepth) return buildAncestryChain(hops, { hitCap: true });
    if (seen.has(cursor)) return buildAncestryChain(hops, { hitCap: true });
    seen.add(cursor);

    const event = port.getEvent(cursor);
    // An absent FIRST event is "not found"; an absent ANCESTOR is a dangling
    // reference, which is a broken chain, not a completed one. `truncated`
    // says the walk could not reach a root — which is the truth.
    if (event === undefined) {
      return hops.length === 0
        ? buildAncestryChain([])
        : buildAncestryChain(hops, { hitCap: true });
    }
    // The gate, at every hop. An ancestor in another user's run stops the
    // walk and is reported as denied — the ids already collected are the
    // caller's own, so they are kept; the denied id is named so the UI can
    // say "the chain continues where you cannot see" rather than implying the
    // cause was reached.
    if (!port.ownsRun(event.runId)) {
      return buildAncestryChain(hops, { deniedAt: cursor });
    }

    hops.push(toHop(event));
    cursor =
      event.parentEventId !== null && event.parentEventId.length > 0
        ? event.parentEventId
        : undefined;
  }

  return buildAncestryChain(hops);
}

/**
 * The caller's own events within a trace, and how many were withheld.
 *
 * A TRACE IS NOT AN AUTHORISATION BOUNDARY. `byTrace` returns whatever shares
 * the trace id, and a trace can span runs — so a trace-scoped list read is
 * exactly the cross-user leak the per-hop gate was written to prevent, in a
 * shape that looks innocent because no chain is being followed.
 *
 * The gate applied here is `port.ownsRun` — the SAME predicate `walkAncestry`
 * applies at every hop, not a second implementation of it. A parallel
 * ownership check would be two things that must agree forever, and they would
 * drift the first time one is updated.
 *
 * `withheld` is a COUNT and nothing else: no ids, no descriptions, no actors.
 * It exists so the UI can say "part of this trace is not yours" instead of
 * silently presenting a partial answer as a whole one — the same reason
 * `denied` and `truncated` are distinct statuses.
 */
export function ownedTraceEvents(
  events: readonly AncestryEvent[],
  port: AncestryPort,
): Readonly<{ owned: readonly AncestryEvent[]; withheld: number }> {
  const owned = events.filter((e) => port.ownsRun(e.runId));
  return Object.freeze({
    owned: Object.freeze(owned),
    withheld: events.length - owned.length,
  });
}

/**
 * Enter the causal chain from a trace id.
 *
 * This is the entry LENS actually uses, because `traceId` is what the block
 * envelope carries. The trace only supplies a STARTING POINT — the newest
 * event in it that the caller owns, which is the one closest to the value
 * they are pointing at. From there the ordinary `walkAncestry` runs, so the
 * per-hop gate, the cycle guard, the depth cap and every terminating status
 * apply unchanged. Nothing about trace entry is a second walking
 * implementation.
 *
 * `sequence` orders the entry choice rather than `wallTime`: wall clocks can
 * tie or step backwards, and two events with the same timestamp would make
 * the entry point depend on row order. `sequence` is unique per ledger.
 */
export function walkTrace(
  traceId: string,
  port: AncestryPort,
  maxDepth: number = ANCESTRY_MAX_DEPTH,
): AncestryChain {
  const { owned, withheld } = ownedTraceEvents(port.eventsInTrace(traceId), port);

  if (owned.length === 0) {
    // Nothing visible. If events EXIST but none are the caller's, that is a
    // denial, not an absence — and the two must not read alike. `deniedAt`
    // carries the caller's own trace id, never the id of an event they are
    // not allowed to know exists.
    return withheld > 0
      ? withWithheld(buildAncestryChain([], { deniedAt: traceId }), withheld)
      : buildAncestryChain([]);
  }

  let newest = owned[0] as AncestryEvent;
  for (const e of owned) {
    if (BigInt(e.sequence) > BigInt(newest.sequence)) newest = e;
  }
  // The count travels WITH the chain. A trace that is partly another user's
  // must say so even when the caller's own walk succeeds — otherwise a
  // partial answer renders exactly like a whole one, which is the lie the
  // `denied` status exists to prevent on the other path.
  return withWithheld(walkAncestry(newest.eventId, port, maxDepth), withheld);
}

/**
 * Bind the walk to the live ledger and the caller's identity.
 *
 * Exported so the block handler stays one line and the wiring is testable
 * separately from the walking.
 */
export async function ancestryPortFor(
  ctx: RouteContext,
  db: AsyncDbClient,
): Promise<AncestryPort> {
  const user = await requireUserContext(ctx, db);
  const query = getTimelineQuery();
  // The caller's runs, resolved ONCE, so `ownsRun` below stays a synchronous
  // predicate. It has to: the ancestry walk calls it per event and cannot
  // await, and an async predicate here would be the quietest possible
  // security failure — a promise is TRUTHY, so `ownsRun` would return "yes"
  // for every run in the ledger, including other users', while looking
  // exactly like the gate it replaced. `allRunIdsForUser` is the same
  // predicate as `runBelongsToUser` (both are `messages.run_id` scoped to the
  // user's chats), enumerated instead of asked one id at a time.
  const ownedRuns = new Set(await db.allRunIdsForUser(user.userId));
  return Object.freeze({
    getEvent: (eventId: string) => {
      const e = query.getEvent(eventId);
      return e === undefined ? undefined : (e as AncestryEvent);
    },
    // Returned UNFILTERED on purpose. Filtering here would put a second
    // ownership decision inside the port, next to the one below, and the
    // caller could not tell which had been applied. `ownedTraceEvents` is the
    // single place a trace result is narrowed, and it narrows it with
    // `ownsRun`. The cap bounds a pathological trace; a trace longer than the
    // ancestry depth cap cannot be walked further than the cap anyway.
    eventsInTrace: (traceId: string) =>
      query.byTrace(traceId, { limit: ANCESTRY_MAX_DEPTH }).events as readonly AncestryEvent[],
    // Deny-by-default: an event with no run has no user provenance, so it is
    // not shown. This is the established rule for single-event reads and is
    // applied here unchanged.
    ownsRun: (runId: string | null) =>
      runId !== null && runId.length > 0 && ownedRuns.has(runId),
  });
}

/**
 * How complete the RECORDER's causality is, over the caller's own runs.
 *
 * Scoped by `allRunIdsForUser` rather than sampling the ledger globally: the
 * ledger is a single shared table with no user column, so an unscoped "recent
 * events" sample would hand one user a window onto another's activity. A user
 * with no runs gets `sampled: 0`, which the UI states as "nothing recorded
 * yet" — an empty sample is not a coverage failure and must not be reported
 * as one.
 */
export async function recorderCoverage(
  ctx: RouteContext,
  db: AsyncDbClient,
  limit: number,
): Promise<CausalityCoverage> {
  const user = await requireUserContext(ctx, db);
  const runIds = await db.allRunIdsForUser(user.userId);
  if (runIds.length === 0) return summarizeCausality([]);
  // Default order is most-recent-first, which is what "is causality being
  // recorded NOW" needs — an ascending sample would answer about the oldest
  // events in the ledger, i.e. about a recorder that may since have been fixed.
  const result = getTimelineQuery().byRuns(runIds, { limit });
  return summarizeCausality(result.events);
}

/** Register the provenance blocks. */
export function defineProvenanceBlocks(db: AsyncDbClient): void {
  defineBlock({
    id: "lens.recorder",
    title: "Recorder causality coverage",
    description:
      "How many of the caller's most recent ledger events actually carry trace, parent and actor — the server-side half of provenance coverage.",
    read: {
      input: RecorderScope,
      output: z.unknown(),
      ttlMs: 15_000,
      handler: async (input, { ctx }: BlockHandlerContext): Promise<CausalityCoverage> =>
        recorderCoverage(ctx, db, input.limit ?? RECORDER_SAMPLE_LIMIT),
    },
  });

  defineBlock({
    id: "lens.ancestry",
    title: "Causal ancestry",
    description:
      "The chain of recorded causes behind one value, entered by ledger event id or by the trace id the block envelope carries, walked backwards through parent_event_id and gated by run ownership at every hop.",
    read: {
      input: AncestryScope,
      output: z.unknown(),
      // Ledger rows are append-only and immutable once written, so a chain
      // that has been walked cannot change. The TTL is therefore about
      // bounding memory, not about correctness.
      ttlMs: 60_000,
      handler: async (input, { ctx }: BlockHandlerContext): Promise<AncestryChain> => {
        const port = await ancestryPortFor(ctx, db);
        const depth = input.depth ?? ANCESTRY_MAX_DEPTH;
        // The schema guarantees exactly one is present, so there is no
        // precedence rule here to get wrong.
        return input.traceId !== undefined
          ? walkTrace(input.traceId, port, depth)
          : walkAncestry(input.eventId as string, port, depth);
      },
    },
  });
}
