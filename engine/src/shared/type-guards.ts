/**
 * Canonical type-guard and exhaustiveness helpers.
 *
 * ONE source of truth for the trivial runtime type checks that were
 * previously duplicated across:
 * - `isPlainObject` — `schema-subset.ts`, `forensic-normalization.ts`
 * - `isPromiseLike` — `filesystem/durable-filesystem-internal.ts`,
 * `runtime/admitted-node-runtime.ts`
 * - `requireObject` — `event-state.ts`, `protocol-projections.ts`
 * - `assertNever` — `filesystem/repository-root-capability-internal.ts`,
 * `editor/edit-operations.ts`,
 * `filesystem/repository-root-capability-contracts.ts` (NOTE: those
 * three copies throw domain-specific error types and are NOT replaced
 * here — this `assertNever` is the generic fallback for new code).
 *
 * The `isPlainObject` merge accepts both `Object.prototype` and `null`
 * prototypes (the `forensic-normalization.ts` version was more permissive —
 * we keep the permissive behaviour as the canonical contract).
 */

import { InputError } from "../kernel/errors.ts";

/** A plain JSON object (string-keyed record of unknown values). */
export type JsonObject = Record<string, unknown>;

/**
 * `true` when `value` is a non-null, non-array plain object (prototype is
 * `Object.prototype` or `null`).
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * `true` when `value` is a thenable (non-null object or function with a
 * `.then` method).
 */
export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === "object" && value !== null || typeof value === "function") &&
    "then" in value && typeof (value as { then?: unknown }).then === "function";
}

/**
 * Exhaustiveness check for discriminated unions. Always throws.
 *
 * The default throw is `new Error(...)`. Callers that need a typed error
 * (SecurityError, InputError, a domain-specific contractError, etc.) pass
 * an `errorFactory` that returns the typed `never`. This unifies the 3
 * domain-specific `assertNever` copies that previously lived in
 * `editor/edit-operations.ts` (SecurityError),
 * `filesystem/repository-root-capability-contracts.ts` (contractError),
 * and `filesystem/repository-root-capability-internal.ts` (capabilityError).
 * Those modules pass an `errorFactory` to this single owner; they no
 * longer need their own private `assertNever`.
 */
export function assertNever(
  value: never,
  errorFactory?: (value: never) => Error,
): never {
  if (errorFactory !== undefined) {
    throw errorFactory(value);
  }
  throw new InputError(`assertNever: unexpected value ${JSON.stringify(value)}`);
}

/**
 * Assert that `value` is a plain JSON object (non-null, non-array,
 * `Object.prototype` prototype). Throws `InputError` otherwise.
 * Replaces the duplicate `requireObject` in `event-state.ts` and
 * `protocol-projections.ts`.
 */
export function requireObject(value: unknown, code: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw new InputError("Protocol object is malformed", code);
  }
  return value as JsonObject;
}

/**
 * A membership test over a DECLARED vocabulary, with no handle to the set.
 *
 * ── THE DEFECT THIS ENDS, DRIVEN ──────────────────────────────────────────
 *
 * The shape everywhere before this was:
 *
 *     const TIER_SET = new Set<string>(MEMORY_TIERS);
 *     ... TIER_SET.has(value) ...
 *
 * and it is wrong twice over. `new Set<string>` ERASES THE ELEMENT TYPE, so
 * the set has no type relationship to the vocabulary it was built from and
 * `.has("anything at all")` compiles. And a `Set` is MUTABLE, so the set can
 * be made to disagree with the vocabulary it came from by one line that
 * typechecks:
 *
 *     TIER_SET.delete("long-term");
 *
 * That was driven against a guard which required the exact spelling
 * `new Set<…>(MEMORY_TIERS)` and was satisfied by it: `tsc` exit 0, the tier
 * suites green, and `?tier=long-term` silently dropped at the boundary — the
 * precise defect the guard had been written to close. A guard that can only be
 * satisfied by a spelling will eventually be satisfied by that spelling in the
 * wrong place.
 *
 * ── WHY THIS IS THE RUNG AND NOT A TIDIER SPELLING ────────────────────────
 *
 * The set lives in the closure and NOTHING NAMES IT. There is no expression a
 * caller can write to add to it, delete from it, or read it back, so the
 * disagreement is not merely discouraged — it cannot be written down. And the
 * predicate's type is tied to the vocabulary's ELEMENT type, so a value the
 * vocabulary does not hold cannot be narrowed to it either.
 *
 * An EMPTY vocabulary is refused rather than accepted: a predicate over
 * nothing answers `false` to everything, which is indistinguishable from
 * "correctly rejected" at every call site, and is how a vocabulary that failed
 * to load becomes a boundary that rejects everything in silence.
 */
export function memberOf<T extends string>(
  vocabulary: readonly T[],
): (value: unknown) => value is T {
  if (vocabulary.length === 0) {
    throw new InputError(
      "memberOf() was given an EMPTY vocabulary. A membership test over nothing answers " +
        "false to every input, which reads exactly like a correct rejection — so a vocabulary " +
        "that failed to load becomes a boundary that refuses everything, silently.",
      "vocabulary_empty",
    );
  }
  const members = new Set<string>(vocabulary);
  return (value: unknown): value is T => typeof value === "string" && members.has(value);
}

/**
 * Refuse an override naming a setting the defaults do not declare.
 *
 * A config resolver that merges `overrides.foo ?? defaults.foo` for a fixed
 * list of names cannot see a name outside that list, so a misspelling falls
 * through every layer without a word: the write gate accepts it, the reader
 * that forwards known names drops it, and the resolver applies the default.
 * Acceptance at every step and effect at none — an operator's setting that
 * reads as applied and is not. The type system cannot catch it either,
 * because these values cross from JSON by assertion.
 *
 * The resolver is the last place that can still tell, so every resolver
 * calls this first. The valid names are read from the DEFAULTS object rather
 * than written down, so a setting added tomorrow is accepted with nothing to
 * remember and a setting removed tomorrow is refused for the same reason.
 */
export function refuseUnknownKeys(
  overrides: Readonly<Record<string, unknown>>,
  defaults: Readonly<Record<string, unknown>>,
  subject: string,
  code: string,
): void {
  const unknown = Object.keys(overrides).filter((key) => !(key in defaults));
  if (unknown.length === 0) return;
  throw new InputError(
    `Unknown ${subject} setting${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. ` +
      `Valid settings are: ${Object.keys(defaults).sort().join(", ")}.`,
    code,
  );
}
