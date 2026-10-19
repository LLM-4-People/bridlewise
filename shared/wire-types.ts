/**
 * Shared WIRE types (server → client) — the single source of truth for the
 * pure data shapes that cross the HTTP boundary. NO `@harness/*` imports so
 * the SERVER (NodeNext module resolution, no path aliases) can import this
 * file exactly like the client (mirrors `shared/ui-schema.ts`).
 *
 * SPO (contracts audit): before  several wire types were
 * defined in BOTH `server/` (the wire producer) AND `src/` (the wire
 * consumer) as structurally-identical parallel definitions — a drift
 * class (a field added on one side without the other would silently break
 * the wire, exactly the bug class closed for SSE event names). 
 * moves the PURE wire types (no canonical-harness dependency) HERE so
 * both sides import the ONE definition. The original modules re-export
 * the moved types so existing import paths are unchanged (low churn).
 *
 * What lives here vs. `shared/types.ts`:
 * - THIS file (`wire-types.ts`): pure wire types with NO `@harness/*`
 * dependency → server-importable (NodeNext). The wire SHAPES that both
 * the server routes + the client store consume.
 * - `shared/types.ts`: re-exports from `@harness/*` (client-only; the
 * server cannot resolve those path aliases) + the web-UI-local types
 * that depend on `@harness/*` (e.g. `WebToolEntry` extends
 * `ToolManifestEntry`).
 *
 * Types NOT moved here (kept mirrored + guarded by a structural-identity
 * contract test in `frontend-contracts-owner.test.ts`):
 * - `WebToolEntry` — extends `ToolManifestEntry` from `@harness/*` (the
 * canonical-dep boundary blocks server import of `shared/types.ts`).
 * - `ChatHistoryView` — composes per-side view types with DIFFERENT names
 * (server `ChatSummaryView`/`ToolCallRowView`/`TimelineRefView` vs.
 * client `ChatSummary`/`ToolCallViewRow`/`TimelineRef`); moving it would
 * require reconciling the whole chain (a dedicated follow-up round).
 * - `MemoryEntryView`? — moved here (its only dependency `MemoryTier` is
 * a pure union defined here too; the server keeps importing the
 * canonical `MemoryTier` for the STORE, and assigns it at the wire
 * boundary — structurally identical unions are assignable).
 *
 * The `frontend-contracts-owner` prevention test (Class E) dynamically
 * discovers every type defined in BOTH `server/` and `src/` and asserts
 * each is EITHER consolidated here (or in `web-ui-types.ts`) OR a zod-
 * inferred mirror (the server's `z.infer<...>` pattern, where the zod
 * schema owns the shape) OR covered by an explicit structural-identity
 * assertion. A NEW plain duplication is caught — deny-by-default.
 */

// ── Memory wire types ──

/**
 * THE MEMORY VOCABULARIES — THE ARRAY IS THE OWNER, THE TYPE IS DERIVED.
 *
 * Both of these used to be a union written by hand PLUS an array annotated
 * with that union:
 *
 *   type MemorySource = "tool" | "conversation" | "llm" | "user";
 *   const MEMORY_SOURCES: readonly MemorySource[] = ["tool", "conversation", ...];
 *
 * That reads as one vocabulary and is two, and the compiler cannot join them:
 * an array of FEWER members is perfectly assignable to `readonly T[]`. Adding
 * a fifth `MemorySource` and forgetting the array is therefore silent — `tsc`
 * exits 0 — while the new source is REJECTED by the server's validation set
 * (built from this array) and ABSENT from the `sources` field the API ships.
 * A declaration with nothing behind it, which is the class this file's
 * neighbours keep rediscovering.
 *
 * Inverting the ownership removes the possibility rather than guarding it:
 * with `type X = typeof ARRAY[number]` there is no second place to add a
 * member to, so a member that is not in the array cannot be expressed. The
 * harness's own memory owner (`memory-types.ts`) already uses exactly this
 * spelling; this is that spelling, not a second mechanism.
 */

/** The source vocabulary (single owner). Consumed by the server (validation
 * set + the `/api/memory` `sources` response field) AND the client
 * (MemoryPanel source dropdown keys). */
