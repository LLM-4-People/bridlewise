import { combineSignals } from "../shared/abort-signals.ts";
import { messagesToResponseInput } from "../shared/llm/response-transcript.ts";
/** Request-shape adapter over the native Responses client. Native LLMError identity is preserved. */

import { canonicalHash, deepFreeze } from "../kernel/integrity.ts";
import { OPERATOR_OWNER, privateAddressesAllowedFor } from "../shared/outbound-policy.ts";
import type { MetricsCollector, MetricScopeKey } from "../performance/metrics-collector.ts";
import {
  SharedLLMClient,
  LLMError,
  type ChatMessage as V2ChatMessage,
  type ChatCompletionRequest as V2ChatCompletionRequest,
  type ProviderRequestOptions,
  type StreamChunk,
  type ToolDefinition as V2ToolDefinition,
  type LLMConfig,
} from "../shared/llm/index.ts";
import type { SseLimits } from "./sse-parser.ts";
import { PROVIDER_CONCURRENCY } from "./runtime-config.ts";
import { toolsToResponses, type ResponseResource, type ResponseStatus, type ResponseToolCall } from "../shared/llm/responses.ts";
import { ResponseTurn } from "./response-turn.ts";
import type { ResponsesTransportConfigInput } from "../shared/llm/config.ts";

// ── Public types (re-exported, one source of truth in../shared/llm) ──────

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ChatMessage = V2ChatMessage;

export type ToolCall = ResponseToolCall;

export type ToolDefinition = V2ToolDefinition;

export type ChatCompletionRequest = V2ChatCompletionRequest;

export type TokenUsage = Readonly<{
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}>;

export type ChatStreamEvent = Exclude<StreamChunk, Readonly<{ type: "finish"; reason: string; truncated: boolean }>>
  | Readonly<{ type: "finish"; reason: string }>;

export type ProviderConfig = Readonly<{
  id: string;
  baseUrl: string;
  timeoutMs: number;
  retries: Readonly<{
    maxRetries: number;
    initialBackoffMs: number;
    maxBackoffMs: number;
    backoffMultiplier: number;
    retryableStatusCodes?: readonly number[];
  }>;
  responsesPath?: string;
  responses?: ResponsesTransportConfigInput | undefined;
}>;

export type ProviderAdapterOptions = Readonly<{
  provider: ProviderConfig;
  apiKey: string;
  signal?: AbortSignal;
  metricsCollector?: MetricsCollector;
  sseLimits?: SseLimits;
}>;

export type ChatCompletionResult = Readonly<{
  content: string;
  toolCalls: readonly ToolCall[];
  usage: TokenUsage | undefined;
  finishReason: string;
  response?: ResponseResource;
  observation?: import("../privacy/responses-observation.ts").ResponseObservationEnvelope;
  status?: ResponseStatus;
  refusal?: string;
  headers?: Readonly<Record<string, string>>;
  model?: string;
}>;

/** Invocation controls are private and excluded from request serialization and hashes. */
export type ProviderInvocationOptions = Pick<ProviderRequestOptions, "onResponseReceipt" | "onResponseEvidence">;

export type ProviderAdapter = Readonly<{
  providerId: string;
  streamChatCompletion(request: ChatCompletionRequest, invocation?: ProviderInvocationOptions): AsyncGenerator<ChatStreamEvent, void, unknown>;
  chatCompletion(request: ChatCompletionRequest, invocation?: ProviderInvocationOptions): Promise<ChatCompletionResult>;
}>;

// ── v2 config construction from the legacy ProviderConfig ────────────────

function buildLLMConfig(options: ProviderAdapterOptions): LLMConfig {
  const p = options.provider;
  const max = p.retries.maxRetries;
  // The legacy adapter uses a SINGLE `maxRetries` for every retryable error.
  // Map it uniformly across the v2's per-error-type budgets so retry counts
  // match (e.g. 429 with maxRetries:3 → 4 attempts, same as before). The
  // legacy treated malformed/empty/streaming responses as NON-retryable
  // (`provider_malformed_response`), so those budgets are pinned to 0 here
  // even though the v2 client defaults them to 1 — direct v2 callers still
  // get the retryable default; only the legacy façade preserves the
  // non-retryable contract.
  const maxRetries = {
    "rate-limit": max, server: max, network: max, overloaded: max,
    "invalid-response": 0, "empty-response": 0, streaming: 0,
    auth: 0, "bad-request": 0, "model-not-found": 0, "context-too-long": 0,
    truncation: 0, timeout: 0,
  } as const;
  return {
    baseUrl: p.baseUrl,
    // The OPERATOR's own configured provider (the CLI, an evaluation run —
    // never a web user's saved one): a local model server is theirs to reach.
    allowPrivateAddress: privateAddressesAllowedFor(OPERATOR_OWNER),
    providerId: p.id,
    ...(p.responses === undefined ? {} : { responses: p.responses }),
    apiKey: options.apiKey,
    timeout: p.timeoutMs,
    maxRetries,
    // Preserve the legacy "effectively unbounded" behavior — the legacy
    // adapter had no concurrency limit. A high cap keeps the queue from
    // ever blocking legacy callers while still bounding runaway parallelism.
    concurrency: PROVIDER_CONCURRENCY,
    backoff: {
      baseMs: p.retries.initialBackoffMs,
      factor: p.retries.backoffMultiplier,
      maxMs: p.retries.maxBackoffMs,
      // Legacy jitter is `capped * 0.1 * random` (additive). The v2 uses
      // multiplicative jitter; jitter: 0 keeps the legacy deterministic
      // backoff sequence [500, 1000, 2000, 4000, 8000] exact under Math.random=0.
      jitter: 0,
    },
    ...(p.responsesPath !== undefined ? { responsesPath: p.responsesPath } : {}),
    // The v2 client must NOT silently swallow errors; wire a no-op logger by
    // default (callers can pass their own via the v2 directly).
  };
}

