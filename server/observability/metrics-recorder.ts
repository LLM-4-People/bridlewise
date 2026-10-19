/**
 * Metrics recorder — lightweight recording hooks that do NOT import the
 * canonical harness chain at module load time.
 *
 * Why this module exists: `tool-executor.ts` and `llm-bridge.ts` need to
 * record calls, but importing `metrics-bridge.ts` (which imports
 * `canonical.ts`) at module load triggers a circular-dependency TDZ in the
 * harness integration's `integrity.ts` → `debug-system.ts` chain. To break
 * the chain, this module holds a LAZY reference to the collector that is
 * set by `metrics-bridge.ts` at first use. The recording functions here
 * import nothing from `canonical.ts` at module load — they dereference the
 * collector only when a call is actually recorded.
 *
 * Token accumulation (for tokens/s) also lives here so the throughput is
 * tracked independently of the collector lifecycle.
 */

import type { MetricsCollector, MetricCorrelation, ResourceDelta } from "../kernel/canonical.ts";
// The ms↔s display unit — the shared conversion owner, never a bare 1000
// beside a tokens-per-second readout.
import { MS_PER_SECOND } from "../../shared/constants.ts";

// TYPE-ONLY import: erased at compile time, never triggers the canonical
// import chain at runtime. The actual collector instance is injected via
// `setMetricsCollector` below.

let collectorRef: MetricsCollector | undefined;

/**
 * Inject the canonical metrics collector. Called once by
 * `metrics-bridge.ts` when the collector is lazily created. After this,
 * `recordLlmCall` / `recordToolCall` will record into the real collector.
 */
export function setMetricsCollector(collector: MetricsCollector): void {
  collectorRef = collector;
}

// ── Token accumulator (for tokens/s) ──

const tokenAccumulator = {
  input: 0,
  output: 0,
  startTime: Date.now(),
};

/**
 * Cumulative input + output tokens since the server started, plus the
 * derived tokens/second rate. Used by the Metrics tab to show throughput.
 */
export function getTokenThroughput(): Readonly<{
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  elapsedMs: number;
  tokensPerSecond: number;
}> {
  const totalTokens = tokenAccumulator.input + tokenAccumulator.output;
  const elapsedMs = Date.now() - tokenAccumulator.startTime;
  const seconds = elapsedMs / MS_PER_SECOND;
  return {
    inputTokens: tokenAccumulator.input,
    outputTokens: tokenAccumulator.output,
    totalTokens,
    elapsedMs,
    tokensPerSecond: seconds > 0 ? totalTokens / seconds : 0,
  };
}

/**
 * Record an LLM call (stream completion) into the metrics collector.
 * The scope key is {module: "llm", function: modelId, scope: "stream"} so
 * each model gets its own entry with a duration histogram.
 *
 * `resource` carries the call's measured cost (CPU time + heap growth, from
 * the shared delta probe) when the caller measured it and the config
 * contract's `resourceDeltas.enabled` gate is on; it feeds the per-scope
 * cpu/ram aggregates in the collector's snapshot.
 */
export function recordLlmCall(
  modelId: string,
  durationMs: number,
  success: boolean,
  correlation: MetricCorrelation = {},
  tokens?: Readonly<{ input: number; output: number }>,
  resource?: ResourceDelta,
): void {
  const collector = collectorRef;
  if (collector !== undefined) {
    collector.recordCall(
      { module: "llm", function: modelId, scope: "stream" },
      { ...correlation, modelId },
      durationMs,
      success ? "succeeded" : "failed",
      "exact",
      resource,
    );
  }
  if (tokens !== undefined) {
    tokenAccumulator.input += tokens.input;
    tokenAccumulator.output += tokens.output;
  }
}

/**
 * Record a CANCELLED LLM call — a stream abandoned before its natural end
 * (the run was stopped, the consumer stopped pulling). The collector has a
 * cancellation counter of its own (`recordCancellation`, unclaimed until
 * now); this is the llm lane's door onto it, so the metrics lane and the
 * ledger lane agree that a cancel is neither a success nor a failure. The
 * same scope key as `recordLlmCall` so the one model's row answers with all
 * three counts. The measured duration is NOT a correlation label (label
 * cardinality is bounded by design); the cancellation count alone is the
 * metric, and the ledger event holds the duration.
 */
export function recordLlmCancellation(
  modelId: string,
  correlation: MetricCorrelation = {},
): void {
  const collector = collectorRef;
  if (collector === undefined) return;
  collector.recordCancellation(
    { module: "llm", function: modelId, scope: "stream" },
    { ...correlation, modelId },
  );
}

/**
 * Record a tool execution call. The scope key is
 * {module: "tool", function: toolName, scope: "execute"}.
 *
 * `resource` carries the call's measured cost (CPU time + heap growth, from
 * the shared delta probe) when the caller measured it and the config
 * contract's `resourceDeltas.enabled` gate is on; it feeds the per-scope
 * cpu/ram aggregates in the collector's snapshot.
 */
export function recordToolCall(
  toolName: string,
  durationMs: number,
  success: boolean,
  correlation: MetricCorrelation = {},
  resource?: ResourceDelta,
): void {
  const collector = collectorRef;
  if (collector !== undefined) {
    collector.recordCall(
      { module: "tool", function: toolName, scope: "execute" },
      { ...correlation, toolName },
      durationMs,
      success ? "succeeded" : "failed",
      "exact",
      resource,
    );
  }
}
