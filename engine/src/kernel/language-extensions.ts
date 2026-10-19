/**
 * Canonical TypeScript/JavaScript file-extension sets.
 *
 * One authoritative owner for the language file-extension sets consumed by
 * the syntax validator and the TypeScript quality pack. Previously these
 * were duplicated verbatim in `src/editor/syntax-validator.ts` and
 * `src/quality-packs/typescript-pack.ts` (Round 6 Category 26 findings); the
 * duplicates could drift silently. Both consumers now import from this
 * module so a single edit point updates every call site.
 */

export const TS_EXTENSIONS: ReadonlySet<string> = new Set([".ts", ".tsx", ".mts", ".cts"]);
export const JS_EXTENSIONS: ReadonlySet<string> = new Set([".js", ".jsx", ".mjs", ".cjs"]);
