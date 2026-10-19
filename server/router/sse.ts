/**
 * SSE (Server-Sent Events) helper for node:http responses.
 *
 * Sets the correct headers and provides a typed `send` function.
 * Handles keep-alive pings and client disconnect detection.
 *
 * SPO (resource-exhaustion fix): this module
 * ALSO owns the per-identity SSE CONNECTION LIMIT. SSE streams are GETs →
 * exempt from the request rate limiter (which only applies to mutating
 * routes). Without a separate connection cap, an attacker could open
 * unlimited long-lived SSE connections → file-descriptor + memory
 * exhaustion. The limit is enforced HERE — at the lowest level (the choke
 * point every SSE stream passes through) — so NO route can bypass it: a
 * route that calls `openSseStream(res, { req, db })` gets the limit for
 * free; a route that omits `{ req, db }` is caught by the prevention test
 * (every `openSseStream` call in `server/` MUST pass `{ req, db }`).
 *
 * THE LIMIT IS PER CLASS AS WELL AS PER IDENTITY (`SSE_CONNECTION_CLASSES`).
 * Run streams and the standing liveness beat are counted in separate buckets
 * with separate budgets, because when they shared one the outage detector was
 * the first thing load refused — see `SSE_CONNECTION_CLASSES` for the defect
 * and `DEFAULT_SSE_MAX_LIVENESS_CONNECTIONS_PER_USER` for the numbers.
 *
 * The identity key is derived via the shared rate-limiter identity
 * (`rateLimitKey` from `rate-limiter.ts` — reuse: the
 * authenticated userId, or the un-spoofable client IP for unauthenticated
 * routes). When a class's per-identity connection count reaches its budget,
 * a new connection is rejected with a
 * `RateLimitError` (HTTP 429 + `Retry-After`) — the router maps it. The
 * count is decremented when the stream closes (on disconnect, error,
 * timeout, or explicit close) so the slot is released for the next
 * connection.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { guarded } from "../kernel/canonical.ts";

import { serverConfig } from "../kernel/config.ts";
import { webHandleError, webWarn } from "../observability/debug-bridge.ts";
import { type ReplayGapReason, type SseEventType, type TerminalSseEventType, type WithheldTerminalFrame, isKnownSseEventType, isTerminalSseEventType, SSE_EVENT_TYPES } from "../../shared/constants.ts";
import { isKnownErrorCode } from "../../shared/errors.ts";
import { noteFrameWithheld } from "./egress-failures.ts";
import { BadRequestError, RateLimitError } from "../kernel/errors.ts";
import { rateLimitKey } from "./rate-limiter.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
// SPO: the SSE stream is the USER-DISPLAY egress choke point — every event
// sent to the browser passes through `send`. PII is redacted HERE, at the
// lowest level, by reusing the single redaction owner (server/redaction.ts
// — NOT a rebuild). A route that forgets an upstream redaction is still
// caught at this choke point: the secret never reaches the wire. The
// redaction preserves keys/structure/variable-names so the UI renders
// correctly (keep consts/vars/env names).
import { redactForUserDisplay } from "../llm/redaction.ts";

export type SseStream = {
  /**
   * Emit a named SSE event. The event name MUST be a registered
   * `SseEventType` (the single owner: `shared/constants.ts`). This is
   * the lowest-level enforcement of the SSE event owner (SPO):
   * the stream itself — the choke point every event passes through —
   * accepts only registered types, so no route can construct an ad-hoc
   * event type. Deny-by-default: an unknown type is dropped + warned
   * (defense-in-depth for non-TS callers; the compile-time type is the
   * primary gate).
   *
   * PII redaction: the payload is redacted HERE, at the egress choke
   * point, before it is serialized to the wire. This is the single place
   * ALL user-facing SSE content converges — no route can bypass it.
   * Secrets (API keys, passwords, tokens, private keys) in any event
   * (model deltas, tool results, context, metadata, errors) are masked;
   * variable/const/env names + structure are preserved so the UI renders
   * correctly.
   */
  readonly send: (eventName: SseEventType, data: unknown) => void;
  readonly close: () => void;
  readonly isClosed: () => boolean;
  /**
   * WHERE THIS CLIENT GOT TO BEFORE IT DROPPED.
   *
   * The sequence carried by the request's `Last-Event-ID` header, or 0 when
   * the client is starting fresh or sent something that is not a sequence.
   *
   * This stream used to write `retry:` — instructing the browser to
   * reconnect — while emitting no `id:` on any frame and never reading this
   * header. So the browser dutifully came back and had no way to say where it
   * had got to, and the server had no way to tell. Telling a client to resume
   * a stream that cannot be resumed is not a partial feature; it is three
   * mechanisms pointing in three directions. `id:` and this are the two
   * halves of SSE's own resumption, and neither is useful alone.
   */
  readonly lastEventId: number;
};

