import { deepFreeze } from "../kernel/integrity.ts";
import { isPromiseLike } from "../shared/type-guards.ts";
import { recordEffectAuto } from "../timeline/recorded-effect.ts";
import { currentRecordingContext } from "../timeline/recording-context.ts";

/**
 * Engine auto-instrumentation — the decoration owner for the canonical hub.
 *
 * THE MEASURED HOLE this module closes: engine internals (kernel, memory,
 * quality, safety, config) were dark. A new engine function became
 * server-visible the moment the hub re-exported it, but nothing wrapped it,
 * so a request could spend its time inside engine code the ledger could not
 * see. Hand-wrapping every re-export is the "remember to record" defect the
 * recorded-effect wrapper exists to remove.
 *
 * THE CHOKE POINT. Every value a server route can call crosses ONE import
 * boundary — the canonical hub (`server/kernel/canonical.ts`), mechanically
 * enforced as the only engine import path for `server/`. Decorating AT the
 * hub therefore instruments exactly the population a request can reach:
 *
 *   - a NEW re-export flows through this decoration the day it lands (the
 *     hub's value re-exports are destructured from `engineSpans(...)`), so
 *     coverage is deny-by-default, never opt-in;
 *   - engine-INTERNAL calls never cross the hub, so they are neither
 *     double-recorded (the harness runtime has its own sink) nor recursive
 *     with the sink's own machinery.
 *
 * This is the same shape OpenTelemetry's JS instrumentation uses — wrap the
 * module's exported functions at the boundary — minus the loader-hook
 * fragility, because the hub already IS the boundary (research record:
 * research/engine-auto-instrumentation/).
 *
 * VOLUME DISCIPLINE. A span is recorded ONLY when an ambient recording
 * context is active (inside a request boundary). Boot, CLI and background
 * ticks pay one `AsyncLocalStorage.getStore()` read and pass through —
 * measured at ~55 ns/call (the microbenchmark beside the research record).
 * Inside a request, each hub call is one ledger event: the point.
 *
 * RE-ENTRANCY. The web sink writes ledger events through hub-imported
 * helpers; an engine span emitted while the sink runs would call the sink
 * again. The sink wraps its body in `withoutEngineSpans`, and the hot
 * sink-path helpers are excluded below — the same flag discipline the
 * OpenTelemetry instrumentation framework uses to keep instrumented
 * recording machinery from observing itself.
 */

/** One reviewed exclusion from engine-span decoration. */
export type EngineSpanExclusion = Readonly<{
  /** Why this function must not be decorated. */
  rationale: string;
  /** The reviewing owner. */
  owner: string;
  /** Where the evidence for the review lives. */
  evidence: readonly string[];
  /** The scope of the exclusion (this instrumentation). */
  scope: string;
}>;

/**
 * The reviewed exclusions, keyed `${architecture-module-id}:${functionName}` —
 * the same key the function manifest's own exclusion mechanism uses.
 *
 * Three families, each reviewed against call rate and role:
 *
 *   1. RECORDING MACHINERY (`recordEffect`, `withSpan`, the ambient
 *      readers…) — wrapping the recorder in its own span is meta-recording:
 *      the span observes the recording of other spans, and the sink calls
 *      several of these per emitted event, so decoration would recurse at
 *      write time.
 *   2. ID/HASH MINTING (`generateId`, `canonicalHash`, `canonicalJson`,
 *      `deepFreeze`, `randomUuid`) — the hottest functions in the estate:
 *      called per ledger event, per manifest entry, per config read. A span
 *      per mint would multiply ledger volume by the event size and put a
 *      recording cost inside the write path itself.
 *   3. SINK-PATH HELPERS (`truncateForLedger`, `eventTypeForEffectKind`) —
 *      called by the web sink for EVERY effect record; excluded for volume
 *      and because they sit inside the re-entrancy window.
 *
 * `withoutEngineSpans` (this module's own suppression primitive, re-exported
 * through the hub for the sink) is excluded for the same reason as family 1.
 *
 * A name may join this table only with all four review fields filled; the
 * manifest gate (tests/prevention/recording-choke-points.test.ts class G +
 * the function-manifest cross-check) verifies membership and review
 * discipline mechanically.
 */
