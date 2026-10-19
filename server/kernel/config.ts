/**
 * Server operational configuration — the single source of truth for all
 * server-side tunable literals.
 *
 * Every value has a default, an env-override, and runtime validation.
 * Other server modules import from here; they never declare their own
 * port/host/limit/interval literals.
 *
 * Env overrides:
 *   HARNESS_WEB_PORT          — listen port (default 5174)
 *   HARNESS_WEB_HOST          — bind host (default 127.0.0.1)
 *   HARNESS_WEB_ALLOWED_ORIGIN — CORS allowed origin (default http://127.0.0.1:5173)
 *   HARNESS_WEB_MAX_BODY_BYTES — request body size cap in bytes (default 1 MiB)
 *   HARNESS_WEB_SSE_KEEPALIVE_MS — SSE keepalive interval (default 15 000)
 *   HARNESS_WEB_RUN_STREAM_RETRY_MS — run-stream reconnect cadence (default 3 000);
 *                                the run feed's retention window is floored against it
 *   HARNESS_WEB_DB_PATH        — SQLite projection DB path (default .bridlewise/web.db)
 *   HARNESS_WEB_LLM_FIXTURES   — "1" streams fixture model events instead of a real LLM
 *
 * @config-owner
 */

import { DEFAULT_SQLITE_BUSY_TIMEOUT_MS, engineConfigDocumentPath, ROOT_POLICY } from "./canonical.ts";
import { ConfigError } from "./errors.ts";
import { COMMAND_ENVIRONMENT, isHarnessEnvironmentName, projectEnvironment } from "../../engine/src/process/environment-projection.ts";
import { HarnessError } from "../../engine/src/kernel/errors.ts";
import { RESPONSES_REQUEST_SCHEMA } from "../../engine/src/shared/llm/responses.ts";
// The canonical catalog of key-name parts that mean "this holds a
// credential". Imported, never restated: the admission path and the
// own-credential discovery below must agree about what a sensitive name is.
import { isSensitiveKeyName, normalizeSecretKey } from "../../engine/src/privacy/secret-signals.ts";

function parseInteger(name: string, raw: string, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(
      `Invalid ${name}: expected integer in [${min}, ${max}], got ${raw}`,
    );
  }
  return n;
}

function envInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  return parseInteger(name, raw, min, max);
}

function envString(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw;
}

