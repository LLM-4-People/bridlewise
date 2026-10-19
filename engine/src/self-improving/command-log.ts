/**
 * EXP424 — Command Log: the canonical append-only log of every command
 * the harness runs on behalf of the LLM.
 *
 * The LLM does NOT see this log directly — the harness uses it to:
 * - detect mistakes (failed commands, wrong results, redundancies),
 * - detect successful patterns (best practices),
 * - identify workflow inefficiencies (duplicate calls, missing caches),
 * - measure the LLM/harness boundary (what the LLM does vs what the harness does).
 *
 * The log is the single owner of the command record. No other module may
 * define its own command-record shape.
 */

import { z } from "zod";

import { HarnessError, InputError } from "../kernel/errors.ts";
import { canonicalHash, deepFreeze, generateId } from "../kernel/integrity.ts";
import {
  COMMAND_TYPES,
  type CommandType,
  MISTAKE_TYPES,
  type MistakeType,
} from "./config.ts";

/** The result of a single command (success or failure + output). */
const COMMAND_RESULT_SCHEMA = z.object({
  ok: z.boolean(),
  /** The actual output (truncated + redacted by the harness, never raw PII). */
  output: z.string(),
  /** Tokens consumed by the LLM for this command, if applicable. */
  tokens: z.number().int().nonnegative().optional(),
  /** Wall-clock duration, in milliseconds. */
  durationMs: z.number().int().nonnegative(),
});
export type CommandResult = z.infer<typeof COMMAND_RESULT_SCHEMA>;

/** A single command record (what was called, with what, and what came back). */
const COMMAND_RECORD_SCHEMA = z.object({
  id: z.string().min(1),
  /** The harness run this command belongs to (correlation id). */
  runId: z.string().min(1),
  /** The turn within the run (1-indexed). */
  turn: z.number().int().positive(),
  /** The task within the turn (multiple tools per turn). */
  taskIndex: z.number().int().nonnegative(),
  /** What tool/command was invoked. */
  command: z.string().min(1),
  /** The canonical command-type category. */
  type: z.enum(COMMAND_TYPES),
  /** Arguments (deterministic JSON — redacted by the harness). */
  args: z.record(z.string(), z.unknown()),
  /** The result (ok + output + tokens + durationMs). */
  result: COMMAND_RESULT_SCHEMA,
  /** The task label the LLM was working on (e.g. "refactor babel-traverse"). */
  task: z.string().min(1),
  /** ISO timestamp when the command was issued. */
  issuedAt: z.string().min(1),
  /** Whether this command was a retry of a previous failed one. */
  isRetry: z.boolean(),
  /** Whether this command was a fallback (retry budget exhausted). */
  isFallback: z.boolean(),
  /** Content hash of the (command, args) — for redundancy detection. */
  argsHash: z.string().length(64),
});
export type CommandRecord = z.infer<typeof COMMAND_RECORD_SCHEMA>;

/** A mistake record (detected by the mistake detector). */
export const MISTAKE_RECORD_SCHEMA = z.object({
  id: z.string().min(1),
  commandId: z.string().min(1),
  runId: z.string().min(1),
  turn: z.number().int().positive(),
  type: z.enum(MISTAKE_TYPES),
  /** The specific cause (one of FIXABLE_CAUSES or UNFIXABLE_CAUSES keys). */
  cause: z.string().min(1),
  /** The evidence (what the detector saw). */
  evidence: z.string().min(1),
  /** ISO timestamp when the mistake was detected. */
  detectedAt: z.string().min(1),
  /** Whether a learned rule now covers this mistake (after learning). */
  coveredAfterLearning: z.boolean(),
});
export type MistakeRecord = z.infer<typeof MISTAKE_RECORD_SCHEMA>;

/**
 * The canonical append-only command log. Records are validated, deduped by
 * id, frozen. The log is the single source of truth for "what the harness
 * did" — used by the mistake detector, success detector, workflow
 * improver, and the LLM-boundary audit.
 */
export class CommandLog {
  private readonly records: CommandRecord[] = [];
  private readonly byId = new Map<string, CommandRecord>();
  private readonly byRun = new Map<string, CommandRecord[]>();
  private readonly argsHashIndex = new Map<string, CommandRecord[]>();

  /** Append a command record. Validates + dedupes + freezes. */
  record(input: Omit<CommandRecord, "id" | "argsHash"> & { id?: string }): CommandRecord {
    const id = input.id ?? generateId("cmd");
    if (this.byId.has(id)) {
      throw new HarnessError(
        "Command already recorded",
        "command_log_duplicate_id",
        false,
        { id },
      );
    }
    const argsHash = canonicalHash({ c: input.command, a: input.args });
    const record: CommandRecord = {
      ...input,
      id,
      argsHash,
    } as CommandRecord;
    const result = COMMAND_RECORD_SCHEMA.safeParse(record);
    if (!result.success) {
      throw new InputError(
        `Invalid command record: ${result.error.message}`,
        "command_record_invalid",
      );
    }
    const frozen = deepFreeze(result.data);
    this.records.push(frozen);
    this.byId.set(frozen.id, frozen);
    const byRun = this.byRun.get(frozen.runId) ?? [];
    byRun.push(frozen);
    this.byRun.set(frozen.runId, byRun);
    const byArgsHash = this.argsHashIndex.get(frozen.argsHash) ?? [];
    byArgsHash.push(frozen);
    this.argsHashIndex.set(frozen.argsHash, byArgsHash);
    return frozen;
  }

  size(): number {
    return this.records.length;
  }

  all(): readonly CommandRecord[] {
    return [...this.records];
  }

  byRunId(runId: string): readonly CommandRecord[] {
    return [...(this.byRun.get(runId) ?? [])];
  }

  byType(type: CommandType): readonly CommandRecord[] {
    return this.records.filter((r) => r.type === type);
  }

  byArgsHash(argsHash: string): readonly CommandRecord[] {
    return [...(this.argsHashIndex.get(argsHash) ?? [])];
  }

  /** All records that have the exact same (command, args) — redundancy check. */
  duplicates(): readonly CommandRecord[][] {
    return [...this.argsHashIndex.values()].filter((group) => group.length > 1);
  }

  /** Compute the argsHash for an external (command, args) pair. */
  hashArgs(command: string, args: Readonly<Record<string, unknown>>): string {
    return canonicalHash({ c: command, a: args });
  }
}

/**
 * Convenience helper: build a CommandRecord from a minimal spec. Used by
 * tests + the simulation engine. The harness's real callers pass their
 * own redacted/validated args. Accepts an optional `id` so tests can use
 * predictable IDs that match expected/verification maps.
 */
export function buildCommandRecord(spec: {
  id?: string;
  runId: string;
  turn: number;
  taskIndex: number;
  command: string;
  type: CommandType;
  args: Readonly<Record<string, unknown>>;
  result: CommandResult;
  task: string;
  isRetry?: boolean;
  isFallback?: boolean;
  issuedAt?: string;
}): CommandRecord {
  return deepFreeze({
    id: spec.id ?? generateId("cmd"),
    runId: spec.runId,
    turn: spec.turn,
    taskIndex: spec.taskIndex,
    command: spec.command,
    type: spec.type,
    args: spec.args,
    result: spec.result,
    task: spec.task,
    issuedAt: spec.issuedAt ?? new Date().toISOString(),
    isRetry: spec.isRetry ?? false,
    isFallback: spec.isFallback ?? false,
    argsHash: canonicalHash({ c: spec.command, a: spec.args }),
  } as CommandRecord);
}

export type { MistakeType };
