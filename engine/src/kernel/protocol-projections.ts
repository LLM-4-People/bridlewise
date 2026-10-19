import { z } from "zod";

import {
  HARNESS_TOOL_CONTROL_SCHEMA,
  MODEL_REQUEST_SCHEMA,
  MODEL_TOOL_SCHEMA,
  RAW_METADATA_ENVELOPE_SCHEMA,
  TOOL_CONTRACT_SCHEMA,
  TOOL_RESULT_SCHEMA,
  TRANSPORT_CONTRACT_SCHEMA,
  type ContractSettings,
  type HarnessToolControl,
  type ModelRequest,
  type ModelTool,
  type RawMetadataEnvelope,
  type ToolContract,
  type ToolResult,
} from "./contracts.ts";
import { InputError } from "./errors.ts";
import { canonicalJson, deepFreeze } from "./integrity.ts";
import { escapePointer } from "../shared/json-pointer.ts";
import { requireObject, type JsonObject } from "../shared/type-guards.ts";
import { assertToolSchemaSubset } from "./schema-subset.ts";
import { ROOT_POLICY } from "./root-policy.ts";

const PROTOCOL_RESPONSES = ROOT_POLICY.contracts.protocolIds[0] as "openai-responses";
const PROTOCOL_CHAT_COMPLETIONS = ROOT_POLICY.contracts.protocolIds[1] as "openai-chat-completions";
const PROTOCOL_MCP = ROOT_POLICY.contracts.protocolIds[2] as "mcp-2025-11-25";

export const PROTOCOL_PROJECTION_REVISION = "openai-mcp-projections/v2";

export type ProtocolProjection = Readonly<{
  transport: Readonly<z.infer<typeof TRANSPORT_CONTRACT_SCHEMA>>;
  body: Readonly<JsonObject>;
}>;

export type ImportedValue<T> = Readonly<{
  value: T;
  metadata?: RawMetadataEnvelope;
  losses: readonly string[];
}>;

export type McpResponseId = string | number;

export class McpJsonRpcError extends InputError {
  readonly protocolCode: number;
  readonly responseId: McpResponseId | undefined;
  readonly metadata: RawMetadataEnvelope;

  constructor(protocolCode: number, responseId: McpResponseId | undefined, error: JsonObject) {
    super("MCP returned a protocol-level JSON-RPC error", "mcp_jsonrpc_error");
    this.protocolCode = protocolCode;
    this.responseId = responseId;
    this.metadata = metadataEnvelope(PROTOCOL_MCP, { error });
  }
}

export function projectOpenAIChat(requestInput: ModelRequest, settings: ContractSettings): ProtocolProjection {
  const request = validateRequest(requestInput, settings);
  const body: JsonObject = {
    model: request.model,
    messages: request.messages.map((message) => message.role === "tool"
      ? { role: "tool", content: message.content, tool_call_id: message.toolCallId }
      : { role: message.role, content: message.content }),
    stream: request.stream,
    tool_choice: request.toolChoice,
  };
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({ type: "function", function: projectChatFunction(tool, settings) }));
    body.parallel_tool_calls = request.parallelToolCalls;
  }
  if (request.stream) body.stream_options = { include_usage: true };
  if (request.maxOutputTokens !== undefined) body.max_completion_tokens = request.maxOutputTokens;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.reasoningEffort !== undefined) body.reasoning_effort = request.reasoningEffort;
  return deepFreeze({
    transport: TRANSPORT_CONTRACT_SCHEMA.parse({
      protocol: PROTOCOL_CHAT_COMPLETIONS,
      method: "POST",
      path: settings.endpoints.chatCompletions,
      framing: request.stream ? "sse" : "json",
      stream: request.stream,
      executionAuthorized: false,
    }),
    body,
  });
}

export function projectOpenAIResponses(requestInput: ModelRequest, settings: ContractSettings): ProtocolProjection {
  const request = validateRequest(requestInput, settings);
  const body: JsonObject = {
    model: request.model,
    input: request.messages.map((message) => message.role === "tool"
      ? { type: "function_call_output", call_id: message.toolCallId, output: message.content }
      : { type: "message", role: message.role, content: message.content }),
    parallel_tool_calls: request.parallelToolCalls,
    store: settings.responsesStore,
    stream: request.stream,
    tool_choice: request.toolChoice,
  };
  if (request.tools.length > 0) body.tools = request.tools.map((tool) => projectResponseFunction(tool, settings));
  if (request.maxOutputTokens !== undefined) body.max_output_tokens = request.maxOutputTokens;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.reasoningEffort !== undefined) body.reasoning = { effort: request.reasoningEffort };
  return deepFreeze({
    transport: TRANSPORT_CONTRACT_SCHEMA.parse({
      protocol: PROTOCOL_RESPONSES,
      method: "POST",
      path: settings.endpoints.responses,
      framing: request.stream ? "sse" : "json",
      stream: request.stream,
      executionAuthorized: false,
    }),
    body,
  });
}

