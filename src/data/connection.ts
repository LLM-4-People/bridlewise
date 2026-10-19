/**
 * THE CONNECTION — one global state, one owner.
 *
 * DESIGN-PERFORMANCE §1 L3 applied to the connection itself: *absence is
 * stated, never rendered as emptiness*. A surface that cannot reach the API
 * and draws nothing is asserting "there is nothing here" when the truth is
 * "I could not ask". That is the same fabricated-absence failure as the
 * silent large-conversation load, arriving through a different door.
 *
 * ── WHY ONE OWNER AND NOT NINETY-THREE CATCH BLOCKS ──
 *
 * Reachability is not a property of a request; it is a property of the
 * SERVER, shared by every request in flight. Deciding it per call site
 * produces ninety-three private opinions that disagree — and it already had:
 * three separate places tested `err.code === "network" || err.code ===
 * "timeout"`, which (see below) is a test that never fires in the dev
 * configuration at all. One fact, one owner, and the only thing allowed to
 * write it is the single fetch choke point (`broker.ts::fetchJson`).
 *
 * ── THE THREE STATES, AND WHY THREE ──
 *
 * "Instant" needs three, not one. A refused socket is not a slow one:
 *
 *   REFUSED  the API is not listening. Known in MILLISECONDS — no timeout is
 *            involved, because there is nothing to wait for. Browser-measured
 *            through the Vite dev proxy with the API stopped: 5ms.
 *   SLOW     a request has been open longer than a person will believe a
 *            spinner. Nothing has failed; the surface says so rather than
 *            spinning without comment.
 *   TIMED OUT we gave up, after a measured elapsed time that is stated.
 *
 * Only the first two are cheap to detect; the third costs exactly what it
 * says it costs, which is why it names the number.
 *
 * ── HOW "THE API DID NOT ANSWER" IS DETECTED, EXACTLY ──
 *
 * Two signals, and no guessing between them:
 *
 *  1. `fetch` REJECTS with something that is not an abort. That is a refused
 *     socket, a DNS failure, or a dropped connection — the request never
 *     produced a response. Direct-to-API deployments take this branch.
 *
 *  2. A response arrives WITHOUT the API's identity header
 *     (`API_IDENTITY_HEADER`, stamped by `server/index.ts` on every response
 *     it produces). Something in front of the API answered for it. In dev
 *     that something is the Vite proxy, which synthesizes `502 Bad Gateway`
 *     with an empty `text/plain` body when the upstream socket is refused.
 *
 * THE STATUS CODE IS NOT THE SIGNAL, and this is the part that was wrong
 * before. `shared/errors.ts` maps an upstream model-provider failure to
 * 502 as well, with the comment "502 is the honest status: this side
 * worked" — so a rule keyed on the number would declare a perfectly healthy
 * server offline every time a provider hiccuped. The header separates "the
 * API said 502" from "something said 502 about the API", which is the
 * distinction that actually matters and the only one that is not a guess.
 *
 * ── 401 IS NOT OFFLINE ──
 *
 * Falls straight out of the rule above rather than being a special case: a
 * 401 carries the identity header, therefore the API answered, therefore the
 * connection is reachable. So does a 500, a 404 and a 403. Reachability and
 * authorization are different facts and this module only knows the first.
 *
 * ── WHAT IT NEVER DOES ──
 *
 * It never clears anything, and that is what makes the recovery instant.
 * Surfaces are HIDDEN while the API is unreachable — the user's ruling: a
 * half-visible control that looks operable and is not is worse than no
 * control — but nothing is discarded. The Broker deliberately keeps its
 * cached entries through a failed read (see `broker.ts::issue`), every
 * nanostore keeps its value, and no reset is called from anywhere on this
 * path. So coming back is not a boot: the block unmounts and the cockpit
 * underneath is the one that was there, at its scroll position, with its
 * rooms still mounted, revalidating in place.
 */

import { atom, type ReadableAtom } from "nanostores";

import {
  API_IDENTITY_HEADER,
  GATEWAY_UNREACHED_STATUSES,
  LIVE_STREAM_MISSED_BEATS,
  LIVE_STREAM_RETRY_MS,
} from "../../shared/constants.ts";
import {
  CONNECTION_TIMEOUT_STRIKES,
  CONNECTION_UNREACHABLE_TIMEOUT_MS,
  LIVENESS_BEAT_MS,
  LIVENESS_CHANNEL_NAME,
  LIVENESS_LOCK_NAME,
} from "../client-config.ts";
import {
  soloLivenessShare,
  webLivenessShare,
  type LivenessShare,
  type LivenessSignal,
} from "./liveness-share.ts";

