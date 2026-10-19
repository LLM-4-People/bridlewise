/**
 * MCP module public surface. Re-exports the canonical types and factories
 * so consumers import from `src/mcp/` (the shared module). There is no
 * `src/tools/mcp-adapter.ts` facade and no `src/runtime/mcp-tools.ts`
 * shim — this module IS the implementation.
 */

export { McpError } from "./errors.ts";
export type { McpSpawn, McpTransport, McpTransportType, McpTransportFactoryOptions } from "./transport/types.ts";
export { createStdioTransport } from "./transport/stdio.ts";
export { createStreamableHttpTransport } from "./transport/streamable-http.ts";
export { createWebSocketTransport } from "./transport/websocket.ts";
export {
  MCP_TOOL_NAME_PREFIX,
  MCP_SERVER_ID_PATTERN,
  MCP_SERVER_ID_MAX_CHARACTERS,
  isMcpServerId,
  isMcpToolName,
  mcpToolName,
  mcpToolNameHead,
} from "./tool-name.ts";
export { authEnv, authHeaders, resolveAuthToken, type McpAuthConfig } from "./auth.ts";
export { mergeHeaders, canonicalHeaderName, redactHeaders } from "./headers.ts";
export { withRetry, withReconnect, backoffDelay, isTransportError, DEFAULT_MCP_RETRY, type McpRetryConfig, type RetryAttempt, type RetryObserver } from "./retry.ts";
export {
  createMcpCoreClient,
  type McpClient,
  type McpClientInfo,
  type McpServerInfo,
  type McpTool,
  type McpToolAnnotations,
  type McpContentItem,
  type McpCallResult,
  MCP_JSONRPC_VERSION,
  MCP_MAX_TOOLS,
  MCP_MAX_TOOL_NAME_LENGTH,
  MCP_MAX_MESSAGE_BYTES,
} from "./core.ts";
export {
  createMcpClientFromConfig,
  buildTransportHeaders,
  buildTransportEnv,
  type McpClientFactoryOptions,
  type McpStdioHost,
} from "./factory.ts";
export {
  validateMcpServerEntry,
  validateMcpModuleConfig,
  normalizeMcpModuleConfig,
  resolveMcpServerConfigs,
  unresolvedCredentialPlaceholders,
  MCP_CREDENTIAL_PLACEHOLDER,
  type McpServerEntry,
  type McpModuleConfig,
} from "./config.ts";
export {
  createMcpToolAdapter,
  createMcpToolManifestEntry,
  buildRegisteredTool,
  mcpToolCapabilities,
} from "./tool-adapter.ts";
export {
  createMcpRegistry,
  type McpRegistry,
  type ServerStatus,
  type ServerSignals,
  type ToolSignals,
  type GlobalSignals,
  type RegistryOptions,
  type McpToolRegistration,
} from "./registry.ts";
export {
  createMcpExposure,
  type McpExposure,
  type ServerEntryProjection,
  type ServerCustomization,
  type ToolCustomization,
  type GlobalCustomization,
} from "./exposure.ts";
