/**
 * Central LLM configuration — one canonical owner of every knob: defaults,
 * types, ranges, and validation. The client, queue, circuit breaker, stats,
 * failover, and backoff all consume this; no module reads literals or env
 * vars directly. All values are dynamically computed from an `LLMConfig`.
 *
 * Adds (over EXP415): per-model overrides, per-provider overrides, and an
 * OPTIONAL per-model/per-provider failover config. Per the user directive:
 * "per model and per provider failover is a good feature we could make and
 * make it optional" — `failover.enabled` defaults to `false`.
 */

import { z } from "zod";
import { deepFreeze } from "../../kernel/integrity.ts";
import { snapshotJsonValue } from "../../kernel/safe-structural.ts";
import { RESPONSES_DEFAULTS_SCHEMA, type ResponsesDefaults } from "./responses.ts";
import { ALL_ERROR_TYPES, type ErrorType } from "./errors.ts";
import { ROOT_POLICY } from "../../kernel/root-policy.ts";
import { isProviderBaseUrl, isResponsesPath } from "./provider-endpoint.ts";

/** Native transport defaults: the one place their values live. `runtime.responses` in the config document overrides each field. */
const RESPONSES_TRANSPORT_DEFAULTS = Object.freeze({
  maximumRequestBytes: 16_777_216,
  maximumResponseHeaderBytes: 65_536,
  maximumResponseBytes: 16_777_216,
  maximumDepth: 48,
  maximumNodes: 50_000,
  operationTimeoutMs: 600_000,
  maximumTrackedResponses: 4096,
  maximumErrorMessageCharacters: 1024,
  cleanupTimeoutMs: 1000,
  maximumResumeAttempts: 2,
  capturedResponseHeaders: Object.freeze([
    "x-request-id", "date", "x-ratelimit-limit-requests", "x-ratelimit-remaining-requests",
    "x-ratelimit-reset-requests", "x-ratelimit-limit-tokens", "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-tokens", "x-model-id", "x-deployment-id", "x-organization",
  ]),
});

/** One declaration for native transport limits, projected into runtime.responses. */
export const RESPONSES_TRANSPORT_SCHEMA = z.strictObject({
  maximumRequestBytes: z.number().int().positive().max(ROOT_POLICY.runtime.limits.maximumToolMemoryBytes).default(RESPONSES_TRANSPORT_DEFAULTS.maximumRequestBytes),
  /** Each HTTP body is bounded separately from all captured header JSON. */
  maximumResponseHeaderBytes: z.number().int().positive().max(ROOT_POLICY.runtime.limits.maximumToolMemoryBytes).default(RESPONSES_TRANSPORT_DEFAULTS.maximumResponseHeaderBytes),
  maximumResponseBytes: z.number().int().positive().max(ROOT_POLICY.runtime.limits.maximumToolMemoryBytes).default(RESPONSES_TRANSPORT_DEFAULTS.maximumResponseBytes),
  maximumDepth: z.number().int().positive().max(ROOT_POLICY.forensics.limits.maximumDepth).default(RESPONSES_TRANSPORT_DEFAULTS.maximumDepth),
  maximumNodes: z.number().int().positive().max(ROOT_POLICY.forensics.limits.maximumNodes).default(RESPONSES_TRANSPORT_DEFAULTS.maximumNodes),
  operationTimeoutMs: z.number().int().positive().max(ROOT_POLICY.runtime.limits.maximumTimeoutMs).default(RESPONSES_TRANSPORT_DEFAULTS.operationTimeoutMs),
  maximumTrackedResponses: z.number().int().positive().max(ROOT_POLICY.forensics.limits.maximumNodes).default(RESPONSES_TRANSPORT_DEFAULTS.maximumTrackedResponses),
  maximumErrorMessageCharacters: z.number().int().positive().max(ROOT_POLICY.contracts.limits.maximumTextCharacters).default(RESPONSES_TRANSPORT_DEFAULTS.maximumErrorMessageCharacters),
  cleanupTimeoutMs: z.number().int().positive().max(ROOT_POLICY.runtime.limits.maximumTimeoutMs).default(RESPONSES_TRANSPORT_DEFAULTS.cleanupTimeoutMs),
  maximumResumeAttempts: z.number().int().nonnegative().max(ROOT_POLICY.runtime.limits.maximumRetries).default(RESPONSES_TRANSPORT_DEFAULTS.maximumResumeAttempts),
  capturedResponseHeaders: z.array(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u))
    .default(() => [...RESPONSES_TRANSPORT_DEFAULTS.capturedResponseHeaders]),
});
export type ResponsesTransportConfigInput = Readonly<Omit<z.input<typeof RESPONSES_TRANSPORT_SCHEMA>, "capturedResponseHeaders">> & Readonly<{ capturedResponseHeaders?: readonly string[] }>;
export type ResponsesTransportConfig = Readonly<z.output<typeof RESPONSES_TRANSPORT_SCHEMA>>;
/**
 * The configured `runtime.responses` transport, resolved. The input is
 * REQUIRED (a2-design M5): a caller hands over the configured section, so no
 * call site falls back to code defaults behind the configured document; `{}`
 * spells "the declared defaults" where there is no document (a test fixture).
 */