/** Parse a comma-separated list of allowed root paths. Empty → no restriction. */
function parseAllowedRoots(raw: string): readonly string[] {
  if (raw === "") return [];
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

// ── Defaults (declared once, the authority) ──

export const DEFAULT_PORT = 5174;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_ALLOWED_ORIGIN = "http://127.0.0.1:5173";
export const DEFAULT_MAX_BODY_BYTES = 1 << 20; // 1 MiB
export const DEFAULT_SSE_KEEPALIVE_MS = 15_000;

/**
 * How long a shutdown may take before the process exits regardless.
 *
 * The defect this bounds is a shutdown that never completes: `server.close()`
 * waits for established connections, and an SSE stream never ends by itself,
 * so a server with a standing stream survived SIGTERM entirely (two orphaned
 * processes, measured). `server/index.ts` ends the streams first — this is
 * the backstop, because a fix that can itself hang is not a fix.
 */
export const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;
/**
 * How long a tool subprocess killed for exceeding a bound gets to exit on
 * SIGTERM before it is SIGKILLed.
 *
 * A child that ignores SIGTERM must not be able to hold a run open. The
 * whole reason `execute_command` moved to async `spawn` was so that an
 * abandoned call reaches a TERMINAL state instead of leaving a beat
 * "running" for ever; a polite signal with no follow-up would put the
 * indefinite wait straight back, just one layer down.
 */
export const DEFAULT_TOOL_KILL_GRACE_MS = 2_000;
export const DEFAULT_TIMELINE_DB_PATH = ".bridlewise/timeline.db";
/**
 * Ceiling on the caller-supplied context-window assumption accepted by
 * `synthesis.contextForecast` (the window is an input because no window size
 * is recorded anywhere; this bound only keeps the arithmetic sane).
 */
export const MAX_FORECAST_WINDOW_TOKENS = 10_000_000;
export const DEFAULT_DB_PATH = ".bridlewise/web.db";

// ── The DB thread pool, and the flag that marks one of its threads ──

/**
 * The environment flag the async facade sets on every DB worker thread.
 *
 * It exists so `server/timeline-bridge.ts` can REFUSE to open the timeline
 * ledger there: the ledger has exactly one writer, and a worker opening its
 * own store would both race the chain hash and record events with no ambient
 * causality (AsyncLocalStorage does not cross a thread). The name and the two
 * helpers below live here because this file is the single owner of every
 * `process.env` read in the web slice.
 */
export const DB_WORKER_FLAG = "HARNESS_DB_WORKER";

/** True when the current thread is one of the facade's DB workers. */
export function isDbWorkerThread(): boolean {
  return process.env[DB_WORKER_FLAG] === "1";
}

/** The environment a DB worker thread is started with: this process's, plus
 * the flag. Assembled here so the one `process.env` read stays in the config
 * owner and a new worker cannot be spawned without the flag. */
export function dbWorkerEnv(): NodeJS.ProcessEnv {
  return { ...process.env, [DB_WORKER_FLAG]: "1" };
}

/**
 * READ POOL SIZING, as named numbers rather than inline literals.
 *
 * Reads through the facade are CPU-bound — SQLite's own work is ~14% of a
 * whole-conversation read, AES decryption ~49%, Zod validation most of the
 * rest — so the useful pool size is bounded by CORES, not by how many requests
 * are in flight. `RESERVED` keeps the main thread, the writer thread and
 * libuv's own pool out of contention with the pool that exists to free them.
 */
export const DB_READ_POOL_MIN = 2;
export const DB_READ_POOL_MAX = 8;
export const DB_READ_POOL_RESERVED_CORES = 4;
export const DEFAULT_PROJECT_ROOT = process.cwd();
/*
 * THERE IS NO DEFAULT LLM CONFIG PATH AND NO DEFAULT MODEL, DELIBERATELY.
 *
 * Two constants lived here — a path under `/tmp` holding the provider base
 * URL and API key, and a model name that overrode whatever the user had
 * chosen. Both were FALLBACK SOURCES: a second place the server went looking
 * for an answer the user gives in Settings, consulted exactly when the real
 * answer was missing, which is when nobody is watching. Providers and models
 * now come from the database and from nowhere else, so a default here would
 * have nothing to be a default FOR.
 *
 * This is not the same as a default VALUE. A timeout, a page size or a
 * keepalive interval below is a resolved answer for a configurable nobody has
 * an opinion about, and those are correct and expected. A default CREDENTIAL
 * or a default IDENTITY is a different thing entirely.
 */
export const DEFAULT_RATE_LIMIT = 60; // requests per minute per session
/**
 * Rate-limiter token-bucket refill window (ms). The bucket refills
 * continuously over this window; `rateLimitPerMinute` tokens are added per
 * window. Default 60 000 (1 minute) — the unit that defines "per minute".
 * Configurable so the refill smoothing can be tuned independently of the
 * per-minute rate (the literal
 * 60_000 previously lived inline in rate-limiter.ts). Env:
 * `HARNESS_WEB_RATE_LIMIT_REFILL_MS`.
 */
export const DEFAULT_RATE_LIMIT_REFILL_MS = 60_000;
/**
 * File-tree depth + entry caps (exp519: the file explorer froze because
 * `countLines` did a synchronous readFileSync of every file, and the depth
 * was capped at 5 ("doesn't go more than 4 levels down"). These are now
 * configurable with higher defaults; line counting is opt-in so the bulk
 * walk only stats files (fast) instead of reading them (the freeze cause).
 */
export const DEFAULT_FILE_TREE_MAX_DEPTH = 10;
export const DEFAULT_FILE_TREE_MAX_ENTRIES = 2000;
// ── Server-operational tunables (single owner; previously these
//    were scattered inline constants — git-bridge 5_000, git-ops-bridge
//    10_000, auto-check-runner 120_000, editor-bridge 1MiB/10MiB,
//    awareness-bridge 60_000). Centralized here so each has one owner +
//    an env override. ──
export const DEFAULT_GIT_TIMEOUT_MS = 10_000;
/**
 * Cap on the number of commit entries the git log accessors return
 * (`git log -<n>`). Previously the literal
 * `100` was scattered across FOUR call sites — `MAX_LOG_ENTRIES` in
 * git-ops-bridge.ts, `Math.min(..., 100)` in routes/git-ops.ts, `Math.min(
 * args.max, 100)` in tool-executor.ts, and `maximum: 100` in the tools-
 * bridge manifest — so the cap drifted (the route defaulted to 50, the
 * LLM tool to 20, for the SAME operation). Centralized here as the single
 * owner; every call site + the manifest derive from it.
 * Env: `HARNESS_WEB_GIT_MAX_LOG_ENTRIES`.
 */
export const DEFAULT_GIT_MAX_LOG_ENTRIES = 100;
/**
 * Default number of commit entries returned when a caller omits `max`.
 * The HTTP route defaulted to 50 + the LLM `git_log` tool to 20
 * — two different defaults for the same operation (drift). Centralized
 * here; both consumers now read this single default. Env:
 * `HARNESS_WEB_GIT_LOG_DEFAULT_ENTRIES`.
 */
export const DEFAULT_GIT_LOG_DEFAULT_ENTRIES = 50;
export const DEFAULT_TYPECHECK_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_FILE_READ_BYTES = 1 << 20; // 1 MiB
export const DEFAULT_MAX_FILE_EDIT_BYTES = 10 << 20; // 10 MiB
export const DEFAULT_AWARENESS_SNAPSHOT_TTL_MS = 60_000;
/**
 * The `harness_session` (anonymous isolation) cookie max-age in seconds.
 * Default: 1 year (the browser keeps the isolation scope across long
 * gaps). Previously an inline `60*60*24*365` literal in
 * session.ts; now a single config owner. Env: `HARNESS_WEB_SESSION_COOKIE_MAX_AGE`.
 */
export const DEFAULT_SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Default auth session TTL in hours (30 days = 720 hours). The single owner
 * of the session-expiry default; consumed by `resolveServerConfig`. Env:
 * `HARNESS_WEB_AUTH_SESSION_TTL_HOURS` (0 disables expiry).
 */
export const DEFAULT_AUTH_SESSION_TTL_HOURS = 720;

/**
 * Default dashboard username. Every other env-overridable value declared its
 * default as a named constant here; this one was an inline `"admin"` at the
 * `envString` call site, so the single place you look for "what does this
 * default to" did not list it. Env: `HARNESS_WEB_AUTH_USERNAME`.
 */
export const DEFAULT_AUTH_USERNAME = "admin";

/**
 * Default session-rotation period in hours (1 day = 24 hours). The single
 * owner of the rotation-interval default. Env:
 * `HARNESS_WEB_SESSION_ROTATION_HOURS` (0 disables rotation).
 */
export const DEFAULT_SESSION_ROTATION_HOURS = 24;

/**
 * Minimum dashboard-password length (chars). The single server-side owner
 * of the auth password policy, consumed by BOTH the register schema
 * (`server/db/schema.ts`) AND the change-password route
 * (`server/routes/auth.ts`) — the `8` was
 * duplicated across two server files + the frontend SettingsPanel; now
 * each consumer reads this one owner. The frontend mirrors it via
 * `PASSWORD_MIN_LENGTH` in `src/client-config.ts` (a contract test
 * asserts no drift). Env: `HARNESS_WEB_PASSWORD_MIN_LENGTH`.
 */
export const DEFAULT_PASSWORD_MIN_LENGTH = 8;

/**
 * Git short-hash display length (chars). The number of hex chars shown when
 * a commit hash is abbreviated for display (e.g. the git log short-hash
 * column). The single owner of the slice length that was previously an
 * inline literal. Env: `HARNESS_WEB_GIT_SHORT_HASH_LENGTH`.
 */
export const DEFAULT_GIT_SHORT_HASH_LENGTH = 7;

/**
 * THE RESOLUTION OF A GIT COMMIT TIMESTAMP — one second, and NOT a tunable.
 *
 * Git stores a commit's author/committer time as a whole number of seconds
 * since the epoch (the `<unix-ts> <tz>` pair in the raw commit object). Every
 * rendering of it inherits that resolution: `%aI` emits
 * `2026-07-27T05:29:18-04:00` and never a fractional second, so
 * `Date.parse(entry.date)` is always an exact multiple of this number.
 *
 * It lives with the other git constants because it is a property of git's
 * storage format, and it is deliberately NOT env-overridable: it describes
 * what git DOES, not what an operator prefers. Widening it would silently
 * admit effects a commit could not have contained; narrowing it re-opens the
 * fabricated absence it exists to prevent (`joinHistory`, custody.ts).
 *
 * A commit stamped at second S therefore covers the half-open interval
 * [S, S + GIT_COMMIT_TIME_RESOLUTION_MS): a millisecond-resolution ledger
 * time inside that interval is WITHIN the commit's second, not after it.
 */
export const GIT_COMMIT_TIME_RESOLUTION_MS = 1000;

/**
 * How long a provider connection test may take before it is abandoned, in ms.
 *
 * A run may retry a flaky provider for a long time, because a run has work to
 * finish and the user has already committed to waiting. A CONNECTION TEST has
 * the opposite shape: a person is sitting in Settings watching a button,
 * wanting to know whether they typed their key correctly. Measured on an
 * unreachable address, the shared client's own retry-and-backoff took 7.4 s to
 * give up — an answer that arrives long after the user has concluded the
 * button is broken. Bounded here so the probe is still real and still honest,
 * and reports "no answer within N seconds" instead of stalling.
 *
 * Env: `HARNESS_WEB_PROVIDER_TEST_TIMEOUT_MS`.
 */
export const DEFAULT_PROVIDER_TEST_TIMEOUT_MS = 5_000;
/** Output-token ceiling for the single connection-test request. A reasoning
 * model can spend a one-token ceiling before producing an answer. This
 * bounded default is sufficient for the observed Runinfra ping, not a promise
 * for every model. Env: `HARNESS_WEB_PROVIDER_TEST_MAX_TOKENS`. */
export const DEFAULT_PROVIDER_TEST_MAX_TOKENS = 256;
/** Bound catalog transfer before decoding or rendering untrusted model entries. */
export const DEFAULT_PROVIDER_DISCOVERY_MAX_BYTES = 2_097_152;
/** Admissible range for `HARNESS_WEB_PROVIDER_DISCOVERY_MAX_BYTES`. */
const PROVIDER_DISCOVERY_MAX_BYTES_MIN = 1_024;
const PROVIDER_DISCOVERY_MAX_BYTES_MAX = 16_777_216;

/**
 * Max number of rate-limiter token-bucket keys retained in memory (the LRU
 * cap). Bounds memory so a spoofed-key attack cannot grow the buckets Map
 * without bound. Default 10 000. Env: `HARNESS_WEB_RATE_LIMIT_MAX_BUCKETS`.
 */
export const DEFAULT_RATE_LIMIT_MAX_BUCKETS = 10_000;

/**
 * Max concurrent RUN streams per user (multi-tab dev cap). Default 8 —
 * generous for a developer with several tabs, caps a runaway client that
 * opens streams without closing them. Env:
 * `HARNESS_WEB_SSE_MAX_CONNECTIONS_PER_USER`.
 *
 * A run stream carries a run: it is per-RUN, it executes work, and eight
 * simultaneous runs for one person is already past what a human drives.
 * The standing liveness beat is a different thing entirely and draws on a
 * different budget — see below.
 */
export const DEFAULT_SSE_MAX_CONNECTIONS_PER_USER = 8;

/**
 * Max concurrent LIVENESS streams per user — a SEPARATE budget, and the
 * separation is the fix for a measured, user-blocking defect.
 *
 * ── WHAT HAPPENED WHEN THE TWO SHARED ONE BUDGET ───────────────────────────
 *
 * `/api/live` is a STANDING connection with `retry: LIVE_STREAM_RETRY_MS`
 * (250ms). Sharing the run budget meant that once eight streams of ANY kind
 * were open for one identity, every liveness reconnect was refused with 429 —
 * and the browser, obeying the retry cadence the server itself wrote, asked
 * again four times a second, forever. The page could not recover on its own;
 * only restarting the API cleared it. Browser-observed as an endless
 * `GET /api/live 429` storm, with the cockpit blocked behind "The harness API
 * is not answering" over a server that was answering every request put to it.
 *
 * ── WHY THE SEPARATION IS THE RIGHT SHAPE, NOT MERELY A BIGGER NUMBER ──────
 *
 * THE STREAM WHOSE ENTIRE JOB IS DETECTING OUTAGES WAS THE FIRST CASUALTY OF
 * LOAD. The instrument failed exactly when it was most needed and then
 * reported "offline" for a healthy server — a false statement manufactured by
 * our own limiter. An outage detector that competes for budget with the work
 * it observes is not a detector; raising the shared number would only move
 * the point at which it lies.
 *
 * The two are not the same resource. A run stream executes and streams a run.
 * A liveness beat is a payload-free public keepalive, one per TAB (the client
 * holds exactly one socket per page — `startLivenessWatch`), bounded by how
 * many tabs a human opens rather than by anything the server does.
 *
 * ── THE NUMBER ─────────────────────────────────────────────────────────────
 *
 * 32. Multi-tab is a deliberate product decision, not abuse: several browser
 * windows plus several in-page workspaces is the NORMAL case here. 32 is
 * roughly four times the tab count a person plausibly holds open, which
 * leaves headroom for slots not yet released (a reloaded tab's old socket
 * lives until the server sees its FIN). It is still a bound — an attacker
 * cannot open unbounded streams — and 32 file descriptors plus 32 keepalive
 * intervals is nothing beside the run pool.
 *
 * Env: `HARNESS_WEB_SSE_MAX_LIVENESS_CONNECTIONS_PER_USER`. The resolved
 * value is FLOORED at the run budget (`resolveServerConfig`) so no
 * configuration can put the outage detector back in the scarcer position.
 */
export const DEFAULT_SSE_MAX_LIVENESS_CONNECTIONS_PER_USER = 32;

/**
 * The `Retry-After` seconds sent with a 429 when the SSE per-user connection
 * cap is exceeded. Default 5. Env:
 * `HARNESS_WEB_SSE_CONNECTION_RETRY_AFTER_SECONDS`.
 */
export const DEFAULT_SSE_CONNECTION_RETRY_AFTER_SECONDS = 5;

/**
 * Rows fetched per statement by the per-chat history reads (messages, tool
 * calls, metrics snapshots, timeline refs) in `server/db/client.ts`.
 *
 * Those four SELECTs had no `LIMIT` at all: a single chat-history read
 * materialised every row of a chat, then AES-decrypted and Zod-validated
 * each one. On a long conversation that is an unbounded latency + memory
 * cost driven entirely by how much the user has talked.
 *
 * This is a PAGE SIZE, not a cap on what the caller receives — the reads
 * walk pages until the table is exhausted, so no row is ever silently
 * dropped (a history that quietly lost its oldest messages would be a
 * worse bug than the one this fixes). It bounds the work done per
 * statement, which is what makes the cost incremental instead of a single
 * unbounded materialisation. Default 500. Env:
 * `HARNESS_WEB_CHAT_HISTORY_PAGE_ROWS`.
 */
export const DEFAULT_CHAT_HISTORY_PAGE_ROWS = 500;

/**
 * Messages per HISTORY PAGE — the bound on what one `/history` response
 * carries (DESIGN-PERFORMANCE §4). Distinct from
 * `DEFAULT_CHAT_HISTORY_PAGE_ROWS` above, which bounds the rows per
 * STATEMENT inside a read that still returns everything.
 *
 * Default 200. Measured on the `heavy` fixture's 20,000-message
 * conversation: 75.1MB / 21,405 messages is 3.5KB per message, so 200
 * messages is ~700KB of message content — which is why the row bound is
 * not the only bound (see `DEFAULT_CHAT_HISTORY_PAGE_BYTES`). Two hundred
 * beats is also more than a 900px viewport can show at any fisheye level,
 * so the tail page always fills the screen with room to spare.
 * Env: `HARNESS_WEB_CHAT_HISTORY_TAIL_ROWS`.
 */
export const DEFAULT_CHAT_HISTORY_TAIL_ROWS = 200;

/**
 * How many frames one run's replay buffer holds.
 *
 * A run's output is published to an append-only, sequence-numbered feed that
 * subscribers read from, so a subscriber that arrives late — or comes back
 * after its socket dropped — replays what it missed instead of starting a
 * second run to see the beginning. That buffer is memory, so it is bounded:
 * past this many frames the oldest are dropped and the feed records the
 * highest sequence it can no longer serve. A subscriber asking for something
 * older is told plainly that the earlier frames are gone, which is the honest
 * answer; the durable record of the run is the chat projection, not this.
 *
 * Default 4 000 — comfortably more than a long tool-using turn emits (a text
 * delta is one frame), so the common reconnect replays everything.
 * Env: `HARNESS_WEB_RUN_FEED_MAX_FRAMES`.
 */
export const DEFAULT_RUN_FEED_MAX_FRAMES = 4_000;

/**
 * What the server tells a browser to wait before reconnecting a RUN stream,
 * written into the stream as SSE's own `retry:` field. Default 3 000 ms.
 *
 * WHY THE SERVER STATES IT AT ALL. Without a `retry:` the browser uses its
 * own value — "a few seconds", chosen per implementation and not the same
 * across them. That is survivable right up until something has to be measured
 * against it, and something does: a finished run's feed is retained precisely
 * so a dropped client can come back, and "long enough for it to come back" is
 * a claim about this interval. A window floored against a number nobody here
 * owns is a threshold resting on someone else's default.
 *
 * It is deliberately NOT the liveness stream's 250 ms
 * (`LIVE_STREAM_RETRY_MS`). That cadence bounds OUTAGE DETECTION on an idle
 * tab and is paid for by a payload-free beat. A run stream reconnect replays
 * the run's buffered frames, so four attempts a second against a server that
 * is merely busy would be expensive and would buy nothing: the run is
 * executing on the server either way, and the record is waiting when the
 * client arrives. Env: `HARNESS_WEB_RUN_STREAM_RETRY_MS`.
 */
export const DEFAULT_RUN_STREAM_RETRY_MS = 3_000;

/**
 * THE HTTP SERVER'S OWN CLOCKS — how long a client may take to send a
 * request's headers (`HARNESS_WEB_HEADERS_TIMEOUT_MS`, default 60 000), the
 * whole request (`HARNESS_WEB_REQUEST_TIMEOUT_MS`, default 300 000; a
 * streamed RESPONSE is not bounded by it, only the upload), and how long an
 * idle keep-alive socket is held (`HARNESS_WEB_KEEP_ALIVE_TIMEOUT_MS`,
 * default 5 000). The defaults are the platform's; stating them here makes
 * them the operator's. A headers bound past the request bound is REFUSED at
 * boot (`http_headers_timeout_exceeds_request`: the platform cannot honour
 * it, and a floor raised in silence would run a value nobody set — floors are
 * refused, not raised).
 */
export const DEFAULT_HEADERS_TIMEOUT_MS = 60_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
export const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 5_000;
const HTTP_TIMEOUT_MIN = 1_000;
const HTTP_TIMEOUT_MAX = 3_600_000;
const KEEP_ALIVE_TIMEOUT_MIN = 100;
const KEEP_ALIVE_TIMEOUT_MAX = 600_000;

/**
 * How long a finished run's feed is retained so a subscriber can still reach
 * it. Default 120 000 ms (2 minutes).
 *
 * This is the window in which a client whose connection dropped as the run was
 * ending can reconnect, replay the tail, and see the terminal frame — the
 * reason it exists at all is that a dropped socket used to make a run
 * permanently unreachable. Nothing is lost when the window closes: the run's
 * messages, tool calls and timeline are already in the database.
 * Env: `HARNESS_WEB_RUN_FEED_RETENTION_MS`.
 *
 * ── THE FLOOR IS DERIVED, AND ITS ABSENCE RE-OPENED THE DEFECT ─────────────
 *
 * The declared minimum used to be 0, and 0 released the feed the instant the
 * run ended. Driven at that minimum: the reconnect a run stream exists to
 * serve got `404`, and a FOREIGN user asking about a finished run got `404`
 * too — collapsing the 403/404 distinction the run routes were rebuilt to
 * preserve. So the whole of the fix was reachable by setting one environment
 * variable to a value the configuration itself advertised as legal.
 *
 * A configurable whose floor undoes the fix is not a configurable. The window
 * is now floored at `RUN_FEED_RETENTION_RECONNECTS_MIN` reconnect intervals
 * (`resolveServerConfig`), so it is stated in terms of the thing it must
 * outlast rather than as a number that has to be remembered. Raising or
 * lowering the reconnect cadence moves the floor with it, which is the
 * property a bare literal could not have.
 */
export const DEFAULT_RUN_FEED_RETENTION_MS = 120_000;

/**
 * The BYTE budget for one history page — the bound that actually holds.
 *
 * A row bound is not a payload bound: one tool call returning a 5MB file
 * makes a 200-row page a 5MB response, and §5's table asks for **< 500KB**
 * for any single collection response. So a page ends at whichever bound is
 * reached first, and the cursor says there is more either way.
 *
 * 400_000 rather than 500_000: the budget is measured over the CONTENT
 * bytes a page's rows carry (message text, metadata, tool-call input and
 * output), which is what dominates the response but is not all of it —
 * JSON structure, keys and ids are the remainder. The headroom is the
 * difference, and `tests/prevention/history-payload-bounded.test.ts`
 * measures the real serialized response rather than trusting the estimate.
 *
 * A page always carries AT LEAST ONE message, whatever its size: returning
 * an empty page while claiming there is more would be a cursor that never
 * advances, which is a hang rather than a bound.
 * Env: `HARNESS_WEB_CHAT_HISTORY_PAGE_BYTES`.
 */
export const DEFAULT_CHAT_HISTORY_PAGE_BYTES = 400_000;

/**
 * SQLite `PRAGMA synchronous` for the web DB — the DURABILITY CHOICE, made
 * here rather than inherited from SQLite's compiled-in default.
 *
 * `server/db/client.ts` set `journal_mode = WAL` and said nothing about
 * `synchronous`, which leaves it at SQLite's default of FULL: a value nobody
 * in this codebase chose. Measured on this machine on real ext4 (NOT
 * `os.tmpdir()`, which is tmpfs where fsync is a no-op and every durability
 * comparison is meaningless):
 *
 *     one 4KB write + fsync, project disk     5.04 ms   (tmpdir: 0.002 ms)
 *     createMessage, auto-commit             11.05 ms
 *       ↳ the INSERT alone                    5.04 ms
 *       ↳ the chats.updated_at UPDATE alone   5.03 ms
 *       ↳ everything that is not fsync       ~17 µs
 *
 * So a message write is two fsyncs and 17µs of work. NORMAL removes the
 * per-commit fsync; it removes NOTHING else. Every byte is still written,
 * every constraint still enforced, every row still encrypted at rest.
 *
 * What NORMAL actually risks: a PROCESS crash loses nothing (the WAL frames
 * are in the OS and replay on next open — which is what the data-loss suite
 * verifies); an OS crash or power loss can lose commits since the last
 * checkpoint, and SQLite guarantees the file is never CORRUPTED in this mode.
 *
 * The checkpoint cadence reduces exposure but is not a maximum loss bound.
 * Env: `HARNESS_WEB_DB_SYNCHRONOUS`.
 */
export const DEFAULT_DB_SYNCHRONOUS = "NORMAL";

/** Accepted `PRAGMA synchronous` values. A value outside this set is refused
 * rather than passed to SQLite — the pragma is interpolated into SQL, and
 * "the config said so" is not a reason to interpolate an arbitrary string. */
export const DB_SYNCHRONOUS_VALUES = ["OFF", "NORMAL", "FULL", "EXTRA"] as const;

/** Requested best-effort checkpoint cadence under NORMAL. Active readers,
 * scheduling and I/O failures can extend completion beyond this interval.
 * The returned checkpoint row measures progress, not per-event fsync.
 * Zero disables this timer; it does not prove zero crash-loss exposure.
 * Env: HARNESS_WEB_DB_DURABILITY_WINDOW_MS. */
export const DEFAULT_DB_DURABILITY_WINDOW_MS = 1_000;
/** Shared SQLite busy-handler range; zero means immediate refusal. */
const DB_BUSY_TIMEOUT_MIN = 0;
const DB_BUSY_TIMEOUT_MAX = ROOT_POLICY.timeline.limits.maxSqliteBusyTimeoutMs;
const DB_DURABILITY_WINDOW_MIN = 0;
/**
 * How many pre-migration copies of the database are kept (`<db>.pre-v<N>`),
 * newest first. A copy holds every row as it stood — rows a user later
 * deleted included — so copies are purged past this count after each new one
 * is verified (secb-design F-8). At least one: an upgrade is forward-only.
 */
export const DEFAULT_DB_BACKUP_RETENTION = 2;
const DB_BACKUP_RETENTION_MIN = 1;
const DB_BACKUP_RETENTION_MAX = 32;
const DB_DURABILITY_WINDOW_MAX = 60_000;
/**
 * THE DATABASE THREADS' RESTART CIRCUIT (SCALE-CR1 C4). A database thread
 * that dies is respawned (a reader's reads retried, a writer's in-flight
 * writes answered `db_write_outcome_unknown`); more than this many restarts
 * within the window opens the circuit: the facade answers `db_unavailable`
 * (retryable) for the window, then tries again — never a permanent outage.
 * Env: HARNESS_WEB_DB_THREAD_RESTART_MAX / HARNESS_WEB_DB_THREAD_RESTART_WINDOW_MS.
 */
export const DEFAULT_DB_THREAD_RESTART_MAX = 5;
export const DEFAULT_DB_THREAD_RESTART_WINDOW_MS = 60_000;
const DB_THREAD_RESTART_MAX_MIN = 1;
const DB_THREAD_RESTART_MAX_MAX = 1_000;
const DB_THREAD_RESTART_WINDOW_MIN = 1_000;
const DB_THREAD_RESTART_WINDOW_MAX = 3_600_000;

/**
 * The default subprocess environment allowlist is the environment
 * projection's `COMMAND_ENVIRONMENT` (engine/src/process/environment-projection.ts:
 * the minimal set, HOME, and the proxy variables forwarded WITHOUT userinfo).
 * Deny-by-default: every var NOT matching an entry is dropped so secrets
 * never leak into a subprocess, and no allowlist may name the harness's own
 * `HARNESS_*` namespace (refused by the projection's one entry rule).
 * `GIT_OPTIONAL_LOCKS=0` is ALWAYS added (the git no-lock-file optimization)
 * regardless of the allowlist. Override the whole set via
 * `HARNESS_WEB_SUBPROCESS_ENV_ALLOWLIST` (comma-separated; a custom value
 * REPLACES the default — deny-by-default).
 */
/**
 * ── THE THREE WILDCARDS WERE THE HOLE, AND A LONGER LIST IS NOT THE FIX ───
 *
 * This used to pass `GIT_*`, `NODE_*` and `npm_*` wholesale. Each of those
 * families contains variables that make a child process EXECUTE something the
 * parent did not name:
 *
 *   GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n — documented git
 *     configuration injected at HIGHER precedence than any file, and untouched
 *     by `GIT_CONFIG_GLOBAL=/dev/null`. Measured: with both of those pointed at
 *     `/dev/null`, `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor` still
 *     ran the named program.
 *   GIT_SSH_COMMAND, GIT_EXTERNAL_DIFF, GIT_PAGER, GIT_EDITOR — each names a
 *     program git will run. GIT_DIR / GIT_WORK_TREE repoint the repository.
 *   NODE_OPTIONS — `--require` loads arbitrary code into every child node.
 *   npm_config_* — the environment form of `.npmrc`, including `node-options`.
 *
 * The previous defence was to neutralise the two variables that had been
 * noticed. That is a LIST, and it was measured incomplete the moment somebody
 * looked for a third. The structural answer is the one this allowlist was
 * built on and then undermined: name the variables that are needed, and let
 * everything else be denied because nothing granted it — so a family member
 * invented next year is denied without anybody having heard of it.
 *
 * WHAT IS LOST, AND WHY IT IS NOTHING: git reads authorship from the
 * repository's own configuration and this server's git is read-only anyway;
 * `NODE_*` and `npm_*` are set by whatever launched the SERVER and passing
 * them into an unrelated child was never intentional — an `npm_config_*` from
 * the server's own start-up leaking into a project's build is a bug in its own
 * right. `GIT_OPTIONAL_LOCKS=0` is added unconditionally below, so the one git
 * variable this server actually wants is not part of the question.
 *
 * An operator who genuinely needs one can name it: the allowlist is
 * configurable through `HARNESS_WEB_SUBPROCESS_ENV_ALLOWLIST`, and naming a
 * variable is the explicit add that §4 asks for.
 */

/**
 * THE ONE ENV PROJECTION: the subset of `env` an allowlist admits. A var
 * passes iff its name exactly matches an allowlist entry OR matches an entry
 * ending in `*` as a prefix. Deny-by-default: a var not matching any entry is
 * dropped so secrets never leak to subprocesses. Each consumer passes its own
 * list — model-run commands `HARNESS_WEB_SUBPROCESS_ENV_ALLOWLIST` (plus the
 * git optimization, see `subprocessEnv`), MCP stdio servers
 * `tools.mcp.stdioInheritedEnv`.
 */
function buildSubprocessEnv(
  env: NodeJS.ProcessEnv,
  allowlist: readonly string[],
): Readonly<Record<string, string>> {
  // THE ONE PROJECTION (engine/src/process/environment-projection.ts); its
  // bare-`*` refusal is this owner's configuration error.
  try {
    return projectEnvironment(env, allowlist);
  } catch (error) {
    if (error instanceof HarnessError) throw new ConfigError(error.message);
    throw error;
  }
}

/**
 * This process's environment projected through a consumer's allowlist (see
 * `buildSubprocessEnv`) — the one place outside the config snapshot that
 * reads `process.env` for a child: an MCP stdio server's inherited base
 * (`tools.mcp.stdioInheritedEnv`).
 */
export function inheritedProcessEnv(allowlist: readonly string[]): Readonly<Record<string, string>> {
  return buildSubprocessEnv(process.env, allowlist);
}

/**
 * The environment a child inherits when its caller names none — the whole of
 * this process's, as `spawn` would pass it — for the spawn door, which must
 * add to it (a confined child's private temp folder). A copy: additions never
 * reach this process.
 */
export function inheritedEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env };
}

