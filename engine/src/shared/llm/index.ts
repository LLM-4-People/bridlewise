/**
 * Public API of the shared LLM module.
 *
 * One OpenAI-compatible client (`SharedLLMClient`) plus the typed error
 * hierarchy, config, circuit breaker, queue, stats, and optional failover.
 * The legacy `src/runtime/provider-adapter.ts` is now a thin façade over
 * this module (same interface, better implementation).
 */

// Register the LLM module's exposure catalog (signals/actions/customization)
// at load time so any caller that imports the client also publishes the
// catalog to the shared registry.
import "./exposure.ts";

export { SharedLLMClient, extractResponseHeaders } from "./client.ts";
export type {
  ProviderRequestOptions, ResponseReceipt, ResponseEvidence, CreateResponse, StreamChunk, ToolCall,
  SharedLLMClientOptions, ProviderResponse, ResponseTransportMetadata, RetrieveResponseQuery, InputItemsQuery,
} from "./client.ts";

export {
  LLMError, MISALIGNMENT_POLICY_ERROR_CODE, RequestObserverError, REQUEST_OBSERVER_ERROR_CODE, ResponseObserverError, RESPONSE_OBSERVER_ERROR_CODE, RateLimitError, ServerError, OverloadedError, NetworkError,
  AuthError, BadRequestError, ModelNotFoundError, ContextTooLongError,
  TruncationError, InvalidResponseError, TimeoutError, EmptyResponseError,
  StreamingError, isLLMError, isRetryable, parseContextTooLong,
  ALL_ERROR_TYPES,
} from "./errors.ts";
export type { ErrorType, SafeDetails } from "./errors.ts";

export {
  resolveLLMConfig, validateLLMConfig, redactAuth,
  DEFAULT_MAX_RETRIES, DEFAULT_BACKOFF,
  DEFAULT_CONCURRENCY, DEFAULT_CIRCUIT_BREAKER, DEFAULT_FAILOVER,
  DEFAULT_FAILOVER_TRIGGER, resolveQueueConfig,
  DEFAULT_ADAPTIVE, QUEUE_STRATEGIES,
} from "./config.ts";
export type {
  LLMConfig, ResolvedLLMConfig, LLMLogger, LLMLogEvent, LLMLogLevel,
  ChatRole, ChatMessage, ChatCompletionRequest, TokenUsage,
  ToolDefinition, ModelConfig, ProviderEntry, FailoverConfig, FailoverStrategy,
  QueueConfig, QueueStrategy, ConcurrencyConfig, AdaptiveConfig,
  ResolveResult,
} from "./config.ts";

export { CircuitBreaker } from "./circuit-breaker.ts";
export type { CircuitState, CircuitSnapshot } from "./circuit-breaker.ts";

export {
  RequestQueue, QueueOverflowError, QueueTimeoutError,
} from "./queue.ts";
export type { QueueRequest, QueueSnapshot } from "./queue.ts";

export { LLMStatsCollector } from "./stats.ts";
export type { LLMStats } from "./stats.ts";

export { FailoverSelector } from "./failover.ts";
export type { FailoverTarget } from "./failover.ts";

export { AdaptiveController } from "./adaptive.ts";
export type { AdaptiveSample, AdaptiveDecision, AdaptiveSnapshot } from "./adaptive.ts";

export { LLM_EXPOSURE_COUNTS, registerLLMExposure, setActiveLLMClientForExposure } from "./exposure.ts";

export * from "./responses.ts";
export * from "./response-transcript.ts";
export * from "./responses-stream.ts";
export * from "./responses-disposition.ts";
export * from "./responses-endpoints.ts";
export { classifyProviderFailure, type ProviderFailureOptions } from "./provider-failure.ts";
