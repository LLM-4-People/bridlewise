/**
 * THE SAFETY-RUNTIME BRIDGE — the SINGLE web-UI owner of the engine's
 * event-feed safety detectors (workaround, bandaid, step-skip, goal-deviation).
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * The engine ships four fully-built, fully-tested deterministic event-stream
 * detectors under `engine/src/safety/` (workaround, bandaid, step-skip,
 * deviation). Only the structural pre-dispatch tool-call gate ran on the web
 * run path; the four event-feed detectors had zero callers outside the
 * engine's own tests. They are pure state machines: record events, then
 * `detect()` — and the web run loop was already the natural producer of every
 * event they consume (tool completions, edits, reads, assistant text, task
 * end). This bridge is the composition owner that:
 *
 *   1. constructs the four detectors per RUN (per-run isolation — state never
 *      leaks between runs; `dispose()` at run end) with one engine-validated
 *      `BandaidConfig` resolved through the config owner
 *      (`getEventFeedSafetyConfig`);
 *   2. routes the run loop's raw facts into the right detectors — the run
 *      loop reports WHAT happened (tool name, args, success/error, the
 *      manifest entry's declared capabilities); THIS owner decides which
 *      detector consumes it. Capability classification is derived from the
 *      live manifest (read/write), never a hardcoded tool-name list;
 *   3. aggregates `detect()` results into one report + pre-formatted chat
 *      messages (the single owner of the finding message format);
 *   4. feeds the exposure signals (`safety.workaroundFindings`, …) with REAL
 *      verdicts through the engine registration's installable state source —
 *      installed once at server boot by
 *      `installRunSafetyRuntimeExposureSource()`.
 *
 * ── HONESTY ────────────────────────────────────────────────────────────────
 *
 * A detector that is not armed reports honestly absent. Three disarmed shapes
 * exist and each is reported as such, never as a fabricated verdict:
 *   - the config section is malformed → the whole runtime is DISARMED and the
 *     reason is published on the run's findings frame;
 *   - a family is disabled in config (`families.X.enabled: false`) → that
 *     family reports `armed: false` with zero findings;
 *   - no events were recorded → the detectors report zero findings (the real
 *     answer for nothing observed).
 *
 * ── THE FACADE SHAPE (what slots in later) ─────────────────────────────────
 *
 * The runtime surface is event-shaped, not detector-shaped:
 * `recordToolCall` / `recordWork` / `completeTask` / `setOriginalTask` /
 * `detect` / `takePendingIntervention`. The investigator and pause-ask
 * stages consume `detect()` and surface a pause the run loop waits on
 * (the existing steer route is the answer channel). The text-grounding
 * hallucination detector and the bias detector still slot onto
 * `recordWork` without the run loop changing.
 */

import {
  createWorkaroundDetector,
  createBandaidDetector,
  createStepSkipDetector,
  createDeviationDetector,
  createInvestigator,
  createPauseAskBuilder,
  installSafetyEventFeedStateSource,
  type AnyFinding,
  type BandaidConfig,
  type BandaidFinding,
  type DeviationFinding,
  type InvestigationResult,
  type McpUnavailabilityKey,
  type PauseAsk,
  type SafetyEventFeedState,
  type StepSkipFinding,
  type WorkaroundFinding,
  isSafetyPostureViolation,
} from "../kernel/canonical.ts";
import { getEventFeedSafetyConfig } from "../kernel/harness-config.ts";
import { webWarn } from "../observability/debug-bridge.ts";

// ── Wire shapes ──

export type SafetyFindingFamily = "workaround" | "bandaid" | "stepSkip" | "deviation";

export type FamilyReport<F> = Readonly<{
  /** Whether this detector family ran (enabled in config AND the runtime armed). */
  armed: boolean;
  detectedCount: number;
  findings: readonly F[];
}>;

export type SafetyRuntimeReport = Readonly<{
  armed: boolean;
  /** Non-null exactly when the runtime could not be armed (config failure). */
  disarmedReason: string | null;
  workaround: FamilyReport<WorkaroundFinding>;
  bandaid: FamilyReport<BandaidFinding>;
  stepSkip: FamilyReport<StepSkipFinding>;
  deviation: FamilyReport<DeviationFinding>;
  /** Pre-formatted one-line messages for chat surfacing — real findings only. */
  messages: readonly string[];
  /** Investigation verdicts for the findings (empty when the runtime is disarmed). */
  investigation: readonly InvestigationResult[];
  /** Consolidated pause-and-ask, or null when none of the findings need the user. */
  pause: PauseAsk | null;
}>;

