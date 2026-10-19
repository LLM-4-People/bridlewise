/**
 * CROSS-TAB — the one place a change made in ANOTHER browser tab of this
 * browser becomes a change in THIS one.
 *
 * THE DEFECT THIS CLOSES. Eight modules write localStorage and nothing
 * listened. Two tabs open on the same cockpit each held their own copy of the
 * pins, the marks, the armed triggers, the theme and the density; each wrote
 * the same keys on every change; the later write won and neither tab noticed.
 * The result was two cockpits quietly disagreeing — the failure class this
 * project refuses everywhere else. A person who pinned a monitor in one tab
 * and then worked in the other was looking at a screen that was wrong, with
 * nothing on it saying so.
 *
 * WHY THE `storage` EVENT AND NOT `BroadcastChannel`. Both are built-ins, so
 * the machinery budget does not decide it. What decides it is which one can
 * LIE.
 *
 *   - `storage` fires FROM the write. The browser emits it in other documents
 *     of the same origin only when a value actually changed in localStorage.
 *     It cannot fire for a write that did not land, and a write cannot land
 *     without it firing. The notification and the truth are the same event.
 *   - `BroadcastChannel` is an independent message bus. A tab would `postMessage`
 *     next to each write, and the two can disagree: this codebase already
 *     tracks storage that REFUSES writes (quota, private mode — see
 *     `monitorStorageDegraded`, `marksStorageDegraded`), and in exactly that
 *     case a BroadcastChannel tab would announce a pin that was never stored.
 *     Every other tab would then show a monitor that vanishes on reload. That
 *     is a new way to be silently wrong, bought to avoid re-reading a string.
 *
 * The state that must converge here is ALREADY localStorage state with a
 * single write path. So the platform's own change notification for that store
 * is the mechanism, and `BroadcastChannel` would be a second channel to keep
 * in step with the first — the custom machinery the standing rule sends us
 * away from.
 *
 * WHAT THIS MODULE IS NOT. It does not decide what converges; each store's
 * owner registers for its own key and adopts the value in the way only that
 * owner knows (a theme re-applies to the DOM, a ledger merges rather than
 * replaces). This module owns the LISTENER — one `addEventListener`, one key
 * map, one dispatch — so there is one place to look for "does a change here
 * travel between tabs", and one place that cannot be forgotten.
 *
 * ECHO. Adoption runs inside `withForeignAdoption`, which mutes `persistSet`
 * for its duration (see `persistence.ts`). Without it every adopter's
 * write-through would immediately re-write the value it was just told about,
 * re-stamping this tab as the last writer of a choice it did not make.
 *
 * @see src/state/persistence.ts — the storage owner this sits beside
 * @see src/state/workspaces.ts — the state that deliberately does NOT converge
 */

import { atom } from "nanostores";

import { storageKeyFor, withForeignAdoption } from "./persistence";
import { registerReset } from "./store-registry";
import { clientWarn } from "../client-debug";

/**
 * What an adopter receives: the raw stored string another tab wrote, or
 * `null` when the key was removed (or the whole store cleared).
 *
 * Deliberately the RAW string rather than a parsed value: the owner already
 * has the parse-and-validate function it uses at boot, and reusing it is what
 * keeps a foreign write held to exactly the same standard as a stored one. A
 * corrupt blob from another tab degrades the same way a corrupt blob on disk
 * does.
 */
export type ForeignWrite = (raw: string | null) => void;

const adopters = new Map<string, ForeignWrite[]>();

let listening = false;

/**
 * Register a handler for another tab's write of `logicalKey` (the same key
 * the owner passes to `persistGet`/`persistSet` — the prefix is applied here
 * through the storage owner, never re-spelled).
 *
 * Returns an unregister function. Registration is what BINDS the listener, so
 * a page that shares nothing never installs one.
 */
export function onForeignWrite(logicalKey: string, adopt: ForeignWrite): () => void {
  const raw = storageKeyFor(logicalKey);
  const list = adopters.get(raw) ?? [];
  list.push(adopt);
  adopters.set(raw, list);
  bindCrossTab();
  return () => {
    const current = adopters.get(raw);
    if (current === undefined) return;
    const next = current.filter((fn) => fn !== adopt);
    if (next.length === 0) adopters.delete(raw);
    else adopters.set(raw, next);
  };
}

