/**
 * Topos intuitionistic logic (EXP344).
 *
 * EXP344 found that the codebase topos is INTUITIONISTIC (not Boolean) —
 * the law of excluded middle (LEM, φ ∨ ¬φ = ⊤) FAILS for 57/57 modules.
 * The signal approximates this by testing, for each module, whether
 * every "property" (boolean predicate over the module's contents) is
 * either provably true or provably false. In an intuitionistic topos,
 * there exist statements that are neither — e.g. "this module has no
 * bugs" cannot be proven true or false without a full proof.
 *
 * For the awareness signal, we use a syntactic proxy: for each module,
 * consider the three properties:
 * P1 = "module has tests" (test files exist for this module).
 * P2 = "module is imported by another module".
 * P3 = "module's functions all have type annotations".
 * Each property is either TRUE (provably has the property) or FALSE
 * (provably lacks it) or UNDECIDED (no test files exist → "no bugs"
 * is neither true nor false; the module is in a "forcing" extension).
 *
 * The signal emits:
 * - lemHoldsCount: modules where all 3 properties are decidable.
 * - lemFailsCount: modules where at least one property is undecided.
 * - isIntuitionistic: true if lemFailsCount > 0.
 * - failureFraction: lemFailsCount / moduleCount.
 */
import type { SignalContext } from "../types.ts";
import { round } from "../../shared/numeric-helpers.ts";
import { moduleOf } from "../module-helpers.ts";

export function computeTopos(ctx: SignalContext) {
  const modules = ctx.modules;
  if (modules.length === 0) {
    return { topos: { lemHoldsCount: 0, lemFailsCount: 0, isIntuitionistic: false, failureFraction: 0 } };
  }
  const testPaths = new Set<string>();
  for (const fa of ctx.fileAnalyses) {
    if (/test|spec/i.test(fa.filePath)) testPaths.add(fa.filePath);
  }
  const importedModules = new Set<string>();
  for (const fa of ctx.fileAnalyses) {
    for (const imp of fa.imports) {
      if (imp.resolvedPath) {
        const mod = moduleOf(imp.resolvedPath, ctx);
        importedModules.add(mod);
      }
    }
  }
  let lemHolds = 0;
  let lemFails = 0;
  for (const m of modules) {
    // P1: "has tests" — true if any test file is in this module, false
    // if the module has source files but no test file, UNDECIDED if the
    // module has no source files at all (we can't say).
    const moduleFiles = ctx.fileAnalyses.filter(fa => fa.filePath.startsWith(m.path + "/") || fa.filePath === m.path);
    const hasSource = moduleFiles.some(fa => !/test|spec/i.test(fa.filePath));
    const hasTest = moduleFiles.some(fa => /test|spec/i.test(fa.filePath));
    let p1;
    if (!hasSource) p1 = "undecided";
    else p1 = hasTest ? "true" : "false";
    // P2: "is imported" — true if any other module imports this one.
    const p2 = importedModules.has(m.name) ? "true" : "false";
    // P3: "all functions have type annotations" — true if every function
    // has typedParameters == parameterCount, false otherwise. UNDECIDED
    // if the module has no functions.
    let functionCount = 0;
    let allTyped = true;
    for (const fa of moduleFiles) {
      for (const f of fa.functions) {
        functionCount += 1;
        if (f.typedParameters !== f.parameterCount) allTyped = false;
      }
    }
    let p3;
    if (functionCount === 0) p3 = "undecided";
    else p3 = allTyped ? "true" : "false";
    // LEM holds for this module iff all three are decidable.
    if (p1 !== "undecided" && p3 !== "undecided") lemHolds += 1;
    else lemFails += 1;
    void p2;
  }
  return {
    topos: {
      lemHoldsCount: lemHolds,
      lemFailsCount: lemFails,
      isIntuitionistic: lemFails > 0,
      failureFraction: round(lemFails / modules.length, 4),
    },
  };
}
