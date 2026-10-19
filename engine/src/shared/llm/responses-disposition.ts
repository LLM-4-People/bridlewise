/** Native output describes work; only the host's admitted inventory grants authority. */
import { deepFreeze } from "../../kernel/integrity.ts";
import { isPlainObject } from "../type-guards.ts";
import { LLMError } from "./errors.ts";
import { projectResponse, type ResponseItem, type ResponseResource, type ResponseStatus, type ResponseToolCall } from "./responses.ts";

export type NativeResponseAction = Readonly<{
  outputIndex: number;
  item: ResponseItem;
  kind: "function" | "custom" | "computer" | "local_shell" | "shell" | "apply_patch" | "tool_search" | "approval";
}>;
/** A resolver reads the host's existing manifest; it never executes an action. */
/** Programmatic callers additionally require host-verified retained program provenance. */
export type ResponseActionAdmission = (action: NativeResponseAction) => boolean;
export type ResponseDisposition = Readonly<{
  kind: "final" | "continue" | "actions" | "approval" | "unavailable" | "pending" | "failed" | "cancelled" | "incomplete";
  actions: readonly NativeResponseAction[];
  toolCalls: readonly ResponseToolCall[];
  issues: readonly Readonly<{ outputIndex: number; code: string }>[];
}>;
export type ResponseDispositionOptions = Readonly<{
  /** The exact tool inventory sent, not the provider's echoed response.tools. */
  tools: readonly ResponseItem[];
  toolChoice?: unknown;
  admit: ResponseActionAdmission;
}>;

function findNamedTool(tools: readonly ResponseItem[], item: ResponseItem, type: "function" | "custom"): ResponseItem | undefined {
  if (item.namespace !== undefined) {
    const namespace = tools.find(tool => tool.type === "namespace" && tool.name === item.namespace);
    if (!namespace || !Array.isArray(namespace.tools)) return undefined;
    return namespace.tools.find(tool => isPlainObject(tool) && tool.type === type && tool.name === item.name) as ResponseItem | undefined;
  }
  return tools.find(tool => tool.type === type && tool.name === item.name);
}

function selectionAllows(choice: unknown, item: ResponseItem, kind: NativeResponseAction["kind"], tools: readonly ResponseItem[]): boolean {
  if (choice === undefined || choice === "auto" || choice === "required") return true;
  if (!isPlainObject(choice)) return false;
  if (choice.type === "allowed_tools") return Array.isArray(choice.tools) &&
    choice.tools.some(selector => selectionAllows(selector, item, kind, tools));
  if (choice.type === "programmatic_tool_calling") return isPlainObject(item.caller) && item.caller.type === "program";
  const type = kind === "approval" ? "mcp" : kind;
  if (type === "computer") return ["computer", "computer_use_preview", "computer_use"].includes(String(choice.type)) &&
    tools.some(tool => tool.type === choice.type);
  if (choice.type !== type) return false;
  if (type === "function" || type === "custom") return choice.name === item.name && choice.namespace === item.namespace;
  if (type === "mcp") return choice.server_label === item.server_label && (choice.name == null || choice.name === item.name);
  return true;
}

function allowedCaller(tool: ResponseItem, item: ResponseItem): boolean {
  const caller = item.caller;
  const mode = caller == null || isPlainObject(caller) && caller.type === "direct" ? "direct"
    : isPlainObject(caller) && caller.type === "program" && typeof caller.caller_id === "string" && caller.caller_id.length > 0
      ? "programmatic" : undefined;
  return mode !== undefined && (tool.allowed_callers == null ? mode === "direct"
    : Array.isArray(tool.allowed_callers) && tool.allowed_callers.includes(mode));
}

