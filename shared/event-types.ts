/**
 * Shared event-kind vocabulary — the single source of truth for the
 * inline-event categories shown in the chat transcript (hallucination,
 * steering, bias, self-healing, error, ui_control). NO `@harness/*`
 * imports so the SERVER (NodeNext module resolution, no path aliases) can
 * import this file exactly like the client (mirrors
 * `shared/input-schemas.ts` + `shared/wire-types.ts`).
 *
 * SPO (eventKind drift): before  the eventKind vocabulary
 * was defined in FOUR inconsistent places:
 *  - `server/db/schema.ts` `MESSAGE_METADATA.eventKind: z.string()`
 *    (accepted ANY string — no validation; a typo would silently persist;
 *    the comment claimed "aligns with the client MessageMetadata type"
 *    but it did not — a lying comment),
 *  - `server/db/schema.ts` `MESSAGE_EVENT_METADATA.eventKind: z.enum([...])`
 *    (a 5-value inline enum, missing `ui_control`),
 *  - `server/routes/run.ts` `persistInlineEvent` param (a 4-value inline
 *    union — what the server actually persists),
 *  - `src/state/chat-messages.ts` `EventKind` (a 6-value inline union —
 *    the client view model, adding `error` + `ui_control`).
 * A new event kind added on one side without the other would silently
 * break the styling or the validation. moves the vocabulary HERE so
 * both the server zod schemas + the client type derive from the ONE
 * definition. The zod schema validates the persisted blob against the
 * canonical vocabulary (rejects typos + unknown values); the client type
 * narrows the persisted value + adds the transient view-model kinds.
 *
 * `error` + `ui_control` are included in the canonical vocabulary even
 * though the server does not persist them to the metadata blob (they are
 * transient client-side events: `error` is rendered via
 * `appendChatError`, `ui_control` via the `ui_control` SSE event —
 * neither is stored as a role="event" message). Including them makes the
 * schema forward-compatible (a future change that persists them needs no
 * schema migration) + keeps the client + server vocabularies identical
 * (no drift). The `z.infer` type is the EXACT `EventKind` union the
 * client consumes.
 */

import { z } from "zod";

/**
 * The canonical inline-event-kind vocabulary. The single owner — was
 * scattered across 4 inconsistent definitions (see file header). The
 * tuple form (`readonly ["...", ...]`) lets the zod enum + the TS union
 * both derive from the SAME literal list (no second declaration to drift).
 */
export const EVENT_KINDS = [
  "hallucination",
  "validation",
  "loop",
  "disabled",
  "steering",
  "bias",
  "self-healing",
  "safety-finding",
  "rewind",
  "restore",
  "error",
  "ui_control",
] as const satisfies readonly string[];

/**
 * The zod enum validating an eventKind value against the canonical
 * vocabulary. Used by the server's `MESSAGE_METADATA` (the persisted
 * blob) + `MESSAGE_EVENT_METADATA` (role="event" message metadata) so a
 * typo or an unknown value is rejected at the validation layer, not
 * silently persisted.
 */
export const EVENT_KIND_SCHEMA = z.enum(EVENT_KINDS);

/**
 * The inline-event-kind union. The single owner — was mirrored as
 * `src/state/chat-messages.ts` `EventKind` (a manual inline union) +
 * `server/routes/run.ts` `persistInlineEvent` param (a 4-value subset).
 * Both now derive from the zod-inferred type (one definition).
 */
export type EventKind = z.infer<typeof EVENT_KIND_SCHEMA>;

/**
 * The gate-block kinds the pre-dispatch safety gate can produce. The single
 * vocabulary owner — the server's `classifyGateBlock` (safety-bridge.ts)
 * returns one of these, and the client reads the same union off the SSE
 * payload, so neither side restates the list (a new kind added here surfaces
 * as a compile error at every unmapped consumer).
 */
export type GateBlockKind = "ghost_tool" | "schema_mismatch" | "loop" | "tool_disabled";

/**
 * A gate block's kind → the inline-event label the chat shows for it. This is
 * the ONE place a gate block's kind becomes a user-facing label, so the two
 * can never disagree and a new gate-block kind cannot ship unlabeled (the
 * `Record<GateBlockKind, …>` shape is a compile error until it is mapped).
 *
 * The label answers "why did the harness intervene?" — the tool call's own
 * failed card already answers "did the call fail". Naming the intervention
 * honestly is what keeps a schema-validation failure from being reported as
 * a hallucination:
 *
 *   ghost_tool      → "hallucination" — the model called a tool that does not
 *                     exist; it invented a capability. A genuine hallucination.
 *   schema_mismatch → "validation"    — the tool exists; the ARGUMENTS failed
 *                     the tool's own schema. A validation failure, not an
 *                     invented capability.
 *   loop            → "loop"          — the same call repeated past the
 *                     threshold; a loop, neither a hallucination nor a schema
 *                     fault.
 *   tool_disabled   → "disabled"      — the tool was auto-tripped for the
 *                     rest of the run after a streak of identical blocked
 *                     calls; the refusal states a standing fact about the
 *                     tool, not a verdict about THIS call's arguments.
 */
export const GATE_BLOCK_EVENT_KIND: Readonly<Record<GateBlockKind, EventKind>> = Object.freeze({
  ghost_tool: "hallucination",
  schema_mismatch: "validation",
  loop: "loop",
  tool_disabled: "disabled",
});

/**
 * The user-facing inline-event label for a gate-blocked call. Unknown kinds
 * are denied (deny-by-default): a kind the map does not recognise is a wiring
 * bug, so this throws rather than silently labeling it "hallucination".
 */
export function gateBlockEventKind(kind: GateBlockKind): EventKind {
  const label = GATE_BLOCK_EVENT_KIND[kind];
  if (label === undefined) {
    throw new Error(`unknown gate-block kind: ${String(kind)}`);
  }
  return label;
}
