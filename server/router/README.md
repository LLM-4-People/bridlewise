# Router domain

The router domain owns the HTTP boundary: routing, middleware, outbound
validation, rate limiting, and the server-sent-events transport. Every request
enters through here, and the gates — auth, CSRF, rate limit, error mapping —
are enforced at this choke point, not in each route.

## What each file does

- `router.ts` — the HTTP router and middleware owner: auth, CSRF, rate
  limiting, and the exception-to-status mapping. EVERY request is answered at
  its one dispatch boundary: one catch around the whole of serving it (a
  malformed percent-escape or Host header is a typed 400 parsed INSIDE the
  recording boundary, so it carries its trace id and leaves its refusal row;
  an error that cannot be described is the fixed last-resort 503).
- `http-listener.ts` — the one place the server's socket is created
  (`createHttpListener`): its clocks from the server config
  (`HARNESS_WEB_HEADERS_TIMEOUT_MS`, `HARNESS_WEB_REQUEST_TIMEOUT_MS`,
  `HARNESS_WEB_KEEP_ALIVE_TIMEOUT_MS`; a headers bound past the request bound
  is refused at boot), the API identity header on EVERY answer (set before
  the server's handler runs, and on the parser refusals), and the typed JSON
  answer to a request the HTTP parser itself refuses (`clientError`: 431
  headers too large, 408 timed out, 400 malformed; logged; the connection
  closed) — withheld (the socket only closed) while a response on that
  socket is still open, so a pipelined bad request never writes into a
  streaming answer.
- `egress-failures.ts` — the egress doors' own fallback counts (last-resort
  503s, withheld SSE frames), served as the `privacy.lastResortResponses`
  and `privacy.framesWithheld` signals.
- `validate.ts` — the outbound validation helpers, the trust-boundary
  enforcement layer.
- `rate-limiter.ts` — the token-bucket limiter keyed by identity; the key is
  derived here so a client cannot choose it.
- `sse.ts` — the server-sent-events helper for streaming responses; its
  `send` is the SSE egress door (redaction first; a resumable frame it cannot
  redact is replaced by a `replay_gap` under its id, the stream kept open, and
  a withheld TERMINAL frame is followed by the same terminal event carrying
  the identity alone, so the run still ends for the client). `replayGapFrame`
  is the one gap builder (the run stream's and the door's; reasons from
  `REPLAY_GAP_REASONS`, shared/constants.ts); a stream that sends resumable
  ids must name its gap identity.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `server/router/`.

- `egress-failures.ts` is consumed by `server/index.ts`, `server/router/router.ts`, `server/router/sse.ts`.
- `http-listener.ts` is consumed by `server/index.ts`.
- `rate-limiter.ts` is consumed by `server/blocks/client-telemetry.ts`, `server/router/router.ts`, `server/router/sse.ts`.
- `router.ts` is consumed by `server/auth/user-context.ts`, `server/blocks/arm.ts`, `server/blocks/custody.ts`, `server/blocks/define.ts`, `server/blocks/intelligence.ts`, `server/blocks/provenance.ts` and 32 more.
- `sse.ts` is consumed by `server/index.ts`, `server/routes/live.ts`, `server/routes/run-stream.ts`.
- `validate.ts` is consumed by `server/routes/auto-checks.ts`, `server/routes/awareness.ts`, `server/routes/chats.ts`, `server/routes/config.ts`, `server/routes/editor.ts`, `server/routes/filesystem.ts` and 10 more.

<!-- /consumers:generated -->