export function projectMcpToolsList(
  tools: readonly ToolContract[],
  settings: ContractSettings,
): Readonly<{ tools: readonly JsonObject[] }> {
  if (tools.length > settings.limits.maximumTools) {
    throw new InputError("Tool count exceeds the configured contract limit", "tool_count_exceeded");
  }
  const contracts = tools.map((tool) => validateToolContract(tool));
  if (new Set(contracts.map((tool) => tool.model.name)).size !== contracts.length) {
    throw new InputError("Tool names must be unique", "tool_contract_inconsistent");
  }
  for (const tool of contracts) assertToolWithinSettings(tool, settings);
  return deepFreeze({ tools: contracts.map(projectValidatedMcpTool) });
}

export function projectMcpTool(tool: ToolContract, settings: ContractSettings): Readonly<JsonObject> {
  const contract = validateToolContract(tool);
  assertToolWithinSettings(contract, settings);
  return deepFreeze(projectValidatedMcpTool(contract));
}

function projectValidatedMcpTool(contract: ToolContract): JsonObject {
  const model = contract.model;
  const projected: JsonObject = {
    name: model.name,
    inputSchema: model.inputSchema,
  };
  if (model.description !== undefined) projected.description = model.description;
  if (model.outputSchema !== undefined) projected.outputSchema = model.outputSchema;
  return projected;
}

export function projectMcpToolResult(resultInput: ToolResult): Readonly<JsonObject> {
  const result = TOOL_RESULT_SCHEMA.parse(resultInput);
  const content: JsonObject[] = [];
  if (result.text !== undefined) content.push({ type: "text", text: result.text });
  if (result.structured !== undefined && result.text === undefined) {
    content.push({ type: "text", text: canonicalJson(result.structured) });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  return deepFreeze({
    content,
    ...(result.structured === undefined ? {} : { structuredContent: result.structured }),
    isError: result.isError,
  });
}

export function importMcpToolsList(
  raw: unknown,
  settings: ContractSettings,
  expectedResponseId?: McpResponseId,
): ImportedValue<readonly ModelTool[]> {
  const { result } = unwrapMcpResult(raw, "mcp_tools_list_invalid", expectedResponseId);
  if (!Array.isArray(result.tools) || result.tools.length > settings.limits.maximumTools) {
    throw new InputError("MCP tools list is invalid", "mcp_tools_list_invalid");
  }
  const unknown: JsonObject = {};
  collectUnknown(result, new Set(["_meta", "nextCursor", "tools"]), "$/result", unknown);
  if (result._meta !== undefined) unknown["$/result/_meta"] = result._meta;
  if (result.nextCursor !== undefined) unknown["$/result/nextCursor"] = result.nextCursor;
  const tools = result.tools.map((entry, index) => importMcpTool(entry, index, settings, unknown));
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
    throw new InputError("MCP tool names must be unique", "mcp_tool_duplicate");
  }
  return imported(tools, PROTOCOL_MCP, unknown, []);
}

export function importMcpToolResult(
  raw: unknown,
  callId: string,
  settings: ContractSettings,
  expectedResponseId?: McpResponseId,
): ImportedValue<ToolResult> {
  const { result } = unwrapMcpResult(raw, "mcp_tool_result_invalid", expectedResponseId);
  if (!Array.isArray(result.content)) throw new InputError("MCP tool result is invalid", "mcp_tool_result_invalid");
  if (result.isError !== undefined && typeof result.isError !== "boolean") {
    throw new InputError("MCP tool result error flag is invalid", "mcp_tool_result_invalid");
  }
  const unknown: JsonObject = {};
  const losses: string[] = [];
  collectUnknown(result, new Set(["_meta", "content", "isError", "structuredContent"]), "$/result", unknown);
  if (result._meta !== undefined) unknown["$/result/_meta"] = result._meta;
  const text: string[] = [];
  for (const [index, block] of result.content.entries()) {
    const content = requireObject(block, "mcp_tool_result_invalid");
    if (content.type === "text" && typeof content.text === "string") {
      text.push(content.text);
      collectUnknown(content, new Set(["_meta", "annotations", "text", "type"]), `$/result/content/${index}`, unknown);
      if (content._meta !== undefined) unknown[`$/result/content/${index}/_meta`] = content._meta;
      if (content.annotations !== undefined) unknown[`$/result/content/${index}/annotations`] = content.annotations;
    } else {
      unknown[`$/result/content/${index}`] = content;
      losses.push("mcp_content_block_not_canonicalized");
    }
  }
  const structured = result.structuredContent === undefined
    ? undefined
    : requireObject(result.structuredContent, "mcp_tool_result_invalid");
  const value = TOOL_RESULT_SCHEMA.parse({
    callId,
    ...(text.length === 0 ? {} : { text: text.join("\n") }),
    ...(structured === undefined ? {} : { structured }),
    isError: result.isError === true,
    ...(Object.keys(unknown).length === 0 ? {} : { metadata: metadataEnvelope(PROTOCOL_MCP, unknown) }),
  });
  if (losses.length > settings.limits.maximumLosses) {
    throw new InputError("MCP tool result loss count exceeds the configured limit", "loss_limit_exceeded");
  }
  return deepFreeze({ value, losses, ...(value.metadata === undefined ? {} : { metadata: value.metadata }) });
}

