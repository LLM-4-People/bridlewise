/**
 * websocket MCP transport — a CUSTOM transport (the MCP spec allows them):
 * JSON-RPC messages over a WebSocket connection, one text frame per message.
 *
 * The handshake is the OUTBOUND DOOR's (`shared/outbound-http.ts`
 * `openOutboundWebSocket`): the URL passes the same scheme, embedded-
 * credential, TLS-verification and cleartext checks (`ws://` to a
 * non-loopback host is refused or warned per the door's one
 * `network.cleartextRemote`), the configured headers — auth included — pass
 * the same header allowlist, the destination is held to the operator's rule
 * (an MCP server is admin-configured: `privateAddressesAllowedFor(OPERATOR_OWNER)`)
 * and PINNED to the addresses checked, on the door's one client (`undici`).
 * A WebSocket handshake never follows a redirect. The `subprotocol` is
 * offered as `Sec-WebSocket-Protocol`.
 *
 * ONE MESSAGE IS AT MOST `maxMessageBytes` (the core's message bound): the
 * door's dispatcher refuses a larger frame BEFORE it is assembled
 * (`maxPayloadSize`; the platform's default was 128 MiB), and a larger
 * message that still arrives is not delivered (nor is anything after it) —
 * the connection is closed with 4009 — RFC 6455's "message too big" (1009)
 * in the application range, because a client's close accepts only 1000 and
 * 3000-4999 (SECC-V-B8) — and a typed reason (`mcp_message_oversized`).
 */

import { McpError } from "../errors.ts";
import { bestEffort } from "../../shared/best-effort.ts";
import { guarded } from "../../process/fault-policy.ts";
import { openOutboundWebSocket } from "../../shared/outbound-http.ts";
import { OPERATOR_OWNER, privateAddressesAllowedFor } from "../../shared/outbound-policy.ts";
import { MCP_LOG_CATEGORY, type McpTransport } from "./types.ts";
import { debugLog } from "../../shared/debug/debug-system.ts";

export type WebSocketTransportConfig = Readonly<{
  url: string;
  headers?: Readonly<Record<string, string>>;
  subprotocol?: string;
  timeoutMs: number;
  /** The largest message delivered to the core, in bytes. */
  maxMessageBytes: number;
}>;

/**
 * RFC 6455 §7.4.1's 1009 ("message too big") in the application range
 * (4000-4999): the only codes a client may send are 1000 and 3000-4999.
 */
const WS_CLOSE_MESSAGE_TOO_BIG = 4009;
/** RFC 6455 §7.4.1 1006: the connection was closed abnormally (no close frame reached the application). */
const RFC_ABNORMAL_CLOSURE = 1006;

