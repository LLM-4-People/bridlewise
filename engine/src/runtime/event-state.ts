import { ResponseStreamState, type ResponseStreamChunk } from "../shared/llm/responses-stream.ts";
import { InvalidResponseError, MISALIGNMENT_POLICY_ERROR_CODE } from "../shared/llm/errors.ts";
import { parseSseEventBlock } from "./sse-parser.ts";
import {
  CONTRACT_ERROR_SCHEMA,
  JSON_OBJECT_SCHEMA,
  MODEL_EVENT_SCHEMA,
  type ContractSettings,
  type ModelEvent,
  type RawMetadataEnvelope,
  type Usage,
  USAGE_SCHEMA,
} from "../kernel/contracts.ts";
import { InputError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { escapePointer } from "../shared/json-pointer.ts";
import { requireObject, type JsonObject } from "../shared/type-guards.ts";
import { assertNoDuplicateJsonObjectKeys } from "../kernel/json-integrity.ts";
import { metadataEnvelope } from "../kernel/protocol-projections.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";

const PROTOCOL_CHAT_COMPLETIONS = ROOT_POLICY.contracts.protocolIds[1] as "openai-chat-completions";
const PROTOCOL_RESPONSES = ROOT_POLICY.contracts.protocolIds[0] as "openai-responses";

type EventInput<T = ModelEvent> = T extends ModelEvent ? Omit<T, "protocol" | "sequence"> : never;

export type StreamStep = Readonly<{
  events: readonly ModelEvent[];
  metadata: readonly RawMetadataEnvelope[];
}>;

type SseFrame = Readonly<{ event?: string; data?: string; heartbeat: boolean }>;
type ChatToolState = {
  callId: string;
  name: string;
  arguments: string;
  done: boolean;
  outputIndex: number;
  toolIndex: number;
};
export const EVENT_STATE_REVISION = "openai-stream-state/v5";

export function parseSseFrame(frame: string, settings: ContractSettings): SseFrame {
  if (frame.length > settings.limits.maximumTextCharacters) {
    throw new InputError("SSE frame exceeds the configured limit", "stream_frame_too_large");
  }
  const data: string[] = [];
  let event: string | undefined;
  let heartbeat = false;
  for (const line of frame.split(/\r?\n/u)) {
    if (line === "") continue;
    if (line.startsWith(":")) {
      heartbeat = true;
      continue;
    }
    if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /u, ""));
      continue;
    }
    if (line.startsWith("event:")) {
      if (event !== undefined) throw new InputError("SSE event field is duplicated", "stream_field_duplicate");
      event = line.slice(6).replace(/^ /u, "");
      continue;
    }
    throw new InputError("SSE frame contains an unsupported field", "stream_field_unsupported");
  }
  if (data.length === 0) {
    if (!heartbeat || event !== undefined) throw new InputError("SSE frame has no data", "stream_data_missing");
    return deepFreeze({ heartbeat: true });
  }
  return deepFreeze({ heartbeat, data: data.join("\n"), ...(event === undefined ? {} : { event }) });
}

export class ChatCompletionEventState {
  readonly #settings: ContractSettings;
  #sequence = 0;
  #eventCount = 0;
  #started = false;
  #done = false;
  #usageSeen = false;
  #responseId: string | undefined;
  #model: string | undefined;
  readonly #seenChoices = new Set<number>();
  readonly #finishedChoices = new Set<number>();
  readonly #tools = new Map<string, ChatToolState>();

  constructor(settings: ContractSettings) {
    this.#settings = settings;
  }

