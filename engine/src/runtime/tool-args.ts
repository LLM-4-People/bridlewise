import { InputError } from "../kernel/errors.ts";

/**
 * Canonical tool-argument validators for the interactive runtime.
 *
 * Single owner of the `assertString` / `optionalString` / `resolveBoolean` /
 * `resolvePositiveInt` pattern. Before this module, four files
 * (git-tools, agent-tools, intelligence-tools, built-in-tools) each
 * re-defined byte-similar helpers with divergent signatures, return types,
 * default max lengths, and nullability. Consumers now import these instead.
 *
 * Conventions:
 * - Missing means `undefined` or `null` (the JSON shapes a model sends).
 * - All failures throw {@link InputError} with a stable code:
 * `tool_arguments_invalid` for missing/wrong-type, `tool_argument_oversized`
 * for length-limit violations.
 * - Length limits are opt-in; an absent `maxLength`/`max` means unbounded.
 */

export type AssertStringOptions = Readonly<{ maxLength?: number }>;

export type ResolvePositiveIntOptions = Readonly<{ defaultValue?: number; max?: number }>;

/**
 * Require a non-empty string field. Throws if the field is missing, not a
 * string, empty, or longer than `opts.maxLength`.
 */
export function assertString(
  args: Readonly<Record<string, unknown>>,
  key: string,
  opts?: AssertStringOptions,
): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new InputError(`${key} must be a non-empty string`, "tool_arguments_invalid");
  }
  if (opts?.maxLength !== undefined && value.length > opts.maxLength) {
    throw new InputError(`${key} exceeds maximum length`, "tool_argument_oversized");
  }
  return value;
}

/**
 * Return an optional string field, or `undefined` when missing. Throws if the
 * field is present but not a string or longer than `opts.maxLength`. `null` is
 * treated as missing so a model may send `null` to mean "omit".
 */
export function optionalString(
  args: Readonly<Record<string, unknown>>,
  key: string,
  opts?: AssertStringOptions,
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new InputError(`${key} must be a string`, "tool_arguments_invalid");
  }
  if (opts?.maxLength !== undefined && value.length > opts.maxLength) {
    throw new InputError(`${key} exceeds maximum length`, "tool_argument_oversized");
  }
  return value;
}

/**
 * Resolve a boolean field, falling back to `defaultValue` when missing.
 * Throws if the field is present but not a boolean. `null` is treated as
 * missing so a model may send `null` to mean "use the default".
 */
export function resolveBoolean(
  args: Readonly<Record<string, unknown>>,
  key: string,
  defaultValue: boolean,
): boolean {
  const value = args[key];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== "boolean") {
    throw new InputError(`${key} must be a boolean`, "tool_arguments_invalid");
  }
  return value;
}

/**
 * Resolve a positive integer field. Returns `opts.defaultValue` when missing
 * (throwing if no default is configured for a missing field). Throws if the
 * field is present but not a positive integer, or exceeds `opts.max`.
 */
export function resolvePositiveInt(
  args: Readonly<Record<string, unknown>>,
  key: string,
  opts?: ResolvePositiveIntOptions,
): number {
  const value = args[key];
  if (value === undefined || value === null) {
    const defaultValue = opts?.defaultValue;
    if (defaultValue === undefined) {
      throw new InputError(`${key} must be a positive integer`, "tool_arguments_invalid");
    }
    return defaultValue;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new InputError(`${key} must be a positive integer`, "tool_arguments_invalid");
  }
  if (opts?.max !== undefined && value > opts.max) {
    throw new InputError(`${key} must be a positive integer <= ${opts.max}`, "tool_arguments_invalid");
  }
  return value;
}