/** Why the API could not be reached. Each is detected differently. */
export type UnreachableCause = "refused" | "timeout";

export type ConnectionState =
  /** The API answered the most recent request that settled. */
  | Readonly<{ kind: "reachable" }>
  /** A request has been open past the patience threshold and has not settled.
   *  Nothing has failed — this is "still trying", said out loud. */
  | Readonly<{ kind: "slow"; since: number }>
  /** The API could not be reached. `elapsedMs` is MEASURED, not assumed: for
   *  `refused` it is how long the failure took to come back (milliseconds);
   *  for `timeout` it is how long we waited before giving up. */
  | Readonly<{
      kind: "unreachable";
      cause: UnreachableCause;
      since: number;
      elapsedMs: number;
    }>;

/**
 * The global connection state.
 *
 * Starts `reachable` deliberately, and not as a fourth "unknown" state: a
 * surface only ever renders something for a state that is NOT reachable, so
 * "unknown" and "reachable" would be pixel-identical, and the first request
 * settles the question in milliseconds. A state nothing can distinguish is
 * not a state.
 */
const state = atom<ConnectionState>({ kind: "reachable" });

/** Read-only view for surfaces. Only this module writes it. */
export const connection: ReadableAtom<ConnectionState> = state;

/** The single label a surface should show. Plain words, and it names WHAT
 *  could not be reached — never a bare "offline". `null` when reachable. */
export function connectionMessage(s: ConnectionState): string | null {
  if (s.kind === "reachable") return null;
  if (s.kind === "slow") {
    return "the harness API is not answering yet — still trying";
  }
  return s.cause === "refused"
    ? "The harness API is not answering"
    : `The harness API stopped answering after ${(s.elapsedMs / 1000).toFixed(0)}s`;
}

// ── The standing liveness stream ──────────────────────────────────────────
//
// THE PAGE DOES NOT ASK. It holds one socket open and listens.
//
// An earlier version of this module polled `/api/health` — every second while
// healthy, and again while down. It worked, and it was the wrong shape:
//
//   COST      a cockpit at rest issues no requests at all (browser-measured:
//             zero fetches in twelve seconds on a loaded screen), so the poll
//             added sixty requests a minute per tab to a silent page;
//   LATENCY   discovery was bounded by the interval and nothing else —
//             browser-measured 4,471ms at a 5s interval, 569ms at 1s;
//   RECOVERY  needed its own second timer.
//
// A held socket removes all three. When the server process dies the kernel
// delivers FIN and the browser fires `error` — detection is no longer a
// function of how often we asked. And the reconnect loop is the BROWSER's:
// the server writes SSE's `retry:` field, so after a drop the browser
// reconnects on that cadence by itself, using the value it received before
// the outage. Nothing on this side polls in either direction.
//
// The I/O is INJECTED rather than imported. `src/client.ts` is the single
// owner of `new EventSource` and of `fetch`
// (tests/prevention/client-api-owner.test.ts) and it already imports the
// Broker, so importing it here would be a cycle. The application entry wires
// the two together — see `startLivenessWatch`.

/** What `src/client.ts::openLivenessStream` provides. Returns its stop. */
export type LivenessOpener = (
  handlers: Readonly<{
    onAlive: () => void;
    onDown: (info: Readonly<{ retrying: boolean }>) => void;
  }>,
) => () => void;

/** What `src/client.ts::diagnoseLivenessConnection` reports. Mirrored here
 *  structurally rather than imported, for the same no-cycle reason as the
 *  opener; the entry point is where the two meet, and the compiler checks
 *  they agree there. */
export type LivenessDiagnosis =
  | Readonly<{ outcome: "answered" }>
  | Readonly<{ outcome: "refused"; retryAfterMs: number }>
  | Readonly<{ outcome: "unreached"; elapsedMs: number }>;

/**
 * The two halves of the liveness I/O, handed over together.
 *
 * ONE PORT AND NOT TWO ARGUMENTS, deliberately. The retry policy below is
 * only correct if it can ask WHY a connection failed; an entry that wired the
 * opener and forgot the diagnosis would compile into a page that retries
 * refusals at the outage cadence — precisely the loop this shape exists to
 * make impossible. A required field of a required object cannot be forgotten
 * silently: the entry does not typecheck.
 */
