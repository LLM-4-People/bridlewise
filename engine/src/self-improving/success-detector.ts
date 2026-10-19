/**
 * EXP424 — Success Detector: the mechanical layer that extracts
 * successful patterns from the command log.
 *
 * Symmetric to the mistake detector: where mistakes drive prevention
 * rules, successes drive best practices. The LLM does NOT self-assess
 * success — the harness verifies the result and extracts the pattern.
 *
 * Best-practice examples:
 * - "search_code with a 50-line viewport succeeds 90% of the time" →
 * best practice: use 50-line viewport for searches.
 * - "edits that pre-verify the preimage succeed 95% of the time" →
 * best practice: always verify preimage before edit.
 */

import { z } from "zod";

import {
  type CommandLog,
  type CommandRecord,
} from "./command-log.ts";
import {
  BEST_PRACTICE_SCHEMA,
  type BestPractice,
  type CommandType,
  type SelfImprovingConfig,
} from "./config.ts";
import { canonicalHash } from "../kernel/integrity.ts";
import { InputError } from "../kernel/errors.ts";

/** A successful pattern (extracted from the log). */
const SUCCESS_PATTERN_SCHEMA = z.object({
  type: z.enum([
    "search",
    "edit",
    "execute",
    "read_file",
    "write_file",
    "tool",
    "agent",
    "quality",
    "memory",
    "context",
    "other",
  ]),
  pattern: z.string().min(1),
  /** Number of successful commands matching this pattern. */
  successCount: z.number().int().nonnegative(),
  /** Total commands matching this pattern (used to compute confidence). */
  totalCount: z.number().int().nonnegative(),
  /** Confidence = successCount / totalCount. */
  confidence: z.number().min(0).max(1),
  /** The canonical best-practice recommendation (deterministic). */
  practice: z.string().min(1),
  /** Representative example (one successful command's signature). */
  example: z.string().min(1),
});
export type SuccessPattern = z.infer<typeof SUCCESS_PATTERN_SCHEMA>;

/**
 * Extract a pattern signature from a command. The signature is the
 * canonical (command, normalized-args) — args are normalized by sorting
 * keys + dropping values over 50 chars (to avoid pinning on specific
 * values).
 */
function commandSignature(record: CommandRecord): string {
  const normalizedArgs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record.args).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const sv = typeof v === "string" && v.length > 50 ? `${v.slice(0, 47)}...` : v;
    normalizedArgs[k] = sv;
  }
  return canonicalHash({ c: record.command, a: normalizedArgs });
}
void commandSignature;

/**
 * Extract a deterministic pattern from a successful command. Returns null
 * if no pattern can be extracted (e.g. one-off commands).
 */
function extractPattern(record: CommandRecord): { pattern: string; practice: string } | null {
  // Pattern 1: search with viewport=N → "use viewport N for search"
  const viewport = record.args.viewport;
  if (record.type === "search" && typeof viewport === "number") {
    return {
      pattern: `search_with_viewport_${viewport}`,
      practice: `Use viewport=${viewport} for search commands.`,
    };
  }
  // Pattern 2: edit with preimage verification → "verify preimage before edit"
  if (record.type === "edit" && record.args.verifyPreimage === true) {
    return {
      pattern: "edit_with_preimage_verification",
      practice: "Always verify preimage before applying edit.",
    };
  }
  // Pattern 3: search with language filter → "use language filter for multi-lang codebases"
  if (record.type === "search" && typeof record.args.language === "string") {
    return {
      pattern: `search_with_language_${record.args.language}`,
      practice: `Use language=${record.args.language} filter for searches.`,
    };
  }
  // Pattern 4: execute with timeout → "set timeout for execute commands"
  if (record.type === "execute" && typeof record.args.timeout === "number") {
    return {
      pattern: `execute_with_timeout_${record.args.timeout}`,
      practice: `Set timeout=${record.args.timeout} for execute commands.`,
    };
  }
  // Pattern 5: tool with retry=N → "set retry N for tool calls"
  if (record.type === "tool" && typeof record.args.retries === "number") {
    return {
      pattern: `tool_with_retry_${record.args.retries}`,
      practice: `Set retries=${record.args.retries} for tool calls.`,
    };
  }
  return null;
}

/**
 * Detect all successful patterns in a CommandLog. Returns one SuccessPattern
 * per unique (command-type, pattern) pair, with the count + confidence.
 */
export function detectSuccessPatterns(
  log: CommandLog,
  config: SelfImprovingConfig,
): SuccessPattern[] {
  const byPattern = new Map<string, {
    type: CommandType;
    pattern: string;
    practice: string;
    success: number;
    total: number;
    example: CommandRecord;
  }>();

  for (const record of log.all()) {
    const extracted = extractPattern(record);
    if (!extracted) continue;
    const key = `${record.type}:${extracted.pattern}`;
    const existing = byPattern.get(key);
    if (existing) {
      existing.total += 1;
      if (record.result.ok) existing.success += 1;
    } else {
      byPattern.set(key, {
        type: record.type,
        pattern: extracted.pattern,
        practice: extracted.practice,
        success: record.result.ok ? 1 : 0,
        total: 1,
        example: record,
      });
    }
  }

  const patterns: SuccessPattern[] = [];
  for (const p of byPattern.values()) {
    if (p.success < config.minSuccessCount) continue;
    const confidence = p.total > 0 ? p.success / p.total : 0;
    if (confidence < config.minPracticeConfidence) continue;
    const result = SUCCESS_PATTERN_SCHEMA.safeParse({
      type: p.type,
      pattern: p.pattern,
      successCount: p.success,
      totalCount: p.total,
      confidence,
      practice: p.practice,
      example: `${p.example.command} (turn=${p.example.turn})`,
    });
    if (result.success) patterns.push(result.data);
  }

  // Sort by success count descending, tie-broken by pattern alphabetically
  // (deterministic).
  patterns.sort((a, b) =>
    b.successCount - a.successCount ||
    (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0));
  return patterns;
}

/**
 * Convert a SuccessPattern into a persisted BestPractice (with provenance).
 */
export function patternToBestPractice(
  pattern: SuccessPattern,
  round: number,
  source: string,
): BestPractice {
  const id = `bp-${pattern.type}-${pattern.pattern}`;
  const spec = {
    id,
    type: pattern.type,
    pattern: pattern.pattern,
    practice: pattern.practice,
    successCount: pattern.successCount,
    confidence: pattern.confidence,
    admittedAt: round,
    source,
  };
  const provenanceHash = canonicalHash({ ...spec, round, source });
  const result = BEST_PRACTICE_SCHEMA.safeParse({
    ...spec,
    provenanceHash,
  });
  if (!result.success) {
    throw new InputError(`Internal: invalid best practice for ${pattern.pattern}`);
  }
  return result.data;
}
