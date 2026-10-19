/**
 * Shared web-UI protocol + schema constants — the single source of truth for
 * literals consumed by more than one module (server routes, the zod schemas,
 * and the client fetch wrapper).
 *
 * The web UI is intentionally independent from the harness runtime
 * (`server/errors.ts` owns its own typed-error hierarchy for the same
 * reason), so these constants live here rather than being imported from the
 * harness `src/contracts.ts`. Each constant has exactly one owner (this
 * file); every other module imports from here and never re-declares the
 * literal inline (prevention rule: no-duplicated-string-literals).
 *
 * @config-owner
 */

/** HTTP content type for JSON responses/requests. */
export const CONTENT_TYPE_JSON = "application/json" as const;

/**
 * Maximum length (in characters) of a path/text string accepted by the zod
 * schemas. A server-side validation limit, not env-overridable (it is a fixed
 * contract of the persisted schemas).
 */
export const MAX_PATH_LENGTH = 4096;

/**
 * Maximum length (in characters) of a file/directory entry name when listing
 * a project tree. Entries with longer names are filtered out of the tree (not
 * an error — just hidden) so a pathological directory does not flood the UI.
 * Single owner; consumed by project-context.ts and file-tree.ts.
 */
export const MAX_FILE_NAME_LENGTH = 256;

/**
 * Maximum length (in characters) of a user-supplied prompt or message
 * content string accepted by the zod schemas. A server-side validation
 * limit shared by the run-start, steer, message-create, and memory-store
 * schemas so a single owner caps every user-content surface (defense-in-
 * depth under the global maxBodyBytes cap). Not env-overridable (a fixed
 * contract of the persisted schemas).
 */
export const MAX_PROMPT_LENGTH = 1_048_576;

/**
 * Maximum length (in characters) of file content accepted by the editor
 * write/edit/create schemas. A server-side validation limit shared by every
 * editor mutation route so one owner caps the file-content surface.
 * Not env-overridable.
 */
export const MAX_FILE_CONTENT_LENGTH = 10_485_760;

// ── SSE event types (Single-Party-Owner ) ──
//
// The SSE event-type registry is the SINGLE source of truth for the wire
// names of every Server-Sent Event the harness emits (server → client).
// BOTH the server stream (`server/sse.ts` → `server/routes/run.ts`) AND
// the client parser (`src/client.ts`) import from this owner — there is
// no second declaration of an event-type literal anywhere. This closes
// the drift class: before  the route used string literals
// (`stream.send("model", …)`) and the client mirrored them
// (`addEventListener("model", …)`) with NO shared contract, so adding a
// server event without a client listener (or a typo) silently broke the
// wire with no compile-time or runtime signal.
//
// Deny-by-default: the stream's `send` accepts ONLY a
// `SseEventType` (a union of the values below). An unregistered event
// type is a compile-time error (TypeScript) + a runtime no-op (the
// `isKnownSseEventType` guard in `server/sse.ts`) — a typo cannot leak
// an event the client never listens for. To add a new event type, add
// ONE entry here; the server `send` + the client `addEventListener`
// reference it by name, so both sides update together.

/**
 * Canonical SSE event-type registry. The keys are stable internal names;
 * the values are the wire strings sent on the `event:` line. Keyed by a
 * descriptive name (camelCase) so call sites read `SSE_EVENT_TYPES.toolResult`
 * instead of the raw wire string `"tool_result"` — the wire string appears
 * in exactly ONE place (here), never scattered as a literal.
 */
