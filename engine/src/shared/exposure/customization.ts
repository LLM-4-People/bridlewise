/**
 * Shared exposure system — Customization primitive (UNIFIED).
 *
 * A Customization is a named, mutable configuration knob exposed by a
 * module for any consumer to read, set, or reset at runtime. Customizations
 * are the "tunables" of the harness: thresholds, limits, feature flags —
 * anything an operator or the LLM might want to tune without restarting.
 *
 * One of three exposure primitives (Signal, Action, Customization) owned by
 * `src/shared/exposure/`. ALL modules register their customizations
 * here — never ad-hoc.
 *
 * UNIFIED API (EXP470): this file merges the three previously-fragmented
 * families into ONE source of truth:
 * - A.1 (EXP425/436): `registerCustomization(Customization)` +
 * `getCustomizationValue(id)` + `setCustomizationValue(id, v)` — the
 * canonical registration + read + write path (kept).
 * - A.2 (EXP462): `readCustomization`/`writeCustomization`/`resetCustomization`
 * + `makeNumberCustomization`/`makeBooleanCustomization` self-contained
 * helpers + the `object` type — subsumed: read→`getCustomizationValue`,
 * write→`setCustomizationValue`, reset→`resetCustomizationValue` (NEW),
 * the self-contained helpers are kept, and `object` is added to the type
 * enum.
 * - B (EXP457): `defineNumber/defineString/defineBoolean/defineEnum/
 * defineObject` positional ergonomics — re-implemented as thin wrappers
 * that create a self-contained customization (via the `makeX` helpers)
 * AND register it, so positional definition uses the SAME registry.
 *
 * Per the root policy invariant `staticConfigValuesAllowed: false`, the
 * `default` is the only stored constant; `current` is always dynamic, and
 * `set` writes through to the owning module's runtime state. The optional
 * `reset` callback (when present) restores the default; when absent,
 * `resetCustomizationValue` falls back to `set(default)`.
 */

import { z } from "zod";

import { deepFreeze } from "../../kernel/integrity.ts";
import { InputError } from "../../kernel/errors.ts";
import { createCatalog } from "./catalog.ts";
import { type ExposureContract } from "./contract.ts";
import { getSignal } from "./signal.ts";
import { assertCustomizationLanguage, isLanguageEnforcedModule } from "./language.ts";
import { isConfigPathDeclared, rememberConfigPathDefault, seedFromConfig } from "./config-binding.ts";

/** Customization value types (superset of A.1 + A.2 + B). */
export const CUSTOMIZATION_TYPES = deepFreeze([
  "number",
  "string",
  "boolean",
  "enum",
  "object",
] as const);
export type CustomizationType = typeof CUSTOMIZATION_TYPES[number];

/** The value domain of a customization (scalar or object). */
export type CustomizationValue = number | string | boolean | Readonly<Record<string, unknown>>;

/** Numeric range for a number-typed customization. */
export type NumberRange = Readonly<{ min?: number; max?: number; integer?: boolean }>;

/**
 * A numeric knob's range, DERIVED from the schema its write gate validates
 * with (the one bounds owner), through zod's PUBLIC JSON-Schema projection —
 * never its internals — so the settings page and the gate cannot disagree
 * about what is accepted. An exclusive integer bound is the next integer.
 */
export function schemaBounds(schema: z.ZodType): Readonly<{ min: number; max: number; integer: boolean }> {
  const json = z.toJSONSchema(schema, { unrepresentable: "any" }) as { type?: string; minimum?: number; maximum?: number; exclusiveMinimum?: number; exclusiveMaximum?: number };
  const integer = json.type === "integer";
  const step = integer ? 1 : Number.EPSILON;
  const min = json.minimum ?? (json.exclusiveMinimum === undefined ? undefined : json.exclusiveMinimum + step);
  const max = json.maximum ?? (json.exclusiveMaximum === undefined ? undefined : json.exclusiveMaximum - step);
  if (min === undefined || max === undefined) throw new InputError("A numeric setting's schema declares no range", "customization_range_undeclared");
  return { min, max, integer };
}

