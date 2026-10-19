/**
 * Persistence landscapes (EXP249).
 *
 * EXP249 found that the topological persistence of code patterns (the
 * "lifetime" of features in a filtration of the complexity distribution)
 * is a stable signature of the codebase's shape. For the awareness
 * signal, we approximate the persistence landscape by computing a
 * "persistence diagram" of the complexity distribution: each function
 * is a point (birth, death) = (line, complexity). The persistence of a
 * point is death - birth. The landscape is the sorted list of
 * persistences (the Betti-0 barcode of the sublevel-set filtration).
 *
 * The signal emits:
 * - meanPersistence: average persistence.
 * - maxPersistence: longest-lived feature.
 * - landscapePeak: the maximum value of the 1st-landscape function.
 * - bettiNumbers: a 3-element array [β0, β1, β2] approximated by counting
 * "components" (connected functions by line), "loops" (functions with
 * high complexity at the same line), and "voids" (very high complexity
 * functions isolated from their neighbors).
 */
import type { SignalContext } from "../types.ts";
import { round } from "../../shared/numeric-helpers.ts";

export function computePersistenceLandscapes(ctx: SignalContext) {
  const fns = ctx.fileAnalyses.flatMap(fa => fa.functions);
  if (fns.length === 0) {
    return { persistenceLandscapes: { meanPersistence: 0, maxPersistence: 0, landscapePeak: 0, bettiNumbers: [0, 0, 0] } };
  }
  // Sort by line, then by complexity.
  const points = fns.map(f => ({ birth: f.line, death: f.line + f.bodyLines, complexity: f.complexity }));
  points.sort((a, b) => a.birth - b.birth);
  const persistences = points.map(p => Math.max(0, p.death - p.birth));
  const mean = persistences.reduce((a, b) => a + b, 0) / persistences.length;
  const max = persistences.length > 0 ? Math.max(...persistences) : 0;
  // Landscape peak: the maximum count of overlapping intervals at any line.
  let peak = 0;
  let active = 0;
  const events: Array<{ line: number; delta: number }> = [];
  for (const p of points) {
    events.push({ line: p.birth, delta: 1 });
    events.push({ line: p.death, delta: -1 });
  }
  events.sort((a, b) => a.line - b.line || b.delta - a.delta);
  for (const e of events) {
    active += e.delta;
    if (active > peak) peak = active;
  }
  // Betti numbers (very rough approximation):
  // β0 = number of connected components (each file is a component).
  const fileSet = new Set<string>();
  for (const fa of ctx.fileAnalyses) fileSet.add(fa.filePath);
  const beta0 = fileSet.size;
  // β1 = number of "loops" — functions whose complexity is high enough to
  // potentially loop back. Approximate by counting functions with body
  // length > 50 AND complexity > 10 (these are large enough to "loop").
  let beta1 = 0;
  for (const f of fns) {
    if (f.bodyLines > 50 && f.complexity > 10) beta1 += 1;
  }
  // β2 = "voids" — very high complexity functions isolated (large + complex
  // but with few callers). Approximate by counting functions with complexity
  // > 50.
  let beta2 = 0;
  for (const f of fns) {
    if (f.complexity > 50) beta2 += 1;
  }
  return {
    persistenceLandscapes: {
      meanPersistence: round(mean, 2),
      maxPersistence: max,
      landscapePeak: peak,
      bettiNumbers: [beta0, beta1, beta2],
    },
  };
}
