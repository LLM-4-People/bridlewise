/**
 * THE SWITCH — the reel's measured outcome line (§5.2).
 *
 * One line per reel, mapped in PLAIN LANGUAGE from the real fields of
 * `synthesis.conversationPulse` ("3 runs · 6 files · no errors"). The
 * mapping is deterministic and re-derivable, and `assertOutcomeHonest`
 * enforces exactly that: a rendered measured line that cannot be recomputed
 * from the pulse it claims to come from is a fabrication and throws.
 *
 * Absence is honest and structural (§1.1): a conversation with no runs says
 * "no runs yet"; an unreadable or refused pulse renders as absence with its
 * reason — never as an error wall, never as a plausible zero.
 *
 * Pure module: no DOM, no fetch. The pulse arrives as `unknown` (the block
 * declares `z.unknown()` output and the cockpit import law forbids server
 * type imports) and is narrowed structurally, field by field — a field that
 * does not narrow is treated as not measured, never guessed at.
 */

/** Thrown by the Switch's honesty guards — a fabricated outcome, a line
 * that its pulse cannot support. These are bugs, loudly. */
export class SwitchHonestyViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwitchHonestyViolation";
  }
}

export type Outcome =
  | Readonly<{
      kind: "measured";
      /** The plain-language line ("3 runs · 6 files · no errors"). */
      line: string;
      /** The conversation's first recorded instant (epoch ms), when the
       * pulse measured a wall-time span — the replay head target. */
      startMs: number | null;
      /** Recorded events in the span, when measured. */
      events: number | null;
    }>
  | Readonly<{ kind: "absent"; reason: string; empty?: true }>;

// ── Structural narrowing (no server imports — see module header) ──────────

/** Narrow to a plain record, else null. Shared with micro-bins.ts (one
 * owner — no-scattered-helpers). */
export function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** A SynthesisFact's measured value, or null (unavailable / malformed). */
function measuredValue(fact: unknown): Record<string, unknown> | null {
  const f = rec(fact);
  if (f === null || f["status"] !== "measured") return null;
  return rec(f["value"]);
}

/** A SynthesisFact's unavailable reason, or null. */
function unavailableReason(fact: unknown): string | null {
  const f = rec(fact);
  if (f === null || f["status"] !== "unavailable") return null;
  return typeof f["reason"] === "string" ? f["reason"] : null;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Map a conversationPulse payload to the reel's outcome. Deterministic:
 * same pulse, same outcome — which is what makes the honesty guard below
 * possible.
 */
export function outcomeFromPulse(pulse: unknown): Outcome {
  const p = rec(pulse);
  if (p === null) return { kind: "absent", reason: "outcome not readable" };

  const runs = rec(p["runs"]);
  const known = runs !== null ? num(runs["known"]) : null;
  if (known === null) return { kind: "absent", reason: "outcome not readable" };
  if (known === 0) return { kind: "absent", reason: "no runs yet", empty: true };

  const clauses: string[] = [plural(known, "run")];

  const files = measuredValue(p["filesTouched"]);
  const distinctPaths = files !== null ? num(files["distinctPaths"]) : null;
  if (distinctPaths !== null) clauses.push(plural(distinctPaths, "file"));

  // Third clause: errors when measured; the count is failed outcomes plus
  // events carrying recorded error detail — both real ledger counts.
  const errors = measuredValue(p["errors"]);
  if (errors !== null) {
    const n =
      (num(errors["failedOutcomes"]) ?? 0) +
      (num(errors["eventsWithErrorDetail"]) ?? 0);
    clauses.push(n > 0 ? plural(n, "error") : "no errors");
  }

  const span = measuredValue(p["wallTimeSpan"]);
  let startMs: number | null = null;
  let events: number | null = null;
  if (span !== null) {
    const first = span["firstEventAt"];
    if (typeof first === "string") {
      const ms = Date.parse(first);
      startMs = Number.isFinite(ms) ? ms : null;
    }
    events = num(span["events"]);
  }

  return { kind: "measured", line: clauses.join(" · "), startMs, events };
}

/** Why a run-bearing pulse still shows fewer clauses: cite the block's own
 * unavailability reasons (plain words, for LENS-style hovers). */
export function outcomeGaps(pulse: unknown): readonly string[] {
  const p = rec(pulse);
  if (p === null) return [];
  const gaps: string[] = [];
  for (const key of ["filesTouched", "errors", "wallTimeSpan"] as const) {
    const reason = unavailableReason(p[key]);
    if (reason !== null) gaps.push(`${key === "filesTouched" ? "files" : key === "errors" ? "errors" : "span"}: ${reason}`);
  }
  return gaps;
}

/**
 * The mutation-tested guard (task law: "reel without outcome-absence state
 * → fail"): an outcome claimed to come from `pulse` must be RE-DERIVABLE
 * from it. A tampered line, a fabricated "measured" over an empty pulse,
 * or an absence hiding real runs all throw.
 */
export function assertOutcomeHonest(outcome: Outcome, pulse: unknown): void {
  const recomputed = outcomeFromPulse(pulse);
  if (outcome.kind !== recomputed.kind) {
    throw new SwitchHonestyViolation(
      `outcome kind "${outcome.kind}" not supported by its pulse (recomputed "${recomputed.kind}")`,
    );
  }
  if (outcome.kind === "measured" && recomputed.kind === "measured") {
    if (outcome.line !== recomputed.line) {
      throw new SwitchHonestyViolation(
        `outcome line "${outcome.line}" not supported by its pulse (recomputed "${recomputed.line}")`,
      );
    }
    if (outcome.startMs !== recomputed.startMs || outcome.events !== recomputed.events) {
      throw new SwitchHonestyViolation(
        "outcome span facts not supported by the pulse they claim to come from",
      );
    }
  }
  if (outcome.kind === "absent" && recomputed.kind === "absent") {
    if (outcome.empty !== recomputed.empty) throw new SwitchHonestyViolation("empty conversation state not supported by the pulse");
    if (outcome.reason !== recomputed.reason) {
      throw new SwitchHonestyViolation(
        `absence reason "${outcome.reason}" is not the pulse's own ("${recomputed.reason}")`,
      );
    }
  }
}
