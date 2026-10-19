/** Collect host projections without rebuilding native output from progress deltas. */
import { deepFreeze } from "../kernel/integrity.ts";
import { StreamingError } from "../shared/llm/errors.ts";
import { awaitWithSignal } from "../shared/abort-signals.ts";
import { parseResponseResource, projectResponse, type ResponseResource, type ResponseStatus } from "../shared/llm/responses.ts";
import type { ChatCompletionRequest, ChatCompletionResult, ChatMessage, ChatStreamEvent, ProviderAdapter, ProviderInvocationOptions } from "./provider-adapter.ts";
import type { ResponseEvidence, ResponseReceipt } from "../shared/llm/client.ts";
import type { ResponseObservationEnvelope } from "../privacy/responses-observation.ts";

export type NativeResponseMetadata = ResponseEvidence & Readonly<{ status: ResponseStatus }>;
export type NativeResponseObserver = (metadata: NativeResponseMetadata, signal?: AbortSignal) => void | Promise<void>;

/** What a foreground host plugs into one provider turn. */
export type ResponseTurnHooks = Readonly<{
  onResponseReceipt?: ProviderInvocationOptions["onResponseReceipt"];
  onResponse?: NativeResponseObserver | undefined;
  /** Receives failure evidence BEFORE a native observer runs, so a throwing observer cannot erase it. */
  onFailureEvidence: (result: ChatCompletionResult) => void;
}>;

/**
 * The provider request for one turn. The data is deep-frozen; the signal is
 * attached with a shallow freeze, because deepFreeze would recurse into the
 * AbortSignal and freeze its internal slot, making abort() throw.
 */
export function turnRequest(data: Omit<ChatCompletionRequest, "signal">, signal: AbortSignal | undefined): ChatCompletionRequest {
  const frozen = deepFreeze(data);
  return signal !== undefined ? Object.freeze({ ...frozen, signal }) : frozen;
}

export class ResponseTurn {
  #content = "";
  #privateProgress = false;
  #refusal = "";
  #usage: ChatCompletionResult["usage"];
  #headers: Readonly<Record<string, string>> = {};
  #model: string | undefined;
  #response: ResponseResource | undefined;
  #observation: ResponseObservationEnvelope | undefined;
  #status: ResponseStatus | undefined;
  #finished = false;
  #failure: unknown;
  #observed = false;
  #receipt: ResponseReceipt | undefined;

  get hasEvidence(): boolean { return this.#observed; }

  /**
   * Drive one provider stream through this turn: the single owner of receipt
   * capture and of the evidence-before-observer order for every foreground host.
   * Each event is accepted before it is yielded; closing this generator closes
   * the adapter's iterator.
   */
  async *stream(adapter: Pick<ProviderAdapter, "streamChatCompletion">, request: ChatCompletionRequest,
    hooks: ResponseTurnHooks, signal?: AbortSignal): AsyncGenerator<ChatStreamEvent, void, unknown> {
    for await (const event of adapter.streamChatCompletion(request, { onResponseReceipt: (received, observerSignal) => {
      this.#receipt = received;
      return hooks.onResponseReceipt?.(received, observerSignal);
    } })) {
      await this.accept(event, (metadata, observerSignal) => {
        hooks.onFailureEvidence(this.failed());
        return hooks.onResponse?.(metadata, observerSignal);
      }, signal);
      yield event;
    }
  }

  /** Release the private provider receipt, if one was delivered. */
  retireReceipt(): void { this.#receipt?.retire(); }

  async accept(event: ChatStreamEvent, onResponse?: NativeResponseObserver, signal?: AbortSignal): Promise<void> {
    if (event.type === "content" && event.text.length > 0 || event.type === "refusal" && event.text.length > 0 ||
        event.type === "response_event" && event.event.type !== "error" || event.type === "tool_call_start" || event.type === "tool_call_delta") {
      this.#observed = true;
    }
    switch (event.type) {
      case "response_event":
        for (const progress of event.progress ?? []) {
          this.#privateProgress = true;
          if (progress.type === "content") this.#content += progress.text;
          if (progress.type === "refusal") this.#refusal += progress.text;
          if (progress.type === "model") this.#model = progress.model;
        }
        break;
      case "content": if (!this.#privateProgress) this.#content += event.text; break;
      case "refusal": if (!this.#privateProgress) this.#refusal += event.text; break;
      case "usage": this.#usage = event.usage; break;
      case "headers": this.#headers = event.headers; break;
      case "model": this.#model = event.model; break;
      case "response":
        this.#response = parseResponseResource(event.response);
        this.#observed = true;
        this.#status = event.status;
        this.#observation = event.observation;
        // This resource has already failed. An observer or a later abort cannot
        // replace that known provider failure (classified once, by the stream
        // decoder under the configured limits) before its error chunk arrives.
        if (event.failure !== undefined && this.#failure === undefined) this.#failure = event.failure;
        try {
          signal?.throwIfAborted();
          await awaitWithSignal(onResponse?.({ response: this.#response, status: event.status, ...(event.observation === undefined ? {} : { observation: event.observation }) }, signal), signal);
        } catch (error) {
          throw this.#failure ?? error;
        }
        break;
      case "finish":
        this.#finished = true;
        if (event.reason === "error" && this.#failure === undefined) this.#failure = new StreamingError("Provider stream reported an error");
        break;
      case "error": this.#failure = event.error; break;
    }
  }

  /** Call only after the provider iterator finishes normally, including cleanup. */
  complete(): ChatCompletionResult {
    if (this.#failure) throw this.#failure;
    if (!this.#finished || !this.#response) throw new StreamingError("Provider stream ended without a native terminal response");
    const projection = projectResponse(this.#response, this.#status);
    return deepFreeze({ ...projection, usage: projection.usage ?? this.#usage,
      ...(this.#status === undefined ? {} : { status: this.#status }), headers: this.#observation?.headers ?? this.#headers,
      ...(this.#observation === undefined ? {} : { observation: this.#observation }) });
  }

  /** Failure evidence carries the native resource but never executable calls. */
  failed(): ChatCompletionResult {
    const native = this.#response === undefined ? undefined : projectResponse(this.#response, this.#status);
    return deepFreeze({ content: this.#content || native?.content || "", refusal: this.#refusal || native?.refusal || "", toolCalls: [], usage: this.#usage,
      finishReason: "error", headers: this.#headers,
      ...(this.#model === undefined ? {} : { model: this.#model }),
      ...(this.#response === undefined ? {} : { response: this.#response }),
      ...(this.#observation === undefined ? {} : { observation: this.#observation }),
      ...(this.#status === undefined ? {} : { status: this.#status }) });
  }
}

export function responseAssistantMessage(result: ChatCompletionResult & Readonly<{ errorCode?: string }>,
  evidenceObserved = result.response !== undefined || result.content.length > 0 || (result.refusal?.length ?? 0) > 0): ChatMessage {
  return deepFreeze({ role: "assistant", content: result.content,
    ...(result.response === undefined ? {} : { responseItems: result.response.output }),
    ...(evidenceObserved && (result.errorCode !== undefined || result.finishReason === "error" || result.finishReason === "cancelled" || result.response !== undefined && result.status !== "completed")
      ? { responseReplayBlocked: true } : {}),
    ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {}) });
}