export const ENGINE_SPAN_EXCLUSIONS: Readonly<Record<string, EngineSpanExclusion>> = deepFreeze({
  "src-process-fault-policy:guarded": {
    rationale: "Event-loop machinery: wraps every timer, listener and watch callback at its registration (per request body, per stream, per child); a span per registration would add ledger rows to every request for no effect worth recording, and the wrapper itself reports its faults to the fault policy it belongs to.",
    owner: "performance-observability",
    evidence: ["engine/src/process/fault-policy.ts", "engine/scripts/verification/event-loop-callbacks.ts"],
    scope: "engine-auto-instrumentation",
  },
  "src-timeline-effect-sink:createTimelineEffectSink": {
    rationale: "Recording machinery: constructing the shared sink must not emit a standalone effect or recurse through the sink being installed.",
    owner: "performance-observability",
    evidence: ["engine/src/timeline/effect-sink.ts"],
    scope: "engine-auto-instrumentation",
  },
  "src-timeline-recorded-effect:recordEffect": {
    rationale: "Recording machinery: wrapping the span-recording primitive in its own span is meta-recording, and it is called per effect at every choke point.",
    owner: "performance-observability",
    evidence: ["research/engine-auto-instrumentation/README.md", "engine/src/performance/engine-instrumentation.ts"],
    scope: "engine-auto-instrumentation",
  },
  "src-timeline-recorded-effect:recordEffectAsync": {
    rationale: "Recording machinery: the async span primitive — same meta-recording and per-effect call rate as recordEffect.",
    owner: "performance-observability",
    evidence: ["research/engine-auto-instrumentation/README.md", "engine/src/performance/engine-instrumentation.ts"],
    scope: "engine-auto-instrumentation",
  },
  "src-timeline-recorded-effect:setEffectSink": {
    rationale: "Recording machinery: sink installation is boot-time only and part of the recording pipeline itself.",
    owner: "performance-observability",
    evidence: ["research/engine-auto-instrumentation/README.md"],
    scope: "engine-auto-instrumentation",
  },
  "src-timeline-recording-context:withSpan": {
    rationale: "Recording machinery: the span primitive the engine span itself runs inside — wrapping it nests a span in itself.",
    owner: "performance-observability",
    evidence: ["research/engine-auto-instrumentation/README.md"],
    scope: "engine-auto-instrumentation",
  },
  "src-timeline-recording-context:withRecordingContext": {
    rationale: "Recording boundary machinery: a span here would duplicate the boundary's own lifecycle recording and cover whole handlers at request rate.",
    owner: "performance-observability",
    evidence: ["research/engine-auto-instrumentation/README.md"],
    scope: "engine-auto-instrumentation",
  },
  "src-timeline-recording-context:currentActor": {
    rationale: "Recording machinery: an ambient read called per recorded event by sinks and readers; a span per read is pure overhead.",
    owner: "performance-observability",
    evidence: ["research/engine-auto-instrumentation/README.md"],
    scope: "engine-auto-instrumentation",
  },
  "src-timeline-recording-context:currentRecordingContext": {
    rationale: "Recording machinery: the ambient read this decoration's own gate performs; decorating it would observe every context check.",
    owner: "performance-observability",
    evidence: ["research/engine-auto-instrumentation/README.md"],
    scope: "engine-auto-instrumentation",
  },
  "src-timeline-recording-context:amendRecordingContext": {
    rationale: "Recording machinery: an ambient-context mutation used by record boundaries; meta-recording, per-boundary call rate.",
    owner: "performance-observability",
    evidence: ["research/engine-auto-instrumentation/README.md"],
    scope: "engine-auto-instrumentation",
  },
  "src-kernel-integrity:generateId": {
    rationale: "Id minting is the hottest call in the estate — every ledger event, span and entity mints one; a span per mint multiplies ledger volume by event count and sits inside the write path.",
    owner: "performance-observability",
    evidence: ["research/engine-auto-instrumentation/README.md", "engine/src/timeline/timeline-recorder.ts"],
    scope: "engine-auto-instrumentation",
  },
  "src-kernel-integrity:canonicalHash": {
    rationale: "Hash minting at per-event and per-manifest-entry rate (the metrics collector keys every entry through it); span cost exceeds work cost by orders of magnitude.",
    owner: "performance-observability",
    evidence: ["research/engine-auto-instrumentation/README.md", "engine/src/performance/metrics-collector.ts"],
    scope: "engine-auto-instrumentation",
  },
  "src-kernel-integrity:canonicalJson": {
    rationale: "Serialization minting at per-hash rate; the span would cost more than the call and sit inside every hashing path.",
    owner: "performance-observability",
    evidence: ["research/engine-auto-instrumentation/README.md"],
    scope: "engine-auto-instrumentation",
  },
  "src-kernel-integrity:deepFreeze": {
    rationale: "Called per manifest entry and per frozen config object — thousands of times per build/read; a span per freeze is volume with no diagnostic value.",
    owner: "performance-observability",
    evidence: ["research/engine-auto-instrumentation/README.md"],
    scope: "engine-auto-instrumentation",
  },
  "src-kernel-integrity:randomUuid": {
    rationale: "Non-identifier uniqueness minting at per-artifact rate; same hot-minting shape as generateId.",
    owner: "performance-observability",
    evidence: ["research/engine-auto-instrumentation/README.md"],
    scope: "engine-auto-instrumentation",
  },
  "ledger-primitives:truncateForLedger": {
    rationale: "Sink-path helper: called by the web effect sink for every record's text; excluded for volume and because it runs inside the sink's re-entrancy window.",
    owner: "performance-observability",
    evidence: ["research/engine-auto-instrumentation/README.md", "server/observability/timeline-bridge.ts"],
    scope: "engine-auto-instrumentation",
  },
  "timeline-types:eventTypeForEffectKind": {
    rationale: "Sink-path helper: the kind-to-lane lookup the web sink performs per effect record; same volume and re-entrancy reasoning as truncateForLedger.",
    owner: "performance-observability",
    evidence: ["research/engine-auto-instrumentation/README.md", "server/observability/timeline-bridge.ts"],
    scope: "engine-auto-instrumentation",
  },
  "performance-engine-instrumentation:withoutEngineSpans": {
    rationale: "This module's own re-entrancy suppression primitive, called by the sink at emit time — decorating it would open a span exactly when suppression must hold.",
    owner: "performance-observability",
    evidence: ["research/engine-auto-instrumentation/README.md", "server/observability/timeline-bridge.ts"],
    scope: "engine-auto-instrumentation",
  },
  "shared-exposure-index:readSignal": {
    rationale: "Loop-called value read: the settings-values route reads every signal in one request (measured 196 calls per GET /api/schema/ui/values), so a span per read multiplied the route past its response budget (measured 269–299 ms vs the 250 ms budget; 240 ledger events per request). The signal's VALUE is already exposed through the block doors; the per-signal loop is the route's shape, not per-call work worth a ledger row.",
    owner: "performance-observability",
    evidence: ["research/engine-auto-instrumentation/README.md", "docs/trackers/ALL-BUGS-AND-ISSUES.md (Round 19 exclusion review)"],
    scope: "engine-auto-instrumentation",
  },
  "privacy-policy:redactionReplacement": {
    rationale: "Pure formatter: builds the replacement marker text a mask writes. Called at the MCP output mask door for every server output (tool result, tool error, stderr line); the span would record a string being formatted, not an effect, once per output.",
    owner: "performance-observability",
    evidence: ["docs/trackers/workflow-lessons/2026-09-29-a-hub-re-export-is-instrumentation.md", "server/integrations/mcp-runtime-bridge.ts"],
    scope: "engine-auto-instrumentation",
  },
  "shared-llm-config:resolveResponsesTransportConfig": {
    rationale: "Pure config resolution: the server's getResponsesTransportSettings resolves the transport section on every provider request and provider-error text cap; a span per call records no effect and adds ledger rows to every request.",
    owner: "performance-observability",
    evidence: ["docs/trackers/workflow-lessons/2026-09-29-a-hub-re-export-is-instrumentation.md", "server/kernel/harness-config.ts"],
    scope: "engine-auto-instrumentation",
  },
  "performance-metrics-collector:quantileFromHistogram": {
    rationale: "Loop-called arithmetic: the metrics source computes p50/p95/p99 per collector entry on every snapshot assembly (measured 42 calls per settings-values request), and each span costs more than the computation it observes — pure overhead with no diagnostic value.",
    owner: "performance-observability",
    evidence: ["research/engine-auto-instrumentation/README.md", "docs/trackers/ALL-BUGS-AND-ISSUES.md (Round 19 exclusion review)"],
    scope: "engine-auto-instrumentation",
  },
});