export type LivenessPort = Readonly<{
  open: LivenessOpener;
  diagnose: () => Promise<LivenessDiagnosis>;
}>;

let revalidate: (() => void) | null = null;
let port: LivenessPort | null = null;
let stopLiveness: (() => void) | null = null;
let silenceTimer: ReturnType<typeof setTimeout> | null = null;
/** Pending next step after a failure — always a DIAGNOSIS, never a blind
 *  re-open. See `scheduleDiagnosis`. */
let reopenTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * ── THE SHARED LIVENESS (UIE-044's fix) ────────────────────────────────────
 *
 * Chrome pins SIX HTTP/1.1 sockets per origin per browser context, and this
 * module's held stream used to be one PER TAB — so a six-tab session pinned
 * the whole pool and every further request (a steer POST included) queued
 * until the broker's 30s timeout killed it with `net::ERR_ABORTED` while the
 * server recorded nothing. Measured live (the UIE-044 drive): the starved
 * steers, the group-aborted observers, the exact wire shape in the
 * UIE-044 entry.
 *
 * The liveness stream is now ELECTED AND SHARED (see `liveness-share.ts`):
 * one tab in the context holds the socket, the others derive the same state
 * from its broadcasts. These three fields are the watch's half of that
 * contract — `connect()` refuses to open a socket for a tab that has not
 * been elected, and the leader's stream handlers re-broadcast what they see.
 */
let share: LivenessShare | null = null;
/** The unsubscribe for this watch's share subscription. Torn down only by the
 *  full reset — `stopLivenessWatch` is a RESTART step (see
 *  `probeConnectionNow`), not a teardown, and a watch that stopped its
 *  socket but kept its share wiring is exactly the follower state. */
let shareUnsubscribe: (() => void) | null = null;
/** True once this tab's lock callback ran — the one and only authority on
 *  whether THIS tab may open the liveness socket. */
let isLeader = false;
/**
 * When the last socket was opened — the floor that keeps every path
 * terminating.
 *
 * `connect` refuses to open two sockets closer together than
 * `LIVE_STREAM_RETRY_MS` and schedules itself for the remainder instead. It
 * is one rule in one place, and it bounds every caller including "try now":
 * a server that answers the diagnosis but drops the stream instantly would
 * otherwise spin as fast as the network allows, which is the same
 * self-sustaining shape this whole change removes, arriving from the other
 * side.
 */
let lastAttemptAt = 0;
/**
 * Which watch a pending async diagnosis belongs to. `stopLivenessWatch`
 * bumps it, so a diagnosis that resolves after the watch was stopped (or
 * restarted by "try now") lands on the floor instead of scheduling work for a
 * watch that no longer exists.
 */
let generation = 0;

/**
 * Wire the recovery revalidation. Called ONCE, by the Broker, at module load.
 *
 * The Broker owns this half because `revalidateAll` is the Broker's own
 * mechanism (the head-moved refresh bus), and reconnection reuses it rather
 * than adding a second one.
 */
export function installConnectionRevalidation(revalidateAll: () => void): void {
  revalidate = revalidateAll;
}

/** Options for the watch. The share is injectable so tests can simulate a
 *  multi-tab context (two watches, one fake election) without a browser. */
export type LivenessWatchOptions = Readonly<{ share?: LivenessShare }>;

/** The page's own share, built once. The Web Locks + BroadcastChannel pair
 *  when the platform has them (a real page), the solo shape when it does not
 *  (the node test environment) — so the watch's code path is ONE path with
 *  an honest fallback, never a second half-implementation. */
let pageShare: LivenessShare | null = null;
function defaultShare(): LivenessShare {
  if (pageShare === null) {
    pageShare = webLivenessShare(LIVENESS_LOCK_NAME, LIVENESS_CHANNEL_NAME)
      ?? soloLivenessShare();
  }
  return pageShare;
}

/**
 * Begin watching the connection. Called once, by the application entry
 * (`src/cockpit/main.ts`, `src/main.ts`), and by nothing else.
 *
 * WHY THIS IS NOT WIRED AT MODULE LOAD, given that everything else in this
 * file argues that a step a caller must remember is a step that gets skipped.
 *
 * The two halves have genuinely different scopes. DETECTION-ON-USE is
 * automatic and unconditional: every request through `fetchJson` reports its
 * outcome, so an outage is noticed by any code path that talks to the server,
 * with nothing to remember. HOLDING A SOCKET OPEN is an application LIFECYCLE
 * behaviour — "this process is a running page" — and that is a fact only an
 * entry point knows.
 *
 * It was module-load-triggered first, and the consequences were measured, not
 * theorised. Importing the Broker anywhere began a background liveness loop:
 * in the ~400 node test files that import it transitively there is no
 * `location` to resolve a relative URL against, and in the jsdom component
 * suites it reached the test's own stub, failed, flipped the connection to
 * unreachable, and drove the cockpit shell's reconnect effect — which
 * restarted the boot and produced duplicate registration lines in a test
 * about something else entirely. A background connection is not something a
 * module import may open on behalf of its importer.
 *
 * The forgettability risk is answered mechanically rather than by hoping:
 * `tests/prevention/liveness-stream-owner.test.ts` fails if an entry point
 * stops calling this.
 *
 * THE SOCKET ITSELF IS ELECTED (UIE-044): this tab queues for the
 * context's leadership lock and only the elected tab opens the stream. A
 * follower tab — one of five others in a six-tab session — contributes
 * ZERO held sockets while seeing the same connection state, which is what
 * returns the per-origin pool its five slots and lets a steer POST through.
 *
 * Returns the stop function; calling it closes the socket and cancels the
 * browser's reconnect loop.
 */
export function startLivenessWatch(
  livenessPort: LivenessPort,
  opts: LivenessWatchOptions = {},
): () => void {
  port = livenessPort;
  // A restart inside one tab (a test seam; the real page starts one watch)
  // must not leak the previous watch's subscription.
  shareUnsubscribe?.();
  share = opts.share ?? defaultShare();
  shareUnsubscribe = share.onSignal(applySharedSignal);
  share.elect(() => {
    isLeader = true;
    connect();
  });
  return stopLivenessWatch;
}

/**
 * A follower's half of the shared liveness: what the elected tab's stream
 * observed, applied to THIS tab's own state machine. The leader ignores its
 * own broadcasts — its stream is the source, and it already ran the same
 * code on the way here.
 */
function applySharedSignal(signal: LivenessSignal): void {
  if (isLeader) return;
  if (signal === "beat") {
    // The shared socket's alive signal is a beat for this tab too: same
    // watchdog re-arm, same reachable verdict, as if the socket were local.
    armSilenceTimer();
    noteAnswered();
    return;
  }
  // The shared socket dropped while the browser retries it — the same
  // instant, honest reading the leader's own retrying branch makes:
  // unreachable-by-refusal, no elapsed time invented (see `connect`).
  disarmSilenceTimer();
  noteNotReached("refused", 0);
}

function connect(): void {
  if (port === null || stopLiveness !== null) return;
  // ONLY THE ELECTED TAB MAY HOLD THE SOCKET. A follower reaching this
  // door (a diagnosis answered, a "try now" pressed) has everything it
  // needs without a socket: its own requests report reachability and the
  // leader's broadcasts carry what only a held stream can observe.
  // Opening one anyway would be the UIE-044 defect reintroduced from the
  // inside — one socket per tab, six tabs, nothing else gets through.
  if (!isLeader) return;
  // THE FLOOR (see `lastAttemptAt`). Never two sockets closer together than
  // the outage cadence, whatever asked for this one.
  const wait = LIVE_STREAM_RETRY_MS - (Date.now() - lastAttemptAt);
  if (wait > 0) {
    armNextStep(wait, connect);
    return;
  }
  lastAttemptAt = Date.now();
  stopLiveness = port.open({
    onAlive: () => {
      // The elected tab speaks for the context: every follower applies this
      // same beat to its own state machine (see `applySharedSignal`). In a
      // solo world the broadcast has no audience and costs nothing.
      share?.broadcast("beat");
      armSilenceTimer();
      noteAnswered();
    },
    onDown: ({ retrying }) => {
      share?.broadcast("down");
      disarmSilenceTimer();
      // WHEN THE BROWSER IS STILL RETRYING it owns the loop and we must not
      // open a second socket beside it. It reached that state through a
      // NETWORK error — a dropped or refused socket, nothing answered — so
      // "unreachable" is the honest reading, and it is available in
      // milliseconds (browser-measured: 22ms).
      //
      // NO MEASURED ELAPSED IS AVAILABLE HERE and none is invented. The
      // browser tells us the socket failed, not how long it took to fail;
      // reporting a duration we did not measure would be exactly the
      // fabrication this product exists to refuse. Zero is the honest value
      // for "a refused socket", which is what this is: the failure came back
      // as fast as the network could report it.
      if (retrying) {
        noteNotReached("refused", 0);
        return;
      }
      // THE BROWSER HAS GIVEN UP FOR GOOD — the spec's response to a non-2xx
      // or a wrong content type — and this branch carries TWO OPPOSITE
      // situations that `error` cannot tell apart:
      //
      //   the API is down    (in dev the Vite proxy answers `502 text/plain`,
      //                       which is exactly the permanent-failure shape),
      //   the API refused us (429 from its own connection cap).
      //
      // Asking is not optional. Assuming the first produced the false
      // "The harness API is not answering" over a healthy server, and
      // assuming the second would delay every real outage. So the next step
      // is a diagnosis, immediately: the STATEMENT must not wait, and the
      // cadence is chosen by whatever comes back.
      diagnoseNow();
    },
  });
}

function stopLivenessWatch(): void {
  generation += 1;
  disarmSilenceTimer();
  if (reopenTimer !== null) {
    clearTimeout(reopenTimer);
    reopenTimer = null;
  }
  stopLiveness?.();
  stopLiveness = null;
}

/** The single timer of the failure path. One pending step at a time; a
 *  second request while one is armed is dropped, never queued.
 *
 *  NOT named `schedule`: `src/cockpit/rooms/switch-feed.ts` already owns a
 *  top-level function by that name, and two unrelated helpers sharing one
 *  name across the client is the scattered-helper shape the guard refuses. */
function armNextStep(delayMs: number, action: () => void): void {
  if (reopenTimer !== null || port === null) return;
  reopenTimer = setTimeout(() => {
    reopenTimer = null;
    action();
  }, delayMs);
}

/** Arm the next diagnosis. This is the ONLY way back to a socket: every
 *  reconnection is preceded by asking the server what is going on, so no
 *  cadence is ever applied to a cause that was not measured. */
function scheduleDiagnosis(delayMs: number): void {
  armNextStep(delayMs, diagnoseNow);
}

/**
 * ASK THE SERVER WHY, THEN ACT ON THE ANSWER.
 *
 * Each branch pairs the honest STATEMENT with the cadence that cause
 * deserves — the whole point of the diagnosis:
 *
 *   unreached  nothing answered. This is an outage; say so, and come back at
 *              LIVE_STREAM_RETRY_MS, because fast retries are what make
 *              recovery feel instant (measured: 104ms).
 *   refused    THE API ANSWERED. It declined this tab's stream, which is not
 *              an outage and must never be reported as one — the module's own
 *              rule is that a response means reachable, and a 429 is a
 *              response. Back off on the server's own `Retry-After`: an
 *              immediate retry cannot succeed and is what made the exhaustion
 *              permanent.
 *   answered   the API is there and admitting streams. Open one.
 *
 * Nothing is rendered for `refused`. The app is fully operable — every
 * request works — and a banner about our own connection budget would be a
 * warning about nothing the reader can act on, on a screen whose rule is that
 * a fact without a verb gets no pixels. What matters is the sentence NOT
 * said: the server is not called unreachable when it answered.
 */
function diagnoseNow(): void {
  if (port === null) return;
  const mine = generation;
  const asked = port.diagnose();
  void asked.then((d) => {
    // A stale answer belongs to a watch that no longer exists (stopped, or
    // restarted by "try now"). It may not schedule work for the live one.
    if (mine !== generation || port === null) return;
    if (d.outcome === "unreached") {
      noteNotReached("refused", d.elapsedMs);
      scheduleDiagnosis(LIVE_STREAM_RETRY_MS);
      return;
    }
    noteAnswered();
    if (d.outcome === "refused") {
      scheduleDiagnosis(d.retryAfterMs);
      return;
    }
    stopLiveness?.();
    stopLiveness = null;
    connect();
  });
}

/**
 * THE SILENCE WATCHDOG — the half `error` cannot cover.
 *
 * A dead PROCESS closes its socket and the browser tells us at once. A WEDGED
 * process does not: it holds the socket open and simply stops producing, so
 * the connection looks perfect and no event ever fires. The server beats on
 * the keepalive cadence precisely so that its silence is observable, and this
 * is what observes it.
 *
 * The threshold is deliberately generous (`LIVE_STREAM_MISSED_BEATS`). This
 * codebase measures healthy-but-busy stalls in seconds — §1 L1's 8,009ms
 * scan, and a `/api/health` measured at 7,358ms that still returned 200 — and
 * a tight threshold would report those as outages. Missing several beats in a
 * row is the evidence; one late beat is not.
 */
function armSilenceTimer(): void {
  disarmSilenceTimer();
  if (livenessBeatMs === null) return;
  silenceTimer = setTimeout(() => {
    silenceTimer = null;
    // The socket is still open — nothing failed — so this is `slow`, not an
    // outage. It says "the server has stopped talking", which is exactly what
    // is known and no more.
    noteSilent();
  }, livenessBeatMs * LIVE_STREAM_MISSED_BEATS);
}

function disarmSilenceTimer(): void {
  if (silenceTimer !== null) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
}

/**
 * How often the server says it will beat, in ms — the denominator of the
 * silence threshold.
 *
 * Defaulted from the client config owner rather than passed in by each entry.
 * It was an entry-wired value first, and that was wrong twice over: it put a
 * second thing for an entry to forget, and it made the cockpit entry import
 * `client-config.ts`, which the cockpit import law does not allow (the
 * cockpit may reach the Broker, the connection owner, errors, asof and
 * absence — not the whole client config).
 *
 * `null` disables the watchdog, which is the honest behaviour when the beat
 * interval is unknown: a watchdog with a guessed threshold reports invented
 * outages.
 */
let livenessBeatMs: number | null = LIVENESS_BEAT_MS;

/** Test seam: override or disable the cadence the watchdog measures against.
 *  Production uses the config default above. */
export function setLivenessBeatMs(ms: number | null): void {
  livenessBeatMs = ms !== null && ms > 0 ? ms : null;
}

/**
 * Reconnect NOW rather than waiting for the next scheduled step. Bound to tab
 * visibility below, and exported so the block's "try now" verb has something
 * to call — a retry the reader pressed must not be a no-op.
 *
 * It goes through the DIAGNOSIS like every other path, not straight to a
 * socket: pressing "try now" while the server is refusing us should learn
 * that, not re-run the loop that produced it. The socket floor in `connect`
 * still applies, so an impatient reader cannot outpace the outage cadence.
 */
export function probeConnectionNow(): void {
  stopLivenessWatch();
  diagnoseNow();
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    // Only when something is actually wrong. A healthy stream is already
    // open and reconnecting it on every tab switch would be churn for
    // nothing.
    if (document.visibilityState === "visible" && state.get().kind !== "reachable") {
      probeConnectionNow();
    }
  });
}

