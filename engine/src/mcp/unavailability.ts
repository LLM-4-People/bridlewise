/**
 * MCP tool-unavailability taxonomy — the ONE owner of the typed-code →
 * reason decode.
 *
 * An MCP tool call (`mcp__<server>__<tool>`) can refuse to run for several genuinely different
 * causes, and each cause asks a different thing of the user:
 *
 *   mcp_not_connected            → the tool is set up, but the service behind
 *     it is not connected right now (it failed to connect or dropped); the
 *     user can start it or find out why it stopped.
 *   mcp_server_not_registered    → the tool is not configured in this harness
 *     at all; the user must add it in settings.
 *   mcp_tool_disabled            → the user turned the tool off on purpose;
 *     turning it back on is the action that unblocks the call.
 *   mcp_start_superseded         → TRANSIENT: the runtime serving the tool was
 *     replaced mid-call by a newer lifecycle; a retry usually needs no user
 *     action at all. Nothing is missing and nothing is misconfigured.
 *   mcp_runtime_shut_down        → the runtime was sealed for process exit;
 *     only a harness restart brings the tool back.
 *
 * These are the reasons a call did NOT run. A call that RAN and erred
 * (`mcp_call_tool_failed`) is a failure, not an unavailability, and is
 * deliberately absent here: classifying it as unavailable would send the
 * user shopping for a fix to a tool that is reachable.
 *
 * The taxonomy's judgment is EXPLICIT in both directions: every other
 * `mcp_*` code in the module is a deliberate exclusion, named here with its
 * reason so "deliberate" and "forgotten" can never be confused (adding a
 * code to the tree without either classifying it in CODE_TO_KEY or naming
 * it below is a test failure, not a choice that can slip):
 *
 *   mcp_error                      → the generic fallback for an error with
 *     no typed code; nothing can honestly be said about availability.
 *   mcp_call_tool_failed           → the tool RAN and reported an error; a
 *     result, not a refusal to run.
 *   mcp_already_connected          → a lifecycle state notice (the client was
 *     connected already), not a failure to serve.
 *   mcp_arguments_invalid          → the call's arguments were invalid; the
 *     tool exists and was reachable.
 *   mcp_cancelled                  → the call was deliberately aborted (a run
 *     cancel or shutdown drain); nothing about the tool's availability.
 *   mcp_closed                     → the transport was already closed (a
 *     teardown race); the lifecycle owns the next connect.
 *   mcp_config_invalid             → the MODULE config was rejected at
 *     connect, or ONE server entry was (the registry validates each entry
 *     and records the refusal as that server's status); a configuration
 *     verdict, not a per-tool state.
 *   mcp_content_block_not_canonicalized / mcp_jsonrpc_error /
 *   mcp_response_id_mismatch / mcp_tool_duplicate / mcp_tool_invalid /
 *   mcp_tool_result_invalid / mcp_tools_list_invalid /
 *   mcp_protocol_violation
 *                                  → the peer spoke out of shape (protocol
 *     projections; a reply that is not a JSON-RPC response); a misbehaving
 *     server, not a missing one.
 *   mcp_http_error /
 *   mcp_websocket_error / mcp_http_content_type_invalid
 *                                  → the transport substrate is missing or
 *     erred beneath a live client (or the peer answered in a shape the
 *     transport cannot frame); environment/transient, not the tool.
 *   mcp_stream_ended_without_response / mcp_resume_unsupported /
 *   mcp_resume_id_invalid / mcp_resume_exhausted
 *                                  → a Streamable HTTP event stream closed
 *     before the answer and could not be resumed (no event id, the server
 *     refuses the resuming GET, an id that cannot be sent back, or the
 *     resume budget spent); a misbehaving or limited peer mid-call.
 *   mcp_session_expired            → the Streamable HTTP session is gone
 *     (404); retryable and transport-level, so the reconnect path starts a
 *     new session and the call is retried in flight rather than judged.
 *   mcp_credential_missing / mcp_credential_env_refused / mcp_spawn_refused /
 *   mcp_tool_name_collision        → CONNECT-time refusals (a `${VAR}` the
 *     environment does not define, or one `tools.mcp.credentialEnv` does not
 *     permit, a stdio server the host would not start —
 *     e.g. its confinement was refused —, two tools minting one harness
 *     name). They become the
 *     SERVER's status (code + message on its signals); a call to one of its
 *     tools afterwards meets the server without a client and is refused as
 *     "not connected", which is the category the user acts on.
 *   mcp_initialize_failed / mcp_protocol_version_mismatch /
 *   mcp_list_tools_failed          → the connect handshake or discovery
 *     failed; the lifecycle retries/rebuilds (transient or interop).
 *   mcp_message_oversized / mcp_too_many_tools → a declared bound tripped
 *     (payload size — a stdio line or WebSocket message past it also closes
 *     the connection —, manifest size); a limit verdict, not availability.
 *
 * NOT MCP codes, and never retried either: the outbound door's refusals
 * (`outbound_*`: a redirect, cleartext to another machine, TLS verification
 * off, a bad header, a credentialed request through an environment proxy)
 * reach an MCP caller as the door's own typed `SecurityError`. They are a
 * POLICY refusal — the call did not run and must not be re-sent — so the
 * retry layer honours their `retryable: false` and nothing here classifies
 * them as an unavailability.
 *   mcp_send_failed                → a write failed on a live transport
 *     (transient I/O).
 *   mcp_timeout                    → a bounded wait elapsed mid-call; the
 *     retry layer owns it, and a slow server is not an absent one.
 *   mcp_tool_name_invalid          → the requested name was malformed; the
 *     registry was reachable and answered.
 *   mcp_transport_closed           → the transport dropped mid-call; the
 *     lifecycle reconnects it, so the call is retried in flight rather than
 *     judged.
 *
 * Everyone who asks "is this refusal an unavailability, and why?" goes
 * through {@link mcpUnavailableReason}: the executor's catch decodes with
 * it once (carrying the reason key on the tool result), the bridge's
 * `isMcpUnavailableError` derives from it, and the safety investigation
 * turns the key into the user-facing pause sentence. There is no second
 * switch over `err.code` anywhere else in the tree.
 */

import { McpError } from "./errors.ts";

export type McpUnavailabilityKey =
  | "not-connected"
  | "not-registered"
  | "disabled"
  | "start-superseded"
  | "shut-down";

const CODE_TO_KEY: Readonly<Record<string, McpUnavailabilityKey>> = Object.freeze({
  mcp_not_connected: "not-connected",
  mcp_server_not_registered: "not-registered",
  mcp_tool_disabled: "disabled",
  mcp_start_superseded: "start-superseded",
  mcp_runtime_shut_down: "shut-down",
});

/** Every typed code the taxonomy owns (guard discovery enumerates this). */
export const MCP_UNAVAILABILITY_CODES: readonly string[] = Object.freeze(Object.keys(CODE_TO_KEY));

export type McpUnavailabilityReason = Readonly<{
  /** The typed error code seen at the throw site. */
  code: string;
  /** The user-honest category of the refusal. */
  key: McpUnavailabilityKey;
}>;

/**
 * The single decode: an {@link McpError} whose code is in the taxonomy is an
 * unavailability (the tool did not run) with a named cause; anything else is
 * a failure of something that did run. Non-MCP errors are never unavailable.
 */
export function mcpUnavailableReason(error: unknown): McpUnavailabilityReason | null {
  if (!(error instanceof McpError)) return null;
  const key = CODE_TO_KEY[error.code];
  return key === undefined ? null : Object.freeze({ code: error.code, key });
}
