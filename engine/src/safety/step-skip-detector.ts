import { type BandaidConfig, type BandaidSeverity } from "./bandaid-config.ts";

/**
 * Step-skip detector — the LLM skips a necessary step.
 *
 * Two detection modes:
 *
 * 1. **Edit-before-read**: an edit is recorded for a file and no read of
 * the same file preceded it within `stepSkipEditBeforeReadWindow` turns.
 * The LLM is editing code it has not looked at.
 *
 * 2. **Expected-step-missing**: the task has a known `taskType` (e.g.
 * "rename", "fix-bug") with expected steps in
 * `stepSkipExpectations`. When the task completes (a `completeTask`
 * event is recorded), the detector checks every expected step was
 * recorded (as a `StepEvent` with `step` matching). A missing step is
 * flagged. e.g. "rename" expects ["read","find-call-sites","edit"]; if
 * the LLM edits without "find-call-sites", the rename may have missed
 * call sites.
 *
 * THIS HALF IS DELIBERATELY DORMANT BY DEFAULT: the shipped expectations
 * map is empty (a configurable nobody has an opinion about yet), and a
 * caller with no task-type taxonomy passes an empty `taskType` — both
 * resolve to "no expectations exist", never to a fabricated expectation
 * from a guessed task type. Wiring a real task taxonomy (a classified
 * `taskType` plus configured expectations) wakes the half without any
 * detector change.
 *
 * Every threshold + the expected-steps map comes from `BandaidConfig`.
 *
 * Integration: `recordRead` wraps every file read; `recordEdit` is shared
 * with the bandaid detector; `recordStep` wraps the harness's step tracker;
 * `completeTask` is called when the task finishes.
 */
export type ReadEvent = Readonly<{
  turn: number;
  filePath: string;
}>;

export type StepEditEvent = Readonly<{
  turn: number;
  filePath: string;
}>;

export type StepEvent = Readonly<{
  turn: number;
  /** The step name (e.g. "read", "find-call-sites", "edit", "check-issues"). */
  step: string;
}>;

export type TaskCompleteEvent = Readonly<{
  turn: number;
  /** The task type (key into `stepSkipExpectations`). */
  taskType: string;
}>;

export type StepSkipFinding = Readonly<{
  family: "stepSkip";
  turn: number;
  severity: BandaidSeverity;
  /** "edit-before-read" or "expected-step-missing". */
  kind: "edit-before-read" | "expected-step-missing";
  filePath: string;
  /** Missing step name (expected-step-missing only; empty for edit-before-read). */
  missingStep: string;
  evidence: string;
  recommendation: string;
}>;

export type StepSkipDetectionReport = Readonly<{
  findings: readonly StepSkipFinding[];
  detectedCount: number;
}>;

export type StepSkipDetector = Readonly<{
  recordRead(event: ReadEvent): void;
  recordEdit(event: StepEditEvent): void;
  recordStep(event: StepEvent): void;
  completeTask(event: TaskCompleteEvent): void;
  detect(): StepSkipDetectionReport;
  snapshot(): Readonly<{
    reads: readonly ReadEvent[];
    edits: readonly StepEditEvent[];
    steps: readonly StepEvent[];
    completions: readonly TaskCompleteEvent[];
  }>;
}>;

export type StepSkipDetectorOptions = Readonly<{ config: BandaidConfig }>;

export function createStepSkipDetector(options: StepSkipDetectorOptions): StepSkipDetector {
  const cfg = options.config;
  const reads: ReadEvent[] = [];
  const edits: StepEditEvent[] = [];
  const steps: StepEvent[] = [];
  const completions: TaskCompleteEvent[] = [];

  function recordRead(event: ReadEvent): void { reads.push(event); }
  function recordEdit(event: StepEditEvent): void { edits.push(event); }
  function recordStep(event: StepEvent): void { steps.push(event); }
  function completeTask(event: TaskCompleteEvent): void { completions.push(event); }

  function detect(): StepSkipDetectionReport {
    const family = cfg.families.stepSkip;
    if (!family.enabled) return { findings: [], detectedCount: 0 };
    const totalEvents = reads.length + edits.length + steps.length + completions.length;
    if (totalEvents < family.minEvents) return { findings: [], detectedCount: 0 };

    const findings: StepSkipFinding[] = [];

    // 1. Edit-before-read.
    for (const edit of edits) {
      const windowStart = edit.turn - cfg.stepSkipEditBeforeReadWindow;
      let read = false;
      for (const r of reads) {
        if (r.filePath === edit.filePath && r.turn <= edit.turn && r.turn >= windowStart) {
          read = true;
          break;
        }
      }
      if (!read) {
        findings.push({
          family: "stepSkip",
          turn: edit.turn,
          severity: "medium",
          kind: "edit-before-read",
          filePath: edit.filePath,
          missingStep: "read",
          evidence: `Edit to ${edit.filePath} at turn ${edit.turn} with no preceding read within ${cfg.stepSkipEditBeforeReadWindow} turns.`,
          recommendation: `Read ${edit.filePath} before editing it. The LLM is editing code it has not inspected.`,
        });
      }
    }

    // 2. Expected-step-missing.
    for (const completion of completions) {
      const expected = cfg.stepSkipExpectations[completion.taskType];
      if (!expected || expected.length === 0) continue;
      const recordedSteps = new Set(steps.map((s) => s.step));
      for (const expectedStep of expected) {
        if (!recordedSteps.has(expectedStep)) {
          findings.push({
            family: "stepSkip",
            turn: completion.turn,
            severity: "high",
            kind: "expected-step-missing",
            filePath: "",
            missingStep: expectedStep,
            evidence: `Task of type "${completion.taskType}" completed at turn ${completion.turn} without the expected step "${expectedStep}".`,
            recommendation: `Perform the missing step "${expectedStep}" before completing a "${completion.taskType}" task. Skipping it risks incomplete/incorrect work.`,
          });
        }
      }
    }

    return { findings, detectedCount: findings.length };
  }

  function snapshot(): Readonly<{
    reads: readonly ReadEvent[];
    edits: readonly StepEditEvent[];
    steps: readonly StepEvent[];
    completions: readonly TaskCompleteEvent[];
  }> {
    return { reads, edits, steps, completions };
  }

  return { recordRead, recordEdit, recordStep, completeTask, detect, snapshot };
}