export const MEMORY_SOURCES = ["tool", "conversation", "llm", "user"] as const;

/** Origin of a memory entry: a tool call, a conversation, the LLM, or the
 * user. Derived from `MEMORY_SOURCES` above — see the note there. */
export type MemorySource = typeof MEMORY_SOURCES[number];

/** The tier vocabulary — the WIRE mirror of the harness memory owner's tier
 * set, which the client cannot import (it would pull the canonical harness
 * into the browser bundle). The server holds the two to each other at COMPILE
 * time in `memory-bridge.ts`, so this mirror cannot drift from the store it
 * mirrors without a type error. */
export const MEMORY_TIERS = ["present", "short-term", "long-term"] as const;

/** Memory tier — the wire shape. Derived from `MEMORY_TIERS` above. The
 * server's memory store uses the CANONICAL `MemoryTier` and assigns it at the
 * wire boundary (`toView`); the two are held equal by a compile-time parity
 * assertion rather than by inspection. */
export type MemoryTier = typeof MEMORY_TIERS[number];

/** Memory entry wire view (server → client). Single owner — was duplicated
 * in `server/memory-bridge.ts` + `src/state/memory.ts` (structurally
 * identical; the client's even documented that `timestamp` MIRRORS the
 * server wire field). `tier` uses the wire `MemoryTier` (above); the
 * server maps the canonical store tier at the boundary. */
export type MemoryEntryView = Readonly<{
  readonly id: string;
  readonly content: string;
  readonly tier: MemoryTier;
  readonly topic: string | null;
  readonly tags: readonly string[];
  readonly agentId: string | null;
  readonly timestamp: string;
  readonly source: MemorySource;
  readonly toolName: string | null;
  readonly originalRequest: string | null;
  readonly chatId: string | null;
  /**
   * The run that produced this memory, when one did.
   *
   * Recorded so a REWIND can reach it. A completed run stores its prompt and
   * its answer as a short-term memory, and that memory is recalled into the
   * system prompt of later turns — so withdrawing the turns from the
   * conversation history was not enough on its own: the abandoned answer came
   * back through the memory channel, verbatim, which is the same question
   * answered on a second path. `chatId` alone cannot separate the withdrawn
   * turn from the one that replaced it — both belong to the same chat — so
   * the RUN is what identifies it. Null for memories not produced by a run.
   */
  readonly runId: string | null;
  readonly how: "automatic" | "manual";
  readonly userId: string | null;
}>;

/**
 * HOW A REWIND FINDS ITS ANCHOR from the message a surface names.
 *
 * `at` — the named message itself is the first thing withdrawn. This is
 *   `rewind here` and `edit & resend`: the user is retracting or replacing
 *   THAT message, so it is on the discarded side of the line.
 *
 * `causing-prompt` — the named message is a MODEL turn; the anchor is the
 *   user message that caused it. This is `retry`, and the resolution happens
 *   on the SERVER: history arrives in pages, so a model turn at the top of the
 *   loaded window has its causing prompt in a page the browser never fetched.
 *   The client names the turn it is standing on; the record supplies the rest.
 *
 * Consolidated here because it crosses the wire in both directions — it is the
 * `mode` field of `run.compose/rewind`'s input, read by `server/rewind.ts` and
 * written by `src/cockpit/flow/rewind.ts`.
 */
export type RewindMode = "at" | "causing-prompt";

// ── Chat / message wire types ──

/** Message wire view (server → client). Single owner — was duplicated in
 * `server/routes/views.ts` + `src/client.ts` (structurally identical).
 * `metadata` is `unknown` (the rich per-message metadata blob; the client
 * narrows it to its `MessageMetadata` view). */