export const SSE_EVENT_TYPES = {
  /** Run stream opened; carries runId + harnessReady + chatId. */
  connected: "connected",
  /** Injected context snapshot (system prompt, tools, history, tokens). */
  context: "context",
  /** Out-of-band metadata (response headers, actual model). */
  metadata: "metadata",
  /** A model streaming event (text/reasoning/tool_call/usage/finish). */
  model: "model",
  /** Hallucination-gate rejection (ghost tool / schema mismatch). */
  hallucination: "hallucination",
  /** Event-feed safety detector report (workaround / bandaid / step-skip /
   * deviation findings) published at run end. Real detector verdicts only —
   * a run whose detectors are disarmed reports that honestly instead. */
  safetyFindings: "safety_findings",
  /**
   * The run is paused because the investigation needs a user action
   * (install/configure something, or confirm a deviation). The payload
   * carries the pause-ask message; the existing steer route is the answer
   * channel. Not terminal — the run resumes when the user steers.
   */
  pauseAsk: "pause_ask",
  /** Server-side tool execution result (output, success, attempt). */
  toolResult: "tool_result",
  /** LLM-requested UI mutation (set_tab / toggle_panel / set_theme). */
  uiControl: "ui_control",
  /** Stream-level error (also fires natively on EventSource disconnect). */
  error: "error",
  /** A steering message was consumed; a new turn is starting. */
  steered: "steered",
  /** Post-run codebase quality snapshot (score, grade, issues). */
  quality: "quality",
  /** Terminal signal: ALL turns complete (client closes the stream). */
  done: "done",
  /** TERMINAL SIGNAL: THE RUN WAS STOPPED ON PURPOSE, and what you have is
   *  all of it.
   *
   *  Neither of the other two terminal frames can carry this fact. `done`
   *  says "all turns complete", which is false — the turns were interrupted,
   *  and telling a reader the answer finished is a fabricated completion.
   *  `error` says the run FAILED and renders as a fault, which is false the
   *  other way: nothing went wrong, a person pressed stop. Reporting a
   *  deliberate stop as either is a wrong statement about what happened, so
   *  cancellation is its own frame.
   *
   *  It exists because a cancelled run used to publish NO terminal frame at
   *  all. The feed ended, the server closed the socket, and — per the
   *  EventSource protocol — a server-closed stream is a RECONNECT. The client
   *  closes only on a terminal frame, so it reconnected, replayed the run's
   *  `model` `start`, appended one more empty assistant bubble, and did it
   *  again for the whole retention window. A missing terminal frame is not a
   *  quiet omission; it is a loop. */
  cancelled: "cancelled",
  /** FRAMES THIS SUBSCRIBER MISSED AND CANNOT BE SHOWN.
   *
   *  A run's frames are held in a bounded replay buffer. A subscriber that
   *  reconnects asking for a sequence older than the buffer still holds has a
   *  real gap in what it can be told, and this says so — carrying the highest
   *  sequence that is gone, so the client can state the gap rather than
   *  render a stream that silently skips.
   *
   *  It is NOT an `error` frame, and the distinction is deliberate: the run
   *  did not fail. An `error` frame means the run failed and the client
   *  closes the stream on one, so reporting a buffer eviction that way would
   *  end a healthy run and name a cause that never happened — a fabricated
   *  failure. Nothing else registered here can carry "your view has a hole in
   *  it, the run is fine". */
  replayGap: "replay_gap",
  /** A durable timeline ledger event for this run. */
  timeline: "timeline",
  /** A real agent-state update for this run. */
  agent: "agent",
  /** LLM-input dedup stats (char reduction, removed blocks). */
  dedup: "dedup",
  /** WHAT WAS MASKED BEFORE THE MODEL SAW IT, and why.
   *
   *  Redaction rewrites the model's input on the user's behalf. Without this
   *  event that rewrite is invisible: the user cannot tell a value was
   *  hidden, cannot tell WHICH value, and cannot tell whether the redactor
   *  was right — which is the difference between a safety feature and
   *  content silently going missing.
   *
   *  Carries counts SPLIT BY CONFIDENCE and a value-free reason per span. It
   *  never carries any part of what was masked; a preview of a secret is the
   *  secret. Fires only when something was actually masked. */
  redaction: "redaction",
  /** THE STANDING LIVENESS STREAM's heartbeat (`/api/live`).
   *
   *  The ONLY event that stream sends. There is no separate "hello": the
   *  EventSource protocol already fires `open` when the connection is
   *  established, so a hello event would be a second announcement of a fact
   *  the browser had already reported.
   *
   *  A REAL EVENT, NOT AN SSE COMMENT, and the difference is the whole point.
   *  `server/sse.ts` already writes `: keepalive` comments, which keep
   *  intermediaries from closing an idle socket — but a comment fires NOTHING
   *  in the browser, so JavaScript cannot observe it. The liveness stream
   *  needs the client to SEE the beat, because a server whose event loop has
   *  wedged still holds its socket open: the connection looks perfect and no
   *  bytes arrive. Silence is the only symptom, and you cannot notice silence
   *  you were never able to hear. */
  ping: "ping",
} as const;