/**
 * Parse a comma-separated allowlist string into a trimmed array. Empty
 * segments are dropped. Returns the empty array when the input is empty
 * (the caller then falls back to the default allowlist).
 */
function parseAllowlist(raw: string): readonly string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// The harness config is the ENGINE's own document, located by its one owner
// (`engineConfigDocumentPath`), so the path is correct regardless of the
// process working directory and is spelled in one place.
export const DEFAULT_HARNESS_CONFIG_PATH = engineConfigDocumentPath();

// Validation bounds
//
// Port 0 is admitted: it is the OS-assigned ephemeral bind, the only way a
// launcher can obtain a free port atomically (any chosen-and-closed number is
// a probe a concurrent process can claim before the bind). The kernel — never
// the config — picks the real port, so 0 here is "let the OS choose", not a
// listenable address, and the readiness line reports the assigned number.
const PORT_MIN = 0;
const PORT_MAX = 65_535;
const BODY_BYTES_MIN = 1;
const BODY_BYTES_MAX = 100 << 20; // 100 MiB hard ceiling
const KEEPALIVE_MIN = 1_000; // 1s floor to avoid tight loops
const KEEPALIVE_MAX = 300_000; // 5min ceiling
const RATE_LIMIT_MIN = 1;
const RATE_LIMIT_MAX = 10_000;
const RATE_LIMIT_REFILL_MIN = 1_000; // 1s floor (below this the refill loop is too tight)
const RATE_LIMIT_REFILL_MAX = 600_000; // 10min ceiling
const FILE_TREE_DEPTH_MIN = 1;
const FILE_TREE_DEPTH_MAX = 50;
const FILE_TREE_ENTRIES_MIN = 1;
const FILE_TREE_ENTRIES_MAX = 100_000;
const GIT_TIMEOUT_MIN = 100;
const GIT_TIMEOUT_MAX = 600_000;
const GIT_MAX_LOG_MIN = 1;
const GIT_MAX_LOG_MAX = 10_000;
const GIT_LOG_DEFAULT_MIN = 1;
const GIT_LOG_DEFAULT_MAX = 10_000;
const TYPECHECK_TIMEOUT_MIN = 1_000;
const TYPECHECK_TIMEOUT_MAX = 600_000;
const FILE_BYTES_MIN = 1024;
const FILE_BYTES_MAX = 100 << 20; // 100 MiB hard ceiling (matches body cap)
const AWARENESS_TTL_MIN = 1_000;
const AWARENESS_TTL_MAX = 600_000;
const GIT_SHORT_HASH_MIN = 4;
const GIT_SHORT_HASH_MAX = 40;
const PROVIDER_TEST_TIMEOUT_MIN = 250; // below this, a healthy provider fails
const PROVIDER_TEST_TIMEOUT_MAX = 60_000; // a minute of waiting is already too long
const PROVIDER_TEST_MAX_TOKENS_MIN = RESPONSES_REQUEST_SCHEMA.shape.max_output_tokens.unwrap().unwrap().minValue!;
const PROVIDER_TEST_MAX_TOKENS_MAX = 4_096;
const RATE_LIMIT_MAX_BUCKETS_MIN = 1;
const RATE_LIMIT_MAX_BUCKETS_MAX = 1_000_000;
const SSE_MAX_CONNECTIONS_MIN = 1;
const SSE_MAX_CONNECTIONS_MAX = 10_000;
// Hour-valued session windows. 0 means "disabled" (no expiry / no rotation)
// and 8760 is one year — the same pair for both, named once rather than
// repeated as bare literals at two call sites.
const SESSION_HOURS_MIN = 0;
const SESSION_HOURS_MAX = 24 * 365;
const SESSION_COOKIE_MAX_AGE_MIN = 60; // 1 minute floor
const SESSION_COOKIE_MAX_AGE_MAX = DEFAULT_SESSION_COOKIE_MAX_AGE * 10; // 10 years
const SSE_RETRY_AFTER_MIN = 1;
const SSE_RETRY_AFTER_MAX = 3_600;
// Chat-history page size. Floor 1 (a page must make progress — a 0 page
// size would loop forever); ceiling 100 000 so an operator cannot restore
// the unbounded behaviour by setting an absurd page size.
const CHAT_HISTORY_PAGE_ROWS_MIN = 1;
const CHAT_HISTORY_PAGE_ROWS_MAX = 100_000;
const CHAT_HISTORY_TAIL_ROWS_MIN = 1;
/** The row bound may be raised, but never to "unbounded": the cursor's whole
 *  claim is that no single response grows with the conversation. */
