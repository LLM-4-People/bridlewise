/** Native replay and dependency grouping, shared by transport and context. */
import { deepFreeze } from "../../kernel/integrity.ts";
import { dependencySpans } from "../dependency-spans.ts";
import type { ContextProjection, ContextTurn, ContextToolCall, UnifiedContextManager } from "../../memory/unified/unified-context-manager.ts";
import type { ChatMessage } from "./config.ts";
import { isPlainObject } from "../type-guards.ts";
import { RESPONSE_ITEM_SCHEMA, responseProtocolError, type ResponseItem } from "./responses.ts";

/** Transcript metadata is authoritative. Display text must never rebuild native history. */
export type ResponseTranscriptMessage = Readonly<{
  role: string; content: string; tool_call_id?: string; tool_calls?: readonly unknown[];
  responseItems?: readonly ResponseItem[];
  responseReplayBlocked?: boolean;
}>;
export function messagesToResponseInput(messages: readonly ResponseTranscriptMessage[]): readonly ResponseItem[] {
  assertResponseReplayUnblocked(messages);
  return projectResponseTranscript(messages);
}

/** Estimation uses the same native projection, including evidence not yet ready to replay. */
export function serializeResponseTranscript(messages: readonly ResponseTranscriptMessage[]): string {
  return JSON.stringify(projectResponseTranscript(messages));
}

function assertResponseReplayUnblocked(messages: readonly ResponseTranscriptMessage[]): void {
  if (messages.some(message => message.responseReplayBlocked)) throw responseProtocolError("responses_history_unready");
}

function projectResponseTranscript(messages: readonly ResponseTranscriptMessage[]): readonly ResponseItem[] {
  const input: ResponseItem[] = [];
  const callers = new Map<string, unknown>();
  const append = (item: ResponseItem): void => {
    input.push(item);
    if (item.type === "function_call" && typeof item.call_id === "string" && item.caller !== undefined) callers.set(item.call_id, item.caller);
  };
  for (const message of messages) {
    if (message.responseItems !== undefined) {
      for (const item of message.responseItems) append(item);
      continue;
    }
    if (message.role === "tool") {
      if (!message.tool_call_id) throw responseProtocolError("responses_tool_result_id_missing");
      const caller = callers.get(message.tool_call_id);
      append({ type: "function_call_output", call_id: message.tool_call_id, output: message.content,
        ...(caller === undefined ? {} : { caller }) });
      continue;
    }
    if (message.content.length > 0 || !message.tool_calls?.length) append({ type: "message", role: message.role, content: message.content });
    for (const raw of message.tool_calls ?? []) {
      if (!isPlainObject(raw) || !isPlainObject(raw.function) || typeof raw.id !== "string" ||
          typeof raw.function.name !== "string" || typeof raw.function.arguments !== "string") throw responseProtocolError("responses_tool_call_malformed");
      append({ type: "function_call", call_id: raw.id, name: raw.function.name, arguments: raw.function.arguments,
        ...(raw.caller === undefined ? {} : { caller: raw.caller }), ...(raw.namespace === undefined ? {} : { namespace: raw.namespace }) });
    }
  }
  return deepFreeze(input);
}

/** Only documented identity roles connect items; equal unrelated IDs do not. */
function transcriptReferences(message: ResponseTranscriptMessage): readonly string[] {
  const references: string[] = [];
  for (const item of projectResponseTranscript([message])) {
    if (typeof item.id === "string" && item.type !== "local_shell_call_output") references.push(`item:${item.id}`);
    if (["function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "computer_call", "computer_call_output",
      "shell_call", "shell_call_output", "apply_patch_call", "apply_patch_call_output", "local_shell_call", "tool_search_call", "tool_search_output",
      "program", "program_output"].includes(item.type) && typeof item.call_id === "string") references.push(`${item.type === "program" || item.type === "program_output" ? "program" : "call"}:${item.call_id}`);
    if (item.type === "local_shell_call_output" && typeof item.id === "string") references.push(`call:${item.id}`);
    if (item.type === "mcp_approval_request" && typeof item.id === "string") references.push(`approval:${item.id}`);
    if ((item.type === "mcp_approval_response" || item.type === "mcp_call") && typeof item.approval_request_id === "string") references.push(`approval:${item.approval_request_id}`);
    if (isPlainObject(item.caller) && item.caller.type === "program" && typeof item.caller.caller_id === "string") references.push(`program:${item.caller.caller_id}`);
  }
  return references;
}

