/**
 * MCP transport interface — the abstraction every transport (stdio,
 * Streamable HTTP `http`, websocket) implements. The core JSON-RPC client (`src/mcp/core.ts`) speaks
 * to a server exclusively through this interface, so transports are fully
 * pluggable and individually testable.
 *
 * A transport is responsible for:
 * - establishing the connection (start a process through the host's spawn,
 * prepare an HTTP session, open a WebSocket),
 * - sending raw newline-delimited JSON-RPC messages,
 * - delivering received raw JSON-RPC messages to a registered handler,
 * - notifying the core when the connection closes unexpectedly,
 * - cleaning up its underlying resource on `close`.
 *
 * Transports do NOT understand JSON-RPC; they only move bytes. The core does
 * all framing, correlation, timeouts, and protocol logic.
 */

export type McpTransportType = "stdio" | "http" | "websocket";

/** The central-log category of the MCP transports (a configured debug category, shared with the web host's MCP runtime). */
export const MCP_LOG_CATEGORY = "mcp-runtime";

/**
 * The host's process starter for a stdio server. The MCP module holds NO
 * process capability of its own: the host supplies this (the web host's is
 * the confinement owner's planned spawn), so an MCP server can only ever be
 * started the way the host decided.
 */
export type McpSpawn = (command: string, args: readonly string[], options: Readonly<{
  cwd: string;
  env: Readonly<Record<string, string>>;
  stdio: readonly ["pipe", "pipe", "pipe"];
}>) => unknown;

export interface McpTransport {
  /** Stable transport label for diagnostics + signals. */
  readonly transportType: McpTransportType;
  /** True after a successful `connect` and before `close` or an unexpected close. */
  readonly isConnected: boolean;
  /** Establish the underlying connection (spawn / fetch / WS open). */
  connect(signal?: AbortSignal): Promise<void>;
  /** Send a single raw JSON-RPC message (already serialized by the core). */
  send(raw: string, options?: McpSendOptions): Promise<void>;
  /** Register the single message handler. Calling twice replaces the handler. */
  onMessage(handler: (raw: string) => void): void;
  /** Register the single close handler (unexpected close or `close`). */
  onClose(handler: () => void): void;
  /** Tear down the underlying resource. Idempotent. */
  close(): Promise<void>;
  /** What the peer last said about itself (stdio: its stderr tail), for an unexpected close's reason. */
  closeReason?(): string | undefined;
}

/** Per-message send options, from the core. */
export type McpSendOptions = Readonly<{
  /** The caller's cancellation. */
  signal?: AbortSignal | undefined;
  /**
   * Present when the message is a REQUEST: true once the core holds its
   * response. A transport that can lose a response mid-exchange (Streamable
   * HTTP, whose server may close an event stream early) keeps resuming until
   * this says the response arrived; the others ignore it.
   */
  answered?: (() => boolean) | undefined;
}>;

/** Shared bound options for every transport factory. */
export type McpTransportFactoryOptions = Readonly<{
  /**
   * Milliseconds closing a server may take: a stdio child's grace to honour
   * SIGTERM before SIGKILL, a remote session's closing DELETE. Resolved by
   * the factory from the module config's default when the caller does not
   * set it.
   */
  closeGraceMs?: number;
  /** Bytes of a stdio server's stderr kept for its close reason (the module config's default when unset). */
  stderrTailBytes?: number;
  /** stderr lines per second, per stdio server, handed to `onStderr` (the module config's default when unset). */
  stderrLinesPerSecond?: number;
  /** The ceiling on a server-sent SSE `retry` (the module config's default when unset). */
  sseRetryMaxMs?: number;
  /** Resumes of one request's closed-early stream (the module config's default when unset). */
  resumeAttempts?: number;
  /** Server-sent requests waiting for an answer at once (the module config's default when unset). */
  serverRequestBacklog?: number;
  /** The host's sink for each stdio stderr line. */
  onStderr?: (serverId: string, line: string) => void;
  /** The Streamable HTTP resume delay when the server names none (the module config's default when unset). */
  sseReconnectMs?: number;
}>;
