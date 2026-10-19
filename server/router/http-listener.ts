/**
 * THE HTTP LISTENER — the one place the server's socket is created, so its
 * clocks and its answer to a request the HTTP parser itself refuses are
 * owned once (wf1b2-correctness: the server ran on the platform's implicit
 * timeouts, and a request the parser refused — an oversized header block,
 * a malformed request line, a header timeout — got the platform's bare
 * `400 Bad Request` with no body and no log line, the one response in the
 * product with no typed body).
 *
 * - The clocks are the server config's (`headersTimeoutMs`,
 *   `requestTimeoutMs`, `keepAliveTimeoutMs`: `server/kernel/config.ts`).
 * - A parser refusal (`clientError`) is answered, while the socket can still
 *   be written, with the same typed JSON body every other refusal carries
 *   (`{ error, message }`): 431 for a header block too large, 408 for a
 *   request that did not arrive in time, 400 otherwise; the connection is
 *   closed after it. A socket already gone (a reset) is only destroyed, and
 *   so is a socket that still carries an unfinished response (a pipelined
 *   bad request behind a streaming answer: writing a second status line into
 *   that response's body would corrupt it — WF-1b3b verify M1; the platform's
 *   own handler withholds its answer there too). Every refusal is logged
 *   through the one logger.
 * - THE API SIGNS EVERY ANSWER IT GIVES: the identity header
 *   (`API_IDENTITY_HEADER`) is set on every response BEFORE the server's
 *   handler runs — before the loopback check, CORS or the router, so no
 *   path, not even a 403 or an unhandled route's 404, leaves without it —
 *   and the parser-refusal answer carries it too. The client's connection
 *   owner (`src/data/connection.ts`) reads its absence as "something in
 *   front of the API answered"; a path that forgot it would be reported as
 *   an outage that is not happening.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { guarded } from "../kernel/canonical.ts";
import type { Duplex } from "node:stream";

import { webWarn } from "../observability/debug-bridge.ts";
import { API_IDENTITY_HEADER, API_IDENTITY_VALUE, CONTENT_TYPE_JSON } from "../../shared/constants.ts";

export type HttpListenerClocks = Readonly<{ headersTimeoutMs: number; requestTimeoutMs: number; keepAliveTimeoutMs: number }>;

/** How a request the HTTP parser refused is answered: status, reason phrase and the typed body. */
export type ClientErrorAnswer = Readonly<{ status: number; reason: string; body: Readonly<{ error: string; message: string }> }>;

/** The typed answer to a parser refusal, by the parser's error code (pure: a test hands it a code). */
export function clientErrorAnswer(code: string | undefined): ClientErrorAnswer {
  if (code === "HPE_HEADER_OVERFLOW") {
    return { status: 431, reason: "Request Header Fields Too Large", body: { error: "request_headers_too_large", message: "The request's headers are larger than this server accepts." } };
  }
  if (code === "ERR_HTTP_REQUEST_TIMEOUT") {
    return { status: 408, reason: "Request Timeout", body: { error: "request_timeout", message: "The request did not arrive in time." } };
  }
  return { status: 400, reason: "Bad Request", body: { error: "request_malformed", message: "The request could not be parsed as HTTP." } };
}

/** The raw HTTP/1.1 response bytes of a {@link ClientErrorAnswer} (the socket has no response object). */
export function clientErrorResponse(answer: ClientErrorAnswer): string {
  const body = JSON.stringify(answer.body);
  return `HTTP/1.1 ${String(answer.status)} ${answer.reason}\r\n${API_IDENTITY_HEADER}: ${API_IDENTITY_VALUE}\r\nContent-Type: ${CONTENT_TYPE_JSON}\r\nContent-Length: ${String(Buffer.byteLength(body))}\r\nConnection: close\r\n\r\n${body}`;
}

/** Creates the server's one HTTP listener with its clocks and its parser-refusal answer. */
export function createHttpListener(clocks: HttpListenerClocks, handler: (req: IncomingMessage, res: ServerResponse) => void): Server {
  // The responses each socket still carries (opened, not yet closed).
  const openResponses = new WeakMap<Duplex, number>();
  const server = createServer({ headersTimeout: clocks.headersTimeoutMs, requestTimeout: clocks.requestTimeoutMs, keepAliveTimeout: clocks.keepAliveTimeoutMs }, guarded("http.request", (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader(API_IDENTITY_HEADER, API_IDENTITY_VALUE);
    const socket = req.socket;
    openResponses.set(socket, (openResponses.get(socket) ?? 0) + 1);
    res.once("close", guarded("http.response-closed", () => openResponses.set(socket, (openResponses.get(socket) ?? 1) - 1)));
    handler(req, res);
  }));
  server.on("clientError", guarded("http.client-error", (error: NodeJS.ErrnoException, socket: Duplex) => {
    const answer = clientErrorAnswer(error.code);
    const responding = (openResponses.get(socket) ?? 0) > 0;
    webWarn("router", "the HTTP parser refused a request", () => ({ code: error.code ?? "unknown", status: answer.status, answered: !responding }));
    if (error.code === "ECONNRESET" || !socket.writable || responding) {
      socket.destroy();
      return;
    }
    socket.end(clientErrorResponse(answer));
  }));
  return server;
}