export type MessageView = Readonly<{
  readonly id: string;
  readonly chatId: string;
  readonly role: "user" | "assistant" | "tool" | "error" | "event";
  readonly content: string;
  readonly createdAt: string;
  readonly modelEventType: string | null;
  readonly runId: string | null;
  /** Rich per-message metadata (reasoning, tokens, timing, headers, model,
   * finish reason, context). Persisted so the full chat exposure survives
   * a page refresh. Null when absent (older messages or non-assistant
   * roles). */
  readonly metadata: unknown;
  /**
   * WITHDRAWN BY A REWIND — still recorded, no longer sent.
   *
   * The row is served exactly as it was stored; this flag says the ledger
   * holds a `rewind` event naming it (`server/rewind.ts`), so the model no
   * longer receives it and the flow does not replay it as accepted history.
   * It is a flag rather than an omission ON PURPOSE: a rewind is a recorded
   * event, not an erasure, and a client that could not tell the difference
   * between "withdrawn" and "never happened" is exactly the missing record
   * this product exists to prevent.
   */
  readonly discarded?: boolean;
}>;

/** Metrics snapshot wire view (server → client). Single owner — was
 * duplicated in `server/routes/views.ts` + `src/client.ts`. */
export type MetricsSnapshotView = Readonly<{
  readonly id: string;
  readonly chatId: string;
  readonly snapshot: unknown;
  readonly createdAt: string;
}>;

/**
 * WHERE A HISTORY PAGE ENDED, AND WHY (DESIGN-PERFORMANCE §4).
 *
 * A conversation opens at its TAIL, so the top of what the reader sees is
 * either the start of the conversation or the edge of one page — and those
 * are opposite facts that render as the same pixels. This is what tells them
 * apart, and it is consolidated here (pure scalars, no per-side view types)
 * so the sentence the surface prints is decided by the same declaration the
 * server fills in.
 *
 * `endedBy: "beginning"` is the ONLY value that licenses a surface to say a
 * conversation starts here — it is issued only for a short page cut from one
 * database snapshot, which is proof there is nothing older. `"limit"` and
 * `"bytes"` both mean "older messages exist and are not loaded yet", which is
 * a different sentence (§1 L3).
 */
export type HistoryPageView = Readonly<{
  /** The row bound this page was asked for. */
  readonly limit: number;
  /** Messages actually in this page. */
  readonly returned: number;
  /** Older messages exist before this page's oldest. */
  readonly hasOlder: boolean;
  /** Opaque cursor for the page BEFORE this one; null iff `hasOlder` is
   * false. The client passes it back verbatim and never reads inside it. */
  readonly olderCursor: string | null;
  /** How many messages the conversation holds — a COUNT, never a length. */
  readonly messageCount: number;
  /** Which bound ended the page. */
  readonly endedBy: "limit" | "bytes" | "beginning";
}>;

// ── System metrics wire type ──

/** System (process) metrics wire view (server → client). Single owner —
 * was duplicated in `server/metrics-bridge.ts` + `src/state/metrics.ts`
 * (structurally identical). Captured by the server via `node:os` +
 * `node:perf_hooks` and sent to the client for the Metrics dashboard
 * System section. */
export type SystemMetrics = Readonly<{
  capturedAt: string;
  processUptimeMs: number;
  osUptimeMs: number;
  cpuCount: number;
  loadAverage1m: number;
  memory: Readonly<{
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
    arrayBuffers: number;
    systemFree: number;
    systemTotal: number;
  }>;
  eventLoop: Readonly<{ utilization: number; delayMin: number; delayMax: number; delayMean: number; delayStddev: number }>;
}>;

// ── Web-UI config-section wire types (the redacted config snapshot shape) ──
//
// The harness config's `webUi.graph` + `webUi.metrics` sections are served
// to the client via GET /api/config (the redacted config snapshot). The
// server (`server/harness-config.ts` `getGraphConfig`/`getMetricsConfig`)
// + the client (`src/state/web-ui-config.ts` `readGraphConfig`/
// `readMetricsConfig`) consume the SAME shape. Single owner — was
// duplicated across `server/harness-config.ts` + `src/state/web-ui-config.ts`
// (structurally identical; 24 graph fields + 2 metrics fields). The
// DEFAULT_* fallback consts + the read functions stay per-side (each side
// has its own read path — server reads the config file, client reads the
// reactive snapshot); only the TYPE is consolidated here.

