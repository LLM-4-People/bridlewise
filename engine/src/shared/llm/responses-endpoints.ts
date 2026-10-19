/** Endpoint-specific Responses admissions. Shared fields come from create. */
import { z } from "zod";
import type { DeepReadonly } from "../../kernel/integrity.ts";
import { RESPONSES_REQUEST_SCHEMA, RESPONSE_INPUT_ITEM_SCHEMA, RESPONSE_USAGE_SCHEMA, responseProtocolError, type ResponseItem, type ResponseUsage } from "./responses.ts";

const field = RESPONSES_REQUEST_SCHEMA.shape;
const input = z.union([z.string(), z.array(RESPONSE_INPUT_ITEM_SCHEMA)]).nullable().optional();
// Endpoint limits count Unicode code points, without changing the wire string.
const endpointText64 = z.string().refine(value => {
  let count = 0;
  for (const _point of value) if (++count > 64) return false;
  return true;
}, "Must contain at most 64 Unicode code points");
const RESPONSE_COMPACT_REQUEST_SCHEMA = z.object({
  model: z.string().min(1).nullable(), input, instructions: field.instructions,
  previous_response_id: field.previous_response_id, prompt_cache_key: endpointText64.nullable().optional(),
  prompt_cache_options: field.prompt_cache_options.nullable(),
  prompt_cache_retention: field.prompt_cache_retention, service_tier: z.enum(["auto", "default", "fast", "flex", "priority"]).nullable().optional(),
}).catchall(z.json());
export const RESPONSE_INPUT_TOKENS_REQUEST_SCHEMA = z.object({
  model: z.string().min(1).nullable().optional(), input, conversation: field.conversation,
  instructions: field.instructions, parallel_tool_calls: field.parallel_tool_calls,
  previous_response_id: field.previous_response_id, reasoning: field.reasoning,
  text: field.text.nullable(), tool_choice: field.tool_choice.nullable(), tools: field.tools.nullable(),
  truncation: z.enum(["auto", "disabled"]).optional(), personality: endpointText64.optional(),
}).catchall(z.json()).superRefine((value, context) => {
  if (value.conversation != null && value.previous_response_id != null) {
    context.addIssue({ code: "custom", path: ["previous_response_id"], message: "conversation and previous_response_id are mutually exclusive" });
  }
});
export const RESPONSE_REQUEST_SCHEMAS = Object.freeze({
  create: RESPONSES_REQUEST_SCHEMA, compact: RESPONSE_COMPACT_REQUEST_SCHEMA, input_tokens: RESPONSE_INPUT_TOKENS_REQUEST_SCHEMA,
});
export type ResponseOperation = keyof typeof RESPONSE_REQUEST_SCHEMAS;
type KnownFields<T> = { [Key in keyof T as string extends Key ? never : Key]: T[Key] };
type RequestFields<Operation extends ResponseOperation> = z.infer<(typeof RESPONSE_REQUEST_SCHEMAS)[Operation]>;
/** Native carrier accepts immutable history; runtime admission validates every opaque item/extension. */
export type ResponseRequestFor<Operation extends ResponseOperation> = Readonly<Record<string, unknown>> &
  DeepReadonly<Omit<KnownFields<RequestFields<Operation>>, "input" | "tools">> & Readonly<{
    input?: Extract<RequestFields<Operation>["input"], string | null> | readonly Readonly<Record<string, unknown>>[];
    tools?: readonly ResponseItem[] | Extract<RequestFields<Operation>["tools"], null>;
  }>;
export const RESPONSE_QUERY_SCHEMAS = Object.freeze({
  retrieve: z.strictObject({include:z.array(z.string()).optional(), include_obfuscation:z.boolean().optional()}),
  input_items: z.strictObject({after:z.string().optional(), include:z.array(z.string()).optional(), limit:z.number().int().min(1).max(100).optional(), order:z.enum(["asc","desc"]).optional()}),
});
export type ResponseQueryFor<Kind extends keyof typeof RESPONSE_QUERY_SCHEMAS> = DeepReadonly<z.infer<(typeof RESPONSE_QUERY_SCHEMAS)[Kind]>>;
export type ResponseCompaction = Readonly<Record<string, unknown> & {
  id: string; object: "response.compaction"; created_at: number; output: readonly ResponseItem[]; usage: ResponseUsage;
}>;
export type ResponseInputTokenCount = Readonly<Record<string, unknown> & { object: "response.input_tokens"; input_tokens: number }>;
export type ResponseInputItemPage = Readonly<Record<string, unknown> & {
  object: "list"; data: readonly ResponseItem[]; first_id: string | null; last_id: string | null; has_more: boolean;
}>;
export type ResponseDeletion = Readonly<Record<string, unknown> & { id: string; object: "response"; deleted: true }>;

const resourceSchemas = {
  compact: z.object({ id: z.string().min(1), object: z.literal("response.compaction"), created_at: z.number().nonnegative(),
    output: z.array(RESPONSE_INPUT_ITEM_SCHEMA), usage: RESPONSE_USAGE_SCHEMA }).catchall(z.json()),
  input_tokens: z.object({ object: z.literal("response.input_tokens"), input_tokens: z.number().int().nonnegative().safe() }).catchall(z.json()),
  input_items: z.object({ object: z.literal("list"), data: z.array(RESPONSE_INPUT_ITEM_SCHEMA),
    first_id: z.string().nullable(), last_id: z.string().nullable(), has_more: z.boolean() }).catchall(z.json()),
  delete: z.object({ id: z.string().min(1), object: z.literal("response"), deleted: z.literal(true) }).catchall(z.json()),
};
export function parseResponseEndpointResource(kind: keyof typeof resourceSchemas, value: unknown): Record<string, unknown> {
  const parsed = resourceSchemas[kind].safeParse(value);
  if (!parsed.success) throw responseProtocolError(`responses_${kind}_malformed`);
  return parsed.data;
}
