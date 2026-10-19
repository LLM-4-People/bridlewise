/**
 * Chat routes — backed by the SQLite projection.
 *
 * The project → many-chats hierarchy:
 * GET /api/projects/:projectId/chats — list chats for a project
 * POST /api/projects/:projectId/chats — create a chat for a project
 * GET /api/chats/:id — get a chat (404 if missing)
 * GET /api/chats/:id/messages — list messages
 * POST /api/chats/:id/messages — append a message
 * GET /api/chats/:id/tool-calls — list tool calls
 * GET /api/chats/:id/metrics — metrics snapshots
 * POST /api/chats/:id/metrics — append a metrics snapshot
 * GET /api/chats/:id/timeline — timeline refs (canonical event refs)
 * POST /api/chats/:id/timeline — append a timeline ref
 * GET /api/chats/:id/history — full history in one payload
 *
 * Two URL patterns for chat creation/listing:
 * - `/api/projects/:projectId/chats` (RESTful nested resource — preferred)
 * - The body may also carry `projectId` for compatibility with the
 * simple `POST /api/chats` form. The nested form is canonical.
 *
 * WITHDRAWING PART OF A CONVERSATION IS NOT HERE. It is one verb with one
 * owner — `run.compose/rewind` → `server/rewind.ts` — which APPENDS a ledger
 * event naming what was withdrawn and leaves every row in place. This module
 * used to carry a second door for the same question, `POST
 * /api/chats/:id/rollback`, and that one DELETED `messages` rows: the same
 * gesture erased the record or preserved it depending on which surface the
 * user happened to find. The history routes above honour the rewind fold,
 * which is the whole of this module's part in it.
 */

import { z } from "zod";

import type { Router } from "../router/router.ts";
import { sendJson, noteCollectionBound } from "../router/router.ts";
import { CHAT_CREATE_SCHEMA } from "../../shared/input-schemas.ts";
import { assertValidBody } from "../router/validate.ts";
import { MAX_PROMPT_LENGTH } from "../../shared/constants.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
import { requireUserContext } from "../auth/user-context.ts";
import { recordRemoval } from "../observability/timeline-bridge.ts";
import { discardedMessageIdsForChat, discardedRunIdsForChat } from "../run/rewind.ts";
import { NotFoundError, BadRequestError } from "../kernel/errors.ts";
import {
  chatToView,
  messageToView,
  toolCallToView,
  metricsSnapshotToView,
  timelineRefToView,
  chatHistoryPageToView,
  chatMessagePageToView,
} from "./views.ts";
import { serverConfig } from "../kernel/config.ts";

// `CHAT_CREATE_SCHEMA` is the single wire-input owner (shared/input-
// schemas.ts); the route imports it for request-body validation. The
// prior local `z.strictObject({...})` copy is removed (a drift class).
// The remaining schemas below are route-local (not client contracts):
//  - `CHAT_CREATE_FLAT_SCHEMA` is the flat compat form (`projectId` in
//    the body) for `POST /api/chats` — a server-internal surface.
//  - `CHAT_RENAME_SCHEMA`/`CHAT_PIN_SCHEMA`/`MESSAGE_CREATE_SCHEMA`/
//    `METRICS_SNAPSHOT_CREATE_SCHEMA`/`TIMELINE_REF_CREATE_SCHEMA` are
//    route-local request shapes not mirrored in the client state (the
//    client sends bare objects via the API helpers).

const CHAT_CREATE_FLAT_SCHEMA = z.strictObject({
  projectId: z.string().min(1),
  title: z.string().min(1).max(256),
  modelId: z.string().min(1).max(256).optional(),
});

const CHAT_RENAME_SCHEMA = z.strictObject({
  title: z.string().min(1).max(256).optional(),
  modelId: z.string().min(1).max(256).nullable().optional(),
}).refine((v) => v.title !== undefined || v.modelId !== undefined, {
  message: "At least one of title or modelId must be provided",
});

const CHAT_PIN_SCHEMA = z.strictObject({
  pinned: z.boolean(),
});

const MESSAGE_CREATE_SCHEMA = z.strictObject({
  role: z.enum(["user", "assistant", "tool", "error"]),
  content: z.string().max(MAX_PROMPT_LENGTH),
  modelEventType: z.string().min(1).optional(),
});