const CHAT_HISTORY_TAIL_ROWS_MAX = 2_000;
const CHAT_HISTORY_PAGE_BYTES_MIN = 1_000;
const CHAT_HISTORY_PAGE_BYTES_MAX = 4_000_000;
// Run replay buffer. Floor 1 — a feed that holds nothing cannot answer a
// reconnect at all, and "0 frames" would make every subscriber's replay a
// silent nothing rather than an honest gap. Ceiling 200 000 so an operator
// cannot turn a bounded per-run buffer back into an unbounded one.
const RUN_FEED_MAX_FRAMES_MIN = 1;
const RUN_FEED_MAX_FRAMES_MAX = 200_000;
// Run-stream reconnect cadence. Floor 100ms — below that a reconnect storm
// costs more than the stream it is trying to restore. Ceiling one minute:
// past that a client whose socket dropped mid-run is staring at a frozen
// transcript for longer than most runs take.
const RUN_STREAM_RETRY_MS_MIN = 100;
const RUN_STREAM_RETRY_MS_MAX = 60_000;
// HOW MANY RECONNECT ATTEMPTS A FINISHED RUN'S FEED MUST OUTLAST.
//
// The retention window exists so a client that dropped as the run ended can
// come back and find the record. One interval is the minimum for the attempt
// to happen at all; two is the minimum for it to happen AFTER the browser has
// noticed the socket died, which is itself an interval away on the graceful
// close that ends every run. Below this the reconnect meets a 404 and the
// 403/404 distinction collapses with it — the defect the window was built to
// close, reachable through the window's own configuration.
const RUN_FEED_RETENTION_RECONNECTS_MIN = 2;
// What an operator may WRITE, which is not the same as what takes effect. 0 is
// accepted at the parse so that "I want the smallest window you will give me"
// is expressible without a startup failure; the DERIVED floor above then
// decides what the smallest window actually is. Stated as a floor rather than
// a rejection for the same reason as the two SSE budgets: changing the
// reconnect cadence alone must move the floor, not invalidate a retention
// setting that was legal when it was written.
const RUN_FEED_RETENTION_MS_PARSE_MIN = 0;
// Ceiling one hour; beyond that the buffer is a cache of finished work nobody
// is coming back for.
const RUN_FEED_RETENTION_MS_MAX = 3_600_000;

