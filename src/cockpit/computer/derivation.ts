/**
 * COCKPIT COMPUTER — the derivation contract (spec §4.4).
 *
 * Every finding carries, one LENS-level deep: the sources joined (in plain
 * words), the counts at each join step, and the `asOf` of the oldest input.
 * Extrapolations must include the word "projection" and their input window.
 *
 * The guard `tests/cockpit/derivation-owner.test.ts` enforces this contract
 * mechanically: `assertDerivation` is the single runtime validator (FindingNote
 * refuses to render without it), and the test mutation-checks the validator
 * against known-bad shapes.
 */

import { ClientError } from "../../data/errors.ts";

export type DerivationStep = Readonly<{
  /** Source in plain words + its id, e.g. "this conversation's transcript". */
  source: string;
  /** Block/signal/store id backing the source (machine-readable join key). */
  sourceId: string;
  /** Measured count at this join step (rows joined, files matched, …). */
  count: number;
}>;

export type Derivation = Readonly<{
  /** The join, spelled in plain words, one sentence. */
  method: string;
  steps: readonly DerivationStep[];
  /** `asOf` of the OLDEST input (epoch ms) — staleness is visible. */
  asOf: number;
  /**
   * Present exactly when the finding is an extrapolation: the measured input
   * window ("your last 10 messages"). §4.4: extrapolations must include the
   * word "projection" AND their input window.
   */
  window?: string;
}>;

/**
 * Validate a derivation at the render boundary. Throws with a plain sentence
 * naming the violated clause — a finding may never render without its work
 * shown. Returns the derivation unchanged so call sites can inline it.
 */
export function assertDerivation(
  derivation: Derivation | undefined | null,
  sentence: string,
): Derivation {
  if (derivation === null || derivation === undefined) {
    throw new ClientError("cockpit_contract", 
      `finding "${truncateForError(sentence)}" has no derivation — a finding may not render without its work shown (§4.4)`,
    );
  }
  if (typeof derivation.method !== "string" || derivation.method.length === 0) {
    throw new ClientError("cockpit_contract", 
      `finding "${truncateForError(sentence)}" has an empty derivation method — the join must be spelled in plain words (§4.4)`,
    );
  }
  if (!Array.isArray(derivation.steps) || derivation.steps.length === 0) {
    throw new ClientError("cockpit_contract", 
      `finding "${truncateForError(sentence)}" has no derivation steps — the sources joined and their counts are mandatory (§4.4)`,
    );
  }
  for (const step of derivation.steps) {
    if (typeof step.count !== "number" || !Number.isFinite(step.count)) {
      throw new ClientError("cockpit_contract", 
        `finding "${truncateForError(sentence)}" carries a step ("${step.source}") without a measured count (§4.4)`,
      );
    }
    if (typeof step.sourceId !== "string" || step.sourceId.length === 0) {
      throw new ClientError("cockpit_contract", 
        `finding "${truncateForError(sentence)}" carries a step ("${step.source}") without a machine-readable source id (§4.4)`,
      );
    }
  }
  if (typeof derivation.asOf !== "number" || derivation.asOf <= 0) {
    throw new ClientError("cockpit_contract", 
      `finding "${truncateForError(sentence)}" has no asOf — the oldest input's age is mandatory (§4.4)`,
    );
  }
  // Extrapolation clause: a sentence that projects must say "projection" and
  // carry its input window; a derivation with a window must be labeled.
  const isProjectionSentence = sentence.toLowerCase().includes("projection");
  const hasWindow = typeof derivation.window === "string" && derivation.window.length > 0;
  if (isProjectionSentence && !hasWindow) {
    throw new ClientError("cockpit_contract", 
      `finding "${truncateForError(sentence)}" is a projection without its input window — "projection from <window>" is mandatory (§4.4)`,
    );
  }
  if (hasWindow && !isProjectionSentence) {
    throw new ClientError("cockpit_contract", 
      `finding "${truncateForError(sentence)}" carries an input window but never says "projection" — an extrapolation must label itself (§4.4)`,
    );
  }
  return derivation;
}

function truncateForError(s: string): string {
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}
