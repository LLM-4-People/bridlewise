/**
 * Mechanism-design signal (EXP327).
 *
 * EXP327 applied mechanism design (the design of incentive-compatible
 * rules): 15/20 evasions are incentive-compatible (IC at penalty/savings
 * ratio ≥ 2.0). 5 uncaught (N1/N2/N4/N5/N6) are NEVER IC — the
 * developer's best response is to copy-paste via these because the
 * mechanism CAN'T catch them. This is the mechanism-design PROOF that
 * the N4/N5 gaps are structural incentive failures, not just missed-TPs.
 *
 * For awareness, we approximate "mechanism-design IC ratio" via the
 * ratio of detected clones to total clone candidates. A high IC ratio
 * means the codebase's DRY-enforcement mechanism is effective (most
 * violations are caught = incentive-compatible). A low IC ratio means
 * many violations slip through (the mechanism is ineffective —
 * developers can profit by copy-pasting).
 *
 * The signal emits:
 * - icRatio: detectedClones / totalCandidates (0-1).
 * - incentiveCompatible: true if icRatio > 0.5.
 * - uncaughtCandidates: totalCandidates − detectedClones (the gap).
 * - mechanismStrength: "strong" | "moderate" | "weak".
 *
 * Actionable: a weak mechanism = the codebase has many undetected DRY
 * violations — strengthen the detector or add explicit anti-clone
 * rules.
 *
 * Source: EXP327.
 */
import type { SignalContext } from "../types.ts";
import { buildCloneGraph } from "./clone-graph.ts";
import { round } from "../../shared/numeric-helpers.ts";

export function computeMechanismDesign(ctx: SignalContext) {
  const graph = buildCloneGraph(ctx);
  const allFns = ctx.fileAnalyses.flatMap(fa => fa.functions);
  // Total candidates = functions that are similar enough to be candidates
  // (in any family, including singletons). We approximate "total
  // candidates" as the number of functions with bodyChars >= minBodySize
  // (i.e. eligible for clone detection).
  const minBody = ctx.config.thresholds.cloneMinBodySize;
  const minTokens = ctx.config.thresholds.cloneMinTokens;
  const eligible = allFns.filter(f => f.bodyChars >= minBody && f.tokens.length >= minTokens);
  const detectedClones = graph.functions.length; // functions in the clone graph
  const totalCandidates = eligible.length;
  if (totalCandidates === 0) {
    return { mechanismDesign: { icRatio: 0, incentiveCompatible: false, uncaughtCandidates: 0, mechanismStrength: "no-data", familyCount: 0 } };
  }
  const icRatio = round(detectedClones / totalCandidates, 4);
  const uncaught = totalCandidates - detectedClones;
  const strength = icRatio > 0.7 ? "strong" : icRatio > 0.4 ? "moderate" : "weak";
  return {
    mechanismDesign: {
      icRatio,
      incentiveCompatible: icRatio > 0.5,
      uncaughtCandidates: uncaught,
      mechanismStrength: strength,
      familyCount: graph.families.length,
    },
  };
}