/** The `webUi.graph` config section shape (the dependency-graph force
 * layout + viewport bounds). Single owner — was duplicated server↔client. */
export type GraphConfig = Readonly<{
  maxNodes: number;
  repulsion: number;
  springLength: number;
  springStrength: number;
  centering: number;
  damping: number;
  iterations: number;
  maxNodeRadius: number;
  minNodeRadius: number;
  /** Target inter-node spacing (layout units) used to size the LAYOUT SPACE
   * from the node count, so node density stays constant regardless of graph
   * size. The layout space is deliberately decoupled from the canvas: the
   * simulation lays out in its own coordinate space and `computeAutoFit`
   * maps that space into the viewport. Previously the canvas rect WAS the
   * layout space, which clamped every graph to the viewport, pinned the
   * auto-fit scale at ~1 and made labels unreachable. */
  nodeSpacing: number;
  /** Distance floor (layout units) for the inverse-square repulsion term.
   * Without it, near-coincident nodes produce an unbounded force spike that
   * throws the simulation apart before the cooling schedule can settle it. */
  minSeparation: number;
  /** Show a node's label once its on-screen diameter reaches this many CSS
   * px — a level-of-detail rule keyed to apparent size rather than to the
   * absolute zoom factor, which no large graph could ever reach. */
  labelMinNodeScreenPx: number;
  /** Always label this many highest-degree nodes, at any zoom, so a dense
   * graph is never completely anonymous. */
  labelTopDegreeCount: number;
  /** Clear space (CSS px) between a node's edge and the nearest edge of its
   * label — the offset the label is drawn at. */
  labelGapPx: number;
  /** Minimum clear space (CSS px) required BETWEEN two drawn labels. The
   * collision-avoidance pass suppresses (or re-anchors) any label that
   * cannot keep this distance from every label already placed; without it
   * a dense graph drew every label at a fixed offset and they overlapped
   * into an unreadable smear. */
  labelPaddingPx: number;
  minZoom: number;
  maxZoom: number;
  minCanvasPx: number;
  maxFitScale: number;
  fitMarginPx: number;
  fallbackWidth: number;
  fallbackHeight: number;
  labelFontPx: number;
  labelShowAllZoom: number;
  hitPaddingPx: number;
  wheelZoomFactor: number;
  buttonZoomIn: number;
  buttonZoomOut: number;
  indexingPollMs: number;
  maxCyclesDisplayed: number;
}>;

/** The `webUi.metrics` config section shape (the metrics poll cadence +
 * history cap). Single owner — was duplicated server↔client. */
export type MetricsConfig = Readonly<{ pollMs: number; historyMax: number }>;

// ── Dependency graph wire shape ──
// The GET /api/intelligence/graph response. Single owner — was an inline
// `unknown` cast in the client + an ad-hoc type in IntelligencePanel that
// DIVERGED from the server's actual response (the server returns
// `cycles` as `{ hasCycles, cycles: string[][] }` but the panel treated it
// as `{ nodes: string[] }[]`, so the cycle count + cycle rendering were
// silently dead; `stats.density` was never sent so the density tile read
// `undefined`). This type pins the real shape the server emits so the
// panel + any future consumer cannot drift again.

/** Graph stats (the `stats` field). `density` is computed in the route
 * from the FULL graph (edgeCount / possible directed pairs) so the stat
 * tile reports the repo's real density, not the capped-render subset's. */
export type GraphStatsView = Readonly<{
  maxInDegree: number;
  maxOutDegree: number;
  avgOutDegree: number;
  isolatedNodes: number;
  density: number;
  hubNodes: ReadonlyArray<Readonly<{ node: string; inDegree: number }>>;
}>;

/** Cycle detection result. `cycles` is an array of cycles, each cycle a
 * sorted list of node ids forming a strongly-connected component (a cycle
 * or self-loop). `hasCycles` is the boolean summary. */
export type CycleResultView = Readonly<{
  hasCycles: boolean;
  cycles: ReadonlyArray<readonly string[]>;
}>;

