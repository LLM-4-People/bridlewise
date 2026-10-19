/**
 * THE RUN'S ONE STATUS READ — `GET /api/run/:runId/status`.
 *
 * A module of its own for the same reason `run-stream.ts` is: this file is a
 * GET and must never be able to execute anything, and that is a fact about the
 * IMPORT CONE, not about discipline. The control module (`run.ts`) reaches the
 * executor and therefore contains no GET handler at all; this one contains a
 * GET handler and therefore reaches no executor — the verb split and the cone
 * split are the same rule seen from both ends, and the shape guard in
 * tests/prevention/run-executes-once.test.ts holds every module under
 * `server/routes/run*.ts` to it.
 *
 * ── THE QUESTION A RELOADED PAGE CANNOT ANSWER FOR ITSELF ─────────────────
 *
 * A hydrate that rebuilt a conversation can hold an assistant row whose turn
 * started and never ended — the shape every exit that writes no terminal mark
 * leaves (a server death mid-stream records nothing at all; a cancel records
 * only a feed frame). Whether that row is still FILLING (the run is executing
 * in this process, the words are on their way) or final (the run is gone and
 * nothing will ever land) is a fact about the SERVER, and the registry is its
 * one owner: the executor deletes its entry in the same `finally` that
 * publishes the terminal frame, after every final row write, so the registry's
 * "gone" is also a promise that no writer remains. The reader that owns the
 * row half of the question reads the chat's own bounded message page.
 *
 * DELIBERATELY NOT THE FEED. `resolveRunOwner` (cancel/steer/stream) also
 * consults the retained feed, because a reconnect must still find a run that
 * just ended. This read must NOT: a run whose feed is retained has already
 * ended, and answering "executing" for it would send the reader polling a run
 * that will never write again. Registry-only is the honest liveness.
 *
 * OWNERSHIP: a live run resolves from the registry (foreign → 403, exactly
 * like the stream route). A run that is not executing resolves from the record
 * instead — every started run persists a message row carrying its run_id into
 * the caller's chat, so `runBelongsToUser` answers for runs this process never
 * knew (the server-death shape: the process that died took the registry with
 * it, the record survived). A run the caller cannot prove is a hidden absence,
 * same as everywhere else.
 *
 * Routes:
 *   GET /api/run/:runId/status — is the run still executing? → { runId, executing }
 */

import type { Router } from "../router/router.ts";
import { sendJson } from "../router/router.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
import { requireUserContext } from "../auth/user-context.ts";
import { ForbiddenError, NotFoundError } from "../kernel/errors.ts";
import { getActiveRun } from "../run/run-registry.ts";

export function registerRunStatusRoutes(router: Router, db: AsyncDbClient): void {
  router.get("/api/run/:runId/status", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const runId = ctx.params["runId"]!;
    const active = getActiveRun(runId);
    if (active !== undefined) {
      if (active.userId !== user.userId) {
        throw new ForbiddenError(`Run ${runId} belongs to another user`);
      }
      sendJson(ctx.res, { runId, executing: true });
      return;
    }
    if (!(await db.runBelongsToUser(runId, user.userId))) {
      throw new NotFoundError(`Run ${runId} not found`);
    }
    sendJson(ctx.res, { runId, executing: false });
  });
}
