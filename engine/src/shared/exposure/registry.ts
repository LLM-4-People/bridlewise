/**
 * Shared exposure system — central registry facade.
 *
 * This file is the SINGLE SOURCE OF TRUTH for exposure. It composes the
 * three primitives (Signal, Action, Customization) into one registry so
 * consumers import one module — `src/shared/exposure/` — and reach every
 * signal, action, and customization in the harness.
 *
 * ALL modules register through here. There is no parallel ad-hoc exposure
 * surface; the register/get functions in `signal.ts`, `action.ts`, and
 * `customization.ts` are the only entry points.
 *
 * The registry is process-global and lives for the lifetime of the harness.
 * It is intentionally NOT frozen: modules register on construction and
 * consumers read at any later time.
 */

import {
  clearActions,
  countActions,
  getAction,
  listActions,
  listActionsByModule,
  registerAction,
  unregisterAction,
  executeAction,
} from "./action.ts";
import {
  clearCustomizations,
  countCustomizations,
  getCustomization,
  getCustomizationValue,
  listCustomizations,
  listCustomizationsByModule,
  registerCustomization,
  resetCustomizationValue,
  setCustomizationValue,
  unregisterCustomization,
} from "./customization.ts";
import {
  clearSignals,
  countSignals,
  getSignal,
  listSignals,
  listSignalsByModule,
  readSignal,
  registerSignal,
  unregisterSignal,
} from "./signal.ts";
import {
  clearExposureModules,
  countExposureModules,
  getExposureModule,
  listExposureModules,
  registerExposureModule,
  unregisterExposureModule,
} from "./module.ts";
import type { Action } from "./action.ts";
import type { Customization } from "./customization.ts";
import type { Signal } from "./signal.ts";

/** The central registry — single import for all exposure primitives. */
export const exposureRegistry = {
  // signals
  registerSignal,
  getSignal,
  readSignal,
  listSignals,
  listSignalsByModule,
  countSignals,
  unregisterSignal,
  clearSignals,
  // actions
  registerAction,
  getAction,
  executeAction,
  listActions,
  listActionsByModule,
  countActions,
  unregisterAction,
  clearActions,
  // customizations
  registerCustomization,
  getCustomization,
  getCustomizationValue,
  setCustomizationValue,
  resetCustomizationValue,
  listCustomizations,
  listCustomizationsByModule,
  countCustomizations,
  unregisterCustomization,
  clearCustomizations,
  // module declarations (the category primitive)
  registerExposureModule,
  getExposureModule,
  listExposureModules,
  countExposureModules,
  unregisterExposureModule,
  clearExposureModules,
} as const;

/** Total number of registered items (signals + actions + customizations). */
export function countAll(): number {
  return countSignals() + countActions() + countCustomizations();
}

/** True when an id is registered under any primitive. */
export function isRegistered(id: string): boolean {
  return getSignal(id) !== undefined
      || getAction(id) !== undefined
      || getCustomization(id) !== undefined;
}

/** Clear ALL exposure primitives (test/reset hook only). */
export function clearAll(): void {
  clearSignals();
  clearActions();
  clearCustomizations();
  // The MODULE declarations are part of the surface, not decoration around
  // it: a reset that left them standing would let a suite that re-registers
  // one module see the categories of every module it did NOT register.
  clearExposureModules();
}

// Re-export the primitive types so consumers can import everything from
// `src/shared/exposure/registry.ts` if they prefer a single import.
export type { Action, ActionArg } from "./action.ts";
export type { Customization, CustomizationType } from "./customization.ts";
export type { Signal, SignalArg, SignalType } from "./signal.ts";

/** Snapshot of all three primitives (registration order preserved). */
export type ExposureSnapshot = Readonly<{
  signals: readonly Signal[];
  actions: readonly Action[];
  customizations: readonly Customization[];
  counts: Readonly<{ signals: number; actions: number; customizations: number; total: number }>;
}>;

/** Take an immutable snapshot of the entire exposure surface. */
export function snapshot(): ExposureSnapshot {
  const signals = listSignals();
  const actions = listActions();
  const customizations = listCustomizations();
  return Object.freeze({
    signals,
    actions,
    customizations,
    counts: Object.freeze({
      signals: signals.length,
      actions: actions.length,
      customizations: customizations.length,
      total: signals.length + actions.length + customizations.length,
    }),
  }) as ExposureSnapshot;
}