const METRICS_SNAPSHOT_CREATE_SCHEMA = z.strictObject({
  snapshot: z.unknown(),
});

const TIMELINE_REF_CREATE_SCHEMA = z.strictObject({
  eventId: z.string().min(1),
  eventType: z.string().min(1),
  timestamp: z.string().min(1),
  metadata: z.unknown(),
});


// ── Helpers ──

// (No Scattered Helpers): the ad-hoc `notFound(ctx, what)` helper
// that was duplicated here AND in routes/auto-checks.ts is removed. Routes
// THROW `NotFoundError` and the router's centralized error mapping produces
// the 404 `{ error: "not_found", message }` body. One owner for error
// mapping (server/router.ts), not a copy per route.

// Single-Party-Owner: the caller-gated `checkProjectUser` /
// `checkChatUser` helpers (which did `projectBelongsToUser` / `chatBelongsToUser`
// + a separate unscoped `getProject`/`getChat` dance) are GONE. The DB methods
// themselves enforce the userId scoping — `getProject(id, userId)` and
// `getChat(id, userId)` return null when the resource is not owned, so the
// route just calls the scoped getter and maps null → 404. A route that
// forgets `userId` cannot leak another user's data because the method won't
// return it. This is the simplified, owner-enforced pattern.

/**
 * THE PAGE SIZE A CALLER MAY ASK FOR — narrower than the configured bound,
 * never wider.
 *
 * A `?limit=` that could raise the bound is the unbounded read coming back
 * through the query string: the first client that wants "the whole
 * conversation in one request" writes `?limit=999999` and every measurement
 * in DESIGN-PERFORMANCE §5 stops describing the product. A value above the
 * bound is CLAMPED rather than refused, because the caller asked for at
 * least that many and receiving fewer with a cursor saying so is a complete,
 * honest answer.
 *
 * An unparseable or non-positive value falls back to the configured page
 * size — the same answer as not asking, which is what "?limit=abc" means.
 */
function readLimit(query: URLSearchParams): number {
  const raw = query.get("limit");
  if (raw === null) return serverConfig.chatHistoryTailRows;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) return serverConfig.chatHistoryTailRows;
  return Math.min(n, serverConfig.chatHistoryTailRows);
}

// ── Route registration ──