/** A registered customization — a mutable runtime tunable. */
export type Customization = Readonly<{
  /** Stable dotted id, e.g. `"search.threshold"`. */
  id: string;
  /** Owning module id, e.g. `"search"`. */
  module: string;
  /**
   * Behavior-shaped human name, e.g. `"Minimum match score"` — what the knob
   * does, never the id restated (see `language.ts` for the enforced rules).
   */
  name: string;
  /**
   * Consequence description: what changes when the value changes, in which
   * direction, at what tradeoff. Served verbatim to every settings surface.
   */
  description: string;
  /** Value semantics. */
  type: CustomizationType;
  /** Default value (the only stored constant). */
  default: CustomizationValue;
  /** Minimum (type=number only). */
  min?: number;
  /** Maximum (type=number only). */
  max?: number;
  /** Enum values (type=enum only). */
  enum?: readonly string[];
  /** Optional unit (e.g. `ms`, `tokens`). */
  unit?: string;
  /** Read the current value (always dynamic). */
  current: () => CustomizationValue;
  /** Set a new value. Throws on validation failure. */
  set: (value: CustomizationValue) => void;
  /** Optional reset-to-default. When absent, `resetCustomizationValue` uses `set(default)`. */
  reset?: () => void;
  /**
   * Id of the SIGNAL that measures this customization's effect — the explicit
   * customization→signal linkage (no name-coincidence resolution). Validated
   * at registration: the signal must already be registered (deny-by-default —
   * a dangling claim of measurement is rejected, not rendered). The inverse
   * lookup (`listCustomizationsMeasuredBy`) is what gives an instrument cell
   * its adjust verb.
   */
  measuredBy?: string;
  /**
   * Shared exposure metadata — determinism class, effect timing, audience,
   * visibility predicate. Optional; see `contract.ts`. Present on EVERY
   * primitive so a generator can treat them uniformly.
   */
  contract?: ExposureContract;
  /**
   * The dotted path in `bridlewise.config.json` this knob is backed by
   * (e.g. `"memory.trimThreshold"`). When present, `current` reads the config
   * document and `set` writes it through the config write gate — the value is
   * persisted, survives restart, and is validated by the config schema.
   *
   * Deny-by-default at registration: a path the config document schema does
   * not declare is REFUSED (a module cannot publish a configurable the config
   * vocabulary does not know about). See `config-binding.ts`.
   */
  configPath?: string;
}>;

/**
 * Validate a value against a customization's declared type and bounds.
 *
 * THE SELECTION'S OWN WORDS. These sentences are USER-FACING: the settings
 * sheet answers a Save press with one of them when the declared bounds
 * refuse the value, so they speak plain English and sentence case and name
 * the setting — never the registry's internal vocabulary (the old
 * "exposure: customization … value 99 > max 1" read as a stack trace to the
 * one person it was addressed to). The REGISTRATION-time messages elsewhere
 * in this file are developer invariants and keep their prefixed shape.
 */
function validateCustomizationValue(
  customization: Customization,
  value: CustomizationValue,
): void {
  switch (customization.type) {
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new InputError(
          `the setting "${customization.id}" holds a number — the saved value is not one`,
        );
      }
      if (customization.min !== undefined && value < customization.min) {
        throw new InputError(
          `the setting "${customization.id}" allows values down to ${customization.min} — ${value} is below its minimum`,
        );
      }
      if (customization.max !== undefined && value > customization.max) {
        throw new InputError(
          `the setting "${customization.id}" allows values up to ${customization.max} — ${value} is above its maximum`,
        );
      }
      return;
    }
    case "string": {
      if (typeof value !== "string") {
        throw new InputError(
          `the setting "${customization.id}" holds a string of text — the saved value is not one`,
        );
      }
      return;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        throw new InputError(
          `the setting "${customization.id}" holds a switch — the saved value is not one`,
        );
      }
      return;
    }
    case "enum": {
      if (typeof value !== "string") {
        throw new InputError(
          `the setting "${customization.id}" holds one of its declared choices — the saved value is not one`,
        );
      }
      if (!customization.enum || !customization.enum.includes(value)) {
        const choices = (customization.enum ?? []).map((c) => `"${c}"`).join(", ");
        throw new InputError(
          `the setting "${customization.id}" allows ${choices} — "${value}" is not one of its choices`,
        );
      }
      return;
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new InputError(
          `the setting "${customization.id}" holds a JSON object — the saved value is not one`,
        );
      }
      return;
    }
    default: {
      throw new InputError(
        `exposure: customization "${customization.id}" has unknown type "${customization.type}"`,
      );
    }
  }
}

