/**
 * EXP424 — Workflow Improver: the mechanical layer that analyzes the
 * command log for inefficiencies and suggests improvements.
 *
 * Inefficiency categories (the only catalog — see config.ts):
 * 1. duplicate_calls — same (command, args) called many times across runs.
 * 2. missing_cache — high duplicate rate → caching would help.
 * 3. missing_shortcut — a long sequence of commands could be batched.
 * 4. missing_tool — a recurring pattern has no dedicated tool.
 * 5. bad_tool_choice — the LLM keeps picking the wrong tool.
 * 6. context_waste — successful commands return too-large outputs.
 * 7. retry_storm — many retries in a short window.
 * 8. feedback_loop — same mistake repeated > N times across runs.
 * 9. unbatched_calls — many small calls that could be one big call.
 * 10. low_cache_hit_rate — search cache hit rate is low.
 *
 * Improvements are EITHER auto-applied (if `safe: true` AND the action is
 * whitelisted) OR surfaced as a recommendation to the user.
 */

import {
  type CommandLog,
  type CommandRecord,
} from "./command-log.ts";
import {
  type Improvement,
  IMPROVEMENT_SCHEMA,
  type InefficiencyType,
  type SelfImprovingConfig,
} from "./config.ts";
import { canonicalHash } from "../kernel/integrity.ts";
import { InputError } from "../kernel/errors.ts";

/** Whitelisted safe actions (auto-applied). */
export const SAFE_ACTIONS: ReadonlySet<string> = new Set([
  "add_cache",
  "add_shortcut",
  "add_retry_budget",
  "increase_viewport",
  "decrease_viewport",
  "add_preimage_check",
  "add_timeout",
  "add_language_filter",
  "batch_calls",
  "suggest_tool",
]);

/** A workflow-inefficiency finding (raw, before improvement emission). */
export interface InefficiencyFinding {
  type: InefficiencyType;
  evidence: string;
  occurrences: number;
  /** The suggested improvement (deterministic). */
  suggestion: string;
  /** Whether the action is whitelisted as safe. */
  safe: boolean;
}

/**
 * Analyze a CommandLog for inefficiencies. Returns one InefficiencyFinding
 * per (type, evidence) pair, filtered by minInefficiencyOccurrences.
 */
