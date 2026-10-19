/**
 * THE EGRESS DOORS' OWN FAILURES, COUNTED — the two answers a door gives when
 * the bytes it was handed cannot be made safe to send:
 *
 * - `lastResortResponses`: an HTTP error response that could not be mapped or
 *   redacted, answered with the fixed 503 instead (`server/router/router.ts`);
 * - `framesWithheld`: an SSE frame that could not be redacted or serialized,
 *   withheld (a resumable frame is replaced by a `replay_gap`, the stream kept;
 *   `server/router/sse.ts`).
 *
 * Each is also logged at its door (`webHandleError`); these counters are what
 * the `redaction.lastResortResponses` / `redaction.framesWithheld` signals
 * serve, so a surface can see the doors fall back without reading a log.
 * Process-lifetime counts, from zero at boot.
 */

let lastResortResponses = 0;
let framesWithheld = 0;

/** One HTTP error answered with the fixed last-resort 503. */
export function noteLastResortResponse(): void {
  lastResortResponses += 1;
}

/** One SSE frame withheld because it could not be made safe to send. */
export function noteFrameWithheld(): void {
  framesWithheld += 1;
}

/** Both counts, as the exposure signals read them. */
export function egressFailureCounts(): Readonly<{ lastResortResponses: number; framesWithheld: number }> {
  return { lastResortResponses, framesWithheld };
}
