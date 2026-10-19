/** Native Responses client: one admission/retry/logging owner for all HTTP operations. */
import { EMPTY_HELD_SET, type HeldSet } from "../../privacy/held-set.ts";
import { DEFAULT_PRIVACY_POLICY, redactionReplacement } from "../../privacy/privacy-policy.ts";
import { observeResponseEnvelope, type ResponseObservationEnvelope } from "../../privacy/responses-observation.ts";
import { InputError } from "../../kernel/errors.ts";
import { deepFreeze } from "../../kernel/integrity.ts";
import { CONTENT_TYPE_JSON } from "../../kernel/contracts.ts";
import { parseSseStream, type SseLimits } from "../../runtime/sse-parser.ts";
import { admitMintedRequest, observeMintedRequest, mintedRequestContext, mintedRequestRedactions, snapshotRequestContext, type MintedRequestContext } from "../../privacy/redacted-messages.ts";
import { captureResponseSource, captureResponsePrivacy, prepareResponseRequest, responseRequiresOrigin, type ResponsePrivacyOptions } from "./responses-preparation.ts";
import { RESPONSE_QUERY_SCHEMAS, type ResponseQueryFor, type ResponseOperation, type ResponseRequestFor } from "./responses-endpoints.ts";
import { bestEffortAsync } from "../best-effort.ts";
import { guarded } from "../../process/fault-policy.ts";
import { awaitWithSignal, deadline } from "../abort-signals.ts";
import { backoffDelayMs } from "../backoff.ts";
import { debugLog, handleError } from "../debug/debug-system.ts";
import { currentRecordingContext } from "../../timeline/recording-context.ts";
import { resolveLLMConfig, redactAuth, type LLMConfig, type LLMLogEvent, type ResolvedLLMConfig, type ResponsesTransportConfig } from "./config.ts";
import { LLMError, RequestObserverError, ResponseObserverError, InvalidResponseError, isLLMError, RateLimitError, TimeoutError, TruncationError, type ErrorType } from "./errors.ts";
import { classifyProviderFailure } from "./provider-failure.ts";
import { CircuitBreaker } from "./circuit-breaker.ts";
import { RequestQueue, type QueueRequest } from "./queue.ts";
import { LLMStatsCollector } from "./stats.ts";
import { FailoverSelector, safeProviderTarget, targetIdentity, type FailoverTarget, type SafeProviderTarget } from "./failover.ts";
import { AdaptiveController } from "./adaptive.ts";
import { setActiveLLMClientForExposure, registerLLMExposure } from "./exposure.ts";
import { parseResponseResource, projectResponse, projectResponseUsage, type ResponseProjection, type ResponseResource, type ResponseStatus, type ProjectedUsage, type ResponseToolCall } from "./responses.ts";
import { ResponseStreamState, type ResponseStreamChunk, type ResponseStreamOptions } from "./responses-stream.ts";
import { ResponsesTracker } from "./responses-tracking.ts";
import { assertProviderIdentity, providerHeldSet, observeProviderLabel, observeProviderDiagnostic } from "./provider-observation.ts";
import { isProviderBaseUrl } from "./provider-endpoint.ts";
import { parseResponseEndpointResource, type ResponseCompaction, type ResponseDeletion, type ResponseInputItemPage, type ResponseInputTokenCount } from "./responses-endpoints.ts";
import { requestProviderHttp, captureResponseHeaders, parseProviderJson, sleep, checkAborted, PROVIDER_LOG_CATEGORY, type ProviderHttpRequest } from "./provider-http.ts";
import { CONTENT_TYPE_SSE, decodeReadableStream, readBody } from "../outbound-http.ts";
export type { ChatMessage, ChatCompletionRequest, TokenUsage, ToolDefinition, LLMConfig, LLMLogger, LLMLogEvent, ResolvedLLMConfig } from "./config.ts";
export type { ErrorType, LLMError } from "./errors.ts";
export type { CircuitSnapshot, CircuitState } from "./circuit-breaker.ts";
export type { LLMStats } from "./stats.ts";
export type { FailoverTarget, FailoverConfig, FailoverStrategy, ModelConfig, ProviderEntry } from "./failover.ts";
export { ALL_ERROR_TYPES } from "./errors.ts";
export type ToolCall = ResponseToolCall;
/** Private accepted-operation handle. Never place this in public events or request data.
 * Receipt does not establish generation/billing ownership. External lifecycle reads
 * carry a permanently inert retirement handle; requestedModel is their resolved
 * routing scope, not evidence of the original generation model.
 */
export type ResponseReceipt = Readonly<{ responseId: string; providerId: string; requestedModel: string | undefined; retire(): boolean }>;
export type ProviderRequestOptions = Readonly<{
  privacy?: ResponsePrivacyOptions;
  provider?: string; signal?: AbortSignal; priority?: number; truncateAsError?: boolean;
  state?: ResponseStreamState;
  onResponseEvidence?: (evidence: ResponseEvidence, signal: AbortSignal) => void | Promise<void>;
  onResponseReceipt?: (receipt: ResponseReceipt, signal: AbortSignal) => void | Promise<void>;
  onRequest?: (event: Readonly<{ request: Readonly<Record<string, unknown>>; redactions: readonly import("../../privacy/redaction-engine.ts").RedactionExplanation[]; provider: string; attempt: number }>, signal: AbortSignal) => void | Promise<void>;
  metricsSink?: (event: Readonly<{ status: "succeeded" | "failed"; durationMs: number; model: string | undefined; provider: string; attempt: number }>) => void | Promise<void>;
}>;
/** Private validated evidence; absent observation explicitly means no qualified public view. */
export type ResponseEvidence = Readonly<{ response: ResponseResource; status?: ResponseStatus; observation?: ResponseObservationEnvelope }>;
export type ResponseTransportMetadata = Readonly<{ provider: string; headers: Readonly<Record<string, string>>; durationMs: number; retries: number; failovers: number; observation?: ResponseObservationEnvelope }>;
export type CreateResponse = ResponseProjection & ResponseTransportMetadata & Readonly<{ status: ResponseStatus | undefined }>;
export type ProviderResponse<T> = ResponseTransportMetadata & Readonly<{ response: T }>;
type PrivateResponseProgress = Extract<ResponseStreamChunk, { type: "content" | "reasoning" | "refusal" | "model" }>;
export type StreamChunk = Exclude<ResponseStreamChunk, { type: "response" | "response_event" }> | Readonly<{ type: "response_event"; event: Readonly<Record<string, unknown>>; progress?: readonly PrivateResponseProgress[] }> | Readonly<{ type: "response"; response: ResponseResource; status: ResponseStatus; observation?: ResponseObservationEnvelope; failure?: LLMError }> | Readonly<{ type: "headers"; headers: Readonly<Record<string, string>> }>;
export type SharedLLMClientOptions = LLMConfig & Readonly<{ sseLimits?: SseLimits; streamLimits?: ResponseStreamOptions }>;
export type RetrieveResponseQuery = ResponseQueryFor<"retrieve">;
export type InputItemsQuery = ResponseQueryFor<"input_items">;
type Emission<T> = Readonly<{ value: T; terminal?: boolean; accepted?: boolean; usage?: ProjectedUsage; model?: string; resourceId?: string }>;
type ResourceObserver = (response: ResponseResource, status?: ResponseStatus) => ResponseObservationEnvelope | undefined;
type Operation = Readonly<{ resultKind: "response" | "compact" | "delete" | "input_items" | "input_tokens"; method: "GET" | "POST" | "DELETE"; suffix?: string; query?: Readonly<Record<string, unknown>>;
  sourceOperation?: ResponseOperation; privacy?: ResponsePrivacyOptions; target?: FailoverTarget; body?: Readonly<Record<string, unknown>>; observation?: Readonly<Record<string, unknown>>; stream?: boolean; pinned?: boolean; modelOperation?: boolean; responseId?: string }>;
