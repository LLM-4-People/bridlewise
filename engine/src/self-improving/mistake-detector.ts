/**
 * EXP424 — Mistake Detector: the mechanical layer that inspects every
 * command the harness runs and classifies it as a mistake (or not).
 *
 * 10 mistake types, all detected deterministically:
 * 1. command_failed — result.ok === false
 * 2. wrong_result — result.ok === true but output doesn't match expected
 * 3. redundant_call — same (command, args) called before in the same run
 * 4. deviation — task diverged from the declared task label
 * 5. bandaid — output contains bandaid markers (was EXP408's job)
 * 6. workaround — output contains workaround markers
 * 7. hallucination — output cites nonexistent files/symbols
 * 8. false_positive — verification rejects a "successful" result
 * 9. context_overflow — tokens exceed budget
 * 10. tool_misuse — wrong tool/args for the task (mechanical check)
 *
 * NO LLM. The detector is fully deterministic. The mistake learner (below)
 * turns detections into rules; the workflow improver turns detections into
 * inefficiency reports.
 */

import {
  type CommandLog,
  type CommandRecord,
  MISTAKE_RECORD_SCHEMA,
  type MistakeRecord,
} from "./command-log.ts";
import {
  FIXABLE_CAUSES,
  type MistakeType,
  UNFIXABLE_CAUSES,
} from "./config.ts";
import { InputError } from "../kernel/errors.ts";
import { generateId } from "../kernel/integrity.ts";

/** A required-verification outcome (used by false_positive detection). */
export interface VerificationOutcome {
  commandId: string;
  passed: boolean;
  reason?: string;
}

/** Bandaid/workaround marker set (mechanical, deterministic). */
const BANDAID_MARKERS = [
  "TODO",
  "FIXME",
  "HACK",
  "WORKAROUND",
  "bandaid",
  "band-aid",
  "band-aid",
  "temporary",
  "for now",
  "quick fix",
  "stopgap",
  "won't work",
  "this fails",
  "skip this",
  "ignored for",
] as const;

const WORKAROUND_MARKERS = [
  "workaround",
  "skip",
  "instead of",
  "rather than",
  "gave up",
  "fall back",
  "fallback to",
  "falling back",
  "couldn't",
  "could not",
  "unable to",
] as const;

const DEVIATION_MARKERS = [
  "actually,",
  "instead of",
  "let's try",
  "different approach",
  "different tactic",
  "going to do",
  "switching to",
] as const;

/**
 * Detect a single mistake from a command record. Returns null if the
 * command is not a mistake.
 *
 * `verifications` (optional) is a map of commandId → verification outcome
 * (used to detect false positives: the LLM said success but the verifier
 * rejected it).
 * `expectedResults` (optional) is a map of commandId → expected output
 * (used to detect wrong_result: the LLM said success but the output is wrong).
 */
export function detectMistake(
  record: CommandRecord,
  options?: {
    verifications?: ReadonlyMap<string, VerificationOutcome>;
    expectedResults?: ReadonlyMap<string, string>;
    contextBudget?: number;
    declaredTask?: string;
  },
): MistakeRecord | null {
  // (1) command_failed
  if (!record.result.ok) {
    return makeMistake(record, "command_failed", classifyFailureCause(record));
  }

  // (2) wrong_result (LLM said ok but output doesn't match expected)
  if (options?.expectedResults) {
    const expected = options.expectedResults.get(record.id);
    if (expected !== undefined && expected !== record.result.output) {
      return makeMistake(record, "wrong_result", "output_mismatch");
    }
  }

  // (3) redundant_call (already recorded with same args in the same run)
  // — handled at the log level (see detectAllMistakes below).

  // (4) deviation (output mentions deviation markers)
  const lower = record.result.output.toLowerCase();
  if (DEVIATION_MARKERS.some((m) => lower.includes(m))) {
    return makeMistake(record, "deviation", "deviation_marker");
  }

  // (5) bandaid (output contains bandaid markers)
  if (BANDAID_MARKERS.some((m) => lower.includes(m.toLowerCase()))) {
    return makeMistake(record, "bandaid", "bandaid_marker");
  }

  // (6) workaround
  if (WORKAROUND_MARKERS.some((m) => lower.includes(m))) {
    return makeMistake(record, "workaround", "workaround_marker");
  }

  // (7) hallucination — output mentions a file that doesn't exist (if
  // explicitly listed via `knownFiles`). We don't have a global file table
  // here, so the caller is expected to inject a hallucinationEvidence
  // outcome via the verifications map.
  if (options?.verifications) {
    const v = options.verifications.get(record.id);
    if (v && !v.passed && v.reason === "hallucination") {
      return makeMistake(record, "hallucination", "model_limitation");
    }
  }

  // (8) false_positive (verifier rejected a "successful" command)
  if (options?.verifications) {
    const v = options.verifications.get(record.id);
    if (v && !v.passed && v.reason !== "hallucination") {
      return makeMistake(record, "false_positive", v.reason ?? "verification_failed");
    }
  }

  // (9) context_overflow (tokens exceed the budget)
  if (options?.contextBudget !== undefined && record.result.tokens !== undefined) {
    if (record.result.tokens > options.contextBudget) {
      return makeMistake(record, "context_overflow", "oversized_payload");
    }
  }

  // (10) tool_misuse — wrong tool for the task (mechanical: declaredTask
  // is given AND the tool name doesn't contain expected keywords).
  if (options?.declaredTask) {
    const misuse = checkToolMisuse(record, options.declaredTask);
    if (misuse) {
      return makeMistake(record, "tool_misuse", misuse);
    }
  }

  return null;
}