/** A graph node for rendering (id + degree). */
export type GraphNodeView = Readonly<{ id: string; degree: number }>;
/** A graph edge for rendering (from → to). */
export type GraphEdgeView = Readonly<{ from: string; to: string }>;

/** One unresolved import, as `GET /api/intelligence/auto-heal` sends it. */
export type BrokenEdgeView = Readonly<{
  /** The file containing the import, relative to the project root. */
  from: string;
  /** The unresolved import specifier, as written in the source. */
  specifier: string;
  /** direct-import / re-export / dynamic-import / require. */
  kind: string;
}>;

/**
 * The full GET /api/intelligence/auto-heal response.
 *
 * FLAT, because the route flattens it: the server's own `AutoHealReport` nests
 * `stale` and `brokenEdges` as sub-reports, and the handler lifts their fields
 * onto one object and makes the paths project-relative. This type describes
 * what goes ON THE WIRE, which is what the client reads — the panel was
 * importing a name (`AutoHealReportResponse`) that no module exported, and
 * `getAutoHealReport` answered `unknown`, so every field the panel reads off
 * it was unchecked.
 */
export type AutoHealReportResponse = Readonly<{
  path: string;
  stale: boolean;
  staleReason: string | null;
  staleSampleSize: number;
  changedFiles: readonly string[];
  vanishedFiles: readonly string[];
  brokenEdgeCount: number;
  brokenEdges: readonly BrokenEdgeView[];
  lastIndexedAt: number | null;
}>;

/** The full GET /api/intelligence/graph response. */
export type DependencyGraphData = Readonly<{
  stats: GraphStatsView;
  cycles: CycleResultView;
  edgeCount: number;
  nodeCount: number;
  edges: ReadonlyArray<GraphEdgeView>;
  nodes: ReadonlyArray<GraphNodeView>;
}>;

/** The 202 "still indexing" body the router emits for any endpoint whose
 * bridge throws `MapNotReadyError` (the graph, map, and awareness routes).
 * A discriminated union partner of `DependencyGraphData` — the panel
 * checks `status === "indexing"` to keep polling instead of rendering. */
export type IndexingResponse = Readonly<{
  status: "indexing";
  code: string;
  message: string;
}>;

/** The `webUi.performance` config section shape — the web-UI performance
 * budget. The regression test (`tests/performance/regression.test.ts`) reads
 * these thresholds via the server accessor `getPerformanceBudgetConfig` and
 * fails if a measured metric in the Playwright profile report degrades past
 * its budget. One canonical owner (this type) so the server accessor + the
 * client reader cannot drift. Every field is the single default owner; the
 * harness-config-webui contract test pins both sides equal. */
export type PerformanceBudgetConfig = Readonly<{
  /** Largest contentful paint budget (ms). Above this the page-load test fails. */
  lcpMaxMs: number;
  /** Cumulative layout shift budget (unitless). Above this the page-load test fails. */
  clsMax: number;
  /** Worst long-task duration budget (ms) — a TBT proxy. */
  longTaskWorstMaxMs: number;
  /** Total long-task time budget (ms) over the page load. */
  longTaskTotalMaxMs: number;
  /** Tab-switch perceived-latency budget (ms) — every tab must switch under this. */
  tabSwitchMaxMs: number;
  /** DOM node-count budget at a tab — a runaway DOM is a jank + memory source. */
  tabDomNodesMax: number;
  /** Typing mean per-keystroke latency budget (ms), settle-inclusive: the
   * measurement runs from the input event to the frame AFTER the reactive
   * render, so it contains one rendered-frame period by construction and
   * the budget must exceed the page's own frame clock. */
  typingMeanMaxMs: number;
  /** Worst single API response-time budget (ms) — the backend must be instant. */
  apiResponseMaxMs: number;
  /** Heap-growth budget (MB) over a long session — a leak test. */
  longSessionHeapGrowthMaxMb: number;
  /** DOM node-growth budget over a long session — a DOM-leak test. */
  longSessionDomGrowthMax: number;
  /** Long-chat render budget (ms) — the time to render a 1000-message chat.
   * A distinct scenario from page load (the chat is already mounted; this
   * measures the message-list mount/scroll for a realistic transcript). */
  longChatRenderMaxMs: number;
  /** Many-projects render budget (ms) — the time to render a 10k-project
   * sidebar. The sidebar must not block the main thread on a large list. */
  manyProjectsRenderMaxMs: number;
  /** Viewport LCP budget (ms) — the LCP at any viewport (desktop/tablet/
   * mobile). Mobile is slower (smaller viewport, reflow); the budget is
   * looser than the desktop-only `lcpMaxMs`. */
  viewportLcpMaxMs: number;
}>;

