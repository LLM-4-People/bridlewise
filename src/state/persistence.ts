/**
 * Safe localStorage persistence for client-side UI selection state.
 *
 * Single owner of the read/write/subscribe-to-localStorage pattern. All
 * stores that need to survive a page refresh (project/chat selection, panel
 * visibility) go through these helpers so the pattern is defined once.
 *
 * In non-browser environments (Node tests, SSR) `localStorage` is absent;
 * the helpers degrade to no-ops so stores keep their in-memory defaults.
 */

import { clientLog } from "../client-debug";

const PREFIX = "bridlewise:";

/**
 * The raw storage key a logical key is stored under.
 *
 * Exported for ONE caller: the cross-tab owner (`cross-tab.ts`), which
 * receives `storage` events carrying RAW keys and has to map them back to
 * the logical names the stores use. The prefix stays defined exactly once,
 * here, rather than being re-spelled by the listener.
 */
export function storageKeyFor(key: string): string {
  return PREFIX + key;
}

function storage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch (err) {
    // localStorage access can throw in privacy/sandboxed modes — degrade to a
    // no-op cache (the in-memory store remains the source of truth). Routed
    // through the client debug owner (/zero-overhead when
    // debug is OFF; visible when the Settings toggle enables it). NOTE: the
    // old `console.debug` calls bypassed the centralized debug owner (the
    // -V3 flag); routes them through `clientLog` so the owner covers
    // ALL client modules, not just `.svelte` components.
    clientLog("persistence", "localStorage unavailable:", err);
    return null;
  }
}

export function persistGet(key: string): string | null {
  const s = storage();
  if (s === null) return null;
  try {
    return s.getItem(PREFIX + key);
  } catch (err) {
    // See storage — a read failure degrades to a cache miss. Routed
    // through the client debug owner.
    clientLog("persistence", "localStorage read failed:", err);
    return null;
  }
}

// ── Foreign-write suppression (the cross-tab echo rule) ──────────────────
//
// When another tab's write arrives here (through `cross-tab.ts`) and a store
// adopts it, the store's own `.listen`/write-through would immediately write
// the same value BACK to storage. That echo is not merely wasted work: it
// re-stamps this tab as the last writer of a value it did not choose, which
// is how two tabs end up shoving one key back and forth.
//
// The rule is enforced HERE rather than being remembered by each of the eight
// adopters, because "do not write back a value you were told about" is a
// property of persistence, not of any one store. During adoption `persistSet`
// is a no-op; reads are untouched (a reader still sees the truth).

let adoptingForeign = false;

/** True while a store is adopting a value that came from another tab. */
export function adoptingForeignWrite(): boolean {
  return adoptingForeign;
}

/**
 * Run `fn` with foreign-write suppression on. Re-entrant (nested adoptions
 * restore the outer state) and exception-safe — a throwing adopter must not
 * leave persistence permanently muted.
 */
export function withForeignAdoption<T>(fn: () => T): T {
  const previous = adoptingForeign;
  adoptingForeign = true;
  try {
    return fn();
  } finally {
    adoptingForeign = previous;
  }
}

export function persistSet(key: string, value: string | null | (() => string)): void {
  if (adoptingForeign) return;
  const s = storage();
  if (s === null) return;
  try {
    if (value === null) s.removeItem(PREFIX + key);
    else s.setItem(PREFIX + key, typeof value === "function" ? value() : value);
  } catch (err) {
    // localStorage quota exceeded or privacy mode — the in-memory store
    // remains the source of truth; persistence is a best-effort cache.
    // Routed through the client debug owner.
    clientLog("persistence", "localStorage write failed:", err);
  }
}

/**
 * Bind a nanostores atom to localStorage: on every `.set` the value is
 * persisted; `restoreAtom` reads the persisted value back. Only string
 * atoms are supported; use a serializer for complex values.
 */
import type { WritableAtom } from "nanostores";

export function bindAtomPersistence(
  atom: WritableAtom<string | null>,
  key: string,
): void {
  atom.listen((value) => persistSet(key, value));
}