type ReceiptPublication = { receipt: ResponseReceipt; delivered: boolean };
type StreamCheckpoint = { target: FailoverTarget; resumes: number; publication: ReceiptPublication; privacy: MintedRequestContext };
export class SharedLLMClient {
  private readonly config: ResolvedLLMConfig;
  private readonly stats = new LLMStatsCollector();
  private readonly circuit: CircuitBreaker;
  private readonly queue: RequestQueue;
  private readonly failover: FailoverSelector;
  private readonly adaptive: AdaptiveController;
  private readonly sseLimits: SseLimits | undefined;
  private readonly streamLimits: ResponseStreamOptions | undefined;
  private readonly tracking: ResponsesTracker;
  private readonly heldCredentials: HeldSet;
  private readonly checkpoints = new WeakMap<ResponseStreamState, StreamCheckpoint>();
  constructor(options: SharedLLMClientOptions) {
    const resolved = resolveLLMConfig(options);
    if (!resolved.config) throw new LLMError("Invalid LLM configuration", "llm_config_invalid", "bad-request", false);
    this.config = resolved.config;
    this.heldCredentials = this.config.providers.reduce((held, provider) =>
      held.merge(providerHeldSet({ id: provider.id, apiKey: provider.apiKey, headers: { ...this.config.headers, ...provider.headers } })), providerHeldSet(this.config));
    this.tracking = new ResponsesTracker(this.config.responses.maximumTrackedResponses);
    this.circuit = new CircuitBreaker(this.config.circuitBreaker.threshold, this.config.circuitBreaker.resetMs);
    this.queue = new RequestQueue(this.config.queue, this.config.concurrencyPolicy);
    this.failover = new FailoverSelector(this.config);
    this.adaptive = new AdaptiveController(this.config.adaptive, this.config.queue.maxConcurrency);
    this.sseLimits = options.sseLimits; this.streamLimits = options.streamLimits;
    for (const identity of [this.config.model, this.config.providerId, ...this.config.models.map(model => model.model),
      ...this.config.providers.map(provider => provider.id), ...this.config.failover.models]) if (identity !== undefined) assertProviderIdentity(identity, this.heldCredentials);
    registerLLMExposure(); setActiveLLMClientForExposure(this);
  }
  async create(source: ResponseRequestFor<"create">, options: ProviderRequestOptions = {}): Promise<CreateResponse> {
    options = captureRequestOptions(options, this.config.responses);
    const body = captureResponseSource("create", source, this.config.responses);
    if (body.stream === true) throw new InputError("Use stream() for a streaming request", "responses_stream_method_required");
    const result = await this.json<ResponseResource>({ resultKind: "response", method: "POST", body, sourceOperation: "create", privacy: options.privacy!, modelOperation: true,
      pinned: responseRequiresOrigin(body), ...this.continuationTarget(body, options) }, options, parseResponseResource);
    return this.projectResult(result, options);
  }
  stream(source: ResponseRequestFor<"create">, options: ProviderRequestOptions = {}): AsyncGenerator<StreamChunk> {
    options = captureRequestOptions(options, this.config.responses);
    const body = captureResponseSource("create", source, this.config.responses), state = options.state ?? new ResponseStreamState({ ...this.streamLimits, maximumObservationBytes: this.config.responses.maximumResponseBytes });
    if (state.sequenceNumber >= 0 || state.done) throw new InputError("A new stream requires a fresh checkpoint", "responses_checkpoint_invalid");
    return this.streamOperation({ resultKind: "response", method: "POST", body, sourceOperation: "create", privacy: options.privacy!, stream: true, modelOperation: true,
      pinned: responseRequiresOrigin(body), ...this.continuationTarget(body, options) }, state, options);
  }
  async retrieve(id: string, query: RetrieveResponseQuery = {}, options: ProviderRequestOptions = {}): Promise<CreateResponse> {
    options = captureRequestOptions(options, this.config.responses);
    query = this.captureQuery("retrieve", query);
    return this.projectResult(await this.json({ resultKind: "response", method: "GET", suffix: responsePath(id), responseId: id, query, pinned: true, target: this.originTarget(id, options) }, options, parseResponseResource), options);
  }
  resume(state: ResponseStreamState, query: RetrieveResponseQuery = {}, options: ProviderRequestOptions = {}): AsyncGenerator<StreamChunk> {
    options = captureRequestOptions(options, this.config.responses);
    query = this.captureQuery("retrieve", query);
    const checkpoint = this.checkpoints.get(state);
    if (!checkpoint || !state.responseId || state.done || checkpoint.resumes >= this.config.responses.maximumResumeAttempts) {
      throw new InputError("Stream checkpoint cannot be resumed", "responses_checkpoint_invalid");
    }
    checkpoint.resumes++;
    return this.streamOperation({ resultKind: "response", method: "GET", suffix: responsePath(state.responseId), responseId: state.responseId, stream: true, pinned: true,
      query: { ...query, stream: true, starting_after: state.sequenceNumber } }, state, { ...options, provider: checkpoint.target.providerId }, checkpoint.target);
  }
  async cancel(id: string, options: ProviderRequestOptions = {}): Promise<CreateResponse> {
    options = captureRequestOptions(options, this.config.responses);
    return this.projectResult(await this.json({ resultKind: "response", method: "POST", suffix: `${responsePath(id)}/cancel`, responseId: id, pinned: true, target: this.originTarget(id, options) }, options, parseResponseResource), options);
  }
  async delete(id: string, options: ProviderRequestOptions = {}): Promise<ProviderResponse<ResponseDeletion | undefined>> {
    options = captureRequestOptions(options, this.config.responses);
    const result = await this.json({ resultKind: "delete", method: "DELETE", suffix: responsePath(id), responseId: id, pinned: true, target: this.originTarget(id, options) }, options,
      value => value === undefined ? undefined : parseResponseEndpointResource("delete", value) as ResponseDeletion);
    return result;
  }
  async listInputItems(id: string, query: InputItemsQuery = {}, options: ProviderRequestOptions = {}): Promise<ProviderResponse<ResponseInputItemPage>> {
    options = captureRequestOptions(options, this.config.responses);
    query = this.captureQuery("input_items", query);
    return this.json({ resultKind: "input_items", method: "GET", suffix: `${responsePath(id)}/input_items`, responseId: id, query, pinned: true, target: this.originTarget(id, options) }, options,
      value => parseResponseEndpointResource("input_items", value) as ResponseInputItemPage);
  }
  async compact(source: ResponseRequestFor<"compact">, options: ProviderRequestOptions = {}): Promise<ProviderResponse<ResponseCompaction>> {
    options = captureRequestOptions(options, this.config.responses);
    const body = captureResponseSource("compact", source, this.config.responses);
    return this.json({ resultKind: "compact", method: "POST", suffix: "/compact", body, sourceOperation: "compact", privacy: options.privacy!, pinned: true, ...this.continuationTarget(body, options) }, options,
      value => parseResponseEndpointResource("compact", value) as ResponseCompaction);
  }
  async countInputTokens(source: ResponseRequestFor<"input_tokens">, options: ProviderRequestOptions = {}): Promise<ProviderResponse<ResponseInputTokenCount>> {
    options = captureRequestOptions(options, this.config.responses);
    const body = captureResponseSource("input_tokens", source, this.config.responses);
    return this.json({ resultKind: "input_tokens", method: "POST", suffix: "/input_tokens", body, sourceOperation: "input_tokens", privacy: options.privacy!, pinned: true, ...this.continuationTarget(body, options) }, options,
      value => parseResponseEndpointResource("input_tokens", value) as ResponseInputTokenCount);
  }
  getStats() { return this.stats.snapshot(this.circuit.isOpen()); }
  getResponseTracking() { return this.tracking.snapshot(); }
  /** Release local accounting only. This does not cancel a remote response. */
  retireResponse(id: string, provider?: string): boolean {
    return this.observeRetirement(this.tracking.retire(id, provider));
  }
  private observeRetirement(target: FailoverTarget | undefined): boolean {
    if (!target) return false;
    this.log({ level: "warn", event: "response_usage_unavailable", provider: target.providerId, model: target.model, requestMs: 0 });
    return true;
  }
  getCircuit() { return this.circuit.snapshot(); }
  getQueue() { return this.queue.snapshot(this.heldCredentials); }
  getAdaptive() { return this.adaptive.snapshot(); }
  getCurrentTarget(): SafeProviderTarget { return safeProviderTarget(this.failover.current(), this.heldCredentials); }
  resetCircuitForTest(): void { this.circuit.resetForTest(); }
  getQueueConcurrency(): number { return this.queue.getConcurrency(); }
  isQueuePaused(): boolean { return this.queue.isPaused(); }
  pauseQueue(): void { this.queue.pauseQueue(); }
  resumeQueue(): void { this.queue.resumeQueue(); }
  clearQueue(): number { return this.queue.clearQueue(); }
  rejectAll(): number { return this.queue.rejectAll(); }
  setConcurrency(value: number): void {
    if (this.adaptive.isEnabled()) { this.adaptive.setConcurrency(value); this.queue.setConcurrency(this.adaptive.current()); }
    else this.queue.setConcurrency(value);
  }
  private captureQuery<Kind extends keyof typeof RESPONSE_QUERY_SCHEMAS>(kind: Kind, query: ResponseQueryFor<Kind>): ResponseQueryFor<Kind> {
    try {
      const captured = snapshotRequestContext(query, undefined, this.config.responses).request;
      const parsed = RESPONSE_QUERY_SCHEMAS[kind].safeParse(captured);
      if (parsed.success) return deepFreeze(parsed.data) as ResponseQueryFor<Kind>;
    } catch {
      // No caller or parser data enters the fixed query refusal.
      throw responsesQueryInvalid();
    }
    throw responsesQueryInvalid();
  }
  private originTarget(id: string, options: ProviderRequestOptions): FailoverTarget {
    const known = this.tracking.origin(id, options.provider);
    if (known) return known;
    if (!options.provider && this.config.providers.length > 0) throw new InputError("An originating provider is required for this resource", "responses_provider_required");
    return this.failover.resolve(this.config.model, options.provider ?? this.config.providerId);
  }
  private continuationTarget(body: Readonly<Record<string, unknown>>, options: ProviderRequestOptions): { target: FailoverTarget } {
    if (typeof body.previous_response_id === "string") {
      const origin = this.originTarget(body.previous_response_id, options);
      return { target: this.selectedTarget(body, this.failover.resolve(typeof body.model === "string" ? body.model : this.config.model, origin.providerId, origin)) };
    }
    if (body.conversation != null && options.provider === undefined && this.config.providers.length > 0) throw new InputError("Conversation continuation requires its provider", "responses_provider_required");
    return { target: this.selectedTarget(body, this.failover.resolve(typeof body.model === "string" ? body.model : this.failover.current().model,
      options.provider ?? this.failover.current().providerId)) };
  }
  private selectedTarget(body: Readonly<Record<string, unknown>>, target: FailoverTarget): FailoverTarget {
    const prompt = Object.hasOwn(body, "prompt") ? body.prompt : target.requestDefaults.prompt;
    return body.model === null || !Object.hasOwn(body, "model") && prompt != null ? Object.freeze({ ...target, model: undefined }) : target;
  }
  private projectResult(result: ProviderResponse<ResponseResource>, options: ProviderRequestOptions): CreateResponse {
    const projection = projectResponse(result.response);
    if (options.truncateAsError && projection.truncated) throw new TruncationError("Response did not complete within its limits");
    return deepFreeze({ ...result, ...projection, status: result.response.status });
  }
  private async json<T>(operation: Operation, options: ProviderRequestOptions, parse: (value: unknown) => T): Promise<ProviderResponse<T>> {
    // The operation's held set covers the returned value too (SECC-V-A3), as it does every streamed chunk.
    const marker = redactionReplacement("secret", options.privacy?.policy ?? DEFAULT_PRIVACY_POLICY);
    for await (const result of this.operate(operation, options, async function* (response, signal, config, _target, onResource, heldCredentials) {
      const text = await readBody(response, signal, config.responses.maximumResponseBytes, config.responses.cleanupTimeoutMs, PROVIDER_LOG_CATEGORY);
      const value = parse(operation.resultKind === "delete" && response.status === 204 && text.length === 0 ? undefined : parseProviderJson(text));
      if (operation.resultKind !== "input_items" && operation.responseId !== undefined && value !== undefined && (typeof value !== "object" || value === null || !("id" in value) || value.id !== operation.responseId)) {
        throw new LLMError("Provider returned a different response identity", "responses_identity_changed", "invalid-response", false);
      }
      if (operation.resultKind === "response") onResource(value as ResponseResource);
      const usage = operation.resultKind === "compact" ? projectResponseUsage((value as ResponseCompaction).usage) : undefined;
      yield { value: heldCredentials.scrubStrings(value, marker), terminal: true, accepted: true, ...(usage === undefined ? {} : { usage }) };
    })) return { response: result.value, ...result.metadata };
    throw new InvalidResponseError("Provider returned no resource");
  }
  private async *streamOperation(operation: Operation, state: ResponseStreamState, options: ProviderRequestOptions, pinnedTarget?: FailoverTarget): AsyncGenerator<StreamChunk> {
    const self = this;
    // The terminal resource as accepted, kept for the teardown fallback below:
    // captured when the decoder sees it (before anything can fail), then given
    // the decoder's own classified `failure` when its response chunk passes, so
    // the fallback never reports a failed resource without its failure (an
    // observer or an abort must not replace it — a2-correctness NEW-3).
    let terminalEvidence: (ResponseEvidence & { status: ResponseStatus; failure?: LLMError }) | undefined, emittedResource = false;
    // THE RUN'S HELD SET COVERS EVERY CHUNK THIS STREAM YIELDS (SECC-V-A3):
    // tool-call arguments (streamed pieces included — a value split across
    // two deltas is still masked), the raw resource and native events, not
    // only the display text. What a consumer executes, streams and records
    // never carries a value this operation holds.
    const marker = redactionReplacement("secret", options.privacy?.policy ?? DEFAULT_PRIVACY_POLICY);
    try { for await (const result of this.operate<StreamChunk>(operation, options, async function* (response, signal, _config, _target, onResource, heldCredentials) {
      if (!(response.headers.get("content-type") ?? "").toLowerCase().startsWith(CONTENT_TYPE_SSE) || response.body === null) throw new InvalidResponseError("Responses stream requires a server-sent event body");
      // Pieces arrive in three interleaved streams that each carry text a
      // held value can be split across: tool-call argument deltas, native
      // delta events, and the private progress text. Each is keyed and
      // released only when no later piece can complete a held value; a
      // stream's tail is released at its end (the call's done, the native
      // family's done, the terminal chunk).
      const pieces = heldCredentials.pieceStreams(marker);
      const lastNative = new Map<string, Readonly<Record<string, unknown>>>();
      const lastProgress = new Map<string, Extract<PrivateResponseProgress, { text: string }>>();
      const nativeKey = (event: Readonly<Record<string, unknown>>): Readonly<{ key: string; delta: boolean }> | undefined => {
        const type = typeof event["type"] === "string" ? event["type"] : "";
        const delta = type.endsWith(".delta") && typeof event["delta"] === "string";
        if (!delta && !type.endsWith(".done")) return undefined;
        const index = [event["output_index"], event["content_index"] ?? event["summary_index"]].map((part) => typeof part === "number" ? part : "").join(":");
        return { key: `native:${type.slice(0, type.lastIndexOf("."))}:${index}`, delta };
      };
      function* release(match: (key: string) => boolean): Generator<StreamChunk> {
        for (const [key, tail] of pieces.release((key) => !key.startsWith("progress:") && match(key))) {
          if (key.startsWith("tool:")) {
            if (tail.length > 0) yield { type: "tool_call_delta", index: Number(key.slice(5)), arguments: tail };
            continue;
          }
          // The native delta's own progress piece travels with it, in lockstep.
          const progress = pieces.release((other) => other === `progress:${key}`).flatMap(([, text]) => text.length === 0 ? [] : [{ ...lastProgress.get(key)!, text }]);
          if (tail.length > 0 || progress.length > 0) yield { type: "response_event", event: heldCredentials.scrubStrings({ ...lastNative.get(key), delta: tail }, marker), progress };
        }
      }
      function* scrubbed(chunk: StreamChunk): Generator<StreamChunk> {
        if (chunk.type === "tool_call_delta") {
          const safe = pieces.push(`tool:${chunk.index}`, chunk.arguments);
          if (safe.length > 0) yield { ...chunk, arguments: safe };
          return;
        }
        if (chunk.type === "response_event") {
          const native = nativeKey(chunk.event);
          if (native?.delta === true) {
            lastNative.set(native.key, chunk.event);
            const safe = pieces.push(native.key, chunk.event["delta"] as string);
            if (safe.length > 0) yield { ...chunk, event: heldCredentials.scrubStrings({ ...chunk.event, delta: safe }, marker) };
            return;
          }
          if (native !== undefined) yield* release((key) => key === native.key);
        }
        if (chunk.type === "tool_call_done") yield* release((key) => key === `tool:${chunk.index}`);
        if (chunk.type === "finish" || chunk.type === "response" || chunk.type === "error") yield* release(() => true);
        // The complete resource (the terminal chunk, a native completed/done
        // event carrying it) is masked across its text parts too: a held
        // value split between two output items is caught once both are known
        // (secd-security SECD-C6; live deltas of the first item precede the
        // second and are the stated residual).
        yield chunk.type === "error" ? chunk : chunk.type === "response" || (chunk.type === "response_event" && typeof chunk.event["response"] === "object") ? heldCredentials.scrubAcrossTextParts(chunk, marker) : heldCredentials.scrubStrings(chunk, marker);
      }
      // A raw native delta's progress text is the same piece: it is streamed
      // under the native event's key, so both release (and hold) together.
      const scrubbedProgress = (raw: unknown, items: readonly PrivateResponseProgress[]): readonly PrivateResponseProgress[] => {
        const native = raw !== null && typeof raw === "object" ? nativeKey(raw as Readonly<Record<string, unknown>>) : undefined;
        return items.flatMap((item): PrivateResponseProgress[] => {
          if (item.type === "model" || native?.delta !== true) return [heldCredentials.scrubStrings(item, marker)];
          lastProgress.set(native.key, item);
          const text = pieces.push(`progress:${native.key}`, item.text);
          return text.length === 0 ? [] : [{ ...item, text }];
        });
      };
      for await (const event of parseSseStream(decodeReadableStream(response.body, signal, self.config.responses.maximumResponseBytes, self.config.responses.cleanupTimeoutMs, PROVIDER_LOG_CATEGORY), null, self.sseLimits)) {
        if (event.type !== "data") continue;
        const raw = parseProviderJson(event.data);
        const failureOptions = { diagnostic: null, heldCredentials, maximumMessageCharacters: self.config.responses.maximumErrorMessageCharacters };
        let observation: ResponseObservationEnvelope | undefined;
        const chunks = state.consume(raw, event.event, failureOptions, (resource, status) => {
          // The observation is masked across its text parts by its builder (one object for every consumer).
          observation = onResource(resource, status);
          terminalEvidence = { response: heldCredentials.scrubAcrossTextParts(resource, marker), status, ...(observation === undefined ? {} : { observation }) };
          return { ...failureOptions, diagnostic: observation?.diagnostic ?? null };
        });
        const progress = scrubbedProgress(raw, chunks.filter((chunk): chunk is PrivateResponseProgress => ["content", "reasoning", "refusal", "model"].includes(chunk.type)));
        for (const chunk of chunks) {
          if (chunk.type === "response" && chunk.failure !== undefined && terminalEvidence !== undefined) terminalEvidence = { ...terminalEvidence, failure: chunk.failure };
          // Native event/resource/tool evidence remains private. Public display
          // strings come only from the complete envelope; raw tool projections
          // retain execution semantics, masked of held values.
          if (["content", "reasoning", "refusal", "model"].includes(chunk.type)) continue;
          for (const safe of scrubbed(chunk as StreamChunk)) {
            if (safe.type === "response") {
              yield { value: { ...safe, ...(observation === undefined ? {} : { observation }) }, terminal: true, resourceId: safe.response.id };
              if (!observation) continue;
              const display = observation.display;
              yield { value: { type: "headers", headers: observation.headers }, terminal: true };
              if (display) {
                yield { value: { type: "model", model: display.model }, terminal: true };
                for (const [type, text] of [["content", display.content], ["reasoning", display.reasoning], ["refusal", display.refusal]] as const) if (text) yield { value: { type, text }, terminal: true };
              }
            } else yield { value: safe.type === "response_event" ? { ...safe, progress: safe.progress ?? progress } : safe, terminal: state.done, ...(state.responseId ? { resourceId: state.responseId } : {}) };
          }
        }
        if (state.done) return;
      }
      state.finish();
    }, pinnedTarget, state)) {
      if (result.value.type === "response") emittedResource = true;
      yield result.value;
      if (result.value.type === "error") throw result.value.error;
      if (result.value.type === "finish" && result.value.truncated && options.truncateAsError) throw new TruncationError("Response did not complete within its limits");
    } } catch (error) {
      // Teardown has completed; preserve private accepted evidence without a finish or public display.
      if (!emittedResource && terminalEvidence) yield { type: "response", ...terminalEvidence };
      throw error;
    }
  }
  private async *operate<T>(operation: Operation, options: ProviderRequestOptions,
    consume: (response: Response, signal: AbortSignal, config: ResolvedLLMConfig, target: FailoverTarget, onResource: ResourceObserver, heldCredentials: HeldSet) => AsyncIterable<Emission<T>>,
    pinnedTarget?: FailoverTarget, streamState?: ResponseStreamState): AsyncGenerator<{ value: T; metadata: ResponseTransportMetadata }> {
    let target = pinnedTarget ?? operation.target ?? this.failover.resolve(typeof operation.body?.model === "string" ? operation.body.model : this.failover.current().model, options.provider ?? this.failover.current().providerId);
    const retainedPrivacy = (streamState === undefined ? undefined : this.checkpoints.get(streamState)?.privacy) ??
      (operation.responseId === undefined ? undefined : this.tracking.observation(operation.responseId, target.providerId));
    const invocationPrivacy = options.privacy!;
    const parentCredentials = typeof operation.body?.previous_response_id === "string" ? this.tracking.observation(operation.body.previous_response_id, target.providerId)?.heldCredentials : undefined;
    let attemptPrivacy: MintedRequestContext = retainedPrivacy ?? { ...invocationPrivacy, limits: this.config.responses, heldCredentials: this.heldCredentials };
    const reservation = operation.modelOperation ? this.tracking.reserve() : undefined;
    const started = performance.now();
    const operationDeadline = deadline(options.signal, this.config.responses.operationTimeoutMs, () => new TimeoutError("Provider operation exceeded its deadline"));
    const signal = operationDeadline.signal;
    const visited = new Set<string>([targetIdentity(target)]);
    let retryCounts: Partial<Record<ErrorType, number>> = {}, retries = 0, failovers = 0, attempt = 0, observed = false;
    let outcomeError: ErrorType | undefined, finalized = false, attemptDispatched = false;
    let publication = streamState === undefined ? undefined : this.checkpoints.get(streamState)?.publication;
    const acceptIdentity = (id: string): void => {
      if (operation.responseId !== undefined && id !== operation.responseId) {
        throw new LLMError("Provider returned a different response identity", "responses_identity_changed", "invalid-response", false);
      }
      observed = true;
      reservation?.observe(id, target, attemptPrivacy);
      if (publication === undefined) {
        const origin = target, retire = this.tracking.retirement(id, origin.providerId);
        publication = { delivered: false, receipt: Object.freeze({ responseId: id, providerId: origin.providerId,
          requestedModel: origin.model, retire: () => this.observeRetirement(retire()) }) };
        if (streamState !== undefined) this.checkpoints.set(streamState, { target: origin, resumes: 0, publication, privacy: attemptPrivacy });
      }
    };
    const publishReceipt = async (lifetime: AbortSignal): Promise<void> => {
      if (publication === undefined || publication.delivered || options.onResponseReceipt === undefined) return;
      // Commit observer delivery before invoking user code, including synchronous throws.
      publication.delivered = true;
      try { await awaitWithSignal(options.onResponseReceipt(publication.receipt, lifetime), lifetime); }
      catch (error) { checkAborted(lifetime); throw new ResponseObserverError(error); }
      checkAborted(lifetime);
    };
    const finalize = (): void => {
      if (finalized) return; finalized = true; operationDeadline.clear();
      reservation?.release();
      if (attemptDispatched && this.adaptive.isEnabled()) { const decision = this.adaptive.record({ durationMs: performance.now() - started, errorType: outcomeError });
        if (decision === "increase" || decision === "decrease") this.queue.setConcurrency(this.adaptive.current()); }
    };
    try {
      // A newly installed resume observer receives the retained receipt before another HTTP attempt.
      await publishReceipt(signal);
      let requestCounted = false;
      while (true) {
        attemptDispatched = false;
        checkAborted(signal);
        if (target.model !== undefined) assertProviderIdentity(target.model, this.heldCredentials);
        const prepared = operation.sourceOperation === undefined ? undefined : prepareResponseRequest(operation.sourceOperation,
          operation.body!, target, operation.stream, this.config.responses, operation.privacy ?? invocationPrivacy, this.heldCredentials.merge(parentCredentials));
        const body = prepared === undefined ? undefined : admitMintedRequest(prepared, prepared.operation);
        const requestObservation = prepared === undefined ? undefined : observeMintedRequest(prepared);
        const privacy = prepared === undefined ? attemptPrivacy : mintedRequestContext(prepared);
        attemptPrivacy = privacy;
        const heldCredentials = privacy.heldCredentials;
        assertProviderIdentity(target.providerId, heldCredentials);
        if (target.model !== undefined) assertProviderIdentity(target.model, heldCredentials);
        if (!requestCounted) { this.stats.recordRequest(this.label(target.model), this.label(target.providerId)); requestCounted = true; }
        if (!this.circuit.allow()) throw new LLMError("Provider circuit is open", "llm_circuit_open", "overloaded", false);
        const admission: QueueRequest = { model: target.model, provider: target.providerId, signal, ...(options.priority === undefined ? {} : { priority: options.priority }) };
        await this.queue.acquire(admission);
        let released = false;
        const release = guarded("llm.client.release", (): void => { if (!released) { released = true; this.queue.release(admission); } });
        let attemptStarted = started;
        const final: T[] = [];
        let usage: ProjectedUsage | undefined, model: string | undefined, headers: Readonly<Record<string, string>> = {}, rawHeaders: Readonly<Record<string, string>> = {};
        let observation: ResponseObservationEnvelope | undefined;
        let acceptedFailure: unknown, observationFailure: unknown;
        let acceptedEvidence: ResponseEvidence | undefined;
        let failure: LLMError | undefined, nativeFailure: LLMError | undefined, compactAccounted = false;
        const onResource: ResourceObserver = (resource, effectiveStatus = resource.status) => {
          // Accepted identity closes the retry door before observation or teardown can fail.
          acceptIdentity(resource.id);
          acceptedEvidence = deepFreeze({ response: resource, ...(effectiveStatus === undefined ? {} : { status: effectiveStatus }) });
          usage = projectResponseUsage(resource.usage);
          if (effectiveStatus !== undefined && ["completed", "failed", "cancelled", "incomplete"].includes(effectiveStatus)) {
            const origin = this.tracking.settle(resource.id, target.providerId, usage !== undefined);
            // Account under the safe originating request scope; provider labels remain private.
            if (origin) this.stats.recordTokens(usage, this.label(origin.model), this.label(origin.providerId));
          }
          if (effectiveStatus === "failed" || effectiveStatus === "cancelled") nativeFailure = classifyProviderFailure(resource.error, { diagnostic: null, maximumMessageCharacters: this.config.responses.maximumErrorMessageCharacters });
          try {
            // A held value split across the resource's text parts (two output
            // items) is masked here, once both halves are known (secd-security
            // SECD-C6): the ONE observation every consumer shares is made here.
            observation = deepFreeze(heldCredentials.scrubAcrossTextParts(observeResponseEnvelope({ headers: rawHeaders, response: resource, ...(streamState === undefined ? {} : { evidence: streamState.observationContext }) }, { ...privacy, limits: this.config.responses, heldCredentials, selectedHeaders: this.config.responses.capturedResponseHeaders, ...(effectiveStatus === undefined ? {} : { status: effectiveStatus }) }),
              redactionReplacement("secret", options.privacy?.policy ?? DEFAULT_PRIVACY_POLICY)));
          } catch (error) { observationFailure = error; return undefined; }
          acceptedEvidence = deepFreeze({ ...acceptedEvidence, observation });
          headers = observation.headers;
          // Metrics remain in requested routing scope; returned model is private protocol evidence.
          if (effectiveStatus === "failed" || effectiveStatus === "cancelled") nativeFailure = classifyProviderFailure(resource.error, {
            maximumMessageCharacters: this.config.responses.maximumErrorMessageCharacters, heldCredentials,
            diagnostic: observation.diagnostic ?? null });
          return observation;
        };
        try {
          signal.addEventListener("abort", release, { once: true });
          checkAborted(signal);
          attemptStarted = performance.now();
          model = this.label(target.model);
          const request: ProviderHttpRequest = { url: endpointUrl(target, operation), method: operation.method,
            heldCredentials, observationPrivacy: privacy, transport: this.config.responses,
            onDispatch: () => { attemptDispatched = true; },
            beforeDispatch: async requestSignal => {
              if (!options.onRequest || !requestObservation) return;
              try {
                await options.onRequest({ request: requestObservation, redactions: mintedRequestRedactions(prepared!), provider: this.label(target.providerId), attempt }, requestSignal);
              } catch { checkAborted(requestSignal); throw new RequestObserverError(); }
            },
            accept: operation.stream ? CONTENT_TYPE_SSE : CONTENT_TYPE_JSON, signal,
            modelOperation: operation.modelOperation ?? false,
            ...(body === undefined ? {} : { body }), onAborted: release };
          const self = this;
          for await (const item of requestProviderHttp(target, request, async function* (response, requestSignal, receivedHeaders) {
            rawHeaders = receivedHeaders;
            try {
              for await (const item of consume(response, requestSignal, self.config, target, onResource, heldCredentials)) {
                if (item.resourceId !== undefined) acceptIdentity(item.resourceId);
                await publishReceipt(requestSignal);
                yield item;
              }
            } catch (error) {
              // onResource may accept/account a resource and then reject its diagnostic projection.
              // Still deliver its control handle; a secondary observer fault cannot replace that failure.
              if (publication !== undefined && !publication.delivered && options.onResponseReceipt !== undefined) acceptedFailure = error;
              try { await publishReceipt(requestSignal); } catch {
                handleError(new LLMError("Receipt observer failed after an accepted response failure", "response_receipt_observer_failed", "invalid-response", false), { module: "llm", operation: "publishReceipt" });
              }
              throw error;
            }
          })) {
            if (item.accepted || item.resourceId !== undefined) observed = true;
            if (item.accepted && operation.resultKind === "delete") this.retireResponse(operation.responseId!, target.providerId);
            if (item.accepted && operation.resultKind === "compact" && !compactAccounted) {
              compactAccounted = true;
              this.stats.recordTokens(item.usage, this.label(target.model), this.label(target.providerId));
            }
            if (item.accepted && operation.resultKind !== "response") {
              observation = observeResponseEnvelope({ headers: rawHeaders, ...(item.value === undefined ? {} : { response: item.value }) },
                { ...privacy, limits: this.config.responses, heldCredentials, selectedHeaders: this.config.responses.capturedResponseHeaders });
              headers = observation.headers;
            }
            if (typeof item.value === "object" && item.value !== null && "type" in item.value && item.value.type === "error" && "error" in item.value && isLLMError(item.value.error)) nativeFailure = item.value.error;
            if (item.usage) usage = item.usage;

            if (item.terminal) final.push(item.value);
            else { if (typeof item.value === "object" && item.value !== null && "type" in item.value && item.value.type !== "headers") observed = true;
              yield { value: item.value, metadata: { provider: target.providerId, headers, durationMs: performance.now() - started, retries, failovers } }; }
          }
        } catch (error) {
          const original = acceptedFailure ?? error;
          failure = operationError(original);
        } finally { signal.removeEventListener("abort", release); release(); }
        if (observationFailure !== undefined) failure = nativeFailure ?? operationError(observationFailure);
        if (failure !== undefined && nativeFailure !== undefined) failure = nativeFailure;
        if (acceptedEvidence !== undefined && options.onResponseEvidence !== undefined) {
          try {
            await awaitWithSignal(options.onResponseEvidence(acceptedEvidence, signal), signal);
            checkAborted(signal);
          } catch (error) {
            if (failure === undefined) {
              try { if (nativeFailure) failure = nativeFailure; else { checkAborted(signal); failure = new ResponseObserverError(error); } }
              catch (abort) { failure = operationError(abort); }
            } else handleError(new LLMError("Accepted evidence observer failed after an earlier provider failure", "response_evidence_observer_failed", "invalid-response", false), { module: "llm", operation: "publishEvidence" });
          }
        }
        const durationMs = performance.now() - attemptStarted;
        if (!failure) {
          if (nativeFailure) { outcomeError = nativeFailure.errorType; this.circuit.recordFailure(); this.stats.recordError(nativeFailure.errorType, model, this.label(target.providerId)); }
          else this.circuit.recordSuccess();
          this.stats.recordLatency(durationMs, model, this.label(target.providerId));
          this.failover.recordLatency(this.failover.currentIndex(), durationMs);
          this.log({ level: nativeFailure ? "error" : "info", event: nativeFailure ? "response_failed" : "response_succeeded", requestMs: durationMs, model, provider: target.providerId, attempt, retries,
            ...(nativeFailure ? { errorType: nativeFailure.errorType, errorCode: nativeFailure.code, status: nativeFailure.status } : {}),
            promptTokens: usage?.promptTokens, completionTokens: usage?.completionTokens, totalTokens: usage?.totalTokens });
          optionalDiagnostic(() => options.metricsSink?.({ status: nativeFailure ? "failed" : "succeeded", durationMs, model, provider: this.label(target.providerId), attempt }));
          const metadata = { provider: target.providerId, headers, ...(observation === undefined ? {} : { observation }), durationMs: performance.now() - started, retries, failovers };
          finalize();
          // All native terminal vectors are delivered only after body/deadline/admission teardown.
          for (const value of final) yield { value, metadata };
          return;
        }
        outcomeError = failure.errorType;
        this.stats.recordError(failure.errorType, this.label(target.model), this.label(target.providerId));
        this.log({ level: failure.retryable ? "warn" : "error", event: "response_failed", requestMs: durationMs, model: target.model, provider: target.providerId,
          attempt, errorType: failure.errorType, errorCode: failure.code, status: failure.status });
        optionalDiagnostic(() => options.metricsSink?.({ status: "failed", durationMs, model: this.label(target.model), provider: this.label(target.providerId), attempt }));
        if (attemptDispatched && !observed && operation.method === "POST" && hasMutableEffects(body) && ["network", "timeout", "streaming"].includes(failure.errorType)) {
          throw new LLMError("Provider delivery outcome is unknown; reconcile the response before resubmitting", "llm_delivery_uncertain", failure.errorType, false);
        }
        if (!attemptDispatched || signal.aborted || observed || !failure.retryable) throw failure;
        const count = retryCounts[failure.errorType] ?? 0;
        if (count < target.maxRetries[failure.errorType]) {
          retryCounts[failure.errorType] = count + 1; retries++; attempt++; this.stats.recordRetry(this.label(target.model), this.label(target.providerId));
          const delay = computeBackoff(this.config.backoff, count, failure);
          if (delay >= this.config.responses.operationTimeoutMs - (performance.now() - started)) throw new TimeoutError("Retry-After exceeds the remaining operation deadline");
          await sleep(delay, signal); continue;
        }
        if (!operation.pinned && !responseRequiresOrigin(body ?? {}) && this.failover.shouldFailover(failure.errorType, visited)) {
          // Omitted/null wire model cannot authorize a model-only "failover".
          const excluded = new Set(visited);
          if (target.model === undefined) for (const candidate of this.failover.candidates()) {
            if ([...visited].some(identity => JSON.parse(identity)[0] === candidate.providerId)) excluded.add(targetIdentity(candidate));
          }
          const next = this.failover.next(excluded);
          if (next) { target = this.selectedTarget(operation.body ?? {}, next); visited.add(targetIdentity(next)); retryCounts = {}; failovers++; attempt++;
            this.stats.recordFailover(failure.errorType); requestCounted = false; continue; }
        }
        throw failure;
      }
    } catch (error) {
      if (attemptDispatched && isLLMError(error) && error.code !== "llm_circuit_open" && error.code !== "llm_cancelled") this.circuit.recordFailure();
      throw error;
    } finally { finalize(); }
  }
  private log(event: Omit<LLMLogEvent, "redactedAuth">): void {
    optionalDiagnostic(() => {
      const safe = observeProviderDiagnostic({ ...event, redactedAuth: redactAuth(this.config.apiKey) }, this.heldCredentials) as LLMLogEvent;
      debugLog(PROVIDER_LOG_CATEGORY, event.level, event.event, () => observeProviderDiagnostic({ ...safe, ...currentRecordingContext() }, this.heldCredentials));
      return this.config.logger?.log(safe);
    });
  }
  private label(value: string): string;
  private label(value: string | undefined): string | undefined;
  private label(value: string | undefined): string | undefined { return value === undefined ? undefined : observeProviderLabel(value, this.heldCredentials); }
}
/** Private callbacks/scalars are captured; AbortSignal remains a live cancellation capability. */
function captureRequestOptions(options: ProviderRequestOptions, limits: ResolvedLLMConfig["responses"]): ProviderRequestOptions {
  return Object.freeze({ ...options, privacy: captureResponsePrivacy(options.privacy, limits) });
}
/** Start optional observers immediately, but never retain admission for them. */
function optionalDiagnostic(operation: () => void | Promise<void>): void {
  void bestEffortAsync(async () => { await operation(); });
}
function operationError(error: unknown): LLMError {
  return isLLMError(error) ? error : new LLMError("Unexpected provider operation failure", "llm_unexpected_error", "invalid-response", false);
}
function responsePath(id: string): string {
  if (!id) throw new InputError("Response id is required", "responses_id_invalid");
  return `/${encodeURIComponent(id)}`;
}
function endpointUrl(target: FailoverTarget, operation: Operation): string {
  const url = new URL(`${target.baseUrl}${target.responsesPath}${operation.suffix ?? ""}`);
  for (const [key, value] of Object.entries(operation.query ?? {})) {
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(`${key}[]`, String(item));
    else if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}
const responsesQueryInvalid = (): InputError =>
  new InputError("Responses query does not match its operation schema", "responses_query_invalid");
/** The provider's retry delay: the one backoff owner; an overloaded provider is given twice the base. */
function computeBackoff(config: ResolvedLLMConfig["backoff"], attempt: number, error: LLMError): number {
  const retryAfter = error instanceof RateLimitError ? error.retryAfterMs : undefined;
  const policy = error.errorType === "overloaded" ? { ...config, baseMs: config.baseMs * 2 } : config;
  return backoffDelayMs(policy, attempt, retryAfter);
}
/** Header-only diagnostic view for the still-unmigrated evaluation caller; not a complete response observation. */
export function extractResponseHeaders(response: Pick<Response, "headers">, transport: Pick<ResponsesTransportConfig, "capturedResponseHeaders" | "maximumResponseHeaderBytes">,
  heldCredentials: HeldSet = EMPTY_HELD_SET): Readonly<Record<string, string>> {
  return observeResponseEnvelope({ headers: captureResponseHeaders(response, transport.maximumResponseHeaderBytes) },
    { selectedHeaders: transport.capturedResponseHeaders, heldCredentials, limits: transport }).headers;
}
export async function fetchProviderModels(options: Readonly<{ baseUrl: string; apiKey: string; headers: Readonly<Record<string, string>>; providerId: string;
  timeoutMs: number; maxBytes: number; transport: ResponsesTransportConfig; signal?: AbortSignal;
  /** The credential's destination rule (see the outbound door's `privateAddressesAllowedFor`). */
  allowPrivateAddress: boolean }>): Promise<unknown> {
  if (!isProviderBaseUrl(options.baseUrl)) throw new InputError("Provider address is invalid", "provider_address_invalid");
  // Discovery is bounded by its OWN byte bound (`maxBytes`): the one request
  // bound is the transport's `maximumResponseBytes`, so discovery hands the
  // request a transport carrying it (a2-design L4: every request carried both).
  const transport = Object.freeze({ ...options.transport, maximumResponseBytes: options.maxBytes });
  for await (const value of requestProviderHttp(options, { url: options.baseUrl.replace(/\/+$/u, "") + "/models", method: "GET", accept: CONTENT_TYPE_JSON,
    signal: options.signal, transport }, async function* (response, signal) {
      yield parseProviderJson(await readBody(response, signal, transport.maximumResponseBytes, transport.cleanupTimeoutMs, PROVIDER_LOG_CATEGORY));
    })) return value;
  throw new InvalidResponseError("Provider model discovery returned no resource");
}

function hasMutableEffects(body: Operation["body"]): boolean {
  return body?.conversation != null || Array.isArray(body?.tools) && body.tools.some(tool =>
    typeof tool === "object" && tool !== null && "type" in tool && tool.type !== "function");
}
