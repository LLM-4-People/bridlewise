/**
 * ONE OWNER for the settle-and-poll mechanics of a dev-server-boot probe that
 * judges a SERVED transform artifact.
 *
 * ── THE DEFECT THIS CLOSES (DESK-CSS-2) ───────────────────────────────────
 *
 * The vite dev server answers `health 200` BEFORE the compile pipeline has
 * populated the metadata a transform request reads. A probe fired the instant
 * health is green lands inside a warmup window where the artifact read still
 * falls through to the raw source — the TRANSIENT warmup read, not the page
 * the browser gets (the browser loads the component first and only then its
 * style, by which time the metadata is populated). A probe that reads ONCE at
 * health-green false-refuses a healthy boot.
 *
 * ── THE PATTERN, OWNED ONCE ────────────────────────────────────────────────
 *
 * Every boot-time probe that fetches a served transform artifact (a compiled
 * style module today; a compiled-JS, sourcemap or served-manifest probe
 * tomorrow) shares the same mechanics, and only the JUDGMENT differs:
 *
 *   1. WARM the parent module first — the browser's order. The artifact is
 *      served from the parent's compile metadata, which the artifact request
 *      reads only after the parent has compiled.
 *   2. POLL the artifact read through a short settle window.
 *   3. REFUSE only a PERSISTENT bad read — a read still bad once the pipeline
 *      has had every chance to settle. A transient bad read inside the window
 *      is the warmup artifact, not the defect.
 *
 * The probe-specific half (which URLs, what "bad" means, the refusal wording)
 * stays with the probe: the caller supplies `judge`, a pure function over the
 * fetched artifact body. This module owns the window, the retry pacing and
 * the verdict — never the CSS-specific classification.
 *
 * Everything is split pure (the window verdict, fixture-driven in
 * `tests/prevention/served-module-probe.test.ts`) from live (the `sleep`
 * between polls, injected so the deciding logic is tested without a clock).
 *
 * DEPENDENCY-FREE ON PURPOSE: node built-ins only, like its neighbours.
 */

/** How long a probe tolerates a transient bad read before refusing. */
export const SERVED_MODULE_SETTLE_WINDOW_MS = 12_000;

/** The pace between polls inside the settle window. */
export const SERVED_MODULE_POLL_INTERVAL_MS = 1_000;

/**
 * One observed read, reduced to its verdict input. `fetchFailed` is a fetch
 * that threw or carried no judgeable payload (the server still coming up);
 * `judgment` is the probe's pure verdict over the body — `null` is clean.
 */
export interface ServedModuleObservation {
  readonly fetchFailed: boolean;
  readonly judgment: string | null;
}

/** What the window concluded. */
export type ServedModuleWindowVerdict =
  | { readonly kind: "settled-clean" }
  | { readonly kind: "not-judged" }
  | { readonly kind: "refused"; readonly judgment: string };

/**
 * THE WINDOW VERDICT, pure over the observation sequence. The sequence is
 * everything the probe saw inside the settle window, oldest first; `elapsedMs`
 * is the window's consumed time at sequence end.
 *
 *   - A clean read settles the probe immediately: `settled-clean`.
 *   - A BAD read inside the window is transient — the loop keeps polling
 *     (`null`, keep going). Only a bad read whose window has CLOSED
 *     (`elapsedMs` past the settle window) is the persistent defect: `refused`.
 *   - A window that closed without ONE judgeable read (every fetch failed or
 *     carried no payload) is `not-judged`: absence, reported plainly by the
 *     caller — never a refusal manufactured from a probe that never saw the
 *     server answer, and never a pass claimed without evidence.
 */
export function servedModuleWindowVerdict(
  observations: readonly ServedModuleObservation[],
  elapsedMs: number,
): ServedModuleWindowVerdict | null {
  let lastJudgment: string | null = null;
  let sawJudgeableRead = false;
  for (const observation of observations) {
    if (observation.fetchFailed) continue; // still coming up — never judged
    sawJudgeableRead = true;
    if (observation.judgment === null) return { kind: "settled-clean" };
    lastJudgment = observation.judgment;
  }
  if (elapsedMs < SERVED_MODULE_SETTLE_WINDOW_MS) return null; // keep polling
  if (sawJudgeableRead && lastJudgment !== null) {
    return { kind: "refused", judgment: lastJudgment };
  }
  return { kind: "not-judged" };
}

export interface PollServedModuleOptions {
  /** Milliseconds between polls; defaults to the shared pace. */
  readonly pollIntervalMs?: number;
  /** Injected in tests; defaults to a real sleep. */
  readonly sleep?: (ms: number) => void;
  /** Injected in tests; defaults to the wall clock. */
  readonly now?: () => number;
}

/**
 * THE LIVE LOOP. Fetches the artifact the way the browser gets it — parent
 * module first, then the artifact — and polls through the settle window,
 * returning the window's verdict. `warm` and `readServed` THROW on a transport
 * failure; a throw is "still coming up" and retries, never a judgment.
 *
 * The caller reports the verdict: `refused` exits non-zero (a wedged server
 * cannot be reported up), `not-judged` is logged plainly and does not fail
 * the boot, `settled-clean` logs the pass.
 */
export function pollServedModule(
  warm: () => void,
  readServed: () => string,
  judge: (body: string) => string | null,
  options: PollServedModuleOptions = {},
): ServedModuleWindowVerdict {
  const pollIntervalMs = options.pollIntervalMs ?? SERVED_MODULE_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? ((ms: number) => sleepSync(ms));
  const now = options.now ?? (() => Date.now());
  const started = now();
  const observations: ServedModuleObservation[] = [];
  for (;;) {
    let observation: ServedModuleObservation;
    try {
      warm(); // the browser's order: the parent compiles first…
      const body = readServed(); // …then the artifact reads its compile metadata
      observation = { fetchFailed: false, judgment: judge(body) };
    } catch {
      observation = { fetchFailed: true, judgment: null };
    }
    observations.push(observation);
    const verdict = servedModuleWindowVerdict(observations, now() - started);
    if (verdict !== null) return verdict;
    sleep(pollIntervalMs);
  }
}

/** The real sleep the live loop paces itself with. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
