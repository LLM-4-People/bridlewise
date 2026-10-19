/**
 * A BEAT, ASKED FOR FROM OUTSIDE THE FLOW — the one-shot seam the right
 * menu's row paths travel through (the editor's open-request shape:
 * src/cockpit/editor/open-request.ts, the store that made a path chip able
 * to open a file without a handle into the room).
 *
 * The run pane's turn and call rows name facts by their MESSAGE id, and
 * the beat that fact lives in is `b-<message id>` (flow/ingest.ts
 * `beatIdFor`). But "what opening a beat means" is the FLOW's own
 * business — its scope sheet, its focus, its inline depth — and the pane
 * has no handle into any of that (it is a shell-side inspector, not a
 * flow component). So the pane writes HERE and the flow consumes, running
 * the SAME functions its own controls run, so an externally-asked beat
 * and a clicked beat cannot diverge in behaviour:
 *
 *   `scope`  — the turn row's ask: open the beat's fact sheet (the flow's
 *              `openBeat`, the same path the `scope` grip and ⏎ take).
 *   `reveal` — the call row's ask: focus the beat, scroll it into view and
 *              open its inline depth (the tool beats are sheetless by the
 *              beat-state ruling — the inline depth IS the deep surface).
 *
 * Same one-shot contract as every pending seam: the request is an atom,
 * consuming clears it, and a request that outlived the surface that
 * should have honored it must not fire on a later mount — that would be a
 * navigation nobody just asked for.
 */

import { atom, type ReadableAtom } from "nanostores";

/** What the asker wants the flow to do with the beat. */
export type BeatRequestKind = "scope" | "reveal";

/** One ask: a beat id (already `b-`-prefixed or a bare message id — the
 * flow's own `beatById` resolves both shapes) and the want. */
export type BeatRequest = Readonly<{
  id: string;
  want: BeatRequestKind;
}>;

const pending = atom<BeatRequest | null>(null);

/** Readable for the flow's subscription (and for tests to observe). */
export const pendingBeatRequest: ReadableAtom<BeatRequest | null> = pending;

/** Ask the flow to act on a beat. Overwrites an unconsumed earlier ask —
 * the newest ask is the one the reader just made. A blank id is refused
 * rather than navigating to nothing. */
export function requestBeatAction(id: string, want: BeatRequestKind): void {
  if (typeof id !== "string" || id.trim().length === 0) return;
  pending.set({ id: id.trim(), want });
}

/** Read-and-clear, called by the flow when it acts (or by a teardown). */
export function consumeBeatRequest(): BeatRequest | null {
  const current = pending.get();
  pending.set(null);
  return current;
}
