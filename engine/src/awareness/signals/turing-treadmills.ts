/**
 * Turing-machine treadmills signal (EXP326).
 *
 * EXP326 modeled the codebase as a Turing machine and found 13
 * "treadmills" — functions refactored >3× without settling. The top
 * treadmill = buildConfigContract (19 refactors), 3 still active:
 * streamChatCompletionWithOptions (8×), createPreflightContext (5×).
 * The TM model PREDICTS they'll NEVER settle — the Halting Problem
 * applies to refactoring.
 *
 * For awareness, we approximate treadmills via the git-history: a
 * treadmill = a file edited in 4+ of the last N commits (suggesting
 * it's in an unstable state — the team keeps revisiting it).
 *
 * The signal emits:
 * - treadmillCount: number of files edited in 4+ commits.
 * - topTreadmills: top-5 files by edit frequency.
 * - maxTreadmillCount: the highest edit count for any file.
 * - hasActiveTreadmills: true if treadmillCount > 0.
 *
 * Actionable: topTreadmills are functions/files the team keeps
 * revisiting — they likely have an underlying design issue (per
 * EXP326, the TM model predicts they'll never settle — stop
 * refactoring them and reconsider the design).
 *
 * Source: EXP326.
 */
import type { SignalContext } from "../types.ts";

export function computeTuringTreadmills(ctx: SignalContext) {
  const commits = ctx.gitHistory;
  if (commits.length < 4) {
    return { turingTreadmills: { treadmillCount: 0, topTreadmills: [], maxTreadmillCount: 0, hasActiveTreadmills: false } };
  }
  const editCount = new Map<string, number>();
  for (const c of commits) {
    for (const f of c.changedFiles) {
      editCount.set(f, (editCount.get(f) ?? 0) + 1);
    }
  }
  const threshold = ctx.config.thresholds.treadmillCommitThreshold;
  const treadmills = [...editCount.entries()]
    .filter(([, count]) => count >= threshold)
    .sort((a, b) => b[1] - a[1]);
  const topTreadmills = treadmills.slice(0, 5).map(([file, count]) => ({ filePath: file, editCount: count }));
  const maxCount = treadmills.length > 0 ? treadmills[0]![1] : 0;
  return {
    turingTreadmills: {
      treadmillCount: treadmills.length,
      topTreadmills,
      maxTreadmillCount: maxCount,
      hasActiveTreadmills: treadmills.length > 0,
    },
  };
}