/** A completed tool call, as the run loop observes it. */
export type SafetyToolCallOutcome = Readonly<{
  turn: number;
  toolName: string;
  success: boolean;
  error?: string | undefined;
  /** The raw arguments the model sent (the ones that executed). */
  args?: Readonly<Record<string, unknown>> | undefined;
  /** The live manifest entry's declared capabilities ("read", "write", …). */
  capabilities?: readonly string[] | undefined;
  /** Typed: the tool did not run because it is missing or unconfigured. */
  unavailable?: boolean | undefined;
  /** Typed: WHY it did not run, when a typed MCP refusal carried the cause. */
  unavailableReason?: McpUnavailabilityKey | undefined;
}>;

export type SafetyRuntimeOptions = Readonly<{
  /** Inject a resolved config (tests). Default: the config owner. */
  config?: BandaidConfig | undefined;
  /** Inject the config resolution itself (tests for the malformed-config path). */
  resolveConfig?: (() => BandaidConfig) | undefined;
}>;

// ── Fact derivation (capability-driven, no tool-name lists) ──

/**
 * Whether the manifest entry declares a capability. The live manifest is the
 * single owner of which tools read/write — a new editor tool with the "write"
 * capability is classified automatically, and a tool renamed out of a
 * convention is still classified by its declared capability.
 */
export function declaresCapability(capabilities: readonly string[] | undefined, capability: string): boolean {
  return capabilities !== undefined && capabilities.includes(capability);
}

/** The file path an edit names, probed from the well-known arg keys. */
export function editFilePath(args: Readonly<Record<string, unknown>> | undefined): string | null {
  if (args === undefined) return null;
  const path = args["path"];
  if (typeof path === "string" && path.length > 0) return path;
  const file = args["file"];
  if (typeof file === "string" && file.length > 0) return file;
  return null;
}

/** The lines an edit ADDS, derived from the edit's own arguments. */
export function editAddedLines(args: Readonly<Record<string, unknown>> | undefined): readonly string[] {
  if (args === undefined) return [];
  const newContent = args["newContent"];
  if (typeof newContent === "string" && newContent.length > 0) return newContent.split("\n");
  const text = args["text"];
  if (typeof text === "string" && text.length > 0) return text.split("\n");
  const patch = args["patch"];
  if (typeof patch === "string" && patch.length > 0) {
    // A unified-diff patch: the lines the model adds are the "+" lines.
    return patch.split("\n").filter((l) => l.startsWith("+")).map((l) => l.slice(1));
  }
  return [];
}

/** The file path a read names, probed from the well-known arg keys. */
export function readFilePath(args: Readonly<Record<string, unknown>> | undefined): string | null {
  if (args === undefined) return null;
  // Only keys that CARRY a file path count. `name` is deliberately absent:
  // on the tools that take one (quick_view, slice) it is a SYMBOL name, not
  // a path — recording it as a read claims the model read a file it never
  // opened, and a root file that happens to share the symbol's name would
  // have its edit-before-read wrongly cleared. A view that cannot name its
  // file records no read (absence over fabrication); `slice`'s `file` hint
  // still records, because it IS a path.
  for (const key of ["path", "file"] as const) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/**
 * The tool call's intent — the tool name plus its principal target, derived
 * from its arguments (path/file/pattern/query/command/name). The workaround
 * detector uses the intent to tell a same-tool retry on the SAME target
 * (clears suspicion) from a call on a DIFFERENT target. Derived, never a
 * static per-tool map.
 */
export function toolIntent(toolName: string, args: Readonly<Record<string, unknown>> | undefined): string {
  if (args === undefined) return toolName;
  for (const key of ["path", "file", "pattern", "query", "command", "name", "message"] as const) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0) return `${toolName}:${v}`;
  }
  return toolName;
}

// ── Finding message format (the single owner of the chat surface) ──