// ── The writes (called ONLY from broker.ts::fetchJson) ─────────────────────

/**
 * The API produced a response — ANY response, including 401, 404 and 500.
 * Reachability is answered by the fact of a response, not by its status.
 *
 * Recovery is automatic and visible from here: leaving `unreachable`
 * revalidates every standing subscription, so the data on screen refreshes
 * with no manual reload and the banner clears in the same beat.
 */
export function noteAnswered(): void {
  lastAnsweredAt = Date.now();
  timeoutStrikes = 0;
  const was = state.get();
  if (was.kind === "reachable") return;
  state.set({ kind: "reachable" });
  if (was.kind === "unreachable") revalidate?.();
}

/**
 * The API could not be reached. Idempotent per cause: a burst of failures
 * from one outage must not keep re-stamping `since`, or the banner's own
 * "since" would tick forward while nothing changed.
 */
export function noteNotReached(cause: UnreachableCause, elapsedMs: number): void {
  // A TIMEOUT IS NOT A REFUSAL, and treating them alike produced a REAL false
  // outage in the browser: the block appeared over a working cockpit saying
  // "stopped answering after 2s" because one liveness check hit its budget
  // while the server was busy with the boot's heavy read. A closed socket
  // proves the
  // API is not there; a request that ran out of time is equally consistent
  // with a server that is merely working hard, and this codebase measures
  // that case in seconds (DESIGN-PERFORMANCE §1 L1, §5d).
  //
  // So a timeout must corroborate itself: it needs `CONNECTION_TIMEOUT_STRIKES`
  // in a row with NOTHING answering in between. Anything that answers resets
  // the count, because a server that answered something is not unreachable.
  if (cause === "timeout") {
    timeoutStrikes = lastAnsweredAt > lastTimeoutAt ? 1 : timeoutStrikes + 1;
    lastTimeoutAt = Date.now();
    if (timeoutStrikes < CONNECTION_TIMEOUT_STRIKES) {
      // Not yet an outage. It IS the thing `slow` exists to say, and saying
      // it is the honest middle state rather than silence or a lie.
      if (state.get().kind === "reachable") {
        state.set({ kind: "slow", since: Date.now() - elapsedMs });
      }
      return;
    }
  }
  const was = state.get();
  if (was.kind === "unreachable" && was.cause === cause) return;
  // A `slow` THAT BECOMES AN OUTAGE STARTED WHEN THE ANSWERS STOPPED, not
  // when the verdict landed. The silence path states `slow` anchored at the
  // last confirmed-alive beat and then diagnoses; if the diagnosis comes
  // back `unreached`, resetting `since` to now would erase the measured
  // silence and restart the block's clock at 0s over an outage already a
  // watchdog-threshold old.
  const since = was.kind === "slow" ? was.since : Date.now();
  state.set({ kind: "unreachable", cause, since, elapsedMs });
}