export function bindHarnessControl(modelTool: ModelTool, controlInput: HarnessToolControl): ToolContract {
  return deepFreeze(validateToolContract({
    model: MODEL_TOOL_SCHEMA.parse(modelTool),
    control: HARNESS_TOOL_CONTROL_SCHEMA.parse(controlInput),
  }));
}

export function metadataEnvelope(
  sourceProtocol: "openai-responses" | "openai-chat-completions" | "mcp-2025-11-25",
  raw: JsonObject,
): RawMetadataEnvelope {
  return deepFreeze(RAW_METADATA_ENVELOPE_SCHEMA.parse({
    classification: ROOT_POLICY.contracts.unknownMetadataClassification,
    forwarding: ROOT_POLICY.contracts.unknownMetadataForwarding,
    sourceProtocol,
    raw,
  }));
}

function validateRequest(requestInput: ModelRequest, settings: ContractSettings): ModelRequest {
  const request = MODEL_REQUEST_SCHEMA.parse(requestInput);
  if (request.messages.length > settings.limits.maximumMessages || request.tools.length > settings.limits.maximumTools) {
    throw new InputError("Model request exceeds configured contract limits", "model_request_limit_exceeded");
  }
  if (request.requestId.length > settings.limits.maximumIdentifierCharacters ||
    request.model.length > settings.limits.maximumIdentifierCharacters ||
    request.messages.some((message) => message.content.length > settings.limits.maximumTextCharacters)) {
    throw new InputError("Model request text exceeds configured contract limits", "model_request_limit_exceeded");
  }
  if (request.tools.length === 0 && request.toolChoice !== "none") {
    throw new InputError("Tool choice requires at least one tool", "tool_choice_without_tools");
  }
  if (new Set(request.tools.map((tool) => tool.model.name)).size !== request.tools.length) {
    throw new InputError("Tool declarations are ambiguous or internally inconsistent", "tool_contract_inconsistent");
  }
  for (const tool of request.tools) {
    assertToolControlConsistency(tool);
    assertToolWithinSettings(tool, settings);
  }
  return request;
}

function projectChatFunction(tool: ToolContract, settings: ContractSettings): JsonObject {
  const model = MODEL_TOOL_SCHEMA.parse(tool.model);
  return {
    name: model.name,
    ...(model.description === undefined ? {} : { description: model.description }),
    parameters: assertToolSchemaSubset(model.inputSchema, settings),
  };
}

function projectResponseFunction(tool: ToolContract, settings: ContractSettings): JsonObject {
  const model = MODEL_TOOL_SCHEMA.parse(tool.model);
  return {
    type: "function",
    name: model.name,
    ...(model.description === undefined ? {} : { description: model.description }),
    parameters: assertToolSchemaSubset(model.inputSchema, settings),
  };
}

function importMcpTool(
  input: unknown,
  index: number,
  settings: ContractSettings,
  unknown: JsonObject,
): ModelTool {
  const tool = requireObject(input, "mcp_tool_invalid");
  collectUnknown(tool, new Set([
    "_meta", "annotations", "description", "execution", "icons", "inputSchema", "name", "outputSchema", "title",
  ]), `$/result/tools/${index}`, unknown);
  for (const field of ["_meta", "annotations", "execution", "icons", "title"] as const) {
    if (tool[field] !== undefined) unknown[`$/result/tools/${index}/${field}`] = tool[field];
  }
  if (typeof tool.name !== "string") throw new InputError("MCP tool name is invalid", "mcp_tool_invalid");
  if (tool.description !== undefined && typeof tool.description !== "string") {
    throw new InputError("MCP tool description is invalid", "mcp_tool_invalid");
  }
  const model = MODEL_TOOL_SCHEMA.parse({
    name: tool.name,
    ...(typeof tool.description === "string" ? { description: tool.description } : {}),
    inputSchema: assertToolSchemaSubset(tool.inputSchema, settings),
    ...(tool.outputSchema === undefined ? {} : { outputSchema: assertToolSchemaSubset(tool.outputSchema, settings) }),
  });
  if (model.name.length > settings.limits.maximumIdentifierCharacters ||
    (model.description?.length ?? 0) > settings.limits.maximumTextCharacters) {
    throw new InputError("MCP tool text exceeds configured limits", "mcp_tool_invalid");
  }
  return model;
}

