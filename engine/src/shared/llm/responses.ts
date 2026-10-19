/** Responses wire contracts. Unknown JSON fields survive projection and replay.
 * Spec and provider evidence: research/responses-api/contract.md.
 */
import { z } from "zod";
import { deepFreeze } from "../../kernel/integrity.ts";
import { isPlainObject } from "../type-guards.ts";
import { InvalidResponseError } from "./errors.ts";

const json = z.json();
const object = z.record(z.string(), json);
const string = z.string().min(1);
const count = z.number().int().nonnegative().safe();
const nullableBoolean = z.boolean().nullable().optional();
const nullableString = z.string().nullable().optional();

export const RESPONSE_STATUS_SCHEMA = z.enum(["completed", "failed", "in_progress", "cancelled", "queued", "incomplete"]);
export type ResponseStatus = z.infer<typeof RESPONSE_STATUS_SCHEMA>;
export type ResponseItem = Readonly<Record<string, unknown> & { type: string }>;
export const RESPONSE_ITEM_SCHEMA = z.object({ type: string }).catchall(json);
/**
 * The spec's identifier grammar, ONE owner: a function or custom tool name is
 * 1-128 of `[A-Za-z0-9_-]`; a namespace and a `text.format` json_schema name
 * are the same alphabet at 1-64. Every name the harness sends is checked
 * against these, and the MCP naming owner mints names that pass them.
 */
const RESPONSES_NAME_ALPHABET = "[A-Za-z0-9_-]";
export const RESPONSES_FUNCTION_NAME_MAX_CHARACTERS = 128;
const RESPONSES_SHORT_NAME_MAX_CHARACTERS = 64;
function responsesNamePattern(maxCharacters: number): RegExp {
  return new RegExp(`^${RESPONSES_NAME_ALPHABET}{1,${maxCharacters}}$`, "u");
}
export const FUNCTION_NAME_PATTERN = responsesNamePattern(RESPONSES_FUNCTION_NAME_MAX_CHARACTERS);
const SHORT_NAME_PATTERN = responsesNamePattern(RESPONSES_SHORT_NAME_MAX_CHARACTERS);
/** The Responses protocol's native MCP item discriminants: wire vocabulary, not harness error codes. */
export const RESPONSE_MCP_ITEM_TYPES = Object.freeze(["mcp_list_tools", "mcp_call", "mcp_approval_request", "mcp_approval_response"] as const);

