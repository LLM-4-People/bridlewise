/** One safe provider failure classifier for HTTP, native events and socket adapters. */
import { redactMessagesTogether } from "../../privacy/redaction-engine.ts";
import { DEFAULT_PRIVACY_POLICY, redactionReplacement } from "../../privacy/privacy-policy.ts";
import { isPlainObject } from "../type-guards.ts";
import { EMPTY_HELD_SET, type HeldSet } from "../../privacy/held-set.ts";
import { AuthError, BadRequestError, ContextTooLongError, LLMError, ModelNotFoundError, MISALIGNMENT_POLICY_ERROR_CODE,
  OverloadedError, parseContextTooLong, RateLimitError, ServerError } from "./errors.ts";

export type ProviderFailureOptions = Readonly<{
  status?: number; modelOperation?: boolean; retryAfterMs?: number | undefined;
  /** The configured `runtime.responses.maximumErrorMessageCharacters`; every caller threads it. */
  maximumMessageCharacters: number;
  heldCredentials?: HeldSet;
  /** Safe complete-resource diagnostic; raw code/type remain classification authority. */
  diagnostic?: unknown;
}>;
export function classifyProviderFailure(raw: unknown, options: ProviderFailureOptions): LLMError {
  const error = isPlainObject(raw) && isPlainObject(raw.error) ? raw.error : raw;
  const code = isPlainObject(error) && typeof error.code === "string" ? error.code : undefined;
  const type = isPlainObject(error) && typeof error.type === "string" ? error.type : undefined;
  const message = isPlainObject(error) && typeof error.message === "string" ? error.message
    : typeof raw === "string" ? raw : "Provider response did not complete successfully";
  const diagnostic = options.diagnostic;
  const limit = options.maximumMessageCharacters;
  const values = !Object.hasOwn(options, "diagnostic") ? [message, code ?? "", type ?? ""]
    : [isPlainObject(diagnostic) && typeof diagnostic.message === "string" ? diagnostic.message : "Provider response did not complete successfully",
      isPlainObject(diagnostic) && typeof diagnostic.code === "string" ? diagnostic.code : "",
      isPlainObject(diagnostic) && typeof diagnostic.type === "string" ? diagnostic.type : ""];
  const held = options.heldCredentials ?? EMPTY_HELD_SET;
  const safe = Object.hasOwn(options, "diagnostic") ? values : redactMessagesTogether(values, DEFAULT_PRIVACY_POLICY, { heldCredentials: held }).redacted.map((text, index) =>
    held.values().includes(values[index]!) ? redactionReplacement("token", DEFAULT_PRIVACY_POLICY) : text);
  const detail = safe[0]!.slice(0, limit);
  const details = { ...(code === undefined ? {} : { providerCode: safe[1]!.slice(0, limit) }),
    ...(type === undefined ? {} : { providerType: safe[2]!.slice(0, limit) }) };
  const { status } = options;
  if (code === "misalignment_policy_violation") {
    return new LLMError(`Provider policy requires review: ${detail}`, MISALIGNMENT_POLICY_ERROR_CODE, "bad-request", false, details, status);
  }
  if (type === "insufficient_quota" || type === "insufficient_credits" || code !== undefined && ["insufficient_quota", "insufficient_credits", "credit_balance_exhausted", "billing_hard_limit_reached", "billing_not_active", "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "organization_usage_limit_exceeded"].includes(code)) {
    return new LLMError(`Provider quota is exhausted: ${detail}`, "llm_quota_exhausted", "rate-limit", false, details, status);
  }
  if (status === 429 || code === "rate_limit_exceeded") return new RateLimitError(`Provider rate limited the request: ${detail}`, options.retryAfterMs, details, status);
  if (status === 401 || status === 403) return new AuthError(`Provider authentication failed: ${detail}`, status, details);
  if (status === 404 && options.modelOperation) return new ModelNotFoundError(`Provider model or endpoint was not found: ${detail}`, details, status);
  if (code === "context_length_exceeded" || status === 400) {
    const context = parseContextTooLong(message);
    if (code === "context_length_exceeded" || context) return new ContextTooLongError("Provider context length exceeded", { ...details, ...context }, context?.promptTokens, context?.maxTokens, status);
  }
  if (status === 529) return new OverloadedError(`Provider is overloaded: ${detail}`, details, status);
  if (status !== undefined && status >= 500) return new ServerError(`Provider server request failed: ${detail}`, status, details);
  if (status !== undefined && status >= 400) return new BadRequestError(`Provider rejected the request: ${detail}`, details, status);
  return new LLMError(detail, "llm_response_failed", "server", false, details, status);
}