function validateToolContract(input: ToolContract): ToolContract {
  const tool = TOOL_CONTRACT_SCHEMA.parse(input);
  assertToolControlConsistency(tool);
  return tool;
}

function assertToolControlConsistency(tool: ToolContract): void {
  if (new Set(tool.control.pathScope).size !== tool.control.pathScope.length ||
    (tool.control.retry === "idempotent-only" && tool.control.idempotency === "none")) {
    throw new InputError("Tool control is internally inconsistent", "tool_contract_inconsistent");
  }
}

function assertToolWithinSettings(tool: ToolContract, settings: ContractSettings): void {
  if (tool.model.name.length > settings.limits.maximumIdentifierCharacters ||
    (tool.model.description?.length ?? 0) > settings.limits.maximumTextCharacters ||
    tool.control.pathScope.some((path) => path.length > settings.limits.maximumTextCharacters)) {
    throw new InputError("Tool contract text exceeds configured limits", "tool_contract_limit_exceeded");
  }
  assertToolSchemaSubset(tool.model.inputSchema, settings);
  if (tool.model.outputSchema !== undefined) assertToolSchemaSubset(tool.model.outputSchema, settings);
}

function unwrapMcpResult(
  raw: unknown,
  code: string,
  expectedResponseId?: McpResponseId,
): Readonly<{ result: JsonObject }> {
  const document = requireObject(raw, code);
  const hasResult = Object.hasOwn(document, "result");
  const hasError = Object.hasOwn(document, "error");
  if (hasResult === hasError || document.jsonrpc !== "2.0") {
    throw new InputError("MCP JSON-RPC response envelope is invalid", code);
  }
  const id = document.id;
  if (id !== undefined && !isMcpResponseId(id)) {
    throw new InputError("MCP JSON-RPC response identifier is invalid", code);
  }
  if (expectedResponseId !== undefined && id !== expectedResponseId) {
    throw new InputError("MCP JSON-RPC response identifier does not match its request", "mcp_response_id_mismatch");
  }
  if (hasResult) {
    if (!isMcpResponseId(id) || !hasExactKeys(document, ["id", "jsonrpc", "result"])) {
      throw new InputError("MCP JSON-RPC result envelope is invalid", code);
    }
    return { result: requireObject(document.result, code) };
  }
  if (!hasExactKeys(document, id === undefined ? ["error", "jsonrpc"] : ["error", "id", "jsonrpc"])) {
    throw new InputError("MCP JSON-RPC error envelope is invalid", code);
  }
  const error = requireObject(document.error, code);
  if (!hasOnlyKeys(error, new Set(["code", "data", "message"])) ||
    !Number.isSafeInteger(error.code) || typeof error.message !== "string" || error.message.length === 0) {
    throw new InputError("MCP JSON-RPC error object is invalid", code);
  }
  if (error.data !== undefined) metadataEnvelope(PROTOCOL_MCP, { data: error.data });
  throw new McpJsonRpcError(Number(error.code), id as McpResponseId | undefined, error);
}

function imported<T>(
  value: T,
  protocol: "openai-responses" | "openai-chat-completions" | "mcp-2025-11-25",
  unknown: JsonObject,
  losses: readonly string[],
): ImportedValue<T> {
  const metadata = Object.keys(unknown).length === 0 ? undefined : metadataEnvelope(protocol, unknown);
  return deepFreeze({ value, losses: [...losses], ...(metadata === undefined ? {} : { metadata }) });
}

function collectUnknown(value: JsonObject, known: ReadonlySet<string>, path: string, target: JsonObject): void {
  for (const key of Object.keys(value)) {
    if (!known.has(key)) target[`${path}/${escapePointer(key)}`] = value[key];
  }
}

function isMcpResponseId(value: unknown): value is McpResponseId {
  return typeof value === "string"
    ? value.length > 0 && value.length <= ROOT_POLICY.contracts.limits.maximumIdentifierCharacters
    : Number.isSafeInteger(value);
}

function hasExactKeys(value: JsonObject, keys: readonly string[]): boolean {
  return Object.keys(value).toSorted().join("\0") === [...keys].toSorted().join("\0");
}

function hasOnlyKeys(value: JsonObject, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}
