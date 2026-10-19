/**
 * THE ONE RETRY DELAY — exponential backoff with a ceiling, optional jitter
 * and a server's own `Retry-After` honoured as a floor. The LLM provider
 * client and the MCP retry layer both ask here (they used to carry two
 * engines: one with jitter and Retry-After, one without either).
 */

export type BackoffPolicy = Readonly<{
  /** The first retry's delay, in milliseconds. */
  baseMs: number;
  /** The multiplier per further retry. */
  factor: number;
  /** The ceiling on any one delay. */
  maxMs: number;
  /** ± fraction of random spread (0 = deterministic). */
  jitter: number;
}>;

/**
 * The delay before retry number `retry` (0 = the first retry). A server's
 * `retryAfterMs` wins over a shorter computed delay and is never cut by the
 * ceiling (the server said when to come back).
 */
export function backoffDelayMs(policy: BackoffPolicy, retry: number, retryAfterMs?: number): number {
  let delay = retryAfterMs ?? policy.baseMs * policy.factor ** Math.max(0, retry);
  if (policy.jitter > 0) delay *= 1 + (Math.random() * 2 - 1) * policy.jitter;
  return Math.ceil(Math.max(retryAfterMs ?? 0, 0, Math.min(policy.maxMs, delay)));
}
