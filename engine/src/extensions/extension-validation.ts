import { InputError } from "../kernel/errors.ts";

/**
 * Shared extension validation utilities — the single canonical owner of
 * validation patterns and assertion helpers reused across the extension
 * domain modules (manifest, lifecycle, approval workflow).
 *
 * Previously `ISO_TIMESTAMP_PATTERN` was duplicated across three files
 * (extension-manifest.ts, approval-workflow.ts, extension-lifecycle.ts) and
 * `assertTimestamp` was duplicated across two with different signatures.
 * Per DRY, one canonical owner; consumers import from here.
 */

/**
 * Canonical ISO-8601 timestamp pattern with a `u` flag and anchored ends.
 *
 * Matches:
 * 2026-07-15T12:34:56Z
 * 2026-07-15T12:34:56.789Z
 * 2026-07-15T12:34:56+02:00
 * 2026-07-15T12:34:56.123-05:00
 *
 * Does NOT match calendar-only dates (no time), ordinal dates, or week
 * numbers. The fractional seconds part is optional. The zone designator is
 * either `Z` or a `+HH:MM`/`-HH:MM` offset.
 */
export const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/u;

/**
 * Assert that `value` is a string matching {@link ISO_TIMESTAMP_PATTERN}.
 * Throws `InputError` with `field` in the message and a typed error code so
 * callers can distinguish timestamp validation failures from other input
 * errors.
 *
 * @param value - The value to validate (typically `unknown` from a parsed
 * manifest/proposal/document).
 * @param field - The field name for the error message (e.g. "createdAt",
 * "updatedAt", "issuedAt").
 * @param code - The typed error code. Defaults to "invalid_timestamp".
 */
export function assertTimestamp(
  value: unknown,
  field: string,
  code = "invalid_timestamp",
): asserts value is string {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) {
    throw new InputError(`${field} must be an ISO-8601 timestamp`, code);
  }
}
