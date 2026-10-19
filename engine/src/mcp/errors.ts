/**
 * MCP error hierarchy. `McpError` carries a retryable flag so the retry
 * layer can decide whether to retry without inspecting strings, and a
 * `transportLevel` flag so the retry layer can decide whether to reconnect
 * the transport (vs. just retrying the call). Errors from the JSON-RPC
 * layer, transports, auth, and the retry layer all surface as `McpError`
 * with a stable code prefix (`mcp_*`).
 *
 * The `transportLevel` flag is the DRY classification: the transport that
 * throws the error knows whether it is a transport-level failure (the
 * connection is dead and must be re-established) or a transient call
 * failure (the connection is fine; just retry the call). This replaces the
 * previous `TRANSPORT_ERROR_CODES` keyword set — the classification is now
 * owned by the error itself, not by a separate list of codes that can drift
 * from the codes the transports actually throw.
 */

import { HarnessError } from "../kernel/errors.ts";

export class McpError extends HarnessError {
  readonly transportLevel: boolean;
  constructor(
    message: string,
    code = "mcp_error",
    retryable = false,
    safeDetails: Readonly<Record<string, string | number | boolean>> = {},
    transportLevel = false,
  ) {
    super(message, code, retryable, safeDetails);
    this.transportLevel = transportLevel;
  }
}