// ── createProviderAdapter ─────────────────────────────────────────────────

export function createProviderAdapter(options: ProviderAdapterOptions): ProviderAdapter {
  if (!options.apiKey || options.apiKey.length === 0) {
    throw new LLMError(
      "Provider API key is missing",
      "llm_config_invalid", "bad-request", false,
    );
  }
  // The key is held by the client for every call it makes (its held list),
  // never registered process-wide: it is its user's, not the harness's.
  const llmConfig = buildLLMConfig(options);
  const clientOptions: LLMConfig & Readonly<{ sseLimits?: SseLimits }> = {
    ...llmConfig,
    ...(options.sseLimits !== undefined ? { sseLimits: options.sseLimits } : {}),
  };
  const client = new SharedLLMClient(clientOptions);

  const metricsSink = buildMetricsSink(options);
  const providerId = options.provider.id;

  return deepFreeze({
    providerId,
    streamChatCompletion(request: ChatCompletionRequest, invocation?: ProviderInvocationOptions): AsyncGenerator<ChatStreamEvent, void, unknown> {
      return streamChat(client, request, options.signal, metricsSink, invocation);
    },
    async chatCompletion(request: ChatCompletionRequest, invocation?: ProviderInvocationOptions): Promise<ChatCompletionResult> {
      return collectStream(streamChat(client, request, options.signal, metricsSink, invocation));
    },
  });
}

// ── streaming + collection (v2 StreamChunk → legacy ChatStreamEvent) ─────

function asyncStream(
  client: SharedLLMClient,
  request: ChatCompletionRequest,
  signal: AbortSignal | undefined,
  metricsSink: ProviderRequestOptions["metricsSink"],
  invocation?: ProviderInvocationOptions,
): AsyncGenerator<StreamChunk, void, unknown> {
  const effectiveSignal = combineSignals(request.signal, signal);
  return client.stream({
    model: request.model, input: messagesToResponseInput(request.messages), store: false,
    ...(request.max_tokens === undefined ? {} : { max_output_tokens: request.max_tokens }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.tools === undefined ? {} : { tools: toolsToResponses(request.tools) }),
    ...(request.tool_choice === undefined ? {} : { tool_choice: request.tool_choice }),
  }, { ...invocation, ...(effectiveSignal ? { signal: effectiveSignal } : {}),
    ...(metricsSink === undefined ? {} : { metricsSink }) });
}

async function* streamChat(
  client: SharedLLMClient,
  request: ChatCompletionRequest,
  signal: AbortSignal | undefined,
  metricsSink: ProviderRequestOptions["metricsSink"],
  invocation?: ProviderInvocationOptions,
): AsyncGenerator<ChatStreamEvent, void, unknown> {
  yield* asyncStream(client, request, signal, metricsSink, invocation);
}

async function collectStream(
  stream: AsyncGenerator<ChatStreamEvent, void, unknown>,
): Promise<ChatCompletionResult> {
  const turn = new ResponseTurn();
  for await (const event of stream) await turn.accept(event);
  return turn.complete();
}

// ── metrics sink (decouples the v2 client from the performance module) ────

function buildMetricsSink(
  options: ProviderAdapterOptions,
): ProviderRequestOptions["metricsSink"] {
  const collector = options.metricsCollector;
  if (collector === undefined) return undefined;
  const key: MetricScopeKey = { module: "provider-adapter", function: "streamChatCompletion", scope: options.provider.id };
  return (event) => {
    const correlation = { providerId: options.provider.id, ...(event.model === undefined ? {} : { modelId: event.model }) };
    collector.recordCall(key, correlation, event.durationMs, event.status === "succeeded" ? "succeeded" : "failed", "shared");
  };
}

// ── helpers re-exported (preserved from the legacy adapter) ───────────────

export function resolveApiKey(apiKeyEnvVar: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = env[apiKeyEnvVar];
  if (key === undefined || key.length === 0) {
    throw new LLMError(
      "Provider API key is missing",
      "llm_config_invalid", "bad-request", false,
    );
  }
  return key;
}

export function buildProviderConfig(config: ProviderConfig): ProviderConfig {
  return deepFreeze({ ...config });
}

export function computeRequestHash(request: ChatCompletionRequest): string {
  return canonicalHash(request);
}
