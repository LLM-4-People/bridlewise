/**
 * Client operational configuration — the single source of truth for
 * client-side tunable literals.
 *
 * The browser cannot read server env vars at runtime, so client-side
 * constants live here (not in server/config.ts). Values that must match
 * the server (e.g. API path prefix) are owned here and consumed by
 * client.ts; the server owns its own equivalents in server/config.ts.
 *
 * @config-owner
 */

export const DEFAULT_API_BASE = "/api";
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

// ── Connection state (src/data/connection.ts owns the state; these are
// its tunables, here with every other client-side literal) ──

/**
 * How often the SERVER beats on the standing liveness stream, in ms — the
 * cadence the client's silence watchdog measures against.
 *
 * IT MUST MATCH THE SERVER, and the server's own owner is
 * `serverConfig.sseKeepaliveMs` (`DEFAULT_SSE_KEEPALIVE_MS`, 15s). The browser
 * cannot read a server env var at runtime, so this is the client-side mirror,
 * and `tests/prevention/liveness-stream-owner.test.ts` asserts the two are
 * equal — a drift here would make the watchdog either trigger-happy or deaf.
 *
 * It is only ever the DENOMINATOR of the watchdog threshold
 * (`LIVE_STREAM_MISSED_BEATS` beats of silence). Nothing polls on it.
 */
export const LIVENESS_BEAT_MS = 15_000;

// ── Shared liveness (the one-socket-per-origin fix — UIE-044) ──

/**
 * The names of the Web Lock + BroadcastChannel the browser-context's tabs
 * use to share ONE liveness stream.
 *
 * WHY THEY EXIST. Chrome holds SIX HTTP/1.1 sockets per origin per browser
 * context, and every logged-in tab used to pin one with its own liveness
 * EventSource for its whole life. Measured on this machine (the UIE-044
 * drive): six tabs pin the pool completely, every further request —
 * a steer POST included — queues forever, and the broker's 30s timeout
 * aborts it with `net::ERR_ABORTED` while the server records nothing. The
 * fact the stream carries ("is this origin's API answering?") is ONE fact
 * per origin, so ONE elected tab holds the socket and every other tab in
 * the context derives the same connection state from its broadcasts.
 *
 * Both names are literals here rather than derived: they are WIRE
 * IDENTIFIERS (cross-tab agreement depends on the exact bytes), not
 * tunable behavior.
 */
export const LIVENESS_LOCK_NAME = "bridlewise-liveness-leader";
export const LIVENESS_CHANNEL_NAME = "bridlewise-liveness-beats";

/** How many CONSECUTIVE timeouts, with nothing answering in between, before
 *  a timeout is allowed to mean "unreachable".
 *
 *  A REFUSAL IS PROOF; A TIMEOUT IS AN OPINION. A closed socket says the API
 *  is not there and nothing else can explain it. A request that did not
 *  finish in time is consistent with an outage AND with a server that is
 *  simply busy — and this codebase measures the busy case in seconds (§1 L1:
 *  an 8,009ms custody scan on an otherwise 3ms endpoint). Blocking the whole
 *  UX on the first timeout would blank the cockpit during heavy-but-healthy
 *  work, which is a fabricated outage.
 *
 *  So the timeout path needs two strikes AND silence between them: any
 *  answered request at all resets the count, because a server that answered
 *  something is not unreachable. */
export const CONNECTION_TIMEOUT_STRIKES = 2;

/** The budget a request gets while the API is ALREADY KNOWN to be
 *  unreachable. The full 30s is the right budget for a server that might
 *  answer; for one we have just watched fail it is thirty seconds of
 *  nothing, which is precisely the "it does not load" this exists to end.
 *  An explicit per-call `timeoutMs` still wins. */
export const CONNECTION_UNREACHABLE_TIMEOUT_MS = 5_000;

/** How long (ms) the run badge shows "done" status after a run completes
 * before clearing back to "idle". FIX: the run badge showing "DONE"
 * forever was confusing — users thought it was a mysterious "Done" button.
 * This delay lets the user see the completion confirmation, then returns
 * to idle. */
