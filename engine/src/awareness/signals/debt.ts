/**
 * Ebbinghaus debt signal: technical debt accumulation from git history.
 *
 * EXP202/274 found Ebbinghaus co-edit signals beat FTRL-Drift by +254%
 * on real code. Here we apply the same Ebbinghaus decay to TECHNICAL
 * DEBT markers (TODO/FIXME/HACK/XXX/BUG comments): each marker's debt
 * accrues over time according to its age, with a daily decay rate.
 *
 * Debt is computed as: for each TODO/FIXME comment in the current
 * codebase, debt = ageDays * debtDecayPerDay. The "top debts" are the
 * TODOs in the files that have had the most recent commits (because
 * TODOs in actively-edited files are more likely to be real debt than
 * TODOs in abandoned files).
 *
 * If git is unavailable, debt = 0 (we cannot compute age without
 * history).
 */
import type { SignalContext } from "../types.ts";
import { round } from "../../shared/numeric-helpers.ts";

const DEBT_MARKERS = ["TODO", "FIXME", "HACK", "XXX", "BUG"] as const;
const DEBT_RE = new RegExp(`\\b(${DEBT_MARKERS.join("|")})\\b`, "i");

/** Recent-commit age per file (days). */
function fileAges(ctx: SignalContext): Map<string, number> {
  const out = new Map<string, number>();
  const now = ctx.nowMs;
  for (const c of ctx.gitHistory) {
    for (const f of c.changedFiles) {
      const ageDays = (now - c.timestampMs) / (1000 * 60 * 60 * 24);
      if (!out.has(f) || ageDays < (out.get(f) ?? Number.POSITIVE_INFINITY)) {
        out.set(f, ageDays);
      }
    }
  }
  return out;
}

export function computeDebt(ctx: SignalContext) {
  if (ctx.gitHistory.length === 0 || !ctx.config.useGitHistory) {
    return { debt: { totalDebt: 0, topDebts: [] } };
  }
  const decay = ctx.config.thresholds.debtDecayPerDay;
  const ages = fileAges(ctx);
  const debts: Array<{ filePath: string; ageDays: number; debt: number; kind: string }> = [];
  for (const fa of ctx.fileAnalyses) {
    const health = fa.health;
    if ((health.todo ?? 0) === 0) continue;
    // Find each TODO line.
    const content = ctx.readFile(fa.filePath);
    if (!content) continue;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      const m = DEBT_RE.exec(line);
      if (!m) continue;
      const kind = m[1]!.toUpperCase();
      const ageDays = ages.get(fa.filePath) ?? 0;
      const debt = ageDays * decay;
      debts.push({ filePath: fa.filePath, ageDays: Math.round(ageDays * 10) / 10, debt: round(debt, 3), kind });
    }
  }
  // Top debts — sort by debt desc.
  debts.sort((a, b) => b.debt - a.debt);
  const top = debts.slice(0, ctx.config.topN.topRiskHotspots);
  const totalDebt = debts.reduce((a, b) => a + b.debt, 0);
  return {
    debt: {
      totalDebt: round(totalDebt, 3),
      topDebts: top as readonly Readonly<{ filePath: string; ageDays: number; debt: number; kind: string }>[],
    },
  };
}
