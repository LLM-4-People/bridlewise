/**
 * A PLACE ON THE BAND, ASKED FOR FROM OUTSIDE THE SWEEP — the one-shot
 * seam a capture row's "go" travels through (the editor's open-request
 * shape, applied to the sweep).
 *
 * A captured range is a bookmark the record holds; going to it means the
 * same thing clicking one of the band's own marks means: plant the head
 * at that instant AND take the reader there (`Sweep.svelte`'s `setHead`
 * — the composite verb, plant + navigate, that a mark click runs). But
 * `setHead` is the sweep's private function, and the capture list lives
 * in the right menu's arm group — a shell-side surface with no handle
 * into the band. So the row writes HERE and the sweep consumes, running
 * the same verb its own controls run.
 *
 * Same one-shot contract as every pending seam: the request is an atom,
 * consuming clears it, and a request that outlived the surface that
 * should have honored it must not fire on a later mount — that would be
 * a time travel nobody just asked for. Planting at an instant is a READ
 * navigation, never a write: the past-view grammar governs what becomes
 * available, and this seam only moves the head.
 */

import { atom, type ReadableAtom } from "nanostores";

const pending = atom<number | null>(null);

/** Readable for the sweep's subscription (and for tests to observe). */
export const pendingBandGo: ReadableAtom<number | null> = pending;

/**
 * Ask the band to plant the head at an instant (epoch ms). A non-finite
 * ask is refused rather than planting the head at a fabricated time.
 */
export function requestBandGo(asOfMs: number): void {
  if (!Number.isFinite(asOfMs)) return;
  pending.set(asOfMs);
}

/** Read-and-clear, called by the sweep when it acts (or by a teardown). */
export function consumeBandGoRequest(): number | null {
  const current = pending.get();
  pending.set(null);
  return current;
}
