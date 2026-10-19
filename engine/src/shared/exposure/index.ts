/**
 * Shared exposure system — public API barrel (UNIFIED, EXP470).
 *
 * This is the SINGLE import path for everything related to exposing
 * signals, actions, and customizations off any module:
 *
 * ```ts
 * import {
 * registerSignal, readSignal, getSignal, defineSignal, defineCounter,
 * registerAction, executeAction, getAction, defineAction,
 * registerCustomization, getCustomizationValue, setCustomizationValue,
 * resetCustomizationValue, defineNumber, makeNumberCustomization,
 * reportAll, reportJson, countAll,
 * } from "../shared/exposure/index.ts";
 * ```
 *
 * UNIFIED API (EXP470): the three previously-fragmented exposure families are
 * merged into ONE source of truth:
 * - A.1 (register/readSignal, register/executeAction,
 * register/getCustomizationValue/setCustomizationValue) — canonical verbs.
 * - B (defineSignal/defineCounter/defineGauge/defineState, defineAction,
 * defineNumber/defineString/defineBoolean/defineEnum/defineObject) —
 * positional ergonomics, thin wrappers over the canonical registers.
 * - A.2 (resetCustomizationValue, makeNumberCustomization/makeBooleanCustomization/
 * makeStringCustomization/makeEnumCustomization/makeObjectCustomization) —
 * reset operation + self-contained builders.
 *
 * There is exactly ONE verb per operation. No parallel ad-hoc exposure
 * surface remains. The register/get functions in `signal.ts`, `action.ts`,
 * and `customization.ts` are the only entry points.
 *
 * The barrel is split across six files for clarity:
 *
 * - `signal.ts` — Signal type + register/get/read + define ergonomics.
 * - `action.ts` — Action type + register/get/execute + define ergonomics.
 * - `customization.ts` — Customization type + register/get/set/reset + define/make helpers.
 * - `registry.ts` — central registry facade + snapshot.
 * - `reporter.ts` — Markdown/JSON reports for docs + the LLM.
 * - `index.ts` — this file (public re-exports only).
 */

// signal.ts
export {
  SIGNAL_TYPES,
  NUMERIC_SIGNAL_TYPES,
  validateSignalAbnormal,
  registerSignal,
  getSignal,
  readSignal,
  listSignals,
  listSignalsByModule,
  countSignals,
  unregisterSignal,
  clearSignals,
  defineSignal,
  defineCounter,
  defineGauge,
  defineState,
} from "./signal.ts";
export type { Signal, SignalType, SignalArg, SignalExtra, SignalAbnormal } from "./signal.ts";

// action.ts
export {
  registerAction,
  getAction,
  executeAction,
  listActions,
  listActionsByModule,
  countActions,
  unregisterAction,
  clearActions,
  defineAction,
  optionalStringArg,
} from "./action.ts";
export type { Action, ActionArg, ActionResult } from "./action.ts";

// customization.ts
export {
  CUSTOMIZATION_TYPES,
  registerCustomization,
  getCustomization,
  getCustomizationValue,
  setCustomizationValue,
  resetCustomizationValue,
  listCustomizations,
  listCustomizationsByModule,
  listCustomizationsMeasuredBy,
  countCustomizations,
  unregisterCustomization,
  clearCustomizations,
  makeNumberCustomization,
  makeStringCustomization,
  makeBooleanCustomization,
  makeEnumCustomization,
  makeObjectCustomization,
  defineNumber,
  defineString,
  defineBoolean,
  defineEnum,
  defineObject,
  schemaBounds,
} from "./customization.ts";
export type {
  Customization,
  CustomizationType,
  CustomizationValue,
  NumberRange,
} from "./customization.ts";

// registry.ts
export {
  exposureRegistry,
  countAll,
  isRegistered,
  clearAll,
  snapshot,
} from "./registry.ts";
export type { ExposureSnapshot } from "./registry.ts";

// reporter.ts
export {
  reportAll,
  reportSignals,
  reportActions,
  reportCustomizations,
  reportJson,
  // Contract-metadata adoption, as a number. Re-exported here because the
  // barrel is the SINGLE public import path: a reporter export missing from
  // it is unreachable by any consumer, so the coverage the reporter computes
  // could only ever be read by embedding it in a JSON blob and re-parsing it.
  contractCoverage,
} from "./reporter.ts";

// ---------------------------------------------------------------------------
// Composition helpers over the three primitives. These are thin wrappers so
// consumers import a single surface from the barrel instead of re-composing
// `list*ByModule` + `clearAll` at every call site. `snapshotExposure(module?)`
// returns a filtered snapshot (whole registry when `module` is omitted);
// `resetExposureForTest` clears the registry (test-only reset).
// ---------------------------------------------------------------------------

import { listSignals, listSignalsByModule } from "./signal.ts";
import { listActions, listActionsByModule } from "./action.ts";
import { listCustomizations, listCustomizationsByModule } from "./customization.ts";
import { clearAll } from "./registry.ts";

export type ExposureModuleSnapshot = Readonly<{
  signals: readonly import("./signal.ts").Signal[];
  actions: readonly import("./action.ts").Action[];
  customizations: readonly import("./customization.ts").Customization[];
}>;

