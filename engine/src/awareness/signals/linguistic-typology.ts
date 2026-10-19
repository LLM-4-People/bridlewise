/**
 * Linguistic typology signal (EXP223).
 *
 * EXP223 classified functions into language families (imperative,
 * functional, declarative, async): src/ is 13% imperative, 37%
 * functional, 7% declarative, 2% async. Cross-family normalization
 * (for-i/for-of/forEach/map → canonical ITERATE) is a strict superset
 * of baseline (V4 4/9 → 6/9 +N1 +N6).
 *
 * For awareness, we approximate the typology using a token-shape
 * heuristic per function:
 * - imperative: contains `for`, `while`, `if`, `return`, assignment
 * - functional: contains `map`, `filter`, `reduce`, `=>`, `forEach`
 * - declarative: contains `type`, `interface`, `enum`, `struct`,
 * `class` declarations (mostly type definitions, not bodies)
 * - async: contains `async`, `await`, `then`, `Promise`
 *
 * The signal emits:
 * - familyDistribution: { imperative, functional, declarative, async }.
 * - dominantFamily: the most-common family.
 * - multiParadigm: true if no family has > 60% (the codebase uses
 * multiple paradigms).
 * - functionalFraction: fraction of functional-style functions.
 *
 * Actionable: a multi-paradigm codebase needs cross-family
 * normalization (EXP223); a single-paradigm codebase is easier to
 * reason about with one canonical form.
 *
 * Source: EXP223.
 */
import type { SignalContext } from "../types.ts";
import { round } from "../../shared/numeric-helpers.ts";

export function computeLinguisticTypology(ctx: SignalContext) {
  const allFns = ctx.fileAnalyses.flatMap(fa => fa.functions);
  if (allFns.length === 0) {
    return { linguisticTypology: { familyDistribution: { imperative: 0, functional: 0, declarative: 0, async: 0 }, dominantFamily: "none", multiParadigm: false, functionalFraction: 0, asyncFraction: 0 } };
  }
  const family = { imperative: 0, functional: 0, declarative: 0, async: 0 };
  for (const f of allFns) {
    const tokens = new Set(f.tokens.map(t => t.toLowerCase()));
    let isAsync = tokens.has("async") || tokens.has("await") || tokens.has("promise") || tokens.has("then");
    let isFunctional = tokens.has("map") || tokens.has("filter") || tokens.has("reduce") || tokens.has("foreach") || tokens.has("=>") || tokens.has("arrow");
    let isImperative = tokens.has("for") || tokens.has("while") || tokens.has("if") || tokens.has("return") || tokens.has("loop") || tokens.has("mut") || tokens.has("let");
    let isDeclarative = tokens.has("type") || tokens.has("interface") || tokens.has("enum") || tokens.has("struct") || tokens.has("class") || tokens.has("type_alias");
    // Classify by priority: async > functional > imperative > declarative.
    if (isAsync) family.async += 1;
    else if (isFunctional) family.functional += 1;
    else if (isImperative) family.imperative += 1;
    else if (isDeclarative) family.declarative += 1;
    else family.imperative += 1; // default = imperative (simplest)
  }
  const dominant = Object.entries(family).sort((a, b) => b[1] - a[1])[0]![0];
  const maxFrac = family[dominant as keyof typeof family] / allFns.length;
  const functionalFraction = round(family.functional / allFns.length, 4);
  return {
    linguisticTypology: {
      familyDistribution: family,
      dominantFamily: dominant,
      multiParadigm: maxFrac < 0.6,
      functionalFraction,
      asyncFraction: round(family.async / allFns.length, 4),
    },
  };
}