export function analyzeInefficiencies(
  log: CommandLog,
  config: SelfImprovingConfig,
): InefficiencyFinding[] {
  const findings: InefficiencyFinding[] = [];

  // (1) duplicate_calls + (2) missing_cache
  const duplicatesByHash = new Map<string, CommandRecord[]>();
  for (const r of log.all()) {
    const group = duplicatesByHash.get(r.argsHash) ?? [];
    group.push(r);
    duplicatesByHash.set(r.argsHash, group);
  }
  let duplicateCount = 0;
  for (const [hash, group] of duplicatesByHash.entries()) {
    if (group.length < config.minInefficiencyOccurrences) continue;
    duplicateCount += group.length - 1;
    findings.push({
      type: "duplicate_calls",
      evidence: `command="${group[0]!.command}" called ${group.length} times (hash=${hash.slice(0, 8)})`,
      occurrences: group.length,
      suggestion: "add_cache",
      safe: SAFE_ACTIONS.has("add_cache"),
    });
  }
  if (duplicateCount > config.duplicateCallThreshold) {
    findings.push({
      type: "missing_cache",
      evidence: `${duplicateCount} duplicate calls across runs — caching would save ${duplicateCount} calls`,
      occurrences: duplicateCount,
      suggestion: "add_cache",
      safe: SAFE_ACTIONS.has("add_cache"),
    });
  }

  // (3) missing_shortcut — N+ calls of the same type in the same turn
  const byTurn = new Map<string, CommandRecord[]>();
  for (const r of log.all()) {
    const key = `${r.runId}:${r.turn}`;
    const list = byTurn.get(key) ?? [];
    list.push(r);
    byTurn.set(key, list);
  }
  for (const [key, list] of byTurn.entries()) {
    if (list.length < 5) continue;
    findings.push({
      type: "missing_shortcut",
      evidence: `${list.length} calls in turn ${key} could be batched into one`,
      occurrences: list.length,
      suggestion: "batch_calls",
      safe: SAFE_ACTIONS.has("batch_calls"),
    });
  }

  // (4) missing_tool — recurring pattern with no dedicated tool
  const byCommand = new Map<string, number>();
  for (const r of log.all()) {
    byCommand.set(r.command, (byCommand.get(r.command) ?? 0) + 1);
  }
  for (const [cmd, count] of byCommand.entries()) {
    if (count < config.minInefficiencyOccurrences * 5) continue;
    // Heuristic: commands ending with "_v2", "_v3" suggest a missing canonical tool.
    if (/_v\d+$/u.test(cmd) || cmd.includes("ad_hoc") || cmd.includes("custom_")) {
      findings.push({
        type: "missing_tool",
        evidence: `command "${cmd}" called ${count} times — consider a dedicated tool`,
        occurrences: count,
        suggestion: "add_tool",
        safe: false, // not whitelisted — surfaced to the user
      });
    }
  }

  // (5) bad_tool_choice — recurring tool_misuse mistakes
  // (the mistake detector flags these; here we just count them)
  const misuseCount = log.all().filter((r) => !r.result.ok &&
    (r.result.output.toLowerCase().includes("wrong tool") ||
     r.result.output.toLowerCase().includes("misuse"))).length;
  if (misuseCount >= config.minInefficiencyOccurrences) {
    findings.push({
      type: "bad_tool_choice",
      evidence: `${misuseCount} tool-misuse failures — suggest the right tool proactively`,
      occurrences: misuseCount,
      suggestion: "suggest_tool",
      safe: SAFE_ACTIONS.has("suggest_tool"),
    });
  }

  // (6) context_waste — successful commands return large outputs
  let largeOutputs = 0;
  for (const r of log.all()) {
    if (!r.result.ok) continue;
    if (r.result.output.length > config.largeOutputChars) largeOutputs += 1;
  }
  if (largeOutputs >= config.minInefficiencyOccurrences) {
    findings.push({
      type: "context_waste",
      evidence: `${largeOutputs} successful commands returned outputs > ${config.largeOutputChars} chars — slice or compress`,
      occurrences: largeOutputs,
      suggestion: "increase_viewport", // ironically, decreasing the viewport reduces waste
      safe: SAFE_ACTIONS.has("decrease_viewport"),
    });
  }

  // (7) retry_storm — many retries in a short window
  const retries = log.all().filter((r) => r.isRetry);
  if (retries.length >= config.minInefficiencyOccurrences * 2) {
    findings.push({
      type: "retry_storm",
      evidence: `${retries.length} retries — consider a fallback action instead`,
      occurrences: retries.length,
      suggestion: "add_retry_budget",
      safe: SAFE_ACTIONS.has("add_retry_budget"),
    });
  }

  // (8) feedback_loop — same mistake repeated across runs
  const mistakeByArgsHash = new Map<string, Set<string>>();
  for (const r of log.all()) {
    if (!r.result.ok) {
      const set = mistakeByArgsHash.get(r.argsHash) ?? new Set<string>();
      set.add(r.runId);
      mistakeByArgsHash.set(r.argsHash, set);
    }
  }
  for (const [hash, runs] of mistakeByArgsHash.entries()) {
    if (runs.size < config.minInefficiencyOccurrences) continue;
    findings.push({
      type: "feedback_loop",
      evidence: `command (hash=${hash.slice(0, 8)}) failed in ${runs.size} runs — no learning`,
      occurrences: runs.size,
      suggestion: "add_preimage_check",
      safe: SAFE_ACTIONS.has("add_preimage_check"),
    });
  }

  // (9) unbatched_calls — many small calls of the same type per turn
  for (const [key, list] of byTurn.entries()) {
    if (list.length < 3) continue;
    const sameType = new Map<string, number>();
    for (const r of list) {
      sameType.set(r.type, (sameType.get(r.type) ?? 0) + 1);
    }
    for (const [t, count] of sameType.entries()) {
      if (count >= 3) {
        findings.push({
          type: "unbatched_calls",
          evidence: `${count} ${t} calls in turn ${key} could be batched`,
          occurrences: count,
          suggestion: "batch_calls",
          safe: SAFE_ACTIONS.has("batch_calls"),
        });
      }
    }
  }

  // (10) low_cache_hit_rate
  const searchCalls = log.byType("search");
  if (searchCalls.length >= config.minInefficiencyOccurrences * 3) {
    const uniqueHashes = new Set(searchCalls.map((r) => r.argsHash));
    const hitRate = uniqueHashes.size > 0 ? (searchCalls.length - uniqueHashes.size) / searchCalls.length : 0;
    if (hitRate < config.lowCacheHitRateThreshold) {
      findings.push({
        type: "low_cache_hit_rate",
        evidence: `search cache hit rate ${(hitRate * 100).toFixed(1)}% < ${(config.lowCacheHitRateThreshold * 100).toFixed(1)}%`,
        occurrences: searchCalls.length,
        suggestion: "add_cache",
        safe: SAFE_ACTIONS.has("add_cache"),
      });
    }
  }

  return findings;
}

/**
 * Convert an InefficiencyFinding into a persisted Improvement. Each
 * improvement has a unique id derived from (type, evidence hash) so the
 * same inefficiency in the same run dedups.
 */
export function findingToImprovement(
  finding: InefficiencyFinding,
  round: number,
  source: string,
): Improvement {
  const evidenceHash = canonicalHash({ type: finding.type, evidence: finding.evidence }).slice(0, 16);
  const id = `imp-${finding.type}-${evidenceHash}`;
  const spec = {
    id,
    type: finding.type,
    evidence: finding.evidence,
    suggestion: finding.suggestion,
    safe: finding.safe,
    admittedAt: round,
    source,
  };
  const result = IMPROVEMENT_SCHEMA.safeParse(spec);
  if (!result.success) {
    throw new InputError(`Internal: invalid improvement for ${finding.type}`);
  }
  return result.data;
}

/**
 * Apply safe improvements automatically. Returns the list of applied
 * improvements (those with safe=true). Unsafe improvements are returned
 * as recommendations for the user.
 */
export function applyImprovements(
  findings: readonly InefficiencyFinding[],
  round: number,
  source: string,
): { applied: Improvement[]; recommended: Improvement[] } {
  const applied: Improvement[] = [];
  const recommended: Improvement[] = [];
  for (const f of findings) {
    const imp = findingToImprovement(f, round, source);
    if (f.safe) applied.push(imp);
    else recommended.push(imp);
  }
  return { applied, recommended };
}
