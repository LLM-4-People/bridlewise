/**
 * Self-improving analyzer — track harness performance and suggest
 * improvements in the Metrics dashboard.
 *
 * The harness ALREADY records per-function performance through the canonical
 * metrics collector (metrics-recorder.ts → metrics-bridge.ts): response
 * times (duration histograms), error rates (errorCount/callCount), and tool
 * success rates per tool name. This module is a PURE analyzer over that
 * existing snapshot — it does NOT re-record or rebuild anything (binding
 * reuse, do not rebuild). It computes typed improvement
 * suggestions from real signals:
 * Failing tools / models (high error rate).
 * Slow tools / models (high average duration).
 * High overall error rate.
 * Cancellation-heavy functions.
 *
 * Thresholds come from the single config owner (`getSelfImprovingConfig` —
 * no hardcoded magic numbers). Pure (no I/O, no deps beyond the
 * snapshot + config types) — fully testable in Node with adversarial input
 *. Invalid / empty / boundary snapshots are handled honestly
 * (return an empty or bounded list, never a throw — typed result).
 */

import type { MetricsSnapshot, MetricEntrySnapshot } from "../kernel/canonical.ts";
import { getSelfImprovingConfig, type SelfImprovingConfig } from "../kernel/harness-config.ts";

export type SuggestionSeverity = "high" | "medium" | "low";

export type SelfImprovementSuggestion = Readonly<{
  /** Severity drives sort order + UI color. */
  readonly severity: SuggestionSeverity;
  /** The area the suggestion applies to (tool / llm / overall / cancellation). */
  readonly area: string;
  /** A short signal label shown in the UI (e.g. "read_file: 42% error rate"). */
  readonly signal: string;
  /** The actionable recommendation. */
  readonly suggestion: string;
  /** The function key that triggered the suggestion (module/function/scope), if any. */
  readonly functionKey?: Readonly<{ module: string; function: string; scope: string }>;
}>;

/** Average duration (ms) for an entry, or 0 when there are no recorded samples. */
function avgDurationMs(entry: MetricEntrySnapshot): number {
  const total = entry.durationHistogram.totalCount;
  return total > 0 ? entry.durationHistogram.sumMs / total : 0;
}

/** Error rate (errorCount/callCount), or 0 when there are no calls. */
function errorRate(entry: MetricEntrySnapshot): number {
  return entry.callCount > 0 ? entry.errorCount / entry.callCount : 0;
}

/** Cancellation rate (cancellationCount/callCount), or 0 when there are no calls. */
function cancellationRate(entry: MetricEntrySnapshot): number {
  return entry.callCount > 0 ? entry.cancellationCount / entry.callCount : 0;
}

/**
 * Compute typed improvement suggestions from a metrics snapshot. Pure: same
 * snapshot + config → same suggestions (deterministic). The config is
 * resolved from the single owner when omitted; tests pass an explicit
 * config for hermetic, deterministic assertions. Suggestions are sorted by
 * severity (high → medium → low) and capped at `config.maxSuggestions`.
 */
export function computeSelfImprovementSuggestions(
  snapshot: MetricsSnapshot,
  config: SelfImprovingConfig = getSelfImprovingConfig(),
): readonly SelfImprovementSuggestion[] {
  const suggestions: SelfImprovementSuggestion[] = [];

  // Overall error rate across every function — the broadest health signal.
  if (snapshot.totalCallCount >= config.minSampleCount) {
    const overallErrorRate = snapshot.totalCallCount > 0
      ? snapshot.totalErrorCount / snapshot.totalCallCount
      : 0;
    if (overallErrorRate >= config.errorRateThreshold) {
      suggestions.push({
        severity: "high",
        area: "overall",
        signal: `Overall error rate ${(overallErrorRate * 100).toFixed(1)}% across ${snapshot.totalCallCount} calls`,
        suggestion: `The harness error rate is above the ${config.errorRateThreshold * 100}% threshold. Investigate the failing functions below and the recent error events in the Timeline tab.`,
      });
    }
  }

  // Per-function analysis (tools + LLM). The module key distinguishes the
  // area so the suggestion + threshold are area-appropriate (tools vs LLM
  // have different latency expectations — both configurable).
  for (const entry of snapshot.entries) {
    if (entry.callCount < config.minSampleCount) continue;
    const mod = entry.key.module;
    const fn = entry.key.function;
    const rate = errorRate(entry);
    const avg = avgDurationMs(entry);
    const key = { module: mod, function: fn, scope: entry.key.scope };

    if (mod === "tool") {
      if (rate >= config.errorRateThreshold) {
        suggestions.push({
          severity: "high",
          area: "tool",
          signal: `Tool '${fn}': ${(rate * 100).toFixed(1)}% error rate (${entry.errorCount}/${entry.callCount})`,
          suggestion: `The tool '${fn}' is failing often. Inspect its recent error outputs in the chat/Timeline — a persistent failure usually means a stale preimage, a path-outside-root, or an adapter misconfiguration.`,
          functionKey: key,
        });
      }
      if (avg >= config.slowToolMsThreshold) {
        suggestions.push({
          severity: "medium",
          area: "tool",
          signal: `Tool '${fn}': avg ${avg.toFixed(0)}ms per call`,
          suggestion: `The tool '${fn}' is slower than the ${config.slowToolMsThreshold}ms threshold. If it scans the project (search_code, get_repository_map), consider narrowing its scope or relying on the cached repository map / quick-view instead.`,
          functionKey: key,
        });
      }
    } else if (mod === "llm") {
      if (rate >= config.errorRateThreshold) {
        suggestions.push({
          severity: "high",
          area: "llm",
          signal: `Model '${fn}': ${(rate * 100).toFixed(1)}% error rate (${entry.errorCount}/${entry.callCount})`,
          suggestion: `The model '${fn}' is returning errors often. Check the API key/base URL in Settings, the provider rate limits, and the recent error model events — retryable provider errors should not dominate a session.`,
          functionKey: key,
        });
      }
      if (avg >= config.slowLlmMsThreshold) {
        suggestions.push({
          severity: "medium",
          area: "llm",
          signal: `Model '${fn}': avg ${avg.toFixed(0)}ms per call`,
          suggestion: `The model '${fn}' averages above the ${config.slowLlmMsThreshold}ms threshold. For long completions this is expected; for short turns consider a faster model or trimming the context (the Context section shows the token pressure).`,
          functionKey: key,
        });
      }
    }

    // Cancellation-heavy functions (either area) — a sign of steering churn
    // or impatient retries.
    const cancelRate = cancellationRate(entry);
    if (cancelRate >= config.errorRateThreshold) {
      suggestions.push({
        severity: "low",
        area: "cancellation",
        signal: `'${fn}': ${(cancelRate * 100).toFixed(1)}% cancellation rate (${entry.cancellationCount}/${entry.callCount})`,
        suggestion: `The function '${fn}' is cancelled often. Frequent cancellations can indicate steering churn or slow responses the user aborts — review the steering events in the Timeline tab.`,
        functionKey: key,
      });
    }
  }

  const severityRank: Record<SuggestionSeverity, number> = { high: 0, medium: 1, low: 2 };
  suggestions.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
  return suggestions.slice(0, config.maxSuggestions);
}