/** When the API last produced a response — the reset point for the timeout
 *  strike count. See `noteNotReached`. */
let lastAnsweredAt = 0;

/** When the last request timed out, and how many have timed out in a row
 *  without anything answering between them. See `noteNotReached`. */
let lastTimeoutAt = 0;
let timeoutStrikes = 0;

/**
 * THE LIVENESS STREAM HAS GONE QUIET — the socket is open and the beats have
 * stopped.
 *
 * ONLY THE STREAM MAY SET THIS, and an earlier draft got it wrong by letting
 * any slow request do it: browser-measured, the bar flashed on and off
 * against a completely healthy server, because ordinary reads legitimately
 * run long while `/api/health` was answering in 6–12ms throughout. A bar that
 * appears during normal, working use is noise, and noise is how a real
 * warning stops being read.
 *
 * The distinction is not cosmetic. `slow` is a claim about the CONNECTION,
 * and a big read taking four seconds says nothing about the connection —
 * that is the READ's business (DESIGN-PERFORMANCE §1 L2) and belongs to the
 * surface waiting on it. The liveness stream is the one channel whose silence
 * means only one thing, which is why it is the only one allowed to speak here.
 *
 * It is `slow` and NOT an outage on purpose: the socket is still open, so
 * nothing has failed. "The server has stopped talking" is exactly what is
 * known, and no more.
 *
 * Only ever a DOWNGRADE from `reachable`: an outage we already know about is
 * a stronger statement than "this is taking a while", and letting silence
 * overwrite it would replace a true sentence with a vaguer one.
 */
