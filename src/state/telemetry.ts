/**
 * Client telemetry — the browser's own observability, as one owner.
 *
 * The page is a harness component, and until this module it produced zero
 * observability of itself: an uncaught exception froze a surface with no
 * record anywhere, a blocked main thread was felt but never measured, a
 * stalled feed was indistinguishable from a quiet one. This module is the
 * ONE client-side owner of those facts. It captures at the lowest choke
 * points the browser offers —
 *
 *   - `window.onerror` + `unhandledrejection`: the only hooks that see an
 *     UNCAUGHT failure (a caught one is the app's to report);
 *   - `PerformanceObserver("longtask")`: the main thread's own account of
 *     when it was too busy to respond;
 *   - the run feed's listener registrations in client.ts (every frame the
 *     page ingests passes through them): dispatch-to-applied per frame,
 *     aggregated per run;
 *   - the boot controller's own measured total (probes.ts measures the
 *     boot; this module only forwards the number it already produced —
 *     one fact, one measurer).
 *
 * ── WHAT IT NEVER COLLECTS ──────────────────────────────────────────────────
 *
 * Message, source file name (basename'd — a query string on a script URL
 * can carry a token and rides along otherwise), line, column, and the
 * FIRST stack frame. Never page content, never input values, never the
 * URL bar, never `location.search`. The server redacts everything again
 * on receipt — the client's discipline is the first lock, not the only
 * one.
 *
 * ── VOLUME, FLUSH, AND THE HOLE ─────────────────────────────────────────────
 *
 * Errors always get a buffer slot; metrics are batched and bounded. The
 * flush policy (named constants in client-config.ts, cited against
 * research/client-telemetry/RESEARCH.md): flush on idle (the page is
 * alive, `requestIdleCallback`), on run end (the ingest-lag report), on
 * buffer pressure, and on `visibilitychange → hidden` — the last via
 * `navigator.sendBeacon`, the one transport that survives the page going
 * away, with the broker's fetch as the fallback. Over-cap events are
 * never silently dropped: the client counts them and the next accepted
 * batch carries the count, so the ledger holds the hole too.
 *
 * ── NEVER THROWS INTO THE APP ───────────────────────────────────────────────
 *
 * Observability must not be the thing being observed. Every observer
 * attach and every capture is guarded; an API the page does not have
 * (Safari's longtask, a test environment's window) is an observable
 * absence — the module stays inert there, and no error path of this
 * module can reach the app's.
 *
 * Plain module (no Svelte, no DOM at import): Node-testable via Vitest.
 *
 * @global-store the buffer and the run latches are USER-SESSION facts (the
 * page's own errors and measurements for whoever is signed in), not per-chat
 * snapshots: a run's ingest report outlives a chat switch by design, and the
 * logout reset (registerReset) is the one boundary this store owes.
 */

import {
  TELEMETRY_DROPPED_MAX,
  TELEMETRY_FLUSH_MAX_EVENTS,
  TELEMETRY_MESSAGE_MAX_CHARS,
  TELEMETRY_RUN_METRIC_CAP,
  TELEMETRY_STACK_HEAD_MAX_CHARS,
} from "../client-config";
import { registerReset } from "./store-registry";

// ── The batch contract (the wire shape server/blocks/client-telemetry.ts
// validates; this module only ever produces well-formed batches) ─────────────

export type ClientTelemetryEventKind = "client-error" | "client-metric";

export type ClientTelemetryEvent = Readonly<{
  kind: ClientTelemetryEventKind;
  clientTimestamp: number;
  facts: Readonly<Record<string, string | number | boolean>>;
}>;

export type ClientTelemetryCorrelation = Readonly<{
  runId?: string;
  chatId?: string;
  traceId?: string;
}>;

export type ClientTelemetryBatch = Readonly<{
  events: readonly ClientTelemetryEvent[];
  correlation?: ClientTelemetryCorrelation;
  droppedCount?: number;
}>;

