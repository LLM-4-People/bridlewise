/** One Responses lifecycle decoder for live clients and contract projections. */
import { JSON_OBJECT_SCHEMA } from "../../kernel/contracts.ts";
import { ROOT_POLICY } from "../../kernel/root-policy.ts";
import { canonicalJson, deepFreeze } from "../../kernel/integrity.ts";
import { isPlainObject } from "../type-guards.ts";
import { classifyProviderFailure, type ProviderFailureOptions } from "./provider-failure.ts";
import { StreamingError, type LLMError } from "./errors.ts";
import {
  parseResponseItem, parseResponseResource, projectResponse,
  responseProtocolError, RESPONSE_STATUS_SCHEMA,
  type ProjectedUsage, type ResponseItem, type ResponseResource, type ResponseStatus,
} from "./responses.ts";

export type ResponseStreamChunk =
  | Readonly<{ type: "response_event"; event: Readonly<Record<string, unknown>> }>
  /** `failure` is the configured classification of a failed terminal resource; the following error chunk carries the same error. */
  | Readonly<{ type: "response"; response: ResponseResource; status: ResponseStatus; failure?: LLMError }>
  | Readonly<{ type: "start"; responseId?: string }>
  | Readonly<{ type: "content"; text: string; outputIndex?: number }>
  | Readonly<{ type: "reasoning"; text: string; outputIndex?: number }>
  | Readonly<{ type: "refusal"; text: string; outputIndex?: number }>
  | Readonly<{ type: "tool_call_start"; index: number; id: string; name: string }>
  | Readonly<{ type: "tool_call_delta"; index: number; arguments: string }>
  | Readonly<{ type: "tool_call_done"; index: number; id: string; name: string; arguments: string }>
  | Readonly<{ type: "usage"; usage: ProjectedUsage }>
  | Readonly<{ type: "finish"; reason: string; truncated: boolean }>
  | Readonly<{ type: "model"; model: string }>
  | Readonly<{ type: "error"; error: LLMError }>;

type Wire = Record<string, unknown>;
type ItemState = { initial: ResponseItem; final?: ResponseItem; arguments?: string; argumentsDone?: boolean };
type PartState = {
  itemId: unknown; outputIndex: number; index: number; kind: string; summary: boolean; text: string;
  touched: boolean; textDone: boolean; final?: Wire;
};
export type ResponseStreamOptions = Readonly<{
  maximumEvents?: number; maximumTextCharacters?: number; maximumObservationBytes?: number;
}>;
/** Runs synchronously after terminal reconciliation, before fallible diagnostics. */
export type ResponseTerminalObserver = (response: ResponseResource, status: ResponseStatus) => ProviderFailureOptions;

export class ResponseStreamState {
  readonly #limits: Required<Pick<ResponseStreamOptions, "maximumEvents" | "maximumTextCharacters">>;
  #lastSequence = -1;
  #events = 0;
  #started = false;
  #done = false;
  #inProgress = false;
  #responseId: string | undefined;
  #model: string | undefined;
  #createdAt: unknown;
  #response: ResponseResource | undefined;
  #failureError: LLMError | undefined;
  #failureSource: Wire | undefined;
  readonly #observationHistory: Wire[] = [];
  readonly #maximumObservationBytes: number;
  #observationBytes = 0;
  #observationUnavailable = false;
  readonly #items = new Map<number, ItemState>();
  readonly #parts = new Map<string, PartState>();