/**
 * HOW MUCH OF THIS COMPUTER A RUN'S COMMANDS CAN REACH.
 *
 * Declared here because BOTH sides speak it and neither may own it: the
 * server measures the state, the cockpit renders it, and a copy on each side
 * is two definitions of one fact that drift the day either is edited. The
 * dangerous drift is specific — losing a state. If the server can report a
 * fourth condition the client has never heard of, the client falls through to
 * whatever its `else` happens to be, which for a safety reading means saying
 * something reassuring about a state it does not understand.
 *
 * FOUR STATES, and the fourth is the point:
 *   off         — nobody asked for confinement. Commands run with the
 *                 server's own authority, and the reading says so.
 *   confined    — measured available. Commands cannot leave the project.
 *   unavailable — asked for, and measurably not deliverable here. Commands
 *                 are refused.
 *   unknown     — asked for, and the check itself could not complete. Also
 *                 refused: a question that could not be answered is not a
 *                 yes, and it is not the same fact as "no".
 */
export const CONFINEMENT_STATES = ["off", "confined", "unavailable", "unknown"] as const;
export type ConfinementState = (typeof CONFINEMENT_STATES)[number];

/**
 * The result of asking a saved model provider whether it actually answers.
 *
 * Defined ONCE and imported by both sides. The server produces it in
 * `server/llm-bridge.ts`; the client consumes it in `src/client.ts`. It
 * deliberately has no field a key could occupy — the only things that cross
 * are whether the provider answered, how long it took, and, on failure, the
 * provider's own words about why (already through redaction).
 */
/**
 * WHAT THE ONE TEST REQUEST MET, in classes a person can act on — the
 * endpoint never answered (bad address / down), refused the saved key,
 * answered but did not accept the request (bad model, no credit, wrong
 * protocol, overloaded), or the request did not complete at all. The server
 * maps the engine's closed error vocabulary INTO this wire vocabulary
 * (a TOTAL map, so a new engine error type without a class is a compile
 * error there) and the settings surface maps the class into its sentence.
 */
export type ProviderTestFailureKind =
  | "no-answer"
  | "refused-key"
  | "refused-request"
  | "output-limit"
  | "invalid-response"
  | "unexpected";

export type ProviderTestResult = Readonly<{
  readonly ok: boolean;
  /** The provider's own failure text; absent when it worked. */
  readonly detail?: string;
  /** What the one test request met, when it failed; absent when it worked
   * or when an older server did not classify. */
  readonly failureKind?: ProviderTestFailureKind;
  /** Round-trip time in milliseconds, so a slow provider is distinguishable. */
  readonly elapsedMs: number;
}>;

/**
 * The same result as it leaves the route, naming what was tested.
 *
 * Separate from {@link ProviderTestResult} because the bridge answers about a
 * credential it was handed and the ROUTE is what knows which saved provider
 * and model that credential came from.
 */
export type ProviderTestResponse = ProviderTestResult & Readonly<{
  readonly providerId: string;
  readonly modelId: string;
}>;

/** An unsaved connection can discover models without creating a provider. */
export type ProviderDiscoveryInput = Readonly<{
  savedProviderId?: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Readonly<Record<string, string>>;
}>;
export type DiscoveredProviderModel = Readonly<{
  id: string;
  contextWindow?: number;
  maxTokens?: number;
}>;
export type ProviderDiscoveryResult =
  | Readonly<{ ok: true; models: readonly DiscoveredProviderModel[] }>
  | Readonly<{ ok: false; failureKind: ProviderTestFailureKind; detail: string }>;