export const RUN_STATUS_CLEAR_DELAY_MS = 3_000;

// ── Hydrated running-tool beats (the reload-orphan reconcile — UIE-042) ──

/**
 * How often a reloaded page re-reads the chat's tool-call rows while any
 * hydrated beat still shows "working" (ms).
 *
 * A page reloaded mid-run never re-attaches to the live run's SSE, so the
 * frames that would settle its in-flight beats — the `tool_result` frames
 * and the terminal frame the client's safety net hangs from — never
 * arrive. The server-side run still finalises its rows on every exit, so
 * the LEDGER is the one authority left: the hydrate path reads the rows
 * once immediately, and while any still read "running" (the run is
 * genuinely still live server-side) re-reads at this cadence until they
 * settle. The run is bounded (iteration limits, provider timeouts), so
 * the poll is too.
 */
export const HYDRATED_TOOL_CALL_RECONCILE_POLL_MS = 5_000;

/**
 * The wall-clock bound on that reconcile (ms). Past it the poll stops
 * WITHOUT settling anything: rows that still read "running" mean the
 * server-side run is itself still live (or wedged), and a working face
 * that matches the server's own record is the honest face — inventing a
 * terminal reason the record does not carry would be fabrication.
 */
export const HYDRATED_TOOL_CALL_RECONCILE_MAX_MS = 10 * 60_000;


/** Minimum dashboard-password length (chars). The SERVER is the authority
 * (`schema.ts` register + `routes/auth.ts` change-password both enforce
 * `z.string.min(8)`); this constant mirrors that policy client-side so
 * the Settings form can pre-validate + label "min N" without a round-trip.
 * A contract test asserts this matches the server's
 * `PASSWORD_MIN_LENGTH` (no drift). */
export const PASSWORD_MIN_LENGTH = 8;

// ── In-memory store caps (single owner, no scattered literals) ──

/** Maximum number of error-log entries retained in the in-memory errors
 * store (`src/state/errors.ts`). Older entries are dropped when the cap is
 * exceeded — enough to inspect a long debugging session without unbounded
 * memory growth in a long session. Client-side in-memory cap (not a server
 * config — the browser cannot read server env). Was a hardcoded `100` in
 * `errors.ts`; moves it to the single client
 * config owner. */
export const ERROR_LOG_MAX_ENTRIES = 100;

// (The service-worker registration fallback delay moved to
// `src/cockpit/shell/config.ts` — the cockpit entry owns registration now,
// and the cockpit import law keeps this module out of its graph.)


/**
 * Default cache lifetime for a Broker read when a block declares no `ttlMs`.
 *
 * Lives here rather than in the Broker because every configurable value has
 * one home. A block may override it per read; this is the floor that applies
 * when none is stated.
 */
export const BROKER_DEFAULT_TTL_MS = 60_000;

// ── Client telemetry (src/state/telemetry.ts owns the mechanism; these are
// its bounds — the flush policy as named constants, per the research record
// research/client-telemetry/RESEARCH.md) ──

/**
 * Events per flush, max — and therefore the buffer's bound: reaching it
 * fires the flush that drains it, so the buffer cannot hold more than one
 * batch in memory. The server's per-batch acceptance cap
 * (server/blocks/client-telemetry.ts) sits above it, so an honest client
 * never trips the server's malformed-batch refusal.
 */
export const TELEMETRY_FLUSH_MAX_EVENTS = 20;

/**
 * Run-correlated metric events per run (the ingest-lag report and any
 * repeats). Beyond the cap the metric is dropped and counted — a looping
 * stream must not mint unbounded ledger rows for one run.
 */
export const TELEMETRY_RUN_METRIC_CAP = 4;

/** Characters kept of a captured error message / stack frame. */
export const TELEMETRY_MESSAGE_MAX_CHARS = 300;
export const TELEMETRY_STACK_HEAD_MAX_CHARS = 200;

/** Ceiling for the client's own dropped-events counter (mirrors the
 * server's per-batch droppedCount bound). */
export const TELEMETRY_DROPPED_MAX = 1_000_000;

