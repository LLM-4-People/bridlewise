import { type BandaidConfig } from "./bandaid-config.ts";
import {
  type BandaidFinding,
} from "./bandaid-detector.ts";
import {
  type WorkaroundFinding,
} from "./workaround-detector.ts";
import {
  type DeviationFinding,
} from "./deviation-detector.ts";
import {
  type StepSkipFinding,
} from "./step-skip-detector.ts";
import {
  type McpUnavailabilityKey,
} from "../mcp/unavailability.ts";

/**
 * Investigation stage — "it needs to be investigated before concluding"
 * (user directive, 2026-07-21).
 *
 * A finding from the bandaid / workaround / deviation / step-skip detectors
 * is a SIGNAL, not a verdict. The investigation takes the finding + a
 * context (what is known about the root cause, the tool status, the task)
 * and classifies it into one of three verdicts:
 *
 * - `unnecessary` — the bandaid/workaround/deviation is NOT
 * legitimate; the LLM should fix the root cause /
 * retry the tool / return to the task. The
 * prevention stage rejects the action.
 * - `necessary` — the bandaid/workaround/deviation IS legitimate
 * (the root cause is genuinely not fixable by the
 * LLM; the tool is genuinely broken; the deviation
 * is a better approach). The prevention stage
 * allows the action but records it.
 * - `needs-user-action` — the root cause requires the USER to act (install
 * a missing dependency, configure a tool, confirm
 * the task is possible). The prevention stage
 * PAUSES and asks the user (see pause-ask.ts).
 *
 * The investigation is DETERMINISTIC: it inspects the finding's overlap with
 * the known root cause, the tool's availability, the task's feasibility,
 * and the deviation's relationship to the original task. It does not call
 * the LLM (the investigation is a structured rule check, not a guess).
 *
 * Every threshold comes from `BandaidConfig`.
 */
export type AnyFinding =
  | BandaidFinding
  | WorkaroundFinding
  | DeviationFinding
  | StepSkipFinding;

/**
 * The honest three-valued answer for any "what does the harness know?"
 * probe: `true` ("assessed and yes"), `false` ("assessed and no"), or
 * `"unevaluated"` — NOTHING probed it at this site, and the context says
 * so rather than passing off a `false` as a measurement. An "unevaluated"
 * leg can never become a pause with a made-up reason: only an EVIDENCED
 * `false` (the task measured impossible, an install measured needed)
 * produces the pause sentences that claim one.
 */
export type Assessment = boolean | "unevaluated";

export type InvestigationContext = Readonly<{
  /**
   * Is the root cause of the error/issue known? (From the quality pack or
   * the harness.) When false or unevaluated, a bandaid finding cannot be
   * classified as `unnecessary` (we cannot demand "fix the root cause" if
   * we don't know it); it falls back to `necessary` (the bandaid may be
   * the best the LLM can do) OR `needs-user-action` (if the root cause
   * needs a user install). `"unevaluated"` says the site ran no probe —
   * the verdict is recorded, never judged.
   */
  rootCauseKnown: Assessment;
  /**
   * Can the LLM fix the root cause? When `rootCauseKnown` is true and this
   * is true, a bandaid finding is `unnecessary` (the LLM could have fixed
   * the root cause). When this is false, the bandaid is `necessary` (the
   * root cause is outside the LLM's control) OR `needs-user-action` (if
   * `rootCauseNeedsUserInstall` is true). `"unevaluated"` records without
   * judging.
   */
  rootCauseFixableByLLM: Assessment;
  /**
   * Does the root cause require the user to install/configure something
   * (a missing dependency, a missing tool, a config change)? When true,
   * the bandaid/workaround finding is `needs-user-action` (the harness
   * should pause and ask the user, not silently work around).
   * `"unevaluated"` can never produce that pause.
   */
  rootCauseNeedsUserInstall: Assessment;
  /**
   * For workaround findings: was the failed tool reported as unavailable
   * (missing/unconfigured) rather than transiently broken? When true, the
   * workaround is `needs-user-action` (the user must install/configure the
   * tool). When false (tool is broken but installed), the workaround is
   * `unnecessary` (the LLM should report the failure, not work around it).
   * Plain boolean: this leg is DRIVEN by recorded tool outcomes, so an
   * honest `false` is always producible at the call site.
   */
  toolReportedUnavailable: boolean;
  /**
   * WHY the failed tool was reported unavailable, when a typed refusal
   * carried the cause. Each cause asks something different of the user (a
   * service to start, a server entry to add, a deliberate disable to undo, a
   * transient restart that needs nothing but a retry) — the pause text names
   * the real one rather than claiming every refusal is "missing or
   * unconfigured". Absent for a refusal with no typed cause (an adapter that
   * was never configured), where the generic install/configure text is the
   * honest sentence.
   */
  toolUnavailableReason?: McpUnavailabilityKey;
  /**
   * For deviation findings: is the original task still possible? When false
   * (e.g. the target function does not exist), the deviation is
   * `needs-user-action` (the user must clarify the task). When true, the
   * deviation is `unnecessary` (the LLM should return to the task) unless
   * `deviationIsImprovement` is true. `"unevaluated"` — no task-feasibility
   * probe ran — records the deviation and never fabricates the impossibility
   * sentence.
   */
  taskPossible: Assessment;
  /**
   * For deviation findings: does the deviation represent a legitimate
   * improvement over the original task (the LLM found a better approach)?
   * When true, the deviation is `necessary` (allow it but record it).
   */
  deviationIsImprovement: Assessment;
}>;