export function snapshotExposure(module?: string): ExposureModuleSnapshot {
  if (module === undefined) {
    return Object.freeze({
      signals: listSignals(),
      actions: listActions(),
      customizations: listCustomizations(),
    });
  }
  return Object.freeze({
    signals: listSignalsByModule(module),
    actions: listActionsByModule(module),
    customizations: listCustomizationsByModule(module),
  });
}

export function resetExposureForTest(): void {
  clearAll();
}

// ── Shared metadata vocabulary ──
// Re-exported from the single facade so consumers (the schema builder, the
// UI generator, prevention guards) import the vocabulary from one place.
export {
  DETERMINISM_CLASSES,
  EFFECT_TIMINGS,
  AUDIENCES,
  // The field→permitted-values table itself, so consumers (a settings UI, a
  // schema builder, a guard) enumerate the vocabulary from the SAME data the
  // validator rejects against instead of restating it.
  CONTRACT_ENUMS,
  resolveContract,
  isContractSpecified,
  validateContract,
} from "./contract.ts";
export type {
  ExposureContract,
  ResolvedContract,
  DeterminismClass,
  EffectTiming,
  Audience,
} from "./contract.ts";
export { createCatalog, isValidExposureId } from "./catalog.ts";
export type { Catalog, CatalogEntry } from "./catalog.ts";

// ── Config binding (config-binding.ts) ──
// The mechanism that backs a Customization with a path in
// `bridlewise.config.json`. The hosting runtime installs the store once;
// a customization declares `configPath` and its value persists through the
// config write gate. Re-exported so the server (installing its
// writeConfigRaw-backed store) and registration files (seeding projections +
// building config-bound setters) reach it through the ONE barrel.
export {
  installCustomizationConfigStore,
  resetCustomizationConfigStore,
  hasCustomizationConfigStore,
  isConfigPathDeclared,
  readConfigCustomization,
  readNumberCustomization,
  readBooleanCustomization,
  readStringCustomization,
  writeConfigCustomization,
  seedFromConfig,
  syncStateFromConfig,
  configBoundSet,
  createEngineCustomizationConfigStore,
  // Consumed by the registration path (customization.ts seeds each knob's
  // declared default into the store). Re-exported because the barrel is the
  // single public path — every value export of an exposure module is
  // reachable through it (the barrel arm enforces this).
  rememberConfigPathDefault,
} from "./config-binding.ts";
export type { CustomizationConfigStore } from "./config-binding.ts";

// ── Served-language guard (language.ts) ──
// The registration-time rules for the words a settings surface serves:
// behavior-shaped names, consequence descriptions, no leading jargon,
// printable units. Re-exported so guards/reporters/tests read the SAME
// vocabulary the validator rejects against.
export {
  LANGUAGE_ENFORCED_MODULES,
  isLanguageEnforcedModule,
  CUSTOMIZATION_LANGUAGE_JARGON,
  MIN_CUSTOMIZATION_DESCRIPTION_WORDS,
  MIN_MODULE_PURPOSE_WORDS,
  UNIT_TOKEN_DENYLIST,
  // The three word-shape primitives the rules are built from. Exported so the
  // MODULE declaration's rules (module.ts) are the SAME rules, not a private
  // second opinion about what "restates the id" means.
  normalize,
  stripParentheticals,
  wordCount,
  customizationUnitViolation,
  customizationLanguageViolation,
  assertCustomizationLanguage,
} from "./language.ts";
export type { CustomizationLanguage } from "./language.ts";

// ── Per-module config sections (module-config-sections.ts) ──
// The zod section schemas each exposure module's config-bound knobs bind
// against. The central config contract (`config-contracts.ts`) splices them
// into the runtime schema as optional top-level sections; they are re-exported
// here so a consumer reaches every exposure value export through the ONE
// barrel (an export present in a module but absent from the barrel is
// unreachable by any consumer).
export {
  SEARCH_CONFIG_SCHEMA,
  MCP_CONFIG_SCHEMA,
  CONTEXT_CONFIG_SCHEMA,
  AWARENESS_CONFIG_SCHEMA,
  BIAS_CONFIG_SCHEMA,
  HALLUCINATION_CONFIG_SCHEMA,
  LEARNING_CONFIG_SCHEMA,
  QUALITY_CONFIG_SCHEMA,
} from "./module-config-sections.ts";
// The safety section lives in the safety domain's own section owner (with
// its posture floors beside the detectors they arm); the barrel re-export
// keeps every exposure value export reachable through the ONE barrel.
export { SAFETY_CONFIG_SCHEMA } from "../../safety/safety-config-section.ts";

// ── The MODULE declaration (module.ts) ──
// The category primitive: what an exposure namespace is CALLED and what it
// DECIDES, in plain words, declared beside the entries it names. Consumers
// (the settings surface, the reporter, the schema builder) derive their
// grouping from this instead of authoring a namespace→name table of their own.
export {
  isValidModuleId,
  humanizeModuleId,
  exposureModuleViolation,
  registerExposureModule,
  listExposureModules,
  getExposureModule,
  countExposureModules,
  exposureModuleTitle,
  undeclaredModules,
  unregisterExposureModule,
  clearExposureModules,
} from "./module.ts";
export type { ExposureModule } from "./module.ts";