/** The marker a decorated engine function carries (non-enumerable). */
const ENGINE_SPAN_MARKER = Symbol("engineSpan");

/**
 * How deep the re-entrancy suppression runs. Incremented by
 * `withoutEngineSpans` for the duration of a sink's synchronous body; any
 * wrapped engine function called while it is non-zero passes through
 * unrecorded — the recording machinery must not observe itself.
 */
let spanSuppressionDepth = 0;

/**
 * Run `fn` with engine spans suppressed.
 *
 * The web effect sink wraps its body in this: the sink writes a ledger event
 * by calling hub-imported helpers, and an engine span emitted from inside
 * that write would call the sink again. Synchronous by contract (the emit
 * path is sync), so a depth counter with try/finally is exact.
 */
export function withoutEngineSpans<T>(fn: () => T): T {
  spanSuppressionDepth += 1;
  try {
    return fn();
  } finally {
    spanSuppressionDepth -= 1;
  }
}

/** Whether `value` is a function this decoration can wrap. Classes (and any
 *  function whose prototype carries more than the implicit constructor) pass
 *  through RAW: a wrapper cannot forward `new` while preserving the original
 *  prototype chain, so a class re-exported through the hub stays undecorated
 *  rather than silently broken. */
function isWrappableFunction(fn: (...args: never[]) => unknown): boolean {
  const proto = fn.prototype as Record<string, unknown> | undefined;
  if (proto === undefined) return true; // arrow/bound — no prototype to preserve
  return Object.getOwnPropertyNames(proto).length <= 1; // just `constructor`
}

