/**
 * A FILE, ASKED FOR FROM OUTSIDE THE EDITOR — the one-shot seam a
 * path travels through to become an open file in the editor room.
 *
 * Two callers exist and neither has (or should have) a handle into the
 * room's internals: a path chip on a tool beat (flow/ToolBeat.svelte), and
 * the shell honoring a `ShellViewRequest` that carries a path
 * (Cockpit.svelte ← shell/view-request.ts, the LLM `control_interface`
 * pipeline). Both write HERE; the EditorRoom consumes while it is on screen
 * and opens the path through its OWN open mechanism — the same probe-first
 * `openFile` a tree click lands in — so an externally-asked file and a
 * clicked file cannot diverge in behaviour (large-file gating, honest
 * absences, draft parking: all of it comes free, once).
 *
 * Same one-shot contract as the shell's view seam and the settings index
 * query (settings-feed.ts::pendingIndexQuery): the request is an atom,
 * consuming clears it, and a request that outlived the surface that should
 * have honored it must not fire on a later mount — that would be a file
 * opening that nobody just asked for.
 *
 * The path may be absolute or project-relative; resolution against the
 * project root is the ROOM's job, because only the room knows its project.
 */

import { atom, type ReadableAtom } from "nanostores";

const pending = atom<string | null>(null);

/** Readable for the room's subscription (and for tests to observe). */
export const pendingEditorOpen: ReadableAtom<string | null> = pending;

/** Ask the editor to open a file. Overwrites an unconsumed earlier request —
 * the newest ask is the one the reader just made. */
export function requestEditorOpen(path: string): void {
  if (typeof path !== "string" || path.trim().length === 0) return;
  pending.set(path.trim());
}

/** Read-and-clear, called by the editor room when it acts. */
export function consumeEditorOpenRequest(): string | null {
  const current = pending.get();
  pending.set(null);
  return current;
}
