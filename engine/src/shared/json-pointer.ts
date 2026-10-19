/**
 * Canonical JSON Pointer (RFC 6901) helpers.
 *
 * ONE source of truth for the JSON-Pointer reference-token escaping that was
 * previously duplicated across:
 * - `protocol-projections.ts`
 * - `event-state.ts`
 * - `schema-subset.ts`
 */

/**
 * Escape a JSON Pointer reference token: `~` → `~0`, `/` → `~1`.
 * (RFC 6901 §3.)
 */
export function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
