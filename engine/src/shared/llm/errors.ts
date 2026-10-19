/**
 * LLM typed error hierarchy — the ONE canonical owner of every LLM error
 * shape. Replaces the scattered ad-hoc `if (status === 429) sleep(5000)`
 * branches agents used to write.
 *
 * Thirteen error types (per the v2 spec):
 * 1. rate-limit (429)
 * 2. server (500/502/503/504)
 * 3. network (ECONNRESET/ETIMEDOUT/ENOTFOUND/fetch failed)
 * 4. auth (401, 403)
 * 5. bad-request (400, generic)
 * 6. model-not-found (404)
 * 7. context-too-long (400 + context_length_exceeded)
 * 8. truncation (finish_reason === "length" surfaced as an error)
 * 9. invalid-response (malformed/invalid JSON)
 * 10. timeout (AbortController fired)
 * 11. empty-response (no content)
 * 12. streaming (stream ended without finish / mid-stream drop)
 * 13. overloaded (529 service overloaded)
 *
 * Each error carries: a stable `code`, an `errorType` discriminant, a
 * `retryable` flag, an optional HTTP `status`, and `safeDetails` with NO
 * raw credentials, prompts, or PII.
 */

/** Derived from `ALL_ERROR_TYPES` below — see the note there. */
export type ErrorType = typeof ALL_ERROR_TYPES[number];

export type SafeDetails = Readonly<Record<string, string | number | boolean | null>>;
/** Native policy refusal stops automatic work in the affected conversation. */
export const MISALIGNMENT_POLICY_ERROR_CODE = "llm_misalignment_policy_violation";

export class LLMError extends Error {
  readonly code: string;
  readonly errorType: ErrorType;
  readonly retryable: boolean;
  /** Observed HTTP status only; native failures may have no transport status. */
  readonly status: number | undefined;
  readonly safeDetails: Readonly<SafeDetails>;

  constructor(
    message: string,
    code: string,
    errorType: ErrorType,
    retryable: boolean,
    safeDetails: SafeDetails = {},
    status?: number,
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.errorType = errorType;
    this.retryable = retryable;
    this.safeDetails = Object.freeze({ ...safeDetails });
    this.status = status;
  }
}

/** Private callback failures expose taxonomy only, never callback text, details, or causes. */
export const RESPONSE_OBSERVER_ERROR_CODE = "llm_response_observer_failed";
export class ResponseObserverError extends LLMError {
  constructor(error: unknown) {
    const { errorType, status } = observerTaxonomy(error);
    // Accepted evidence or receipt publication is never authority to repeat generation.
    super("Response observer failed", RESPONSE_OBSERVER_ERROR_CODE, errorType, false, {}, status);
  }
}
function observerTaxonomy(error: unknown): { errorType: ErrorType; status?: number } {
  try {
    if (isLLMError(error)) {
      const { errorType, status } = error;
      if (ALL_ERROR_TYPES.includes(errorType)) return { errorType,
        ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}) };
    }
  } catch { return { errorType: "invalid-response" }; }
  return { errorType: "invalid-response" };
}

/** A required request observer never grants transport retry authority. */
export const REQUEST_OBSERVER_ERROR_CODE = "llm_request_observer_failed";
export class RequestObserverError extends LLMError {
  constructor() {
    super("Required provider request observer failed", REQUEST_OBSERVER_ERROR_CODE, "invalid-response", false);
  }
}

