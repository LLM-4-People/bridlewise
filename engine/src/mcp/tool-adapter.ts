/**
 * MCP tool adapter — bridges a discovered MCP tool into the harness
 * `ToolAdapter` + `ToolManifestEntry` + `RegisteredTool` shapes so the
 * runtime tool registry can expose MCP tools to the LLM with zero
 * per-tool code.
 *
 * The harness name of each tool comes from the one naming owner
 * (`tool-name.ts`: `mcp__<serverId>__<toolName>`, spec-legal), and its
 * read/write classification from the one classifier below.
 */

import { deepFreeze } from "../kernel/integrity.ts";
import { extractErrorMessage, InputError } from "../kernel/errors.ts";
import {
  isAbortError,
  type ToolAdapter,
  type ToolAdapterContext,
  type ToolAdapterInput,
  type ToolAdapterResult,
} from "../tools/tool-adapter.ts";
import { DEFAULT_TOOL_RESOURCE_BOUNDS, type ToolCapability, type ToolManifestEntry } from "../tools/tool-manifest.ts";
import type { RegisteredTool, ToolContext } from "../runtime/tool-registry.ts";
import type { McpCallResult, McpClient, McpTool } from "./core.ts";

/**
 * The ONE classification of an MCP tool's effect, from the server's own
 * annotations, failing CLOSED: a tool is `read` only when the server says
 * `readOnlyHint: true`; absent or false is `write`. It reaches the network
 * unless the server says `openWorldHint: false`. Annotations are untrusted
 * claims, so this only decides how a call is CLASSIFIED (the event feed,
 * the write set's accounting); what a server process can actually touch is
 * decided by its confinement, never by these hints.
 */
export function mcpToolCapabilities(tool: McpTool): readonly ToolCapability[] {
  const hints = tool.annotations;
  return deepFreeze([
    hints?.readOnlyHint === true ? "read" as const : "write" as const,
    ...(hints?.openWorldHint === false ? [] : ["network" as const]),
  ]);
}

/**
 * The synchronous placeholder every bridged MCP tool carries. MCP execution
 * is inherently async (a JSON-RPC round-trip), so the sync handler only ever
 * throws — the runtime dispatches through `asyncHandler`. Module-private: it
 * is not part of the public surface.
 */
function createAsyncOnlyHandler(toolName: string): () => never {
  return () => {
    throw new InputError(`Tool '${toolName}' is async-only; use executeAsync`, "tool_async_only");
  };
}


export function createMcpToolAdapter(client: McpClient, tool: McpTool, adapterId: string): ToolAdapter {
  return deepFreeze({
    adapterId,
    async execute(input: ToolAdapterInput, context: ToolAdapterContext): Promise<ToolAdapterResult> {
      try {
        const result: McpCallResult = await client.callTool(tool.name, input.arguments, context.signal);
        const textParts = result.content
          .filter((c) => c.type === "text" && typeof c.text === "string")
          .map((c) => c.text!);
        const content = textParts.length > 0 ? textParts.join("\n") : JSON.stringify(result.content);
        return deepFreeze({
          toolId: input.toolId,
          content,
          isError: result.isError,
          structured: deepFreeze({ content: [...result.content] }),
          durationMs: 0,
          truncated: false,
          cancelled: false,
        });
      } catch (error) {
        if (isAbortError(error)) {
          return deepFreeze({ toolId: input.toolId, content: "", isError: true, durationMs: 0, truncated: false, cancelled: true });
        }
        return deepFreeze({
          toolId: input.toolId, content: extractErrorMessage(error), isError: true, durationMs: 0, truncated: false, cancelled: false,
        });
      }
    },
  });
}

/**
 * The manifest entry of one discovered tool, under the harness name the
 * registry minted for it (`name`, from the one naming owner, minted once per
 * registration — never re-derived here).
 */
export function createMcpToolManifestEntry(
  serverId: string,
  tool: McpTool,
  name: string,
  bounds?: Partial<typeof DEFAULT_TOOL_RESOURCE_BOUNDS>,
): ToolManifestEntry {
  const id = name;
  const capabilities = mcpToolCapabilities(tool);
  return deepFreeze({
    id,
    // The name the model calls IS the harness name; the server's own name
    // stays with the registry, which resolves the one from the other.
    name: id,
    description: tool.description ?? `MCP tool ${tool.name} from server ${serverId}`,
    inputSchema: deepFreeze({ ...tool.inputSchema }) as Readonly<Record<string, unknown>>,
    capabilities,
    bounds: deepFreeze({
      timeoutMs: bounds?.timeoutMs ?? DEFAULT_TOOL_RESOURCE_BOUNDS.timeoutMs,
      maxOutputBytes: bounds?.maxOutputBytes ?? DEFAULT_TOOL_RESOURCE_BOUNDS.maxOutputBytes,
      maxMemoryBytes: bounds?.maxMemoryBytes ?? DEFAULT_TOOL_RESOURCE_BOUNDS.maxMemoryBytes,
    }),
    adapterId: `mcp-${serverId}`,
  });
}

/**
 * Build a complete `RegisteredTool` for the runtime registry from a
 * discovered MCP tool. The tool is async-only — the sync `handler` throws
 * `tool_async_only`; the `asyncHandler` delegates to the adapter.
 */
export function buildRegisteredTool(client: McpClient, serverId: string, tool: McpTool, name: string): RegisteredTool {
  const toolName = name;
  const adapterId = `mcp-${serverId}`;
  const adapter = createMcpToolAdapter(client, tool, adapterId);
  return deepFreeze({
    definition: deepFreeze({
      type: "function" as const,
      function: deepFreeze({
        name: toolName,
        description: tool.description ?? `MCP tool ${tool.name} from server ${serverId}`,
        parameters: tool.inputSchema as Record<string, unknown>,
      }),
    }),
    handler: createAsyncOnlyHandler(toolName),
    asyncHandler: async (
      args: Readonly<Record<string, unknown>>,
      context: ToolContext,
      signal?: AbortSignal,
    ): Promise<string> => {
      const input: ToolAdapterInput = deepFreeze({ toolId: toolName, arguments: args });
      const adapterContext: ToolAdapterContext = deepFreeze({
        repositoryRoot: context.repositoryRoot,
        ...(signal !== undefined ? { signal } : {}),
      });
      const result = await adapter.execute(input, adapterContext);
      if (result.isError) {
        throw new InputError(result.content, "tool_execution_failed");
      }
      return result.content;
    },
  });
}