/** Inspect the entire completed batch before any caller is allowed to dispatch. */
export function inspectResponseDisposition(
  response: ResponseResource,
  status: ResponseStatus | undefined,
  options: ResponseDispositionOptions,
): ResponseDisposition {
  if (status !== "completed") {
    const kind = status === "failed" || status === "cancelled" || status === "incomplete" ? status : "pending";
    return deepFreeze({ kind, actions: [], toolCalls: [], issues: [] });
  }
  const actions: NativeResponseAction[] = [];
  const issues: { outputIndex: number; code: string }[] = [];
  const callIds = new Set<string>();
  let finalMessage = false;
  let continuation = false;
  const issue = (outputIndex: number, code: string): void => { issues.push({ outputIndex, code }); };
  const action = (outputIndex: number, item: ResponseItem, kind: NativeResponseAction["kind"], declared: boolean): void => {
    const pending = deepFreeze({ outputIndex, item, kind });
    actions.push(pending);
    if (typeof item.call_id === "string") {
      if (callIds.has(item.call_id)) issue(outputIndex, "native_action_identity_duplicate");
      callIds.add(item.call_id);
    }
    if (!declared || !selectionAllows(options.toolChoice, item, kind, options.tools)) issue(outputIndex, "native_action_not_authorized");
    else if (!options.admit(pending)) issue(outputIndex, "native_action_handler_unavailable");
  };
  const declared = (type: string): ResponseItem | undefined => options.tools.find(tool => tool.type === type);
  for (const [index, item] of response.output.entries()) {
    switch (item.type) {
      case "message":
        if (item.phase === "commentary") continuation = true;
        else if (item.phase == null || item.phase === "final_answer") finalMessage = true;
        else issue(index, "native_message_phase_unavailable");
        break;
      case "function_call": {
        const tool = findNamedTool(options.tools, item, "function");
        if (item.status !== undefined && item.status !== "completed") {
          issue(index, "native_action_incomplete");
          break;
        }
        action(index, item, "function", tool !== undefined && allowedCaller(tool, item));
        break;
      }
      case "custom_tool_call": {
        const tool = findNamedTool(options.tools, item, "custom");
        action(index, item, "custom", tool !== undefined && allowedCaller(tool, item));
        break;
      }
      case "computer_call": action(index, item, "computer", !!(declared("computer") ?? declared("computer_use_preview") ?? declared("computer_use"))); break;
      case "local_shell_call": action(index, item, "local_shell", !!declared("local_shell")); break;
      case "apply_patch_call": {
        const tool = declared("apply_patch");
        action(index, item, "apply_patch", tool !== undefined && allowedCaller(tool, item));
        break;
      }
      case "shell_call": {
        const tool = declared("shell");
        const environment = tool?.environment;
        if (isPlainObject(environment) && ["container_auto", "container_reference"].includes(String(environment.type))) break;
        action(index, item, "shell", tool !== undefined && allowedCaller(tool, item) && isPlainObject(environment) && environment.type === "local");
        break;
      }
      case "tool_search_call":
        if (item.execution === "server") break;
        if (item.execution !== "client" || typeof item.call_id !== "string" || !item.call_id) {
          issue(index, "native_tool_search_execution_unavailable");
          break;
        }
        action(index, item, "tool_search", declared("tool_search")?.execution === "client");
        break;
      case "mcp_approval_request":
        action(index, item, "approval", options.tools.some(tool => tool.type === "mcp" && tool.server_label === item.server_label));
        break;
      case "program": case "program_output": continuation = true; break;
      case "reasoning": case "compaction":
      case "web_search_call": case "file_search_call": case "image_generation_call": case "code_interpreter_call":
      case "mcp_call": case "mcp_list_tools": case "tool_search_output": case "shell_call_output":
        break;
      default: issue(index, "native_output_disposition_unavailable");
    }
  }
  const kind = issues.length ? "unavailable" : actions.some(value => value.kind === "approval") ? "approval"
    : actions.length ? "actions" : continuation && !finalMessage ? "continue" : "final";
  return deepFreeze({ kind, actions, issues,
    toolCalls: issues.length || kind === "approval" ? [] : projectResponse(response, status).toolCalls });
}

export function assertResponseDispositionAvailable(disposition: ResponseDisposition): void {
  const issue = disposition.issues[0];
  if (issue) throw new LLMError("Response requires an unavailable or unauthorized native action", issue.code,
    "invalid-response", false, { outputIndex: issue.outputIndex });
  if (disposition.kind === "approval") throw new LLMError("Response requires a trusted approval decision",
    "native_approval_required", "invalid-response", false);
  if (disposition.kind === "pending") throw new LLMError("Response has no completed terminal outcome",
    "native_response_pending", "invalid-response", false);
}