function noteSilent(): void {
  if (state.get().kind === "reachable") {
    // ANCHORED AT THE LAST CONFIRMED-ALIVE INSTANT, not at the verdict.
    // The watchdog fires a whole threshold AFTER the beats stopped; "0s"
    // at that moment would claim the silence just began, and anchoring at
    // the stream's OPEN would claim the whole session was silent. The last
    // beat is the newest moment the server was provably there, so it is
    // the honest start of the silence being reported.
    state.set({ kind: "slow", since: silenceAnchorMs(Date.now(), lastAnsweredAt) });
  }
  // SILENCE IS EVIDENCE, NOT A VERDICT — ask. Behind the dev proxy a dead
  // upstream never closes this socket (the proxy holds the client side
  // open), so the watchdog is the ONLY detector there is, and before this
  // call the path ended here: "slow" forever, ~90s behind an outage the
  // doctrine says must read as one. The diagnosis converts the silence
  // into a measured verdict — the proxy's unsigned 502 reads as
  // `unreached` and the block appears; a server that answers (busy but
  // alive) clears it, which is exactly the production semantics unchanged.
  diagnoseNow();
}

/**
 * Where a reported silence STARTS: the last confirmed-alive instant when
 * one exists, else the moment of the report (never earlier — a stream that
 * has never beaten proves nothing about the past). Exported for the elapsed
 * math to be testable as arithmetic rather than by racing timers.
 */