const FINDING_FAMILY_LABELS: Readonly<Record<SafetyFindingFamily, string>> = Object.freeze({
  workaround: "workaround",
  bandaid: "bandaid fix",
  stepSkip: "skipped step",
  deviation: "off-task work",
});

/**
 * The one-line message a finding becomes in chat, in the owner's stable
 * format. The leading marker is load-bearing: the client's inline-event
 * reconstruction (`classifyInlineEvent`) reads it back from persisted
 * timeline refs, so the live SSE label and the reloaded label cannot drift.
 * The evidence text is the finding's own field (the detector families name
 * it differently — `evidence` vs `evidenceLine`), passed in by the caller.
 */
export function safetyFindingMessage(
  family: SafetyFindingFamily,
  evidence: string,
  recommendation: string,
): string {
  const label = FINDING_FAMILY_LABELS[family] ?? family;
  const pieces = [evidence, recommendation].filter((p) => typeof p === "string" && p.length > 0);
  return `Safety finding (${label}): ${pieces.join(" ")}`;
}

// ── The runtime ──

export type SafetyRuntime = Readonly<{
  setOriginalTask(taskDescription: string): void;
  /** The run-loop seam for a completed tool call. Routes the fact into every
   * detector that consumes it (workaround tool-calls; bandaid + step-skip
   * edits; step-skip reads) based on the manifest-declared capabilities. */
  recordToolCall(outcome: SafetyToolCallOutcome): void;
  /** The run-loop seam for a finished assistant turn. Files touched and
   * searches are derived from this runtime's own recorded tool calls for the
   * turn — the run loop reports only what it uniquely knows (the text). */
  recordWork(event: Readonly<{ turn: number; description: string }>): void;
  /** The run-loop seam for task completion. `taskType` is optional: an unknown
   * task type records the completion honestly and matches no expectations. */
  completeTask(event: Readonly<{ turn: number; taskType?: string | undefined }>): void;
  detect(): SafetyRuntimeReport;
  /**
   * Mid-run intervention: the NEW pause (if any) and the NEW reject
   * guidance since the last take. The run loop publishes the pause and
   * waits for a steer, and injects reject guidance into the next turn.
   * Calling this marks those interventions consumed so a later turn
   * cannot re-pause or re-inject the same findings.
   */
  takePendingIntervention(): SafetyIntervention;
  /** The live counts the exposure signals read (cached detect result). */
  liveState(): SafetyEventFeedState;
  /**
   * How long the run may wait for the user's pause-ask answer before it
   * ends as a named timeout (milliseconds; 0 = wait forever). Resolved ONCE
   * with the rest of the event-feed config at creation — a mid-run config
   * edit applies to the next run, like every other detector tunable.
   * The run-registry's wait requires a bound argument, so "wait with no
   * bound" is not a shape the owner offers; 0 on a disarmed runtime (which
   * never pauses, so the value is never consumed).
   */
  readonly pauseAskWaitTimeoutMs: number;
  dispose(): void;
}>;

export type SafetyIntervention = Readonly<{
  pause: PauseAsk | null;
  rejectMessage: string | null;
}>;

const liveRuntimes = new Set<SafetyRuntime>();

/**
 * Install the exposure state source once at server boot. The engine's safety
 * registration owns the signals; this is the single feeder — it aggregates
 * every live runtime's cached verdicts, so the instruments show real detector
 * counts across concurrent runs and honest zeros when no run is active.
 */
export function installRunSafetyRuntimeExposureSource(): void {
  installSafetyEventFeedStateSource(() => {
    let active = false;
    let workaroundFindings = 0;
    let bandaidFindings = 0;
    let stepSkipFindings = 0;
    let deviationFindings = 0;
    for (const rt of liveRuntimes) {
      const state = rt.liveState();
      if (state.active) active = true;
      workaroundFindings += state.workaroundFindings;
      bandaidFindings += state.bandaidFindings;
      stepSkipFindings += state.stepSkipFindings;
      deviationFindings += state.deviationFindings;
    }
    return { active, workaroundFindings, bandaidFindings, stepSkipFindings, deviationFindings };
  });
}

/** How many runtimes this process currently tracks (reported by tests). */
export function liveSafetyRuntimeCount(): number {
  return liveRuntimes.size;
}