/**
 * Register for a key stored WITHOUT the app prefix.
 *
 * Exists for one honest reason: `sessionStorage`-backed and legacy raw keys
 * are addressed by their literal name. Kept separate from `onForeignWrite`
 * rather than making the prefix a parameter, so a caller cannot accidentally
 * register for an unprefixed key that will never fire.
 */
export function onForeignRawWrite(rawKey: string, adopt: ForeignWrite): () => void {
  const list = adopters.get(rawKey) ?? [];
  list.push(adopt);
  adopters.set(rawKey, list);
  bindCrossTab();
  return () => {
    const current = adopters.get(rawKey);
    if (current === undefined) return;
    const next = current.filter((fn) => fn !== adopt);
    if (next.length === 0) adopters.delete(rawKey);
    else adopters.set(rawKey, next);
  };
}

/**
 * Epoch-ms of the last adopted foreign write, and how many landed. Not
 * decoration: it is the ONLY evidence this tab has that another tab of this
 * browser exists at all, and surfaces that want to say so must say it from
 * measured evidence rather than from a guess. `null` means nothing has ever
 * arrived — which is the honest state of a lone tab, and is NOT the same as
 * "no other tab is open" (a second tab that has changed nothing is
 * indistinguishable from no second tab, and neither this store nor any
 * surface may claim otherwise).
 */
export const lastForeignWriteAtMs = atom<number | null>(null);
export const foreignWritesAdopted = atom<number>(0);

function dispatch(rawKey: string, value: string | null): void {
  const list = adopters.get(rawKey);
  if (list === undefined || list.length === 0) return;
  withForeignAdoption(() => {
    for (const adopt of list) {
      try {
        adopt(value);
      } catch (err) {
        // One adopter throwing must not stop the others from converging, and
        // must not leave persistence muted (withForeignAdoption restores in a
        // `finally`). Reported, never swallowed silently.
        clientWarn("cross-tab", `adopting "${rawKey}" failed:`, err);
      }
    }
  });
  lastForeignWriteAtMs.set(Date.now());
  foreignWritesAdopted.set(foreignWritesAdopted.get() + 1);
}

function onStorage(event: StorageEvent): void {
  // sessionStorage also emits `storage` events (to same-tab documents such as
  // iframes). Per-tab state must never travel, so anything that is not the
  // shared store is ignored at the door.
  if (event.storageArea !== null && event.storageArea !== window.localStorage) return;
  if (event.key === null) {
    // `localStorage.clear()` — the spec reports it as a null key with no
    // value. Every registered key is now genuinely absent, so every adopter
    // is told so rather than being left holding a value that is gone.
    for (const rawKey of [...adopters.keys()]) dispatch(rawKey, null);
    return;
  }
  dispatch(event.key, event.newValue);
}

/**
 * Install the single listener. Idempotent, and called by registration — no
 * caller has to remember a boot step, and a second call cannot install a
 * second listener (which would adopt every write twice).
 */
export function bindCrossTab(): void {
  if (listening) return;
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  window.addEventListener("storage", onStorage);
  listening = true;
}

// There is deliberately NO teardown. The listener is passive, costs one
// function per storage write, and must outlive every session on the page:
// a sign-out that removed it would leave the signed-out screen quietly
// diverging from every other tab — the bug re-introduced at the one moment
// nobody is watching for it. Individual adopters unregister; the door does not.

/** Whether the listener is installed (guards + tests read this). */
export function crossTabBound(): boolean {
  return listening;
}

/**
 * Reset the EVIDENCE only, on sign-out. Deliberately NOT a teardown of the
 * listener: cross-tab coherence is a property of the browser, not of the
 * session, and a signed-out cockpit that stopped following the theme would be
 * a new divergence introduced by the fix. What must not survive a sign-out is
 * the count of what the previous person's other tabs did.
 */
export function resetCrossTabEvidence(): void {
  lastForeignWriteAtMs.set(null);
  foreignWritesAdopted.set(0);
}

registerReset("crossTab", resetCrossTabEvidence);
