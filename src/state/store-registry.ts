/**
 * Store reset registry — the SINGLE owner of the auto-registering
 * store-reset mechanism (SPO: "Relieve Responsibilities" + * "Store management").
 *
 * THE PROBLEM (RIGID solution, pre-): `resetAllStores` in
 * `reset-all.ts` was a MANUALLY-MAINTAINED list of 21 `resetXxx` calls.
 * "Relieve Responsibilities" explicitly calls this out as a
 * RIGID solution: "if someone adds a new store and forgets to add it to
 * `resetAllStores`, the same security hole recurs. The DYNAMIC solution:
 * stores AUTO-REGISTER into a registry; the reset iterates the registry
 * dynamically; adding a new store = automatically covered." Forgetting is
 * impossible because you NEVER HAD TO REMEMBER a line in a remote file.
 *
 * THE FIX (DYNAMIC solution, ): each store module self-registers its
 * reset function at module load via `registerReset(name, fn)` (a side-effect
 * co-located with the reset fn definition — natural locality). This module
 * owns the registry `Map<string, () => void>`. `resetAllStores` iterates
 * the registry DYNAMICALLY — there is NO manually-maintained call list in
 * `reset-all.ts`. Adding a new store = call `registerReset` once in the
 * store module = automatically covered by logout reset.
 *
 * POPULATION: the registry is populated by side-effect when store modules
 * are loaded. In the browser, the app loads every store via component
 * imports (normal operation). For the test environment (vitest imports
 * `resetAllStores` directly), `reset-all.ts` triggers loading of EVERY
 * store module anywhere under `src/state/` via an eager, RECURSIVE
 * `import.meta.glob` (Vite-native dynamic discovery — no manual import
 * list) so the self-registrations run. A new store module is picked up
 * automatically — no edit to `reset-all.ts` needed — INCLUDING one placed
 * in a subdirectory, which the previous non-recursive pattern silently
 * skipped, leaving that store unreset on logout.
 *
 * DENY-BY-DEFAULT: the mechanical test
 * `tests/prevention/frontend-stores-deep.test.ts` dynamically discovers
 * every store via `readdirSync` and verifies (a) each store with
 * a writable atom has a reset fn, (b) that reset fn is registered via
 * `registerReset` in the store source, (c) `resetAllStores` iterates the
 * registry (not a hardcoded call list). A forgotten store is caught
 * mechanically — the default state is "not registered" (you must
 * EXPLICITLY call `registerReset`).
 *
 * Pure module — no imports, no side-effects beyond the Map. This keeps it
 * cycle-free: stores import `registerReset` from here; this module imports
 * nothing. The glob that loads the stores lives in `reset-all.ts` (the
 * owner), not here, so importing `registerReset` never triggers the glob.
 */

/** The registry: store name → its no-arg reset function. Insertion-ordered. */
const resetFns: Map<string, () => void> = new Map();

/**
 * A SEPARATE registry for context-switch resets (chat/project switch).
 * Snapshot stores that show per-chat data (quality, dedup, etc.)
 * self-register here via `registerContextReset`. When the chat changes,
 * `resetContextStores` iterates this registry dynamically — every
 * registered snapshot store resets itself. This is the same DYNAMIC
 * auto-registration pattern as the logout registry above, but for
 * context-switch reset (not logout reset). Adding a new snapshot store
 * = call `registerContextReset` once = automatically resets on chat
 * switch. No handler needs to manually call each store's reset — the
 * stores handle it themselves via the registry.
 */
const contextResetFns: Map<string, () => void> = new Map();

/**
 * Self-register a store's reset function. Called once at module load by
 * each store module that owns a writable atom + a `reset*`/`clear*` fn.
 * Co-located with the reset fn definition so the registration is natural
 * (define `resetAuth`, then `registerReset("auth", resetAuth)` on the next
 * line — no remote file to remember). Re-registering the same name
 * overwrites (defensive: a module loaded twice in a hot-reload cycle does
 * not duplicate the entry).
 */
export function registerReset(name: string, fn: () => void): void {
  resetFns.set(name, fn);
}

/**
 * Reset EVERY registered store to its initial/empty state by iterating the
 * registry DYNAMICALLY. Called by `src/client.ts::submitLogout` (via the
 * re-export in `reset-all.ts`) after the server logout request + after
 * closing any active SSE stream. After this call, no store holds the
 * previous user's data — a re-login as a different user starts from a
 * clean slate. Idempotent + order-independent: each store's reset only
 * touches that store's writable atoms; derived stores recompute from the
 * reset sources.
 *
 * This is the DYNAMIC owner: there is NO hardcoded call list here. The
 * registry is populated by the stores' own `registerReset` side-effects.
 * A new store is covered automatically once it self-registers.
 */
export function resetAllStores(): void {
  for (const fn of resetFns.values()) {
    fn();
  }
}

/**
 * The names of every registered store reset (for diagnostics + the
 * mechanical test). Returns a snapshot array (defensive copy) so callers
 * cannot mutate the registry via the returned reference.
 */
