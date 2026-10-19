/**
 * THE RUN STREAM — a subscriber, and only a subscriber.
 *
 * `GET /api/run/:runId/stream` attaches to a run that is already executing and
 * relays what it published. It starts nothing, stops nothing, and owns
 * nothing. Opening a second one is reading the same record twice.
 *
 * ── WHAT THIS FILE IS NOT ALLOWED TO REACH, AND HOW THAT IS CHECKED ────────
 *
 * It imports the registry (to answer "does this run exist, and is it yours?")
 * and the feed (to read what the run said). It does NOT import the executor,
 * the LLM bridge, or the tool executor — and that is verifiable by walking the
 * import graph rather than by trusting a comment. A source scan for "does a
 * GET handler call `streamChat`" has a universe, and universes are what this
 * project keeps getting wrong; an import cone does not.
 *
 * The compile-time half covers the ordinary mistake: `router.get` hands its
 * handler no `MutationWarrant` and cannot accept one, and `startRunExecution`
 * demands one, so this file could not start a run by writing the obvious
 * code. It does NOT cover a deliberate cast — measured, 6 of 10 planted
 * escapes compile — and those are refused at runtime by the warrant registry
 * instead. `server/router.ts` states the full table; the point of repeating
 * the limit here is that a reader of this file must not conclude the import
 * cone above is redundant, because it is what holds when a cast does not.
 *
 * ── THE THREE THINGS THAT USED TO BE WRONG HERE ────────────────────────────
 *
 *   1. This handler WAS the executor. Two connections meant two complete
 *      executions — two provider POSTs of 38,429 bytes, billed twice, and the
 *      same tool call dispatched twice.
 *   2. `ctx.res.on("close", …)` aborted the run and deleted it, so one
 *      subscriber leaving ended another subscriber's paid work. There is no
 *      close handler here now. A subscriber that leaves unsubscribes; that is
 *      the entire consequence. Only `POST /api/run/:runId/cancel` stops a run.
 *   3. A dropped connection lost the run permanently: the reconnect got a 404
 *      because the close handler had already deleted it. Now the feed outlives
 *      the run for a retention window, carries its owner, and is replayed from
 *      `Last-Event-ID` — so coming back resumes rather than restarts.
 */

import type { Router } from "../router/router.ts";
import { guarded } from "../kernel/canonical.ts";
import { openSseStream, replayGapFrame } from "../router/sse.ts";
import { serverConfig } from "../kernel/config.ts";
import { SSE_EVENT_TYPES } from "../../shared/constants.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
import { requireUserContext } from "../auth/user-context.ts";
import { ForbiddenError, NotFoundError } from "../kernel/errors.ts";
import { getActiveRun, resolveRunOwner } from "../run/run-registry.ts";
import { subscribeToRunFeed, runFeedOwner } from "../run/run-feed.ts";