export function createRunSafetyRuntime(options: SafetyRuntimeOptions = {}): SafetyRuntime {
  let config: BandaidConfig | null;
  let disarmedReason: string | null = null;
  try {
    config = options.config ?? (options.resolveConfig ?? getEventFeedSafetyConfig)();
  } catch (err) {
    // A POSTURE violation is refused, not degraded: a section that disarms a
    // detector would turn "the run could not arm its detectors" into the
    // very weakening the floors exist to refuse — the run that would run
    // unarmed detectors does not start, and the typed refusal names the
    // leaf. Only value-shape problems (a bad regex, an out-of-range
    // threshold) take the visible disarmed path below.
    if (isSafetyPostureViolation(err)) throw err;
    // A malformed config section is a VISIBLE disarmed state, never a silent
    // "detectors off". The reason travels on the run's findings frame and the
    // debug bridge so the operator sees exactly why nothing was evaluated.
    disarmedReason = `the event-feed safety detectors could not be armed: ${err instanceof Error ? err.message : String(err)}`;
    webWarn("safety-runtime", "event-feed safety config rejected", () => ({ reason: disarmedReason ?? "" }));
    config = null;
  }

  const workaround = config !== null ? createWorkaroundDetector({ config }) : null;
  const bandaid = config !== null ? createBandaidDetector({ config }) : null;
  const stepSkip = config !== null ? createStepSkipDetector({ config }) : null;
  const deviation = config !== null ? createDeviationDetector({ config }) : null;
  const investigator = config !== null ? createInvestigator({ config }) : null;
  const pauseAsk = config !== null ? createPauseAskBuilder({ config }) : null;

  const turnFiles = new Map<number, Set<string>>();
  const turnSearches = new Map<number, Set<string>>();
  /** The tools whose LATEST outcome was a typed unavailability refusal. The
   * set is last-outcome-wins, not set-only: a later untyped outcome (a plain
   * failure, a success) says the tool answered, so the tool leaves the set —
   * otherwise a stale "unavailable" would keep judging later findings against
   * a state the tool no longer has. */
  const unavailableTools = new Set<string>();
  /** The typed cause of each unavailable tool (the refusal that carried a
   * reason key) — consumed by the investigation so its pause text names the
   * REAL cause, not a generic "missing or unconfigured". Last-outcome-wins
   * alongside `unavailableTools`: an untyped unavailability for the same name
   * clears the earlier reason, so a later pause sentence can never borrow a
   * cause that belonged to an older refusal. */
  const unavailableReasons = new Map<string, McpUnavailabilityKey>();
  const consumedKeys = new Set<string>();
  let cached: SafetyRuntimeReport | null = null;

  const familyArmed = (family: "workaround" | "bandaid" | "stepSkip" | "deviation"): boolean =>
    config !== null && config.families[family].enabled;

  function recordToolCall(outcome: SafetyToolCallOutcome): void {
    cached = null;
    if (workaround !== null) {
      workaround.recordToolCall({
        turn: outcome.turn,
        toolName: outcome.toolName,
        intent: toolIntent(outcome.toolName, outcome.args),
        success: outcome.success,
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        ...(outcome.unavailable === true ? { unavailable: true } : {}),
      });
    }
    if (outcome.success === false && outcome.unavailable === true) {
      unavailableTools.add(outcome.toolName);
      if (outcome.unavailableReason !== undefined) {
        unavailableReasons.set(outcome.toolName, outcome.unavailableReason);
      } else {
        // An untyped unavailability carries no cause — clear any reason an
        // earlier typed refusal recorded for this name, so the pause text
        // for a LATER finding cannot borrow a cause that is no longer the
        // tool's latest state.
        unavailableReasons.delete(outcome.toolName);
      }
    } else {
      // Any other outcome (a success, or a plain failure with no unavailable
      // typing) means the tool answered: it is not "unavailable" any more.
      // Keep the maps at the latest state so a finding is judged against
      // what the tool most recently said, never against a stale refusal.
      unavailableTools.delete(outcome.toolName);
      unavailableReasons.delete(outcome.toolName);
    }
    if (config === null) return;

    const args = outcome.args;
    if (declaresCapability(outcome.capabilities, "write")) {
      const filePath = editFilePath(args);
      if (filePath !== null) {
        const addedLines = editAddedLines(args);
        workaround?.recordEdit({ turn: outcome.turn, filePath, addedLines });
        bandaid?.recordEdit({ turn: outcome.turn, filePath, addedLines, removedLines: [] });
        stepSkip?.recordEdit({ turn: outcome.turn, filePath });
        let files = turnFiles.get(outcome.turn);
        if (files === undefined) {
          files = new Set();
          turnFiles.set(outcome.turn, files);
        }
        files.add(filePath);
      }
    }
    if (declaresCapability(outcome.capabilities, "read")) {
      const filePath = readFilePath(args);
      if (filePath !== null) {
        stepSkip?.recordRead({ turn: outcome.turn, filePath });
        let files = turnFiles.get(outcome.turn);
        if (files === undefined) {
          files = new Set();
          turnFiles.set(outcome.turn, files);
        }
        files.add(filePath);
      }
    }
    if (args !== undefined) {
      for (const key of ["pattern", "query"] as const) {
        const v = args[key];
        if (typeof v === "string" && v.length > 0) {
          let searches = turnSearches.get(outcome.turn);
          if (searches === undefined) {
            searches = new Set();
            turnSearches.set(outcome.turn, searches);
          }
          searches.add(v);
        }
      }
    }
  }

  function recordWork(event: { turn: number; description: string }): void {
    cached = null;
    deviation?.recordWork({
      turn: event.turn,
      description: event.description,
      filesTouched: [...(turnFiles.get(event.turn) ?? [])],
      searches: [...(turnSearches.get(event.turn) ?? [])],
    });
  }

  function completeTask(event: { turn: number; taskType?: string | undefined }): void {
    cached = null;
    stepSkip?.completeTask({ turn: event.turn, taskType: event.taskType ?? "" });
  }

  function emptyFamily<F>(): FamilyReport<F> {
    return { armed: false, detectedCount: 0, findings: [] };
  }

  function disarmedReport(): SafetyRuntimeReport {
    return {
      armed: false,
      disarmedReason,
      workaround: emptyFamily(),
      bandaid: emptyFamily(),
      stepSkip: emptyFamily(),
      deviation: emptyFamily(),
      messages: [],
      investigation: [],
      pause: null,
    };
  }

  function findingKey(finding: AnyFinding): string {
    if (finding.family === "workaround") {
      return `workaround:${finding.turn}:${finding.failedTool}:${finding.switchKind}:${finding.switchedTo}`;
    }
    if (finding.family === "bandaid") {
      return `bandaid:${finding.turn}:${finding.filePath}:${finding.patternLabel}`;
    }
    if (finding.family === "stepSkip") {
      return `stepSkip:${finding.turn}:${finding.kind}:${finding.filePath}:${finding.missingStep}`;
    }
    return `deviation:${finding.turn}:${finding.similarity.toFixed(3)}:${finding.persistent ? "p" : "t"}`;
  }

  function detect(): SafetyRuntimeReport {
    if (config === null || workaround === null || bandaid === null || stepSkip === null || deviation === null || investigator === null || pauseAsk === null) {
      cached = disarmedReport();
      return cached;
    }
    const workaroundReport = workaround.detect();
    const bandaidReport = bandaid.detect();
    const stepSkipReport = stepSkip.detect();
    const deviationReport = deviation.detect();
    const messages: string[] = [];
    for (const f of workaroundReport.findings) messages.push(safetyFindingMessage("workaround", f.evidence, f.recommendation));
    for (const f of bandaidReport.findings) messages.push(safetyFindingMessage("bandaid", f.evidenceLine, f.recommendation));
    for (const f of stepSkipReport.findings) messages.push(safetyFindingMessage("stepSkip", f.evidence, f.recommendation));
    for (const f of deviationReport.findings) messages.push(safetyFindingMessage("deviation", f.evidence, f.recommendation));
    const allFindings: AnyFinding[] = [
      ...workaroundReport.findings,
      ...bandaidReport.findings,
      ...stepSkipReport.findings,
      ...deviationReport.findings,
    ];
    const investigation = allFindings.map((finding) => investigator.investigate(finding, {
      // Sentence-level honesty: this site runs NO root-cause probe and NO
      // task-feasibility probe, so those legs say "unevaluated" rather than
      // carrying a fabricated boolean that pretends a measurement ran. An
      // "unevaluated" leg can only ever be recorded, never judged — a fired
      // deviation therefore surfaces as a finding (advisory) and becomes a
      // pause only when a leg is EVIDENCED, the way the workaround's
      // tool-unavailability is: that leg is DRIVEN by recorded outcomes,
      // so its honest boolean always exists.
      rootCauseKnown: "unevaluated",
      rootCauseFixableByLLM: "unevaluated",
      rootCauseNeedsUserInstall: finding.family === "workaround"
        ? unavailableTools.has(finding.failedTool)
        : "unevaluated",
      toolReportedUnavailable: finding.family === "workaround" && unavailableTools.has(finding.failedTool),
      ...(finding.family === "workaround" && unavailableReasons.has(finding.failedTool)
        ? { toolUnavailableReason: unavailableReasons.get(finding.failedTool)! }
        : {}),
      taskPossible: "unevaluated",
      deviationIsImprovement: "unevaluated",
    }));
    cached = {
      armed: true,
      disarmedReason: null,
      workaround: { armed: familyArmed("workaround"), detectedCount: workaroundReport.detectedCount, findings: workaroundReport.findings },
      bandaid: { armed: familyArmed("bandaid"), detectedCount: bandaidReport.detectedCount, findings: bandaidReport.findings },
      stepSkip: { armed: familyArmed("stepSkip"), detectedCount: stepSkipReport.detectedCount, findings: stepSkipReport.findings },
      deviation: { armed: familyArmed("deviation"), detectedCount: deviationReport.detectedCount, findings: deviationReport.findings },
      messages: Object.freeze(messages),
      investigation: Object.freeze(investigation),
      pause: pauseAsk.buildPause(investigation[0]?.finding.turn ?? 0, investigation),
    };
    return cached;
  }

  function takePendingIntervention(): SafetyIntervention {
    const report = detect();
    const freshPause: InvestigationResult[] = [];
    const rejectReasons: string[] = [];
    for (const result of report.investigation) {
      if (result.action === "pause-and-ask") {
        const key = `pause:${findingKey(result.finding)}`;
        if (consumedKeys.has(key)) continue;
        freshPause.push(result);
        continue;
      }
      if (result.action !== "reject") continue;
      const key = `reject:${findingKey(result.finding)}`;
      if (consumedKeys.has(key)) continue;
      consumedKeys.add(key);
      rejectReasons.push(result.reason);
    }
    let pause: PauseAsk | null = null;
    if (freshPause.length > 0 && pauseAsk !== null) {
      // Rebuild from UNCONSUMED findings only. Keying the pause by the
      // first finding's turn + family list dropped a later unconfigured-tool
      // workaround of the same family — the new finding never reached the user.
      pause = pauseAsk.buildPause(freshPause[0]!.finding.turn, freshPause);
      if (pause !== null) {
        for (const result of freshPause) consumedKeys.add(`pause:${findingKey(result.finding)}`);
      }
    }
    return {
      pause,
      rejectMessage: rejectReasons.length === 0
        ? null
        : `The event-feed safety investigation rejected the following work. Undo or correct it and continue with the original task:\n${rejectReasons.map((reason, i) => `${i + 1}. ${reason}`).join("\n")}`,
    };
  }

  function liveState(): SafetyEventFeedState {
    const report = cached ?? detect();
    return {
      active: report.armed,
      workaroundFindings: report.workaround.detectedCount,
      bandaidFindings: report.bandaid.detectedCount,
      stepSkipFindings: report.stepSkip.detectedCount,
      deviationFindings: report.deviation.detectedCount,
    };
  }

  const runtime: SafetyRuntime = Object.freeze({
    setOriginalTask(taskDescription: string): void {
      cached = null;
      deviation?.setOriginalTask(taskDescription);
    },
    recordToolCall,
    recordWork,
    completeTask,
    detect,
    takePendingIntervention,
    liveState,
    pauseAskWaitTimeoutMs: config?.pauseAskWaitTimeoutMs ?? 0,
    dispose(): void {
      liveRuntimes.delete(runtime);
      cached = null;
    },
  });
  liveRuntimes.add(runtime);
  return runtime;
}