export function registeredResetNames(): readonly string[] {
  return [...resetFns.keys()];
}

/**
 * Clear the registry. Test-only: vitest may reuse the module graph across
 * test files; a stale registry from a prior test file would let
 * `resetAllStores` call fns whose atoms were never populated in the
 * current file. Clearing before re-populating keeps each test file
 * hermetic. NOT called by production code (the registry is populated once
 * per page load + reused for the session).
 *
 * Under `isolate: false` the module registry is shared across files, so a
 * store module's top-level `registerReset` side-effect runs ONCE per worker.
 * Clearing destroys the entries; re-importing the store modules does NOT
 * re-run the side-effect (the modules are cached). Tests that need an
 * isolated registry (e.g. to verify `resetAllStores` calls a sentinel fn
 * without the real stores also running) should use `snapshotResetRegistry`
 * + `restoreResetRegistry` instead of `clearResetRegistry` so the registry
 * is repopulated for subsequent files.
 */
export function clearResetRegistry(): void {
  resetFns.clear();
}

/**
 * Snapshot the reset registry (test-only). Returns a defensive copy of the
 * registry Map so a test can mutate the live registry (e.g. clear it for an
 * isolated sentinel run) + later restore the exact prior state. This is
 * the `isolate: false`-safe isolation primitive: unlike `clearResetRegistry`
 * (which destroys entries that cannot be re-populated because the store
 * modules' top-level side-effects run once per worker), snapshot/restore
 * preserves the worker's registry state across the mutation.
 */
export function snapshotResetRegistry(): ReadonlyMap<string, () => void> {
  return new Map(resetFns);
}

/**
 * Restore the reset registry from a snapshot (test-only). Replaces the live
 * registry with the snapshot's entries. Pairs with `snapshotResetRegistry`
 * so a test can mutate the registry in isolation + restore the prior state,
 * keeping the registry populated for subsequent test files under
 * `isolate: false`.
 */
export function restoreResetRegistry(snapshot: ReadonlyMap<string, () => void>): void {
  resetFns.clear();
  for (const [name, fn] of snapshot) {
    resetFns.set(name, fn);
  }
}

// ── Context-switch reset (chat/project switch) ──

/**
 * Self-register a snapshot store's reset function for context-switch
 * (chat/project change) reset. Called once at module load by each
 * snapshot store that shows per-chat data (quality, dedup, etc.).
 * When the chat changes, `resetContextStores` iterates this registry
 * dynamically — the store resets itself. This is the DYNAMIC solution to
 * the stale quality/dedup data on chat switch bug: previously
 * App.svelte manually called `setQualitySnapshot(null)` +
 * `setDedupSnapshot(null)` in the chatId effect — a RIGID solution where
 * a new snapshot store that forgot to add its reset call would show stale
 * data. Now the store self-registers, and the chat-change signal calls
 * `resetContextStores` once — every registered store resets, with no
 * manual per-store call needed.
 */
export function registerContextReset(name: string, fn: () => void): void {
  contextResetFns.set(name, fn);
}

/**
 * Reset EVERY registered context-switch snapshot store by iterating the
 * registry DYNAMICALLY. Called by the chat-change signal (wired in
 * `reset-all.ts`) when `currentChatId` changes. After this call, no
 * snapshot store holds the previous chat's data — the dashboard reflects
 * the newly-selected chat, not the previous chat's last run. Idempotent +
 * order-independent.
 *
 * This is the DYNAMIC owner: there is NO hardcoded call list here. The
 * registry is populated by the stores' own `registerContextReset`
 * side-effects. A new snapshot store is covered automatically once it
 * self-registers.
 */
export function resetContextStores(): void {
  for (const fn of contextResetFns.values()) {
    fn();
  }
}

/**
 * The names of every registered context-switch reset (for diagnostics +
 * the mechanical test). Returns a snapshot array (defensive copy).
 */
export function registeredContextResetNames(): readonly string[] {
  return [...contextResetFns.keys()];
}

/**
 * Clear the context-reset registry. Test-only (same rationale as
 * `clearResetRegistry`). Under `isolate: false` prefer
 * `snapshotContextResetRegistry` + `restoreContextResetRegistry` so the
 * registry is repopulated for subsequent files.
 */
export function clearContextResetRegistry(): void {
  contextResetFns.clear();
}

/**
 * Snapshot the context-reset registry (test-only). Pairs with
 * `restoreContextResetRegistry` for `isolate: false`-safe isolation.
 */
export function snapshotContextResetRegistry(): ReadonlyMap<string, () => void> {
  return new Map(contextResetFns);
}

/**
 * Restore the context-reset registry from a snapshot (test-only).
 */
export function restoreContextResetRegistry(snapshot: ReadonlyMap<string, () => void>): void {
  contextResetFns.clear();
  for (const [name, fn] of snapshot) {
    contextResetFns.set(name, fn);
  }
}