export type InvestigationVerdict = "unnecessary" | "necessary" | "needs-user-action";

export type InvestigationResult = Readonly<{
  verdict: InvestigationVerdict;
  /** The finding that was investigated. */
  finding: AnyFinding;
  /** Human-readable reason for the verdict. */
  reason: string;
  /**
   * The recommended action for the prevention stage. "reject" (block the
   * action), "allow-and-record" (let it through but log), or "pause-and-ask"
   * (pause the task and ask the user).
   */
  action: "reject" | "allow-and-record" | "pause-and-ask";
  /** The message to surface when the action is "pause-and-ask". */
  pauseMessage: string;
}>;

export type Investigator = Readonly<{
  investigate(finding: AnyFinding, context: InvestigationContext): InvestigationResult;
  investigateAll(
    findings: readonly AnyFinding[],
    context: InvestigationContext,
  ): readonly InvestigationResult[];
}>;

export type InvestigatorOptions = Readonly<{ config: BandaidConfig }>;

/**
 * What a tool-unavailability refusal means for a person, per reason key —
 * the ONE map covering the whole taxonomy. A reason added to the taxonomy
 * without its sentence fails to typecheck; a sentence keyed to a reason
 * the taxonomy does not own fails to typecheck. The check is on the object
 * itself (not on the freeze call), so an extra key cannot hide behind a
 * call expression.
 * `cause` is what is true right now; `advice` is what the user can
 * truthfully do. Both are plain words: no server ids, no env var names, no
 * protocol vocabulary. The transient case asks for a retry and nothing
 * else — telling the user to install or configure something for a
 * mid-flight restart would be a lie.
 */
const TOOL_UNAVAILABLE_GUIDANCE = Object.freeze({
  "not-connected": Object.freeze({
    cause: "the service it talks to is not connected right now",
    advice: "start it (or find out why it stopped) and tell me to retry",
  }),
  "not-registered": Object.freeze({
    cause: "it is not configured in this harness",
    advice: "set it up in settings and tell me to retry",
  }),
  "disabled": Object.freeze({
    cause: "it is turned off in settings",
    advice: "turn it back on and tell me to retry",
  }),
  "start-superseded": Object.freeze({
    cause: "the runtime serving it was just restarted, which is usually transient",
    advice: "tell me to retry",
  }),
  "shut-down": Object.freeze({
    cause: "the harness is shutting down",
    advice: "start it again and tell me to retry",
  }),
} satisfies Readonly<Record<McpUnavailabilityKey, Readonly<{ cause: string; advice: string }>>>);

/** The workaround description shared by every unavailability sentence. */
function switchDescription(finding: WorkaroundFinding): string {
  return finding.switchKind === "tool-switch"
    ? `switching to "${finding.switchedTo}"`
    : "hand-rolling the tool's job";
}

