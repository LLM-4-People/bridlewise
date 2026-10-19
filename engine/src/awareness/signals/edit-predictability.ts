/**
 * Game-of-Life edit predictability (EXP224).
 *
 * EXP224 found that a cellular-automaton (Conway's Game of Life) on the
 * edit-history grid predicts the next edit location with 88.9% accuracy.
 * For the awareness signal, we approximate the "edit predictability" by
 * running a single step of Life on the per-file touch-count grid (where
 * each cell = a file, and "alive" = touched in the last commit). The
 * signal emits the predictability score (fraction of cells whose next
 * state matches their current state).
 *
 * For the awareness signal, we compute:
 * - aliveCellCount: number of files touched in the last commit.
 * - predictedAliveNext: predicted number of files touched in the next
 * commit (Life's prediction).
 * - predictability: the fraction of files whose Life-transition matches
 * their long-term touch frequency.
 * - isPredictable: true if predictability > predictabilityThreshold
 * (default 0.6 — EXP224's 88.9% required a richer automaton).
 */
import type { SignalContext } from "../types.ts";
import { round } from "../../shared/numeric-helpers.ts";

export function computeEditPredictability(ctx: SignalContext) {
  if (ctx.gitHistory.length < 2) {
    return { editPredictability: { aliveCellCount: 0, predictedAliveNext: 0, predictability: 0, isPredictable: false } };
  }
  // Build per-file touch count and the most-recent commit's "alive" set.
  const touchCount = new Map<string, number>();
  const lastCommit = ctx.gitHistory[0]!;
  const lastAlive = new Set<string>(lastCommit.changedFiles);
  for (const c of ctx.gitHistory) {
    for (const f of c.changedFiles) {
      touchCount.set(f, (touchCount.get(f) ?? 0) + 1);
    }
  }
  // Build the "neighborhood" — for each file, its directory siblings are
  // its neighbors (Life on a 1D ring of files in the same directory).
  const byDir = new Map<string, Set<string>>();
  for (const f of touchCount.keys()) {
    const dir = f.includes("/") ? f.split("/").slice(0, -1).join("/") : ".";
    if (!byDir.has(dir)) byDir.set(dir, new Set());
    byDir.get(dir)!.add(f);
  }
  // Apply Life rules: a cell stays alive if 2-3 alive neighbors, dies otherwise.
  let aliveNext = 0;
  let matchCount = 0;
  let totalCells = 0;
  for (const [dir, files] of byDir) {
    const fileArr = [...files];
    for (let i = 0; i < fileArr.length; i += 1) {
      const file = fileArr[i]!;
      const alive = lastAlive.has(file);
      // Neighbors: the previous and next file in the same directory.
      const prev = fileArr[i - 1] ?? fileArr[fileArr.length - 1] ?? file;
      const next = fileArr[i + 1] ?? fileArr[0] ?? file;
      const aliveNeighbors = (lastAlive.has(prev) ? 1 : 0) + (lastAlive.has(next) ? 1 : 0);
      let nextAlive;
      if (alive) nextAlive = aliveNeighbors === 2 || aliveNeighbors === 3;
      else nextAlive = aliveNeighbors === 3;
      if (nextAlive) aliveNext += 1;
      // Predictability: does the Life prediction match the touch frequency?
      // A file touched many times should be "alive"; one touched rarely should be "dead".
      const touchFreq = touchCount.get(file) ?? 0;
      const expectedAlive = touchFreq >= 2;
      if (nextAlive === expectedAlive) matchCount += 1;
      totalCells += 1;
    }
    void dir;
  }
  const predictability = totalCells > 0 ? matchCount / totalCells : 0;
  const threshold = ctx.config.thresholds.editPredictabilityThreshold;
  return {
    editPredictability: {
      aliveCellCount: lastAlive.size,
      predictedAliveNext: aliveNext,
      predictability: round(predictability, 4),
      isPredictable: predictability > threshold,
    },
  };
}
