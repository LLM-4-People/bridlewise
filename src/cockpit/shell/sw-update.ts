/**
 * A NEW VERSION OF THE COCKPIT EXISTS, AND THE RUNNING PAGE IS TOLD.
 *
 * ── THE DEFECT THIS ENDS ──────────────────────────────────────────────────
 *
 * `public/sw.js` calls `skipWaiting()` + `clients.claim()`, so a freshly
 * deployed worker activates immediately — but the page that was ALREADY OPEN
 * keeps every module it loaded under the old worker. Registration in
 * `main.ts` had zero update listeners, so a running page would serve the old
 * bundle forever: the deploy was silent, and the only cure was a reload the
 * user had no reason to perform.
 *
 * ── WHAT COUNTS AS EVIDENCE OF AN UPDATE, precisely ───────────────────────
 *
 * Deny-by-default: the chip must never appear on a first install, so every
 * signal is qualified by "this page was already controlled":
 *
 *   1. `controllerchange` while the page ALREADY HAD a controller — the new
 *      worker took over a page the old one was serving. (A first
 *      registration also fires this, via `clients.claim()`, with no prior
 *      controller — that is the page becoming controlled, not an update.)
 *   2. `updatefound` → the incoming worker reaching `installed` while a
 *      controller exists — the update is staged; with skipWaiting it will
 *      activate on its own and (1) confirms, but the earlier signal lets the
 *      chip appear without waiting on the activation race.
 *   3. a `waiting` worker already present at registration time — an update
 *      that staged before this watch began (a browser may hold one there
 *      despite skipWaiting when registration raced).
 *
 * The one-shot store below is the SINGLE owner of "an update is ready";
 * the chip (`UpdateChip.svelte`) renders it and `main.ts` wires it. Applying
 * is a soft reload of the page — the only way a running module graph can
 * adopt a new bundle — and it happens ONLY on the reader's own click, never
 * automatically: an unasked reload throws away scroll position, composer
 * text and reading context for a deploy the reader did not schedule.
 */

import { atom, type ReadableAtom } from "nanostores";

export type SwUpdateReady = Readonly<{
  /** Soft-reload the page onto the new bundle. The reader's click, only. */
  apply: () => void;
}>;

const pending = atom<SwUpdateReady | null>(null);

/** Readable for the chip (and for tests to observe). */
export const swUpdateReady: ReadableAtom<SwUpdateReady | null> = pending;

/** The narrow slices of the real interfaces the watch needs — injectable so
 * the wiring is drivable in jsdom, where no real service worker exists. */
export type SwContainerLike = Readonly<{
  controller: unknown;
  addEventListener: (type: "controllerchange", fn: () => void) => void;
  removeEventListener: (type: "controllerchange", fn: () => void) => void;
}>;

export type SwWorkerLike = Readonly<{
  state: string;
  addEventListener: (type: "statechange", fn: () => void) => void;
}>;

export type SwRegistrationLike = Readonly<{
  waiting: SwWorkerLike | null;
  installing: SwWorkerLike | null;
  addEventListener: (type: "updatefound", fn: () => void) => void;
  removeEventListener: (type: "updatefound", fn: () => void) => void;
  /** The real registration's own unregister — the escape hatch needs it. */
  unregister: () => Promise<boolean>;
}>;

/**
 * Watch a registration for a NEW version superseding the one this page runs.
 * Returns the unbind. `reload` is what applying does — injectable because
 * jsdom's `location.reload` is not; production passes the real one.
 */
export function watchServiceWorkerUpdate(
  container: SwContainerLike,
  registration: SwRegistrationLike,
  reload: () => void,
): () => void {
  /**
   * THE ESCAPE HATCH FOR A PINNED PRE-EXEMPTION CONTROLLER — decided at
   * CLICK time, on the freshest evidence, not when the chip rose.
   *
   * A worker before the event-stream exemption intercepts the standing
   * liveness stream and `cache.put`s it; the put never settles, so that
   * worker can never be superseded — the fixed worker sits in the waiting
   * seat forever. Worse, the chip's plain reload cannot free the page: the
   * reloaded page re-opens the stream under the SAME old controller, which
   * re-pins it. Only detaching the page from the registration breaks the
   * loop: unregister (new navigations leave the old worker's control), then
   * reload — the page comes back uncontrolled, boot re-registers, and the
   * fixed worker installs into an empty seat.
   *
   * The DETECTION is the waiting-forever evidence class, not a version
   * probe: under any controller with the exemption, skipWaiting drains the
   * waiting seat within milliseconds of the chip rising — so a worker STILL
   * waiting when the reader's click arrives, seconds later, is one that
   * cannot activate. The only cost of a false positive is one uncontrolled
   * page load followed by a fresh registration, which converges to the same
   * place a plain reload does.
   *
   * This is the one-time v2 migration path: once no pre-exemption workers
   * remain in the wild, no worker can be pinned, the waiting seat is always
   * drained by click time, and this branch is dead code — removable then.
   */
  const apply = (): void => {
    if (registration.waiting !== null && wasControlled) {
      // Unregister NOW, reload when it settles — reloading first would
      // navigate back under the very controller being escaped. Reload on
      // either outcome: a failed unregister must not eat the click.
      let detaching: Promise<boolean>;
      try {
        detaching = registration.unregister();
      } catch {
        reload();
        return;
      }
      void detaching.then(() => reload(), () => reload());
      return;
    }
    reload();
  };

  const ready = (): void => {
    // One chip, however many signals confirm the same update.
    if (pending.get() !== null) return;
    pending.set({ apply });
  };

  // (1) The page was controlled and the controller CHANGED: the new worker
  // owns the page while the loaded modules are still the old bundle.
  let wasControlled = container.controller !== null && container.controller !== undefined;
  const onControllerChange = (): void => {
    if (wasControlled) ready();
    wasControlled = true;
  };
  container.addEventListener("controllerchange", onControllerChange);

  // (2) An incoming worker finishing its install while this page is
  // controlled — the staged update, announced without waiting on activation.
  const onUpdateFound = (): void => {
    const incoming = registration.installing;
    if (incoming === null) return;
    incoming.addEventListener("statechange", () => {
      if (incoming.state === "installed" && wasControlled) ready();
    });
  };
  registration.addEventListener("updatefound", onUpdateFound);

  // (3) An update already staged before the watch began.
  if (registration.waiting !== null && wasControlled) ready();

  return () => {
    container.removeEventListener("controllerchange", onControllerChange);
    registration.removeEventListener("updatefound", onUpdateFound);
  };
}

/** Test seam: a page cannot un-know an update, but a TEST must not leak one
 * into its neighbour. */
export function clearSwUpdateForTests(): void {
  pending.set(null);
}
