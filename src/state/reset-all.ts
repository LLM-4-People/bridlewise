/**
 * The SINGLE owner of client-side store reset on logout (SPO → ).
 *
 * ("Single-Party-Owner Principle" + "Relieve
 * Responsibilities" + "Store management"): every nanostores writable atom
 * in `src/state/` that holds user-originating OR session-originating data
 * is reset through ONE canonical function — `resetAllStores` — so a logout
 * cannot leave a previous user's data in any store. Before 
 * `submitLogout` reset ONLY `authState` (`authState.set(initialAuth)`) and
 * left every other store (projects, chats, messages, run-state, metrics,
 * memory, timeline, auto-checks, tools, schema-store, quality, code-index,
 * ui-layout, config, models, errors, route) holding the previous user's
 * data. After logout + re-login as a DIFFERENT user on the same tab, the
 * new user briefly saw the previous user's projects/chats/messages — a
 * cross-user client-state data leak (-B1, CRITICAL).
 *
 * fixed the leak with a MANUALLY-MAINTAINED list of 21 `resetXxx`
 * calls. "Relieve Responsibilities" calls that a RIGID solution:
 * "if someone adds a new store and forgets to add it to `resetAllStores`,
 * the same security hole recurs." replaces it with the DYNAMIC
 * solution: stores AUTO-REGISTER their reset fn into a registry
 * (`src/state/store-registry.ts::registerReset`); `resetAllStores`
 * iterates the registry DYNAMICALLY. Adding a new store = call
 * `registerReset` once in the store module = automatically covered. No
 * line to add here. Forgetting is impossible because you NEVER HAD TO
 * REMEMBER ("Relieve Responsibilities").
 *
 * POPULATION: this
 * module triggers loading of EVERY store module anywhere under
 * `src/state/` via an eager, RECURSIVE `import.meta.glob` (Vite-native) —
 * subdirectories included; see the loader below. When a
 * store module loads, its top-level `registerReset(...)` side-effect runs,
 * populating the registry. In the browser, the app already loads every
 * store via component imports; the glob guarantees the registry is also
 * fully populated in the test environment (vitest imports `resetAllStores`
 * directly without going through component imports). A new store file that
 * calls `registerReset` is picked up automatically — no edit here needed.
 *
 * `resetAllStores` is re-exported from `store-registry.ts` (the pure
 * registry owner). `src/client.ts::submitLogout` imports it from here (the
 * single reset owner) — the call path is unchanged from ; only the
 * internal mechanism changed (manual list → dynamic registry iteration).
 *
 * Deny-by-default: the mechanical test
 * `tests/prevention/frontend-stores-deep.test.ts` verifies (a) this module
 * re-exports `resetAllStores` from `./store-registry`, (b) this module
 * contains the `import.meta.glob` dynamic loader, (c) this module does NOT
 * contain a manually-maintained `resetXxx` call list (the rigid pattern
 * removed), (d) every store with a writable atom self-registers its
 * reset fn.
 */

// Re-export the dynamic reset owner. `submitLogout` (client.ts) imports
// `resetAllStores` from this module — the single reset entry point.
export { resetAllStores } from "./store-registry";

// Re-export the context-switch reset owner so the chat-change signal
// wiring (below) + tests can import it from the single reset owner.
export { resetContextStores } from "./store-registry";

// DYNAMIC loader: eagerly import EVERY store module so its
// top-level `registerReset(...)` side-effect runs + populates the registry.
// This is the ONLY place the store set is referenced — and it is a GLOB,
// not a manual list. A new store that self-registers is picked up
// automatically (Vite resolves the glob at build time; vitest resolves it
// at test time).
//
// THE PATTERN IS RECURSIVE (globstar), AND THAT IS A SECURITY PROPERTY.
// It used to match one directory level only, so a store moved into a
// subdirectory of `src/state/` was never imported, never self-registered,
// and therefore NEVER RESET ON LOGOUT: the previous user's data survived
// into the next user's session on the same tab. Nothing said so, because a
// store that is not loaded is not missing from anything — it is absent from
// the registry AND absent from every count taken of the registry. Grouping
// state modules into folders is an ordinary, encouraged refactor; it must
// not be able to silently un-protect a store.
//
// The pattern is not spelled out in this comment on purpose: a glob literal
// in a comment opens a block comment to the regex-based comment stripper the
// guards share, which then eats the code below it and reports the loader as
// absent. The guard that judges this line reads what the glob MATCHED.
const _storeModules = import.meta.glob("./**/*.ts", { eager: true });
void _storeModules;

/**
 * THE PATHS THE LOADER ABOVE ACTUALLY MATCHED — the glob's OUTPUT, not its
 * text.
 *
 * Every guard over this mechanism used to check the glob's SOURCE STRING and
 * then compute its own expectation with a NON-RECURSIVE directory listing —
 * the same blind spot the subject had. An expectation computed the same way
 * as the subject can only ever agree with it, so `expected − registered` was
 * empty by construction and the guards were silent about the one thing that
 * mattered: what the glob matched.
 *
 * Exporting the matched keys lets a guard compare them against an
 * INDEPENDENT recursive walk of the directory on disk. Two mechanisms, one
 * question, and a disagreement is a finding rather than an accident.
 */
export function loadedStoreModulePaths(): readonly string[] {
  return Object.keys(_storeModules).sort();
}

// ── Chat-change signal: auto-reset snapshot stores on context switch ──
//
// THE PROBLEM (prior RIGID fix): App.svelte's chatId `$effect` manually
// called `setQualitySnapshot(null)` + `setDedupSnapshot(null)` on chat
// switch. This is a RIGID solution — if a new snapshot store is added and
// the effect doesn't call its reset, the same stale-data bug recurs.
//
// THE FIX (DYNAMIC): snapshot stores self-register via
// `registerContextReset` (in their module). When `currentChatId`
// changes, the signal fires `resetContextStores` which iterates the
// registry DYNAMICALLY — every registered snapshot store resets itself.
// Adding a new snapshot store = call `registerContextReset` once = it
// resets on chat switch automatically. The App.svelte handler no longer
// needs to manually call each store's reset — the stores handle it
// themselves via the registry. Forgetting is impossible because you NEVER
// HAD TO REMEMBER a reset call in the handler.
//
// The listen is set up AFTER the glob (above) so the stores are registered
// before the signal can fire. The callback fires synchronously on
// `currentChatId.set` — BEFORE Svelte's `$effect` runs — so the snapshots
// reset before the new chat history loads (the dashboard reflects the new
// chat, not the old chat's last run). On the initial load (null → chat-1)
// the snapshots are already null, so the reset is a no-op. On logout
// (chat-1 → null) the reset fires, but `resetAllStores` also fires — the
// double reset is harmless (idempotent).
import { currentChatId } from "./chats";
import { resetContextStores as _resetContextStores } from "./store-registry";

currentChatId.listen(() => {
  _resetContextStores();
});
