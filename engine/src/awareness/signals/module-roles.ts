/**
 * Module-roles signal: top roles by directory structure.
 *
 * Per the user directive ("NO hardcoded module roles"), the role of a
 * module is the directory NAME (e.g. a directory `parser/` has role
 * "parser"; a directory `traverse/` has role "traverse"). Roles are
 * GROUPED across the codebase: "5 modules named 'parser', 3 named
 * 'util'" — this is the dynamic role distribution.
 *
 * The role is NOT a category from a hardcoded list. It is the literal
 * directory name. The grouping reveals the codebase's vocabulary: a
 * codebase with 10 modules named `util` has a "util-heavy" shape.
 */
import type { SignalContext } from "../types.ts";

export function computeModuleRoles(ctx: SignalContext) {
  const byRole = new Map<string, { moduleCount: number; functionCount: number; lineCount: number }>();
  for (const m of ctx.modules) {
    const role = m.name;
    const e = byRole.get(role) ?? { moduleCount: 0, functionCount: 0, lineCount: 0 };
    e.moduleCount += 1;
    e.functionCount += m.functionCount;
    e.lineCount += m.lineCount;
    byRole.set(role, e);
  }
  const roles = [...byRole.entries()].map(([role, e]) => ({ role, moduleCount: e.moduleCount, functionCount: e.functionCount })).sort((a, b) => b.moduleCount - a.moduleCount || b.functionCount - a.functionCount);
  return {
    moduleRoles: {
      roles: roles.slice(0, ctx.config.topN.topModuleRoles) as readonly Readonly<{ role: string; moduleCount: number; functionCount: number }>[],
    },
  };
}