export function silenceAnchorMs(nowMs: number, lastAliveAtMs: number): number {
  return lastAliveAtMs > 0 ? Math.min(lastAliveAtMs, nowMs) : nowMs;
}

/**
 * The budget a request should be given, in ms.
 *
 * While the API is known to be unreachable, a request must not sit on the
 * full 30s budget: we already know how that ends, and thirty seconds of
 * nothing is exactly the "it does not load" the user reported. An explicit
 * `timeoutMs` from a caller always wins — a caller that named its own budget
 * knows something this module does not.
 */
export function requestBudgetMs(defaultMs: number): number {
  return state.get().kind === "unreachable"
    ? Math.min(defaultMs, CONNECTION_UNREACHABLE_TIMEOUT_MS)
    : defaultMs;
}

/** A request being watched. Exactly one of the three verbs is called. */
export type ConnectionWatch = Readonly<{
  /** A response arrived. Pass it: the identity header decides whether the
   *  API answered or something in front of it did. */
  responded: (res: Response) => void;
  /** No response arrived. */
  failed: (cause: UnreachableCause) => void;
  /** End the watch without reaching a verdict (the caller aborted). */
  release: () => void;
}>;

/**
 * Begin watching one request. Ended by exactly one of the three verbs; every
 * later call is a no-op (see the latch inside).
 */