/** Validate the customization's own default against its declared type. */
function validateCustomizationDefault(customization: Customization): void {
  try {
    validateCustomizationValue(customization, customization.default);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InputError(
      `exposure: customization "${customization.id}" default is invalid: ${message}`,
    );
  }
  if (customization.type !== "enum" && customization.enum !== undefined) {
    throw new InputError(
      `exposure: customization "${customization.id}" enum must be empty unless type=enum`,
    );
  }
  if (customization.type !== "number" &&
      (customization.min !== undefined || customization.max !== undefined)) {
    throw new InputError(
      `exposure: customization "${customization.id}" min/max only allowed for type=number`,
    );
  }
}

/** Register a customization (canonical, A.1). Throws on duplicate id or invalid shape. */
/**
 * Storage + the seven generic operations come from the shared catalog. Only
 * CUSTOMIZATION-specific validation stays here: the declared type must be
 * known, `current`/`set` must be callable, and the default must satisfy the
 * declared type and bounds.
 */
const catalog = createCatalog<Customization>("customization", (customization) => {
  if (!CUSTOMIZATION_TYPES.includes(customization.type)) {
    throw new InputError(
      `exposure: customization "${customization.id}" has invalid type "${customization.type}"`,
    );
  }
  if (typeof customization.current !== "function") {
    throw new InputError(`exposure: customization "${customization.id}" current must be a function`);
  }
  if (typeof customization.set !== "function") {
    throw new InputError(`exposure: customization "${customization.id}" set must be a function`);
  }
  validateCustomizationDefault(customization);
  // `measuredBy` is validated for EVERY module: it names a signal, and a
  // signal that is not registered yet cannot be measuring anything. Modules
  // register signals before customizations, so a truthful linkage resolves.
  if (customization.measuredBy !== undefined && getSignal(customization.measuredBy) === undefined) {
    throw new InputError(
      `exposure: customization "${customization.id}" declares measuredBy ` +
        `"${customization.measuredBy}", which is not a registered signal`,
      "exposure_measured_by_unknown",
      { exposureId: customization.id, measuredBy: customization.measuredBy },
    );
  }
  // Config binding — deny-by-default at the choke point. A customization that
  // declares `configPath` is backed by the config file; a path the config
  // document schema does not declare is refused HERE, at registration, so a
  // module cannot publish a configurable the config vocabulary does not know
  // about. This is the single gate every config-bound customization passes.
  if (customization.configPath !== undefined && !isConfigPathDeclared(customization.configPath)) {
    throw new InputError(
      `exposure: customization "${customization.id}" declares configPath ` +
        `"${customization.configPath}", which is not declared in the config document schema`,
      "customization_config_path_unknown",
      { exposureId: customization.id, configPath: customization.configPath },
    );
  }
  // Served-language rules — enforced for every settings-surface module (see
  // language.ts for scope): behavior-shaped name, consequence description,
  // no leading jargon, printable unit.
  if (isLanguageEnforcedModule(customization.module)) {
    assertCustomizationLanguage(customization);
  }
});

export function registerCustomization(customization: Customization): Customization {
  // Config-bound read liveness, at the single door. A config-bound knob's
  // `current` must serve the LIVE config value — not the module's in-memory
  // projection, which is seeded once at registration and otherwise moves only
  // when the knob's own `set` runs. A raw config edit (`PUT /api/config`, or
  // an operator editing the file) changes the document without touching the
  // projection, so reading the projection serves a value the config file has
  // already left behind — the two-sources defect this binding exists to end.
  // Reading through the store here covers every config-bound knob, including
  // one registered tomorrow, with no per-module edit. `seedFromConfig` falls
  // back to the registration's own `current()` (the projection) when no store
  // is installed or the path is absent, so a host without a store keeps its
  // existing behaviour.
  if (customization.configPath !== undefined) {
    const configPath = customization.configPath;
    rememberConfigPathDefault(configPath, customization.default);
    const projectionCurrent = customization.current;
    return catalog.register({
      ...customization,
      current: () => seedFromConfig(configPath, projectionCurrent()),
    });
  }
  return catalog.register(customization);
}

