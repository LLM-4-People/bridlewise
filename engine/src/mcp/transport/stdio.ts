/**
 * stdio MCP transport: start a server process and exchange newline-delimited
 * JSON-RPC messages over its stdin/stdout.
 *
 * THE TRANSPORT HOLDS NO PROCESS CAPABILITY. It starts the server only
 * through the host's `spawn` (required), in the host's `cwd`, with exactly
 * the host's `env` — nothing is inherited from this process, and there is no
 * default. The web host's spawn is the confinement owner's planned spawn, so
 * an MCP server runs confined to its own home with an allowlisted
 * environment; a transport that could fall back to `child_process.spawn`
 * would be an unconfined door, and this module has none.
 *
 * STDERR IS ALWAYS DRAINED. A server may log anything to stderr (the spec
 * allows it), and an unread pipe fills (~64 KiB) and then blocks the server's
 * next write — every later call times out. Each line goes to the host's
 * `onStderr` (the web host: its central log), and the last
 * `stderrTailBytes` of it are kept: when the process dies, that tail (a
 * confinement denial, the guardian's refusal, a crash trace) is the reason
 * the transport reports, instead of a bare "transport closed". At most
 * `stderrLinesPerSecond` lines a second reach the host; the rest are counted
 * and reported once a second (a flood is one log line per second, not one per
 * line — secb-security SECB-V-11).
 *
 * STDOUT IS FRAMED IN BOUNDED, LINEAR TIME. A line (one JSON-RPC message) may
 * be at most `MCP_MAX_MESSAGE_BYTES`; bytes are buffered as chunks, only the
 * NEW chunk is searched for the newline, and a line that grows past the bound
 * closes the transport typed (`mcp_message_oversized`) — a server writing
 * without a newline once grew the host to 1.67 GB and burned the web
 * server's event loop re-scanning the whole buffer on every chunk
 * (secb-security SECB-V-2).
 */

import type { ChildProcess } from "node:child_process";

import { extractErrorMessage, HarnessError } from "../../kernel/errors.ts";
import { McpError } from "../errors.ts";
import type { McpSpawn, McpTransport } from "./types.ts";
import { writeWithCallback } from "./helpers.ts";
import { guarded } from "../../process/fault-policy.ts";

export type StdioTransportConfig = Readonly<{
  command: string;
  args?: readonly string[];
  /** The server's working directory — host-resolved, never inherited. */
  cwd: string;
  /** The server's WHOLE environment — host-composed, never inherited. */
  env: Readonly<Record<string, string>>;
  /** The host's process starter (see `McpSpawn`). */
  spawn: McpSpawn;
  /**
   * Milliseconds after SIGTERM before escalation to SIGKILL, per close.
   * Resolved from the module config's default by the factory; explicit here
   * because the transport must never carry a timing constant of its own.
   */
  closeGraceMs: number;
  /** How many bytes of the server's latest stderr are kept for the close reason (the module config's `stderrTailBytes`). */
  stderrTailBytes: number;
  /** stderr lines per second handed to `onStderr`; the rest are counted and reported once a second. */
  stderrLinesPerSecond: number;
  /** The host's sink for each stderr line (bounded to `stderrTailBytes`, rate-limited). */
  onStderr?: (line: string) => void;
  /** The largest message (one stdout line) in bytes — the core's message bound. */
  maxMessageBytes: number;
}>;

/** The window the stderr line budget is counted over. */
const STDERR_WINDOW_MS = 1_000;

