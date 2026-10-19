/**
 * Streamable HTTP MCP transport (`transport: "http"`) — the MCP 2025-11-25
 * remote transport, and the ONLY http one (the retired HTTP+SSE transport is
 * not implemented).
 *
 * Every request leaves through the one outbound HTTP policy
 * (`shared/outbound-http.ts`): redirects are refused, never followed (a
 * followed redirect re-sent `X-API-Key` and `Mcp-Session-Id` to another host,
 * SEC-V-1), TLS is verified, a cleartext non-loopback endpoint is refused or
 * warned per the door's one `network.cleartextRemote`, operator headers are
 * allowlisted, every body read is bounded and every unread body let go through
 * the door's `discardBody`. This module holds no fetch options and no
 * transport of its own.
 *
 * Every JSON-RPC message is one POST to the server's single endpoint:
 *
 *   - `Content-Type: application/json` and `Accept: application/json,
 *     text/event-stream` on every POST (the spec's MUST). Operator headers
 *     never override protocol headers.
 *   - 202 Accepted (a notification or a response) carries no body: a no-op.
 *   - `application/json` is one message; `text/event-stream` is framed by the
 *     harness's one SSE parser (`runtime/sse-parser.ts`) over the policy's
 *     bounded body decoder, and every non-empty `data` event is one message
 *     (the priming event, an id with an empty `data`, only moves the resume
 *     cursor). Any other content type is a typed refusal.
 *   - RESUMPTION (spec "Sending Messages" §6, "Resumability"): when the
 *     event stream of a POST that carried a REQUEST ends before that
 *     request's response arrived, the server closed the connection without
 *     ending the stream. The transport then polls: after the stream's last
 *     `retry` (clamped to [`tools.mcp.sseReconnectMs`, `sseRetryMaxMs`];
 *     the floor when the server sent none) it GETs the endpoint with
 *     `Accept: text/event-stream` and `Last-Event-ID`, and repeats until the
 *     response arrives, `tools.mcp.resumeAttempts` resumes are spent, or the
 *     request's timeout ends.
 *     A 405 is `mcp_resume_unsupported`; a stream that ends with no event id
 *     to resume from is `mcp_stream_ended_without_response`. The standalone
 *     GET listening stream (a spec MAY) is not opened: every message the
 *     harness expects answers one of its own requests.
 *   - Session: an `MCP-Session-Id` the server returns is sent on every later
 *     request. A 404 on a request that carried it means the session is gone:
 *     retryable AND transport-level, so the registry's reconnect initializes
 *     a new session. `close()` ends the session with a best-effort DELETE.
 *   - `MCP-Protocol-Version: <negotiated>` on every request after the first.
 *
 * The transport moves messages; the core owns JSON-RPC (correlation, server
 * requests, cancellation, timeouts, the version handshake) and tells the
 * transport, per send, whether the message still awaits its response.
 */

import { McpError } from "../errors.ts";
import { CONTENT_TYPE_JSON } from "../../kernel/contracts.ts";
import { ROOT_POLICY } from "../../kernel/root-policy.ts";
import { abortableDelay, deadline } from "../../shared/abort-signals.ts";
import { bestEffortAsync } from "../../shared/best-effort.ts";
import { guarded } from "../../process/fault-policy.ts";
import { CONTENT_TYPE_SSE, decodeReadableStream, discardBody, outboundFetch, readBody } from "../../shared/outbound-http.ts";
import { OPERATOR_OWNER, privateAddressesAllowedFor } from "../../shared/outbound-policy.ts";
import { parseSseStream } from "../../runtime/sse-parser.ts";
import { MCP_LOG_CATEGORY, type McpSendOptions, type McpTransport } from "./types.ts";

/**
 * Bound on one exchange's whole response body (one answer plus any server
 * messages before it). An MCP answer is a tool result the harness holds in
 * memory for the model, so the tool-memory bound is the right one: a body
 * larger than a tool may hold could never be used.
 */
const MAX_RESPONSE_BODY_BYTES = ROOT_POLICY.runtime.limits.maximumToolMemoryBytes;
const HTTP_ACCEPTED = 202;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_SERVER_ERROR = 500;
const SESSION_HEADER = "mcp-session-id";

export type StreamableHttpTransportConfig = Readonly<{
  url: string;
  headers?: Readonly<Record<string, string>>;
  timeoutMs: number;
  /** The protocol version the core negotiates; sent after `initialize`. */
  protocolVersion: string;
  /** The resume delay when the server's stream carried no `retry` field — and the floor under one it did. */
  sseReconnectMs: number;
  /** The ceiling on a server-sent `retry`. */
  sseRetryMaxMs: number;
  /** Resumes of one request's closed-early stream before it fails. */
  resumeAttempts: number;
  /** The bound on the closing DELETE of a session (the module's close grace). */
  closeGraceMs: number;
}>;

