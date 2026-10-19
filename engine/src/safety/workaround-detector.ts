import {
  type BandaidConfig,
  type BandaidSeverity,
} from "./bandaid-config.ts";

/**
 * Workaround detector — the LLM uses a different/manual approach because a
 * tool failed or is unavailable.
 *
 * Records tool-call events (success + failure) and edit events. The
 * detection logic:
 *
 * 1. A "consequential" tool (from `workaroundConsequentialTools`) fails.
 * 2. Within `workaroundSwitchWindow` turns, the LLM either:
 * a. issues a DIFFERENT tool call for the same intent (a switch), OR
 * b. writes code matching a `workaroundManualApproachPattern` (a hand-rolled
 * reimplemented tool — e.g. a for-loop with indexOf after `search_code`
 * failed).
 * 3. Flag a workaround finding.
 *
 * A tool failure ALONE is not a workaround — the LLM is allowed to fail and
 * retry the SAME tool, or report the failure. The finding fires only when the
 * LLM SWITCHES approach silently. Per the user directive: "if its something
 * the user needs to do/install, then pause and ask user" — the investigation
 * + pause-ask stages decide whether the switch is legitimate (tool genuinely
 * broken → ask user) or a workaround the LLM should not have applied.
 *
 * Every threshold + tool list + regex comes from `BandaidConfig`.
 *
 * Integration: `recordToolCall` wraps every tool call; `recordEdit` is shared
 * with the bandaid detector (both consume edits). The detector produces a
 * `WorkaroundFinding[]` that feeds the investigation stage.
 */
export type ToolCallEvent = Readonly<{
  turn: number;
  toolName: string;
  /** Intent of the call (e.g. "find-all-call-sites", "fetch-docs-for-X"). */
  intent: string;
  success: boolean;
  /** Free-text error when `success` is false. */
  error?: string | undefined;
  /** Was the tool reported as unavailable (missing/unconfigured)? */
  unavailable?: boolean | undefined;
}>;

export type WorkaroundEditEvent = Readonly<{
  turn: number;
  filePath: string;
  addedLines: readonly string[];
}>;

export type WorkaroundFinding = Readonly<{
  family: "workaround";
  turn: number;
  severity: BandaidSeverity;
  /** The tool that failed. */
  failedTool: string;
  /** The intent the LLM was pursuing. */
  intent: string;
  /** "tool-switch" (different tool used next) or "manual-reimplementation" (hand-rolled code). */
  switchKind: "tool-switch" | "manual-reimplementation";
  /** The turn the switch happened. */
  switchTurn: number;
  /** The tool the LLM switched to (tool-switch only; empty for manual). */
  switchedTo: string;
  evidence: string;
  recommendation: string;
}>;

export type WorkaroundDetectionReport = Readonly<{
  findings: readonly WorkaroundFinding[];
  detectedCount: number;
}>;

export type WorkaroundDetector = Readonly<{
  recordToolCall(event: ToolCallEvent): void;
  recordEdit(event: WorkaroundEditEvent): void;
  detect(): WorkaroundDetectionReport;
  snapshot(): Readonly<{ toolCalls: readonly ToolCallEvent[]; edits: readonly WorkaroundEditEvent[] }>;
}>;

export type WorkaroundDetectorOptions = Readonly<{ config: BandaidConfig }>;