export function watchRequest(): ConnectionWatch {
  const startedAt = Date.now();
  // NO SLOW TIMER HERE. An ordinary request's duration is not evidence about
  // the connection (see `noteSilent`); this watch reports only the two
  // things a single request CAN prove — that the API answered, or that it
  // could not be reached.
  // ENDED ONCE. A request that answered and then failed to PARSE is still a
  // request the API answered, and `fetchJson`'s one catch block cannot tell
  // the two apart by itself — a malformed body arrives at the same `catch`
  // as a refused socket. Without this latch, a JSON parse error over a real
  // 200 would be reported as an outage that is not happening.
  let ended = false;
  const end = (): boolean => {
    if (ended) return false;
    ended = true;
    return true;
  };
  return {
    responded(res: Response): void {
      if (!end()) return;
      // TWO CONDITIONS, AND BOTH ARE REQUIRED. See
      // `GATEWAY_UNREACHED_STATUSES` for why neither is sufficient alone —
      // the API itself answers 502 when a model provider fails, and a proxy
      // that strips unknown headers would otherwise make every healthy 200
      // read as an outage.
      //
      // A response with no readable headers at all is a TEST DOUBLE, not a
      // proxy error: every real `fetch` resolves with a `Response`, which
      // always carries a `Headers`. Dozens of suites stub `global.fetch`
      // with `{ ok: true, json: … }` while testing something else, and the
      // correct reading there is the same as everywhere — a response came
      // back, so the API answered.
      const headers: Headers | undefined = res.headers;
      const signed =
        typeof headers?.get !== "function" ||
        headers.get(API_IDENTITY_HEADER) !== null;
      if (signed || !GATEWAY_UNREACHED_STATUSES.includes(res.status)) {
        noteAnswered();
        return;
      }
      // An unsigned gateway-class status: something in front of the API
      // answered FOR it — in dev, the Vite proxy's synthesized 502. The API
      // was not reached, and saying "reachable" here would be the lie.
      noteNotReached("refused", Date.now() - startedAt);
    },
    failed(cause: UnreachableCause): void {
      if (!end()) return;
      noteNotReached(cause, Date.now() - startedAt);
    },
    release(): void {
      end();
    },
  };
}

/** Test seam: return the state to its initial value and cancel any pending
 *  socket. Production never calls this — a real page has one connection for
 *  its whole life. */
export function resetConnectionForTest(): void {
  stopLivenessWatch();
  port = null;
  shareUnsubscribe?.();
  shareUnsubscribe = null;
  share = null;
  isLeader = false;
  // The page singleton too: it is only "the page's" in production, and a
  // test that restarts a watch must be able to re-elect from scratch. Both
  // shares guard `elect` as idempotent (the documented contract), so without
  // this a second watch in one test process would silently never connect.
  pageShare = null;
  livenessBeatMs = LIVENESS_BEAT_MS;
  lastAnsweredAt = 0;
  lastTimeoutAt = 0;
  timeoutStrikes = 0;
  // The socket floor is measured from the last ATTEMPT, so a fresh test must
  // start from a clean one or the first connect of one test is delayed by the
  // last connect of the previous.
  lastAttemptAt = 0;
  state.set({ kind: "reachable" });
}
