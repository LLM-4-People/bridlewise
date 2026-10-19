/**
 * MCP core — the transport-agnostic JSON-RPC 2.0 client. Owns a single
 * `McpTransport`, frames requests/responses, and implements the MCP
 * lifecycle: `initialize` → `notifications/initialized` → `tools/list` →
 * `tools/call`.
 *
 * The core is transport-pluggable: the transport delivers raw JSON-RPC
 * messages; the core correlates by `id`, applies per-request timeouts,
 * validates the protocol-version handshake, and normalizes JSON-RPC errors
 * to typed `McpError`.
 *
 * All configurable ceilings (max tools, max tool-name length, max message
 * bytes) are derived from `ROOT_POLICY` — no hardcoded literals. The
 * JSON-RPC wire-version (`"2.0"`) is the protocol standard, not a
 * configurable server value.
 */

import { z } from "zod";

import { InputError } from "../kernel/errors.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { bestEffortAsync } from "../shared/best-effort.ts";
import { guarded } from "../process/fault-policy.ts";
import { McpError } from "./errors.ts";
import { MCP_LOG_CATEGORY, type McpTransport } from "./transport/types.ts";
import { debugLog } from "../shared/debug/debug-system.ts";

const JSONRPC_VERSION = "2.0";
/** JSON-RPC 2.0 §5.1 "Method not found" — the protocol standard's code. */
const JSONRPC_METHOD_NOT_FOUND = -32601;

/** Max bytes for a single JSON-RPC message — derived from ROOT_POLICY. */
const MAX_MCP_MESSAGE_BYTES = ROOT_POLICY.runtime.limits.maximumSseEventBytes;
/** Max tools a single server may expose — derived from ROOT_POLICY. */
const MAX_MCP_TOOLS = ROOT_POLICY.tools.limits.maximumEnabledTools;
/** Max length of a tool name — derived from ROOT_POLICY. */
const MAX_TOOL_NAME_LENGTH = ROOT_POLICY.tools.limits.maximumToolNameCharacters;

export type McpClientInfo = Readonly<{ name: string; version: string }>;
export type McpServerInfo = Readonly<{ name: string; version: string; title?: string }>;
/**
 * The behaviour hints an MCP server declares for one tool (spec
 * `ToolAnnotations`). They are UNTRUSTED claims — the MCP spec says so — and
 * the harness uses them only to CLASSIFY a tool (read vs write), failing
 * closed when a hint is absent. The boundary is the confinement, never these.
 */
export type McpToolAnnotations = Readonly<{
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}>;
const ANNOTATION_HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

export type McpTool = Readonly<{
  name: string;
  description?: string;
  title?: string;
  inputSchema: Readonly<Record<string, unknown>>;
  annotations?: McpToolAnnotations;
}>;
export type McpContentItem = Readonly<{ type: string; text?: string; data?: string; mimeType?: string }>;
export type McpCallResult = Readonly<{
  content: readonly McpContentItem[];
  /** The tool's typed result object, when the server sends one (spec `structuredContent`). */
  structuredContent?: Readonly<Record<string, unknown>>;
  isError: boolean;
}>;

/** Keep only the spec's hint booleans and title; anything else is dropped. */
function projectAnnotations(raw: unknown): McpToolAnnotations | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const out: Record<string, boolean | string> = {};
  for (const hint of ANNOTATION_HINTS) {
    if (typeof source[hint] === "boolean") out[hint] = source[hint];
  }
  if (typeof source.title === "string") out.title = source.title;
  return Object.keys(out).length === 0 ? undefined : Object.freeze(out) as McpToolAnnotations;
}

type JsonRpcRequest = Readonly<{ jsonrpc: typeof JSONRPC_VERSION; id: string | number; method: string; params?: unknown }>;
type JsonRpcNotification = Readonly<{ jsonrpc: typeof JSONRPC_VERSION; method: string; params?: unknown }>;

