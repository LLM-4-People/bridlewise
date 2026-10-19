/**
 * Health signal: TODO/FIXME count, empty-catch count, magic-number count,
 * and dead-export count (exports never imported by any file).
 *
 * Aggregates per-file health counts from the language adapters and
 * computes the dead-export count via a workspace-aware import graph
 * (reuses the technique from EXP349's quality pack).
 */
import type { SignalContext } from "../types.ts";

export function computeHealth(ctx: SignalContext) {
  let todo = 0;
  let emptyCatch = 0;
  let magicNumber = 0;
  for (const fa of ctx.fileAnalyses) {
    const h = fa.health;
    todo += h.todo ?? 0;
    emptyCatch += h.emptyCatch ?? 0;
    magicNumber += h.magicNumber ?? 0;
  }
  // Dead exports: exports never imported by any file (intra-codebase).
  const importedNames = new Set<string>();
  for (const fa of ctx.fileAnalyses) {
    for (const imp of fa.imports) {
      for (const n of imp.importedNames) importedNames.add(n);
    }
  }
  let deadExport = 0;
  for (const fa of ctx.fileAnalyses) {
    for (const e of fa.exports) {
      if (!importedNames.has(e.name)) deadExport += 1;
    }
  }
  return {
    health: {
      todoCount: todo,
      emptyCatchCount: emptyCatch,
      magicNumberCount: magicNumber,
      deadExportCount: deadExport,
      total: todo + emptyCatch + magicNumber + deadExport,
    },
  };
}