export function createWorkaroundDetector(options: WorkaroundDetectorOptions): WorkaroundDetector {
  const cfg = options.config;
  // EXP432: consequential tools are now DYNAMIC. Mode "all" (the default)
  // treats every tool as consequential — no static list. Mode "list" uses the
  // config's `workaroundConsequentialTools` (a user may populate it from the
  // harness tool registry at runtime; empty by default — no hardcoded list).
  const consequentialMode = cfg.workaroundConsequentialToolsMode;
  const consequentialList = new Set(cfg.workaroundConsequentialTools);
  const isConsequential = (toolName: string): boolean =>
    consequentialMode === "all" ? true : consequentialList.has(toolName);
  const manualPatterns = cfg.workaroundManualApproachPatterns.map((p: string) => new RegExp(p));

  const toolCalls: ToolCallEvent[] = [];
  const edits: WorkaroundEditEvent[] = [];

  function recordToolCall(event: ToolCallEvent): void {
    toolCalls.push(event);
  }
  function recordEdit(event: WorkaroundEditEvent): void {
    edits.push(event);
  }

  function detect(): WorkaroundDetectionReport {
    const family = cfg.families.workaround;
    if (!family.enabled) return { findings: [], detectedCount: 0 };
    if (toolCalls.length < family.minEvents) return { findings: [], detectedCount: 0 };

    const findings: WorkaroundFinding[] = [];
    const fired = new Set<string>(); // dedupe by `${failedTool}-${intent}`

    // Index edits by turn for the manual-reimplementation check.
    const editsByTurn = new Map<number, WorkaroundEditEvent[]>();
    for (const e of edits) {
      let bucket = editsByTurn.get(e.turn);
      if (!bucket) {
        bucket = [];
        editsByTurn.set(e.turn, bucket);
      }
      bucket.push(e);
    }

    for (let i = 0; i < toolCalls.length; i += 1) {
      const call = toolCalls[i];
      if (!call) continue;
      if (call.success) continue;
      if (!isConsequential(call.toolName)) continue;

      const windowEnd = call.turn + cfg.workaroundSwitchWindow;
      const key = `${call.toolName}-${call.intent}`;
      if (fired.has(key)) continue;

      // (a) tool-switch: a subsequent DIFFERENT-named SUCCESSFUL call within
      // the window. A switch to another failing tool is not a workaround
      // (the LLM is still failing); a switch to a succeeding tool is.
      // A same-tool+same-intent retry that succeeds clears suspicion.
      let switched: ToolCallEvent | null = null;
      let sameToolRetriedSwitch = false;
      for (let j = i + 1; j < toolCalls.length; j += 1) {
        const next = toolCalls[j];
        if (!next) continue;
        if (next.turn > windowEnd) break;
        if (next.toolName === call.toolName) {
          if (next.intent === call.intent && next.success) {
            sameToolRetriedSwitch = true;
            break;
          }
          continue; // same tool, different intent or failed retry — keep scanning.
        }
        if (next.success) {
          switched = next;
          break;
        }
      }
      if (sameToolRetriedSwitch) continue; // retry cleared suspicion for this failure.
      if (switched) {
        fired.add(key);
        findings.push({
          family: "workaround",
          turn: call.turn,
          severity: "medium",
          failedTool: call.toolName,
          intent: call.intent,
          switchKind: "tool-switch",
          switchTurn: switched.turn,
          switchedTo: switched.toolName,
          evidence: `Tool "${call.toolName}" failed (turn ${call.turn}); LLM switched to "${switched.toolName}" (turn ${switched.turn}) without reporting the failure.`,
          recommendation:
            `Tool "${call.toolName}" failed. Investigate the failure; if the tool is genuinely broken/unavailable, pause and ask the user. Do not silently switch approaches.`,
        });
        continue;
      }

      // (b) manual-reimplementation: an edit within the window matching a
      // manual-approach pattern (hand-rolled reimplemented tool). Skip
      // when the SAME tool was retried successfully for the SAME intent
      // within the window — a retry clears workaround suspicion (the
      // LLM is retrying, not working around). A successful call for a
      // DIFFERENT intent does not clear suspicion for this failure.
      let sameToolRetried = false;
      for (let j = i + 1; j < toolCalls.length; j += 1) {
        const next = toolCalls[j];
        if (!next) continue;
        if (next.turn > windowEnd) break;
        if (next.toolName === call.toolName && next.intent === call.intent && next.success) {
          sameToolRetried = true;
          break;
        }
      }
      let manualHit: WorkaroundEditEvent | null = null;
      let manualLine = "";
      if (!sameToolRetried) {
        for (let t = call.turn; t <= windowEnd; t += 1) {
          const bucket = editsByTurn.get(t);
          if (!bucket) continue;
          for (const e of bucket) {
            // Scan the JOINED added-lines content so multi-line manual
            // reimplementations (a for-loop with indexOf on a later line)
            // match. Per-line scan would miss multi-line hand-rolled loops.
            const joined = e.addedLines.join("\n");
            let hit = false;
            for (const re of manualPatterns) {
              if (re.test(joined)) {
                hit = true;
                break;
              }
            }
            if (hit) {
              manualHit = e;
              manualLine = e.addedLines.find((l) => l.length > 0) ?? "";
              break;
            }
          }
          if (manualHit) break;
        }
      }
      if (manualHit) {
        fired.add(key);
        findings.push({
          family: "workaround",
          turn: call.turn,
          severity: "high",
          failedTool: call.toolName,
          intent: call.intent,
          switchKind: "manual-reimplementation",
          switchTurn: manualHit.turn,
          switchedTo: "",
          evidence: `Tool "${call.toolName}" failed (turn ${call.turn}); LLM hand-rolled the tool's job at turn ${manualHit.turn}: "${manualLine}"`,
          recommendation:
            `Tool "${call.toolName}" failed and the LLM reimplemented its job by hand. Investigate the tool failure; if the tool is unavailable, pause and ask the user to install/configure it. Do not silently work around it.`,
        });
      }
    }

    return { findings, detectedCount: findings.length };
  }

  function snapshot(): Readonly<{ toolCalls: readonly ToolCallEvent[]; edits: readonly WorkaroundEditEvent[] }> {
    return { toolCalls, edits };
  }

  return { recordToolCall, recordEdit, detect, snapshot };
}