/**
 * THE ONE JSON-RPC 2.0 RESPONSE SHAPE (§5): `jsonrpc` "2.0", an `id`, and
 * EXACTLY ONE of `result` (any value) or `error` (an object with an integer
 * `code` and a string `message`, `data` optional). Every reply a server sends
 * is held to it before anything reads a field of it: a reply such as
 * `{"error":null}` used to throw inside the transport's message listener and
 * end the whole process (SCALE-CR1 C1). A reply that fails it rejects the
 * request it answers with `mcp_protocol_violation`; the transport stays up.
 */
const JSON_RPC_ERROR_SCHEMA = z.object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() });
const JSON_RPC_RESPONSE_SCHEMA = z.union([
  z.object({ jsonrpc: z.literal(JSONRPC_VERSION), id: z.union([z.string(), z.number()]), error: JSON_RPC_ERROR_SCHEMA }),
  z.object({ jsonrpc: z.literal(JSONRPC_VERSION), id: z.union([z.string(), z.number()]), result: z.unknown() }),
]);
type JsonRpcResponse = z.infer<typeof JSON_RPC_RESPONSE_SCHEMA>;
/** A reply that answered with a result: what a request's promise resolves to (an error reply rejects it). */
type JsonRpcResultReply = Exclude<JsonRpcResponse, Readonly<{ error: unknown }>>;

/** The response's shape, or `undefined`: EXACTLY ONE of the two members (judged on the wire object — a schema strips the other). */
function parseJsonRpcResponse(message: Readonly<Record<string, unknown>>): JsonRpcResponse | undefined {
  if (("result" in message) === ("error" in message)) return undefined;
  const reply = JSON_RPC_RESPONSE_SCHEMA.safeParse(message);
  return reply.success ? reply.data : undefined;
}

/** The `initialize` result fields the client reads (MCP lifecycle): a server that omits them is refused typed. */
const INITIALIZE_RESULT_SCHEMA = z.object({
  protocolVersion: z.string(),
  serverInfo: z.object({ name: z.string(), version: z.string(), title: z.string().optional() }),
});