/**
 * A RESUMABLE stream — one opened with a `gapIdentity`: only it may send a
 * frame with an `id` (a sequence a reconnecting client resumes from),
 * because only it can write the `replay_gap` frame that replaces a frame the
 * door could not redact. The requirement is the TYPE's (WF1B3BFIX-GAP-
 * IDENTITY-TYPE): `openSseStream` answers this shape only when the options
 * carry a gap identity, so a route without one cannot spell an id; the door's
 * runtime refusal stays for a caller the types do not reach.
 */
export type ResumableSseStream = Omit<SseStream, "send"> & {
  readonly send: (eventName: SseEventType, data: unknown, id?: number) => void;
};

export type SseStreamOptions = {
  /** The request — used to derive the per-identity SSE connection-limit
   * key (SPO). When provided WITH `db`, `openSseStream` enforces the
   * max-connections-per-identity limit (rejects with 429 + Retry-After
   * when exceeded). Every production SSE route MUST pass both; the
   * prevention test verifies no `server/` caller omits them. */
  readonly req?: IncomingMessage;
  /** The async data facade — used to resolve the authenticated user for the
   * identity key. */
  readonly db?: AsyncDbClient;
  /** Keepalive interval (ms). Defaults to `serverConfig.sseKeepaliveMs`
   * (the single source of truth). */
  readonly keepaliveMs?: number;
  /**
   * SSE's own `retry:` field — how long the BROWSER waits before
   * reconnecting this stream after it drops, written once when the stream
   * opens.
   *
   * It is part of the EventSource protocol rather than anything this
   * codebase invented: the browser stores the value and applies it to every
   * later reconnect, INCLUDING while the server is unreachable, because the
   * value it holds was delivered before the outage began. That is what lets
   * a stream recover with no polling on the page's side. Omitted → the
   * browser's own default (~3s in Chrome).
   */
  readonly retryMs?: number;
  /**
   * WHICH BUDGET this stream draws on. Defaults to `run` — the strict one —
   * so a new route gets the scarce budget unless it deliberately names the
   * other (deny-by-default: the permissive class must be asked for, never
   * inherited).
   *
   * See `SSE_CONNECTION_CLASSES` for why there are two.
   */
  readonly connectionClass?: SseConnectionClass;
  /**
   * The fields that name this stream's record in a `replay_gap` frame the
   * door writes IN PLACE OF a resumable frame it could not redact (the run
   * stream passes `{ runId }`, which the client's gap handler requires).
   * Plain identifiers only: the gap frame is written without redaction.
   * REQUIRED to send a resumable frame: a stream that sends ids without an
   * identity could only emit a gap the client refuses, so such a send is
   * refused at the door (logged, the stream closed), never written.
   */
  readonly gapIdentity?: Readonly<Record<string, string>>;
};

/**
 * THE ONE `replay_gap` BUILDER — the frame that tells a subscriber its view
 * of a run has a hole, written by the run stream (a resume the buffer cannot
 * serve) and by the egress door (a frame it withheld). One shape, one
 * reason vocabulary (`REPLAY_GAP_REASONS`, shared/constants.ts), so the
 * client reads every gap the same way.
 */
export function replayGapFrame(identity: Readonly<Record<string, string>>, gap: Readonly<{
  droppedThroughSequence: number;
  resumedFrom: number;
  highestSequence?: number;
  reason: ReplayGapReason;
}>): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ...identity,
    droppedThroughSequence: gap.droppedThroughSequence,
    resumedFrom: gap.resumedFrom,
    ...(gap.highestSequence === undefined ? {} : { highestSequence: gap.highestSequence }),
    reason: gap.reason,
  });
}

