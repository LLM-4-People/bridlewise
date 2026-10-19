/**
 * Timeline route — queries the timeline event ledger.
 *
 * Routes:
 * POST /api/timeline/query — TimelineQueryResult (flat filtered list)
 * GET /api/timeline/events/:eventId — TimelineEventRecord (single event detail)
 *
 * The client renders the timeline itself from the flat query results using
 * the shared `horizontal-timeline-layout.ts` pure layout (the swimlane owner)
 * + `timeline-categories.ts` (the single category owner). A server-side tree
 * endpoint was removed because it had no consumer and duplicated the client's
 * rendering logic; the client-side tree-builder was removed entirely in 
 * (the tree panel was dead).
 *
 * Scoping: the query
 * accepts `chatId` and `projectId` and resolves them to run IDs via the
 * web-slice projection DB, then filters the canonical ledger server-side
 * with `runIds` (`IN (...)`). This is the root-cause fix for "timeline
 * shows events not related to the current chat/project" — previously the
 * route returned the latest N events from the whole ledger and the client
 * filtered only chat scope client-side (project scope showed ALL events
 * from ALL projects).
 *
 * When the runtime bridge is wired, all routes query the real timeline store.
 *
 * Scoping (the trace axis): `traceId` filters the query to one HTTP
 * request's causal chain within the caller's owned runs, across
 * lanes (http, db, provider, run). It is ownership-gated like every other
 * client-supplied scope; see the gate at its use site below.
 */

import { z } from "zod";

import type { Router } from "../router/router.ts";
import { sendJson } from "../router/router.ts";
import { assertValidBody } from "../router/validate.ts";
import { getTimelineQuery } from "../observability/timeline-bridge.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
import type { QueryOptions } from "../kernel/canonical.ts";
import { requireUserContext } from "../auth/user-context.ts";
import { BadRequestError } from "../kernel/errors.ts";
import { resolveTimelineScope } from "../observability/timeline-scope.ts";
import { TIMELINE_QUERY_LIMIT } from "../../shared/constants.ts";

// ── Input validation ──

const TIMELINE_QUERY_SCHEMA = z.strictObject({
  ledgerId: z.string().optional(),
  runId: z.string().optional(),
  runIds: z.array(z.string().min(1)).optional(),
  chatId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  turnId: z.string().optional(),
  agentId: z.string().optional(),
  taskId: z.string().optional(),
  // The causal-chain scope: every event one HTTP request's trace produced.
  // The store's query already filters `trace_id` (indexed by
  // idx_event_log_ledger_trace_seq), so the field passes straight through
  // like the other correlation keys.
  traceId: z.string().min(1).optional(),
  eventType: z.string().min(1).optional(),
  recordKind: z.string().min(1).optional(),
  effectId: z.string().optional(),
  fromSequence: z.string().optional(),
  toSequence: z.string().optional(),
  fromWallTime: z.string().optional(),
  toWallTime: z.string().optional(),
  limit: z.number().int().positive().max(10_000).optional(),
  offset: z.number().int().nonnegative().optional(),
  ascending: z.boolean().optional(),
  // Keyset cursor — the `nextCursor` from the previous page. A ledger
  // sequence: a canonical non-negative decimal with no leading zeros, matching
  // the ledger's own DECIMAL_SEQUENCE_PATTERN so a malformed cursor is
  // rejected at the trust boundary rather than deeper in the store.
  cursor: z.string().regex(/^(?:0|[1-9][0-9]*)$/u).optional(),
});

// ── Route registration ──

export function registerTimelineRoutes(router: Router, db: AsyncDbClient): void {
  // Flat query — returns a paginated, filtered list of events.
  router.post("/api/timeline/query", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const filter = assertValidBody(
      TIMELINE_QUERY_SCHEMA,
      ctx.body,
      "invalid_timeline_query",
    );
    const scope = await resolveTimelineScope(db, user, filter);
    // Apply authorization to rows and totals before pagination. Remove the
    // singular field after its union so storage cannot intersect it again.
    const { ledgerId: _l, runId: _r, chatId: _c, projectId: _p, runIds: _rs, ...rest } = filter;
    void _l; void _r; void _c; void _p; void _rs;
    const options: QueryOptions = { ...rest as unknown as QueryOptions, ...scope };
    // THE UNSCOPED DEFAULT PAGE IS THE PRODUCT'S PAGE. Every real caller
    // asks for `TIMELINE_QUERY_LIMIT` rows (the one shared owner the client
    // reads); a caller that names no limit is not asking for the store's
    // 1,000-row engine default — it is a miscoded or exploratory client,
    // and handing it a ~1 MB page is a hazard, not a service. The bound is
    // applied HERE, at the web route's own contract (the store keeps its
    // default for its other callers), so one forgotten `limit` cannot turn
    // this route into a bulk dump — the same deny-by-default posture the
    // scope gates above hold.
    const bounded: QueryOptions = options.limit === undefined
      ? { ...options, limit: TIMELINE_QUERY_LIMIT }
      : options;
    // THE FLAT LANE SERVES ROWS. `eventSummaries` is the list read whose
    // contract this route IS: every consumer of the flat page (the client's
    // timeline lane, its sweep, its ancestry walks) renders summary fields
    // and none reads documents or edges — those are the detail door's
    // (`GET /api/timeline/events/:eventId`), which serves the full record
    // per event. A page of attachments was the bulk of this route's cost
    // (the two batched attachment SELECTs, the nested objects, and every
    // attachment string walked by the egress redaction pass) while carrying
    // bytes no consumer reads.
    const result = getTimelineQuery().eventSummaries(bounded);
    sendJson(ctx.res, result);
  });

  // Single event detail — returns the full TimelineEventRecord for one
  // event id. Used by the tree detail panel when lazy-loading event
  // details (e.g. documents, edges, payload) that were elided from the
  // tree summary.
  //
  // Event identity never substitutes for per-row run ownership.
  router.get("/api/timeline/events/:eventId", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const eventId = ctx.params["eventId"];
    if (eventId === undefined) {
      throw new BadRequestError("Missing event id", "missing_event_id");
    }
    const event = getTimelineQuery().getEvent(eventId);
    // Deny-by-default: hide existence when the event is absent OR
    // its run does not belong to the caller — User B cannot fetch User A's
    // event detail by guessing/leaking the eventId. Events with a null runId
    // have no user provenance → denied (the secure default). The 404 body
    // keeps the `{ error, eventId }` shape the client + the test depend on.
    if (
      event === undefined ||
      event.runId === null ||
      !(await db.runBelongsToUser(event.runId, user.userId))
    ) {
      sendJson(ctx.res, { error: "not_found", eventId }, 404);
      return;
    }
    sendJson(ctx.res, event);
  });
}
