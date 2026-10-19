import { type BandaidConfig } from "./bandaid-config.ts";
import {
  type InvestigationResult,
} from "./investigation.ts";

/**
 * Pause-and-ask stage — "if its something the user needs to do/install, then
 * pause and ask user" (user directive, 2026-07-21).
 *
 * When the investigation returns `needs-user-action`, the harness PAUSES the
 * task and surfaces a single consolidated question to the user. The pause is
 * a typed state, not a thrown error: the runtime can resume the task once the
 * user answers (and the harness can record the pause + answer in the
 * timeline, per the harness's linked-timeline requirement).
 *
 * The pause-ask is DETERMINISTIC: it consumes `InvestigationResult[]` and
 * builds the message from the `pauseMessage` fields. It does not call the LLM
 * to phrase the question (the messages are already human-readable from the
 * investigation stage).
 *
 * When `pauseAskEnabled` is false in the config, `buildPause` returns null
 * (the harness falls back to recording the needs-user-action finding without
 * pausing — a degraded mode for non-interactive runs).
 *
 * Every threshold comes from `BandaidConfig`.
 */
export type PauseAsk = Readonly<{
  /** The turn at which the pause was issued. */
  turn: number;
  /** The investigation results that triggered the pause. */
  triggeringResults: readonly InvestigationResult[];
  /** The consolidated message to surface to the user. */
  message: string;
  /** The user-action categories requested (deduped). */
  requestedActions: readonly string[];
}>;

export type PauseAskBuilder = Readonly<{
  /** Build a consolidated pause from investigation results. Returns null when no result needs user action. */
  buildPause(turn: number, results: readonly InvestigationResult[]): PauseAsk | null;
}>;

export type PauseAskOptions = Readonly<{ config: BandaidConfig }>;

export function createPauseAskBuilder(options: PauseAskOptions): PauseAskBuilder {
  const cfg = options.config;

  function buildPause(turn: number, results: readonly InvestigationResult[]): PauseAsk | null {
    if (!cfg.pauseAskEnabled) return null;
    const triggers = results.filter((r) => r.verdict === "needs-user-action" && r.action === "pause-and-ask");
    if (triggers.length === 0) return null;

    // Dedupe messages (multiple findings can produce the same pause message).
    const seenMessages = new Set<string>();
    const uniqueMessages: string[] = [];
    for (const t of triggers) {
      if (t.pauseMessage && !seenMessages.has(t.pauseMessage)) {
        seenMessages.add(t.pauseMessage);
        uniqueMessages.push(t.pauseMessage);
      }
    }
    // Dedupe requested actions (categories from the finding families).
    const seenActions = new Set<string>();
    const requestedActions: string[] = [];
    for (const t of triggers) {
      const fam = t.finding.family;
      if (!seenActions.has(fam)) {
        seenActions.add(fam);
        requestedActions.push(fam);
      }
    }

    const header =
      `I need your help before continuing. ${triggers.length} issue(s) require a user action:\n\n`;
    const body = uniqueMessages.map((m, i) => `${i + 1}. ${m}`).join("\n\n");
    let message = `${header}${body}`;
    if (message.length > cfg.pauseAskMaxMessageLength) {
      message = message.slice(0, cfg.pauseAskMaxMessageLength - 3) + "...";
    }

    return {
      turn,
      triggeringResults: triggers,
      message,
      requestedActions,
    };
  }

  return { buildPause };
}

/**
 * A typed pause state for the runtime. The runtime holds the task in this
 * state until the user answers; the harness can record the pause + answer in
 * the timeline. This is a value object — the actual pause/resume is owned by
 * the runtime, not by this module.
 */
export type PauseState = Readonly<{
  paused: true;
  pause: PauseAsk;
}>;

export type RunningState = Readonly<{ paused: false }>;

export type TaskState = PauseState | RunningState;

export function isPaused(state: TaskState): state is PauseState {
  return state.paused === true;
}

/**
 * Build the typed pause state from investigation results. Returns a running
 * state (paused: false) when no pause is needed.
 */
export function buildTaskState(
  builder: PauseAskBuilder,
  turn: number,
  results: readonly InvestigationResult[],
): TaskState {
  const pause = builder.buildPause(turn, results);
  if (pause === null) return { paused: false };
  return { paused: true, pause };
}