// ── The transport (injectable — the single door a flush leaves through) ──────

/**
 * ONE flush, one door. The default implementation posts through the broker
 * action door (CSRF header attached at the fetch choke point) while the
 * page lives and through `sendBeacon` when it is going away. Tests inject
 * a recording stub here — the wiring arms prove the buffer/flush/correlation
 * mechanics without owning network I/O.
 *
 * Returns whether the batch was accepted. A refusal is not an error to
 * surface — the caller counts the drop and moves on.
 */
export type TelemetryFlushSink = (batch: ClientTelemetryBatch) => Promise<boolean>;

// ── Module state ────────────────────────────────────────────────────────────

type BufferedEvent = {
  kind: ClientTelemetryEventKind;
  clientTimestamp: number;
  facts: Record<string, string | number | boolean>;
  /** The correlation this event was captured under (run-scoped facts carry
   * their run's claim; page-wide facts carry none). */
  correlation: ClientTelemetryCorrelation | null;
};

const state: {
  buffer: BufferedEvent[];
  dropped: number;
  /** Which capture hooks could not attach (an API this page lacks, or an
   * attach that threw) — the observable-absence record: a signal that is
   * dark is a fact about coverage, and it is counted, never swallowed. */
  attachAbsences: string[];
  /** Run correlation latches: the chat the stream bound, the trace the
   * metadata frame carried (the metadata-frame trace wiring — the client already holds both). */
  runChat: Map<string, string | null>;
  runTrace: Map<string, string>;
  /** Per-run ingest aggregates (dispatch → applied, per frame). */
  runFrames: Map<string, { count: number; maxMs: number }>;
  runMetrics: Map<string, number>;
  /** The long-task window aggregate (page-wide). */
  longTasks: { count: number; maxMs: number };
  bootMs: number | null;
  sink: TelemetryFlushSink | null;
  idleScheduled: boolean;
} = {
  buffer: [],
  dropped: 0,
  attachAbsences: [],
  runChat: new Map(),
  runTrace: new Map(),
  runFrames: new Map(),
  runMetrics: new Map(),
  longTasks: { count: 0, maxMs: 0 },
  bootMs: null,
  sink: null,
  idleScheduled: false,
};

/** Test seam: inject the flush door. Pass null to restore the default. */
export function installTelemetrySink(sink: TelemetryFlushSink | null): void {
  state.sink = sink;
}

// ── Capture ──────────────────────────────────────────────────────────────────

/**
 * Bound a captured string in CHARACTERS (the wire bound is bytes; a
 * multi-byte message is cut well inside it, and the server truncates its
 * own copy again).
 */
function clampText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}

/**
 * A script URL reduced to its FILE NAME. The full URL can carry a query
 * string, and a query string can carry anything — a token in a dev-server
 * cache-buster, a credential in a pasted link. The file name is the part
 * that identifies the source; everything else is discarded rather than
 * redacted, because the page cannot know what the rest contained.
 */