/** The code a withheld `error` frame carries when the original's is not a taxonomy code. */
export const WITHHELD_FRAME_CODE = "frame_withheld";

/** The fixed message of a withheld `error` frame (nothing of the original's text leaves). */
export const WITHHELD_ERROR_MESSAGE = "This run ended with an error whose report could not be shown safely, so it was withheld.";

/**
 * THE ONE BUILDER of the terminal frame that stands in for a withheld one
 * ({@link WithheldTerminalFrame}): the identity, `withheld`, the original's
 * `autoTripsReverted` when it was `true`, and for `error` the SSE error
 * contract (`code`: the original's when the taxonomy declares it, else
 * {@link WITHHELD_FRAME_CODE}; the fixed {@link WITHHELD_ERROR_MESSAGE}).
 * Every value is a plain identifier or a constant: the frame is written
 * without redaction.
 */
export function withheldTerminalFrame(event: TerminalSseEventType, identity: Readonly<Record<string, string>>, original: unknown): WithheldTerminalFrame {
  const facts = typeof original === "object" && original !== null ? original as Record<string, unknown> : {};
  const originalCode = facts["code"];
  return Object.freeze({
    ...identity,
    withheld: "frame_unredactable",
    ...(facts["autoTripsReverted"] === true ? { autoTripsReverted: true as const } : {}),
    ...(event === SSE_EVENT_TYPES.error
      ? { code: typeof originalCode === "string" && isKnownErrorCode(originalCode) ? originalCode : WITHHELD_FRAME_CODE, message: WITHHELD_ERROR_MESSAGE }
      : {}),
  });
}

/** The frame's resumable sequence (a positive integer), or `undefined` for a frame outside any record. */
function resumableId(id: number | undefined): number | undefined {
  return id !== undefined && Number.isFinite(id) && id > 0 ? Math.floor(id) : undefined;
}

/**
 * THE TWO SSE BUDGETS, and why one number could not serve both.
 *
 * `run` — a stream that executes and streams a run. Per-run, server work
 *         behind it, bounded by `sseMaxConnectionsPerUser` (8).
 * `liveness` — the standing, payload-free, public keepalive that answers "is
 *         the API there?". One per TAB, no server work behind it, bounded by
 *         `sseMaxLivenessConnectionsPerUser` (32).
 *
 * They shared one budget once, and the consequence was perverse: the stream
 * whose entire job is DETECTING OUTAGES was the first casualty of load. Eight
 * streams of any kind exhausted the budget, every liveness reconnect was
 * refused with 429, and the browser — obeying the 250ms `retry:` cadence the
 * server itself wrote — asked again four times a second forever. The page
 * could not recover; it reported the server unreachable while that same
 * server answered every request put to it.
 *
 * The separation is a SHAPE, not a bigger number: the two classes are counted
 * in different buckets (the class is part of the tracker key), so run streams
 * cannot consume liveness slots and liveness streams cannot consume run
 * slots, whatever the numbers are set to.
 */
export const SSE_CONNECTION_CLASSES = {
  run: "run",
  liveness: "liveness",
} as const;

export type SseConnectionClass =
  (typeof SSE_CONNECTION_CLASSES)[keyof typeof SSE_CONNECTION_CLASSES];

/** The per-class connection budget. One place, so "which limit applies" is
 *  never decided at a call site. */
function limitFor(cls: SseConnectionClass): number {
  return cls === SSE_CONNECTION_CLASSES.liveness
    ? serverConfig.sseMaxLivenessConnectionsPerUser
    : serverConfig.sseMaxConnectionsPerUser;
}

/**
 * The tracker key: the class and the identity, together.
 *
 * This is where the separation is actually enforced. Counting both classes
 * under one key is what let a run stream refuse a liveness beat; keying by
 * both makes that unrepresentable rather than merely discouraged. The `|`
 * separator cannot occur in either half — the class names are bare words
 * and `rateLimitKey` produces `user:<uuid>` / `ip:<addr>` — so no identity
 * can forge a class by choosing its own name.
 */