// ── Resolved config (evaluated once at import time) ──

export type ServerConfig = Readonly<{
  readonly port: number;
  readonly host: string;
  readonly allowedOrigin: string;
  readonly maxBodyBytes: number;
  /** How long a client may take to send a request's headers (`DEFAULT_HEADERS_TIMEOUT_MS`); past `requestTimeoutMs` is refused at boot. */
  readonly headersTimeoutMs: number;
  /** How long a client may take to send a whole request (`DEFAULT_REQUEST_TIMEOUT_MS`). */
  readonly requestTimeoutMs: number;
  /** How long an idle keep-alive socket is held (`DEFAULT_KEEP_ALIVE_TIMEOUT_MS`). */
  readonly keepAliveTimeoutMs: number;
  readonly sseKeepaliveMs: number;
  readonly timelineDbPath: string;
  readonly dbPath: string;
  readonly projectRoot: string;
  readonly harnessConfigPath: string;
  /** rate limiting — max requests per minute per session. */
  readonly rateLimitPerMinute: number;
  /** Rate-limiter token-bucket refill window (ms). Default 60 000 (1 min). */
  readonly rateLimitRefillMs: number;
  /** path validation — comma-separated allowed root paths for project creation. */
  readonly allowedProjectRoots: readonly string[];
  /** DB encryption key (env: HARNESS_WEB_DB_KEY). When set, this passphrase
   * is the persisted secret: the AES-256 key is derived from it via scrypt
   * over a random salt kept in the key home (no key file is used). When empty
   * (the default), a 32-byte random key is persisted to a key file in the
   * key home (`engine/src/filesystem/self-protection/key-home.ts`, mode
   * 0600, outside every checkout; relocated by `HARNESS_KEY_HOME`) — this is
   * the fix for the per-process random key bug that lost every project's
   * path on reboot. See server/db/db-crypto.ts. */
  readonly dbEncryptionKey: string;
  /** UNMENTIONED #5: Session rotation period in hours. When > 0, the
   * session ID is rotated after this many hours. Default: 24 (1 day).
   * Set to 0 to disable rotation. */
  readonly sessionRotationHours: number;
  /** Subprocess environment for ALL child processes (git, execute_command,
    * typecheck). Frozen, built from process.env via an EXPLICIT allowlist
    * (deny-by-default: only PATH, HOME, GIT_* and similar vars pass
    * through; secrets like HARNESS_API_KEY are dropped) +
    * GIT_OPTIONAL_LOCKS=0. Centralized here per the no-scattered-process.env
    * rule (one owner for all subprocesses). */
  readonly subprocessEnv: Readonly<Record<string, string>>;
  /** File-tree depth + entry caps (exp519: configurable, higher defaults
    * so the explorer is not capped at 4 levels). */
  readonly fileTreeMaxDepth: number;
  readonly fileTreeMaxEntries: number;
  /** Subprocess timeout for git operations (ms). Unifies the previously
   *  duplicated git-bridge (5_000) + git-ops-bridge (10_000) constants
     *  (no duplicate logic). Env: HARNESS_WEB_GIT_TIMEOUT_MS. */
  readonly gitTimeoutMs: number;
  /** Cap on the number of commit entries the git log accessors return
    *  (`git log -<n>`). The single owner of the `100` literal that was
   *  previously scattered across the bridge, route, tool-executor, + the
   *  manifest. Env: HARNESS_WEB_GIT_MAX_LOG_ENTRIES. */
  readonly gitMaxLogEntries: number;
  /** Default commit-entry count when a caller omits `max`. The single
    *  owner replacing the route's `50` + the LLM tool's `20` defaults that
    *  drifted for the same operation. Env:
    *  HARNESS_WEB_GIT_LOG_DEFAULT_ENTRIES. */
  readonly gitLogDefaultEntries: number;
  /** Timeout for the typecheck subprocess in auto-checks (ms). Env:
   *  HARNESS_WEB_TYPECHECK_TIMEOUT_MS. */
  readonly typecheckTimeoutMs: number;
  /** Max bytes read from a file for the read_file tool / editor preview.
   *  Env: HARNESS_WEB_MAX_FILE_READ_BYTES. */
  readonly maxFileReadBytes: number;
  /** Max bytes accepted for a file edit (write). Env:
   *  HARNESS_WEB_MAX_FILE_EDIT_BYTES. */
  readonly maxFileEditBytes: number;
  /** Awareness-snapshot cache TTL (ms). Env:
   *  HARNESS_WEB_AWARENESS_SNAPSHOT_TTL_MS. */
  readonly awarenessSnapshotTtlMs: number;
  /** Dashboard login password (env: HARNESS_WEB_AUTH_PASSWORD). When set,
    * the password is hashed (scrypt) + stored in the encrypted DB on first
    * boot, and every API request (except /api/auth/* + /api/health) requires
    * a valid session cookie. When empty AND no password has been set via
    * the setup flow, the first visit shows a setup page. Authentication is
   * the simple, no-third-party, scrypt + HttpOnly-cookie approach (HTTPS,
     * authentication, secrets management; no new deps).
     *
     * v12: this password seeds the FIRST admin user (with `authUsername`)
    * during the v12 migration; after that, each user has their own username
    * + password. The env remains the dev-mode admin seed. */
  readonly authPassword: string;
  /** The username for the seeded admin user (env:
    * HARNESS_WEB_AUTH_USERNAME). Default "admin". Used only by the v12
    * migration to seed the first admin from HARNESS_WEB_AUTH_PASSWORD. */
  readonly authUsername: string;
  /** Auth session TTL in hours (env: HARNESS_WEB_AUTH_SESSION_TTL_HOURS).
    * A session cookie expires after this period. Default: 720 (30 days).
    * 0 disables expiry (session lasts until logout). */
  readonly authSessionTtlHours: number;
  /** The `harness_session` (anonymous isolation) cookie max-age (seconds).
    *  Single owner of the cookie-lifetime literal. Env:
    *  `HARNESS_WEB_SESSION_COOKIE_MAX_AGE`. */
  readonly sessionCookieMaxAgeSeconds: number;
  /** Whether auth/session cookies carry the `Secure` flag (sent only over
    * HTTPS). DERIVED from the configured allowed-origin scheme (a loopback
    * HTTP dev origin → false so the browser keeps the cookie; an HTTPS
    * origin → true so a MITM on the wire cannot read it). This is a safety
    * invariant, not a tunable — the flag MUST match the transport or the
    * cookie is either dropped (Secure over HTTP) or insecure (no Secure
     * over HTTPS). Cookies previously had NO Secure flag,
     * leaking over any non-loopback HTTPS path. */
  readonly cookieSecure: boolean;
  /** Git short-hash display length (chars). The single owner of the
    *  abbreviation slice used by the git log accessor. Env:
    *  `HARNESS_WEB_GIT_SHORT_HASH_LENGTH`. */
  readonly gitShortHashLength: number;
  /** How long a provider connection test may take before it gives up (ms). */
  readonly providerTestTimeoutMs: number;
  /** Single-request output ceiling. Env: `HARNESS_WEB_PROVIDER_TEST_MAX_TOKENS`. */
  readonly providerTestMaxTokens: number;
  /** Byte bound on one provider model-catalog response. Env:
    *  `HARNESS_WEB_PROVIDER_DISCOVERY_MAX_BYTES`. */
  readonly providerDiscoveryMaxBytes: number;
  /** Whether to trust `X-Forwarded-For` for the rate-limit client IP.
    *  Deny-by-default: false — the header is spoofable on a direct
    *  connection. Set to true ONLY behind a trusted proxy. Env:
    *  `HARNESS_WEB_RATE_LIMIT_TRUST_PROXY`. */
  readonly rateLimitTrustProxy: boolean;
  /** Max number of rate-limiter buckets retained (the LRU memory cap).
    *  Env: `HARNESS_WEB_RATE_LIMIT_MAX_BUCKETS`. */
  readonly rateLimitMaxBuckets: number;
  /** The subprocess env allowlist (the vars passed to spawned subprocesses).
    *  Deny-by-default: every var NOT matching an entry is dropped. Override
    *  via `HARNESS_WEB_SUBPROCESS_ENV_ALLOWLIST` (comma-separated; replaces the
    *  default). */
  readonly subprocessEnvAllowlist: readonly string[];
  /** Max concurrent RUN streams per user (multi-tab cap). Env:
    *  `HARNESS_WEB_SSE_MAX_CONNECTIONS_PER_USER`. */
  readonly sseMaxConnectionsPerUser: number;
  /** Max concurrent LIVENESS streams per user — its OWN budget, never the
    *  run budget. See `DEFAULT_SSE_MAX_LIVENESS_CONNECTIONS_PER_USER` for
    *  the defect that separation fixes. Floored at
    *  `sseMaxConnectionsPerUser`. Env:
    *  `HARNESS_WEB_SSE_MAX_LIVENESS_CONNECTIONS_PER_USER`. */
  readonly sseMaxLivenessConnectionsPerUser: number;
  /** `Retry-After` seconds for a 429 when the SSE cap is exceeded. Env:
    *  `HARNESS_WEB_SSE_CONNECTION_RETRY_AFTER_SECONDS`. */
  readonly sseConnectionRetryAfterSeconds: number;
  /** Rows per statement for the per-chat history reads (a PAGE SIZE — the
    *  reads page until exhausted, so nothing is truncated). Env:
    *  `HARNESS_WEB_CHAT_HISTORY_PAGE_ROWS`. */
  readonly chatHistoryPageRows: number;
  /** Messages per history PAGE — the bound on one `/history` response. Env:
    *  `HARNESS_WEB_CHAT_HISTORY_TAIL_ROWS`. */
  readonly chatHistoryTailRows: number;
  /** Content-byte budget for one history page. Env:
    *  `HARNESS_WEB_CHAT_HISTORY_PAGE_BYTES`. */
  readonly chatHistoryPageBytes: number;
  /** Frames one run's replay feed holds before the oldest are dropped. Env:
    *  `HARNESS_WEB_RUN_FEED_MAX_FRAMES`. */
  readonly runFeedMaxFrames: number;
  /** What a browser is told to wait before reconnecting a run stream, written
    *  as SSE's `retry:`. The retention window below is floored against it.
    *  Env: `HARNESS_WEB_RUN_STREAM_RETRY_MS`. */
  readonly runStreamRetryMs: number;
  /** How long a finished run's feed stays reachable for a reconnect. Env:
    *  `HARNESS_WEB_RUN_FEED_RETENTION_MS`. */
  readonly runFeedRetentionMs: number;
  /** `PRAGMA synchronous` for the web DB — the durability choice, stated.
    *  See `DEFAULT_DB_SYNCHRONOUS`. Env: `HARNESS_WEB_DB_SYNCHRONOUS`. */
  readonly dbSynchronous: (typeof DB_SYNCHRONOUS_VALUES)[number];
  /** How long a committed write may sit unsynced, in ms — the bound that
    *  makes the setting above a stated trade rather than an assumed one.
    *  See `DEFAULT_DB_DURABILITY_WINDOW_MS`. 0 disables the timer.
    *  Env: `HARNESS_WEB_DB_DURABILITY_WINDOW_MS`. */
  readonly dbDurabilityWindowMs: number;
  /** Busy handler installed before WAL/startup locks; zero refuses immediately. */
  readonly dbBusyTimeoutMs: number;
  /** Pre-migration copies kept, newest first. See `DEFAULT_DB_BACKUP_RETENTION`.
    *  Env: `HARNESS_WEB_DB_BACKUP_RETENTION`. */
  readonly dbBackupRetention: number;
  /** Database-thread restarts allowed per window before the circuit opens. See `DEFAULT_DB_THREAD_RESTART_MAX`.
    *  Env: `HARNESS_WEB_DB_THREAD_RESTART_MAX`. */
  readonly dbThreadRestartMax: number;
  /** The restart circuit's window (and its open time). Env: `HARNESS_WEB_DB_THREAD_RESTART_WINDOW_MS`. */
  readonly dbThreadRestartWindowMs: number;
}>;