/** Local dependencies form conservative chronological spans, not a protocol adjacency rule. */
export function responseTranscriptGroups(messages: readonly ResponseTranscriptMessage[]): readonly (readonly number[])[] {
  return dependencySpans(messages.map(transcriptReferences));
}

/** Every serializer projects stored tool-call arguments the same way. */
export function projectToolCallArguments(calls: readonly ContextToolCall[], argumentsOf: (call: ContextToolCall) => string): ContextToolCall[] {
  return calls.map(call => ({ ...call, function: { ...call.function, arguments: argumentsOf(call) } }));
}

export function contextTurnMessage(turn: Pick<ContextTurn, "role" | "content" | "toolCalls" | "toolCallId" | "responseItems" | "responseReplayBlocked">,
  argumentsOf: (call: ContextToolCall) => string = call => call.function.arguments,
  contentOf: (content: string) => string = content => content): ChatMessage {
  const role = turn.role === "system" || turn.role === "assistant" || turn.role === "tool" ? turn.role : "user";
  return { role, content: turn.responseItems === undefined ? contentOf(turn.content) : turn.content,
    ...(turn.toolCalls === undefined ? {} : { tool_calls: turn.responseItems === undefined
      ? projectToolCallArguments(turn.toolCalls, argumentsOf) : turn.toolCalls }),
    ...(turn.toolCallId === undefined ? {} : { tool_call_id: turn.toolCallId }),
    ...(turn.responseItems === undefined ? {} : { responseItems: turn.responseItems.map(item => {
      const parsed = RESPONSE_ITEM_SCHEMA.safeParse(item);
      if (!parsed.success) throw responseProtocolError("responses_item_malformed");
      return parsed.data;
    }) }),
    ...(turn.responseReplayBlocked === undefined ? {} : { responseReplayBlocked: turn.responseReplayBlocked }) };
}

function assertContextReplayReady(turns: readonly ContextTurn[]): void {
  const messages = turns.map(turn => contextTurnMessage(turn));
  assertResponseReplayUnblocked(messages);
  // This host binding sends complete manual history. External call outputs
  // need an explicit continuation policy; low-level protocol projection still
  // preserves them for that later planner. Item references remain valid.
  const pending = new Set<string>();
  for (const item of projectResponseTranscript(messages)) {
    if (item.type === "function_call" && typeof item.call_id === "string") {
      if (pending.has(item.call_id)) throw responseProtocolError("responses_history_unready");
      pending.add(item.call_id);
    }
    if (item.type === "function_call_output") {
      if (typeof item.call_id !== "string" || !pending.delete(item.call_id)) throw responseProtocolError("responses_history_unready");
    }
  }
  if (pending.size) throw responseProtocolError("responses_history_unready");
}

/** One protocol projection bound by each host before memory captures any turn. */
const RESPONSE_CONTEXT_PROJECTION: ContextProjection<readonly ChatMessage[]> = Object.freeze({
  project: ({ turns, summaries, argumentsOf, contentOf }) => deepFreeze([
    ...(summaries.length ? [{ role: "system" as const, content: summaries.map(contentOf).join("\n\n") }] : []),
    ...turns.map(turn => contextTurnMessage(turn, argumentsOf, contentOf)),
  ]),
  serialize: serializeResponseTranscript,
  references: turn => transcriptReferences(contextTurnMessage(turn)),
  assertReady: assertContextReplayReady,
});

export function bindResponseContext(cm: UnifiedContextManager): UnifiedContextManager {
  cm.bindProjection(RESPONSE_CONTEXT_PROJECTION);
  return cm;
}

export function projectResponseContext(cm: UnifiedContextManager): readonly ChatMessage[] {
  return cm.project(RESPONSE_CONTEXT_PROJECTION);
}
