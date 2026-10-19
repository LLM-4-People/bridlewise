/**
 * Web-UI-local PURE shared types — the single source of truth for shared
 * type literals that have NO dependency on the canonical harness
 * (`@harness/*`), so the SERVER (NodeNext module resolution, no path
 * aliases) can import this file exactly like the client.
 *
 * SPO (contracts audit): before  `ToolKind` was defined in
 * BOTH `shared/types.ts` (the client owner) AND `server/harness-config.ts`
 * (a parallel server-local definition). The server could not import
 * `shared/types.ts` because that file pulls `@harness/*` path aliases
 * (only the client tsconfig resolves them; the server's NodeNext
 * resolution cannot). The two definitions were structurally identical but
 * DUPLICATED — a drift class (a new tool kind added on one side without
 * the other would silently break the wire). moves the PURE shared
 * type here (a file with NO `@harness/*` imports, mirroring
 * `shared/ui-schema.ts`), so BOTH the server + the client import the
 * ONE definition. `shared/types.ts` re-exports it so existing client
 * import paths are unchanged.
 *
 * Adding a new pure shared web-UI type: add it HERE (not in
 * `shared/types.ts` if it must be server-importable; `shared/types.ts`
 * remains the home for types that re-export from `@harness/*` and are
 * client-only). The `frontend-contracts-owner` prevention test pins this
 * file as the single owner.
 */

/**
 * Granular tool category (more than read/write). Each tool is tagged
 * with a `kind` derived from its `adapterId` (and configurable via the config's
 * `tools.kinds` map). The UI uses `kind` for filtering and sorting; the binary
 * `category` ("built-in" | "mcp") distinguishes the source.
 *
 * SPO: previously duplicated in `server/harness-config.ts` (the server
 * could not import `shared/types.ts` due to the `@harness/*` path-alias
 * boundary). Now defined ONCE here; both sides import this file.
 */
// THE ARRAY OWNS THE VOCABULARY, AND THE TYPE IS READ OUT OF IT.
//
// This was a union with a hand-written copy of all eleven members living in
// `server/harness-config.ts` as `new Set<ToolKind>([ … ])`. Naming the type
// inside the type argument reads as a check and is not one: a set holding
// FEWER members is assignable, so a twelfth kind added here and forgotten
// there compiled with zero errors in both programs — driven, `tsc -p
// tsconfig.server.json` and `tsc -p tsconfig.json` both exit 0 — while a
// config naming the new kind failed the set's membership test and fell
// through to the catch-all default. Accepted upstream, silently dropped at
// the one place that still believed there were eleven.
//
// With `typeof TOOL_KINDS[number]` there is no second declaration to forget.
export const TOOL_KINDS = [
  "filesystem",
  "editor",
  "intelligence",
  "memory",
  "quality",
  "git",
  "system",
  "network",
  "mcp",
  "extension",
  "artifact",
] as const;

export type ToolKind = typeof TOOL_KINDS[number];