export function registerRunStreamRoutes(router: Router, db: AsyncDbClient): void {
  router.get("/api/run/:runId/stream", async (ctx) => {
    const user = await requireUserContext(ctx, db);
    const runId = ctx.params["runId"]!;

    // ── The two gates, unchanged in meaning and both still before the 200 ──
    //
    // Resolve the run and verify ownership BEFORE opening the stream, so a
    // 401/403/404 is a clean JSON response rather than a half-open event
    // stream. User B cannot read User A's run by guessing the id.
    //
    // The run is looked for in TWO places, and that is what makes a reconnect
    // possible. The registry holds runs that are still executing. The feed
    // outlives the run by its retention window and carries the same owner, so
    // a client that comes back moments after the run finished still resolves
    // to something and still passes an ownership check — instead of meeting
    // the 404 that used to make a dropped connection permanent.
    const owner = resolveRunOwner(runId);
    if (owner === undefined) {
      throw new NotFoundError(`Run ${runId} not found or already completed`);
    }
    if (owner !== user.userId) {
      throw new ForbiddenError(`Run ${runId} belongs to another user`);
    }
    const chatId = getActiveRun(runId)?.chatId ?? runFeedOwner(runId)?.chatId ?? null;

    // SPO: the per-identity SSE connection limit is enforced at the lowest
    // level — the stream owner. Passing `{ req, db }` lets the stream acquire
    // a connection slot for the caller's identity; a rejection throws
    // RateLimitError (429 + Retry-After) BEFORE the headers are written. The
    // slot is released when the stream closes. Every production SSE route
    // MUST pass both.
    //
    // THE RECONNECT CADENCE IS OURS, NOT THE BROWSER'S. Without a `retry:`
    // the browser picks its own interval — a few seconds, defined per
    // implementation and different between them. That is fine until something
    // has to be MEASURED against it, and something does: the retention window
    // is only meaningful if it outlasts a reconnect, and a window floored
    // against a number no one here owns is a threshold resting on a guess.
    // Writing the cadence makes the floor derivable (`server/config.ts`).
    const stream = await openSseStream(ctx.res, {
      req: ctx.req,
      db,
      retryMs: serverConfig.runStreamRetryMs,
      // A retained frame the egress door cannot redact is replaced by a
      // `replay_gap` naming this run (the client's gap handler needs it).
      gapIdentity: { runId },
    });

    // The stream's own open acknowledgment. It carries no sequence because it
    // is not part of the run's record — it is this connection saying hello.
    // Giving it an id would tell a later reconnect it had already received a
    // run frame it never saw.
    stream.send(SSE_EVENT_TYPES.connected, { runId, harnessReady: false, chatId });

    const subscription = subscribeToRunFeed(
      runId,
      stream.lastEventId,
      (frame) => stream.send(frame.event, frame.data, frame.sequence),
      () => stream.close(),
    );
    if (subscription === undefined) {
      // The feed was released between the ownership check and here — the run
      // finished and its retention window closed in that window. Say so
      // plainly and end the stream; inventing frames would be worse.
      stream.close();
      return;
    }

    // WHERE THIS SUBSCRIBER'S POSITION AND THE RUN'S RECORD DISAGREE, STATED.
    //
    // Two ways they can, and BOTH are reported through this one frame because
    // they are one fact — "what you are about to be given is not a continuous
    // continuation of what you had" — and a second frame type would be a
    // second thing for a client to remember to handle.
    //
    //   below: the buffer is bounded, so a client resuming from far enough
    //          back has a real gap, and is told the highest sequence that is
    //          gone rather than handed a stream that silently skips.
    //   above: a resume point past everything the run ever published. This
    //          reported NOTHING — 200, no frames, no gap, socket closed —
    //          which reads as "you are up to date" and on a live run hides
    //          every frame between the run's real position and the impossible
    //          one. `droppedBefore` existed to stop exactly this and only
    //          watched one end of the number line.
    //
    // An unreported gap is a fabricated continuity, in either direction.
    if (subscription.replay.droppedBefore > 0 || subscription.replay.resumeAhead) {
      stream.send(SSE_EVENT_TYPES.replayGap, replayGapFrame({ runId }, {
        droppedThroughSequence: subscription.replay.droppedBefore,
        resumedFrom: stream.lastEventId,
        highestSequence: subscription.replay.highestSequence,
        reason: subscription.replay.resumeAhead ? "resume_point_ahead_of_run" : "frames_dropped",
      }));
    }
    for (const frame of subscription.replay.frames) {
      // Delivery of retained output is real activity, but its arrival time
      // cannot measure when the model originally produced it.
      const data = frame.event === SSE_EVENT_TYPES.model && frame.data !== null && typeof frame.data === "object"
        ? { ...frame.data, replayed: true }
        : frame.data;
      stream.send(frame.event, data, frame.sequence);
    }

    // LEAVING IS ONLY LEAVING. This listener unsubscribes and does nothing
    // else — no abort, no delete. Its predecessor aborted the run's shared
    // controller and removed it from the registry, which is why one party
    // closing a tab ended another party's turn and why a reconnect 404'd.
    // The prompt is already billed by the time a socket drops; throwing the
    // answer away does not refund it.
    ctx.res.on("close", guarded("run-stream.unsubscribe", subscription.unsubscribe));

    // The run had already finished when this subscriber attached: the replay
    // above is the whole of it, so close rather than hold a socket open on a
    // feed that will never publish again.
    if (subscription.replay.ended) {
      subscription.unsubscribe();
      stream.close();
    }
  });
}
