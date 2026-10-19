/**
 * THE LAST RUN — the cache a promotion run leaves for the people and agents
 * watching it (merge-door-final §8, `promotion-last-run/v1`): one record per
 * profile, `<registry>/promotion/<profile>/last-run.json` (private, written
 * atomically at every phase and at the end). It feeds `status`, the exposure
 * signals and the trigger's one-line notice, and nothing else: every decision
 * a run takes is derived from the refs and the trailers (§7.1 I-6), so a lost
 * or torn record loses no safety — it reads as absent.
 *
 * {@link lastRunRecorder} is the one writer: a run states each phase it
 * enters (the record says `running` with the phase while its process lives)
 * and its end (the answer's code, class, message and remedy; the facts the
 * signals show: the commit, whether it was pushed, the target checkout's
 * state, the advisories). {@link promotionState} reads a record as the
 * `promotion.state` signal's word.
 *
 * THE LOG OF AN UNATTENDED RUN ({@link openUnattendedLog}): a background run
 * has no terminal, so its log lines (the central logger's console sink writes
 * them on stderr) land in a file of its own, `unattended-<ms>-<pid>.log` in
 * the profile's area — never truncating another run's (a coalesced launch
 * while a run writes, or the launch right after a failure the notice points
 * at). The run that records names its log in the record (`log`, from
 * `ROOT_POLICY.workflow.promotion.logEnvironmentVariable`), and a log lives
 * as long as the record that may point at it: each launch removes the logs
 * older than the record's start, except the record's own. (The durable,
 * rotated sink of the central logger itself is RC-06's, decision Q3.)
 */
import { existsSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { deepFreeze } from "../../kernel/integrity.ts";
import { ROOT_POLICY } from "../../kernel/root-policy.ts";
import { schemaId } from "../../kernel/product-identity.ts";
import { atomicWriteFile } from "../../filesystem/atomic-write.ts";
import { ensurePrivateStateDirectory, PRIVATE_STATE_FILE_MODE } from "../../filesystem/private-state.ts";
import { isProcessAlive } from "../../process/process-facts.ts";
import type { PromotionAnswer, PromotionClass, PromotionCode } from "./codes.ts";

const PROMOTION_LAST_RUN_SCHEMA = schemaId("promotion-last-run", 1);

/** What the run knows of the checkout holding the target: where it is, the paths that parked a landing, and the setup commands its new tree needs re-run there (never run by the promoter: it may be serving). */
export type TargetCheckoutState = Readonly<{ path: string | null; overlap: readonly string[]; depsStale: readonly string[] }>;

/** One run's record (see the header). */
export type LastRun = Readonly<{
  schema: string;
  runId: string;
  /** The process that ran it (a record whose process is gone and that never ended was interrupted). */
  pid: number;
  profile: string;
  verb: string;
  startedAt: string;
  endedAt: string | null;
  /** The phase entered last. */
  phase: string;
  /** Milliseconds per phase, in the order entered. */
  durations: Readonly<Record<string, number>>;
  source: string | null;
  target: string | null;
  commit: string | null;
  pushed: boolean;
  result: Readonly<{ code: PromotionCode; class: PromotionClass; message: string; remedy: string; at: string }> | null;
  advisories: readonly Readonly<{ kind: string; path: string; detail: string }>[];
  /** The target edits the run's plan found (accepted or refused). */
  targetEdits: readonly string[];
  targetCheckout: TargetCheckoutState | null;
  /** The log file of the run (an unattended run's; `null`: it logged to a terminal). */
  log: string | null;
}>;

/** The record's path in the profile's private area. */
function lastRunPath(workDirectory: string): string {
  return join(workDirectory, "last-run.json");
}

const UNATTENDED_LOG = /^unattended-(\d+)-\d+\.log$/u;

/**
 * Opens a NEW log for the profile's next unattended run (see the header),
 * after removing the logs no record can point at any more. Answers its
 * descriptor (the caller closes it once the child holds it) and its path.
 */
export function openUnattendedLog(workDirectory: string, now: number = Date.now()): Readonly<{ fd: number; path: string }> {
  ensurePrivateStateDirectory(workDirectory);
  const record = readLastRun(workDirectory);
  if (record !== null) {
    const since = Date.parse(record.startedAt);
    for (const name of readdirSync(workDirectory)) {
      const stamp = UNATTENDED_LOG.exec(name)?.[1];
      const path = join(workDirectory, name);
      if (stamp !== undefined && Number(stamp) < since && path !== record.log) rmSync(path, { force: true });
    }
  }
  const path = join(workDirectory, `unattended-${String(now)}-${String(process.pid)}.log`);
  return deepFreeze({ fd: openSync(path, "a", PRIVATE_STATE_FILE_MODE), path });
}

/** The profile's last record, or `null`: none, torn, or of another schema (see the header: it is a cache). */
export function readLastRun(workDirectory: string): LastRun | null {
  const path = lastRunPath(workDirectory);
  if (!existsSync(path)) return null;
  let record: Partial<LastRun>;
  try {
    record = JSON.parse(readFileSync(path, "utf8")) as Partial<LastRun>;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  return record.schema === PROMOTION_LAST_RUN_SCHEMA ? deepFreeze(record as LastRun) : null;
}

function writeLastRun(workDirectory: string, record: LastRun): void {
  ensurePrivateStateDirectory(workDirectory);
  const written = atomicWriteFile(lastRunPath(workDirectory), `${JSON.stringify(record, null, 2)}\n`, { requiredMode: PRIVATE_STATE_FILE_MODE });
  if (!written.success) throw written.error;
}

/** The facts a run states when it ends (each optional: what it learned). */
export type LastRunFacts = Partial<Pick<LastRun, "source" | "target" | "commit" | "pushed" | "advisories" | "targetEdits" | "targetCheckout">>;

export type LastRunRecorder = Readonly<{
  /** Enters `phase` (its predecessor's duration is recorded). */
  phase: (phase: string) => void;
  /** States what the run learned so far (merged into the record). */
  learn: (facts: LastRunFacts) => void;
  /** Ends the run with its answer. */
  end: (answer: PromotionAnswer) => void;
}>;

/** The one writer of a profile's record (see the header), for one run of `verb`. */
export function lastRunRecorder(workDirectory: string, profile: string, verb: string, now: () => Date = () => new Date()): LastRunRecorder {
  const started = now();
  const durations: Record<string, number> = {};
  let phaseStarted = started.getTime();
  let record: LastRun = {
    schema: PROMOTION_LAST_RUN_SCHEMA,
    runId: `${started.toISOString()}-${String(process.pid)}`,
    pid: process.pid,
    profile,
    verb,
    startedAt: started.toISOString(),
    endedAt: null,
    phase: "start",
    durations,
    source: null,
    target: null,
    commit: null,
    pushed: false,
    result: null,
    advisories: [],
    targetEdits: [],
    targetCheckout: null,
    log: process.env[ROOT_POLICY.workflow.promotion.logEnvironmentVariable] || null,
  };
  const close = (): void => {
    const at = now().getTime();
    durations[record.phase] = (durations[record.phase] ?? 0) + (at - phaseStarted);
    phaseStarted = at;
  };
  writeLastRun(workDirectory, record);
  return deepFreeze({
    phase: (phase: string) => {
      close();
      record = { ...record, phase, durations: { ...durations } };
      writeLastRun(workDirectory, record);
    },
    learn: (facts: LastRunFacts) => {
      record = { ...record, ...facts };
    },
    end: (answer: PromotionAnswer) => {
      close();
      const at = now().toISOString();
      record = { ...record, endedAt: at, durations: { ...durations }, result: { code: answer.code, class: answer.class, message: answer.message, remedy: answer.remedy, at } };
      writeLastRun(workDirectory, record);
    },
  });
}

/**
 * The `promotion.state` word of a record: `idle` (none yet, or the last run
 * ended ok), `running:<phase>` (its process lives), `interrupted:<phase>`
 * (it never ended and its process is gone), `held`, `parked`, `blocked` (a
 * refusal to fix on the source or by a flag), `errored` (the machine's),
 * `failed` (a defect, or a state that must not happen).
 */
export function promotionState(record: LastRun | null, alive: (pid: number) => boolean = isProcessAlive): string {
  if (record === null) return "idle";
  if (record.result === null) return `${alive(record.pid) ? "running" : "interrupted"}:${record.phase}`;
  if (record.result.code === "promotion_held") return "held";
  switch (record.result.class) {
    case "ok": return "idle";
    case "parked": return "parked";
    case "input":
    case "precondition": return "blocked";
    case "errored": return "errored";
    case "failed":
    case "integrity": return "failed";
  }
}
