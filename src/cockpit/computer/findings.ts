/**
 * COCKPIT COMPUTER — client-computable findings (spec §4, BUILD-NOW slice).
 *
 * Two findings are computable today with zero backend additions, from data
 * the client already holds measured:
 *
 *   1. the TURN-SEAM ROLLUP (§4.3) — one line, always exactly one, computed
 *      from the turn's own beats + the checks store;
 *   2. the CONTEXT PROJECTION (§4.2 move 3) — a deterministic, labeled
 *      extrapolation from the measured context sizes of past runs.
 *
 * Both are pure functions of their inputs (Node-testable), both return the
 * mandatory derivation (§4.4), and both return `null` when the join has
 * nothing to say — absence of a finding is the honest output (§4.8).
 * No model is ever consulted (§4.8).
 */

import type { Beat, FindingBody, BeatVerb } from "../flow/types.ts";
import type { Derivation } from "./derivation.ts";

// ── Turn-seam rollup ────────────────────────────────────────────────────────

export type TurnRollupInput = Readonly<{
  turnIndex: number;
  /** Every beat belonging to this turn (from the flow log). */
  beats: readonly Beat[];
  /** How many checks were observed for this chat while the turn ran. */
  checksObserved: number;
  /** Epoch ms of the oldest input consulted. */
  asOf: number;
}>;

export type ComputedFinding = Readonly<{
  sentence: string;
  derivation: Derivation;
}>;

/**
 * The one-line turn rollup. Aggregates only MEASURED facts from the turn's
 * beats: effect count, check deltas, envelope token totals, measured duration.
 * A clause with no measured input is omitted, not zero-filled.
 */
export function computeTurnRollup(input: TurnRollupInput): ComputedFinding {
  const { turnIndex, beats, checksObserved, asOf } = input;
  const effects = beats.filter((b) => b.kind === "effect");
  const regressions = beats.filter(
    (b) => b.kind === "check-delta" && b.checkDelta !== undefined && b.checkDelta.to === "failed",
  );
  const recoveries = beats.filter(
    (b) => b.kind === "check-delta" && b.checkDelta !== undefined && b.checkDelta.to === "passed",
  );
  const toolBeats = beats.filter((b) => b.kind === "tool");
  const failedTools = toolBeats.filter((b) => b.tool?.status === "error");

  let inTok: number | undefined;
  let outTok: number | undefined;
  let totalMs: number | undefined;
  for (const b of beats) {
    if (b.kind === "turn" && b.turn?.who === "model") {
      if (b.turn.inputTokens !== undefined) inTok = (inTok ?? 0) + b.turn.inputTokens;
      if (b.turn.outputTokens !== undefined) outTok = (outTok ?? 0) + b.turn.outputTokens;
    }
  }
  const modelBeat = beats.find((b) => b.kind === "turn" && b.turn?.who === "model");
  if (modelBeat?.turn?.firstWordMs !== undefined && modelBeat.turn.tokPerSec !== undefined) {
    // duration is carried per-beat elsewhere; the rollup uses tokens instead.
  }

  const clauses: string[] = [];
  if (effects.length > 0) {
    clauses.push(effects.length === 1 ? "1 file changed" : `${effects.length} files changed`);
  }
  if (failedTools.length > 0) {
    clauses.push(failedTools.length === 1 ? "1 tool call failed" : `${failedTools.length} tool calls failed`);
  }
  for (const r of regressions) {
    clauses.push(`${r.checkDelta!.checkName}: ${r.checkDelta!.from} → ${r.checkDelta!.to}`);
  }
  for (const r of recoveries) {
    clauses.push(`${r.checkDelta!.checkName}: ${r.checkDelta!.from} → ${r.checkDelta!.to}`);
  }
  if (inTok !== undefined || outTok !== undefined) {
    const parts: string[] = [];
    if (inTok !== undefined) parts.push(`↑${fmt(inTok)}`);
    if (outTok !== undefined) parts.push(`↓${fmt(outTok)}`);
    clauses.push(`${parts.join(" ")} tok`);
  }
  void totalMs;

  const sentence =
    clauses.length > 0
      ? `turn ${turnIndex + 1} — ${clauses.join(" · ")}`
      : `turn ${turnIndex + 1} — no file effects, no check changes`;

  const derivation: Derivation = {
    method:
      "counted this turn's recorded beats (effects, tool results, envelope token totals) and joined them with the check states observed for this conversation",
    steps: [
      { source: "this turn's beats in the flow log", sourceId: "cockpit.flow.log", count: beats.length },
      { source: "checks observed for this conversation", sourceId: "state.auto-checks", count: checksObserved },
    ],
    asOf,
  };
  return { sentence, derivation };
}