/**
 * WHY A `replay_gap` WAS SENT — the one vocabulary the server's builder
 * (`replayGapFrame`, server/router/sse.ts) writes and the client reads:
 *
 * - `frames_dropped`: the bounded replay buffer no longer holds what a
 *   resuming subscriber asked for;
 * - `resume_point_ahead_of_run`: the subscriber asked to resume past
 *   everything the run ever published;
 * - `frame_unredactable`: ONE frame the egress door could not redact was
 *   withheld (nothing unredacted leaves) and the gap stands in its place.
 */
export const REPLAY_GAP_REASONS = ["frames_dropped", "resume_point_ahead_of_run", "frame_unredactable"] as const;

/** The union of the reasons a `replay_gap` carries. */
export type ReplayGapReason = (typeof REPLAY_GAP_REASONS)[number];

/**
 * The union of all registered SSE wire event names. The stream `send`
 * function + the client `addEventListener` accept only this type, so a
 * typo or an unregistered event is caught at compile time.
 */
export type SseEventType = (typeof SSE_EVENT_TYPES)[keyof typeof SSE_EVENT_TYPES];

/**
 * Runtime deny-by-default guard: true only for a registered event type.
 * Defense-in-depth at the stream choke point (`server/sse.ts`) — the
 * compile-time type is the primary gate; this catches a non-TS caller or
 * a dynamically-constructed string.
 */
export function isKnownSseEventType(value: string): value is SseEventType {
  return (Object.values(SSE_EVENT_TYPES) as readonly string[]).includes(value);
}

// ── WHICH FRAMES MEAN "THIS RUN HAS STOPPED PRODUCING" ─────────────────────
//
// One owner, both sides, for the same reason the event registry itself has
// one: the server decides a run has ended and the client decides to stop
// listening, and those two decisions have to be the SAME decision.
//
// They were not. The server ended the feed and closed the socket on every
// exit path; the client closed its `EventSource` on `done` alone. So a run
// that ended any other way left a client that — per the EventSource protocol
// — treats a server-closed stream as a reconnect. It reconnected, was
// replayed the retained feed, re-ingested the run's `model` `start`, appended
// another empty assistant bubble, and repeated for the whole retention
// window. The retention window is what makes a missing terminal frame REPEAT
// rather than merely fail once, which is why "the client only knows about
// `done`" stopped being survivable.
//
// Membership is a claim about MEANING, not about severity: each of these
// three says the run will publish nothing further. A frame that reports
// something ABOUT a run still in flight (`replay_gap`, `steered`, `quality`)
// is not here, and must not be — closing on one would end a healthy run.

/**
 * The frames after which a run publishes nothing further. The server may not
 * end a feed without one (`server/run-feed.ts` takes this type, so ending a
 * feed silently is a compile error), and the client closes its stream on any
 * of them (`src/client.ts`).
 */
export const TERMINAL_SSE_EVENT_TYPES = [
  SSE_EVENT_TYPES.done,
  SSE_EVENT_TYPES.cancelled,
  SSE_EVENT_TYPES.error,
] as const;

