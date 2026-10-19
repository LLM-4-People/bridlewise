/**
 * Unified auxiliary modules aggregator.
 *
 * Bundles the four auxiliary modules that support the core (search,
 * editor, memory):
 * - awareness (EXP387: 44 signals, real-time, multi-language, dynamic)
 * - quality (EXP386: 23 checks, multi-language, scoring, monitoring)
 * - safety (EXP354/388/380/408: hallucination + bias + bandaid, all gates strong)
 * - learning (EXP389: multi-cause, generalization, self-improving, 0 LLM)
 *
 * Each module registers its signals / actions / customizations with the
 * shared exposure system (`src/shared/exposure/`), so any consumer reads
 * them via one canonical API. Per binding directive: "Expose as many
 * signals, actions and customization as possible."
 *
 * This file is the public entry point. It does not own any logic; it
 * composes the modules and re-exports their public APIs.
 *
 * UNIFIED API (EXP470): the re-exports below use the unified exposure
 * verbs (executeAction, getCustomizationValue, setCustomizationValue,
 * resetCustomizationValue). The previously-fragmented A.2 verbs
 * (invokeAction, readCustomization, writeCustomization, resetCustomization)
 * are gone — there is exactly ONE verb per operation.
 */

import {
  listSignals,
  countSignals,
  clearSignals,
  type Signal,
} from "../shared/exposure/signal.ts";
import {
  listActions,
  countActions,
  clearActions,
  type Action,
} from "../shared/exposure/action.ts";
import {
  listCustomizations,
  countCustomizations,
  clearCustomizations,
  type Customization,
} from "../shared/exposure/customization.ts";

// Re-export the module public APIs. `safety` has no barrel index; its
// surface is reached via the shared exposure registrations + per-file imports.
//
// `learning` is deliberately NOT re-exported here. The auto-learning code
// lives under `_experiments/`, which every repository scan excludes, so a
// value re-export from this barrel made production depend on a directory the
// scan universe cannot see — the manifest recorded the edge while every guard
// derived from the exclusions was silently short by it. Nothing consumed the
// namespace (its only importer takes the four exposure helpers below), and
// the auto-learning tests import the experiment directly. If auto-learning is
// ever confirmed as product code, it moves under `src/` first and is
// re-exported from there; a barrel is not the place to promote an experiment.
export * as awareness from "../awareness/config.ts";
export * as quality from "../quality/index.ts";

// Re-export the shared exposure primitives (UNIFIED verbs, EXP470).
export {
  registerSignal,
  getSignal,
  readSignal,
  listSignals,
  countSignals,
  listSignalsByModule,
  clearSignals,
  type Signal,
} from "../shared/exposure/signal.ts";
export {
  registerAction,
  getAction,
  executeAction,
  listActions,
  countActions,
  listActionsByModule,
  clearActions,
  type Action,
} from "../shared/exposure/action.ts";
export {
  registerCustomization,
  getCustomization,
  getCustomizationValue,
  setCustomizationValue,
  resetCustomizationValue,
  listCustomizations,
  countCustomizations,
  listCustomizationsByModule,
  clearCustomizations,
  makeNumberCustomization,
  makeStringCustomization,
  makeBooleanCustomization,
  makeEnumCustomization,
  makeObjectCustomization,
  type Customization,
} from "../shared/exposure/customization.ts";

/** Snapshot of the entire exposure registry. */
export type ExposureSnapshot = Readonly<{
  signals: readonly Signal[];
  actions: readonly Action[];
  customizations: readonly Customization[];
}>;

/** Snapshot the whole exposure registry at the current moment. */
export function snapshotExposure(): ExposureSnapshot {
  return {
    signals: listSignals(),
    actions: listActions(),
    customizations: listCustomizations(),
  };
}

/** Reset the entire exposure registry (test-only). */
export function resetExposure(): void {
  clearSignals();
  clearActions();
  clearCustomizations();
}

/** Total exposed items across signals, actions, customizations. */
export function totalExposedItems(): number {
  return countSignals() + countActions() + countCustomizations();
}

/** List of every module that has registered at least one signal/action/customization. */
export function listExposedModules(): readonly string[] {
  const set = new Set<string>();
  for (const s of listSignals()) set.add(s.module);
  for (const a of listActions()) set.add(a.module);
  for (const c of listCustomizations()) set.add(c.module);
  return Array.from(set).sort();
}