/** Build a typed MistakeRecord with provenance. */
function makeMistake(
  record: CommandRecord,
  type: MistakeType,
  cause: string,
): MistakeRecord {
  const result = MISTAKE_RECORD_SCHEMA.safeParse({
    id: generateId("mistake"),
    commandId: record.id,
    runId: record.runId,
    turn: record.turn,
    type,
    cause,
    evidence: `${type} from ${record.command} (cause=${cause})`,
    detectedAt: new Date().toISOString(),
    coveredAfterLearning: false,
  });
  if (!result.success) {
    // Should never happen; throw a typed error to surface the bug.
    throw new InputError(`Internal: invalid mistake record for ${record.id}`);
  }
  return result.data;
}

/**
 * Classify a failed command's cause (used by command_failed mistakes). The
 * cause drives which deterministic rule will prevent the next occurrence.
 */
function classifyFailureCause(record: CommandRecord): string {
  const err = record.result.output.toLowerCase();
  if (err.includes("regex") || err.includes("pattern")) return "invalid_regex";
  if (err.includes("preimage") || err.includes("does not match")) return "missing_preimage";
  if (err.includes("syntax") || err.includes("parse error")) return "syntax_error";
  if (err.includes("context") || err.includes("too long")) return "stale_context";
  if (err.includes("payload") || err.includes("size")) return "oversized_payload";
  if (err.includes("no such file") || err.includes("not found")) return "missing_file";
  if (err.includes("directory") || err.includes("cwd")) return "wrong_directory";
  if (err.includes("argument") || err.includes("args")) return "tool_misuse_args";
  if (err.includes("throw") || err.includes("exception")) return "uncaught_throw";
  if (err.includes("catch") || err.includes("swallow")) return "swallowed_catch";
  if (err.includes("matches: true") || err.includes("hardcoded")) return "matches_true";
  if (err.includes("retry") || err.includes("exhausted")) return "retry_exhausted";
  if (err.includes("duplicate") || err.includes("already")) return "duplicate_query";
  if (err.includes("unbounded") || err.includes("too many")) return "unbounded_search";
  // Cause is unknown (unfixable). The learner will log it as `unknownUnknown`.
  return "unknown_unknown";
}

/**
 * Mechanically check tool misuse (declaredTask vs command). Returns the
 * cause string if the tool is wrong for the task, otherwise null.
 */
function checkToolMisuse(record: CommandRecord, declaredTask: string): string | null {
  const task = declaredTask.toLowerCase();
  const cmd = record.command.toLowerCase();
  // Read tasks should NOT use edit/write tools.
  if ((task.includes("read") || task.includes("inspect") || task.includes("view")) &&
      (cmd.includes("edit") || cmd.includes("write") || cmd.includes("delete"))) {
    return "wrong_tool";
  }
  // Search tasks should NOT use edit tools.
  if ((task.includes("search") || task.includes("find")) &&
      (cmd.includes("edit") || cmd.includes("write"))) {
    return "wrong_tool";
  }
  return null;
}

