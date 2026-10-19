// src/shared/memory/ebbinghaus.ts
// Canonical Ebbinghaus forgetting-curve + spaced-repetition scoring.
// One owner of the decay math (the old stores had no decay; the user asked
// for an Ebbinghaus score in the metadata). Research: arXiv 2605.08538
// ("interference-based forgetting", "engram maturation") maps to the
// Ebbinghaus retention function R = e^(-t/S).

import type { EbbinghausConfig } from "./memory-config.ts";

/**
 * Ebbinghaus retention strength. R = exp(-elapsedDays * decayPerDay / stability).
 * Stability grows by `reinforcementFactor` on each access (spaced repetition),
 * and gets a small `accessBoost` on read. Clamped to `[floor, 1]`.
 */
export function ebbinghausScore(input: {
  elapsedDays: number;
  stability: number;
  config: EbbinghausConfig;
}): number {
  const { elapsedDays, stability, config } = input;
  if (stability <= 0) return config.floor;
  const raw = Math.exp(-(Math.max(0, elapsedDays) * config.decayPerDay) / stability);
  return Math.max(config.floor, Math.min(1, raw));
}

/**
 * Update stability after an access (reinforcement). Returns the new
 * stability (monotonically grows with reinforcementFactor, bounded to avoid
 * overflow — stability never exceeds ~1e9 days of half-life).
 */
export function reinforceStability(stability: number, config: EbbinghausConfig): number {
  const next = stability * config.reinforcementFactor + config.accessBoost;
  return Math.min(next, 1e9);
}

/**
 * Convert a raw [0,1] Ebbinghaus score into a 0..1 retention rank used for
 * the "prune-lowest-ebbinghaus" token-cap strategy.
 */
export function retentionRank(score: number, floor: number): number {
  if (floor >= 1) return 1;
  return Math.max(0, Math.min(1, (score - floor) / (1 - floor)));
}
