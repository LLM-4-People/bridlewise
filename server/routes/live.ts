/**
 * THE STANDING LIVENESS STREAM — the socket that answers "is the API there?"
 * without anyone having to ask.
 *
 * ── WHY A STREAM AND NOT A POLL ────────────────────────────────────────────
 *
 * This replaced a 1s `/api/health` poll, and the poll was the wrong shape in
 * three separate ways.
 *
 * COST. A cockpit at rest issues no requests at all (browser-measured: zero
 * fetches in twelve seconds on a fully loaded screen), so a poll adds traffic
 * to a page that was silent — sixty requests a minute, per tab, forever,
 * every one of them expected to say "still fine".
 *
 * LATENCY. A poll's discovery time is bounded by its interval and nothing
 * else: browser-measured at a 5s interval it took 4,471ms to notice the
 * server had gone, and at 1s it took 569ms. A held socket has no interval —
 * when the process dies the kernel delivers FIN and the browser fires `error`
 * immediately, so detection stops being a function of how often we asked.
 *
 * RECOVERY. `retry:` (written below) is part of the EventSource protocol: the
 * browser stores it and reconnects on that cadence by itself, using the value
 * it received BEFORE the outage. So the page needs no timer of its own in
 * either direction — not to detect the drop, and not to detect the return.
 *
 * ── WHAT IT SENDS, AND WHY EACH PIECE EXISTS ───────────────────────────────
 *
 *   retry:  the reconnect cadence (LIVE_STREAM_RETRY_MS) — see above;
 *   ping    a REAL event on the keepalive cadence, deliberately not the SSE
 *           COMMENT `server/sse.ts` already writes. A comment keeps
 *           intermediaries from closing the socket but fires nothing in the
 *           browser — and the failure this exists to catch is a server whose
 *           event loop has WEDGED, which holds its socket open and simply
 *           stops producing. The only symptom is silence, and silence is
 *           only observable if there was a sound to miss.
 *
 * There is deliberately NO "hello" event and no payload of any kind. The
 * EventSource protocol fires `open` on the browser when the connection is
 * established, so a hello would announce a fact the browser already reported;
 * and every field this stream carried would be a field some surface would
 * eventually render, at which point a reconnect becomes a data event and the
 * connection state stops being a fact about the CONNECTION.
 *
 * ── WHY IT IS PUBLIC ───────────────────────────────────────────────────────
 *
 * "Is the server there" is not a question that needs a session, and the boot
 * needs it answered BEFORE one exists — the first request of the boot is the
 * auth check, and a reader stuck at a blocked sign-in screen has the same
 * right to know the server is down as one who is signed in. It carries no
 * data about anything at all — an empty beat, nothing else. The loopback
 * origin check in `server/index.ts` still applies.
 *
 * ── WHY IT IS CAPPED ON ITS OWN BUDGET ─────────────────────────────────────
 *
 * It IS capped — this route passes `{ req, db }`, so it cannot be used to
 * exhaust file descriptors — but NOT out of the run streams' budget, and the
 * reason is a measured, user-blocking defect rather than a preference.
 *
 * This is a STANDING connection carrying `retry: LIVE_STREAM_RETRY_MS`
 * (250ms). While it shared the run budget, eight streams of any kind for one
 * identity meant every liveness reconnect was refused with 429 — and the
 * browser, obeying the cadence written on the line above, asked again four
 * times a second, forever. The loop was self-sustaining: a refusal cannot be
 * cured by retrying, so the page never recovered without restarting the API.
 * Three windows plus a slot not yet released was enough to reach it, and
 * several windows and several in-page workspaces is the NORMAL case for this
 * product — a deliberate feature decision, not abuse.
 *
 * THE STRONGEST ARGUMENT IS THE PERVERSE ONE: the stream whose entire job is
 * detecting outages was the first casualty of load. The instrument failed
 * exactly when it was most needed and then reported "offline" for a server
 * that was perfectly healthy — a false statement produced by our own limiter.
 * A bigger shared number would only move the point at which it lies; a
 * separate budget removes the competition. See `SSE_CONNECTION_CLASSES` in
 * `server/sse.ts` and `DEFAULT_SSE_MAX_LIVENESS_CONNECTIONS_PER_USER`.
 */

import type { Router } from "../router/router.ts";
import { guarded } from "../kernel/canonical.ts";
import { openSseStream, SSE_CONNECTION_CLASSES } from "../router/sse.ts";
import { serverConfig } from "../kernel/config.ts";
import {
  LIVE_STREAM_RETRY_MS,
  SSE_EVENT_TYPES,
} from "../../shared/constants.ts";
import type { AsyncDbClient } from "../db/async-client.ts";

export function registerLiveRoutes(router: Router, db: AsyncDbClient): void {
  router.get("/api/live", async (ctx) => {
    const stream = await openSseStream(ctx.res, {
      req: ctx.req,
      db,
      retryMs: LIVE_STREAM_RETRY_MS,
      // Its own budget — see the header. The only route that names this
      // class; everything else takes the strict `run` default.
      connectionClass: SSE_CONNECTION_CLASSES.liveness,
    });

    // THE FIRST BEAT GOES OUT IMMEDIATELY, before any interval is armed.
    // Without it the client's silence watchdog would start against a stream
    // that has not yet made a sound, and one keepalive period of a perfectly
    // healthy connection would count toward its threshold.
    stream.send(SSE_EVENT_TYPES.ping, {});

    // The beat. Reuses `sseKeepaliveMs` — the existing single owner of "how
    // often a stream should make a noise" — rather than introducing a second
    // interval that could drift from it.
    const beat = setInterval(guarded("live.heartbeat", () => {
      if (stream.isClosed()) {
        clearInterval(beat);
        return;
      }
      stream.send(SSE_EVENT_TYPES.ping, {});
    }), serverConfig.sseKeepaliveMs);

    // Cleared on disconnect as well as on close: an interval that outlives
    // its response is a leak that grows with every reconnect, and this
    // stream is designed to reconnect often.
    ctx.res.on("close", guarded("live.closed", () => {
      clearInterval(beat);
    }));
  });
}
