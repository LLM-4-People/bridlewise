/**
 * Hotspots signal: top complex functions + top depended-on modules.
 *
 * Aggregates from the complexity + architecture signals. The "top
 * complex" functions are the highest-complexity functions in the
 * codebase. The "top depended-on" modules are the modules with the
 * highest in-degree (most other modules import them).
 */
import type { SignalContext, ModuleRecord, FunctionRecord } from "../types.ts";

export function computeHotspots(_ctx: SignalContext, prior: { complexity?: { topFunctions: readonly FunctionRecord[] } | null; architecture?: { hubModules: readonly ModuleRecord[] } | null }) {
  const topComplex = prior.complexity?.topFunctions ?? [];
  const topDependedOn = (prior.architecture?.hubModules ?? []).slice().sort((a, b) => b.inDegree - a.inDegree);
  return {
    hotspots: {
      topComplex: topComplex as readonly FunctionRecord[],
      topDependedOn: topDependedOn as readonly ModuleRecord[],
    },
  };
}