export function getCustomization(id: string): Customization | undefined {
  return catalog.get(id);
}

/** Read a customization's current value (canonical, A.1). Throws if unknown. */
export function getCustomizationValue(id: string): CustomizationValue {
  const customization = catalog.get(id);
  if (!customization) throw new InputError(`exposure: customization "${id}" not registered`);
  return customization.current();
}

/** Set a customization's value, validating first (canonical, A.1). Throws if unknown. */
export function setCustomizationValue(
  id: string,
  value: CustomizationValue,
): void {
  const customization = catalog.get(id);
  if (!customization) throw new InputError(`exposure: customization "${id}" not registered`);
  validateCustomizationValue(customization, value);
  customization.set(value);
}

/**
 * Reset a customization to its default (NEW operation, from A.2).
 * If the customization provides an explicit `reset` callback, it is called.
 * Otherwise the default is re-applied via `set(default)` (the default was
 * validated at registration, so `set` accepts it). Throws if unknown.
 */
export function resetCustomizationValue(id: string): void {
  const customization = catalog.get(id);
  if (!customization) throw new InputError(`exposure: customization "${id}" not registered`);
  if (typeof customization.reset === "function") {
    customization.reset();
    return;
  }
  validateCustomizationValue(customization, customization.default);
  customization.set(customization.default);
}

/** List all registered customizations in registration order. */
export function listCustomizations(): readonly Customization[] {
  return catalog.list();
}

/** Count registered customizations. */
export function countCustomizations(): number {
  return catalog.count();
}

/** List all customizations owned by a module, in registration order. */
export function listCustomizationsByModule(module: string): readonly Customization[] {
  return catalog.listByModule(module);
}

/**
 * The customizations whose declared `measuredBy` is this signal — the
 * EXPLICIT signal→adjustment mapping. An instruments surface resolves a
 * reading's adjust verb through this instead of an identical-id coincidence:
 * the linkage was validated at registration, so every hit is a real,
 * declared measurement relationship.
 */
export function listCustomizationsMeasuredBy(signalId: string): readonly Customization[] {
  return catalog.list().filter((customization) => customization.measuredBy === signalId);
}

/** Remove a customization (test/reset hook). */
export function unregisterCustomization(id: string): boolean {
  return catalog.unregister(id);
}

/** Clear all customizations (test/reset hook). */
export function clearCustomizations(): void {
  catalog.clear();
}

// ---------------------------------------------------------------------------
// Self-contained customization builders (A.2 family).
//
// These create a Customization object with internal mutable state + a
// `reset` callback. They do NOT register; pass the result to
// `registerCustomization` (or use the `defineX` helpers below which do both).
// ---------------------------------------------------------------------------

/** Build a self-contained number customization with internal state + reset. */
export function makeNumberCustomization(
  id: string,
  module: string,
  name: string,
  description: string,
  defaultValue: number,
  min: number | undefined = undefined,
  max: number | undefined = undefined,
): Customization {
  let current = defaultValue;
  const base = {
    id, module, name, description,
    type: "number" as const,
    default: defaultValue,
    current: () => current,
    set: (v: CustomizationValue) => {
      if (typeof v !== "number" || !Number.isFinite(v)) throw new InputError(`exposure: ${id} expects number`);
      if (min !== undefined && v < min) throw new InputError(`exposure: ${id} below min ${min}`);
      if (max !== undefined && v > max) throw new InputError(`exposure: ${id} above max ${max}`);
      current = v;
    },
    reset: () => { current = defaultValue; },
  };
  // Conditionally include min/max (exactOptionalPropertyTypes forbids `undefined`).
  const withMin = min !== undefined ? { ...base, min } : base;
  return max !== undefined ? { ...withMin, max } : withMin;
}

