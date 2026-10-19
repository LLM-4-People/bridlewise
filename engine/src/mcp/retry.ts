/**
 * MCP retry layer — seamless error handling for tool calls and transport
 * failures. Two scopes:
 *
 * 1. **Per-call retry** (`withRetry`): wraps a single `tools/call` (or any
 * JSON-RPC request) and retries on a retryable `McpError` up to
 * `retry.count` times with exponential backoff (base `retry.backoffMs`,
 * capped at 10× base). Non-retryable errors rethrow immediately. The
 * caller's `AbortSignal` is honored between attempts.
 *
 * 2. **Transport restart** (`restartTransport`): when the transport itself
 * drops (stdio process crashed, SSE stream closed, WebSocket closed),
 * the registry calls `restartTransport` to re-`connect` the transport
 * and re-`initialize` the session. This is transparent to tool callers
 * because the retry layer re-runs the call after a successful restart.
 *
 * The retry budget is bounded: after `retry.count` attempts the last error
 * is rethrown. Every attempt is logged via the optional `onAttempt` callback
 * so the exposure layer can count retries, measure per-attempt latency, and
 * surface the last error.
 */

import { HarnessError, isAbortError } from "../kernel/errors.ts";
import { abortableDelay } from "../shared/abort-signals.ts";
import { backoffDelayMs } from "../shared/backoff.ts";
import { McpError } from "./errors.ts";

export type McpRetryConfig = Readonly<{
  count: number;
  backoffMs: number;
}>;

export const DEFAULT_MCP_RETRY: McpRetryConfig = Object.freeze({ count: 3, backoffMs: 1000 });

export type RetryAttempt = Readonly<{
  attempt: number;
  ok: boolean;
  durationMs: number;
  error?: string;
  errorRetryable?: boolean;
}>;

export type RetryObserver = (attempt: RetryAttempt) => void;

/** The shape of the MCP retry curve around the configured base: doubling, capped at 10× the base (the protocol's retry mechanics, not an operator setting). */
const MCP_BACKOFF_CURVE = Object.freeze({ factor: 2, ceilingMultiple: 10 });

/** The MCP retry delay: attempt N waits `backoffMs * 2^(N-1)` ms, capped at 10× — through the one backoff owner. */
export function backoffDelay(attempt: number, backoffMs: number): number {
  return backoffDelayMs({ baseMs: backoffMs, factor: MCP_BACKOFF_CURVE.factor, maxMs: backoffMs * MCP_BACKOFF_CURVE.ceilingMultiple, jitter: 0 }, attempt - 1);
}

/** Retry a single operation on retryable errors. Returns its result on success. */
export async function withRetry<T>(
  operation: (signal?: AbortSignal) => Promise<T>,
  options: Readonly<{ retry: McpRetryConfig; signal?: AbortSignal; onAttempt?: RetryObserver }>,
): Promise<T> {
  const retry = options.retry;
  const maxAttempts = Math.max(1, retry.count);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.signal?.aborted) {
      throw new McpError("MCP operation cancelled before attempt", "mcp_cancelled", false, {});
    }
    const start = Date.now();
    let attemptOk = false;
    try {
      const result = await operation(options.signal);
      attemptOk = true;
      options.onAttempt?.({ attempt, ok: attemptOk, durationMs: Date.now() - start });
      return result;
    } catch (error) {
      lastError = error;
      // EVERY typed harness error carries its own retryable verdict — an
      // MCP error, and the outbound door's policy refusals (a redirect,
      // cleartext, a bad header: never retryable). Reading only McpError's
      // flag re-sent a redirected request `retry.count` times (secb-design F-1).
      const retryable = error instanceof HarnessError ? error.retryable : !isAbortError(error);
      options.onAttempt?.({
        attempt,
        ok: attemptOk,
        durationMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
        errorRetryable: retryable,
      });
      if (!retryable || attempt === maxAttempts) {
        throw error;
      }
      const delay = backoffDelay(attempt, retry.backoffMs);
      try {
        await abortableDelay(delay, options.signal);
      } catch {
        throw new McpError("MCP retry cancelled during backoff", "mcp_cancelled", false, {});
      }
    }
  }
  throw lastError;
}

/** Reconnect a transport that dropped, then re-run the operation.
 * Only reconnects on transport-level errors (connection dead). Transient
 * call failures (timeouts, 5xx, server-returned errors) just retry. */
export async function withReconnect<T>(
  operation: (signal?: AbortSignal) => Promise<T>,
  reconnect: (signal?: AbortSignal) => Promise<void>,
  options: Readonly<{ retry: McpRetryConfig; signal?: AbortSignal; onAttempt?: RetryObserver }>,
): Promise<T> {
  return withRetry(async (signal) => {
    try {
      return await operation(signal);
    } catch (error) {
      if (error instanceof McpError && error.retryable && isTransportError(error)) {
        await reconnect(signal);
      }
      throw error;
    }
  }, options);
}

/**
 * Transport-level classification — owned by the error itself, not by a
 * keyword list. Transports set `transportLevel: true` when they throw;
 * the retry layer asks the error whether it is transport-level. This
 * keeps the classification DRY (no separate code set that can drift from
 * the codes the transports actually throw).
 */
export function isTransportError(error: McpError): boolean {
  return error.transportLevel;
}