// ── MCP server wire types (the settings room's server list) ──

/**
 * The MCP transport vocabulary the config document schema declares
 * (`stdio | http | websocket`; `http` is MCP Streamable HTTP — the retired
 * HTTP+SSE transport is not offered). THE ARRAY OWNS THE VOCABULARY: the
 * settings form's choices, the served summary's field, and any decoder read
 * the one list, so a transport the engine learns is served the day it lands.
 */
export const MCP_TRANSPORT_IDS = ["stdio", "http", "websocket"] as const;
export type McpTransportId = (typeof MCP_TRANSPORT_IDS)[number];

/** How a saved MCP server authenticates, as the wire serves it — the TYPE
 * and the PRESENCE of a token, never the token itself. */
export type McpAuthView = Readonly<{
  readonly type: "api-key" | "bearer" | "oauth";
  /** Where an api-key credential travels: a header name, an env var name,
   * or null when the server's own default applies. */
  readonly header: string | null;
  readonly envName: string | null;
  /** Whether a credential is saved. The value never crosses the wire. */
  readonly hasToken: boolean;
}>;

/**
 * One configured MCP server as the settings list serves it: the registration
 * facts that are not credential material (the engine's own field vocabulary),
 * joined with the live registry-measured connection state. Credential-bearing
 * values — environment VALUES, header VALUES, the auth token — are
 * structurally absent: a name stands in for each saved credential, exactly
 * like the provider list's `hasApiKey`, so a read can never echo one back.
 */
export type McpServerView = Readonly<{
  readonly id: string;
  /** Normally one of the closed vocabulary; a hand-edited config file that
   * bypassed the write gate can hold anything, and the list serves what is
   * actually there — the `string & {}` keeps the autocomplete while
   * admitting that case without inventing a transport. */
  readonly transport: McpTransportId | (string & {});
  readonly enabled: boolean;
  readonly command: string | null;
  readonly args: readonly string[];
  /** stdio: what the confined server may read and execute (its install). */
  readonly readPaths: readonly string[];
  readonly url: string | null;
  readonly subprotocol: string | null;
  readonly envNames: readonly string[];
  readonly headerNames: readonly string[];
  readonly auth: McpAuthView | null;
  readonly retry: Readonly<{ count: number; backoffMs: number }> | null;
  readonly timeoutMs: number | null;
  readonly protocolVersion: string;
  // Live runtime state — measured by the registry, never invented.
  readonly status: "stopped" | "connecting" | "connected" | "error" | "reconnecting";
  readonly toolCount: number;
  readonly callCount: number;
  readonly errorCount: number;
  readonly lastError: string | null;
  /** The typed code of the last failure (e.g. `mcp_credential_missing`). */
  readonly lastErrorCode: string | null;
  /** How the server's last start was placed; null before any start. */
  readonly confinement: McpConfinementState | null;
  /** Why: the operator's reason when unconfined, the confinement owner's code when refused. */
  readonly confinementReason: string | null;
}>;

/**
 * How an MCP server runs, as the confinement owner decided at its last start:
 * a local (stdio) server is `confined` (its home is its only writable root),
 * `unconfined` (self-protection turned off in the settings file) or `refused`
 * (confinement unavailable or a read path refused); a remote server has no
 * local process — `remote`.
 */
export const MCP_CONFINEMENT_STATES = ["confined", "unconfined", "refused", "remote"] as const;
export type McpConfinementState = (typeof MCP_CONFINEMENT_STATES)[number];

/**
 * The result of asking a saved MCP server whether it actually answers — one
 * real connect + tools/list against the saved registration (the provider test
 * precedent's MCP equivalent). A failed connect with a named reason is a
 * valid observation: what the test proves is that the registration was
 * tried, not that the server is up.
 */
