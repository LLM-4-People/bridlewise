/**
 * Thermodynamic free-energy signal (EXP41 + EXP210).
 *
 * EXP41 modeled the codebase as a thermodynamic system: T = churn rate
 * (commits per unit time), S = disorder (Boltzmann entropy of the
 * token-frequency distribution, S = k ln W where W = distinct token
 * count), and free energy F = U − T·S where U is the average complexity
 * (internal "energy" — work needed to understand a function). EXP210
 * confirmed ΔS matches the theoretical Σ−ln(k) after a refactor to 6
 * decimal places, so F is a quantitative refactor-ROI metric:
 * - ΔF > 0 = ordering (the refactor added structure; F went up).
 * - ΔF < 0 = simplifying (the refactor reduced complexity; F went
 * down — net positive ROI).
 *
 * For awareness, the signal emits the absolute free energy F and its
 * components (T, S, U). A high |F| means the codebase has either a lot
 * of structure (high F) or a lot of disorder (low F) — both are
 * actionable: a high-F codebase is "done" (refactoring will reduce
 * order); a low-F codebase is a refactor candidate.
 *
 * Source: EXP41 (https://github.com/.../experiments/exp41-thermodynamics),
 * EXP210 (Boltzmann S = k ln W). Cited in EXPERIMENTS-SURVEY.md.
 */
import type { SignalContext } from "../types.ts";
import { round } from "../../shared/numeric-helpers.ts";

export function computeThermodynamics(ctx: SignalContext) {
  // T = churn rate: commits per day over the recent history window.
  const commits = ctx.gitHistory;
  let temperature = 0;
  if (commits.length >= 2) {
    const newest = commits[0]!.timestampMs;
    const oldest = commits[commits.length - 1]!.timestampMs;
    const days = Math.max(1, (newest - oldest) / 86_400_000);
    temperature = commits.length / days;
  }
  // S = Boltzmann entropy: k * ln(W), where W = distinct token count.
  // k is a "Boltzmann constant" for code — we use k = 1 (unitless).
  const tokenSet = new Set<string>();
  for (const fa of ctx.fileAnalyses) {
    for (const t of fa.tokenStream) tokenSet.add(t);
  }
  const W = tokenSet.size;
  const entropy = W > 0 ? Math.log(W) : 0;
  // U = average cyclomatic complexity (internal energy).
  const allFns = ctx.fileAnalyses.flatMap(fa => fa.functions);
  const U = allFns.length > 0
    ? allFns.reduce((s, f) => s + f.complexity, 0) / allFns.length
    : 0;
  // F = U - T*S. (Boltzmann k=1.)
  const freeEnergy = U - temperature * entropy;
  return {
    thermodynamics: {
      temperature: round(temperature, 4),
      entropy: round(entropy, 4),
      internalEnergy: round(U, 4),
      freeEnergy: round(freeEnergy, 4),
      boltzmannW: W,
    },
  };
}
