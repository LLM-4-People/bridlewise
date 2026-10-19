/**
 * Algebraic geometry spectrum (EXP347).
 *
 * EXP347 found that the spectrum (minimal catching subsets) of the
 * codebase's rule set has 26 points, with idNum being the most-generic
 * rule (covering 9/26 subsets). The signal approximates this by computing
 * the minimal "rule coverage" of clone families: each rule (normalization
 * token like `id`, `lit_str`, `lit_num`) appears in a subset of families.
 * The spectrum is the family of irreducible subsets that together cover
 * all families.
 *
 * For the awareness signal, we compute a simpler proxy:
 * - spectrumSize: number of distinct normalization tokens that appear
 * in ALL clone families (the "universal" rules — must be in any
 * catching set).
 * - totalRules: total distinct normalization tokens across all families.
 * - mostGenericRule: the rule that appears in the most families
 * (the analog of idNum being the most-generic rule in EXP347).
 * - reducibleCount: families where an alternative rule subset exists
 * (approximated by families with > 1 distinct token).
 */
import type { SignalContext } from "../types.ts";
import { buildCloneGraph } from "./clone-graph.ts";

export function computeAgSpectrum(ctx: SignalContext) {
  const graph = buildCloneGraph(ctx);
  if (graph.families.length === 0) {
    return { agSpectrum: { spectrumSize: 0, totalRules: 0, mostGenericRule: "", reducibleCount: 0, familyCount: 0 } };
  }
  // For each family, gather the set of normalization tokens used.
  const ruleToFamilyCount = new Map<string, number>();
  let totalRules = new Set<string>();
  let reducibleCount = 0;
  for (const fam of graph.families) {
    const rules = new Set<string>();
    for (const idx of fam.members) {
      const fn = graph.functions[idx]!;
      for (const t of fn.tokens) {
        // Normalization tokens are the lowercase structural markers.
        if (t === "id" || t === "lit_str" || t === "lit_num" || t === "lit_true" || t === "lit_false" || t === "lit_null" || t === "lit_bool") {
          rules.add(t);
        } else if (!/^[a-z][a-z0-9_$]*$/.test(t)) {
          // Structural tokens like "block", "if_statement" etc. — skip.
          // (these come from the tree-sitter/babel node types)
        }
      }
    }
    if (rules.size > 1) reducibleCount += 1;
    for (const r of rules) {
      totalRules.add(r);
      ruleToFamilyCount.set(r, (ruleToFamilyCount.get(r) ?? 0) + 1);
    }
  }
  // Spectrum: rules that appear in ALL families.
  let spectrumSize = 0;
  for (const [, c] of ruleToFamilyCount) {
    if (c === graph.families.length) spectrumSize += 1;
  }
  // Most-generic rule: appears in the most families.
  let mostGenericRule = "";
  let maxCount = 0;
  for (const [r, c] of ruleToFamilyCount) {
    if (c > maxCount) { maxCount = c; mostGenericRule = r; }
  }
  return {
    agSpectrum: {
      spectrumSize,
      totalRules: totalRules.size,
      mostGenericRule,
      reducibleCount,
      familyCount: graph.families.length,
    },
  };
}
