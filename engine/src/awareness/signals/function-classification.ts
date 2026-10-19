/**
 * Function classification signal (EXP102).
 *
 * EXP102 classified 2559 src/ functions on 4 axes (complexity, clone-
 * type, role, risk): 22% simple, 51% medium, 17% complex, 9%
 * pathological. 85% no-clone, 2.6% Type-1 (exact), 8.6% Type-2
 * (normalized), 4.2% Type-3 (structural). 62% utility, 20% data-
 * transform, 9% error-handler, 9% other. 36% low-risk, 61% medium,
 * 2.3% high.
 *
 * For awareness, we approximate the classification using a 2-axis
 * scheme: (complexity bucket, role bucket). The complexity bucket is
 * derived from each function's cyclomatic complexity; the role bucket
 * is a heuristic based on the function name (handler/parser/validator/
 * utility/getter/setter/main).
 *
 * The signal emits:
 * - complexityBuckets: { simple, medium, complex, pathological } counts.
 * - roleBuckets: { utility, dataTransform, errorHandler, validator, other }.
 * - riskBuckets: { low, medium, high } (high = complex AND high call count).
 * - pathologicalFraction: % of functions that are pathological.
 *
 * Actionable: pathologicalFraction > 0.1 = the codebase has many
 * unmaintainable functions — review the top-complex list.
 *
 * Source: EXP102.
 */
import type { SignalContext } from "../types.ts";
import { round } from "../../shared/numeric-helpers.ts";

export function computeFunctionClassification(ctx: SignalContext) {
  const allFns = ctx.fileAnalyses.flatMap(fa => fa.functions);
  if (allFns.length === 0) {
    return {
      functionClassification: {
        complexityBuckets: { simple: 0, medium: 0, complex: 0, pathological: 0 },
        roleBuckets: { utility: 0, dataTransform: 0, errorHandler: 0, validator: 0, other: 0 },
        riskBuckets: { low: 0, medium: 0, high: 0 },
        pathologicalFraction: 0,
      },
    };
  }
  // Complexity buckets.
  const complexityBuckets = { simple: 0, medium: 0, complex: 0, pathological: 0 };
  for (const f of allFns) {
    if (f.complexity <= 1) complexityBuckets.simple += 1;
    else if (f.complexity <= 5) complexityBuckets.medium += 1;
    else if (f.complexity <= 15) complexityBuckets.complex += 1;
    else complexityBuckets.pathological += 1;
  }
  // Role buckets via name heuristic.
  const roleBuckets = { utility: 0, dataTransform: 0, errorHandler: 0, validator: 0, other: 0 };
  for (const f of allFns) {
    const n = f.name.toLowerCase();
    if (/^(handle|on|process|run|do|exec|perform|apply)/.test(n)) roleBuckets.dataTransform += 1;
    else if (/^(error|fail|throw|catch|recover|fallback|raise)/.test(n)) roleBuckets.errorHandler += 1;
    else if (/^(is|has|can|should|validate|check|verify|assert|guard)/.test(n)) roleBuckets.validator += 1;
    else if (/^(get|set|make|create|build|init|new|from|of|to|map|filter|reduce|find)/.test(n)) roleBuckets.utility += 1;
    else roleBuckets.other += 1;
  }
  // Risk buckets: high = pathological AND high call count.
  // Call count is not in the snapshot — approximate with parameter count
  // (more parameters = more likely to be called widely = higher blast
  // radius).
  const riskBuckets = { low: 0, medium: 0, high: 0 };
  for (const f of allFns) {
    if (f.complexity > 15 && f.parameterCount >= 3) riskBuckets.high += 1;
    else if (f.complexity > 5) riskBuckets.medium += 1;
    else riskBuckets.low += 1;
  }
  const pathologicalFraction = round(complexityBuckets.pathological / allFns.length, 4);
  return {
    functionClassification: {
      complexityBuckets,
      roleBuckets,
      riskBuckets,
      pathologicalFraction,
    },
  };
}