/** Operational options; the content admission/client owns model, input, stream. */
const requestControlsSchema = z.object({
  messages: z.never().optional(), max_tokens: z.never().optional(), response_format: z.never().optional(),
  access_programs: z.strictObject({ cyber: z.enum(["standard", "daybreak_blue", "daybreak_red"]).optional() }).optional(),
  background: nullableBoolean,
  context_management: z.array(z.object({
    type: string, compact_threshold: z.number().int().min(1000).nullable().optional(),
  }).catchall(json)).min(1).nullable().optional(),
  conversation: z.union([string, z.object({ id: string }).catchall(json)]).nullable().optional(),
  include: z.array(string).nullable().optional(),
  instructions: nullableString,
  max_output_tokens: z.number().int().min(16).nullable().optional(),
  max_tool_calls: count.nullable().optional(),
  metadata: z.record(z.string().max(64), z.string().max(512))
    .refine((value) => Object.keys(value).length <= 16, "Metadata permits at most 16 entries").nullable().optional(),
  moderation: z.object({ model: string, policy: object.nullable().optional() }).catchall(json).nullable().optional(),
  parallel_tool_calls: nullableBoolean,
  previous_response_id: nullableString,
  prompt: z.object({ id: string, variables: object.nullable().optional(), version: nullableString }).catchall(json).nullable().optional(),
  prompt_cache_key: nullableString,
  prompt_cache_options: z.object({
    comparison_response_id: nullableString, mode: z.enum(["implicit", "explicit"]).optional(),
    prewarm: z.boolean().optional(), ttl: z.literal("30m").optional(),
  }).catchall(json).optional(),
  prompt_cache_retention: z.enum(["in_memory", "24h"]).nullable().optional(),
  reasoning: z.object({
    context: z.enum(["auto", "current_turn", "all_turns"]).nullable().optional(),
    effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).nullable().optional(),
    mode: string.optional(), summary: z.enum(["auto", "concise", "detailed"]).nullable().optional(),
  }).catchall(json).nullable().optional(),
  safety_identifier: z.string().max(64).nullable().optional(),
  service_tier: z.enum(["auto", "default", "flex", "scale", "priority", "fast", "ultrafast"]).nullable().optional(),
  store: nullableBoolean,
  stream_options: z.object({ include_obfuscation: z.boolean().optional(), include_usage: z.never().optional() }).catchall(json).nullable().optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  text: z.object({
    format: z.union([
      z.object({ type: z.enum(["text", "json_object"]) }).catchall(json),
      z.object({ type: z.literal("json_schema"), name: z.string().regex(SHORT_NAME_PATTERN), schema: object,
        description: z.string().optional(), strict: nullableBoolean }).catchall(json),
    ]).optional(), verbosity: z.enum(["low", "medium", "high"]).nullable().optional(),
  }).catchall(json).optional(),
  tool_choice: z.union([z.enum(["auto", "none", "required"]), RESPONSE_ITEM_SCHEMA]).optional(),
  tools: z.array(RESPONSE_ITEM_SCHEMA).optional(),
  top_logprobs: z.number().int().min(0).max(20).nullable().optional(),
  top_p: z.number().min(0).max(1).nullable().optional(),
  truncation: z.enum(["auto", "disabled"]).nullable().optional(),
}).catchall(json);
function validateConversation(value: { conversation?: unknown; previous_response_id?: unknown }, context: z.RefinementCtx): void {
  if (value.conversation != null && value.previous_response_id != null) {
    context.addIssue({ code: "custom", path: ["previous_response_id"], message: "conversation and previous_response_id are mutually exclusive" });
  }
}
export const RESPONSES_REQUEST_OPTIONS_SCHEMA = requestControlsSchema.extend({
  model: z.never().optional(), input: z.never().optional(), stream: z.never().optional(),
}).superRefine(validateConversation);
/** Defaults cannot carry request history, method mode, or executable tool authority.
 * Instructions and metadata retain their ordinary caller/host ownership. */
export const RESPONSES_DEFAULTS_SCHEMA = requestControlsSchema.extend({
  model: z.never().optional(), input: z.never().optional(), stream: z.never().optional(),
  previous_response_id: z.never().optional(), conversation: z.never().optional(), tools: z.never().optional(),
});
export type ResponsesDefaults = Readonly<z.infer<typeof RESPONSES_DEFAULTS_SCHEMA>>;
export type ResponsesRequestOptions = Readonly<z.infer<typeof RESPONSES_REQUEST_OPTIONS_SCHEMA>>;
/** Full native content admission uses the same controls as per-provider options. */
export const RESPONSE_INPUT_ITEM_SCHEMA = z.union([
  RESPONSE_ITEM_SCHEMA,
  z.object({ role: z.enum(["user", "assistant", "system", "developer"]),
    content: z.union([z.string(), z.array(RESPONSE_ITEM_SCHEMA)]) }).catchall(json),
  z.object({ id: string, type: z.literal("item_reference").nullable().optional() }).catchall(json),
]);
export const RESPONSES_REQUEST_SCHEMA = requestControlsSchema.extend({
  model: string.optional(), input: z.union([z.string(), z.array(RESPONSE_INPUT_ITEM_SCHEMA)]).optional(),
  stream: nullableBoolean,
}).superRefine(validateConversation);
export type ResponsesRequest = Readonly<z.infer<typeof RESPONSES_REQUEST_SCHEMA>>;

