/**
 * Shared exposure system — Signal primitive (UNIFIED).
 *
 * A Signal is a named, dynamically-computed value exposed by a module for
 * any consumer to read. Signals are the "gauges" of the harness: they report
 * observable state (counts, rates, latencies, flags) without exposing the
 * underlying implementation.
 *
 * One of three exposure primitives (Signal, Action, Customization) owned by
 * `src/shared/exposure/`. ALL modules register their signals here — never
 * ad-hoc.
 *
 * UNIFIED API (EXP470): this file merges the three previously-fragmented
 * exposure families into ONE source of truth:
 * - A.1 (EXP425/436): `registerSignal(Signal)` object registration +
 * `readSignal(id)` — the canonical registration + read path (kept).
 * - B (EXP457): `defineSignal/defineCounter/defineGauge/defineState`
 * positional ergonomics — re-implemented as thin wrappers over
 * `registerSignal` so modules that prefer positional definition use the
 * SAME registry (no parallel surface).
 *
 * Per the root policy invariant `staticConfigValuesAllowed: false`, signal
 * values are always computed by `value` — never stored as a constant. The
 * `defineX` helpers therefore take a `value` callback (merging B's positional
 * ergonomics with A.1's dynamic-value requirement).
 */

import { deepFreeze } from "../../kernel/integrity.ts";
import { InputError } from "../../kernel/errors.ts";
import { createCatalog } from "./catalog.ts";
import { type ExposureContract } from "./contract.ts";

/** Signal value types supported by the exposure system (superset of A.1 + B). */
export const SIGNAL_TYPES = deepFreeze([
  "counter",
  "gauge",
  "histogram",
  "timer",
  "boolean",
  "string",
  "event",
  "state",
  // An INSTANT (epoch milliseconds), not a duration. `timer` means "how long
  // something took"; a renderer is right to format a timer's value as a
  // duration. A value produced by `Date.now()` declared as `timer`/`ms`
  // therefore renders as a ~56-year duration — the declaration lied, not the
  // renderer. `timestamp` states the value's true nature so a generic
  // consumer can format it as a point in time.
  "timestamp",
] as const);
export type SignalType = typeof SIGNAL_TYPES[number];

/**
 * Declared abnormality bounds for a numeric signal — the ONLY basis on which
 * a generic surface may color a reading as abnormal.
 *
 * A value above `warnAbove` (strictly) or below `warnBelow` (strictly) is
 * abnormal BY THE OWNING MODULE'S OWN SEMANTICS (an integrity-failure counter
 * above zero, a utilization above its documented limit). Absent bounds mean
 * "no declared abnormality" and a renderer must stay quiet — a threshold
 * invented by a consumer would be fabricated judgment presented as fact.
 */
export type SignalAbnormal = Readonly<{
  /** Values strictly above this are abnormal. */
  warnAbove?: number;
  /** Values strictly below this are abnormal. */
  warnBelow?: number;
}>;

/** Signal types whose values are ordered numbers, i.e. can carry `abnormal` bounds. */
export const NUMERIC_SIGNAL_TYPES = deepFreeze([
  "counter",
  "gauge",
  "histogram",
  "timer",
] as const);

/** Validate a declared `abnormal` block. Throws the typed InputError on nonsense. */
export function validateSignalAbnormal(
  id: string,
  type: SignalType,
  abnormal: SignalAbnormal | undefined,
): void {
  if (abnormal === undefined) return;
  if (!(NUMERIC_SIGNAL_TYPES as readonly string[]).includes(type)) {
    throw new InputError(
      `exposure: signal "${id}" declares abnormal bounds but its type "${type}" is not numeric`,
    );
  }
  const { warnAbove, warnBelow } = abnormal;
  if (warnAbove === undefined && warnBelow === undefined) {
    throw new InputError(
      `exposure: signal "${id}" declares an empty abnormal block (no warnAbove/warnBelow)`,
    );
  }
  for (const [field, bound] of [["warnAbove", warnAbove], ["warnBelow", warnBelow]] as const) {
    if (bound !== undefined && !Number.isFinite(bound)) {
      throw new InputError(`exposure: signal "${id}" abnormal.${field} must be a finite number`);
    }
  }
  if (warnAbove !== undefined && warnBelow !== undefined && warnBelow >= warnAbove) {
    throw new InputError(
      `exposure: signal "${id}" abnormal bounds are inverted (warnBelow ${warnBelow} >= warnAbove ${warnAbove})`,
    );
  }
}

/** A signal argument schema entry (when a signal takes input). */
export type SignalArg = Readonly<{
  name: string;
  type: "number" | "string" | "boolean";
  description: string;
}>;

/** Optional extra fields for a signal (unit + partition labels). */
export type SignalExtra = Readonly<{
  unit?: string;
  labels?: readonly string[];
  args?: readonly SignalArg[];
}>;

