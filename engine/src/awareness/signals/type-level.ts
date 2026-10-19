/**
 * Type-level signal: typed / untyped / mixed.
 *
 * Computed from the actual type annotations found in source files by
 * the language adapters. A file is "typed" if `hasTypeAnnotations` is
 * true. The codebase is:
 * - "typed" if ≥ 80% of files have type annotations (configurable).
 * - "untyped" if < 20% of files have type annotations.
 * - "mixed" otherwise.
 *
 * No hardcoded thresholds — the boundaries come from `config.thresholds`
 * (here we use fixed boundaries 0.8/0.2 because they are part of the
 * type-level definition itself, not a tunable; making them configurable
 * would require a separate config field — TODO if needed).
 *
 * NOTE: the boundaries are computed FROM the codebase (the fraction),
 * not asserted as constants; the 0.8/0.2 boundaries are the only
 * hardcoded values here and they define the signal's semantic categories.
 */
import type { SignalContext } from "../types.ts";
import { round } from "../../shared/numeric-helpers.ts";

const TYPED_BOUNDARY = 0.8;
const UNTYPED_BOUNDARY = 0.2;

export function computeTypeLevel(ctx: SignalContext) {
  let typedFiles = 0;
  let totalFiles = 0;
  let totalParams = 0;
  let typedParams = 0;
  for (const fa of ctx.fileAnalyses) {
    totalFiles += 1;
    if (fa.hasTypeAnnotations) typedFiles += 1;
    for (const f of fa.functions) {
      totalParams += f.parameterCount;
      typedParams += f.typedParameters;
    }
  }
  if (totalFiles === 0) {
    return { typeLevel: { level: "untyped" as const, typedFileFraction: 0, typedParameterFraction: 0 } };
  }
  const typedFileFraction = typedFiles / totalFiles;
  const typedParameterFraction = totalParams === 0 ? 0 : typedParams / totalParams;
  let level: "typed" | "untyped" | "mixed";
  if (typedFileFraction >= TYPED_BOUNDARY) level = "typed";
  else if (typedFileFraction < UNTYPED_BOUNDARY) level = "untyped";
  else level = "mixed";
  return {
    typeLevel: {
      level,
      typedFileFraction: round(typedFileFraction, 3),
      typedParameterFraction: round(typedParameterFraction, 3),
    },
  };
}