export type McpServerTestResult = Readonly<{
  readonly ok: boolean;
  /** The tools the server offered when it answered; absent on failure. */
  readonly toolNames?: readonly string[];
  /** The refusal's own words when it did not answer. */
  readonly detail?: string;
  /** What the one test connection met, when it failed; absent when it
   * worked. `no-answer`: the connect or the tools/list failed (the command
   * did not spawn, the address did not answer, the handshake was refused).
   * `unexpected`: the attempt did not complete in a classifiable way. */
  readonly failureKind?: "no-answer" | "unexpected";
  /** Round-trip time in milliseconds, so a slow server is distinguishable. */
  readonly elapsedMs: number;
}>;

/**
 * The add/edit write body — ONE shape for both verbs (upsert by id). The
 * SERVER's zod schema (`MCP_SERVER_WRITE_SCHEMA` in
 * `server/integrations/mcp-bridge.ts`) owns the runtime gate this type is
 * the wire mirror of, and the frontend-contracts drift guard asserts the
 * two declare the same fields (the zod-mirror class). Credential-bearing
 * fields carry the write-only-with-blank-keeps contract: an env/header
 * name present with an empty value keeps the saved value for that name; an
 * absent `auth` keeps the saved auth; `auth: null` REMOVES it; an auth
 * object with an empty `token` keeps the saved token. `retry: null` /
 * `timeoutMs: null` REMOVE the override (the module's own default applies —
 * the omit-on-default honesty the config file is written with).
 *
 * The nested shapes are NAMED sub-types (not inline `Readonly<{...}>`) for
 * the same reason MessageMetadata's are: the contracts drift guard reads a
 * flat mirror, and a named type is a field the client can share with the
 * server's zod schema instead of a shape restated twice.
 */
export type McpServerRetryWrite = Readonly<{ count: number; backoffMs: number }>;
export type McpServerAuthWrite =
  | Readonly<{ type: "api-key"; token: string; header?: string; envName?: string }>
  | Readonly<{ type: "bearer"; token: string; envName?: string }>
  | Readonly<{ type: "oauth"; token: string }>;
export type McpServerWrite = Readonly<{
  readonly id: string;
  readonly transport: McpTransportId;
  readonly enabled?: boolean;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly readPaths?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly subprotocol?: string;
  readonly retry?: McpServerRetryWrite | null;
  readonly auth?: McpServerAuthWrite | null;
  readonly timeoutMs?: number | null;
}>;

/**
 * The composition channel vocabulary — the strips of the next turn's model
 * input (`run.compose`). THE ARRAY OWNS THE VOCABULARY, AND THE TYPES DERIVE.
 *
 * This was stated twice: the server's `ComposeChannel["id"]` type literal and
 * Zod enums in `server/blocks/compose.ts`, and the client's `CHANNEL_IDS` in
 * `src/cockpit/desk/desk-data.ts`. Two copies of one wire vocabulary drift the
 * moment a channel is added — a new channel emitted by the server would be an
 * unrecognised value the client drops. One array here; the server's type, the
 * server's Zod enums, and the client's decoder all read it, so a channel added
 * once reaches both sides of the wire.
 *
 * `toolSchemas` is the request's `tools` array — the OpenAI JSON schema of
 * every enabled tool, carried beside the messages on EVERY call. A channel
 * list that omitted it would answer "what does the next turn send?" with a
 * subset, and a total built from that subset would understate the real
 * per-call cost by a constant the provider always bills (measured ~6.8k
 * tokens for 46 schemas — larger than everything else on a fresh chat
 * combined).
 */
export const COMPOSE_CHANNEL_IDS = ["system", "memories", "history", "toolResults", "toolSchemas"] as const;
export type ComposeChannelId = (typeof COMPOSE_CHANNEL_IDS)[number];

/**
 * One recycle-bin entry as the wire serves it (`GET /api/editor/recycle`).
 * Owned here because both sides declared it: the server's bridge produced it
 * (`server/filesystem/editor-bridge.ts`) and the client consumed it
 * (`src/client.ts`) — two copies of one record drift the moment a field is
 * added.
 */
export type RecycledFile = Readonly<{
  id: string;
  name: string;
  originalPath: string;
  relativePath: string;
  projectRoot: string;
  wasDirectory: boolean;
  deletedAt: number;
}>;