/** Build a self-contained string customization with internal state + reset. */
export function makeStringCustomization(
  id: string,
  module: string,
  name: string,
  description: string,
  defaultValue: string,
): Customization {
  let current = defaultValue;
  return {
    id, module, name, description, type: "string", default: defaultValue,
    current: () => current,
    set: (v: CustomizationValue) => {
      if (typeof v !== "string") throw new InputError(`exposure: ${id} expects string`);
      current = v;
    },
    reset: () => { current = defaultValue; },
  };
}

/** Build a self-contained boolean customization with internal state + reset. */
export function makeBooleanCustomization(
  id: string,
  module: string,
  name: string,
  description: string,
  defaultValue: boolean,
): Customization {
  let current = defaultValue;
  return {
    id, module, name, description, type: "boolean", default: defaultValue,
    current: () => current,
    set: (v: CustomizationValue) => {
      if (typeof v !== "boolean") throw new InputError(`exposure: ${id} expects boolean`);
      current = v;
    },
    reset: () => { current = defaultValue; },
  };
}

/** Build a self-contained enum customization with internal state + reset. */
export function makeEnumCustomization(
  id: string,
  module: string,
  name: string,
  description: string,
  defaultValue: string,
  values: readonly string[],
): Customization {
  let current = defaultValue;
  return {
    id, module, name, description, type: "enum", default: defaultValue, enum: values,
    current: () => current,
    set: (v: CustomizationValue) => {
      if (typeof v !== "string") throw new InputError(`exposure: ${id} expects enum string`);
      if (!values.includes(v)) throw new InputError(`exposure: ${id} value "${v}" not in enum`);
      current = v;
    },
    reset: () => { current = defaultValue; },
  };
}

/** Build a self-contained object customization with internal state + reset. */
export function makeObjectCustomization(
  id: string,
  module: string,
  name: string,
  description: string,
  defaultValue: Readonly<Record<string, unknown>>,
): Customization {
  let current: Readonly<Record<string, unknown>> = defaultValue;
  return {
    id, module, name, description, type: "object", default: defaultValue,
    current: () => current,
    set: (v: CustomizationValue) => {
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        throw new InputError(`exposure: ${id} expects object`);
      }
      current = v as Readonly<Record<string, unknown>>;
    },
    reset: () => { current = defaultValue; },
  };
}

// ---------------------------------------------------------------------------
// Ergonomic positional helpers (B family, re-implemented over makeX + register).
// Each creates a self-contained customization AND registers it. The `id` is a
// SHORT id unique within `module`; the registered dotted id is `${module}.${id}`.
// ---------------------------------------------------------------------------

/** Define + register a number customization (B ergonomics). */
export function defineNumber(
  module: string,
  id: string,
  name: string,
  description: string,
  defaultValue: number,
  range?: NumberRange,
  unit?: string,
): Customization {
  const fullId = `${module}.${id}`;
  const cust = makeNumberCustomization(fullId, module, name, description, defaultValue, range?.min, range?.max);
  const withUnit: Customization = unit !== undefined ? { ...cust, unit } : cust;
  return registerCustomization(withUnit);
}

/** Define + register a string customization (B ergonomics). */
export function defineString(
  module: string,
  id: string,
  name: string,
  description: string,
  defaultValue: string,
): Customization {
  return registerCustomization(makeStringCustomization(`${module}.${id}`, module, name, description, defaultValue));
}

/** Define + register a boolean customization (B ergonomics). */
export function defineBoolean(
  module: string,
  id: string,
  name: string,
  description: string,
  defaultValue: boolean,
): Customization {
  return registerCustomization(makeBooleanCustomization(`${module}.${id}`, module, name, description, defaultValue));
}

/** Define + register an enum customization (B ergonomics). */
export function defineEnum(
  module: string,
  id: string,
  name: string,
  description: string,
  defaultValue: string,
  values: readonly string[],
): Customization {
  return registerCustomization(makeEnumCustomization(`${module}.${id}`, module, name, description, defaultValue, values));
}

/** Define + register an object customization (B ergonomics). */
export function defineObject(
  module: string,
  id: string,
  name: string,
  description: string,
  defaultValue: Readonly<Record<string, unknown>>,
): Customization {
  return registerCustomization(makeObjectCustomization(`${module}.${id}`, module, name, description, defaultValue));
}