/** Rate limit. Retryable. Honors `Retry-After` (ms). */
export class RateLimitError extends LLMError {
  readonly retryAfterMs: number | undefined;
  constructor(message: string, retryAfterMs?: number, safeDetails: SafeDetails = {}, status?: number) {
    super(message, "llm_rate_limited", "rate-limit", true, safeDetails, status);
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

/** 500/502/503/504 server error. Retryable. */
export class ServerError extends LLMError {
  constructor(message: string, status: number, safeDetails: SafeDetails = {}) {
    super(message, "llm_server_error", "server", true, safeDetails, status);
  }
}

/** Provider overload. Retryable with longer backoff. */
export class OverloadedError extends LLMError {
  constructor(message: string, safeDetails: SafeDetails = {}, status?: number) {
    super(message, "llm_overloaded", "overloaded", true, safeDetails, status);
  }
}

/** Network/transport failure (ECONNRESET, ETIMEDOUT, ENOTFOUND, fetch failed). Retryable. */
export class NetworkError extends LLMError {
  constructor(message: string, safeDetails: SafeDetails = {}) {
    super(message, "llm_network_error", "network", true, safeDetails);
  }
}

/** 401/403 auth failure. NOT retryable — the key is wrong. */
export class AuthError extends LLMError {
  constructor(message: string, status: number, safeDetails: SafeDetails = {}) {
    super(message, "llm_auth_error", "auth", false, safeDetails, status);
  }
}

/** Rejected request. NOT retryable. */
export class BadRequestError extends LLMError {
  constructor(message: string, safeDetails: SafeDetails = {}, status?: number) {
    super(message, "llm_bad_request", "bad-request", false, safeDetails, status);
  }
}

/** Model or model endpoint not found. NOT retryable. */
export class ModelNotFoundError extends LLMError {
  constructor(message: string, safeDetails: SafeDetails = {}, status?: number) {
    super(message, "llm_model_not_found", "model-not-found", false, safeDetails, status);
  }
}

/** Context capacity exceeded. NOT retryable. Counts are optional observations. */
export class ContextTooLongError extends LLMError {
  readonly promptTokens: number | undefined;
  readonly maxTokens: number | undefined;
  constructor(
    message: string,
    safeDetails: SafeDetails = {},
    promptTokens?: number,
    maxTokens?: number,
    status?: number,
  ) {
    super(message, "llm_context_too_long", "context-too-long", false, safeDetails, status);
    if (promptTokens !== undefined) this.promptTokens = promptTokens;
    if (maxTokens !== undefined) this.maxTokens = maxTokens;
  }
}

/** Truncation: `finish_reason === "length"` and the caller asked to treat it as an error. Not retryable. */
export class TruncationError extends LLMError {
  constructor(message: string, safeDetails: SafeDetails = {}) {
    super(message, "llm_truncation", "truncation", false, safeDetails);
  }
}

/** Malformed/invalid JSON response. Retryable once. */
export class InvalidResponseError extends LLMError {
  constructor(message: string, safeDetails: SafeDetails = {}, status?: number) {
    super(message, "llm_invalid_response", "invalid-response", true, safeDetails, status);
  }
}

/** Request exceeded the per-request timeout (AbortController fired). NOT retryable. */
export class TimeoutError extends LLMError {
  constructor(message: string, safeDetails: SafeDetails = {}) {
    super(message, "llm_timeout", "timeout", false, safeDetails);
  }
}

/**
 * Project a private abort reason into fresh, fixed public diagnostics. This
 * classifies the reason; it does not establish who owns a deadline. Never
 * copy a caller's message/code/details/cause or change signal.reason.
 */
function isTimeoutReason(reason: unknown): boolean {
  try {
    // The intrinsic DOMException getter verifies its internal brand and
    // ignores an overridden public name getter. Hostile proxies fail closed.
    return reason instanceof TimeoutError ||
      Object.getOwnPropertyDescriptor(DOMException.prototype, "name")?.get?.call(reason) === "TimeoutError";
  } catch {
    return false;
  }
}
export function safeAbortError(reason: unknown): LLMError {
  return isTimeoutReason(reason) ? new TimeoutError("Provider operation exceeded its deadline")
    : new LLMError("Provider operation cancelled by caller", "llm_cancelled", "timeout", false);
}

/** Response had no content. Retryable once. */
export class EmptyResponseError extends LLMError {
  constructor(message: string, safeDetails: SafeDetails = {}) {
    super(message, "llm_empty_response", "empty-response", true, safeDetails);
  }
}

/** Streaming failure: stream ended without a finish event or a mid-stream drop. Retryable before first chunk. */
export class StreamingError extends LLMError {
  constructor(message: string, safeDetails: SafeDetails = {}) {
    super(message, "llm_streaming_error", "streaming", true, safeDetails);
  }
}

/** Discriminated guard helpers (no `instanceof` switches in callers). */
export function isLLMError(error: unknown): error is LLMError {
  return error instanceof LLMError;
}

export function isRetryable(error: unknown): boolean {
  return error instanceof LLMError && error.retryable;
}

/**
 * Parse an OpenAI-style `context_length_exceeded` message and extract the
 * prompt token count and the model's max context. Returns `null` when the
 * numbers cannot be parsed.
 */
export function parseContextTooLong(body: string): { promptTokens: number; maxTokens: number } | null {
  const maxMatch = /maximum context length is (\d+)/i.exec(body);
  const promptMatch = /resulted in (\d+) tokens/i.exec(body);
  if (maxMatch === null || promptMatch === null) return null;
  const maxTokens = Number(maxMatch[1]);
  const promptTokens = Number(promptMatch[1]);
  if (!Number.isFinite(maxTokens) || !Number.isFinite(promptTokens)) return null;
  return { promptTokens, maxTokens };
}

/**
 * Every error type, in spec order — AND THE OWNER OF THE `ErrorType` UNION,
 * which is derived from it below.
 *
 * The two used to be written separately, and the doc comment said "all
 * thirteen" while the annotation `readonly ErrorType[]` accepted any subset
 * of the union. A fourteenth type would have been added to the union,
 * compiled, and then been missing from the one list callers iterate — the
 * comment counting the members it could no longer see.
 */
export const ALL_ERROR_TYPES = Object.freeze([
  "rate-limit", "server", "network", "auth", "bad-request", "model-not-found",
  "context-too-long", "truncation", "invalid-response", "timeout", "empty-response",
  "streaming", "overloaded",
] as const);