export const RESPONSE_USAGE_SCHEMA = z.object({
  input_tokens: count, output_tokens: count, total_tokens: count,
  input_tokens_details: z.object({ cached_tokens: count.optional(), cache_write_tokens: count.optional() }).catchall(json).optional(),
  output_tokens_details: z.object({ reasoning_tokens: count.optional() }).catchall(json).optional(),
}).catchall(json).superRefine((usage, context) => {
  if (usage.total_tokens !== usage.input_tokens + usage.output_tokens) {
    context.addIssue({ code: "custom", message: "Usage totals are inconsistent" });
  }
  if ((usage.input_tokens_details?.cached_tokens ?? 0) > usage.input_tokens ||
      (usage.output_tokens_details?.reasoning_tokens ?? 0) > usage.output_tokens) {
    context.addIssue({ code: "custom", message: "Usage details exceed their totals" });
  }
});
export type ResponseUsage = Readonly<z.infer<typeof RESPONSE_USAGE_SCHEMA>>;
/** Observation may retain declared telemetry, never arbitrary JSON extension fields. */
export function isResponseUsageValue(path: readonly (string | number)[], value: unknown): boolean {
  let schema: z.ZodType = RESPONSE_USAGE_SCHEMA;
  for (const key of path) {
    while (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) schema = schema.unwrap() as z.ZodType;
    if (!(schema instanceof z.ZodObject) || typeof key !== "string" || !Object.hasOwn(schema.shape, key)) return false;
    schema = schema.shape[key];
  }
  return schema.safeParse(value).success;
}
const resourceSchema = z.object({
  id: string, object: z.literal("response"), model: string,
  output: z.array(RESPONSE_ITEM_SCHEMA), status: RESPONSE_STATUS_SCHEMA.optional(),
  usage: RESPONSE_USAGE_SCHEMA.nullable().optional(), error: object.nullable().optional(),
  incomplete_details: object.nullable().optional(),
}).catchall(json);
export type ResponseResource = Readonly<Record<string, unknown> & {
  id: string; object: "response"; model: string; output: readonly ResponseItem[];
  status?: ResponseStatus | undefined; usage?: ResponseUsage | null | undefined;
  error?: Readonly<Record<string, unknown>> | null | undefined;
  incomplete_details?: Readonly<Record<string, unknown>> | null | undefined;
}>;
export type ProjectedUsage = Readonly<{
  promptTokens: number; completionTokens: number; totalTokens: number;
  cachedInputTokens?: number; reasoningTokens?: number; cacheWriteTokens?: number;
}>;
export type ResponseToolCall = Readonly<{
  id: string; type: "function"; function: Readonly<{ name: string; arguments: string }>;
  caller?: unknown; namespace?: string;
}>;
export type ResponseProjection = Readonly<{
  content: string; refusal: string; reasoning: string; toolCalls: readonly ResponseToolCall[];
  usage: ProjectedUsage | undefined; finishReason: string; truncated: boolean;
  model: string; response: ResponseResource;
}>;

/** Shared protocol refusal; no prompt/provider error text enters diagnostics. */
export function responseProtocolError(code: string): InvalidResponseError {
  return new InvalidResponseError(`Invalid Responses protocol: ${code}`, { protocolCode: code });
}

export function parseResponseItem(raw: unknown): ResponseItem {
  const result = RESPONSE_ITEM_SCHEMA.safeParse(raw);
  if (!result.success) throw responseProtocolError("responses_item_malformed");
  const item = result.data;
  if (item.id !== undefined && (typeof item.id !== "string" || item.id.length === 0)) throw responseProtocolError("responses_item_malformed");
  if (["message", "reasoning", "function_call"].includes(item.type) && item.status !== undefined &&
      !["in_progress", "completed", "incomplete"].includes(String(item.status))) throw responseProtocolError("responses_item_malformed");
  if (item.type === "message") {
    if (item.role !== "assistant" || !Array.isArray(item.content)) throw responseProtocolError("responses_item_malformed");
    for (const part of item.content) {
      if (!isPlainObject(part) || typeof part.type !== "string") throw responseProtocolError("responses_content_part_invalid");
      if (part.type === "output_text" && typeof part.text !== "string" || part.type === "refusal" && typeof part.refusal !== "string") {
        throw responseProtocolError("responses_content_part_invalid");
      }
    }
  }
  if (item.type === "function_call" &&
      (typeof item.call_id !== "string" || !item.call_id || typeof item.name !== "string" || !item.name || typeof item.arguments !== "string")) {
    throw responseProtocolError("responses_item_malformed");
  }
  if (item.type === "reasoning") {
    if (!Array.isArray(item.summary) || item.content !== undefined && !Array.isArray(item.content)) throw responseProtocolError("responses_item_malformed");
    for (const part of [...item.summary, ...(Array.isArray(item.content) ? item.content : [])]) {
      if (!isPlainObject(part) || typeof part.type !== "string" ||
          ["summary_text", "reasoning_text"].includes(part.type) && typeof part.text !== "string") throw responseProtocolError("responses_item_malformed");
    }
  }
  return deepFreeze(item);
}