/** Whether `value` carries the engine-span marker. */
export function isEngineSpan(value: unknown): boolean {
  return (
    typeof value === "function" &&
    (value as { [ENGINE_SPAN_MARKER]?: boolean })[ENGINE_SPAN_MARKER] === true
  );
}

/**
 * The SHAPE of one invocation argument — the only thing about it an engine
 * span may know. Mirrors the db lane's discipline: a type name always; a
 * byte length where size is the interesting fact; key NAMES and counts for
 * objects (engine functions take rich config objects whose key vocabulary is
 * schema, not data). There is deliberately no branch that returns the VALUE
 * itself, so no argument value can reach a ledger document through this
 * channel no matter how the call sites grow — the redaction owner never sees
 * raw values because none are captured.
 */
const MAX_SHAPE_KEYS = 16;
const MAX_KEY_NAME_BYTES = 64;

function engineArgShape(value: unknown): Readonly<Record<string, unknown>> {
  switch (typeof value) {
    case "string":
      return { type: "string", bytes: Buffer.byteLength(value, "utf8") };
    case "number":
    case "boolean":
    case "bigint":
    case "symbol":
    case "undefined":
      return { type: typeof value };
    case "function":
      return { type: "function", name: typeof value.name === "string" ? value.name : "" };
    case "object": {
      if (value === null) return { type: "null" };
      if (Array.isArray(value)) return { type: "array", length: value.length };
      if (value instanceof Map) return { type: "map", size: value.size };
      if (value instanceof Set) return { type: "set", size: value.size };
      if (value instanceof Date) return { type: "date" };
      if (value instanceof RegExp) return { type: "regexp", bytes: Buffer.byteLength(value.source, "utf8") };
      if (isPromiseLike(value)) return { type: "promise" };
      const keys = Object.keys(value);
      return {
        type: "object",
        count: keys.length,
        keys: keys.slice(0, MAX_SHAPE_KEYS).map((key) => key.slice(0, MAX_KEY_NAME_BYTES)),
      };
    }
    default:
      return { type: typeof value };
  }
}

/**
 * The shapes of an invocation's arguments, as the span's `args` document:
 * count + per-argument shape. Bounded twice — the key/length caps above, and
 * the sink's own per-document bound on the stored payload.
 */
export function engineArgsShape(args: readonly unknown[]): Readonly<Record<string, unknown>> {
  return { count: args.length, args: args.map(engineArgShape) };
}

/**
 * Decorate every function-valued export of `moduleExports` with an engine
 * span, unless the reviewed exclusion table names it.
 *
 * Non-function exports (schemas, constants, type-only members) pass through
 * unchanged — there is nothing to measure on a value nobody calls. The
 * result is a plain object with the same keys, so the hub destructures the
 * decorated names exactly where the old re-export statements stood.
 *
 * The span records ONLY inside an ambient recording context (a request):
 * outside one — boot, CLI, background ticks — the wrapper performs one
 * ambient read and calls through, which is the measured near-zero cost the
 * whole design depends on. Excluded functions keep their RAW identity, so
 * identity comparisons and hot-path calls see the original function.
 */
export function engineSpans<T extends object>(moduleExports: T, moduleId: string): T {
  const decorated: Record<string, unknown> = {};
  for (const name of Object.keys(moduleExports)) {
    const value: unknown = (moduleExports as Record<string, unknown>)[name];
    const excluded = ENGINE_SPAN_EXCLUSIONS[`${moduleId}:${name}`];
    if (typeof value !== "function" || excluded !== undefined) {
      decorated[name] = value;
      continue;
    }
    if (!isWrappableFunction(value as (...args: never[]) => unknown)) {
      decorated[name] = value;
      continue;
    }
    const original = value as (...args: never[]) => unknown;
    const wrapped = function (this: unknown, ...args: never[]): unknown {
      if (currentRecordingContext() === undefined || spanSuppressionDepth > 0) {
        return original.apply(this, args);
      }
      return recordEffectAuto("engine", name, () => original.apply(this, args), {
        argsOf: () => engineArgsShape(args),
      });
    } as (...args: never[]) => unknown;
    // The wrapper answers to the original's name — span descriptions and any
    // fn.name diagnostics keep working.
    Object.defineProperty(wrapped, "name", { value: name, configurable: true });
    Object.defineProperty(wrapped, ENGINE_SPAN_MARKER, {
      value: true,
      enumerable: false,
      configurable: true,
    });
    decorated[name] = wrapped;
  }
  return decorated as T;
}