/** A Last-Event-ID the transport may send back: visible ASCII (a header value). */
const RESUMABLE_EVENT_ID = /^[\x21-\x7e]+$/u;

/** Where a resumable stream stands: the last event id and the server's last `retry`. */
type StreamCursor = { lastEventId: string | undefined; retryMs: number | undefined };

export function createStreamableHttpTransport(
  config: StreamableHttpTransportConfig,
): McpTransport {
  let connected = false;
  let initialized = false;
  let sessionId: string | undefined;
  let messageHandler: ((raw: string) => void) | undefined;
  /** One message to the core, guarded (SCALE-CR1 C3): a fault in the core never fails the exchange that carried it. */
  const deliverMessage = guarded("mcp.http.message", (raw: string) => { messageHandler?.(raw); });

  /** Protocol headers: the negotiated version and the session once known, then the exchange's own. */
  function protocolHeaders(extra: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
    return {
      ...(initialized ? { "MCP-Protocol-Version": config.protocolVersion } : {}),
      ...(sessionId !== undefined ? { "Mcp-Session-Id": sessionId } : {}),
      ...extra,
    };
  }

  function request(method: "GET" | "POST" | "DELETE", extra: Readonly<Record<string, string>>, signal: AbortSignal, body?: string): Promise<Response> {
    return outboundFetch({
      url: config.url, method, signal, body,
      operatorHeaders: config.headers,
      protocolHeaders: protocolHeaders(extra),
      // An MCP server is configured by an admin (global, never a user's own
      // choice), so its address — a local server included — is theirs.
      allowPrivateAddress: privateAddressesAllowedFor(OPERATOR_OWNER),
      logCategory: MCP_LOG_CATEGORY,
    });
  }

  /** The status checks every exchange shares (session expiry, HTTP errors). */
  async function admit(response: Response, carriedSession: boolean): Promise<void> {
    if (response.status === HTTP_NOT_FOUND && carriedSession) {
      await discardBody(response, MCP_LOG_CATEGORY, config.closeGraceMs);
      sessionId = undefined;
      throw new McpError("MCP session expired (the server answered 404 to the session)", "mcp_session_expired", true, { status: HTTP_NOT_FOUND }, true);
    }
    if (!response.ok) {
      await discardBody(response, MCP_LOG_CATEGORY, config.closeGraceMs);
      throw new McpError(
        `MCP HTTP transport returned ${response.status}`,
        "mcp_http_error",
        response.status >= HTTP_SERVER_ERROR,
        { status: response.status },
      );
    }
  }

  async function deliverStream(body: ReadableStream<Uint8Array>, signal: AbortSignal, cursor: StreamCursor): Promise<void> {
    for await (const event of parseSseStream(decodeReadableStream(body, signal, MAX_RESPONSE_BODY_BYTES, config.timeoutMs, MCP_LOG_CATEGORY), null)) {
      if (event.type !== "data") continue;
      if (event.id !== undefined) cursor.lastEventId = event.id;
      if (event.retry !== undefined) cursor.retryMs = event.retry;
      if (event.data.length > 0) deliverMessage(event.data);
    }
  }

  /** Deliver one POST answer; returns the stream cursor when the answer was an event stream. */
  async function deliver(response: Response, signal: AbortSignal): Promise<StreamCursor | undefined> {
    if (response.status === HTTP_ACCEPTED) return undefined;
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (contentType.startsWith(CONTENT_TYPE_SSE)) {
      const cursor: StreamCursor = { lastEventId: undefined, retryMs: undefined };
      if (response.body !== null) await deliverStream(response.body, signal, cursor);
      return cursor;
    }
    if (contentType.startsWith(CONTENT_TYPE_JSON)) {
      const text = await readBody(response, signal, MAX_RESPONSE_BODY_BYTES, config.timeoutMs, MCP_LOG_CATEGORY);
      if (text.trim().length > 0) deliverMessage(text);
      return undefined;
    }
    // A body we cannot frame is a protocol refusal, not an empty answer —
    // except the empty 200 some servers send for a notification.
    const text = await readBody(response, signal, MAX_RESPONSE_BODY_BYTES, config.timeoutMs, MCP_LOG_CATEGORY);
    if (text.length === 0) return undefined;
    throw new McpError(
      `MCP Streamable HTTP response has content type '${contentType || "(none)"}'; expected application/json or text/event-stream`,
      "mcp_http_content_type_invalid",
      false,
      { status: response.status },
    );
  }

  /**
   * Poll a POST's stream the server closed early (see the module doc), until
   * the response arrives — at most `resumeAttempts` times, each after the
   * server's `retry` CLAMPED to [`sseReconnectMs`, `sseRetryMaxMs`]: a
   * `retry: 0` once gave ~250 GETs a second, and an overflowing one fired
   * `setTimeout` at 1 ms (secb-security SECB-V-9). An event id that is not
   * visible ASCII cannot be sent back as a header, and is refused typed.
   */
  async function resume(cursor: StreamCursor, answered: () => boolean, signal: AbortSignal): Promise<void> {
    for (let attempt = 0; !answered(); attempt += 1) {
      if (cursor.lastEventId === undefined) {
        throw new McpError("MCP server closed the event stream before the response, with no event id to resume from", "mcp_stream_ended_without_response", true, {}, true);
      }
      if (!RESUMABLE_EVENT_ID.test(cursor.lastEventId)) {
        throw new McpError("MCP server's event id cannot be sent back to resume its stream (it is not visible ASCII)", "mcp_resume_id_invalid", false, {}, true);
      }
      if (attempt >= config.resumeAttempts) {
        throw new McpError(`MCP server closed the event stream before the response ${config.resumeAttempts} times; the request was given up`, "mcp_resume_exhausted", true, { attempts: config.resumeAttempts }, true);
      }
      await abortableDelay(Math.min(Math.max(cursor.retryMs ?? config.sseReconnectMs, config.sseReconnectMs), config.sseRetryMaxMs), signal);
      const carriedSession = sessionId !== undefined;
      const response = await request("GET", { Accept: CONTENT_TYPE_SSE, "Last-Event-ID": cursor.lastEventId }, signal);
      if (response.status === HTTP_METHOD_NOT_ALLOWED) {
        await discardBody(response, MCP_LOG_CATEGORY, config.closeGraceMs);
        throw new McpError("MCP server closed the event stream before the response and does not offer resumption (GET answered 405)", "mcp_resume_unsupported", false, { status: HTTP_METHOD_NOT_ALLOWED }, true);
      }
      await admit(response, carriedSession);
      if (response.body !== null) await deliverStream(response.body, signal, cursor);
    }
  }

  return {
    transportType: "http" as const,
    get isConnected() { return connected; },

    async connect() {
      connected = true;
    },

    async send(raw: string, sendOptions: McpSendOptions = {}) {
      if (!connected) throw new McpError("http transport is not connected", "mcp_not_connected", false, {}, true);
      const exchange = deadline(sendOptions.signal, config.timeoutMs);
      const carriedSession = sessionId !== undefined;
      try {
        const response = await request("POST", { "Content-Type": CONTENT_TYPE_JSON, Accept: `${CONTENT_TYPE_JSON}, ${CONTENT_TYPE_SSE}` }, exchange.signal, raw);
        await admit(response, carriedSession);
        const returnedSession = response.headers.get(SESSION_HEADER);
        if (sessionId === undefined && returnedSession !== null && returnedSession.length > 0) sessionId = returnedSession;
        initialized = true;
        const cursor = await deliver(response, exchange.signal);
        if (cursor !== undefined && sendOptions.answered !== undefined) await resume(cursor, sendOptions.answered, exchange.signal);
      } catch (error) {
        if (exchange.expired()) {
          throw new McpError(`MCP HTTP request timed out after ${config.timeoutMs}ms`, "mcp_timeout", true, {});
        }
        throw error instanceof Error ? error : new McpError(String(error), "mcp_send_failed", true, {}, true);
      } finally {
        exchange.clear();
      }
    },

    onMessage(handler: (raw: string) => void) { messageHandler = handler; },
    onClose(_handler: () => void) { /* each exchange is its own request; there is no connection to drop */ },

    async close() {
      connected = false;
      if (sessionId === undefined) return;
      // Best effort: a server that does not support ending sessions answers
      // 405, and one that is gone cannot be told anything.
      await bestEffortAsync(async () => {
        // Bounded by the close grace, not a request's time limit: a shutdown
        // must not wait a tool-call's bound for a server that is gone (H-6).
        const closing = deadline(undefined, config.closeGraceMs);
        try {
          const response = await request("DELETE", {}, closing.signal);
          await discardBody(response, MCP_LOG_CATEGORY, config.closeGraceMs);
        } finally {
          closing.clear();
          sessionId = undefined;
        }
      });
    },
  };
}