export function createInvestigator(options: InvestigatorOptions): Investigator {
  const cfg = options.config;

  function investigate(finding: AnyFinding, ctx: InvestigationContext): InvestigationResult {
    if (finding.family === "bandaid") {
      return investigateBandaid(finding, ctx);
    }
    if (finding.family === "workaround") {
      return investigateWorkaround(finding, ctx);
    }
    if (finding.family === "deviation") {
      return investigateDeviation(finding, ctx);
    }
    return investigateStepSkip(finding, ctx);
  }

  function investigateBandaid(
    finding: BandaidFinding,
    ctx: InvestigationContext,
  ): InvestigationResult {
    // If the user needs to install something, ALWAYS pause-and-ask (the user
    // directive: "if its something the user needs to do/install, then pause
    // and ask user"). Only an EVIDENCED need pauses — "unevaluated" never
    // fabricates the install demand.
    if (ctx.rootCauseNeedsUserInstall === true) {
      return {
        verdict: "needs-user-action",
        finding,
        reason:
          `The root cause requires a user action (install/configure). The bandaid "${finding.patternLabel}" should not be applied silently; pause and ask the user.`,
        action: "pause-and-ask",
        pauseMessage:
          `The fix for this issue requires installing or configuring something I cannot do myself. ` +
          `Root cause hint: ${finding.recommendation} Please install/configure the missing piece and I will apply the root-cause fix.`,
      };
    }
    // If the root cause is NOT known, we cannot demand "fix the root cause."
    if (ctx.rootCauseKnown === false) {
      return {
        verdict: "necessary",
        finding,
        reason:
          `The root cause is not known to the harness. The bandaid "${finding.patternLabel}" may be the best available fix; allow it but record it.`,
        action: "allow-and-record",
        pauseMessage: "",
      };
    }
    // Nothing probed the root cause at this site — say so, never fake a
    // measured "no".
    if (ctx.rootCauseKnown !== true) {
      return {
        verdict: "necessary",
        finding,
        reason:
          `No root-cause assessment ran at this site, so the harness cannot say whether the bandaid "${finding.patternLabel}" covers an addressable root cause. The edit is allowed and recorded, not judged.`,
        action: "allow-and-record",
        pauseMessage: "",
      };
    }
    // Root cause IS known, but whether the LLM could fix it was never
    // assessed — record honestly instead of branching on an invented leg.
    if (ctx.rootCauseFixableByLLM === "unevaluated") {
      return {
        verdict: "necessary",
        finding,
        reason:
          `The root cause is known, but no site assessed whether the LLM could fix it. The bandaid "${finding.patternLabel}" is allowed and recorded, not judged.`,
        action: "allow-and-record",
        pauseMessage: "",
      };
    }
    // Root cause IS known. If the LLM could fix it, the bandaid is unnecessary.
    if (ctx.rootCauseFixableByLLM) {
      // Confirm via the overlap floor: if the edit already addresses the
      // root cause (overlap >= floor), it's not a bandaid — it's a fix.
      if (finding.rootCauseOverlap >= cfg.investigationRootCauseOverlapFloor) {
        return {
          verdict: "necessary",
          finding,
          reason:
            `The edit addresses the known root cause (overlap ${finding.rootCauseOverlap.toFixed(3)} >= ${cfg.investigationRootCauseOverlapFloor}). Not a bandaid; allow it.`,
          action: "allow-and-record",
          pauseMessage: "",
        };
      }
      return {
        verdict: "unnecessary",
        finding,
        reason:
          `The root cause is known and fixable by the LLM, but the edit does not address it (overlap ${finding.rootCauseOverlap.toFixed(3)} < ${cfg.investigationRootCauseOverlapFloor}). Reject the bandaid; fix the root cause instead.`,
        action: "reject",
        pauseMessage: "",
      };
    }
    // Root cause known but NOT fixable by the LLM. Allow the bandaid.
    return {
      verdict: "necessary",
      finding,
      reason:
        `The root cause is known but not fixable by the LLM. The bandaid "${finding.patternLabel}" is necessary; allow it but record it.`,
      action: "allow-and-record",
      pauseMessage: "",
    };
  }

  function investigateWorkaround(
    finding: WorkaroundFinding,
    ctx: InvestigationContext,
  ): InvestigationResult {
    // Tool reported as unavailable → user must act. The sentence names the
    // real cause (a disconnected service, a never-configured server, a
    // deliberate disable, a transient restart, a shutdown) — the typed
    // refusal carried it; "missing or unconfigured" is only the honest text
    // for a refusal that arrived without a cause (an adapter that was never
    // configured).
    if (ctx.toolReportedUnavailable || ctx.rootCauseNeedsUserInstall === true) {
      if (ctx.toolUnavailableReason !== undefined) {
        const guidance = TOOL_UNAVAILABLE_GUIDANCE[ctx.toolUnavailableReason];
        return {
          verdict: "needs-user-action",
          finding,
          reason:
            `The failed tool "${finding.failedTool}" is unavailable: ${guidance.cause}. The workaround "${finding.switchKind}" should not be applied silently; pause so the user can ${guidance.advice}.`,
          action: "pause-and-ask",
          pauseMessage:
            `Tool "${finding.failedTool}" is unavailable: ${guidance.cause}, and I would otherwise work around it by ${switchDescription(finding)}. ` +
            `Please ${guidance.advice}; I will then use the proper tool.`,
        };
      }
      return {
        verdict: "needs-user-action",
        finding,
        reason:
          `The failed tool "${finding.failedTool}" is unavailable. The workaround "${finding.switchKind}" should not be applied silently; pause and ask the user to install/configure the tool.`,
        action: "pause-and-ask",
        pauseMessage:
          `Tool "${finding.failedTool}" is unavailable (missing or unconfigured), and I would otherwise work around it by ${switchDescription(finding)}. ` +
          `This is something you need to install/configure. Please do so and I will use the proper tool.`,
      };
    }
    // Tool is broken but installed → the LLM should REPORT the failure, not
    // silently work around it. The workaround is unnecessary.
    return {
      verdict: "unnecessary",
      finding,
      reason:
        `The failed tool "${finding.failedTool}" is installed but failed. The LLM should report the failure and ask for guidance, not silently switch to a ${finding.switchKind}. Reject the workaround; investigate the tool failure.`,
      action: "reject",
      pauseMessage: "",
    };
  }

  function investigateDeviation(
    finding: DeviationFinding,
    ctx: InvestigationContext,
  ): InvestigationResult {
    // Deviation is an improvement → allow but record.
    if (ctx.deviationIsImprovement === true) {
      return {
        verdict: "necessary",
        finding,
        reason:
          `The deviation is a legitimate improvement over the original task. Allow it but record it.`,
        action: "allow-and-record",
        pauseMessage: "",
      };
    }
    // Original task is impossible → user must clarify. Only an EVIDENCED
    // impossibility pauses — "unevaluated" never fabricates it.
    if (ctx.taskPossible === false) {
      return {
        verdict: "needs-user-action",
        finding,
        reason:
          `The original task is not possible (e.g. the target does not exist). The deviation may be the LLM searching for a substitute; pause and ask the user to clarify.`,
        action: "pause-and-ask",
        pauseMessage:
          `I have deviated from the original task because it appears not to be possible as stated (similarity ${finding.similarity.toFixed(3)}). ` +
          `Please clarify the task or confirm the deviation is correct.`,
      };
    }
    // No site assessed the original task — record the deviation honestly
    // rather than judging it against an invented feasibility claim.
    if (ctx.taskPossible === "unevaluated") {
      return {
        verdict: "necessary",
        finding,
        reason:
          `No site assessed whether the original task is still possible, nor whether this deviation improves on it (similarity ${finding.similarity.toFixed(3)}). The deviation is allowed and recorded, not judged.`,
        action: "allow-and-record",
        pauseMessage: "",
      };
    }
    // Task is possible + deviation is not an improvement → unnecessary.
    return {
      verdict: "unnecessary",
      finding,
      reason:
        `The original task is possible and the deviation is not a documented improvement. Reject the deviation; return to the task.`,
      action: "reject",
      pauseMessage: "",
    };
  }

  function investigateStepSkip(
    finding: StepSkipFinding,
    ctx: InvestigationContext,
  ): InvestigationResult {
    // Step-skip is almost always unnecessary (the LLM should perform the
    // step). The exception: the step is genuinely impossible (e.g. "read"
    // for a file that does not exist yet — a new file). When the user
    // needs to act (e.g. a dependency must be installed before "check-issues"
    // can run), pause and ask. Only an EVIDENCED need pauses.
    if (ctx.rootCauseNeedsUserInstall === true) {
      return {
        verdict: "needs-user-action",
        finding,
        reason:
          `The skipped step "${finding.missingStep}" cannot be completed without a user action. Pause and ask the user.`,
        action: "pause-and-ask",
        pauseMessage:
          `I skipped the step "${finding.missingStep}" because it requires installing or configuring something I cannot do myself. ` +
          `Please install/configure the missing piece and I will complete the step.`,
      };
    }
    return {
      verdict: "unnecessary",
      finding,
      reason:
        `The step "${finding.missingStep}" was skipped but is within the LLM's ability. Reject; perform the step.`,
      action: "reject",
      pauseMessage: "",
    };
  }

  function investigateAll(
    findings: readonly AnyFinding[],
    context: InvestigationContext,
  ): readonly InvestigationResult[] {
    return findings.map((f) => investigate(f, context));
  }

  return { investigate, investigateAll };
}

/**
 * Convenience: does any investigation result require pause-and-ask?
 * Used by the pause-ask stage to decide whether to pause.
 */
export function anyNeedsUserAction(results: readonly InvestigationResult[]): boolean {
  return results.some((r) => r.verdict === "needs-user-action");
}

/**
 * Convenience: the dominant verdict across a set of results (priority
 * needs-user-action > unnecessary > necessary). Used by the prevention
 * stage to decide the overall action.
 */
export function dominantVerdict(results: readonly InvestigationResult[]): InvestigationVerdict {
  if (results.length === 0) return "necessary";
  if (results.some((r) => r.verdict === "needs-user-action")) return "needs-user-action";
  if (results.some((r) => r.verdict === "unnecessary")) return "unnecessary";
  return "necessary";
}