  consumeSse(frame: string): StreamStep {
    try {
      if (this.#done) throw new InputError("Chat stream continued after completion", "stream_after_done");
      const parsed = parseSseFrame(frame, this.#settings);
      if (parsed.data === undefined) return emptyStep();
      if (parsed.event !== undefined && parsed.event !== "message") {
        throw new InputError("Chat stream event name is unsupported", "chat_event_name_unsupported");
      }
      if (parsed.data === this.#settings.chatStreamDoneSentinel) return this.#consumeDone();
      return this.consumeChunk(parseJsonObject(parsed.data, this.#settings, "chat_chunk_malformed"));
    } catch (error) {
      this.#done = true;
      throw error;
    }
  }

  consumeChunk(raw: unknown): StreamStep {
    try {
      return this.#consumeChunk(raw);
    } catch (error) {
      this.#done = true;
      throw error;
    }
  }

  #consumeChunk(raw: unknown): StreamStep {
    if (this.#done) throw new InputError("Chat stream continued after completion", "stream_after_done");
    if (this.#usageSeen) {
      throw new InputError("Chat data followed the terminal usage chunk", "stream_after_usage");
    }
    const chunk = requireObject(raw, "chat_chunk_malformed");
    const events: ModelEvent[] = [];
    const metadata: RawMetadataEnvelope[] = [];
    this.#recordInput();
    if (chunk.error !== undefined) {
      if (!this.#started) {
        events.push(this.#emit({ type: "start" }));
        this.#started = true;
      }
      events.push(this.#providerError(chunk.error, PROTOCOL_CHAT_COMPLETIONS));
      this.#done = true;
      return step(events, metadata);
    }
    this.#bindIdentity(chunk);
    if (!this.#started) {
      events.push(this.#emit({ type: "start", responseId: this.#responseId! }));
      this.#started = true;
    }
    const unknown: JsonObject = {};
    collectUnknown(chunk, new Set([
      "choices", "created", "error", "id", "model", "object", "service_tier", "system_fingerprint", "usage",
    ]), "$", unknown);
    if (!Array.isArray(chunk.choices)) throw new InputError("Chat choices are malformed", "chat_choices_malformed");
    const chunkChoiceIndices = new Set<number>();
    for (const choiceValue of chunk.choices) {
      const choice = requireObject(choiceValue, "chat_choice_malformed");
      const outputIndex = indexField(choice.index, "chat_choice_malformed");
      if (chunkChoiceIndices.has(outputIndex)) {
        throw new InputError("Chat choice index was duplicated within a chunk", "chat_choice_duplicate");
      }
      chunkChoiceIndices.add(outputIndex);
      this.#consumeChoice(choice, outputIndex, events, unknown);
    }
    if (chunk.usage !== undefined && chunk.usage !== null) {
      if (this.#usageSeen) throw new InputError("Chat usage was duplicated", "stream_usage_duplicate");
      if (chunk.choices.length !== 0 || !this.#allSeenChoicesFinished()) {
        throw new InputError("Chat usage chunk arrived before every choice finished", "stream_usage_out_of_order");
      }
      this.#usageSeen = true;
      events.push(this.#emit({ type: "usage", usage: parseChatUsage(chunk.usage) }));
    }
    if (chunk.choices.length === 0 && (chunk.usage === undefined || chunk.usage === null)) {
      throw new InputError("Chat chunk has neither choices nor terminal usage", "chat_chunk_empty");
    }
    if (Object.keys(unknown).length > 0) metadata.push(metadataEnvelope(PROTOCOL_CHAT_COMPLETIONS, unknown));
    return step(events, metadata);
  }

  #consumeChoice(choice: JsonObject, outputIndex: number, events: ModelEvent[], unknown: JsonObject): void {
    if (this.#finishedChoices.has(outputIndex)) {
      throw new InputError("Chat choice continued after its finish reason", "stream_after_finish");
    }
    this.#seenChoices.add(outputIndex);
    collectUnknown(choice, new Set(["delta", "finish_reason", "index", "logprobs"]), `$/choices/${outputIndex}`, unknown);
    const delta = requireObject(choice.delta ?? {}, "chat_delta_malformed");
    collectUnknown(delta, new Set(["content", "reasoning", "reasoning_content", "refusal", "role", "tool_calls"]), `$/choices/${outputIndex}/delta`, unknown);
    if (delta.content !== undefined && delta.content !== null) {
      if (typeof delta.content !== "string") throw new InputError("Chat text delta is malformed", "chat_delta_malformed");
      events.push(this.#emit({ type: "text_delta", outputIndex, delta: delta.content }));
    }
    const reasoningValues = [delta.reasoning, delta.reasoning_content].filter((entry) => entry !== undefined && entry !== null);
    if (reasoningValues.length > 1) throw new InputError("Chat reasoning delta is duplicated", "chat_reasoning_duplicate");
    if (reasoningValues.length === 1) {
      if (typeof reasoningValues[0] !== "string") throw new InputError("Chat reasoning delta is malformed", "chat_delta_malformed");
      events.push(this.#emit({ type: "reasoning_delta", outputIndex, delta: reasoningValues[0] }));
    }
    if (delta.tool_calls !== undefined) this.#consumeToolDeltas(delta.tool_calls, outputIndex, events, unknown);
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      if (typeof choice.finish_reason !== "string") throw new InputError("Chat finish reason is malformed", "chat_finish_malformed");
      const open = [...this.#tools.values()].filter((tool) => tool.outputIndex === outputIndex && !tool.done);
      if (choice.finish_reason === "tool_calls") {
        if (open.length === 0) throw new InputError("Tool finish had no tool calls", "tool_finish_without_calls");
        for (const tool of open.toSorted((left, right) => left.toolIndex - right.toolIndex)) {
          tool.done = true;
          events.push(this.#emit({
            type: "tool_call_done",
            outputIndex,
            callId: tool.callId,
            arguments: parseToolArguments(tool.arguments, this.#settings),
          }));
        }
      } else if (open.length > 0) {
        throw new InputError("Chat finished with incomplete tool calls", "tool_call_incomplete");
      }
      events.push(this.#emit({
        type: "finish",
        outputIndex,
        reason: mapFinishReason(choice.finish_reason),
      }));
      this.#finishedChoices.add(outputIndex);
    }
  }

  #consumeToolDeltas(value: unknown, outputIndex: number, events: ModelEvent[], unknown: JsonObject): void {
    if (!Array.isArray(value)) throw new InputError("Chat tool delta is malformed", "tool_delta_malformed");
    const entries = value.map((entryValue) => requireObject(entryValue, "tool_delta_malformed"));
    const toolIndices = entries.map((entry) => indexField(entry.index, "tool_delta_malformed"));
    if (new Set(toolIndices).size !== toolIndices.length) {
      throw new InputError("Chat tool index was duplicated within a chunk", "tool_delta_index_duplicate");
    }
    for (const [entryOffset, entry] of entries.entries()) {
      const toolIndex = toolIndices[entryOffset]!;
      const key = `${outputIndex}:${toolIndex}`;
      const fn = requireObject(entry.function ?? {}, "tool_delta_malformed");
      collectUnknown(entry, new Set(["function", "id", "index", "type"]), `$/choices/${outputIndex}/delta/tool_calls/${toolIndex}`, unknown);
      collectUnknown(fn, new Set(["arguments", "name"]), `$/choices/${outputIndex}/delta/tool_calls/${toolIndex}/function`, unknown);
      let state = this.#tools.get(key);
      if (!state) {
        if (typeof entry.id !== "string" || typeof fn.name !== "string") {
          throw new InputError("Tool call start is incomplete", "tool_call_start_incomplete");
        }
        if ([...this.#tools.values()].some((tool) => tool.callId === entry.id)) {
          throw new InputError("Tool call identity was duplicated", "tool_call_start_duplicate");
        }
        state = {
          callId: entry.id,
          name: fn.name,
          arguments: "",
          done: false,
          outputIndex,
          toolIndex,
        };
        this.#tools.set(key, state);
        events.push(this.#emit({ type: "tool_call_start", outputIndex, callId: state.callId, name: state.name }));
      } else if (entry.id !== undefined || fn.name !== undefined) {
        throw new InputError("Tool call start fields were duplicated", "tool_call_start_duplicate");
      }
      if (state.done) throw new InputError("Tool call continued after completion", "tool_call_after_done");
      if (fn.arguments !== undefined) {
        if (typeof fn.arguments !== "string") throw new InputError("Tool arguments delta is malformed", "tool_delta_malformed");
        state.arguments += fn.arguments;
        if (state.arguments.length > this.#settings.limits.maximumTextCharacters) {
          throw new InputError("Tool arguments exceed the configured limit", "tool_arguments_too_large");
        }
        if (fn.arguments !== "") events.push(this.#emit({
          type: "tool_call_delta",
          outputIndex,
          callId: state.callId,
          argumentsDelta: fn.arguments,
        }));
      }
    }
  }

  #consumeDone(): StreamStep {
    if (this.#done) throw new InputError("Chat done sentinel was duplicated", "stream_done_duplicate");
    if (!this.#started || !this.#allSeenChoicesFinished() || [...this.#tools.values()].some((tool) => !tool.done)) {
      throw new InputError("Chat done sentinel arrived before a complete finish", "stream_done_out_of_order");
    }
    this.#recordInput();
    this.#done = true;
    return emptyStep();
  }

  #providerError(value: unknown, protocol: "openai-chat-completions"): ModelEvent {
    const raw = requireObject(value, "provider_error_malformed");
    return this.#emit({
      type: "error",
      error: CONTRACT_ERROR_SCHEMA.parse({
        kind: "provider",
        code: safeProviderCode(raw.code),
        message: "Provider reported an error",
        retryable: false,
        metadata: metadataEnvelope(protocol, { error: raw }),
      }),
    });
  }

  #bindIdentity(chunk: JsonObject): void {
    if (typeof chunk.id !== "string" || chunk.id.length === 0 ||
      typeof chunk.model !== "string" || chunk.model.length === 0 ||
      chunk.object !== "chat.completion.chunk") {
      throw new InputError("Chat chunk identity is malformed", "chat_identity_malformed");
    }
    if (this.#responseId === undefined) {
      this.#responseId = chunk.id;
      this.#model = chunk.model;
      return;
    }
    if (chunk.id !== this.#responseId || chunk.model !== this.#model) {
      throw new InputError("Chat chunk identity changed", "chat_identity_changed");
    }
  }

  #allSeenChoicesFinished(): boolean {
    return this.#seenChoices.size > 0 && this.#seenChoices.size === this.#finishedChoices.size &&
      [...this.#seenChoices].every((index) => this.#finishedChoices.has(index));
  }

  #emit(event: EventInput): ModelEvent {
    return MODEL_EVENT_SCHEMA.parse({ ...event, protocol: PROTOCOL_CHAT_COMPLETIONS, sequence: this.#sequence++ });
  }

  #recordInput(): void {
    this.#eventCount += 1;
    if (this.#eventCount > this.#settings.limits.maximumEvents) {
      throw new InputError("Chat stream exceeds the configured event limit", "stream_event_limit_exceeded");
    }
  }
}

/** Contract-facing projection of the same native state used by the live client. */
export class ResponsesEventState {
  readonly #settings: ContractSettings;
  /** The provider error-message cap: THE configured `runtime.responses` one (a2-design M6). */
  readonly #maximumErrorMessageCharacters: number;
  readonly #state: ResponseStreamState;
  #sequence = 0;
  #closed = false;
  readonly #callIds = new Map<number, string>();

  /** `transport` is the configured `runtime.responses` transport (its error-message cap). */
  constructor(settings: ContractSettings, transport: Readonly<{ maximumErrorMessageCharacters: number }>) {
    this.#settings = settings;
    this.#maximumErrorMessageCharacters = transport.maximumErrorMessageCharacters;
    this.#state = new ResponseStreamState(settings.limits);
  }

  consumeSse(frame: string): StreamStep {
    try {
      if (this.#closed || this.#state.done) throw new InputError("Responses stream continued after completion", "stream_after_done");
      if (frame.length > this.#settings.limits.maximumTextCharacters) throw new InputError("SSE frame exceeds limit", "stream_frame_too_large");
      const parsed = parseSseEventBlock(frame, null);
      if (parsed === undefined || parsed.type === "comment") return emptyStep();
      if (parsed.type !== "data") throw new InputError("Responses event is malformed", "responses_event_malformed");
      return this.consumeEvent(parseJsonObject(parsed.data, this.#settings, "responses_event_malformed"), parsed.event);
    } catch (error) { this.#closed = true; throw error; }
  }

  consumeEvent(raw: unknown, eventName?: string): StreamStep {
    try {
      if (this.#closed) throw new InputError("Responses stream continued after completion", "stream_after_done");
      // Provider failure text is bounded by the ONE configured error-message
      // cap (it used the contract's 1 MiB text limit: a second owner, 1000x the
      // live client's; a2-design M6).
      const chunks = this.#state.consume(raw, eventName, { maximumMessageCharacters: this.#maximumErrorMessageCharacters });
      const events: ModelEvent[] = [];
      const metadata: RawMetadataEnvelope[] = [];
      for (const chunk of chunks) {
        if (chunk.type === "response_event") metadata.push(metadataEnvelope(PROTOCOL_RESPONSES, { event: chunk.event }));
        const event = this.#project(chunk);
        if (event !== undefined) events.push(MODEL_EVENT_SCHEMA.parse({ ...event, protocol: PROTOCOL_RESPONSES, sequence: this.#sequence++ }));
      }
      return step(events, metadata);
    } catch (error) {
      this.#closed = true;
      if (error instanceof InvalidResponseError) throw new InputError(error.message, String(error.safeDetails.protocolCode ?? "responses_event_malformed"));
      throw error;
    }
  }

  #project(chunk: ResponseStreamChunk): EventInput | undefined {
    switch (chunk.type) {
      case "start": return { type: "start", ...(chunk.responseId === undefined ? {} : { responseId: chunk.responseId }) };
      case "content": case "refusal": return { type: "text_delta", outputIndex: chunk.outputIndex ?? 0, delta: chunk.text };
      case "reasoning": return { type: "reasoning_delta", outputIndex: chunk.outputIndex ?? 0, delta: chunk.text };
      case "tool_call_start":
        this.#callIds.set(chunk.index, chunk.id);
        return { type: "tool_call_start", outputIndex: chunk.index, callId: chunk.id, name: chunk.name };
      case "tool_call_delta": return { type: "tool_call_delta", outputIndex: chunk.index, callId: this.#callIds.get(chunk.index)!, argumentsDelta: chunk.arguments };
      case "tool_call_done": {
        return { type: "tool_call_done", outputIndex: chunk.index, callId: chunk.id,
          arguments: parseToolArguments(chunk.arguments, this.#settings) };
      }
      case "usage": return { type: "usage", usage: {
        inputTokens: chunk.usage.promptTokens, outputTokens: chunk.usage.completionTokens, totalTokens: chunk.usage.totalTokens,
        ...(chunk.usage.cachedInputTokens === undefined ? {} : { cachedInputTokens: chunk.usage.cachedInputTokens }),
        ...(chunk.usage.reasoningTokens === undefined ? {} : { reasoningTokens: chunk.usage.reasoningTokens }),
      } };
      case "finish": return { type: "finish", reason: mapFinishReason(chunk.reason) };
      case "error": return { type: "error", error: CONTRACT_ERROR_SCHEMA.parse({
        kind: "provider", code: chunk.error.code === MISALIGNMENT_POLICY_ERROR_CODE ? chunk.error.code : safeProviderCode(chunk.error.safeDetails.providerCode), message: "Provider reported an error",
        retryable: false, metadata: metadataEnvelope(PROTOCOL_RESPONSES, { error: chunk.error.safeDetails }),
      }) };
      default: return undefined;
    }
  }
}

function parseJsonObject(text: string, settings: ContractSettings, code: string): JsonObject {
  if (text.length > settings.limits.maximumTextCharacters) {
    throw new InputError("Protocol JSON exceeds the configured limit", "stream_frame_too_large");
  }
  assertNoDuplicateJsonObjectKeys(text, "Protocol JSON contains a duplicate key", "protocol_key_duplicate");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InputError("Protocol JSON is malformed", code);
  }
  return requireObject(parsed, code);
}

function parseToolArguments(text: string, settings: ContractSettings): ReturnType<typeof JSON_OBJECT_SCHEMA.parse> {
  if (text === "" || text.length > settings.limits.maximumTextCharacters) {
    throw new InputError("Tool arguments are incomplete or too large", "tool_arguments_malformed");
  }
  return JSON_OBJECT_SCHEMA.parse(parseJsonObject(text, settings, "tool_arguments_malformed"));
}

function parseChatUsage(value: unknown): Usage {
  const usage = requireObject(value, "usage_malformed");
  const details = usage.completion_tokens_details === undefined
    ? {}
    : requireObject(usage.completion_tokens_details, "usage_malformed");
  const promptDetails = usage.prompt_tokens_details === undefined
    ? {}
    : requireObject(usage.prompt_tokens_details, "usage_malformed");
  return parseUsageNumbers(
    usage.prompt_tokens,
    usage.completion_tokens,
    usage.total_tokens,
    promptDetails.cached_tokens,
    details.reasoning_tokens,
  );
}

function parseUsageNumbers(
  input: unknown,
  output: unknown,
  total: unknown,
  cached: unknown,
  reasoning: unknown,
): Usage {
  for (const value of [input, output, total]) {
    if (!Number.isSafeInteger(value) || Number(value) < 0) throw new InputError("Usage is malformed", "usage_malformed");
  }
  if (Number(total) !== Number(input) + Number(output)) {
    throw new InputError("Usage totals are inconsistent", "usage_total_inconsistent");
  }
  for (const value of [cached, reasoning]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 0)) {
      throw new InputError("Usage details are malformed", "usage_malformed");
    }
  }
  return USAGE_SCHEMA.parse({
    inputTokens: Number(input),
    outputTokens: Number(output),
    totalTokens: Number(total),
    ...(cached === undefined ? {} : { cachedInputTokens: Number(cached) }),
    ...(reasoning === undefined ? {} : { reasoningTokens: Number(reasoning) }),
  });
}

function mapFinishReason(value: string): "stop" | "length" | "tool_calls" | "content_filter" | "cancelled" | "unknown" {
  if (value === "stop" || value === "length" || value === "tool_calls" || value === "content_filter") return value;
  if (value === "cancelled") return "cancelled";
  return "unknown";
}

function safeProviderCode(value: unknown): string {
  return typeof value === "string" && /^[a-z0-9_]{1,512}$/u.test(value) ? value : "provider_error";
}

function indexField(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new InputError("Protocol index is malformed", code);
  return Number(value);
}

function collectUnknown(value: JsonObject, known: ReadonlySet<string>, path: string, target: JsonObject): void {
  for (const key of Object.keys(value)) {
    if (!known.has(key)) target[`${path}/${escapePointer(key)}`] = value[key];
  }
}

function step(events: readonly ModelEvent[], metadata: readonly RawMetadataEnvelope[]): StreamStep {
  return deepFreeze({ events: [...events], metadata: [...metadata] });
}

function emptyStep(): StreamStep {
  return deepFreeze({ events: [], metadata: [] });
}