function budgetKey(cls: SseConnectionClass, identity: string): string {
  return `${cls}|${identity}`;
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

const KEEPALIVE_COMMENT = ": keepalive";

// ── Per-identity SSE connection tracker (resource-exhaustion fix) ──
// A process-global Map keyed by identity (the same `user:<id>` / `ip:<ip>`
// form `rateLimitKey` produces). The value is the count of active SSE
// connections for that identity. When the count reaches
// `sseMaxConnectionsPerUser`, a new connection is rejected with 429. The
// count is decremented when the stream closes (disconnect/error/timeout/
// explicit close). Process-global because SSE connections outlive any
// single request (the stream handler is async + long-lived).
const sseConnections = new Map<string, number>();

/**
 * Every OPEN stream's close function — the shutdown registry.
 *
 * WHY THIS EXISTS, measured rather than anticipated. `server.close()` stops
 * the listener but deliberately does NOT touch established connections; it
 * waits for them to finish. An SSE stream never finishes. So the moment this
 * server had a STANDING stream open (`server/routes/live.ts`), SIGTERM stopped
 * working: the listener closed, the process stayed alive holding ESTABLISHED
 * sockets, and `kill` hung forever. Two orphaned servers were produced this
 * way in one session before it was noticed — the exact class of failure a
 * long-lived process must never have, because the operator's only remaining
 * tool is SIGKILL and every graceful-shutdown path is bypassed.
 *
 * The registry is the smallest honest fix: shutdown ENDS the streams, then
 * `server.close()` has nothing left to wait for. See `closeAllSseStreams`.
 */
const openStreams = new Set<() => void>();

/**
 * Acquire an SSE connection slot for the request's identity (
 * the lowest-level enforcement of the per-identity connection limit).
 * Derives the identity key via the shared rate-limiter identity
 * (`rateLimitKey` — reuse) so authenticated users are keyed by
 * userId and unauthenticated public routes by the un-spoofable client IP.
 * Throws `RateLimitError` (HTTP 429 + `Retry-After`) when the per-identity
 * count has reached `sseMaxConnectionsPerUser` — the router maps it to a
 * 429 response. Returns a `release` function that MUST be called when the
 * stream closes (the stream's `close` calls it) so the slot is freed.
 *
 * Exposed so the prevention test + diagnostics can verify the limit
 * directly (without an HTTP server). NOT for routes — routes call
 * `openSseStream(res, { req, db })` which calls this internally (the
 * choke point — no route bypasses the limit).
 */
export async function acquireSseConnection(
  req: IncomingMessage,
  db: AsyncDbClient,
  cls: SseConnectionClass = SSE_CONNECTION_CLASSES.run,
): Promise<() => void> {
  const key = budgetKey(cls, await rateLimitKey(req, db));
  const current = sseConnections.get(key) ?? 0;
  const limit = limitFor(cls);
  if (current >= limit) {
    throw new RateLimitError(
      "Too many concurrent SSE connections. Please close an existing connection and retry.",
      serverConfig.sseConnectionRetryAfterSeconds,
      "sse_connection_limit",
    );
  }
  sseConnections.set(key, current + 1);
  let released = false;
  return function release(): void {
    if (released) return;
    released = true;
    const after = sseConnections.get(key);
    if (after === undefined) return; // already cleaned (e.g. resetSseConnectionTracker)
    if (after <= 1) sseConnections.delete(key);
    else sseConnections.set(key, after - 1);
  };
}

/** The number of active SSE connections for an identity key, in one class
 * (for diagnostics + the prevention test). Takes the raw key form
 * `rateLimitKey` produces (`user:<id>` / `ip:<ip>`); the class defaults to
 * `run`, the class every caller but the liveness route uses. */
export function sseConnectionCount(
  key: string,
  cls: SseConnectionClass = SSE_CONNECTION_CLASSES.run,
): number {
  return sseConnections.get(budgetKey(cls, key)) ?? 0;
}

/** The total number of tracked SSE connection identities (for diagnostics). */
export function sseConnectionIdentities(): number {
  return sseConnections.size;
}

/** Reset the connection tracker (for tests). */
export function resetSseConnectionTracker(): void {
  sseConnections.clear();
}

/**
 * A RESUME POINT THIS SERVER COULD HAVE MINTED, OR A REFUSAL.
 *
 * `Last-Event-ID` is whatever the client says it is. The only ids this server
 * ever writes are plain decimal integers counting from 1 (`send` below emits
 * `String(Math.floor(id))`), so the set of values that can legitimately come
 * back is exactly that — and this reader accepts exactly that set. Anything
 * else is a position this run's record cannot contain.
 *
 * ── WHY `Number()` WAS THE WRONG READER, DRIVEN ────────────────────────────
 *
 * The previous version took `Number(text)` and accepted anything finite and
 * positive. `Number` parses a far larger language than this server writes,
 * and the comment above it claimed "an unparseable value is never guessed
 * at". Measured against a feed whose highest sequence was 415:
 *
 *   `1e3`                → 1000  → 0 frames replayed, no gap reported
 *   `9007199254740993`   → accepted as-is, 0 frames, no gap
 *   `0x10`               → 16, by the same route
 *   `3.7`                → 3
 *
 * Two of those hand the subscriber an EMPTY stream and tell it nothing —
 * "unparseable" was the one thing the value was not, and being parseable by
 * the wrong grammar is worse than being rejected, because it produces a
 * confident wrong answer. Unknown input is an error, never a silent default.
 *
 * ── WHY A REFUSAL AND NOT "START FROM THE BEGINNING" ───────────────────────
 *
 * Because silently restarting the stream is a second wrong answer: the client
 * asked to resume, and would be handed frames it already has with no way to
 * know that is what happened. The refusal is a 400 before the stream opens,
 * so it is a readable JSON error rather than a half-open event stream — and,
 * per the EventSource protocol, a non-200 makes the browser FAIL the
 * connection rather than retry it, so a nonsense header cannot become a
 * reconnect loop. No browser produces one of these on its own: it can only
 * send back an id this server minted, and every one of those is accepted.
 *
 * Absent or empty is not a refusal — that is a client with no position yet,
 * which is the ordinary first connection, and it means "from the beginning".
 */
export function parseResumePoint(raw: string | readonly string[] | undefined): number {
  const text = Array.isArray(raw) ? raw[0] : (raw as string | undefined);
  if (text === undefined) return 0;
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  // No sign, no exponent, no decimal point, no radix prefix, no leading zero:
  // the exact shape `send` writes, so the accepted set equals the emitted set
  // by construction rather than by two definitions agreeing.
  if (!/^[1-9][0-9]*$/.test(trimmed)) {
    throw new BadRequestError(
      "The resume position sent with this request is not one this server issues. " +
        "Reconnect without it to receive the stream from the beginning.",
      "invalid_resume_point",
    );
  }
  const value = Number(trimmed);
  // Beyond this, integers stop being distinguishable from their neighbours,
  // so an id "equal" to a sequence would be an accident of rounding.
  if (!Number.isSafeInteger(value)) {
    throw new BadRequestError(
      "The resume position sent with this request is larger than any this server issues. " +
        "Reconnect without it to receive the stream from the beginning.",
      "invalid_resume_point",
    );
  }
  return value;
}

/**
 * Open an SSE stream on the response. `keepaliveMs` defaults to the
 * server-configured interval (single source of truth in server/config.ts).
 *
 * SPO: when `{ req, db }` are provided, the per-identity connection
 * limit is enforced BEFORE the headers are written (a rejection throws
 * `RateLimitError` → the router maps it to 429 + Retry-After; the SSE
 * 200 headers are never sent). The acquired slot is released when the
 * stream closes (disconnect/error/timeout/explicit close) so the next
 * connection can take it. Every production SSE route MUST pass `{ req, db }`
 * the prevention test verifies no `server/` caller omits them.
 */
export async function openSseStream(res: ServerResponse, opts: SseStreamOptions & { readonly gapIdentity: Readonly<Record<string, string>> }): Promise<ResumableSseStream>;
export async function openSseStream(res: ServerResponse, opts?: Omit<SseStreamOptions, "gapIdentity">): Promise<SseStream>;
export async function openSseStream(
  res: ServerResponse,
  opts: SseStreamOptions = {},
): Promise<ResumableSseStream> {
  const resolved: SseStreamOptions = opts;

  // Enforce the per-identity connection limit BEFORE writing headers. A
  // rejection throws RateLimitError (→ 429 + Retry-After via the router)
  // before the SSE 200 headers are sent, so the client gets a clean JSON
  // error, not a half-open event stream. Lowest-level enforcement: no
  // route can bypass this — every stream goes through openSseStream.
  // THE CLIENT CAN VANISH DURING THE ACQUIRE, and before this latch existed
  // that leaked the slot permanently. `acquireSseConnection` awaits
  // `rateLimitKey`, which awaits the database — a real suspension point — and
  // the `close`/`error` listeners below are only attached AFTER it resolves.
  // A browser that aborted in that window fired `close` with nothing
  // listening, so the response was already dead when the stream was wired to
  // it: the slot was held by a socket that no event would ever close again,
  // and a keepalive wrote into the void every 15s. A handful of those turn a
  // survivable cap into an inevitable one, which is exactly how this class of
  // defect ends. The listener is registered BEFORE the first await so no
  // event can be missed, and `close()` below (registered later) is idempotent.
  let aborted = false;
  const markAborted = guarded("sse.client-aborted", (): void => {
    aborted = true;
  });
  res.on("close", markAborted);

  // WHERE THE CLIENT GOT TO — read and REFUSED before anything is spent.
  //
  // Deliberately above the connection-slot acquisition: a rejection here
  // throws, and a throw after `acquireSseConnection` would leak the slot it
  // had just taken (the release is only wired into `close`, which a stream
  // that never opened never calls).
  const lastEventId = parseResumePoint(resolved.req?.headers["last-event-id"]);

  let release: (() => void) | undefined;
  if (resolved.req !== undefined && resolved.db !== undefined) {
    release = await acquireSseConnection(
      resolved.req,
      resolved.db,
      resolved.connectionClass ?? SSE_CONNECTION_CLASSES.run,
    );
  }

  const keepaliveMs = resolved.keepaliveMs ?? serverConfig.sseKeepaliveMs;
  // If writeHead/flushHeaders throw AFTER a slot was acquired
  // (rare — e.g. a res already ended), release the slot so it doesn't
  // leak (deny-by-default: never hold a slot for a stream that never
  // opened). The release is one-shot; close also calls it (no-op then).
  try {
    res.writeHead(200, SSE_HEADERS);
    res.flushHeaders();
  } catch (hdrErr) {
    release?.();
    throw hdrErr;
  }

  // The reconnect cadence, written BEFORE anything else on the stream so a
  // connection that drops immediately after opening has still been told it.
  if (resolved.retryMs !== undefined) {
    try {
      res.write(`retry: ${String(Math.max(0, Math.round(resolved.retryMs)))}\n\n`);
    } catch (retryErr) {
      // Rethrown UNCHANGED, never re-wrapped: the original carries what
      // actually failed (a destroyed socket, a closed response), and a new
      // message here would replace a real cause with a summary of it.
      release?.();
      throw retryErr;
    }
  }

  let closed = false;

  const keepalive = setInterval(guarded("sse.keepalive", () => {
    if (closed) return;
    try {
      res.write(KEEPALIVE_COMMENT + "\n");
    } catch {
      close();
    }
  }), keepaliveMs);

  function close(): void {
    if (closed) return;
    closed = true;
    openStreams.delete(close);
    clearInterval(keepalive);
    try { res.end(); } catch (endErr) { webWarn("sse", "res.end failed", () => ({ error: endErr instanceof Error ? endErr.message : String(endErr) })); }
    // Release the connection slot so the next connection can take it.
    // Idempotent (release is one-shot); safe to call even if no slot was
    // acquired (release is undefined when { req, db } were omitted).
    release?.();
  }

  const closeOnEvent = guarded("sse.close", close);
  res.on("close", closeOnEvent);
  res.on("error", closeOnEvent);
  // Registered only once the stream is genuinely open, and removed by `close`
  // itself, so the set holds exactly the streams that would otherwise keep the
  // process alive.
  openStreams.add(close);

  // The response died while the identity was being resolved (see the latch
  // above): its `close` already fired, so `close` would never run on its own.
  // Run it now — the slot is released, the keepalive is cleared, and the
  // stream is out of the shutdown registry before it can be handed back.
  if (aborted) close();

  function send(eventName: SseEventType, data: unknown, id?: number): void {
    if (closed) return;
    // Deny-by-default (SPO): only registered event types are
    // emitted. The compile-time `SseEventType` is the primary gate; this
    // runtime guard is defense-in-depth for a dynamically-constructed
    // string or a non-TS caller. An unknown type is dropped + warned
    // (never silently written to the wire).
    if (!isKnownSseEventType(eventName)) {
      webWarn("sse", "rejected unregistered event type", () => ({ eventName: String(eventName) }));
      return;
    }
    // SPO: redact PII at the egress choke point BEFORE the payload is
    // serialized to the wire. This is the single place ALL user-facing
    // SSE content converges, so no route can bypass it — a tool result,
    // model delta, context event, or error message that carries a secret
    // (API key, password, token, private key) is masked here.
    // Variable/const/env names + structure are preserved (the UI still
    // renders; the user still understands the code context).
    //
    // THE DOOR CANNOT THROW. Sends run from timers and event callbacks (the
    // liveness beat, run feeds), where an exception is an uncaught one — the
    // process exits. A frame that cannot be redacted or serialized is NOT
    // written (nothing unredacted leaves), counted (`privacy.framesWithheld`)
    // and logged. A RESUMABLE frame (it carries an id) is replaced by the one
    // gap frame, `replay_gap`, under its own id, and the stream stays open:
    // closing it made the client reconnect from the frame before, the replay
    // re-sent the same frame, and the stream closed again — an endless loop
    // for the whole retention window (wf1b-design M7). A frame with no id has
    // no place in a record to skip past, so its stream is closed.
    let payload: string;
    // A withheld TERMINAL frame still ends the run for the client: after the
    // gap, the same terminal event is sent as `withheldTerminalFrame` builds
    // it (no sequence, nothing unredacted; an `error` keeps the SSE error
    // contract). Without it the client never learns the run ended and waits
    // on a stream that will publish nothing further (wf1b2-correctness: an
    // unredactable final frame).
    let withheldTerminal: TerminalSseEventType | undefined;
    const sequence = resumableId(id);
    if (sequence !== undefined && resolved.gapIdentity === undefined) {
      webWarn("sse", "a resumable frame was sent on a stream with no gap identity; the stream is closed", () => ({ eventName }));
      close();
      return;
    }
    try {
      const redacted = redactForUserDisplay(data);
      payload = typeof redacted === "string" ? redacted : JSON.stringify(redacted);
    } catch (egressFailure) {
      noteFrameWithheld();
      webHandleError(egressFailure, { module: "sse", operation: "egress-redaction", eventName });
      if (sequence === undefined || resolved.gapIdentity === undefined) {
        close();
        return;
      }
      if (isTerminalSseEventType(eventName)) withheldTerminal = eventName;
      eventName = SSE_EVENT_TYPES.replayGap;
      payload = JSON.stringify(replayGapFrame(resolved.gapIdentity, {
        droppedThroughSequence: sequence,
        resumedFrom: sequence - 1,
        reason: "frame_unredactable",
      }));
    }
    try {
      // `id:` FIRST, because the browser applies the id it last saw to the
      // event it is currently assembling — and it is what comes back as
      // `Last-Event-ID` on the reconnect. A frame without one is a frame a
      // client cannot resume past, so callers that own a sequence pass it;
      // callers whose frame is not part of a resumable record (a stream's own
      // open acknowledgment, a keepalive) pass nothing rather than inventing
      // a number, because a made-up id would tell a reconnecting client it
      // had received something it had not.
      if (sequence !== undefined) res.write(`id: ${String(sequence)}\n`);
      res.write(`event: ${eventName}\n`);
      res.write(`data: ${payload}\n\n`);
      if (withheldTerminal !== undefined) {
        res.write(`event: ${withheldTerminal}\n`);
        res.write(`data: ${JSON.stringify(withheldTerminalFrame(withheldTerminal, resolved.gapIdentity!, data))}\n\n`);
      }
    } catch {
      close();
    }
  }

  return { send, close, isClosed: () => closed, lastEventId };
}

/**
 * End every open SSE stream. Called by the shutdown handler in
 * `server/index.ts` BEFORE `server.close()`, because `server.close()` waits
 * for established connections and an SSE stream never ends on its own — see
 * `openStreams` for the orphaned processes this prevents.
 *
 * Returns how many were closed, so shutdown can say what it did rather than
 * claiming a clean exit it did not verify. Iterates a COPY: each `close()`
 * removes itself from the set.
 */
export function closeAllSseStreams(): number {
  const streams = [...openStreams];
  for (const close of streams) close();
  return streams.length;
}
