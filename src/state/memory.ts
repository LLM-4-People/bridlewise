/**
 * nanostores shared state: memory entries (present/short/long-term) with
 * full provenance.
 *
 * Plain.ts — Node-testable via Vitest without any Svelte compiler.
 *
 * Boundary rule: the memory LIST is backend-originating and is fed ONLY by
 * client.ts (setMemoryEntries). Components read the store reactively.
 *
 * The client-side MemoryEntryView is a MIRROR of the server wire shape
 * (server/memory-bridge.ts `MemoryEntryView`, produced by `toView`). The
 * server is the authoritative owner; this type MUST stay in sync with it
 * enforced by a contract test (tests/prevention/memory-rendering-
 * owner.test.ts) that compares the two type definitions' field names so a
 * drift (e.g. `createdAt` vs the server's `timestamp`) is caught
 * mechanically ("enforce exact contract tests against drift").
 * Memory is per-USER (v12 — not per-chat/session) — shown as a top-level
 * tab.
 *
 * @global-store per-user memory entries (not chat-scoped; shown as a top-level tab)
 */

import { atom, computed, type ReadableAtom } from "nanostores";

import { registerReset } from "./store-registry";

// ── Wire types (owned by shared/wire-types.ts) ──
//
// `MemorySource` + `MEMORY_SOURCES` + `MemoryTier` + `MEMORY_TIERS` +
// `MemoryEntryView` are owned by `shared/wire-types.ts` (the single
// wire-shape owner, imported by BOTH server + client — no drift).
// Re-exported here so existing `import { type MemoryEntryView,
// MEMORY_SOURCES } from "./state/memory"` paths are unchanged.
//
// `MEMORY_TIERS` USED TO BE DECLARED HERE, and its own doc comment said it
// existed so nothing "would silently miss a new tier" — while being a
// hand-written `readonly MemoryTier[]`, which is exactly the shape that CAN
// silently miss one: an array of two tiers is assignable to a type of three,
// so the compiler had nothing to say. Its type lived in `wire-types.ts` and
// its value lived here, and nothing joined them. Both now live at the owner,
// where the type is DERIVED from the array and the omission is
// unrepresentable rather than merely discouraged.
import type { MemorySource, MemoryTier, MemoryEntryView } from "../../shared/wire-types";
import { MEMORY_SOURCES, MEMORY_TIERS } from "../../shared/wire-types";
export type { MemorySource, MemoryTier, MemoryEntryView };
export { MEMORY_SOURCES, MEMORY_TIERS };

// ── Stores ──

export const memoryEntries = atom<readonly MemoryEntryView[]>([]);
export const memoryCount: ReadableAtom<number> = computed(
  memoryEntries,
  (list) => list.length,
);

// ── Ingestion ──

export function setMemoryEntries(list: readonly MemoryEntryView[]): void {
  memoryEntries.set(list);
}

/**
 * Reset the memory store to empty. Called by the single store-reset owner
 * (`resetAllStores`) on logout so a re-login as a DIFFERENT user does not
 * briefly see the previous user's memory entries (SPO: closes the
 * cross-user client-state leak flagged by -B1).
 */
export function resetMemory(): void {
  memoryEntries.set([]);
}

registerReset("memory", resetMemory);