/**
 * Cached-then-revalidate for LIST stores (web-native correction, cockpit
 * v2.1): a page revisit paints the last visit's known list instantly from
 * localStorage while the boot fetch revalidates against the server and
 * replaces it. The cache is only ever written from a SERVER response (the
 * store's real setter), so it can be stale but never invented — and the
 * consumer is expected to say "as of your last visit" until the live read
 * lands. Returns the cached value (or null) so callers can seed synchronously.
 */
export function restoreJsonList<T>(key: string): readonly T[] | null {
  const raw = persistGet(key);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as readonly T[]) : null;
  } catch {
    persistSet(key, null); // a corrupt cache is worse than none
    return null;
  }
}

export function persistJsonList<T>(key: string, value: readonly T[] | (() => readonly T[])): void {
  persistSet(key, () => JSON.stringify(typeof value === "function" ? value() : value));
}

/** Discover scoped lists once on page load; each project can then persist
 * its own answer without serializing every other project's conversations. */
export function restoreJsonLists<T>(prefix: string): ReadonlyMap<string, readonly T[]> {
  const result = new Map<string, readonly T[]>();
  const s = storage();
  if (s === null) return result;
  const rawPrefix = PREFIX + prefix;
  try {
    for (let i = s.length - 1; i >= 0; i -= 1) {
      const key = s.key(i);
      if (key === null || !key.startsWith(rawPrefix)) continue;
      const raw = s.getItem(key);
      if (raw === null) continue;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) result.set(key.slice(rawPrefix.length), parsed as T[]);
      } catch {
        if (!adoptingForeign) s.removeItem(key);
      }
    }
  } catch (err) {
    clientLog("persistence", "localStorage scoped read failed:", err);
  }
  return result;
}

/** Logout/replacement clears owned shared cache entries, never tab state. */
export function persistRemovePrefixed(prefix: string): number {
  return adoptingForeign ? 0 : removePrefixed(storage(), prefix);
}

export function restoreStringAtom(
  atom: WritableAtom<string | null>,
  key: string,
): void {
  const value = persistGet(key);
  if (value !== null) atom.set(value);
}

export function restoreBooleanAtom(
  atom: WritableAtom<boolean>,
  key: string,
): void {
  const value = persistGet(key);
  if (value !== null) atom.set(value === "true");
}

export function persistBooleanAtom(
  atom: WritableAtom<boolean>,
  key: string,
): void {
  atom.listen((value) => persistSet(key, String(value)));
}

// (The number-atom pair left with its one consumer — the old resizable
// layout's width atoms.)

// ── PER-TAB persistence (sessionStorage), with a localStorage SEED ────────
//
// Some state is not "how this person likes the cockpit" but "what THIS tab is
// working on" — the open project and conversation. Persisting those in
// localStorage made every tab share one slot: two tabs each wrote it on every
// selection, the later write won, and neither tab noticed. Two cockpits then
// disagreed about what they were showing, silently.
//
// `sessionStorage` is the built-in for exactly this shape. It is per-tab by
// definition (a new tab starts empty), it survives a RELOAD of that tab, and
// it is discarded when the tab closes — which is the same lifetime as "what
// this tab is working on". No custom tab-id, no registry of live tabs.
//
// The localStorage value is kept as a SEED: a brand-new tab has no session
// value, so it opens on the last thing chosen anywhere. That is what preserves
// the existing "reload returns you to your conversation" behaviour for the
// single-tab user, who is most users, and it is also the whole migration path
// — someone with a localStorage value today gets it as their first tab's seed
// and never sees a change. Nothing is copied, cleared or rewritten on upgrade.
//
// A seed write is last-write-wins between tabs and that is CORRECT here: the
// seed is only ever read by a tab that does not exist yet, so a later write
// cannot move a tab that is already open.

function tabStorage(): Storage | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    return sessionStorage;
  } catch (err) {
    // Same degradation as localStorage: privacy/sandbox modes throw on
    // access. The in-memory store stays the source of truth.
    clientLog("persistence", "sessionStorage unavailable:", err);
    return null;
  }
}

/**
 * Read this TAB's value, falling back to the shared seed when the tab has
 * none of its own (a brand-new tab, or a browser with no sessionStorage).
 */