/** A registered signal — a dynamically-computed observable value. */
export type Signal = Readonly<{
  /** Stable dotted id, e.g. `"search.queryCount"`. */
  id: string;
  /** Owning module id, e.g. `"search"`. */
  module: string;
  /** Human-readable name, e.g. `"Query Count"`. */
  name: string;
  /** Short description for documentation + LLM consumption. */
  description: string;
  /** Value semantics. */
  type: SignalType;
  /** Optional unit, e.g. `"ms"`, `"tokens"`, `"count"`. */
  unit?: string;
  /**
   * Optional declared abnormality bounds (numeric types only). Absent means
   * no abnormality is declared and consumers must not invent one.
   */
  abnormal?: SignalAbnormal;
  /** Optional fixed label keys this signal is partitioned by. */
  labels?: readonly string[];
  /** Optional argument schema when `value` needs input. */
  args?: readonly SignalArg[];
  /** Compute the current value (always dynamic, never a stored constant). */
  value: (args?: Readonly<Record<string, unknown>>) => number | string | boolean;
  /**
   * WHO MAY READ THE VALUE. Absent: every signed-in viewer. `admin`: the value
   * names the host's layout (paths of other installs, the key home, backups),
   * so a viewer who is not an admin is served `publicValue` instead (a count,
   * a version) — or nothing, when there is none. Applied by the one values
   * surface (`buildUiSchemaValues`), per caller.
   */
  visibility?: Readonly<{ viewer: "admin"; publicValue?: () => number | string | boolean }>;
  /**
   * Shared exposure metadata — determinism class, effect timing, audience,
   * visibility predicate. Optional; see `contract.ts`. Present on EVERY
   * primitive so a generator can treat them uniformly.
   */
  contract?: ExposureContract;
}>;

/**
 * Storage + the seven generic operations come from the shared catalog. This
 * module keeps only what is SIGNAL-specific: the entry type, the type/value
 * validation below, and the `define*` sugar. The registry Map, the insertion
 * ordering, the dotted-id grammar and the duplicate-id rejection used to be
 * re-declared here; they now have exactly one implementation.
 */
const catalog = createCatalog<Signal>("signal", (signal) => {
  if (!SIGNAL_TYPES.includes(signal.type)) {
    throw new InputError(`exposure: signal "${signal.id}" has invalid type "${signal.type}"`);
  }
  if (typeof signal.value !== "function") {
    throw new InputError(`exposure: signal "${signal.id}" value must be a function`);
  }
  validateSignalAbnormal(signal.id, signal.type, signal.abnormal);
});

/**
 * Register a signal (canonical object registration, A.1).
 * Throws on duplicate id or invalid shape. Returns the registered signal.
 */
export function registerSignal(signal: Signal): Signal {
  return catalog.register(signal);
}

/** Get a registered signal by id, or `undefined`. */
export function getSignal(id: string): Signal | undefined {
  return catalog.get(id);
}

/** Read a signal's current value, or throw if unknown. */
export function readSignal(
  id: string,
  args?: Readonly<Record<string, unknown>>,
): number | string | boolean {
  const signal = catalog.get(id);
  if (!signal) throw new InputError(`exposure: signal "${id}" not registered`);
  return signal.value(args);
}

/** List all registered signals in registration order. */
export function listSignals(): readonly Signal[] {
  return catalog.list();
}

/** Count registered signals. */
export function countSignals(): number {
  return catalog.count();
}

/** List all signals owned by a module, in registration order. */
export function listSignalsByModule(module: string): readonly Signal[] {
  return catalog.listByModule(module);
}

/** Remove a signal (test/reset hook — production code does not unregister). */
export function unregisterSignal(id: string): boolean {
  return catalog.unregister(id);
}

/** Clear all signals (test/reset hook). */
export function clearSignals(): void {
  catalog.clear();
}

// ---------------------------------------------------------------------------
// Ergonomic positional helpers (B family, re-implemented over registerSignal).
// These are thin wrappers so modules that prefer positional definition use the
// SAME registry — there is no parallel definition-only surface.
// ---------------------------------------------------------------------------

/**
 * Define + register a signal positionally (B ergonomics over A.1 registration).
 * The `value` callback is required (dynamic values, no stored constants).
 * The `id` is a SHORT id unique within `module`; the registered dotted id is
 * `${module}.${id}` (so callers do not repeat the module prefix).
 */
export function defineSignal(
  module: string,
  id: string,
  name: string,
  description: string,
  type: SignalType,
  value: (args?: Readonly<Record<string, unknown>>) => number | string | boolean,
  extra: SignalExtra = {},
): Signal {
  const signal: Signal = { id: `${module}.${id}`, module, name, description, type, value, ...extra };
  return registerSignal(signal);
}

/** Convenience: define + register a counter signal (monotonic total). */
export function defineCounter(
  module: string,
  id: string,
  name: string,
  description: string,
  value: (args?: Readonly<Record<string, unknown>>) => number | string | boolean,
  labels?: readonly string[],
): Signal {
  return defineSignal(module, id, name, description, "counter", value, labels !== undefined ? { labels } : {});
}

/** Convenience: define + register a gauge signal (current value, can go up or down). */
export function defineGauge(
  module: string,
  id: string,
  name: string,
  description: string,
  value: (args?: Readonly<Record<string, unknown>>) => number | string | boolean,
  unit?: string,
): Signal {
  return defineSignal(module, id, name, description, "gauge", value, unit !== undefined ? { unit } : {});
}

/** Convenience: define + register a state signal (enum-like: idle/running, open/closed,...). */
export function defineState(
  module: string,
  id: string,
  name: string,
  description: string,
  value: (args?: Readonly<Record<string, unknown>>) => number | string | boolean,
): Signal {
  return defineSignal(module, id, name, description, "state", value, {});
}