/** One of `DB_SYNCHRONOUS_VALUES` (case-insensitive), or the default when
 * unset. An unrecognised value is REFUSED at boot (a typed `ConfigError`,
 * like every other invalid env value): it is interpolated into a PRAGMA
 * statement, and a typo must be neither passed through nor — as it was until
 * CFG-0 B2 — silently replaced by the default, a durability choice nobody made. */
function envSynchronous(
  env: NodeJS.ProcessEnv,
  name: string,
): (typeof DB_SYNCHRONOUS_VALUES)[number] {
  const raw = envString(env, name, "");
  if (raw === "") return DEFAULT_DB_SYNCHRONOUS as (typeof DB_SYNCHRONOUS_VALUES)[number];
  const match = DB_SYNCHRONOUS_VALUES.find((v) => v === raw.toUpperCase());
  if (match === undefined) {
    throw new ConfigError(`Invalid ${name}: expected one of ${DB_SYNCHRONOUS_VALUES.join(", ")}, got ${raw}`);
  }
  return match;
}

export function resolveServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const allowedOrigin = envString(env, "HARNESS_WEB_ALLOWED_ORIGIN", DEFAULT_ALLOWED_ORIGIN);
  // The Secure cookie flag is a DERIVED invariant: it must match the
  // transport scheme. https → Secure (the cookie is dropped if a request
  // downgrades to http, which is exactly the defense). http (dev loopback)
  // → no Secure (the browser would otherwise drop the cookie over the http
  // dev origin). Not a tunable — deriving it keeps the flag consistent
  // with the configured origin (single source of truth).
  const cookieSecure = allowedOrigin.toLowerCase().startsWith("https://");
  // The subprocess env allowlist: a custom value REPLACES the default
  // (deny-by-default). Empty → the default allowlist.
  const allowlistRaw = envString(env, "HARNESS_WEB_SUBPROCESS_ENV_ALLOWLIST", "");
  const subprocessEnvAllowlist = allowlistRaw.length > 0 ? parseAllowlist(allowlistRaw) : COMMAND_ENVIRONMENT;
  // The two SSE budgets, resolved together because the second has a FLOOR at
  // the first. The liveness stream exists to notice outages; a configuration
  // that made it scarcer than the streams whose load it observes would
  // re-create the defect `DEFAULT_SSE_MAX_LIVENESS_CONNECTIONS_PER_USER`
  // documents — the detector refused first, and the page told the reader the
  // server was gone. The floor is stated rather than validated-and-rejected
  // so that raising the RUN budget alone (a perfectly reasonable thing for an
  // operator to do) cannot silently lower the detector's headroom below it.
  const sseMaxConnectionsPerUser = envInt(env, "HARNESS_WEB_SSE_MAX_CONNECTIONS_PER_USER", DEFAULT_SSE_MAX_CONNECTIONS_PER_USER, SSE_MAX_CONNECTIONS_MIN, SSE_MAX_CONNECTIONS_MAX);
  const sseMaxLivenessConnectionsPerUser = Math.max(
    envInt(env, "HARNESS_WEB_SSE_MAX_LIVENESS_CONNECTIONS_PER_USER", DEFAULT_SSE_MAX_LIVENESS_CONNECTIONS_PER_USER, SSE_MAX_CONNECTIONS_MIN, SSE_MAX_CONNECTIONS_MAX),
    sseMaxConnectionsPerUser,
  );
  // The reconnect cadence and the retention window, resolved together because
  // the second is FLOORED by the first. The window's whole purpose is that a
  // client which dropped as the run ended can reconnect and still find the
  // record; a window shorter than the reconnect it is waiting for serves
  // nobody, and the previously-declared minimum of 0 made that state legal —
  // reconnect met a 404, and a foreign user's 403 became a 404 with it, which
  // is the defect this window exists to prevent arriving through the window's
  // own configuration. Stated as a floor rather than a rejection so that
  // changing the cadence alone (a reasonable operator change) moves the floor
  // instead of silently invalidating it.
  const runStreamRetryMs = envInt(env, "HARNESS_WEB_RUN_STREAM_RETRY_MS", DEFAULT_RUN_STREAM_RETRY_MS, RUN_STREAM_RETRY_MS_MIN, RUN_STREAM_RETRY_MS_MAX);
  const runFeedRetentionFloorMs = runStreamRetryMs * RUN_FEED_RETENTION_RECONNECTS_MIN;
  const runFeedRetentionMs = Math.max(
    envInt(env, "HARNESS_WEB_RUN_FEED_RETENTION_MS", DEFAULT_RUN_FEED_RETENTION_MS, RUN_FEED_RETENTION_MS_PARSE_MIN, RUN_FEED_RETENTION_MS_MAX),
    runFeedRetentionFloorMs,
  );
  const requestTimeoutMs = envInt(env, "HARNESS_WEB_REQUEST_TIMEOUT_MS", DEFAULT_REQUEST_TIMEOUT_MS, HTTP_TIMEOUT_MIN, HTTP_TIMEOUT_MAX);
  const headersTimeoutMs = envInt(env, "HARNESS_WEB_HEADERS_TIMEOUT_MS", DEFAULT_HEADERS_TIMEOUT_MS, HTTP_TIMEOUT_MIN, HTTP_TIMEOUT_MAX);
  if (headersTimeoutMs > requestTimeoutMs) {
    throw new ConfigError(
      `Invalid HARNESS_WEB_HEADERS_TIMEOUT_MS: ${String(headersTimeoutMs)} exceeds HARNESS_WEB_REQUEST_TIMEOUT_MS ${String(requestTimeoutMs)} (the headers arrive within the request)`,
      "http_headers_timeout_exceeds_request",
    );
  }
  return Object.freeze({
    port: envInt(env, "HARNESS_WEB_PORT", DEFAULT_PORT, PORT_MIN, PORT_MAX),
    requestTimeoutMs,
    headersTimeoutMs,
    keepAliveTimeoutMs: envInt(env, "HARNESS_WEB_KEEP_ALIVE_TIMEOUT_MS", DEFAULT_KEEP_ALIVE_TIMEOUT_MS, KEEP_ALIVE_TIMEOUT_MIN, KEEP_ALIVE_TIMEOUT_MAX),
    host: envString(env, "HARNESS_WEB_HOST", DEFAULT_HOST),
    allowedOrigin,
    maxBodyBytes: envInt(
      env,
      "HARNESS_WEB_MAX_BODY_BYTES",
      DEFAULT_MAX_BODY_BYTES,
      BODY_BYTES_MIN,
      BODY_BYTES_MAX,
    ),
    sseKeepaliveMs: envInt(
      env,
      "HARNESS_WEB_SSE_KEEPALIVE_MS",
      DEFAULT_SSE_KEEPALIVE_MS,
      KEEPALIVE_MIN,
      KEEPALIVE_MAX,
    ),
    timelineDbPath: envString(env, "HARNESS_WEB_TIMELINE_DB_PATH", DEFAULT_TIMELINE_DB_PATH),
    dbPath: envString(env, "HARNESS_WEB_DB_PATH", DEFAULT_DB_PATH),
    projectRoot: envString(env, "HARNESS_WEB_PROJECT_ROOT", DEFAULT_PROJECT_ROOT),
    harnessConfigPath: envString(env, "HARNESS_CONFIG_PATH", DEFAULT_HARNESS_CONFIG_PATH),
    rateLimitPerMinute: envInt(env, "HARNESS_WEB_RATE_LIMIT", DEFAULT_RATE_LIMIT, RATE_LIMIT_MIN, RATE_LIMIT_MAX),
    rateLimitRefillMs: envInt(env, "HARNESS_WEB_RATE_LIMIT_REFILL_MS", DEFAULT_RATE_LIMIT_REFILL_MS, RATE_LIMIT_REFILL_MIN, RATE_LIMIT_REFILL_MAX),
    fileTreeMaxDepth: envInt(env, "HARNESS_WEB_FILE_TREE_MAX_DEPTH", DEFAULT_FILE_TREE_MAX_DEPTH, FILE_TREE_DEPTH_MIN, FILE_TREE_DEPTH_MAX),
    fileTreeMaxEntries: envInt(env, "HARNESS_WEB_FILE_TREE_MAX_ENTRIES", DEFAULT_FILE_TREE_MAX_ENTRIES, FILE_TREE_ENTRIES_MIN, FILE_TREE_ENTRIES_MAX),
    gitTimeoutMs: envInt(env, "HARNESS_WEB_GIT_TIMEOUT_MS", DEFAULT_GIT_TIMEOUT_MS, GIT_TIMEOUT_MIN, GIT_TIMEOUT_MAX),
    gitMaxLogEntries: envInt(env, "HARNESS_WEB_GIT_MAX_LOG_ENTRIES", DEFAULT_GIT_MAX_LOG_ENTRIES, GIT_MAX_LOG_MIN, GIT_MAX_LOG_MAX),
    gitLogDefaultEntries: envInt(env, "HARNESS_WEB_GIT_LOG_DEFAULT_ENTRIES", DEFAULT_GIT_LOG_DEFAULT_ENTRIES, GIT_LOG_DEFAULT_MIN, GIT_LOG_DEFAULT_MAX),
    typecheckTimeoutMs: envInt(env, "HARNESS_WEB_TYPECHECK_TIMEOUT_MS", DEFAULT_TYPECHECK_TIMEOUT_MS, TYPECHECK_TIMEOUT_MIN, TYPECHECK_TIMEOUT_MAX),
    maxFileReadBytes: envInt(env, "HARNESS_WEB_MAX_FILE_READ_BYTES", DEFAULT_MAX_FILE_READ_BYTES, FILE_BYTES_MIN, FILE_BYTES_MAX),
    maxFileEditBytes: envInt(env, "HARNESS_WEB_MAX_FILE_EDIT_BYTES", DEFAULT_MAX_FILE_EDIT_BYTES, FILE_BYTES_MIN, FILE_BYTES_MAX),
    awarenessSnapshotTtlMs: envInt(env, "HARNESS_WEB_AWARENESS_SNAPSHOT_TTL_MS", DEFAULT_AWARENESS_SNAPSHOT_TTL_MS, AWARENESS_TTL_MIN, AWARENESS_TTL_MAX),
    allowedProjectRoots: parseAllowedRoots(envString(env, "HARNESS_WEB_ALLOWED_ROOTS", "")),
    authPassword: envString(env, "HARNESS_WEB_AUTH_PASSWORD", ""),
    authUsername: envString(env, "HARNESS_WEB_AUTH_USERNAME", DEFAULT_AUTH_USERNAME),
    authSessionTtlHours: envInt(env, "HARNESS_WEB_AUTH_SESSION_TTL_HOURS", DEFAULT_AUTH_SESSION_TTL_HOURS, SESSION_HOURS_MIN, SESSION_HOURS_MAX),
    sessionCookieMaxAgeSeconds: envInt(env, "HARNESS_WEB_SESSION_COOKIE_MAX_AGE", DEFAULT_SESSION_COOKIE_MAX_AGE, SESSION_COOKIE_MAX_AGE_MIN, SESSION_COOKIE_MAX_AGE_MAX),
    cookieSecure,
    dbEncryptionKey: envString(env, "HARNESS_WEB_DB_KEY", ""),
    sessionRotationHours: envInt(env, "HARNESS_WEB_SESSION_ROTATION_HOURS", DEFAULT_SESSION_ROTATION_HOURS, SESSION_HOURS_MIN, SESSION_HOURS_MAX),
    gitShortHashLength: envInt(env, "HARNESS_WEB_GIT_SHORT_HASH_LENGTH", DEFAULT_GIT_SHORT_HASH_LENGTH, GIT_SHORT_HASH_MIN, GIT_SHORT_HASH_MAX),
    providerTestTimeoutMs: envInt(env, "HARNESS_WEB_PROVIDER_TEST_TIMEOUT_MS", DEFAULT_PROVIDER_TEST_TIMEOUT_MS, PROVIDER_TEST_TIMEOUT_MIN, PROVIDER_TEST_TIMEOUT_MAX),
    providerDiscoveryMaxBytes: envInt(env, "HARNESS_WEB_PROVIDER_DISCOVERY_MAX_BYTES", DEFAULT_PROVIDER_DISCOVERY_MAX_BYTES, PROVIDER_DISCOVERY_MAX_BYTES_MIN, PROVIDER_DISCOVERY_MAX_BYTES_MAX),
    providerTestMaxTokens: envInt(env, "HARNESS_WEB_PROVIDER_TEST_MAX_TOKENS", DEFAULT_PROVIDER_TEST_MAX_TOKENS, PROVIDER_TEST_MAX_TOKENS_MIN, PROVIDER_TEST_MAX_TOKENS_MAX),
    rateLimitTrustProxy: envString(env, "HARNESS_WEB_RATE_LIMIT_TRUST_PROXY", "") === "1",
    rateLimitMaxBuckets: envInt(env, "HARNESS_WEB_RATE_LIMIT_MAX_BUCKETS", DEFAULT_RATE_LIMIT_MAX_BUCKETS, RATE_LIMIT_MAX_BUCKETS_MIN, RATE_LIMIT_MAX_BUCKETS_MAX),
    subprocessEnvAllowlist,
    sseMaxConnectionsPerUser,
    sseMaxLivenessConnectionsPerUser,
    sseConnectionRetryAfterSeconds: envInt(env, "HARNESS_WEB_SSE_CONNECTION_RETRY_AFTER_SECONDS", DEFAULT_SSE_CONNECTION_RETRY_AFTER_SECONDS, SSE_RETRY_AFTER_MIN, SSE_RETRY_AFTER_MAX),
    chatHistoryPageRows: envInt(env, "HARNESS_WEB_CHAT_HISTORY_PAGE_ROWS", DEFAULT_CHAT_HISTORY_PAGE_ROWS, CHAT_HISTORY_PAGE_ROWS_MIN, CHAT_HISTORY_PAGE_ROWS_MAX),
    chatHistoryTailRows: envInt(env, "HARNESS_WEB_CHAT_HISTORY_TAIL_ROWS", DEFAULT_CHAT_HISTORY_TAIL_ROWS, CHAT_HISTORY_TAIL_ROWS_MIN, CHAT_HISTORY_TAIL_ROWS_MAX),
    chatHistoryPageBytes: envInt(env, "HARNESS_WEB_CHAT_HISTORY_PAGE_BYTES", DEFAULT_CHAT_HISTORY_PAGE_BYTES, CHAT_HISTORY_PAGE_BYTES_MIN, CHAT_HISTORY_PAGE_BYTES_MAX),
    runFeedMaxFrames: envInt(env, "HARNESS_WEB_RUN_FEED_MAX_FRAMES", DEFAULT_RUN_FEED_MAX_FRAMES, RUN_FEED_MAX_FRAMES_MIN, RUN_FEED_MAX_FRAMES_MAX),
    runStreamRetryMs,
    runFeedRetentionMs,
    dbBusyTimeoutMs: envInt(env, "HARNESS_WEB_DB_BUSY_TIMEOUT_MS", DEFAULT_SQLITE_BUSY_TIMEOUT_MS, DB_BUSY_TIMEOUT_MIN, DB_BUSY_TIMEOUT_MAX),
    dbBackupRetention: envInt(env, "HARNESS_WEB_DB_BACKUP_RETENTION", DEFAULT_DB_BACKUP_RETENTION, DB_BACKUP_RETENTION_MIN, DB_BACKUP_RETENTION_MAX),
    dbSynchronous: envSynchronous(env, "HARNESS_WEB_DB_SYNCHRONOUS"),
    dbDurabilityWindowMs: envInt(env, "HARNESS_WEB_DB_DURABILITY_WINDOW_MS", DEFAULT_DB_DURABILITY_WINDOW_MS, DB_DURABILITY_WINDOW_MIN, DB_DURABILITY_WINDOW_MAX),
    dbThreadRestartMax: envInt(env, "HARNESS_WEB_DB_THREAD_RESTART_MAX", DEFAULT_DB_THREAD_RESTART_MAX, DB_THREAD_RESTART_MAX_MIN, DB_THREAD_RESTART_MAX_MAX),
    dbThreadRestartWindowMs: envInt(env, "HARNESS_WEB_DB_THREAD_RESTART_WINDOW_MS", DEFAULT_DB_THREAD_RESTART_WINDOW_MS, DB_THREAD_RESTART_WINDOW_MIN, DB_THREAD_RESTART_WINDOW_MAX),
    // `GIT_OPTIONAL_LOCKS=0` is ALWAYS added for model-run commands (the git
    // optimization), regardless of the allowlist.
    subprocessEnv: Object.freeze({ GIT_OPTIONAL_LOCKS: "0", ...buildSubprocessEnv(env, subprocessEnvAllowlist) }),
  });
}