export function persistTabGet(key: string): string | null {
  const s = tabStorage();
  if (s !== null) {
    try {
      const own = s.getItem(PREFIX + key);
      if (own !== null) return own;
    } catch (err) {
      clientLog("persistence", "sessionStorage read failed:", err);
    }
  }
  return persistGet(key);
}

/**
 * Write this TAB's value AND refresh the shared seed. The seed write goes
 * through `persistSet`, so it inherits the foreign-write suppression above:
 * adopting another tab's value never re-stamps the seed.
 */
export function persistTabSet(key: string, value: string | null): void {
  const s = tabStorage();
  if (s !== null) {
    try {
      if (value === null) s.removeItem(PREFIX + key);
      else s.setItem(PREFIX + key, value);
    } catch (err) {
      clientLog("persistence", "sessionStorage write failed:", err);
    }
  }
  persistSet(key, value);
}

/**
 * Read/write a value that belongs to THIS browser tab and must NOT fall back
 * to — or refresh — the shared seed.
 *
 * The workspace list is the case that needs this: a brand-new browser tab
 * inheriting another tab's whole set of open tabs is exactly the shared-slot
 * behaviour being removed. Only the seed PAIR is allowed to cross; the set of
 * open tabs is not. Kept here rather than in the caller so `sessionStorage`
 * and the key prefix still have one owner.
 */
export function persistTabOnlyGet(key: string): string | null {
  const s = tabStorage();
  if (s === null) return null;
  try {
    return s.getItem(PREFIX + key);
  } catch (err) {
    clientLog("persistence", "sessionStorage read failed:", err);
    return null;
  }
}

export function persistTabOnlySet(key: string, value: string | null): boolean {
  const s = tabStorage();
  if (s === null) return false;
  try {
    if (value === null) s.removeItem(PREFIX + key);
    else s.setItem(PREFIX + key, value);
    return true;
  } catch (err) {
    clientLog("persistence", "sessionStorage write failed:", err);
    return false;
  }
}

/**
 * Remove every value in THIS TAB's storage whose logical key starts with
 * `prefix` — the sweep a close path uses for scoped state whose owner no
 * longer exists (a closed workspace's per-view mirrors). `keep`, when
 * given, receives each candidate's LOGICAL key and returns `true` to
 * PRESERVE it, so one sweep can clean a prefix while sparing live owners
 * inside it.
 *
 * The prefix is LOGICAL (un-prefixed), like every other door here, and the
 * sweep touches ONLY this tab's sessionStorage: the values it clears are
 * per-tab by definition, and the shared localStorage seed is not theirs to
 * drop. Returns how many keys were removed.
 *
 * Iterates BACKWARDS on purpose: `Storage` indexes live-update as items are
 * removed, so a forward walk would skip the item that shifts into the index
 * it just left behind.
 */
export function persistTabOnlyRemovePrefixed(
  prefix: string,
  keep?: (logicalKey: string) => boolean,
): number {
  return removePrefixed(tabStorage(), prefix, keep);
}

function removePrefixed(
  s: Storage | null,
  prefix: string,
  keep?: (logicalKey: string) => boolean,
): number {
  if (s === null) return 0;
  const raw = PREFIX + prefix;
  let removed = 0;
  try {
    for (let i = s.length - 1; i >= 0; i -= 1) {
      const key = s.key(i);
      if (key === null || !key.startsWith(raw)) continue;
      if (keep !== undefined && keep(key.slice(PREFIX.length))) continue;
      s.removeItem(key);
      removed += 1;
    }
  } catch (err) {
    clientLog("persistence", "storage sweep failed:", err);
  }
  return removed;
}

/** Restore a string atom from this tab's value (or the seed). */
export function restoreTabStringAtom(
  atom: WritableAtom<string | null>,
  key: string,
): void {
  const value = persistTabGet(key);
  if (value !== null) atom.set(value);
}

/** Bind a string atom's writes to this tab's storage + the shared seed. */
export function bindAtomTabPersistence(
  atom: WritableAtom<string | null>,
  key: string,
): void {
  atom.listen((value) => persistTabSet(key, value));
}