/**
 * Detect ALL mistakes in a CommandLog. This is the canonical entry point
 * for the mistake detector — it scans every command, dedups redundancy,
 * and returns a complete MistakeRecord list.
 *
 * `duplicates` (from log.duplicates) are turned into redundant_call
 * mistakes — the FIRST occurrence is not a mistake; subsequent ones are.
 */
export function detectAllMistakes(
  log: CommandLog,
  options?: {
    verifications?: ReadonlyMap<string, VerificationOutcome>;
    expectedResults?: ReadonlyMap<string, string>;
    contextBudget?: number;
    declaredTasks?: ReadonlyMap<string, string>;
    knownFiles?: ReadonlySet<string>;
  },
): MistakeRecord[] {
  const mistakes: MistakeRecord[] = [];
  const seenArgsHash = new Set<string>();

  // First, detect duplicates (redundant_call) — we need to know which
  // (command, args) are repeated within a run.
  const duplicatesByHash = new Map<string, CommandRecord[]>();
  for (const r of log.all()) {
    const group = duplicatesByHash.get(r.argsHash) ?? [];
    group.push(r);
    duplicatesByHash.set(r.argsHash, group);
  }

  for (const record of log.all()) {
    // (3) redundant_call — same (command, args) within the same run, NOT
    // the first occurrence. We don't count cross-run duplicates as
    // mistakes (caching handles that as an inefficiency).
    const group = duplicatesByHash.get(record.argsHash) ?? [];
    const sameRun = group.filter((r) => r.runId === record.runId);
    if (sameRun.length > 1 && sameRun[0] !== record) {
      mistakes.push(makeMistake(record, "redundant_call", "duplicate_query"));
      continue;
    }

    // Hallucination check via knownFiles (if provided).
    let hallucinationRecord: MistakeRecord | null = null;
    if (options?.knownFiles) {
      hallucinationRecord = detectHallucination(record, options.knownFiles);
      if (hallucinationRecord) {
        mistakes.push(hallucinationRecord);
        continue;
      }
    }

    const declaredTask = options?.declaredTasks?.get(record.id);
    const detectOpts: {
      verifications?: ReadonlyMap<string, VerificationOutcome>;
      expectedResults?: ReadonlyMap<string, string>;
      contextBudget?: number;
      declaredTask?: string;
    } = {};
    if (options?.verifications) detectOpts.verifications = options.verifications;
    if (options?.expectedResults) detectOpts.expectedResults = options.expectedResults;
    if (options?.contextBudget !== undefined) detectOpts.contextBudget = options.contextBudget;
    if (declaredTask !== undefined) detectOpts.declaredTask = declaredTask;
    const m = detectMistake(record, detectOpts);
    if (m) mistakes.push(m);

    seenArgsHash.add(record.argsHash);
  }

  return mistakes;
}

/**
 * Detect hallucinations: scan the output for file paths that don't exist
 * in the knownFiles set. A hallucination is a citation of a nonexistent
 * file path (the LLM "imagined" a file).
 */
function detectHallucination(
  record: CommandRecord,
  knownFiles: ReadonlySet<string>,
): MistakeRecord | null {
  const filePathPattern = /(?:^|[\s(])([a-zA-Z0-9._/-]+\/[a-zA-Z0-9._/-]+\.(?:ts|js|mjs|json|md|py|rs|go|c|cpp|h|hcpp|txt))/gu;
  const matches = record.result.output.matchAll(filePathPattern);
  for (const m of matches) {
    const filePath = m[1];
    if (filePath === undefined) continue;
    if (!knownFiles.has(filePath) && !knownFiles.has(`./${filePath}`)) {
      return makeMistake(record, "hallucination", "model_limitation");
    }
  }
  return null;
}

/**
 * Is the cause fixable? Returns true if a deterministic rule can prevent it.
 */
export function isFixableCause(cause: string): boolean {
  return Object.prototype.hasOwnProperty.call(FIXABLE_CAUSES, cause) &&
    !Object.prototype.hasOwnProperty.call(UNFIXABLE_CAUSES, cause);
}

/**
 * Is the cause unfixable (structural — needs future research)?
 */
export function isUnfixableCause(cause: string): boolean {
  return Object.prototype.hasOwnProperty.call(UNFIXABLE_CAUSES, cause);
}