/**
 * THE CREDENTIALS THIS PROCESS HOLDS, so the redactor can recognise them.
 *
 * The strongest secret detector available to this product is not a pattern —
 * it is identity. A string equal to a credential this server holds is
 * provably a secret in any format, whatever provider issued it and however it
 * has been escaped. That layer needs to be TOLD which credentials those are,
 * and the only place allowed to read `process.env` is this module
 * (`tests/prevention/centralized-config.test.ts`), so the enumeration lives
 * here and the redaction owner consumes it.
 *
 * ONE source: any env var whose NAME says it holds a credential, matched
 * against `SENSITIVE_KEY_PARTS` — the same catalog the admission path treats
 * as authoritative for key-name sensitivity, imported rather than restated —
 * so the NEXT such variable is known without anybody remembering to add it.
 *
 * ── NO EQUALITY ORACLE ON A GUESSABLE SECRET (SECC-V-A4) ─────────────────
 *
 * Every surface that consults the registry is observable by a user: the
 * REST/SSE display egress masks a match, and the model-bound path tells the
 * user what it masked. A value an OPERATOR CHOSE — the first admin's password
 * seed, the database passphrase — registered there answers any user's guess
 * ("store a chat title, read `[REDACTED:secret]` back"): an online password
 * confirmation. So the harness's own `HARNESS_*` boot inputs and every
 * variable whose name says it is a password or passphrase are NOT registered.
 * They cannot leak through the paths the registry guarded: no `HARNESS_*`
 * variable reaches a child (the environment projection refuses the
 * namespace), none is served, and the harness state that holds them is on
 * the keep-out list. A token named as a token (issued, high-entropy) stays
 * registered: equality with an unguessable value confirms nothing.
 *
 * VALUES ARE RETURNED, NOT LOGGED. The caller registers them into a private
 * registry and nothing downstream can read them back out — see
 * `privacy/secret-intelligence.ts`. The label is what surfaces.
 */