/** The union of the frames that end a run. */
export type TerminalSseEventType = (typeof TERMINAL_SSE_EVENT_TYPES)[number];

/** True only for a frame that means the run has stopped producing. */
export function isTerminalSseEventType(value: string): value is TerminalSseEventType {
  return (TERMINAL_SSE_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * THE TERMINAL FRAME THAT STANDS IN FOR A WITHHELD ONE — when the egress
 * door cannot redact a run's `done`/`cancelled`/`error` frame it withholds it
 * (a `replay_gap` with reason `frame_unredactable` takes its place) and then
 * sends the same terminal event in this shape, so the run still ends for the
 * client. It keeps only the plain, non-sensitive facts: the stream's identity
 * (`runId`), `autoTripsReverted` (UIE-041), and for `error` a taxonomy
 * `code` (the original's when the taxonomy knows it, else `frame_withheld`)
 * and a fixed `message` — the SSE error contract. Built by ONE builder
 * (`withheldTerminalFrame`, server/router/sse.ts).
 */
export type WithheldTerminalFrame = Readonly<{
  runId?: string;
  withheld: Extract<ReplayGapReason, "frame_unredactable">;
  autoTripsReverted?: true;
  code?: string;
  message?: string;
}>;

// ── CSRF custom header (Single-Party-Owner ) ──
//
// The CSRF custom-header name is the SINGLE source of truth for the
// opt-in header the server's stateless CSRF guard accepts (defense 2 in
// `server/csrf.ts`: same-origin OR a non-empty custom header). BOTH the
// server guard (`server/csrf.ts`) AND the client fetch wrapper
// (`src/client.ts` → `fetchJson`) import from this owner — there is no
// second declaration of the header name anywhere. Before  the client
// did NOT send this header at all; it relied solely on the browser's
// automatic `Origin` header (defense 1). That worked for same-origin
// deployments but left the CSRF guard's custom-header defense INERT — a
// reverse-proxy deployment where the dashboard origin differs from the
// API origin would have failed the same-origin check AND lacked the
// custom-header fallback, blocking every mutation. centralizes the
// header at the fetch choke point so every call gets it automatically
// (the whole point of the single fetch owner — a future CSRF token
// rotation is added in ONE place, not at each call site).

/**
 * The CSRF custom-header name. Sent by the client fetch wrapper on EVERY
 * request (any non-empty value — presence is the signal). Lowercase per
 * Node's header normalization; the browser's `fetch` Headers API
 * preserves case but the server reads via `req.headers[name]` which is
 * case-insensitive. The server guard accepts any non-empty value.
 */
export const CSRF_CUSTOM_HEADER = "x-requested-with";

/**
 * The API's identity header, stamped on EVERY response the API server
 * itself produces (`server/index.ts`, at the top of the one request
 * handler — before the loopback check, before CORS, before the router).
 *
 * WHY A HEADER AND NOT A STATUS CODE. The client has to answer one
 * question exactly: *did the API answer, or did something in front of it
 * answer for it?* A status code cannot answer it. The Vite dev proxy
 * synthesizes `502 Bad Gateway` when the upstream socket is refused
 * (browser-measured: 502, `text/plain`, empty body, 5ms), and the API
 * ITSELF also returns 502 legitimately — `shared/errors.ts` maps an
 * upstream provider failure to 502 with the comment "502 is the honest
 * status: this side worked". Keying "unreachable" on the number would
 * therefore call a working server offline every time a model provider
 * failed, which is a fabricated absence in the other direction.
 *
 * Presence of this header is the whole signal, and it is unforgeable in
 * the direction that matters: a proxy that cannot reach the API cannot
 * mint a header the API never sent. A response WITH it means the API
 * answered (any status, including 401 and 500 — see
 * `src/data/connection.ts`). A response WITHOUT it means the API was
 * not reached.
 *
 * Lowercase per Node's header normalization; `Headers.get` is
 * case-insensitive on the client side.
 */
export const API_IDENTITY_HEADER = "x-harness-api";

/**
 * THE STANDING LIVENESS STREAM's path — one owner, both sides.
 *
 * The server mounts it (`server/routes/live.ts`, public) and the client
 * opens it (`src/client.ts::openLivenessStream`). A duplicated literal here
 * would be a client that permanently cannot reach a server that is fine.
 */
export const LIVE_STREAM_PATH = "/api/live";

/**
 * What the server tells the browser to wait before reconnecting the liveness
 * stream, written into the stream as SSE's own `retry:` field.
 *
 * THIS IS WHY THERE IS NO POLLING. `retry:` is part of the EventSource
 * protocol: the browser stores it and, whenever the connection drops,
 * reconnects on that cadence BY ITSELF — including while the server is down,
 * because the value it is using was received before the outage. So recovery
 * is detected by the browser's own reconnect succeeding, not by the page
 * asking every second whether the server is back.
 *
 * IT BOUNDS DETECTION AS WELL AS RECOVERY, which is not obvious and was
 * measured the hard way. A server that is SIGKILLed drops its socket abruptly
 * and the browser reports the error at once (browser-measured: 33ms). A server
 * shut down GRACEFULLY ends its streams cleanly — which is the correct thing
 * for it to do, and which the browser reads as a normal end-of-stream, so it
 * waits this long before trying again and only then discovers the server is
 * gone. With this at 1s the same test measured 1,603ms.
 *
 * 250ms rather than the ~3s browsers default to. It costs nothing while the
 * server is up (the stream is open; nothing reconnects), and during an outage
 * it is four connection attempts a second against a socket that refuses in
 * milliseconds — on a page that is blocked and waiting for exactly this
 * answer. Detection by any ORDINARY request is unaffected and stays
 * immediate; this bounds only the fully idle tab.
 *
 * IT IS THE OUTAGE CADENCE, AND ONLY THAT. A refusal is a different fact and
 * gets a different cadence — see `LIVE_STREAM_REFUSED_RETRY_MS`.
 */
export const LIVE_STREAM_RETRY_MS = 250;

/**
 * What to wait before re-opening the liveness stream after the SERVER
 * REFUSED it — when the server did not say.
 *
 * ── WHY THE CADENCE DEPENDS ON THE CAUSE ───────────────────────────────────
 *
 * 250ms is right for an OUTAGE: nothing is listening, the failure comes back
 * in milliseconds, and asking again immediately is what makes recovery feel
 * instant (measured: 104ms from the socket listening to the block clearing).
 *
 * It is wrong for a REFUSAL, and this is the loop that took the product down.
 * A 429 means the server answered and declined; retrying it immediately
 * cannot succeed, and the retries themselves are what keep the condition
 * alive — the browser asked four times a second, forever, and the page never
 * recovered. Backing off is not politeness here: an immediate retry makes an
 * exhaustion PERMANENT, while a slower one lets the slot the refusal is
 * waiting for actually come free.
 *
 * THE SERVER'S OWN `Retry-After` ALWAYS WINS (it sends one:
 * `sseConnectionRetryAfterSeconds`). This is only the fallback for a refusal
 * that named no interval, so there is one owner of the cadence — the side
 * that knows why it refused — and a stated default rather than a guess when
 * that side stays silent.
 */
export const LIVE_STREAM_REFUSED_RETRY_MS = 5_000;

/**
 * How many missed heartbeats before an OPEN liveness stream is treated as
 * silent.
 *
 * Detecting a dead PROCESS needs none of this — the socket closes and the
 * browser fires `error` in milliseconds. This bounds the other failure: a
 * server whose event loop is wedged, which holds its socket open and simply
 * stops producing. DESIGN-PERFORMANCE §1 L1 measures that class directly (an
 * 8,009ms scan on an otherwise 3ms endpoint), and a browser-measured
 * `/api/health` in this session took 7,358ms and still returned 200 — so the
 * threshold has to sit well clear of a server that is merely working hard, or
 * it reports outages that are not happening.
 */
export const LIVE_STREAM_MISSED_BEATS = 2.5;

/** The value stamped under `API_IDENTITY_HEADER`. Presence is the signal;
 *  the value is a version marker so a future protocol change is nameable. */
export const API_IDENTITY_VALUE = "1";

/**
 * Statuses that mean "an intermediary could not reach the upstream".
 *
 * Used ONLY in conjunction with the absence of `API_IDENTITY_HEADER` — see
 * `src/data/connection.ts`. Neither half is sufficient alone, and getting
 * that wrong is possible in both directions:
 *
 *   status alone   the API ITSELF returns 502 when a model provider fails
 *                  (`shared/errors.ts`: "502 is the honest status: this
 *                  side worked") and 503 for `config_invalid`. Blanking the
 *                  cockpit on those would be an outage that is not happening.
 *   absence alone  the header proves the API answered; its absence proves
 *                  nothing by itself. A reverse proxy that strips unknown
 *                  headers would make a perfectly healthy 200 read as an
 *                  outage, permanently.
 *
 * Together they are exact: a gateway-class status that the API did not sign
 * is, by the definition of those statuses, an intermediary reporting that it
 * could not reach the server.
 */
export const GATEWAY_UNREACHED_STATUSES: readonly number[] = [502, 503, 504];

/**
 * Name of the ledger document carrying an effect's MEASURED resource cost,
 * written by the effect sink beside the timing document: the CPU time the
 * effect consumed and the heap growth it caused (which may be negative — a
 * net release), measured across the same window as `durationMs`.
 *
 * Declared here, with the other cross-boundary wire literals, because the
 * writer (`server/observability/timeline-bridge.ts`) and any timeline reader
 * are on opposite sides of the boundary and a duplicated string would
 * silently produce events whose cost is never found.
 */
export const TIMELINE_EFFECT_TIMING_DOCUMENT = "effect-timing";

/**
 * Shape of that document's `contentJson`. `durationMs` is the wrapper's own
 * wall-clock measurement (it holds both ends of the call); the resource
 * fields ride beside it when resource-delta capture is enabled
 * (`performance.resourceDeltas.enabled`) and the measurement succeeded.
 */
export type TimelineEffectTiming = Readonly<{
  durationMs: number;
  /** CPU time (user + system) the effect consumed, in ms. */
  cpuMs?: number;
  /** Heap growth across the effect, in bytes (negative = net release). */
  heapDeltaBytes?: number;
}>;

/**
 * Name of the ledger document carrying an effect's REDACTED invocation
 * arguments — "what arguments it used" — written by the effect sink as a
 * second document on the same event, bounded like every other document.
 *
 * The call site redacts through the single redaction owner BEFORE the getter
 * hands the args over (the store deliberately stores document content
 * verbatim, so masking must happen before the document exists), and the
 * database lane records argument SHAPES only — never raw DB arguments, so
 * message content cannot reach a ledger document through this channel.
 */
export const TIMELINE_EFFECT_ARGS_DOCUMENT = "effect-args";

/**
 * THE RESPONSE HEADER THAT CARRIES THE REQUEST'S TRACE ID.
 *
 * The router mints one trace id per HTTP request, enters it into the
 * recording context, and stamps it here — so a client holding a failed
 * response can hand the operator an id that answers "every ledger event
 * this request produced" (`TimelineQuery.byTrace`). Lowercase per Node's
 * header normalization; `Headers.get` is case-insensitive on the client
 * side.
 */
export const TRACE_ID_HEADER = "x-trace-id";

/**
 * Name of the ledger document carrying the FINAL REDACTED request messages
 * a provider call sent. Written by the LLM bridge's capture at the
 * `buildLLMMessages` choke point and attached to the same provider event as
 * the response document, so "what did the provider actually receive?" is
 * answerable from the ledger alone.
 */
export const TIMELINE_LLM_REQUEST_DOCUMENT = "llm-request";

/**
 * Name of the ledger document carrying the ASSEMBLED provider response
 * (accumulated text + tool-call name/arguments pairs), captured at the
 * stream settlement and attached to the same provider event as the request
 * document.
 */
export const TIMELINE_LLM_RESPONSE_DOCUMENT = "llm-response";

/**
 * Name of the ledger document carrying the SAFETY GATE'S STRUCTURED BLOCK
 * DETAIL on a `tool` event — the block kind and WHICH argument fields failed
 * schema validation, the names the gate itself computed. The model-facing
 * refusal message already carries them as prose; this document is the
 * machine-queryable half, so a ledger reader answers "which fields failed"
 * without parsing the message and without reading the client.
 */
export const TIMELINE_GATE_BLOCK_DOCUMENT = "gate-block";

/**
 * Name of the ledger document carrying ONE RECORDED TOKEN-USAGE SAMPLE on a
 * `token` event. Written by the recorder's `recordTokenUsage` (whose JSON
 * carries `{promptTokens, completionTokens, totalTokens}`) and decoded by the
 * timeline's synthesis reads and the dig reader.
 *
 * Hoisted here from the engine's timeline vocabulary to sit with the other
 * cross-boundary document names: writers and readers are on opposite sides
 * of the engine↔web seam, and every recurring document name a reader can
 * join on belongs to this one owner.
 */
export const TIMELINE_TOKEN_USAGE_DOCUMENT = "usage";

/**
 * Name of the ledger document carrying a FILE EFFECT's facts (`{path,
 * operation, preimageDigest, postimageDigest}`), written by the recorder's
 * purpose-built `recordFileEffect` — never through the generic effect sink —
 * and decoded by the timeline's file-effect synthesis reads.
 */
export const TIMELINE_FILE_EFFECT_DOCUMENT = "effect";

/**
 * Name of the ledger document carrying ONE CHECK-STATUS CHANGE (a check's
 * name, previous and new status, and its chat/project scope), recorded as a
 * standalone `quality` event beside the auto-checks store's latest-status
 * upsert so "when did it change" stays derivable.
 */
export const TIMELINE_CHECK_STATUS_DOCUMENT = "check-status";

/**
 * Name of the ledger document carrying one PROCESS RESOURCE SAMPLE (the
 * metric's name, value and unit), written by the recorder's `recordResource`
 * — the lane the process resource sampler writes its periodic footprint into.
 */
export const TIMELINE_RESOURCE_METRIC_DOCUMENT = "metric";

/**
 * Name of the ledger document carrying ONE BROWSER-REPORTED FACT on a
 * `client-error` or `client-metric` event: the redacted facts the page sent
 * (an error's message/source/line/column/first stack frame, or a
 * measurement's numbers — long-task ms, ingest lag, dropped-event counts).
 * Written by the client-telemetry ingestion route after server-side
 * redaction; the client never writes this document itself.
 */
export const TIMELINE_CLIENT_FACTS_DOCUMENT = "client-facts";

/**
 * How many milliseconds one second is — the unit conversion between the unit
 * the record keeps (ms) and the unit a person reads (s). A UNIT CONVERSION,
 * not an operator knob: nothing is configured by it.
 *
 * ONE owner because it was declared TWICE — once in the engine's timeline
 * config (`MS_PER_SECOND` beside the dig's duration formatter) and once in
 * the cockpit flow config (tokens/s and latency readouts) — and two private
 * copies of one conversion is how two readouts of the same measurement drift
 * apart. `shared/*` is the seam every consumer can reach: the engine, the
 * web server and the client.
 */
export const MS_PER_SECOND = 1_000;

/**
 * How many microseconds one millisecond is — `process.cpuUsage()` reports in
 * microseconds and every consumer converts to the ms unit the ledger and the
 * metrics readouts keep. A UNIT CONVERSION, not an operator knob, and ONE
 * owner because the fact was written bare in FOUR places across the seam
 * (the server's resource sampler and the engine's diagnostic modes) — the
 * same drift risk `MS_PER_SECOND` exists to end.
 */
export const MICROSECONDS_PER_MILLISECOND = 1_000;

// ── COCKPIT block bounds (DESIGN-COCKPIT-V2.md §3.4/§3.5/§6.6) ──────────────
// Numeric ceilings for the cockpit spine blocks, owned here (the
// @config-owner file) so no block module carries a magic number.

/**
 * Most time bins one `sweep.spectrum` read may request — the spec's own
 * SWEEP ceiling. The harness store enforces the same bound on its side
 * (`timeline_spectrum_bins_invalid`), so a drift here is a 400, never a
 * silent widening.
 */
export const SPECTRUM_MAX_BINS = 2000;

/** Default `sweep.spectrum` bin count (the spec's `bins=1200` exemplar). */
export const SPECTRUM_DEFAULT_BINS = 1200;

/**
 * Ceiling of one packed spectrum cell: the spectrum is wired as an
 * Int16Array (base64), and a cell past this value is CLAMPED with
 * `header.clamped: true` — stated, never silently wrapped.
 */
export const SPECTRUM_CELL_MAX = 32_767;

/**
 * Most recorded tool events one `tools.breaker` read folds for a chat's
 * runs. A bound on the ledger query, not on the truth: a chat past it would
 * undercount, which the fold prevents by folding newest-last in ascending
 * ledger order within the cap.
 */
export const BREAKER_EVENT_FOLD_LIMIT = 10_000;

/**
 * Most stored-flag events one `arm.flags` read folds (arm events are rare —
 * human-created marks, not machine traffic).
 */
export const ARM_FOLD_LIMIT = 5000;

/**
 * Most compose (pin/mute/trim) events one `run.compose` state fold reads —
 * same rarity argument as `ARM_FOLD_LIMIT`.
 */
export const COMPOSE_FOLD_LIMIT = 5000;

/**
 * Most characters of REAL composed body one `run.composeItem` read returns
 * for a single item. A tool result can be a whole file, and a desk that
 * ships one on every glance is a desk nobody opens; past this the read
 * states exactly how many characters it withheld, so the reader is never
 * shown a cut they cannot see. Sized well above the longest thing a person
 * reads in a sheet and well below a payload that costs a visible pause.
 */
export const COMPOSE_ITEM_MAX_CHARS = 120_000;

/**
 * How long a pointer or keyboard focus must REST on a control before it
 * counts as INTENT to activate it — the trigger for anticipatory warming
 * (prefetching the reads the activation would perform).
 *
 * The dwell is the entire cost control. Without it, a pointer crossing a rail
 * on its way somewhere else would warm every surface it passed; with it, only
 * a deliberate pause spends anything. Short enough to be finished by the time
 * the click lands (a block read is ~600ms browser-measured, so 120ms of dwell
 * is noise beside it), long enough that a sweep costs nothing.
 *
 * ONE owner because there are two warmers with the same physics and the same
 * argument: the module rail (`src/lib/module/intent.ts`) and the cockpit shell
 * (`src/cockpit/shell/room-warm.ts`). The cockpit cannot import from
 * `src/lib/**` (its import law allows only the Broker, the errors and the
 * asOf owner), and `shared/*` is reachable from both — so the shared
 * number lives here rather than being written twice and drifting.
 */
export const INTENT_DWELL_MS = 120;

/**
 * Result-row cap sent on every timeline scope query — the single owner of
 * the cap so no two query builders can drift. Lifted here from the old
 * timeline view-config when the query builders (src/client.ts,
 * src/state/timeline-query.ts) outlived the view that file configured:
 * `shared/*` is the seam every query builder can reach.
 */
export const TIMELINE_QUERY_LIMIT = 200;
