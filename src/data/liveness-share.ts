/**
 * THE LIVENESS SHARE — one liveness socket per origin, held by one elected
 * tab.
 *
 * ── WHY THIS MODULE EXISTS (UIE-044, measured) ──────────────────────────────
 *
 * Chrome pins SIX HTTP/1.1 TCP connections per origin per browser context.
 * Every logged-in tab used to open its own `/api/live` EventSource at boot
 * and hold it for its whole life, so N tabs pinned N of the six slots —
 * measured live (the UIE-044 drive): with six tabs every further request in
 * the context queued forever ("Stalled"), the broker's 30s request timeout
 * aborted them as a group (`net::ERR_ABORTED`, no server row), and a steer
 * POST died exactly that way while the server recorded nothing. Five tabs
 * plus one watched live run is the same world: the run's stream is the sixth
 * slot.
 *
 * But the fact the liveness stream carries — "is this origin's API
 * answering?" — is ONE fact per origin. N sockets for one fact is the
 * defect, and the fix is consolidation: ONE tab, elected, holds the stream;
 * the others derive the same connection state from its broadcasts.
 *
 * ── THE ELECTION IS THE BROWSER'S, NOT OURS ────────────────────────────────
 *
 * A hand-rolled heartbeat (each tab broadcasts liveness, the quietest tab
 * wins) is a distributed-systems problem smuggled into a web page: it has
 * split-brain windows, tie-break races, and its own watchdog to maintain.
 * The Web Locks API already answers exactly this question with the
 * document's own lifetime as the liveness guarantee:
 *
 *   - `navigator.locks.request(name, callback)` wakes ONE waiting tab at a
 *     time; the first tab to ask becomes the holder;
 *   - the lock is RELEASED THE INSTANT the holding document goes away
 *     (closed tab, crashed renderer), and the next waiter is woken
 *     immediately — no heartbeat to miss, no election timeout to tune;
 *   - the holder keeps the lock by never resolving the callback's promise,
 *     which is a held resource, not a spin.
 *
 * So leadership here has exactly one rule: the tab whose lock callback runs
 * is the leader. Everything else is bookkeeping.
 *
 * ── THE BROADCASTS ──────────────────────────────────────────────────────────
 *
 * The leader re-broadcasts the two signals its own stream gives it —
 * `beat` (an alive signal arrived) and `down` (the socket dropped while the
 * browser retries). Followers apply them to the SAME connection-state
 * machine they already run (see `src/data/connection.ts`); each tab still
 * diagnoses outages with its own requests, so a follower is never trusting a
 * silent partner for a verdict — the broadcasts only carry what a held
 * socket observes, which is the one thing a follower no longer has.
 *
 * ── DEGRADATION IS THE LEGACY BEHAVIOUR, NOT A SECOND IMPLEMENTATION ───────
 *
 * Where the platform pieces are missing (the node test environment, jsdom,
 * ancient browsers), `webLivenessShare` answers `null` and the watch falls
 * back to the solo shape — every tab its own stream, exactly the behaviour
 * that predates this module. One code path where the platform supports it;
 * the honest old behaviour where it does not.
 */

/** What the leader's stream observed. The whole payload vocabulary — a
 *  follower needs nothing else to run the same state machine the leader
 *  does, because diagnosis (a plain request) is every tab's own. */
export type LivenessSignal = "beat" | "down";

/** The election + broadcast mechanism. Implemented twice: the Web Locks
 *  shape for real pages, an injectable shape for tests. */
export interface LivenessShare {
  /** Queue this tab for leadership. The callback runs exactly once, when
   *  this tab is elected — which for the first tab to ask is immediately.
   *  Idempotent per share: a second call on the same share is ignored, so a
   *  watch that stops and restarts inside one tab cannot double-claim. */
  elect(onLeader: () => void): void;
  /** The leader tells the context's other tabs what its stream observed.
   *  A follower or solo tab calling this is a no-op — only a leader has an
   *  audience by construction. */
  broadcast(signal: LivenessSignal): void;
  /** Subscribe to the leader's signals. Returns the unsubscribe. */
  onSignal(listener: (signal: LivenessSignal) => void): () => void;
}

/**
 * The share the real page uses: Web Locks elect, BroadcastChannel speaks.
 *
 * `null` — not a degraded object — when any platform piece is absent: the
 * caller falls back to the solo share, and the `null` answer is the whole
 * reason the fallback cannot drift into a second half-implementation that
 * thinks it is sharing when it is not.
 *
 * A BROWSER CONTEXT IS A PRECONDITION, NOT A TEST CONVENIENCE. The whole
 * mechanism rests on the lock releasing the instant its holder's DOCUMENT
 * goes away — that release is what hands leadership to the next tab with no
 * heartbeat to miss. Node now ships `navigator.locks` (measured: Node 24
 * answers a `LockManager`), but a node process has no document whose
 * destruction could release a lock, so a share elected there would hold its
 * lock forever and wedge every later election in the process — the exact
 * pollution measured on the connection suite when this precondition was
 * missing. `window`/`document` presence is the honest line between "a page,
 * whose lifetime the browser owns" and "a runtime that merely has the
 * objects".
 */
export function webLivenessShare(
  lockName: string,
  channelName: string,
): LivenessShare | null {
  const page = globalThis as Readonly<{
    window?: unknown;
    document?: unknown;
    navigator?: Readonly<{ locks?: { request(name: string, cb: (lock: unknown) => Promise<never> | void): Promise<void> } }>;
    BroadcastChannel?: new (name: string) => {
      postMessage(message: unknown): void;
      close(): void;
      addEventListener(type: "message", cb: (e: Readonly<{ data: unknown }>) => void): void;
    };
  }>;
  if (page.window === undefined || page.document === undefined) return null;
  const locks = page.navigator?.locks;
  const Channel = page.BroadcastChannel;
  if (locks === undefined || Channel === undefined) return null;

  const channel = new Channel(channelName);
  const listeners = new Set<(signal: LivenessSignal) => void>();
  let elected = false;

  channel.addEventListener("message", (e) => {
    if (e.data !== "beat" && e.data !== "down") return;
    for (const listener of [...listeners]) listener(e.data);
  });

  return {
    elect(onLeader: () => void): void {
      if (elected) return;
      elected = true;
      // The callback's never-resolving promise is HOW the lock is held: it
      // releases only when this document goes away, and the browser then
      // wakes the next waiting tab. A resolved promise here would hand
      // leadership straight to the next tab and re-elect on its next boot
      // step — the opposite of the guarantee this module exists for.
      void locks.request(lockName, () => {
        onLeader();
        return new Promise<never>(() => undefined);
      });
    },
    broadcast(signal: LivenessSignal): void {
      channel.postMessage(signal);
    },
    onSignal(listener: (signal: LivenessSignal) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * The fallback share: no peers exist, so this tab is elected at once and its
 * broadcasts have no audience. This is the pre-share behaviour, kept as ONE
 * honest object rather than a `share === null` special case at every call
 * site — the watch runs the same code path either way.
 */
export function soloLivenessShare(): LivenessShare {
  let elected = false;
  return {
    elect(onLeader: () => void): void {
      // The same idempotence contract as the web share: one election per
      // share, so a tab that restarts its watch re-elects only through a
      // fresh share (the reset seam builds one).
      if (elected) return;
      elected = true;
      onLeader();
    },
    broadcast(): void {
      // No other tab can be listening in a solo world.
    },
    onSignal(): () => () => undefined {
      return () => () => undefined;
    },
  };
}