export type OwnCredential = Readonly<{ label: string; value: string }>;

export function harnessOwnSecrets(env: NodeJS.ProcessEnv = process.env): readonly OwnCredential[] {
  const out: OwnCredential[] = [];
  const add = (label: string, value: string | undefined): void => {
    if (typeof value === "string" && value.length > 0) out.push({ label, value });
  };
  // Anything whose NAME says it is a credential, asked of the declared
  // owner's WHOLE key question — normalized parts AND the separator-bounded
  // patterns, so an `SK_…` env name is discovered too (U-44: parts alone
  // missed it). The patterns need the name AS WRITTEN (they are
  // separator-bounded), which is why the owner is asked BEFORE any
  // normalization.
  for (const [name, value] of Object.entries(env)) {
    if (!isSensitiveKeyName(name)) continue;
    // The harness's own boot inputs and human-chosen secrets: no oracle (above).
    if (isHarnessEnvironmentName(name)) continue;
    const normalized = normalizeSecretKey(name);
    if (/pass(?:word|phrase|wd)?$|pwd$/u.test(normalized)) continue;
    // A `_PATH`/`_FILE` variable names a location, not a credential; masking
    // every occurrence of a file path would destroy legitimate content.
    if (/(?:path|file|dir|url|enabled|username|user)$/u.test(normalized)) continue;
    add(`env:${name}`, value);
  }
  return Object.freeze(out);
}

/**
 * Whether to stream fixture model events instead of calling a real LLM.
 * Read at CALL time (not import time) so a test can set
 * `HARNESS_WEB_LLM_FIXTURES=1` after the config module is imported but
 * before a run starts. This keeps the env read centralized in config.ts
 * (the sole config owner) while preserving call-time override semantics.
 */
export function llmFixturesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envString(env, "HARNESS_WEB_LLM_FIXTURES", "") === "1";
}

/**
 * Whether the centralized debug/error system (server/debug-bridge.ts → the
 * canonical `integration/src/shared/debug/debug-system.ts`) is enabled at
 * bootstrap. When true, the server attaches a console sink (stderr) so
 * `webDebugLog`/`webWarn`/`webHandleError` emit structured events. When
 * false (the DEFAULT), the debug system stays in its no-op state: every
 * call returns immediately at the `!configured` guard — ZERO overhead when
 * debug is off. Read at bootstrap (in
 * server/index.ts) so the env read is centralized here. Env:
 * `HARNESS_WEB_DEBUG=1` enables it.
 */
export function debugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envString(env, "HARNESS_WEB_DEBUG", "") === "1";
}

/**
 * The resolved server config singleton. Declared `let` (not `const`) so the
 * binding can be re-resolved at runtime via `resetServerConfig()`. ESM live
 * bindings mean every `import { serverConfig }` consumer sees the refreshed
 * value after a reset — no consumer holds a stale snapshot (the only module-
 * level capture, `SESSION_ROTATION_MS`, was refactored to a call-time read).
 *
 * Tests reset the config per file (so a test that sets `HARNESS_WEB_PORT`
 * via `vi.hoisted` sees the new value) which lets the suite run with
 * `isolate: false` (shared module registry — the import cost collapses
 * from per-file to per-worker). The reset is centralized in the vitest
 * setup file so individual tests do not need to remember to call it.
 */
export let serverConfig: ServerConfig = resolveServerConfig();

/**
 * Re-resolve `serverConfig` from the current `process.env` (or a custom
 * env) + reassign the live binding. Returns the freshly resolved config.
 *
 * Called by the vitest setup file (per test file) so the singleton reflects
 * env mutations made by `vi.hoisted` / `beforeAll` even when the module
 * registry is shared (`isolate: false`). Production code never needs this
 * — env is read once at boot + the singleton is stable for the process
 * lifetime. The function exists for the test isolation contract.
 */
export function resetServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  serverConfig = resolveServerConfig(env);
  return serverConfig;
}