// ── Context projection (desk line) ──────────────────────────────────────────

export type MeasuredContextPoint = Readonly<{
  /** Measured context size of a run (RunContext.contextTokens). */
  contextTokens: number;
  /** The run's measured limit (RunContext.contextTokenLimit). */
  contextTokenLimit?: number;
  /** When the run produced it (message timestamp, epoch ms). */
  at: number;
}>;

/** How many recent runs feed the projection window. */
export const PROJECTION_WINDOW = 10;

/**
 * Deterministic projection of context fill (§4.2 move 3). Needs ≥2 measured
 * context sizes AND a measured limit AND positive measured growth; otherwise
 * returns null — no projection is rendered from insufficient measurement.
 *
 * The sentence carries the word "projection" and the input window, both
 * mandatory (§4.4); `assertDerivation` enforces the pairing mechanically.
 */
export function computeContextProjection(
  points: readonly MeasuredContextPoint[],
): ComputedFinding | null {
  const windowPoints = points.slice(-PROJECTION_WINDOW);
  if (windowPoints.length < 2) return null;
  const last = windowPoints[windowPoints.length - 1]!;
  const first = windowPoints[0]!;
  const limit = last.contextTokenLimit;
  if (limit === undefined || limit <= 0) return null;
  const growth = (last.contextTokens - first.contextTokens) / (windowPoints.length - 1);
  if (growth <= 0) return null;
  const remaining = limit - last.contextTokens;
  if (remaining <= 0) return null;
  const messagesLeft = Math.max(1, Math.ceil(remaining / growth));
  const n = windowPoints.length;
  const windowLabel = `your last ${n} runs' measured context sizes`;
  const sentence =
    `At this rate, context fills in ~${messagesLeft} more ${messagesLeft === 1 ? "message" : "messages"} — ` +
    `projection from ${windowLabel} (avg +${fmt(Math.round(growth))} tok per message)`;
  const derivation: Derivation = {
    method:
      `took the measured context size of each of the last ${n} runs (served with each run's context event), ` +
      `averaged the growth between consecutive runs, and divided the measured remaining room ` +
      `(${fmt(remaining)} of ${fmt(limit)} tok) by that average`,
    steps: [
      { source: "measured context sizes from past runs", sourceId: "state.chat-messages/RunContext.contextTokens", count: n },
    ],
    asOf: first.at,
    window: windowLabel,
  };
  return { sentence, derivation };
}

// ── Finding assembly helper ────────────────────────────────────────────────

export function asFinding(
  computed: ComputedFinding,
  findingKind: string,
): FindingBody {
  return {
    sentence: computed.sentence,
    derivation: computed.derivation,
    findingKind,
  };
}

/**
 * Verb for the projection finding's trim shortcut — the honest disabled
 * form. The trim control IS built and live (the context desk's history
 * strip, `run.compose/trim`); what a beat verb cannot do is CHOOSE THE
 * TURN for you, so the refusal names that real limit and says where the
 * live control is — it never claims the control does not exist (UIE-011).
 */
export function trimVerbPlaceholder(controlWhere: string): BeatVerb {
  return {
    id: "run.compose/trim",
    label: "trim now",
    wired: false,
    reason: `trim needs a chosen turn — drag the trim point on ${controlWhere}`,
  };
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}