export function createStdioTransport(config: StdioTransportConfig): McpTransport {
  let child: ChildProcess | undefined;
  let connected = false;
  let closeRequested = false;
  let messageHandler: ((raw: string) => void) | undefined;
  let closeHandler: (() => void) | undefined;
  /** One message to the core, guarded per line: a fault in one never drops the lines after it in the chunk. */
  const deliver = guarded("mcp.stdio.message", (line: string) => { messageHandler?.(line); });
  /** The current stdout line, as the chunks that make it up (never re-scanned). */
  let lineChunks: Buffer[] = [];
  let lineBytes = 0;
  let oversizedClose: McpError | undefined;
  let stderrPartial = "";
  let stderrTail: string[] = [];
  let stderrTailBytes = 0;
  let stderrWindowStart = 0;
  let stderrWindowLines = 0;
  let stderrDropped = 0;

  /** Hand a line to the host within the per-second budget; report what the budget dropped. */
  function logStderr(line: string): void {
    const now = Date.now();
    if (now - stderrWindowStart >= STDERR_WINDOW_MS) {
      if (stderrDropped > 0) config.onStderr?.(`[${stderrDropped} more stderr lines in the last second were not logged (rate limit)]`);
      stderrWindowStart = now;
      stderrWindowLines = 0;
      stderrDropped = 0;
    }
    if (stderrWindowLines < config.stderrLinesPerSecond) {
      stderrWindowLines += 1;
      config.onStderr?.(line);
    } else {
      stderrDropped += 1;
    }
  }

  /** Keep the newest lines within the byte bound, and hand each to the host. */
  function recordStderr(raw: string): void {
    const line = raw.replace(/\r$/u, "").slice(0, config.stderrTailBytes);
    if (line.length === 0) return;
    logStderr(line);
    stderrTail.push(line);
    stderrTailBytes += Buffer.byteLength(line, "utf8");
    while (stderrTailBytes > config.stderrTailBytes && stderrTail.length > 1) {
      stderrTailBytes -= Buffer.byteLength(stderrTail.shift()!, "utf8");
    }
  }

  function handleStderr(chunk: string): void {
    stderrPartial += chunk;
    const lines = stderrPartial.split("\n");
    stderrPartial = lines.pop() ?? "";
    for (const line of lines) recordStderr(line);
    // A line that never ends is still bounded: flush what the tail can hold.
    if (stderrPartial.length > config.stderrTailBytes) { recordStderr(stderrPartial); stderrPartial = ""; }
  }

  /** Frame stdout by newline: each byte is searched once, and a line is bounded. */
  function handleChunk(data: Buffer | string): void {
    if (oversizedClose !== undefined) return;
    const chunk = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    let start = 0;
    for (let newline = chunk.indexOf(0x0a); newline !== -1; newline = chunk.indexOf(0x0a, start)) {
      if (!appendToLine(chunk.subarray(start, newline))) return;
      const line = Buffer.concat(lineChunks, lineBytes).toString("utf8");
      lineChunks = [];
      lineBytes = 0;
      start = newline + 1;
      if (line.length > 0) deliver(line);
    }
    appendToLine(chunk.subarray(start));
  }

  /** Add bytes to the current line; past the message bound the transport closes, typed. */
  function appendToLine(bytes: Buffer): boolean {
    if (bytes.length === 0) return true;
    lineBytes += bytes.length;
    if (lineBytes > config.maxMessageBytes) {
      lineChunks = [];
      lineBytes = 0;
      oversizedClose = new McpError(
        `MCP server '${config.command}' wrote a message larger than ${config.maxMessageBytes} bytes to stdout; the connection was closed`,
        "mcp_message_oversized", true, { limitBytes: config.maxMessageBytes }, true,
      );
      const proc = child;
      connected = false;
      closeHandler?.();
      if (proc !== undefined && !proc.killed) proc.kill("SIGKILL");
      return false;
    }
    lineChunks.push(Buffer.from(bytes));
    return true;
  }

  return {
    transportType: "stdio" as const,
    get isConnected() { return connected; },

    async connect() {
      if (connected) return;
      if (closeRequested) {
        throw new McpError("stdio transport already closed", "mcp_closed", false, {}, true);
      }
      try {
        child = config.spawn(config.command, [...(config.args ?? [])], {
          stdio: ["pipe", "pipe", "pipe"],
          cwd: config.cwd,
          env: config.env,
        }) as ChildProcess;
      } catch (error) {
        // The host decided not to start this server (its confinement was
        // refused, its command is not there). That is the server's status —
        // typed, with the host's own reason code — never a crash.
        throw new McpError(
          `MCP server command '${config.command}' was not started: ${extractErrorMessage(error)}`,
          "mcp_spawn_refused",
          false,
          error instanceof HarnessError ? { reason: error.code } : {},
          true,
        );
      }
      child.stdout?.on("data", guarded("mcp.stdio.stdout", (chunk: Buffer | string) => handleChunk(chunk)));
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", guarded("mcp.stdio.stderr", (chunk: string) => handleStderr(chunk)));
      // Any stdio/child failure event is reported through the close handler —
      // NEVER by throwing: a throw inside an EventEmitter callback has no
      // caller to catch it and crashes the whole server process (a missing
      // command — an operator typo in the config — would kill the harness).
      // The close handler reports the failure through the registry's signals.
      const failed = guarded("mcp.stdio.failure", () => {
        connected = false;
        closeHandler?.();
      });
      child.stdin?.on("error", failed);
      child.on("error", failed);
      child.on("close", guarded("mcp.stdio.close", () => {
        const wasConnected = connected;
        connected = false;
        if (wasConnected && !closeRequested) closeHandler?.();
      }));
      connected = true;
    },

    async send(raw: string) {
      if (!connected || child?.stdin === undefined) {
        throw new McpError("stdio transport is not connected", "mcp_not_connected", false, {}, true);
      }
      await writeWithCallback(child!, raw);
    },

    onMessage(handler: (raw: string) => void) { messageHandler = handler; },
    onClose(handler: () => void) { closeHandler = handler; },
    closeReason() {
      if (oversizedClose !== undefined) return oversizedClose.message;
      if (stderrPartial.length > 0) { recordStderr(stderrPartial); stderrPartial = ""; }
      return stderrTail.length === 0 ? undefined : stderrTail.join("\n");
    },

    async close() {
      closeRequested = true;
      connected = false;
      const proc = child;
      child = undefined;
      if (proc === undefined || proc.killed) return;
      proc.kill("SIGTERM");
      // Ask politely, then insist: a wedged server must never hold the OS
      // process open, and a healthy one never pays more than its own exit
      // time. The wait is observable only on a real child process — a
      // duck-typed spawn mock without events is best-effort by construction
      // (there is nothing to wait on).
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      if (typeof (proc as { once?: unknown }).once !== "function") return;
      const terminationMs = config.closeGraceMs;
      await new Promise<void>((resolve) => {
        let settled = false;
        // Kept in scope so a close that resolves BEFORE the escalation (the
        // polite child, honoured SIGTERM) cancels the timer outright: an
        // un-cancelled timer still fires at the bound and calls `kill` on a
        // long-closed child — harmless (a closed handle sends nothing), but
        // it is dead work the polite path never needed to schedule.
        let escalate: ReturnType<typeof setTimeout> | undefined;
        const finish = guarded("mcp.stdio.closed", (): void => {
          if (settled) return;
          settled = true;
          if (escalate !== undefined) clearTimeout(escalate);
          resolve();
        });
        // A child exiting on SIGTERM resolves through the close listener.
        // Both timers are unref'd so a pending bound never keeps the host
        // process alive: if the child ignored SIGTERM, SIGKILL is the
        // kernel-guaranteed end, and the final timer bounds the wait for
        // the 'close' event itself (a child whose pipes never close must
        // not hold the caller open either).
        escalate = setTimeout(guarded("mcp.stdio.kill-escalation", () => {
          proc.kill("SIGKILL");
          setTimeout(finish, terminationMs).unref();
        }), terminationMs);
        proc.once("close", finish);
        escalate.unref();
      });
    },
  };
}
