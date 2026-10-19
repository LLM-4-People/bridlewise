/**
 * WHAT THE SWITCH IS BEING ASKED FOR — one bit, owned in one place.
 *
 * The Switch (§5.2) has always meant "go here": choosing a conversation
 * REPLACES what the active workspace is showing. The `+` on the tab strip
 * asks the same question with a different answer in mind — "open this
 * somewhere new" — and the two must not become two pickers. A second
 * chooser would be a second place to fix, a second place to search, and a
 * second thing to learn, for a difference of one bit.
 *
 * So the bit lives here and the Switch reads it once, when the user picks
 * something. `take()` is deliberately read-AND-CLEAR: an intent that
 * outlived the choice it was armed for would turn the NEXT ⌘J into a
 * silent tab-opener, which is precisely the kind of mode this cockpit
 * refuses. Every other way of opening the Switch clears it explicitly, so
 * the default is the one that has always been true.
 *
 * @see src/cockpit/shell/WorkspaceStrip.svelte — the `+` that arms it
 * @see src/cockpit/rooms/SwitchRoom.svelte — the surface that consumes it
 */

import { atom, type ReadableAtom } from "nanostores";

export type OpenIntent =
  /** Choosing replaces what the active tab is showing (the original gesture). */
  | "replace"
  /** Choosing opens a NEW tab and leaves the current one alone (the `+`). */
  | "new-tab";

const intent = atom<OpenIntent>("replace");

/** Readable so a surface can SAY what the next choice will do (§ zero
 * knowledge: a mode nobody can see is a mode nobody can predict). */
export const openIntent: ReadableAtom<OpenIntent> = intent;

/** The `+` was pressed: the next choice opens a new tab. */
export function armNewTab(): void {
  intent.set("new-tab");
}

/** Any other way into the Switch (⌘J, the place chip, a verb). */
export function clearOpenIntent(): void {
  intent.set("replace");
}

/**
 * Read the armed intent and disarm in the same step. Called by the Switch at
 * the moment of the choice. Closing the room without choosing disarms too
 * (the shell calls `clearOpenIntent` from `closeRoom`), so an abandoned `+`
 * cannot leave a mode behind for the next ⌘J to walk into.
 */
export function takeOpenIntent(): OpenIntent {
  const current = intent.get();
  intent.set("replace");
  return current;
}
