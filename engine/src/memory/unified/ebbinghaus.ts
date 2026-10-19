/**
 * Ebbinghaus forgetting curve + FSRS-4 reinforcement (from EXP202/353/418).
 *
 * Retention: R(t) = e^(-t/S), where t = turns since last access, S = strength.
 * FSRS-4: S_new = S * (1 + (1 - R) * g(n)), where g(n) = a * n^(-0.5) + 0.1.
 * Accessed memories get stronger; non-accessed memories decay.
 *
 * Fading boost: entries with R < 0.5 get a +0.15 retrieval-score boost
 * (reinforce-the-fading signal from EXP353).
 *
 * Pruning: entries with R < pruneThreshold are pruned — EXCEPT kind="fact"
 * entries, which are persistent anchors.
 */
import { deepFreeze } from "../../kernel/integrity.ts";
import { InputError } from "../../kernel/errors.ts";

export type EbbinghausConfig = Readonly<{
  /** Initial strength S. */
  stabilityInitial: number;
  /** FSRS-4 reinforcement gain (S grows by this factor on access). */
  decayReinforceGain: number;
  /** R < this threshold → entry is pruned. */
  pruneThreshold: number;
  /** R < 0.5 → +fadingBoost in retrieval score. */
  fadingBoost: number;
  /** R < fadingThreshold → apply fading boost. */
  fadingThreshold: number;
}>;

/**
 * Module-private: `resolveEbbinghausConfig` below is the resolver and the only
 * correct reader. Ask `resolveEbbinghausConfig()` for the defaulted document.
 */
const DEFAULT_EBBINGHAUS_CONFIG: EbbinghausConfig = deepFreeze({
  stabilityInitial: 1.5,
  decayReinforceGain: 1.0,
  pruneThreshold: 0.05,
  fadingBoost: 0.15,
  fadingThreshold: 0.5,
});

export function resolveEbbinghausConfig(overrides: Partial<EbbinghausConfig> = {}): EbbinghausConfig {
  const cfg: EbbinghausConfig = {
    stabilityInitial: overrides.stabilityInitial ?? DEFAULT_EBBINGHAUS_CONFIG.stabilityInitial,
    decayReinforceGain: overrides.decayReinforceGain ?? DEFAULT_EBBINGHAUS_CONFIG.decayReinforceGain,
    pruneThreshold: overrides.pruneThreshold ?? DEFAULT_EBBINGHAUS_CONFIG.pruneThreshold,
    fadingBoost: overrides.fadingBoost ?? DEFAULT_EBBINGHAUS_CONFIG.fadingBoost,
    fadingThreshold: overrides.fadingThreshold ?? DEFAULT_EBBINGHAUS_CONFIG.fadingThreshold,
  };
  if (cfg.stabilityInitial <= 0 || !Number.isFinite(cfg.stabilityInitial)) {
    throw new InputError("ebbinghaus.stabilityInitial must be a positive finite number");
  }
  if (cfg.decayReinforceGain <= 0 || !Number.isFinite(cfg.decayReinforceGain)) {
    throw new InputError("ebbinghaus.decayReinforceGain must be a positive finite number");
  }
  if (cfg.pruneThreshold < 0 || cfg.pruneThreshold > 1 || !Number.isFinite(cfg.pruneThreshold)) {
    throw new InputError("ebbinghaus.pruneThreshold must be in [0, 1]");
  }
  if (cfg.fadingBoost < 0 || !Number.isFinite(cfg.fadingBoost)) {
    throw new InputError("ebbinghaus.fadingBoost must be a non-negative finite number");
  }
  if (cfg.fadingThreshold < 0 || cfg.fadingThreshold > 1 || !Number.isFinite(cfg.fadingThreshold)) {
    throw new InputError("ebbinghaus.fadingThreshold must be in [0, 1]");
  }
  return deepFreeze(cfg) as EbbinghausConfig;
}

/**
 * Compute Ebbinghaus retention R(t) = e^(-t/S).
 * `t` = turns since last access. `strength` = S.
 */
export function retention(turnsSinceAccess: number, strength: number): number {
  if (turnsSinceAccess <= 0) return 1;
  const s = Math.max(0.001, strength);
  return Math.exp(-turnsSinceAccess / s);
}

/**
 * FSRS-4 reinforcement. Returns the new strength.
 * `n` = access count. `gain` = decayReinforceGain.
 */
export function reinforce(
  strength: number,
  accessCount: number,
  retentionValue: number,
  gain: number,
): number {
  const n = Math.max(1, accessCount);
  const g = gain * Math.pow(n, -0.5) + 0.1;
  return strength * (1 + (1 - retentionValue) * g);
}

/** Apply fading boost to a score. */
export function applyFadingBoost(
  score: number,
  retentionValue: number,
  config: EbbinghausConfig,
): number {
  if (retentionValue < config.fadingThreshold) {
    return score + config.fadingBoost;
  }
  return score;
}

/** Whether an entry should be pruned (R < pruneThreshold) and is not a fact. */
export function shouldPrune(
  retentionValue: number,
  config: EbbinghausConfig,
  isFact: boolean,
): boolean {
  if (isFact) return false;
  return retentionValue < config.pruneThreshold;
}