export function createWebSocketTransport(config: WebSocketTransportConfig): McpTransport {
  let ws: WebSocket | undefined;
  let connected = false;
  let closeRequested = false;
  let messageHandler: ((raw: string) => void) | undefined;
  let closeHandler: (() => void) | undefined;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  const pendingOpen: Array<() => void> = [];
  let openError: Error | undefined;
  let oversized: McpError | undefined;
  let failedAfterOpen = false;

  return {
    transportType: "websocket" as const,
    get isConnected() { return connected; },

    async connect(signal?: AbortSignal) {
      if (connected) return;
      const socket = await openOutboundWebSocket({
        url: config.url,
        operatorHeaders: config.headers,
        subprotocol: config.subprotocol,
        allowPrivateAddress: privateAddressesAllowedFor(OPERATOR_OWNER),
        maxMessageBytes: config.maxMessageBytes,
        logCategory: MCP_LOG_CATEGORY,
      });
      await new Promise<void>((resolve, reject) => {
        ws = socket;
        openTimer = setTimeout(guarded("mcp.websocket.open-timeout", () => {
          if (!connected) {
            bestEffort(() => ws?.close());
            reject(new McpError(`MCP WebSocket open timed out after ${config.timeoutMs}ms`, "mcp_timeout", true, {}));
          }
        }), config.timeoutMs);

        ws.addEventListener("open", guarded("mcp.websocket.open", () => {
          if (openTimer !== undefined) clearTimeout(openTimer);
          openTimer = undefined;
          connected = true;
          while (pendingOpen.length > 0) pendingOpen.shift()!();
          resolve();
        }));
        ws.addEventListener("message", guarded("mcp.websocket.message", (event: MessageEvent) => {
          // Nothing after an oversized message is delivered: the connection is closing.
          if (oversized !== undefined) return;
          const raw = typeof event.data === "string" ? event.data : String(event.data);
          if (Buffer.byteLength(raw, "utf8") > config.maxMessageBytes) {
            oversized = new McpError(
              `MCP WebSocket server sent a message larger than ${config.maxMessageBytes} bytes; the connection was closed`,
              "mcp_message_oversized", true, { limitBytes: config.maxMessageBytes }, true,
            );
            debugLog(MCP_LOG_CATEGORY, "warn", "mcp_message_oversized", () => ({ limitBytes: config.maxMessageBytes }));
            // Not best-effort: a close the platform refused would leave the
            // connection open while the core believes it closed.
            ws?.close(WS_CLOSE_MESSAGE_TOO_BIG, "message too big");
            return;
          }
          messageHandler?.(raw);
        }));
        ws.addEventListener("close", guarded("mcp.websocket.close", (event: CloseEvent) => {
          // A connection the client's protocol layer FAILED after an error
          // (1006, unclean): the door's dispatcher refused a frame past the
          // message bound BEFORE assembling it (`maxPayloadSize`; it sends
          // the peer 1009) or the peer broke the protocol — said as such.
          if (connected && !event.wasClean && event.code === RFC_ABNORMAL_CLOSURE && failedAfterOpen && oversized === undefined) {
            oversized = new McpError(
              `MCP WebSocket connection failed: the server sent a frame past the message bound (${config.maxMessageBytes} bytes, refused before it was assembled) or broke the protocol`,
              "mcp_websocket_error", true, { limitBytes: config.maxMessageBytes }, true,
            );
          }
          const wasConnected = connected;
          connected = false;
          if (openTimer !== undefined) { clearTimeout(openTimer); openTimer = undefined; }
          if (openError !== undefined) { reject(openError); openError = undefined; return; }
          if (wasConnected && !closeRequested) closeHandler?.();
          if (!connected) resolve();
        }));
        ws.addEventListener("error", guarded("mcp.websocket.error", (event: Event) => {
          // `ErrorEvent` is a DOM type; under a Node-only lib target it is
          // absent, so read the message structurally (the event a WebSocket
          // error listener receives carries it on every runtime we support).
          const message = (event as { message?: unknown }).message;
          // Only an error BEFORE the open fails the connect. After it, the
          // platform reports a dropped connection as error-then-close, and
          // the close must still tell the core (it used to be swallowed as
          // an "open error", so the core never learned the server was gone).
          if (connected) {
            failedAfterOpen = true;
            debugLog(MCP_LOG_CATEGORY, "warn", "mcp_websocket_error", () => ({ message: typeof message === "string" ? message : "unknown" }));
            return;
          }
          openError = new McpError(`MCP WebSocket error: ${typeof message === "string" ? message : "unknown"}`, "mcp_websocket_error", false, {}, true);
        }));
        if (signal !== undefined) {
          if (signal.aborted) {
            bestEffort(() => ws?.close());
            reject(new McpError("MCP WebSocket connect cancelled", "mcp_cancelled", false));
          } else {
            signal.addEventListener("abort", guarded("mcp.websocket.abort", () => {
              bestEffort(() => ws?.close());
            }), { once: true });
          }
        }
      });
    },

    async send(raw: string) {
      if (!connected || ws === undefined) {
        throw new McpError("websocket transport is not connected", "mcp_not_connected", false, {}, true);
      }
      // If the socket is in CONNECTING state, queue the send until open.
      if (ws.readyState === 0) {
        await new Promise<void>((resolve) => pendingOpen.push(resolve));
      }
      ws.send(raw);
    },

    onMessage(handler: (raw: string) => void) { messageHandler = handler; },
    onClose(handler: () => void) { closeHandler = handler; },
    closeReason() { return oversized?.message; },

    async close() {
      closeRequested = true;
      connected = false;
      if (openTimer !== undefined) { clearTimeout(openTimer); openTimer = undefined; }
      if (ws !== undefined) {
        const wsClose = ws;
        bestEffort(() => wsClose.close());
      }
      ws = undefined;
      // Do NOT fire closeHandler on explicit close — the core already knows.
    },
  };
}