function sourceBasename(url: unknown): string {
  if (typeof url !== "string" || url.length === 0) return "";
  const noQuery = url.split(/[?#]/, 1)[0] ?? "";
  const slash = noQuery.lastIndexOf("/");
  return clampText(slash >= 0 ? noQuery.slice(slash + 1) : noQuery, TELEMETRY_MESSAGE_MAX_CHARS);
}

/** The FIRST stack frame, verbatim in shape, bounded in length. Stack
 * formats differ per browser; the server never parses it, so neither do
 * we — capture what exists, never invent the rest. */
function firstStackFrame(error: unknown): string {
  const stack = (error as { stack?: unknown } | null | undefined)?.stack;
  if (typeof stack !== "string" || stack.length === 0) return "";
  const lines = stack.split("\n");
  const frame = lines.length > 1 ? (lines[1] ?? "").trim() : (lines[0] ?? "").trim();
  return clampText(frame, TELEMETRY_STACK_HEAD_MAX_CHARS);
}

/**
 * Enqueue one event. THE VOLUME DISCIPLINE: the buffer's bound IS the
 * flush batch cap — reaching it fires the flush that drains it, so the
 * buffer cannot grow past one batch in memory. Errors always get a slot
 * (nothing displaces them: an uncaught error is the one fact this channel
 * exists for); the drops that can occur — a refused batch, a failed flush,
 * a metric past its per-run cap — are all COUNTED, and the next accepted
 * batch carries the count, so the ledger holds the hole too.
 */
function enqueue(
  kind: ClientTelemetryEventKind,
  facts: Record<string, string | number | boolean>,
  correlation: ClientTelemetryCorrelation | null,
): void {
  state.buffer.push({ kind, clientTimestamp: Date.now(), facts, correlation });
  if (state.buffer.length >= TELEMETRY_FLUSH_MAX_EVENTS) {
    void flushTelemetry().catch(() => undefined);
    return;
  }
  scheduleIdleFlush();
}

/** Count a drop (bounded — the counter mirrors what the server accepts). */
function noteDropped(n: number): void {
  state.dropped = Math.min(TELEMETRY_DROPPED_MAX, state.dropped + n);
}

// ── Flush ────────────────────────────────────────────────────────────────────

/**
 * Drain the buffer into bounded, single-claim batches and push each through
 * the sink. THE ONE CLAIM PER BATCH rule: events captured under different
 * correlations never share a batch — the batch's claim is verified by the
 * server as one statement about every event inside it. The drop count rides
 * the FIRST batch (a hole stated once, not amortized across batches that
 * might not all land).
 *
 * A refused or failed batch counts its events as dropped — they do not
 * come back (a stale error re-sent after the user moved on would be a fact
 * about the past presented as news, and the drop count is the honest
 * statement instead). A flush failure is this module's problem, never the
 * app's.
 */
async function drainBatches(sink: TelemetryFlushSink): Promise<Readonly<{ sent: number; refused: boolean }>> {
  if (state.buffer.length === 0 && state.dropped === 0 && state.longTasks.count === 0) {
    return { sent: 0, refused: false };
  }
  const take: BufferedEvent[] = [];
  // Fold the long-task window into the batch before sending: the aggregate
  // is a fact about the window that is closing, not a standing series.
  if (state.longTasks.count > 0) {
    const { count, maxMs } = state.longTasks;
    state.longTasks = { count: 0, maxMs: 0 };
    take.push({
      kind: "client-metric",
      clientTimestamp: Date.now(),
      facts: { longTaskMs: Math.round(maxMs), longTaskCount: count },
      correlation: null,
    });
  }
  take.push(...state.buffer.splice(0, TELEMETRY_FLUSH_MAX_EVENTS));
  const droppedNow = state.dropped;
  state.dropped = 0;
  try {
    const batches: ClientTelemetryBatch[] = [];
    const byClaim = new Map<string, BufferedEvent[]>();
    for (const event of take) {
      const key = event.correlation === null ? "" : JSON.stringify(event.correlation);
      const existing = byClaim.get(key);
      if (existing === undefined) byClaim.set(key, [event]);
      else existing.push(event);
    }
    for (const [key, events] of byClaim) {
      batches.push({
        events: events.map(({ kind, clientTimestamp, facts }) => ({ kind, clientTimestamp, facts })),
        ...(key === "" ? {} : { correlation: JSON.parse(key) as ClientTelemetryCorrelation }),
        ...(batches.length === 0 && droppedNow > 0 ? { droppedCount: droppedNow } : {}),
      });
    }
    if (batches.length === 0 && droppedNow > 0) {
      // Nothing buffered but a hole to report: the count still travels.
      batches.push({
        events: [{ kind: "client-metric", clientTimestamp: Date.now(), facts: { droppedClientEvents: droppedNow } }],
      });
    }
    let sent = 0;
    let refused = false;
    for (const batch of batches) {
      const ok = await sink(batch);
      if (ok) sent += batch.events.length;
      else {
        refused = true;
        noteDropped(batch.events.length);
      }
    }
    return { sent, refused };
  } catch {
    noteDropped(take.length);
    return { sent: 0, refused: true };
  }
}

/** Flush now, through the injected sink if one stands, else the broker door. */
export async function flushTelemetry(): Promise<Readonly<{ sent: number; refused: boolean }>> {
  return drainBatches(state.sink ?? defaultSink);
}

/**
 * The unload-path flush: `sendBeacon` — the transport built to survive the
 * page going away — with the beacon's own limits respected (the body is a
 * plain STRING: a JSON content type would force a CORS preflight a closing
 * page cannot wait for; text/plain is a simple content type and the
 * server's body reader is content-type-agnostic).
 *
 * A beacon that returns false (queue refused) counts the batch as dropped.
 */
export async function flushViaBeacon(): Promise<boolean> {
  if (state.sink !== null) {
    const result = await flushTelemetry();
    return !result.refused;
  }
  const result = await drainBatches(beaconSink);
  return !result.refused;
}

/** The beacon door: fire-and-forget, one POST per batch. */
const beaconSink: TelemetryFlushSink = async (batch) => {
  const beacon = (navigator as { sendBeacon?: (url: string, data?: string) => boolean } | undefined)?.sendBeacon;
  if (typeof beacon !== "function") return false;
  const { blockActionRequestPath } = await import("../data/broker.ts");
  const { DEFAULT_API_BASE } = await import("../client-config");
  return beacon(
    `${DEFAULT_API_BASE}${blockActionRequestPath("client.telemetry", "ingest")}`,
    JSON.stringify(batch),
  );
};

/** The default flush door (page alive): the broker's action POST — the one
 * write door, CSRF header attached at its fetch choke point. */
const defaultSink: TelemetryFlushSink = async (batch) => {
  const { action } = await import("../data/broker.ts");
  await action("client.telemetry", "ingest", batch as unknown as Record<string, unknown>, { origin: "automatic" });
  return true;
};

/**
 * Schedule the idle flush. ONE callback at a time, armed when the buffer
 * empties into a non-empty state — not a polling loop. `requestIdleCallback`
 * is guarded (Safari); without it the flush waits for run end, buffer
 * pressure, or the visibility flip, which are the triggers that matter
 * anyway.
 */
function scheduleIdleFlush(): void {
  if (state.idleScheduled) return;
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
  if (typeof idle !== "function") return;
  state.idleScheduled = true;
  idle(() => {
    state.idleScheduled = false;
    void flushTelemetry().catch(() => undefined);
  });
}

// ── The capture hooks (attached once, guarded) ──────────────────────────────

/**
 * Record WHICH capture hook is dark. An attach failure must not throw into
 * the app, but swallowing it silently would hide exactly the coverage gap
 * this module exists to state — so the absence is counted here, where a
 * debugging session can read it.
 */
function noteAttachAbsence(hook: string): void {
  if (state.attachAbsences.includes(hook)) return;
  state.attachAbsences.push(hook);
}

/** The capture hooks that could not attach on this page (diagnostics). */
export function telemetryAttachAbsences(): readonly string[] {
  return Object.freeze([...state.attachAbsences]);
}

/**
 * Attach every observer. Idempotent, guarded per API, and NEVER throws —
 * a page without the API (a test environment, an old engine) simply keeps
 * the module inert for that signal, which is the observable-absence rule:
 * absence is recorded by nothing arriving, not by an error.
 */
export function attachClientTelemetry(): void {
  const w = globalThis as {
    window?: typeof globalThis & {
      addEventListener?: typeof addEventListener;
      PerformanceObserver?: new (cb: (list: { getEntries(): { duration?: unknown }[] }) => void) => { observe: (opts: { type: string; buffered?: boolean }) => void };
      onerror: unknown;
    };
  };
  const win = w.window;
  if (win === undefined) return;
  try {
    win.addEventListener?.("error", (event: Event) => {
      // Only UNCAUGHT script errors — a resource-load error also fires this
      // hook with no `error` property and no script position; that is a
      // network/asset fact, not a page exception.
      const err = (event as { error?: unknown; message?: unknown; filename?: unknown; lineno?: unknown; colno?: unknown }).error;
      const message = (event as { message?: unknown }).message;
      const source = (event as { filename?: unknown }).filename;
      const line = (event as { lineno?: unknown }).lineno;
      const column = (event as { colno?: unknown }).colno;
      const facts: Record<string, string | number | boolean> = {
        message: clampText(typeof message === "string" ? message : String(message ?? "unknown error"), TELEMETRY_MESSAGE_MAX_CHARS),
        source: sourceBasename(source),
        ...(typeof line === "number" ? { line } : {}),
        ...(typeof column === "number" ? { column } : {}),
        ...(firstStackFrame(err) !== "" ? { stackHead: firstStackFrame(err) } : {}),
      };
      captureError(facts);
    });
  } catch {
    noteAttachAbsence("error");
  }
  try {
    win.addEventListener?.("unhandledrejection", (event: Event) => {
      const reason = (event as { reason?: unknown }).reason;
      const message =
        reason instanceof Error ? reason.message
        : typeof reason === "string" ? reason
        : "";
      captureError({
        message: clampText(message.length > 0 ? message : "unhandled promise rejection with no message", TELEMETRY_MESSAGE_MAX_CHARS),
        source: "promise",
        ...(firstStackFrame(reason) !== "" ? { stackHead: firstStackFrame(reason) } : {}),
      });
    });
  } catch {
    noteAttachAbsence("unhandledrejection");
  }
  try {
    const Observer = win.PerformanceObserver;
    // A page with no long-task observer keeps its OTHER signals — one dark
    // hook never ends the attach, and the dark hook itself is recorded.
    if (Observer === undefined) {
      noteAttachAbsence("longtask");
    }
    if (Observer !== undefined) {
      const observer = new Observer((list) => {
        for (const entry of list.getEntries()) {
          const duration = typeof entry.duration === "number" ? entry.duration : 0;
          if (duration > state.longTasks.maxMs) state.longTasks.maxMs = duration;
          state.longTasks.count += 1;
        }
      });
      // `buffered: true` reaches long tasks that fired before this module
      // attached (the Long Tasks API's own late-attach escape hatch), so
      // the deferred import cost does not blind the first seconds.
      observer.observe({ type: "longtask", buffered: true });
    }
  } catch {
    // A page with no long-task observer (or one that refused to attach)
    // keeps its other signals; the gap is recorded, not swallowed.
    noteAttachAbsence("longtask");
  }
  try {
    win.addEventListener?.("visibilitychange", () => {
      const document = (win as unknown as { document?: { visibilityState?: string } }).document;
      if (document?.visibilityState === "hidden") {
        void flushViaBeacon().catch(() => undefined);
      }
    });
  } catch {
    noteAttachAbsence("visibilitychange");
  }
}

/** Capture an uncaught error fact (the one signal that always gets a slot). */
export function captureError(facts: Record<string, string | number | boolean>): void {
  enqueue("client-error", facts, null);
}

/** Enqueue a page-wide measurement (bounded, droppable, counted). */
function enqueueMetric(
  facts: Record<string, string | number | boolean>,
  correlation: ClientTelemetryCorrelation | null,
  runId?: string,
): void {
  if (runId !== undefined) {
    const used = state.runMetrics.get(runId) ?? 0;
    if (used >= TELEMETRY_RUN_METRIC_CAP) {
      noteDropped(1);
      return;
    }
    state.runMetrics.set(runId, used + 1);
  }
  enqueue("client-metric", facts, correlation);
}

// ── The run-feed wiring (client.ts calls these at its own choke points) ──────

/**
 * The stream's bound chat, latched from the `connected` frame (the frame
 * always carries it and is always first).
 */
export function noteRunChat(runId: string, chatId: string | null): void {
  state.runChat.set(runId, chatId);
}

/**
 * The run's request trace, latched from the `metadata` frame — the same
 * id the run pane's trace row reads, the correlation key for everything
 * this run produced.
 */
export function latchRunTrace(runId: string, traceId: string): void {
  state.runTrace.set(runId, traceId);
}

/**
 * ONE FRAME APPLIED. `applyMs` is dispatch-to-applied — from the event
 * loop handing the page the frame to the stores holding it — measured at
 * the one choke point every run frame passes (openRunStream's listener
 * registrations). Aggregated per run; reported at run end.
 */
export function noteRunFrameApplied(runId: string, event: string, applyMs: number): void {
  const current = state.runFrames.get(runId) ?? { count: 0, maxMs: 0 };
  state.runFrames.set(runId, {
    count: current.count + 1,
    maxMs: Math.max(current.maxMs, applyMs),
  });
  void event;
}

/**
 * THE RUN ENDED (the `done`/`cancelled` frame). The ingest-lag report is
 * the run's own client-side summary — max dispatch-to-applied per frame
 * and the frame count, correlated with the run, the chat it sat in, and
 * the trace the run carried — flushed immediately while the page lives.
 */
export function finishRunTelemetry(runId: string): void {
  const agg = state.runFrames.get(runId);
  state.runFrames.delete(runId);
  const chatId = state.runChat.get(runId) ?? null;
  state.runChat.delete(runId);
  const traceId = state.runTrace.get(runId);
  state.runTrace.delete(runId);
  if (agg === undefined || agg.count === 0) return;
  enqueueMetric(
    { ingestLagMs: Math.round(agg.maxMs), ingestFrames: agg.count },
    {
      runId,
      ...(chatId !== null ? { chatId } : {}),
      ...(traceId !== undefined ? { traceId } : {}),
    },
    runId,
  );
  void flushTelemetry().catch(() => undefined);
}

/**
 * THE PAGE'S OWN BOOT COST — forwarded, not measured: the boot controller
 * already measures its waves (probes.ts `onComplete` totalMs); this is
 * the same number carried into the telemetry channel, one fact with one
 * measurer.
 */
export function noteBootMs(totalMs: number): void {
  if (state.bootMs !== null) return;
  state.bootMs = totalMs;
  enqueueMetric({ bootMs: Math.round(totalMs) }, null);
}

// ── Reset (logout: the buffer and the latches are the user's session) ────────

/**
 * Clear everything. On logout a buffered batch belongs to the departing
 * session — sending it after would attribute the previous user's page
 * facts to whoever logs in next, and dropping them silently is the
 * session boundary, not a telemetry loss (the count is not carried over:
 * a hole in one user's ledger is not the next user's fact to report).
 */
export function resetTelemetry(): void {
  state.buffer = [];
  state.dropped = 0;
  state.attachAbsences = [];
  state.runChat.clear();
  state.runTrace.clear();
  state.runFrames.clear();
  state.runMetrics.clear();
  state.longTasks = { count: 0, maxMs: 0 };
  state.bootMs = null;
  state.idleScheduled = false;
}

registerReset("clientTelemetry", resetTelemetry);

// ── Auto-attach ─────────────────────────────────────────────────────────────
//
// The observers are attached at module load — the same self-registering
// discipline the state stores use — so no caller can forget the wire-up.
// In a windowless environment (tests, SSR) the attach is a no-op by the
// guards above. client.ts imports this module, so the page loads it with
// the app; the captures exist from the first frame the app ingests.
attachClientTelemetry();