  constructor(options: ResponseStreamOptions = {}) {
    this.#maximumObservationBytes = options.maximumObservationBytes ?? ROOT_POLICY.runtime.limits.maximumToolMemoryBytes;
    if (!Number.isSafeInteger(this.#maximumObservationBytes) || this.#maximumObservationBytes < 1 || this.#maximumObservationBytes > ROOT_POLICY.runtime.limits.maximumToolMemoryBytes) throw responseProtocolError("responses_observation_limit_invalid");
    this.#limits = {
      maximumEvents: options.maximumEvents ?? ROOT_POLICY.contracts.limits.maximumEvents,
      maximumTextCharacters: options.maximumTextCharacters ?? ROOT_POLICY.contracts.limits.maximumTextCharacters,
    };
  }

  get response(): ResponseResource | undefined { return this.#response; }
  get done(): boolean { return this.#done; }
  /** Private parser evidence omitted or changed by a terminal snapshot. Never display it. */
  get observationContext(): readonly unknown[] {
    if (this.#observationUnavailable) throw responseProtocolError("responses_observation_context_unavailable");
    const omitted: unknown[] = [...this.#observationHistory];
    if (this.#failureSource && !this.#observationHistory.some(event => event.type === "error")) omitted.push(this.#failureSource);
    for (const part of this.#parts.values()) {
      const item = this.#response?.output[part.outputIndex], parts = item?.[part.summary ? "summary" : "content"];
      const final = Array.isArray(parts) ? parts[part.index] : undefined;
      const text = isPlainObject(final) ? final[part.kind === "refusal" ? "refusal" : "text"] : undefined;
      if (part.text && part.text !== text) omitted.push(part.text);
    }
    for (const [index, item] of this.#items) if (item.arguments && item.arguments !== this.#response?.output[index]?.arguments) omitted.push(item.arguments);
    return Object.freeze([...new Set(omitted)]);
  }

  get responseId(): string | undefined { return this.#responseId; }
  get sequenceNumber(): number { return this.#lastSequence; }

  consume(raw: unknown, eventName: string | undefined, failureOptions: ProviderFailureOptions, onTerminal?: ResponseTerminalObserver): readonly ResponseStreamChunk[] {
    try {
      const chunks = this.#consume(raw, eventName, failureOptions, onTerminal);
      if (!this.#done && !this.#observationUnavailable) {
        const event = chunks.find(chunk => chunk.type === "response_event");
        if (event?.type === "response_event") {
          this.#observationBytes += Buffer.byteLength(JSON.stringify(event.event), "utf8");
          if (this.#observationBytes > this.#maximumObservationBytes) { this.#observationHistory.length = 0; this.#observationUnavailable = true; }
          else this.#observationHistory.push(event.event);
        }
      }
      return chunks;
    }
    catch (error) { this.#done = true; throw error; }
  }

  finish(): void {
    if (!this.#done) {
      if (this.#failureError) throw this.#failureError;
      throw new StreamingError("Responses stream ended without a terminal event");
    }
  }

  #consume(raw: unknown, eventName: string | undefined, failureOptions: ProviderFailureOptions, onTerminal: ResponseTerminalObserver | undefined): readonly ResponseStreamChunk[] {
    if (this.#done) throw responseProtocolError("stream_after_done");
    const parsed = JSON_OBJECT_SCHEMA.safeParse(raw);
    if (!parsed.success) throw responseProtocolError("responses_event_malformed");
    const event: Wire = parsed.data;
    if (typeof event.type !== "string" || !event.type || !Number.isSafeInteger(event.sequence_number) || Number(event.sequence_number) < 0) {
      throw responseProtocolError("responses_event_malformed");
    }
    if (eventName !== undefined && eventName !== event.type) throw responseProtocolError("responses_event_type_mismatch");
    if (Number(event.sequence_number) <= this.#lastSequence) throw responseProtocolError("responses_sequence_invalid");
    this.#lastSequence = Number(event.sequence_number);
    if (++this.#events > this.#limits.maximumEvents) throw responseProtocolError("stream_event_limit_exceeded");
    if (JSON.stringify(event).length > this.#limits.maximumTextCharacters) throw responseProtocolError("stream_frame_too_large");
    if (event.response_id !== undefined && event.response_id !== this.#responseId) throw responseProtocolError("responses_identity_changed");
    const chunks: ResponseStreamChunk[] = [{ type: "response_event", event: deepFreeze(event) }];
    if (event.type === "error") return this.#failure(event, chunks, failureOptions);
    if (event.type === "response.created") {
      if (this.#started) throw responseProtocolError("responses_event_duplicate");
      this.#snapshot(event.response, undefined);
      this.#started = true;
      chunks.push({ type: "start", responseId: this.#responseId! });
      if (this.#model !== undefined) chunks.push({ type: "model", model: this.#model });
      return chunks;
    }
    if (!this.#started) throw responseProtocolError("responses_event_out_of_order");
    switch (event.type) {
      case "response.queued": this.#snapshot(event.response, "queued"); break;
      case "response.in_progress":
        if (this.#inProgress) throw responseProtocolError("responses_event_duplicate");
        if (this.#items.size) throw responseProtocolError("responses_event_out_of_order");
        this.#inProgress = true; this.#snapshot(event.response, "in_progress"); break;
      case "response.output_item.added": this.#itemAdded(event, chunks); break;
      case "response.output_item.done": this.#itemDone(event); break;
      case "response.content_part.added": case "response.reasoning_summary_part.added":
        this.#partAdded(event, chunks); break;
      case "response.content_part.done": case "response.reasoning_summary_part.done":
        this.#partDone(event); break;
      case "response.output_text.delta": case "response.refusal.delta":
      case "response.reasoning_text.delta": case "response.reasoning_summary_text.delta":
        this.#textEvent(event, chunks, false); break;
      case "response.output_text.done": case "response.refusal.done":
      case "response.reasoning_text.done": case "response.reasoning_summary_text.done":
        this.#textEvent(event, chunks, true); break;
      case "response.function_call_arguments.delta": case "response.function_call_arguments.done":
        this.#arguments(event, chunks); break;
      case "response.completed": case "response.incomplete": case "response.failed": case "response.cancelled":
        this.#terminal(event, chunks, failureOptions, onTerminal); break;
      default:
        // New hosted-tool and extension events remain observable; they grant no execution authority.
        break;
    }
    return chunks;
  }

  #snapshot(raw: unknown, expected: ResponseStatus | undefined): Wire {
    if (!isPlainObject(raw) || typeof raw.id !== "string" || !raw.id || raw.object !== "response") throw responseProtocolError("responses_identity_changed");
    if (this.#responseId !== undefined && raw.id !== this.#responseId) throw responseProtocolError("responses_identity_changed");
    if (raw.status !== undefined && (!RESPONSE_STATUS_SCHEMA.safeParse(raw.status).success || expected !== undefined && raw.status !== expected)) {
      throw responseProtocolError("responses_identity_changed");
    }
    if (raw.model !== undefined && (typeof raw.model !== "string" || !raw.model || this.#model !== undefined && raw.model !== this.#model)) {
      throw responseProtocolError("responses_identity_changed");
    }
    if (raw.created_at !== undefined && this.#createdAt !== undefined && raw.created_at !== this.#createdAt) throw responseProtocolError("responses_identity_changed");
    this.#responseId = raw.id;
    if (typeof raw.model === "string") this.#model = raw.model;
    if (raw.created_at !== undefined) this.#createdAt = raw.created_at;
    return raw;
  }

  #itemAdded(event: Wire, chunks: ResponseStreamChunk[]): void {
    const index = responseIndex(event.output_index);
    if (this.#items.has(index)) throw responseProtocolError("responses_event_duplicate");
    const item = parseResponseItem(event.item);
    if (item.id !== undefined && [...this.#items.values()].some((entry) => entry.initial.id === item.id)) throw responseProtocolError("responses_event_duplicate");
    const state: ItemState = { initial: item };
    this.#items.set(index, state);
    if (item.type === "function_call") {
      if ([...this.#items.entries()].some(([otherIndex, entry]) => otherIndex !== index && entry.initial.type === "function_call" && entry.initial.call_id === item.call_id)) {
        throw responseProtocolError("tool_call_start_duplicate");
      }
      state.arguments = String(item.arguments);
      chunks.push({ type: "tool_call_start", index, id: String(item.call_id), name: String(item.name) });
      if (state.arguments) chunks.push({ type: "tool_call_delta", index, arguments: state.arguments });
    }
    this.#seedParts(item, index, chunks);
  }

  #seedParts(item: ResponseItem, outputIndex: number, chunks: ResponseStreamChunk[]): void {
    for (const [field, summary] of [["content", false], ["summary", true]] as const) {
      if (!Array.isArray(item[field])) continue;
      item[field].forEach((raw, index) => {
        if (!isPlainObject(raw) || typeof raw.type !== "string") return;
        const text = raw.type === "refusal" ? raw.refusal : raw.text;
        const part: PartState = { itemId: item.id, outputIndex, index, kind: raw.type, summary, text: typeof text === "string" ? text : "", touched: false, textDone: false };
        this.#parts.set(partKey(outputIndex, index, summary), part);
        if (part.text && textualPart(part.kind)) chunks.push(textChunk(part, part.text));
      });
    }
  }

  #active(event: Wire, requireId = true): Readonly<{ index: number; state: ItemState }> {
    const index = responseIndex(event.output_index);
    const state = this.#items.get(index);
    if (!state || state.final) throw responseProtocolError("responses_event_out_of_order");
    if (requireId && (typeof event.item_id !== "string" || !event.item_id)) throw responseProtocolError("responses_item_identity_missing");
    if (event.item_id !== undefined && event.item_id !== state.initial.id) throw responseProtocolError("responses_item_identity_changed");
    return { index, state };
  }

  #partAdded(event: Wire, chunks: ResponseStreamChunk[]): void {
    const { index: outputIndex, state } = this.#active(event);
    const summary = String(event.type).includes("summary_part");
    const index = responseIndex(summary ? event.summary_index : event.content_index);
    if (summary ? state.initial.type !== "reasoning" : !["message", "reasoning"].includes(state.initial.type)) throw responseProtocolError("responses_content_part_invalid");
    const raw = event.part;
    if (!isPlainObject(raw) || typeof raw.type !== "string") throw responseProtocolError("responses_content_part_invalid");
    const text = raw.type === "refusal" ? raw.refusal : raw.text;
    if (textualPart(raw.type) && typeof text !== "string") throw responseProtocolError("responses_content_part_invalid");
    const key = partKey(outputIndex, index, summary);
    const prior = this.#parts.get(key);
    if (prior?.touched || prior && (prior.kind !== raw.type || textualPart(raw.type) && prior.text !== text)) throw responseProtocolError("responses_event_duplicate");
    if (prior) { prior.touched = true; return; }
    const part: PartState = { itemId: state.initial.id, outputIndex, index, kind: raw.type, summary, text: typeof text === "string" ? text : "", touched: true, textDone: false };
    this.#parts.set(key, part);
    if (part.text && textualPart(part.kind)) chunks.push(textChunk(part, part.text));
  }

  #textEvent(event: Wire, chunks: ResponseStreamChunk[], done: boolean): void {
    const { index: outputIndex, state } = this.#active(event);
    const type = String(event.type);
    const summary = type.includes("reasoning_summary_");
    const reasoning = type.includes("reasoning_");
    const index = responseIndex(summary ? event.summary_index : event.content_index);
    const key = partKey(outputIndex, index, summary);
    const kind = summary ? "summary_text" : reasoning ? "reasoning_text" : type.includes("refusal") ? "refusal" : "output_text";
    let part = this.#parts.get(key);
    if (!part && reasoning && state.initial.type === "reasoning") {
      part = { itemId: state.initial.id, outputIndex, index, kind, summary, text: "", touched: true, textDone: false };
      this.#parts.set(key, part);
    }
    if (!part || part.final || part.textDone) throw responseProtocolError("responses_event_out_of_order");
    if (part.kind !== kind || (reasoning ? state.initial.type !== "reasoning" : state.initial.type !== "message")) throw responseProtocolError("responses_content_part_changed");
    const value = done ? kind === "refusal" ? event.refusal : event.text : event.delta;
    if (typeof value !== "string") throw responseProtocolError("responses_event_malformed");
    if (done) {
      if (part.text !== value) throw responseProtocolError("responses_text_changed");
      part.textDone = true;
    } else {
      part.text += value; part.touched = true;
      if (part.text.length > this.#limits.maximumTextCharacters) throw responseProtocolError("stream_frame_too_large");
      if (value) chunks.push(textChunk(part, value));
    }
  }

  #partDone(event: Wire): void {
    const { index: outputIndex } = this.#active(event);
    const summary = String(event.type).includes("summary_part");
    const index = responseIndex(summary ? event.summary_index : event.content_index);
    const part = this.#parts.get(partKey(outputIndex, index, summary));
    if (!part || part.final) throw responseProtocolError("responses_event_out_of_order");
    if (part.touched && !part.textDone && textualPart(part.kind)) throw responseProtocolError("responses_event_out_of_order");
    const raw = event.part;
    if (!isPlainObject(raw) || raw.type !== part.kind || textualPart(part.kind) && (part.kind === "refusal" ? raw.refusal : raw.text) !== part.text) {
      throw responseProtocolError("responses_content_part_changed");
    }
    part.final = raw;
  }

  #arguments(event: Wire, chunks: ResponseStreamChunk[]): void {
    const { index, state } = this.#active(event);
    if (state.initial.type !== "function_call" || state.argumentsDone) throw responseProtocolError("responses_event_out_of_order");
    if (event.name !== undefined && event.name !== state.initial.name) throw responseProtocolError("tool_call_identity_changed");
    const done = event.type === "response.function_call_arguments.done";
    const value = done ? event.arguments : event.delta;
    if (typeof value !== "string") throw responseProtocolError("responses_event_malformed");
    if (done) {
      if (value !== state.arguments) throw responseProtocolError("tool_call_arguments_changed");
      state.argumentsDone = true;
      // Argument completion is observation only; response.completed authorizes execution.
    } else {
      state.arguments = (state.arguments ?? "") + value;
      if (state.arguments.length > this.#limits.maximumTextCharacters) throw responseProtocolError("stream_frame_too_large");
      if (value) chunks.push({ type: "tool_call_delta", index, arguments: value });
    }
  }

  #itemDone(event: Wire): void {
    const { index, state } = this.#active(event, false);
    const item = parseResponseItem(event.item);
    if (item.id !== state.initial.id || item.type !== state.initial.type) throw responseProtocolError("responses_item_identity_changed");
    if (["message", "reasoning", "function_call"].includes(item.type) && item.status === "in_progress") throw responseProtocolError("responses_event_out_of_order");
    if (item.type === "function_call") {
      if (item.call_id !== state.initial.call_id || item.name !== state.initial.name || item.arguments !== state.arguments ||
          canonicalJson(item.caller ?? null) !== canonicalJson(state.initial.caller ?? null) || item.namespace !== state.initial.namespace) {
        throw responseProtocolError("tool_call_identity_changed");
      }
      state.argumentsDone = true;
    }
    for (const [field, summary] of [["content", false], ["summary", true]] as const) {
      if (item.type !== "message" && item.type !== "reasoning") continue;
      const parts = [...this.#parts.values()].filter((part) => part.outputIndex === index && part.summary === summary).sort((a, b) => a.index - b.index);
      const actual = item[field];
      if (parts.length === 0 && actual === undefined) continue;
      if (!Array.isArray(actual) || actual.length !== parts.length) throw responseProtocolError("responses_item_payload_changed");
      for (const part of parts) {
        const raw = actual[part.index];
        if (!isPlainObject(raw) || raw.type !== part.kind || textualPart(part.kind) && (part.kind === "refusal" ? raw.refusal : raw.text) !== part.text ||
            part.final && canonicalJson(raw) !== canonicalJson(part.final)) throw responseProtocolError("responses_item_payload_changed");
        if (part.touched && !part.textDone && textualPart(part.kind)) throw responseProtocolError("responses_event_out_of_order");
      }
    }
    state.final = item;
  }

  #terminal(event: Wire, chunks: ResponseStreamChunk[], failureOptions: ProviderFailureOptions, onTerminal: ResponseTerminalObserver | undefined): void {
    const status = String(event.type).slice("response.".length) as ResponseStatus;
    const raw = this.#snapshot(event.response, status);
    const response = parseResponseResource(raw);
    if (status === "completed") {
      if ([...this.#items.values()].some((state) => !state.final)) throw responseProtocolError("responses_event_out_of_order");
      if (response.output.length !== this.#items.size) throw responseProtocolError("responses_final_payload_changed");
    }
    for (const [index, state] of this.#items) {
      if (state.final && (response.output[index] === undefined || canonicalJson(response.output[index]) !== canonicalJson(state.final))) throw responseProtocolError("responses_final_payload_changed");
    }
    this.#response = response;
    this.#done = true;
    if (onTerminal) failureOptions = onTerminal(response, status);
    const projection = projectResponse(response, status);
    // One classification per failed terminal, under the configured limits. The
    // resource carries it so a host that fails before the error chunk keeps it.
    const failure = this.#failureError || status === "failed" ? classifyProviderFailure(this.#failureSource ?? response.error, failureOptions) : undefined;
    chunks.push({ type: "response", response, status, ...(failure === undefined ? {} : { failure }) });
    if (this.#model !== undefined) chunks.push({ type: "model", model: this.#model });
    if (projection.usage !== undefined) chunks.push({ type: "usage", usage: projection.usage });
    if (failure !== undefined) { chunks.push({ type: "error", error: failure }); return; }
    for (const call of projection.toolCalls) {
      const index = response.output.findIndex((item) => item.type === "function_call" && item.call_id === call.id);
      chunks.push({ type: "tool_call_done", index, id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
    chunks.push({ type: "finish", reason: projection.finishReason, truncated: projection.truncated });
  }

  #failure(event: Wire, chunks: ResponseStreamChunk[], failureOptions: ProviderFailureOptions): readonly ResponseStreamChunk[] {
    // Official reference documents flat fields; live OpenAI also emits the nested envelope.
    const error = event.error === undefined ? event : event.error;
    if (!isPlainObject(error) || !(typeof error.code === "string" || error.code === null) || typeof error.message !== "string" ||
        !(typeof error.param === "string" || error.param === null) || error.type !== undefined && typeof error.type !== "string") {
      throw responseProtocolError("responses_error_malformed");
    }
    this.#failureSource ??= error;
    this.#failureError ??= classifyProviderFailure(error, failureOptions);
    if (!this.#started) {
      chunks.push({ type: "start" });
      this.#done = true;
      chunks.push({ type: "error", error: this.#failureError });
    }
    // A started response can still supply its failed resource. EOF surfaces the retained error.
    return chunks;
  }
}

function responseIndex(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw responseProtocolError("responses_output_index_invalid");
  return Number(value);
}
function partKey(outputIndex: number, index: number, summary: boolean): string { return `${outputIndex}:${summary ? "summary" : "content"}:${index}`; }
function textChunk(part: PartState, text: string): ResponseStreamChunk {
  return { type: part.kind === "output_text" ? "content" : part.kind === "refusal" ? "refusal" : "reasoning", text, outputIndex: part.outputIndex };
}

function textualPart(kind: string): boolean { return ["output_text", "refusal", "summary_text", "reasoning_text"].includes(kind); }