export function parseResponseResource(raw: unknown): ResponseResource {
  const result = resourceSchema.safeParse(raw);
  if (!result.success) throw responseProtocolError("responses_resource_malformed");
  const output = result.data.output.map(parseResponseItem);
  const ids = output.flatMap((item) => typeof item.id === "string" ? [item.id] : []);
  if (new Set(ids).size !== ids.length) throw responseProtocolError("responses_item_identity_duplicate");
  const calls = output.filter((item) => item.type === "function_call").map((item) => item.call_id);
  if (new Set(calls).size !== calls.length) throw responseProtocolError("tool_call_start_duplicate");
  return deepFreeze({ ...result.data, output });
}

export function projectResponseUsage(usage: ResponseUsage | null | undefined): ProjectedUsage | undefined {
  if (usage == null) return undefined;
  const cached = usage.input_tokens_details?.cached_tokens;
  const reasoning = usage.output_tokens_details?.reasoning_tokens;
  const written = usage.input_tokens_details?.cache_write_tokens;
  return Object.freeze({ promptTokens: usage.input_tokens, completionTokens: usage.output_tokens, totalTokens: usage.total_tokens,
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    ...(written === undefined ? {} : { cacheWriteTokens: written }),
  });
}

export function projectResponse(response: ResponseResource, terminalStatus: ResponseStatus | undefined = response.status): ResponseProjection {
  let content = ""; let refusal = ""; let reasoning = "";
  const toolCalls: ResponseToolCall[] = [];
  for (const item of response.output) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (isPlainObject(part) && part.type === "output_text") content += String(part.text);
        if (isPlainObject(part) && part.type === "refusal") refusal += String(part.refusal);
      }
    }
    if (item.type === "reasoning" && Array.isArray(item.summary)) {
      for (const part of item.summary) if (isPlainObject(part) && typeof part.text === "string") reasoning += part.text;
    }
    if (item.type === "function_call" && terminalStatus === "completed" && (item.status === undefined || item.status === "completed")) {
      toolCalls.push({ id: String(item.call_id), type: "function", function: { name: String(item.name), arguments: String(item.arguments) },
        ...(item.caller === undefined ? {} : { caller: item.caller }),
        ...(typeof item.namespace === "string" ? { namespace: item.namespace } : {}),
      });
    }
  }
  const reason = response.incomplete_details?.reason;
  const finishReason = terminalStatus === "completed" ? (toolCalls.length ? "tool_calls" : "stop")
    : terminalStatus === "incomplete" ? (reason === "max_output_tokens" ? "length" : typeof reason === "string" ? reason : "unknown")
      : terminalStatus ?? "unknown";
  return deepFreeze({ content, refusal, reasoning, toolCalls, usage: projectResponseUsage(response.usage),
    finishReason, truncated: terminalStatus === "incomplete" && reason === "max_output_tokens", model: response.model, response });
}


/**
 * Project registered tools onto the Responses `tools` array. Existing
 * registered schemas retain optional properties: opt out of auto-strict.
 * Names are VALIDATED, never rewritten: a name outside the spec grammar
 * refuses here (fail closed) rather than reaching a provider that may or may
 * not accept it. The one place a harness name is minted from foreign input
 * (an MCP server's tool) is the MCP naming owner, which mints legal names.
 */
export function toolsToResponses(tools: readonly unknown[]): readonly ResponseItem[] {
  return deepFreeze(tools.map((raw) => {
    if (!isPlainObject(raw) || typeof raw.type !== "string") throw responseProtocolError("responses_tool_malformed");
    const { function: nested, ...rest } = raw;
    const tool = raw.type === "function" && isPlainObject(nested) ? { ...rest, ...nested } : { ...raw };
    if (tool.type === "function" && tool.strict === undefined) tool.strict = false;
    if ((tool.type === "function" || tool.type === "custom") && (typeof tool.name !== "string" || !FUNCTION_NAME_PATTERN.test(tool.name))) {
      throw responseProtocolError("responses_tool_name_invalid");
    }
    if (tool.type === "namespace" && (typeof tool.name !== "string" || !SHORT_NAME_PATTERN.test(tool.name))) {
      throw responseProtocolError("responses_tool_name_invalid");
    }
    const parsed = RESPONSE_ITEM_SCHEMA.safeParse(tool);
    if (!parsed.success) throw responseProtocolError("responses_tool_malformed");
    return parsed.data;
  }));
}