/** The refusal of a reply that is not a JSON-RPC response: the request it answers fails; nothing else does. */
function protocolViolation(serverId: string, reason: string): McpError {
  return new McpError(`MCP server sent a reply that is not a JSON-RPC 2.0 response (${reason})`, "mcp_protocol_violation", false, { serverId, reason });
}
type PendingRequest = Readonly<{ resolve: (r: JsonRpcResultReply) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>;

export type McpClient = Readonly<{
  readonly serverId: string;
  readonly connected: boolean;
  connect(signal?: AbortSignal): Promise<McpServerInfo>;
  listTools(signal?: AbortSignal): Promise<readonly McpTool[]>;
  callTool(name: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<McpCallResult>;
  close(): Promise<void>;
}>;

export type McpCoreOptions = Readonly<{
  serverId: string;
  transport: McpTransport;
  protocolVersion: string;
  /** Client identity sent in the `initialize` handshake — required, no hardcoded default. */
  clientInfo: McpClientInfo;
  timeoutMs: number;
  /**
   * How many requests the SERVER sent may wait for an answer at once (the
   * module config's `serverRequestBacklog`). Answers go out one at a time; a
   * request beyond the backlog is dropped and logged — a stream of 2000
   * pings no longer fires 2000 concurrent sends (secb-security SECB-V-10).
   */
  serverRequestBacklog: number;
  /** Called when the transport closes unexpectedly — the registry uses this to restart. */
  onTransportClose?: () => void;
}>;

export function createMcpCoreClient(options: McpCoreOptions): McpClient {
  const { transport, protocolVersion, timeoutMs, serverId, clientInfo } = options;
  let connected = false;
  let closeRequested = false;
  let serverInfo: McpServerInfo | undefined;
  let nextRequestId = 1;
  const pending = new Map<string | number, PendingRequest>();

  /**
   * ROUTE BY SHAPE (JSON-RPC 2.0 §4-5, MCP basic protocol): a message with a
   * `method` is the SERVER speaking first — a request when it carries an
   * `id`, a notification when it does not — and only a message WITHOUT a
   * `method` is a response to one of ours. Both sides number their requests
   * from 1, so correlating on `id` alone let a server `ping` with id 1
   * resolve our pending request 1 with the ping as its "result", and left
   * the server waiting forever for the answer it asked for.
   */
  transport.onMessage((raw) => {
    // The transports bound what they deliver (a stdio line, an SSE event, a
    // WebSocket message); a JSON body may be larger than one message.
    if (Buffer.byteLength(raw, "utf8") > MAX_MCP_MESSAGE_BYTES) {
      debugLog(MCP_LOG_CATEGORY, "warn", "mcp_message_oversized", () => ({ serverId, limitBytes: MAX_MCP_MESSAGE_BYTES }));
      return;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return; }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const msg = parsed as Record<string, unknown>;
    if (msg.jsonrpc !== JSONRPC_VERSION) return;
    const hasId = typeof msg.id === "string" || typeof msg.id === "number";
    if (typeof msg.method === "string") {
      if (hasId) answerServerRequest(msg.id as string | number, msg.method);
      return;
    }
    if (!hasId) {
      debugLog(MCP_LOG_CATEGORY, "warn", "mcp_protocol_violation", () => ({ serverId, reason: "a reply with no usable id" }));
      return;
    }
    const id = msg.id as string | number;
    const entry = pending.get(id);
    if (entry === undefined) {
      debugLog(MCP_LOG_CATEGORY, "warn", "mcp_protocol_violation", () => ({ serverId, reason: "a reply to no pending request" }));
      return;
    }
    clearTimeout(entry.timer);
    pending.delete(id);
    const reply = parseJsonRpcResponse(msg);
    if (reply === undefined) {
      entry.reject(protocolViolation(serverId, "exactly one of a result or an {code, message} error is required"));
      return;
    }
    if ("error" in reply) {
      const { code, message } = reply.error;
      entry.reject(new McpError(message, `mcp_rpc_error_${String(code)}`, false, { serverId, code }));
    } else {
      entry.resolve(reply);
    }
  });

  /**
   * Answer a request the server sent us. The client declares NO capabilities
   * in `initialize`, so the only request it serves is `ping` (which either
   * side may send at any time, answered with an empty result); every other
   * method — sampling, elicitation, roots — is "method not found". The answer
   * is best effort: a transport that cannot send it is already reporting its
   * own failure through the pending requests.
   */
  let answering: Promise<unknown> = Promise.resolve();
  let waitingAnswers = 0;
  function answerServerRequest(id: string | number, method: string): void {
    if (waitingAnswers >= options.serverRequestBacklog) {
      debugLog(MCP_LOG_CATEGORY, "warn", "server request dropped: the answer backlog is full", () => ({ serverId, method, backlog: options.serverRequestBacklog }));
      return;
    }
    const answer = method === "ping"
      ? { jsonrpc: JSONRPC_VERSION, id, result: {} }
      : { jsonrpc: JSONRPC_VERSION, id, error: { code: JSONRPC_METHOD_NOT_FOUND, message: `Method not found: ${method}` } };
    waitingAnswers += 1;
    answering = answering
      .then(() => bestEffortAsync(() => transport.send(JSON.stringify(answer))))
      .finally(() => { waitingAnswers -= 1; });
  }

  transport.onClose(() => {
    // The peer's own last words (a stdio server's stderr tail: the guardian's
    // refusal, EACCES, a crash) are the reason, not a bare "closed".
    const said = transport.closeReason?.();
    const message = said === undefined ? "MCP transport closed unexpectedly" : `MCP transport closed unexpectedly; the server last reported: ${said}`;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new McpError(message, "mcp_transport_closed", true, { serverId }, true));
    }
    pending.clear();
    connected = false;
    options.onTransportClose?.();
  });

  function sendRequest(method: string, params: unknown, signal?: AbortSignal): Promise<JsonRpcResultReply> {
    return new Promise((resolve, reject) => {
      const id = nextRequestId++;
      // Settled (answered, timed out, cancelled): a resuming transport stops.
      const answered = (): boolean => !pending.has(id);
      const message: JsonRpcRequest = Object.freeze({
        jsonrpc: JSONRPC_VERSION, id, method, ...(params !== undefined ? { params } : {}),
      });
      /**
       * The ONE way a request we gave up on is settled — a timeout and a
       * cancellation alike. The server is TOLD (`notifications/cancelled`;
       * the spec's lifecycle "Timeouts": the sender SHOULD cancel), so it can
       * stop the work it is doing for us: disconnecting is not cancelling.
       * `initialize` is never cancelled (spec, cancellation).
       */
      const abandon = (error: McpError, reason: string): void => {
        const entry = pending.get(id);
        if (entry === undefined) return;
        clearTimeout(entry.timer);
        pending.delete(id);
        entry.reject(error);
        if (method !== "initialize") {
          void bestEffortAsync(() => sendNotification("notifications/cancelled", Object.freeze({ requestId: id, reason })));
        }
      };
      const timer = setTimeout(guarded("mcp.request.timeout", () => {
        abandon(new McpError(`MCP request '${method}' timed out after ${timeoutMs}ms`, "mcp_timeout", true, { serverId, method }), `The client timed out after ${timeoutMs}ms`);
      }), timeoutMs);
      pending.set(id, { resolve, reject, timer });
      if (signal !== undefined) {
        if (signal.aborted) {
          clearTimeout(timer); pending.delete(id);
          reject(new McpError(`MCP request '${method}' cancelled`, "mcp_cancelled", false, {}));
          return;
        }
        signal.addEventListener("abort", guarded("mcp.request.abort", () => {
          abandon(new McpError(`MCP request '${method}' cancelled`, "mcp_cancelled", false, {}), "The client cancelled the request");
        }), { once: true });
      }
      const json = JSON.stringify(message);
      if (Buffer.byteLength(json, "utf8") > MAX_MCP_MESSAGE_BYTES) {
        clearTimeout(timer); pending.delete(id);
        reject(new McpError("MCP message exceeds maximum size", "mcp_message_oversized", false, {}));
        return;
      }
      transport.send(json, { signal, answered }).catch((error) => {
        const entry = pending.get(id);
        if (entry !== undefined) {
          clearTimeout(timer); pending.delete(id);
          entry.reject(error instanceof Error ? error : new McpError(String(error), "mcp_send_failed", true, {}, true));
        }
      });
    });
  }

  async function sendNotification(method: string, params?: unknown): Promise<void> {
    const message: JsonRpcNotification = Object.freeze({
      jsonrpc: JSONRPC_VERSION, method, ...(params !== undefined ? { params } : {}),
    });
    await transport.send(JSON.stringify(message));
  }

  async function connect(signal?: AbortSignal): Promise<McpServerInfo> {
    if (closeRequested) throw new McpError("MCP client has been closed and cannot reconnect", "mcp_closed", false, {}, true);
    if (connected) throw new McpError("MCP client is already connected", "mcp_already_connected", false, {});
    await transport.connect(signal);
    try {
      const response = await sendRequest("initialize", Object.freeze({
        protocolVersion, capabilities: Object.freeze({}), clientInfo,
      }), signal);
      const initialized = INITIALIZE_RESULT_SCHEMA.safeParse(response.result);
      if (!initialized.success) throw new McpError("MCP initialize returned no protocol version and server identity", "mcp_initialize_failed", false, {});
      const result = initialized.data;
      if (result.protocolVersion !== protocolVersion) {
        throw new McpError(`MCP protocol version mismatch: client requested ${protocolVersion}, server returned ${result.protocolVersion}`, "mcp_protocol_version_mismatch", false, { requested: protocolVersion, returned: result.protocolVersion });
      }
      serverInfo = Object.freeze({
        name: result.serverInfo.name,
        version: result.serverInfo.version,
        ...(result.serverInfo.title !== undefined ? { title: result.serverInfo.title } : {}),
      });
      await sendNotification("notifications/initialized");
      connected = true;
      return serverInfo;
    } catch (error) {
      await transport.close();
      throw error;
    }
  }

  /**
   * Discover every tool, following `nextCursor` pagination to the end. The
   * page loop is bounded by the tool ceiling itself: every page but the last
   * must carry at least one tool, so a server can never hold the loop open
   * with empty pages, and the total can never pass the ceiling unnoticed.
   */
  async function listTools(signal?: AbortSignal): Promise<readonly McpTool[]> {
    if (!connected) throw new McpError("MCP client is not connected", "mcp_not_connected", false, {}, true);
    const raw: unknown[] = [];
    let cursor: string | undefined;
    for (;;) {
      const response = await sendRequest("tools/list", Object.freeze(cursor === undefined ? {} : { cursor }), signal);
      const result = response.result as { tools?: unknown; nextCursor?: unknown } | undefined;
      if (result === undefined || !Array.isArray(result.tools)) {
        throw new McpError("MCP tools/list returned invalid result", "mcp_list_tools_failed", false, {});
      }
      raw.push(...result.tools);
      if (raw.length > MAX_MCP_TOOLS) {
        throw new McpError(`MCP server returned too many tools (${raw.length})`, "mcp_too_many_tools", false, {});
      }
      if (typeof result.nextCursor !== "string" || result.nextCursor.length === 0) break;
      if (result.tools.length === 0) {
        throw new McpError("MCP tools/list returned an empty page with a cursor", "mcp_list_tools_failed", false, {});
      }
      cursor = result.nextCursor;
    }
    const validated: McpTool[] = [];
    for (const entry of raw) {
      if (entry === null || typeof entry !== "object") continue;
      const tool = entry as { name?: unknown; description?: unknown; title?: unknown; inputSchema?: unknown; annotations?: unknown };
      if (typeof tool.name !== "string" || tool.name.length === 0 || tool.name.length > MAX_TOOL_NAME_LENGTH) continue;
      if (typeof tool.inputSchema !== "object" || tool.inputSchema === null) continue;
      const annotations = projectAnnotations(tool.annotations);
      validated.push(Object.freeze({
        name: tool.name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        ...(typeof tool.title === "string" ? { title: tool.title } : {}),
        inputSchema: Object.freeze({ ...tool.inputSchema }) as Readonly<Record<string, unknown>>,
        ...(annotations !== undefined ? { annotations } : {}),
      }));
    }
    return Object.freeze(validated);
  }

  async function callTool(name: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<McpCallResult> {
    if (!connected) throw new McpError("MCP client is not connected", "mcp_not_connected", true, {}, true);
    if (typeof name !== "string" || name.length === 0 || name.length > MAX_TOOL_NAME_LENGTH) {
      throw new InputError("Tool name must be a non-empty string within length limits", "mcp_tool_name_invalid");
    }
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      throw new InputError("Tool arguments must be a JSON object", "mcp_arguments_invalid");
    }
    const response = await sendRequest("tools/call", Object.freeze({ name, arguments: args }), signal);
    const result = response.result as { content?: McpContentItem[]; structuredContent?: unknown; isError?: boolean } | undefined;
    if (result === undefined || !Array.isArray(result.content)) {
      throw new McpError("MCP tools/call returned invalid result", "mcp_call_tool_failed", false, {});
    }
    const structured = result.structuredContent;
    return Object.freeze({
      content: Object.freeze(result.content.map((c) => Object.freeze({ ...c }))) as readonly McpContentItem[],
      ...(structured !== null && typeof structured === "object" && !Array.isArray(structured)
        ? { structuredContent: Object.freeze({ ...(structured as Record<string, unknown>) }) }
        : {}),
      isError: result.isError === true,
    });
  }

  async function close(): Promise<void> {
    closeRequested = true;
    // A request still in flight is settled, never abandoned: its caller would
    // otherwise await forever.
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new McpError("MCP client was closed before the server answered", "mcp_closed", false, { serverId }, true));
    }
    pending.clear();
    connected = false;
    await transport.close();
  }

  return Object.freeze({
    serverId,
    get connected() { return connected; },
    connect, listTools, callTool, close,
  });
}

export {
  JSONRPC_VERSION as MCP_JSONRPC_VERSION,
  MAX_MCP_TOOLS as MCP_MAX_TOOLS,
  MAX_TOOL_NAME_LENGTH as MCP_MAX_TOOL_NAME_LENGTH,
  MAX_MCP_MESSAGE_BYTES as MCP_MAX_MESSAGE_BYTES,
};