export function registerChatRoutes(router: Router, db: AsyncDbClient): void {
  // ── Project-scoped chat endpoints (RESTful nested) ──
  //
  // Single-Party-Owner: the project ownership gate is `await db.getProject(id,
  // userId)` — null → 404 (existence hidden for non-owned). Then the child
  // methods (`listChats`, `createChat`) are ALSO scoped by userId, so even
  // a route that forgot the project gate would return empty / throw, never
  // another user's data (defense-in-depth at the DB layer).

  router.get("/api/projects/:projectId/chats", async (ctx) => {
    const projectId = ctx.params["projectId"]!;
    const user = await requireUserContext(ctx, db);
    if (await db.getProject(projectId, user.userId) === null) throw new NotFoundError(`Project ${projectId} not found`);
    const rows = await db.listChats(projectId, user.userId);
    sendJson(ctx.res, rows.map(chatToView));
  });

  router.post("/api/projects/:projectId/chats", async (ctx) => {
    const projectId = ctx.params["projectId"]!;
    const user = await requireUserContext(ctx, db);
    if (await db.getProject(projectId, user.userId) === null) throw new NotFoundError(`Project ${projectId} not found`);
    const input = assertValidBody(CHAT_CREATE_SCHEMA, ctx.body, "invalid_chat_input");
    const row = await db.createChat(
      {
        project_id: projectId,
        title: input.title,
        ...(input.modelId !== undefined ? { model_id: input.modelId } : {}),
      },
      user.userId,
    );
    sendJson(ctx.res, chatToView(row), 201);
  });

  // ── Flat chat creation (compat; projectId in body) ──

  router.post("/api/chats", async (ctx) => {
    const input = assertValidBody(CHAT_CREATE_FLAT_SCHEMA, ctx.body, "invalid_chat_input");
    const user = await requireUserContext(ctx, db);
    if (await db.getProject(input.projectId, user.userId) === null) throw new NotFoundError(`Project ${input.projectId} not found`);
    const row = await db.createChat(
      {
        project_id: input.projectId,
        title: input.title,
        ...(input.modelId !== undefined ? { model_id: input.modelId } : {}),
      },
      user.userId,
    );
    sendJson(ctx.res, chatToView(row), 201);
  });

  // ── Flat chat listing (compat; projectId as query string) ──
  // The nested /api/projects/:projectId/chats form is canonical; this
  // flat form is provided for callers that prefer the query-string shape.

  router.get("/api/chats", async (ctx) => {
    const projectId = ctx.query.get("projectId");
    if (projectId === null) {
      throw new BadRequestError("Missing ?projectId query parameter", "missing_query");
    }
    const user = await requireUserContext(ctx, db);
    if (await db.getProject(projectId, user.userId) === null) throw new NotFoundError(`Project ${projectId} not found`);
    const rows = await db.listChats(projectId, user.userId);
    sendJson(ctx.res, rows.map(chatToView));
  });

  // ── Single-chat endpoints ──
  //
  // The chat ownership gate is `await db.getChat(id, userId)` — null → 404. The
  // chat is then in hand for the response (no second query). Child methods
  // (messages, tool-calls, metrics, timeline, history, rollback) are ALSO
  // scoped by userId — the route passes `user.userId` to every call.

  router.get("/api/chats/:id", async (ctx) => {
    const id = ctx.params["id"]!;
    const user = await requireUserContext(ctx, db);
    const row = await db.getChat(id, user.userId);
    if (row === null) throw new NotFoundError(`Chat ${id} not found`);
    sendJson(ctx.res, chatToView(row));
  });

  // ── Chat management (sidebar rework) ──
  // Rename, delete, pin, and duplicate individual chats. All are
  // user-scoped: a user can only manage their own chats.

  router.patch("/api/chats/:id", async (ctx) => {
    const id = ctx.params["id"]!;
    const user = await requireUserContext(ctx, db);
    const existing = await db.getChat(id, user.userId);
    if (existing === null) throw new NotFoundError(`Chat ${id} not found`);
    const input = assertValidBody(CHAT_RENAME_SCHEMA, ctx.body, "invalid_chat_input");
    let row = existing;
    if (input.title !== undefined) {
      row = await db.renameChat(id, input.title, user.userId) ?? row;
    }
    if (input.modelId !== undefined) {
      row = await db.setChatModel(id, input.modelId, user.userId) ?? row;
    }
    sendJson(ctx.res, chatToView(row));
  });

  router.delete("/api/chats/:id", async (ctx) => {
    const id = ctx.params["id"]!;
    const user = await requireUserContext(ctx, db);
    const existed = await db.deleteChat(id, user.userId);
    if (!existed) throw new NotFoundError(`Chat ${id} not found`);
    // Trash, not destroy: `trashed_at` hides the row. The conversation
    // record stays (messages and tool calls with it) so restore can bring
    // it back. Recorded AFTER the hide returns, and only when it actually
    // hid something — a `false` here means there was nothing to hide.
    recordRemoval("chat", { id });
    sendJson(ctx.res, { deleted: true, id });
  });

  router.post("/api/chats/:id/restore", async (ctx) => {
    const id = ctx.params["id"]!;
    const user = await requireUserContext(ctx, db);
    const row = await db.restoreChat(id, user.userId);
    if (row === null) throw new NotFoundError(`Chat ${id} not found`);
    sendJson(ctx.res, chatToView(row));
  });

  router.post("/api/chats/:id/pin", async (ctx) => {
    const id = ctx.params["id"]!;
    const user = await requireUserContext(ctx, db);
    const input = assertValidBody(CHAT_PIN_SCHEMA, ctx.body, "invalid_chat_input");
    const row = await db.setChatPinned(id, input.pinned, user.userId);
    if (row === null) throw new NotFoundError(`Chat ${id} not found`);
    sendJson(ctx.res, chatToView(row));
  });

  router.post("/api/chats/:id/duplicate", async (ctx) => {
    const id = ctx.params["id"]!;
    const user = await requireUserContext(ctx, db);
    const row = await db.duplicateChat(id, user.userId);
    if (row === null) throw new NotFoundError(`Chat ${id} not found`);
    sendJson(ctx.res, chatToView(row), 201);
  });

  /**
   * ── THE FOUR PER-CHAT COLLECTIONS ARE BOUNDED TOO (§4) ──────────────────
   *
   * These four returned every row of their table for a chat. They are served
   * from the SAME tail page the history route uses, so there is one bounded
   * read and one definition of "the newest N", rather than four bounding
   * rules that can drift apart.
   *
   * A bare JSON array has nowhere to carry a cursor, so what each of these
   * can honestly offer is the bound itself, in the `X-Collection-Bound`
   * header — and the paged route beside them for a caller that needs to
   * travel. That is a real narrowing of these four: `/tool-calls` now means
   * "the tool calls of the newest N messages", not "every tool call in the
   * chat". The alternative was to leave a door open that returns 75MB.
   */
  router.get("/api/chats/:id/messages", async (ctx) => {
    const id = ctx.params["id"]!;
    const user = await requireUserContext(ctx, db);
    const page = await db.getChatHistoryPage(id, user.userId, readLimit(ctx.query));
    if (page === null) throw new NotFoundError(`Chat ${id} not found`);
    noteCollectionBound(ctx.res, {
      limit: page.page.limit,
      returned: page.messages.length,
      hasOlder: page.page.hasOlder,
    });
    // ONE fold read for the whole page (see `messageToView`). A withdrawn
    // message is still SERVED — flagged — because a rewind is a recorded
    // event, not an erasure, and a reader that cannot tell "taken back" from
    // "never happened" has been shown a hole.
    const discarded = discardedMessageIdsForChat(id, user.userId);
    sendJson(ctx.res, page.messages.map((m) => messageToView(m, discarded)));
  });

  router.post("/api/chats/:id/messages", async (ctx) => {
    const id = ctx.params["id"]!;
    const user = await requireUserContext(ctx, db);
    if (await db.getChat(id, user.userId) === null) throw new NotFoundError(`Chat ${id} not found`);
    const input = assertValidBody(MESSAGE_CREATE_SCHEMA, ctx.body, "invalid_message_input");
    // The public message-create endpoint does NOT accept a client-supplied
    // run_id: run_id is the authoritative run→user mapping key (allRunIdsForUser
    // / runBelongsToUser resolve ownership from messages.run_id). Accepting a
    // client run_id would let a caller poison their own chat with another
    // user's run id, then read that run's timeline events + agent states
    // (cross-user leak). Only the run route (server-generated run id) sets
    // run_id, via the internal db.createMessage — not this public path.
    const row = await db.createMessage(
      {
        chat_id: id,
        role: input.role,
        content: input.content,
        ...(input.modelEventType !== undefined ? { model_event_type: input.modelEventType } : {}),
      },
      user.userId,
    );
    sendJson(ctx.res, messageToView(row), 201);
  });

  router.get("/api/chats/:id/tool-calls", async (ctx) => {
    const id = ctx.params["id"]!;
    const user = await requireUserContext(ctx, db);
    const page = await db.getChatHistoryPage(id, user.userId, readLimit(ctx.query));
    if (page === null) throw new NotFoundError(`Chat ${id} not found`);
    noteCollectionBound(ctx.res, {
      limit: page.page.limit,
      returned: page.tool_calls.length,
      hasOlder: page.page.hasOlder,
    });
    sendJson(ctx.res, page.tool_calls.map(toolCallToView));
  });

  router.get("/api/chats/:id/metrics", async (ctx) => {
    const id = ctx.params["id"]!;
    const user = await requireUserContext(ctx, db);
    const page = await db.getChatHistoryPage(id, user.userId, readLimit(ctx.query));
    if (page === null) throw new NotFoundError(`Chat ${id} not found`);
    noteCollectionBound(ctx.res, {
      limit: page.page.limit,
      returned: page.metrics_snapshots.length,
      // The snapshot collection has its own tail bound; `hasOlder` here is
      // the MESSAGE page's, which would be a claim about a different table.
      // Whether older snapshots exist is answered by asking for more of
      // them, so this says only what it knows: the bound that was applied.
      hasOlder: page.metrics_snapshots.length >= page.page.limit,
    });
    sendJson(ctx.res, page.metrics_snapshots.map(metricsSnapshotToView));
  });

  router.post("/api/chats/:id/metrics", async (ctx) => {
    const id = ctx.params["id"]!;
    const user = await requireUserContext(ctx, db);
    if (await db.getChat(id, user.userId) === null) throw new NotFoundError(`Chat ${id} not found`);
    const input = assertValidBody(METRICS_SNAPSHOT_CREATE_SCHEMA, ctx.body, "invalid_metrics_input");
    const row = await db.createMetricsSnapshot({ chat_id: id, snapshot: input.snapshot }, user.userId);
    sendJson(ctx.res, metricsSnapshotToView(row), 201);
  });

  router.get("/api/chats/:id/timeline", async (ctx) => {
    const id = ctx.params["id"]!;
    const user = await requireUserContext(ctx, db);
    const page = await db.getChatHistoryPage(id, user.userId, readLimit(ctx.query));
    if (page === null) throw new NotFoundError(`Chat ${id} not found`);
    noteCollectionBound(ctx.res, {
      limit: page.page.limit,
      returned: page.timeline_refs.length,
      hasOlder: page.timeline_refs.length >= page.page.limit,
    });
    sendJson(ctx.res, page.timeline_refs.map(timelineRefToView));
  });

  router.post("/api/chats/:id/timeline", async (ctx) => {
    const id = ctx.params["id"]!;
    const user = await requireUserContext(ctx, db);
    if (await db.getChat(id, user.userId) === null) throw new NotFoundError(`Chat ${id} not found`);
    const input = assertValidBody(TIMELINE_REF_CREATE_SCHEMA, ctx.body, "invalid_timeline_ref_input");
    const row = await db.createTimelineRef(
      {
        chat_id: id,
        event_id: input.eventId,
        event_type: input.eventType,
        timestamp: input.timestamp,
        metadata: input.metadata,
      },
      user.userId,
    );
    sendJson(ctx.res, timelineRefToView(row), 201);
  });

  /**
   * ── THE CONVERSATION AT ITS TAIL (DESIGN-PERFORMANCE §4) ────────────────
   *
   * This route used to return the whole conversation. Measured on the
   * `heavy` fixture's 21,405-message chat: 75.1MB, 7,217ms to headers,
   * 34,665ms to the last byte, against a 30,000ms client timeout. The
   * conversation could not be opened at all — not slowly, at all.
   *
   * It now returns the NEWEST page and a cursor. `?limit=` narrows the page
   * (it may not widen it past the configured bound — a client asking for
   * "everything" is how the unbounded read comes back through the query
   * string). The reader travels backwards through `/history/older`.
   */
  router.get("/api/chats/:id/history", async (ctx) => {
    const id = ctx.params["id"]!;
    const user = await requireUserContext(ctx, db);
    const page = await db.getChatHistoryPage(id, user.userId, readLimit(ctx.query));
    if (page === null) throw new NotFoundError(`Chat ${id} not found`);
    // Both folds, restore-aware: the withdrawn message rows are flagged out
    // of the live view, and the withdrawn runs' timeline refs stop replaying
    // inline with them (views.ts states why the two are one withdrawal).
    sendJson(
      ctx.res,
      chatHistoryPageToView(
        page,
        discardedMessageIdsForChat(id, user.userId),
        discardedRunIdsForChat(id, user.userId),
      ),
    );
  });

  /**
   * ── THE PAGE BEFORE A CURSOR — a DELTA, not a conversation ──────────────
   *
   * A separate route rather than a `?before=` on the one above, because the
   * two answer different questions and therefore have different shapes: a
   * page of older messages knows nothing about the conversation's metrics
   * snapshots or timeline refs, and returning empty arrays for them from a
   * route whose other form fills them would be the surface reading "there
   * are none" (§1 L3).
   */
  router.get("/api/chats/:id/history/older", async (ctx) => {
    const id = ctx.params["id"]!;
    const before = ctx.query.get("before");
    if (before === null || before.length === 0) {
      throw new BadRequestError(
        "Missing ?before cursor — an older page is addressed by the position it precedes",
        "missing_query",
      );
    }
    const user = await requireUserContext(ctx, db);
    const page = await db.getChatMessagePage(id, user.userId, before, readLimit(ctx.query));
    if (page === null) throw new NotFoundError(`Chat ${id} not found`);
    // A REWIND POINT CAN SIT IN A PAGE THAT WAS NEVER LOADED. The fold is
    // over the whole conversation, not over this page, so an older page
    // carries the same withdrawal marks the tail does — the reader scrolling
    // back into a rewound stretch sees it as rewound, not as live history.
    sendJson(ctx.res, chatMessagePageToView(page, discardedMessageIdsForChat(id, user.userId)));
  });
}