export function resolveResponsesTransportConfig(input: ResponsesTransportConfigInput): ResponsesTransportConfig {
  return deepFreeze(RESPONSES_TRANSPORT_SCHEMA.parse(input));
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ChatMessage = Readonly<{
  role: ChatRole;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: readonly unknown[];
  responseItems?: readonly import("./responses.ts").ResponseItem[];
  /** Evidence is retained, but an unresolved/failed native turn requires explicit recovery before replay. */
  responseReplayBlocked?: boolean;
}>;

export type ToolDefinition = Readonly<{
  type: "function";
  function: Readonly<{
    name: string;
    description: string;
    parameters: Readonly<Record<string, unknown>>;
    allowed_callers?: readonly ("direct" | "programmatic")[];
  }>;
}>;

export type ChatCompletionRequest = Readonly<{
  model: string;
  messages: readonly ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  tools?: readonly ToolDefinition[];
  tool_choice?: "auto" | "none" | "required";
  signal?: AbortSignal;
}>;

export type TokenUsage = Readonly<{
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}>;

/** Per-model config: overrides the provider defaults for one model id. */
export type ModelConfig = Readonly<{
  /** Absent means the base provider; model overrides never leak to another provider. */
  providerId?: string;
  /** Model id this entry applies to (e.g. `gemma-4-31b`). */
  model: string;
  requestDefaults?: ResponsesDefaults;
  timeout?: number;
  retries?: Partial<Record<ErrorType, number>>;
  /** Override the provider's concurrency for this model alone. */
  concurrency?: number;
}>;

/** Per-provider config: one OpenAI-compatible endpoint. */
export type ProviderEntry = Readonly<{
  /** Stable provider id (e.g. `neuralwatt`, `openai`). */
  id: string;
  baseUrl: string;
  apiKey: string;
  timeout?: number;
  retries?: Partial<Record<ErrorType, number>>;
  concurrency?: number;
  headers?: Readonly<Record<string, string>>;
  responsesPath?: string;
  requestDefaults?: ResponsesDefaults;
}>;

export type FailoverStrategy = "round-robin" | "priority" | "least-latency";

export type FailoverConfig = Readonly<{
  enabled: boolean;
  models: readonly string[];
  providers: readonly string[];
  strategy: FailoverStrategy;
  /** Fall back on these error types only (default: rate-limit, server, network, overloaded, streaming). */
  triggerOnError?: readonly ErrorType[];
}>;

/**
 * Queue strategy — how the request queue selects the next pending request
 * when a concurrency slot frees up.
 *
 * - `fifo`: first-in-first-out (default; fair, starvation-free).
 * - `lifo`: last-in-first-out (stack; favors recent, low-latency work).
 * - `priority`: highest priority first; ties broken by arrival order.
 * Requires `priorityLevels: true` so requests carry a priority.
 * - `round-robin`: rotate across providers so one busy provider does not
 * starve others. Tracks the last provider served.
 */
export type QueueStrategy = typeof QUEUE_STRATEGIES[number];

/**
 * Queue configuration — bounds the request backlog. Every knob is
 * configurable (the user directive: "support queue and concurrency
 * configuration like everything else in the harness").
 */
export type QueueConfig = Readonly<{
  /** Max concurrent in-flight requests (default 5; overrides top-level `concurrency`). */
  maxConcurrency?: number;
  /** Max requests waiting in the queue; excess are rejected (default 100). */
  maxQueueSize?: number;
  /** How long a request may wait in the queue before timing out (default 30000 ms). */
  queueTimeoutMs?: number;
  /** Enable priority queuing so callers may pass a `priority` (default false). */
  priorityLevels?: boolean;
  /** Selection policy for the next pending request (default "fifo"). */
  queueStrategy?: QueueStrategy;
}>;

/**
 * Concurrency configuration — independent caps per model, per provider, and a
 * global ceiling. A request occupies one slot in each applicable semaphore
 * (global + its model + its provider) for its whole in-flight duration. The
 * effective per-request cap is the MINIMUM of the three that apply.
 */
export type ConcurrencyConfig = Readonly<{
  /** Per-model max concurrent, e.g. `{ "gemma-4-31b": 5, "qwen3.6-35b-fast": 3 }`. */
  perModel?: Readonly<Record<string, number>>;
  /** Per-provider max concurrent, e.g. `{ neuralwatt: 5, openai: 10 }`. */
  perProvider?: Readonly<Record<string, number>>;
  /** Global max concurrent across every model + provider. */
  global?: number;
}>;

/**
 * Adaptive concurrency — AIMD (Additive Increase, Multiplicative Decrease),
 * the same congestion-control rule TCP uses. When the API is fast and error
 * free the client cautiously opens more slots; on 429s / high latency it
 * multiplicative-decreases. Off by default so behavior is deterministic unless
 * a caller opts in.
 */
export type AdaptiveConfig = Readonly<{
  enabled?: boolean;
  /** Floor the controller never goes below (default 1). */
  minConcurrency?: number;
  /** Ceiling the controller never exceeds (default 50). */
  maxConcurrency?: number;
  /** Additive increase step per calm window (default 1). */
  increaseStep?: number;
  /** Multiplicative decrease factor in (0, 1) (default 0.5). */
  decreaseFactor?: number;
  /** Error-rate fraction above which the controller decreases (default 0.5). */
  errorThreshold?: number;
  /** Sample window size before a decision is made (default 20). */
  sampleWindow?: number;
  /** Avg latency (ms) below which the controller increases (default 1000). */
  fastLatencyMs?: number;
  /** Avg latency (ms) above which the controller decreases (default 10000). */
  slowLatencyMs?: number;
  /** How much a rate-limit (429) error counts toward the error rate (default 1.0). */
  rateLimitWeight?: number;
}>;

export type LLMConfig = Readonly<{
  baseUrl: string;
  apiKey: string;
  /**
   * REQUIRED: may this client reach a loopback/private address? The
   * credential's destination rule (the outbound door's
   * `privateAddressesAllowedFor`): a non-admin's provider may not; an
   * operator's own configuration (the CLI, an evaluation) states true.
   */
  allowPrivateAddress: boolean;
  /** Optional routing scope; never fills an omitted native model field. */
  model?: string;
  providerId?: string;
  responses?: ResponsesTransportConfigInput;
  requestDefaults?: ResponsesDefaults;
  timeout?: number;
  maxRetries?: Partial<Record<ErrorType, number>>;
  concurrency?: number;
  circuitBreaker?: Readonly<{ threshold: number; resetMs: number }>;
  backoff?: Readonly<{ baseMs: number; factor: number; maxMs: number; jitter: number }>;
  logger?: LLMLogger;
  headers?: Readonly<Record<string, string>>;
  responsesPath?: string;
  /** Optional failover (off by default). */
  failover?: FailoverConfig;
  /** Optional per-model overrides. */
  models?: readonly ModelConfig[];
  /** Optional per-provider overrides (when using failover across providers). */
  providers?: readonly ProviderEntry[];
  /** Queue bounds + selection policy (EXP457). */
  queue?: QueueConfig;
  /** Per-model / per-provider / global concurrency caps (EXP457). */
  concurrencyPolicy?: ConcurrencyConfig;
  /** AIMD adaptive concurrency (off by default; EXP457). */
  adaptive?: AdaptiveConfig;
}>;

export type LLMLogLevel = "debug" | "info" | "warn" | "error";

export type LLMLogEvent = Readonly<{
  level: LLMLogLevel;
  event: string;
  requestMs: number;
  model: string | undefined;
  provider?: string;
  status?: number | undefined;
  errorType?: string | undefined;
  errorCode?: string | undefined;
  attempt?: number | undefined;
  retries?: number | undefined;
  truncated?: boolean | undefined;
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
  totalTokens?: number | undefined;
  failover?: boolean | undefined;
  redactedAuth: string;
}>;

export interface LLMLogger {
  log(event: LLMLogEvent): void | Promise<void>;
}

export const DEFAULT_MAX_RETRIES: Readonly<Record<ErrorType, number>> = Object.freeze({
  "rate-limit": 5,
  server: 3,
  network: 3,
  overloaded: 3,
  "invalid-response": 1,
  "empty-response": 1,
  streaming: 1,
  auth: 0,
  "bad-request": 0,
  "model-not-found": 0,
  "context-too-long": 0,
  truncation: 0,
  timeout: 0,
});

export const DEFAULT_BACKOFF: Readonly<{ baseMs: number; factor: number; maxMs: number; jitter: number }> = Object.freeze({
  baseMs: 1000,
  factor: 2,
  maxMs: 60_000,
  jitter: 0.25,
});

/** Module-private: `resolveLLMConfig` resolves it into `timeoutMs`. */
const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_CONCURRENCY = 5;
export const DEFAULT_CIRCUIT_BREAKER: Readonly<{ threshold: number; resetMs: number }> = Object.freeze({
  threshold: 10,
  resetMs: 30_000,
});

/**
 * Which failures are worth trying another provider for.
 *
 * DELIBERATE SUBSET: 5 of 13 error types, and it must stay a
 * choice — the other eight (`auth`, `bad-request`, `model-not-found`,
 * `context-too-long`, …) describe a request that will fail identically
 * everywhere, so failing over on them spends every provider's budget to
 * arrive at the same answer. A new error type must be judged against that
 * question before it joins this list, never swept in by being new.
 */
export const DEFAULT_FAILOVER_TRIGGER: readonly ErrorType[] = Object.freeze([
  "rate-limit", "server", "network", "overloaded", "streaming",
]);

export const DEFAULT_FAILOVER: Readonly<FailoverConfig> = Object.freeze({
  enabled: false,
  models: [],
  providers: [],
  strategy: "round-robin",
  triggerOnError: DEFAULT_FAILOVER_TRIGGER,
});

/** The strategy vocabulary, and the owner of the `QueueStrategy` union it is
 * derived into — one declaration, so a fifth strategy cannot exist as a type
 * without existing in the list every consumer validates against. */
export const QUEUE_STRATEGIES = Object.freeze(["fifo", "lifo", "priority", "round-robin"] as const);

/**
 * The queue defaults — module-private, because `resolveQueueConfig` below is
 * the resolver and therefore the single correct reader. A default whose owner
 * also owns the resolver has no other honest consumer: anyone reading it
 * directly holds a value that stops tracking configuration the moment a
 * caller supplies any.
 */
const DEFAULT_QUEUE: Readonly<Required<QueueConfig>> = Object.freeze({
  maxConcurrency: DEFAULT_CONCURRENCY,
  maxQueueSize: 100,
  queueTimeoutMs: 30_000,
  priorityLevels: false,
  queueStrategy: "fifo",
});

/** Module-private for the same reason: `resolveLLMConfig` resolves it into
 * `concurrencyPolicy`, and that field is the answer. */
const DEFAULT_CONCURRENCY_POLICY: Readonly<ConcurrencyConfig> = Object.freeze({});

export const DEFAULT_ADAPTIVE: Readonly<Required<AdaptiveConfig>> = Object.freeze({
  enabled: false,
  minConcurrency: 1,
  maxConcurrency: 50,
  increaseStep: 1,
  decreaseFactor: 0.5,
  errorThreshold: 0.5,
  sampleWindow: 20,
  fastLatencyMs: 1000,
  slowLatencyMs: 10_000,
  rateLimitWeight: 1,
});

export type ResolvedLLMConfig = Readonly<{
  baseUrl: string;
  apiKey: string;
  allowPrivateAddress: boolean;
  model: string | undefined;
  providerId: string;
  responses: ResponsesTransportConfig;
  requestDefaults: ResponsesDefaults;
  timeoutMs: number;
  maxRetries: Readonly<Record<ErrorType, number>>;
  concurrency: number;
  circuitBreaker: Readonly<{ threshold: number; resetMs: number }>;
  backoff: Readonly<{ baseMs: number; factor: number; maxMs: number; jitter: number }>;
  logger: LLMLogger | undefined;
  headers: Readonly<Record<string, string>>;
  responsesPath: string;
  failover: Readonly<FailoverConfig>;
  models: readonly ModelConfig[];
  providers: readonly ProviderEntry[];
  queue: Readonly<Required<QueueConfig>>;
  concurrencyPolicy: Readonly<ConcurrencyConfig>;
  adaptive: Readonly<Required<AdaptiveConfig>>;
}>;

export type ResolveResult = Readonly<{ config: ResolvedLLMConfig | null; error: string | null }>;

/**
 * THE QUEUE CONFIG, FULLY FILLED IN — one owner for the fill-in step.
 *
 * `RequestQueue` used to repeat this with its own literals (`?? 5`, `?? 100`,
 * `?? false`, `?? "fifo"`), so a queue built directly and a queue built
 * through `resolveLLMConfig` were answering the same question from two
 * different sets of numbers, and only one of them tracked the declared
 * defaults. Two mechanisms answering one question is the shape that drifts;
 * this is the one mechanism.
 *
 * Callers that want the plain defaults pass `{}` — that is how the exposure
 * catalog reports what a setting defaults to, without reading the default
 * constant it would then have to keep in step by hand.
 */
export function resolveQueueConfig(
  queue: Readonly<QueueConfig> = {},
): Readonly<Required<QueueConfig>> {
  return Object.freeze({
    maxConcurrency: queue.maxConcurrency ?? DEFAULT_QUEUE.maxConcurrency,
    maxQueueSize: queue.maxQueueSize ?? DEFAULT_QUEUE.maxQueueSize,
    queueTimeoutMs: queue.queueTimeoutMs ?? DEFAULT_QUEUE.queueTimeoutMs,
    priorityLevels: queue.priorityLevels ?? DEFAULT_QUEUE.priorityLevels,
    queueStrategy: queue.queueStrategy ?? DEFAULT_QUEUE.queueStrategy,
  });
}

export function resolveLLMConfig(config: LLMConfig): ResolveResult {
  const error = validateLLMConfig(config);
  if (error !== null) return { config: null, error };
  const maxRetries: Record<ErrorType, number> = { ...DEFAULT_MAX_RETRIES };
  if (config.maxRetries) {
    for (const key of Object.keys(config.maxRetries) as ErrorType[]) {
      const v = config.maxRetries[key];
      if (v !== undefined) maxRetries[key] = v;
    }
  }
  const failover: FailoverConfig = {
    ...DEFAULT_FAILOVER,
    ...(config.failover ?? {}),
    ...(config.failover?.triggerOnError !== undefined ? { triggerOnError: config.failover.triggerOnError } : {}),
  };
  // Queue: top-level `concurrency` is the historical default; the richer
  // `queue.maxConcurrency` overrides it when present. Both flow through the
  // same resolved `concurrency` so existing single-knob callers keep working.
  const queue: Required<QueueConfig> = resolveQueueConfig({
    ...(config.queue ?? {}),
    // The historical single knob. `queue.maxConcurrency` wins when both are
    // present, which is what `??` already gave, expressed here so the whole
    // fill-in-the-defaults step has one owner.
    ...(config.queue?.maxConcurrency === undefined && config.concurrency !== undefined
      ? { maxConcurrency: config.concurrency }
      : {}),
  });
  const concurrencyPolicy: ConcurrencyConfig = {
    ...(config.concurrencyPolicy ?? DEFAULT_CONCURRENCY_POLICY),
    perModel: { ...Object.fromEntries((config.models ?? []).filter(m => m.concurrency !== undefined).map(m => [m.model, m.concurrency!])), ...config.concurrencyPolicy?.perModel },
    perProvider: { ...Object.fromEntries((config.providers ?? []).filter(p => p.concurrency !== undefined).map(p => [p.id, p.concurrency!])), ...config.concurrencyPolicy?.perProvider },
  };
  const adaptive: Required<AdaptiveConfig> = {
    ...DEFAULT_ADAPTIVE,
    ...(config.adaptive ?? {}),
  };
  const resolved: ResolvedLLMConfig = Object.freeze({
    baseUrl: trimTrailingSlash(config.baseUrl),
    apiKey: config.apiKey,
    allowPrivateAddress: config.allowPrivateAddress,
    model: config.model,
    providerId: config.providerId ?? "default",
    // An absent `runtime.responses` section IS its schema's declared defaults
    // (the one owner); every caller that holds the configured section passes it.
    responses: resolveResponsesTransportConfig(config.responses ?? {}),
    requestDefaults: snapshotResponseDefaults(config.requestDefaults),
    timeoutMs: config.timeout ?? DEFAULT_TIMEOUT_MS,
    maxRetries: Object.freeze(maxRetries),
    concurrency: queue.maxConcurrency,
    circuitBreaker: Object.freeze({ ...DEFAULT_CIRCUIT_BREAKER, ...(config.circuitBreaker ?? {}) }),
    backoff: Object.freeze({ ...DEFAULT_BACKOFF, ...(config.backoff ?? {}) }),
    logger: config.logger,
    headers: Object.freeze({ ...(config.headers ?? {}) }),
    responsesPath: config.responsesPath ?? "/responses",
    failover: deepFreeze({ ...failover, models: [...failover.models], providers: [...failover.providers], ...(failover.triggerOnError === undefined ? {} : { triggerOnError: [...failover.triggerOnError] }) }),
    models: deepFreeze((config.models ?? []).map(model => ({ ...model, requestDefaults: snapshotResponseDefaults(model.requestDefaults), ...(model.retries === undefined ? {} : { retries: { ...model.retries } }) }))),
    providers: deepFreeze((config.providers ?? []).map(provider => ({ ...provider, requestDefaults: snapshotResponseDefaults(provider.requestDefaults), ...(provider.headers === undefined ? {} : { headers: { ...provider.headers } }), ...(provider.retries === undefined ? {} : { retries: { ...provider.retries } }) }))),
    queue: Object.freeze(queue),
    concurrencyPolicy: deepFreeze(concurrencyPolicy),
    adaptive: Object.freeze(adaptive),
  });
  return { config: resolved, error: null };
}

export function validateLLMConfig(config: LLMConfig): string | null {
  if (typeof config.baseUrl !== "string" || config.baseUrl.length === 0) return "baseUrl must be a non-empty string";
  if (!isProviderBaseUrl(config.baseUrl)) return "baseUrl must be an HTTP(S) URL without user information, query or fragment";
  if (config.responsesPath !== undefined && !isResponsesPath(config.responsesPath)) return "responsesPath must be an absolute path without query or fragment";
  if (typeof config.apiKey !== "string" || config.apiKey.length === 0) return "apiKey must be a non-empty string";
  if (config.model !== undefined && (typeof config.model !== "string" || config.model.length === 0)) return "model must be a non-empty string";
  if (config.timeout !== undefined && (!Number.isFinite(config.timeout) || config.timeout < 1)) return "timeout must be >= 1 ms";
  if (config.concurrency !== undefined && (!Number.isInteger(config.concurrency) || config.concurrency < 1)) return "concurrency must be an integer >= 1";
  if (config.circuitBreaker !== undefined) {
    const cb = config.circuitBreaker;
    if (!Number.isInteger(cb.threshold) || cb.threshold < 1) return "circuitBreaker.threshold must be an integer >= 1";
    if (!Number.isFinite(cb.resetMs) || cb.resetMs < 1) return "circuitBreaker.resetMs must be >= 1";
  }
  if (config.backoff !== undefined) {
    const b = config.backoff;
    if (!Number.isFinite(b.baseMs) || b.baseMs < 1) return "backoff.baseMs must be >= 1";
    if (!Number.isFinite(b.factor) || b.factor < 1) return "backoff.factor must be >= 1";
    if (!Number.isFinite(b.maxMs) || b.maxMs < b.baseMs) return "backoff.maxMs must be >= baseMs";
    if (!Number.isFinite(b.jitter) || b.jitter < 0 || b.jitter > 1) return "backoff.jitter must be in [0, 1]";
  }
  if (config.responses !== undefined && !RESPONSES_TRANSPORT_SCHEMA.safeParse(config.responses).success) return "responses transport configuration is invalid";
  if (config.maxRetries !== undefined) {
    for (const key of Object.keys(config.maxRetries) as ErrorType[]) {
      if (!ALL_ERROR_TYPES.includes(key)) return `maxRetries contains an unknown error type`;
      const v = config.maxRetries[key];
      if (v !== undefined && (!Number.isInteger(v) || v < 0)) return `maxRetries.${key} must be a non-negative integer`;
    }
  }
  try {
    for (const defaults of [config.requestDefaults, ...(config.models ?? []).map(model => model.requestDefaults), ...(config.providers ?? []).map(provider => provider.requestDefaults)]) snapshotResponseDefaults(defaults);
  } catch { return "native request defaults are invalid"; }
  const providerIds = new Set<string>();
  for (const provider of config.providers ?? []) {
    if (!provider.id || providerIds.has(provider.id)) return "provider ids must be non-empty and unique";
    providerIds.add(provider.id);
    if (!isProviderBaseUrl(provider.baseUrl) || !provider.apiKey) return "provider endpoint and credential are required";
    if (provider.responsesPath !== undefined && !isResponsesPath(provider.responsesPath)) return "provider responsesPath must be an absolute path without query or fragment";
    if (provider.timeout !== undefined && (!Number.isFinite(provider.timeout) || provider.timeout < 1)) return "provider timeout must be positive";
    if (provider.concurrency !== undefined && (!Number.isSafeInteger(provider.concurrency) || provider.concurrency < 1)) return "provider concurrency must be positive";
  }
  for (const providerId of config.failover?.providers ?? []) {
    if (providerId !== (config.providerId ?? "default") && !providerIds.has(providerId)) return "failover provider must resolve to a configured endpoint";
  }
  if (config.failover !== undefined) {
    const f = config.failover;
    if (typeof f.enabled !== "boolean") return "failover.enabled must be a boolean";
    if (!Array.isArray(f.models)) return "failover.models must be an array";
    if (!Array.isArray(f.providers)) return "failover.providers must be an array";
    if (f.strategy !== "round-robin" && f.strategy !== "priority" && f.strategy !== "least-latency") {
      return "failover.strategy must be round-robin | priority | least-latency";
    }
  }
  if (config.queue !== undefined) {
    const q = config.queue;
    if (q.maxConcurrency !== undefined && (!Number.isInteger(q.maxConcurrency) || q.maxConcurrency < 1)) {
      return "queue.maxConcurrency must be an integer >= 1";
    }
    if (q.maxQueueSize !== undefined && (!Number.isInteger(q.maxQueueSize) || q.maxQueueSize < 0)) {
      return "queue.maxQueueSize must be an integer >= 0";
    }
    if (q.queueTimeoutMs !== undefined && (!Number.isFinite(q.queueTimeoutMs) || q.queueTimeoutMs < 0)) {
      return "queue.queueTimeoutMs must be >= 0";
    }
    if (q.priorityLevels !== undefined && typeof q.priorityLevels !== "boolean") {
      return "queue.priorityLevels must be a boolean";
    }
    if (q.queueStrategy !== undefined && !QUEUE_STRATEGIES.includes(q.queueStrategy)) {
      return `queue.queueStrategy must be one of ${QUEUE_STRATEGIES.join(", ")}`;
    }
  }
  if (config.concurrencyPolicy !== undefined) {
    const cp = config.concurrencyPolicy;
    if (cp.perModel !== undefined) {
      if (typeof cp.perModel !== "object" || cp.perModel === null) return "concurrencyPolicy.perModel must be an object";
      for (const [k, v] of Object.entries(cp.perModel)) {
        if (typeof k !== "string" || k.length === 0) return "concurrencyPolicy.perModel keys must be non-empty strings";
        if (!Number.isInteger(v) || v < 1) return "concurrencyPolicy.perModel values must be an integer >= 1";
      }
    }
    if (cp.perProvider !== undefined) {
      if (typeof cp.perProvider !== "object" || cp.perProvider === null) return "concurrencyPolicy.perProvider must be an object";
      for (const [k, v] of Object.entries(cp.perProvider)) {
        if (typeof k !== "string" || k.length === 0) return "concurrencyPolicy.perProvider keys must be non-empty strings";
        if (!Number.isInteger(v) || v < 1) return "concurrencyPolicy.perProvider values must be an integer >= 1";
      }
    }
    if (cp.global !== undefined && (!Number.isInteger(cp.global) || cp.global < 1)) {
      return "concurrencyPolicy.global must be an integer >= 1";
    }
  }
  if (config.adaptive !== undefined) {
    const a = config.adaptive;
    if (a.enabled !== undefined && typeof a.enabled !== "boolean") return "adaptive.enabled must be a boolean";
    if (a.minConcurrency !== undefined && (!Number.isInteger(a.minConcurrency) || a.minConcurrency < 1)) return "adaptive.minConcurrency must be an integer >= 1";
    if (a.maxConcurrency !== undefined && (!Number.isInteger(a.maxConcurrency) || a.maxConcurrency < 1)) return "adaptive.maxConcurrency must be an integer >= 1";
    if (a.minConcurrency !== undefined && a.maxConcurrency !== undefined && a.minConcurrency > a.maxConcurrency) {
      return "adaptive.minConcurrency must be <= adaptive.maxConcurrency";
    }
    if (a.increaseStep !== undefined && (!Number.isInteger(a.increaseStep) || a.increaseStep < 1)) return "adaptive.increaseStep must be an integer >= 1";
    if (a.decreaseFactor !== undefined && (!Number.isFinite(a.decreaseFactor) || a.decreaseFactor <= 0 || a.decreaseFactor >= 1)) {
      return "adaptive.decreaseFactor must be in (0, 1)";
    }
    if (a.errorThreshold !== undefined && (!Number.isFinite(a.errorThreshold) || a.errorThreshold < 0 || a.errorThreshold > 1)) {
      return "adaptive.errorThreshold must be in [0, 1]";
    }
    if (a.sampleWindow !== undefined && (!Number.isInteger(a.sampleWindow) || a.sampleWindow < 1)) return "adaptive.sampleWindow must be an integer >= 1";
    if (a.fastLatencyMs !== undefined && (!Number.isFinite(a.fastLatencyMs) || a.fastLatencyMs < 0)) return "adaptive.fastLatencyMs must be >= 0";
    if (a.slowLatencyMs !== undefined && (!Number.isFinite(a.slowLatencyMs) || a.slowLatencyMs < 0)) return "adaptive.slowLatencyMs must be >= 0";
    if (a.fastLatencyMs !== undefined && a.slowLatencyMs !== undefined && a.fastLatencyMs > a.slowLatencyMs) {
      return "adaptive.fastLatencyMs must be <= adaptive.slowLatencyMs";
    }
    if (a.rateLimitWeight !== undefined && (!Number.isFinite(a.rateLimitWeight) || a.rateLimitWeight < 0)) {
      return "adaptive.rateLimitWeight must be >= 0";
    }
  }
  return null;
}

export function redactAuth(apiKey: string): string {
  return apiKey.length > 0 ? "Bearer [REDACTED]" : "[ABSENT]";
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** Immutable configured JSON; the same native schema owns every defaults layer. */
function snapshotResponseDefaults(value: ResponsesDefaults | undefined): ResponsesDefaults {
  const { maximumDepth, maximumNodes } = ROOT_POLICY.forensics.limits;
  return deepFreeze(RESPONSES_DEFAULTS_SCHEMA.parse(snapshotJsonValue(value ?? {}, { maximumDepth, maximumNodes }, "responses_defaults_invalid")));
}
