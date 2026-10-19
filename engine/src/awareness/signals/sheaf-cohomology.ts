/**
 * Sheaf cohomology signal (EXP80).
 *
 * EXP80 modeled the codebase as a sheaf: each module is an open set,
 * and the sheaf assigns to each module its set of exported symbols.
 * The symbol sheaf IS a sheaf (H¹ = 0, no obstructions — every local
 * symbol-gluing is globally consistent). dim H⁰ = 1058 (universal
 * functions — symbols that appear in EVERY module). Top: `deepFreeze`
 * flows through 132/169 files (78%) — confirms EXP14's hub finding.
 *
 * For awareness, we approximate the sheaf cohomology:
 * - h0: number of "universal" symbols (exported from >=50% of
 * modules — these flow through everything).
 * - h1: number of "obstructions" (symbols imported in a module but
 * not exported from any module — a broken gluing). For a valid
 * sheaf, h1 = 0.
 * - topUniversalSymbol: the most-occurring universal symbol.
 *
 * The signal emits:
 * - h0Dimension: number of universal symbols.
 * - h1Obstructions: number of broken imports (missing symbols).
 * - isSheaf: true if h1Obstructions === 0 (no broken gluings).
 * - topUniversalSymbol: the symbol that flows through most modules.
 *
 * Actionable: a high h0Dimension = many "universal" helpers (good for
 * consistency, bad for modularity — every module depends on them). A
 * non-zero h1Obstructions = broken imports — fix them.
 *
 * Source: EXP80.
 */
import type { SignalContext } from "../types.ts";
import { moduleOfPath } from "../module-helpers.ts";

export function computeSheafCohomology(ctx: SignalContext) {
  const modules = ctx.modules;
  if (modules.length === 0) {
    return { sheafCohomology: { h0Dimension: 0, h1Obstructions: 0, isSheaf: true, topUniversalSymbol: "", topSymbolReach: 0 } };
  }
  // Build module → set of exported symbols.
  const moduleExports = new Map<string, Set<string>>();
  const moduleOf = (filePath: string): string | null => moduleOfPath(filePath, modules);
  for (const m of modules) moduleExports.set(m.path, new Set());
  for (const fa of ctx.fileAnalyses) {
    const mod = moduleOf(fa.filePath);
    if (!mod) continue;
    for (const exp of fa.exports) {
      if (!exp.isDefault) moduleExports.get(mod)!.add(exp.name);
    }
  }
  // h0 = symbols exported from >= 50% of modules.
  const symbolCount = new Map<string, number>();
  for (const syms of moduleExports.values()) {
    for (const s of syms) symbolCount.set(s, (symbolCount.get(s) ?? 0) + 1);
  }
  const threshold = modules.length / 2;
  let h0 = 0;
  let topSymbol = "";
  let topCount = 0;
  for (const [s, c] of symbolCount) {
    if (c >= threshold) h0 += 1;
    if (c > topCount) { topCount = c; topSymbol = s; }
  }
  // h1 = number of imports whose target symbol is NOT exported from any
  // module (a broken sheaf gluing — the symbol doesn't exist locally).
  // Approximate: imports whose resolvedPath is null AND specifier is
  // intra-codebase (starts with./ or../).
  let h1 = 0;
  for (const fa of ctx.fileAnalyses) {
    for (const imp of fa.imports) {
      if (imp.resolvedPath === null && (imp.specifier.startsWith("./") || imp.specifier.startsWith("../"))) {
        h1 += 1;
      }
    }
  }
  return {
    sheafCohomology: {
      h0Dimension: h0,
      h1Obstructions: h1,
      isSheaf: h1 === 0,
      topUniversalSymbol: topSymbol,
      topSymbolReach: topCount,
    },
  };
}
