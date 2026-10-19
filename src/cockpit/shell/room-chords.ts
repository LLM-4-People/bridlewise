/**
 * ROOM-LOCAL CHORDS — the second keyboard registry, made visible.
 *
 * WHY THIS FILE EXISTS. `keyboard.ts` holds the SHELL grammar (§2.7) and the
 * mouse-path guard reads it to prove that every chord has a discoverable
 * click path. That proof was only ever as wide as the table it reads, and it
 * turned out there was a second table nobody had written down: a room can
 * open its own capture-phase key listener and invent chords of its own. The
 * Switch did exactly that — ⌘N created a conversation and ⌘⇧N created a
 * project, with no control on screen doing either. The guard passed because
 * it had nothing to compare against, which is the worst way for a guard to
 * pass.
 *
 * So room-local chords are DECLARED here, and the rooms match against this
 * table rather than reading `ev.metaKey` themselves. Two things follow
 * mechanically:
 *
 *   1. every entry must have a control that names it (`data-room-chord`),
 *      interactive, titled, at the pointer-target floor — the same rule the
 *      shell grammar already lives under (MOUSE-FIRST law, v2.1);
 *   2. a room that reaches for the platform modifier directly is a room
 *      building a private registry again, and the guard says so.
 *
 * Guard: tests/cockpit/cockpit-mouse-path-owner.test.ts (§ "room-local
 * chords"). Both rules are mutation-tested there.
 *
 * WHAT DOES NOT BELONG HERE. Keys that operate the control already under the
 * pointer — Enter on a focused row, arrows that walk a grid, Esc — are
 * keyboard ACCESS to a mouse path that already exists. This table is for
 * chords that INVOKE a capability, which is the class that can be invisible.
 */

import type { RoomId } from "./contract.ts";
import { chordLabel, primaryDown } from "./chords.ts";
import { VERB_MARK } from "./verb-marks.ts";

/** Ids are `<room>.<capability>` so a control's attribute reads as itself. */
export type RoomChordId =
  | "switch.new-conversation"
  | "switch.new-project";

export type RoomChord = Readonly<{
  id: RoomChordId;
  room: RoomId;
  /** KeyboardEvent.key (case-insensitive for letters). */
  key: string;
  /** Platform primary modifier (meta on mac, ctrl elsewhere). */
  primary: boolean;
  shift?: boolean;
  /** Plain words — what the chord does, for the tooltip it must teach. */
  means: string;
  /** Platform-true label, DERIVED from the keys above (chords.ts owns the
   * spelling, so a row cannot teach a key it does not match). */
  chord: string;
}>;

const chordRow = (spec: Omit<RoomChord, "chord">): RoomChord => ({
  ...spec,
  chord: chordLabel({
    key: spec.key,
    primary: spec.primary,
    // exactOptionalPropertyTypes: an absent flag stays ABSENT.
    ...(spec.shift !== undefined ? { shift: spec.shift } : {}),
  }),
});

export const ROOM_CHORDS: readonly RoomChord[] = [
  chordRow({
    id: "switch.new-conversation",
    room: "switch",
    key: "n",
    primary: true,
    means: `${VERB_MARK.add} conversation`,
  }),
  chordRow({
    id: "switch.new-project",
    room: "switch",
    key: "n",
    primary: true,
    shift: true,
    means: `${VERB_MARK.add} project`,
  }),
] as const;

export function roomChord(id: RoomChordId): RoomChord | undefined {
  return ROOM_CHORDS.find((c) => c.id === id);
}

/** The tooltip a room-local mouse path shows: what it does · the key. */
export function roomChordTitle(id: RoomChordId): string {
  const c = roomChord(id);
  return c === undefined ? "" : `${c.means} · ${c.chord}`;
}

/**
 * Match an event against ONE room's chords — the room's whole modifier
 * handling, in one call, so no room reads `metaKey` for itself.
 *
 * Most-specific first: ⌘⇧N must not be answered by the ⌘N row, so rows that
 * require shift are tried before rows that do not.
 */
export function matchRoomChord(
  ev: Readonly<{ key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }>,
  room: RoomId,
  opts: Readonly<{ isMac: boolean }>,
): RoomChord | null {
  if (ev.altKey) return null;
  const primary = primaryDown(ev, opts.isMac);
  const rows = ROOM_CHORDS.filter((c) => c.room === room);
  for (const c of [...rows].sort((a, b) => Number(b.shift ?? false) - Number(a.shift ?? false))) {
    if (c.primary !== primary) continue;
    if (c.shift === true && !ev.shiftKey) continue;
    if (c.shift === undefined && ev.shiftKey && /^[a-z]$/i.test(c.key)) continue;
    const keyMatches =
      c.key.length === 1 ? ev.key.toLowerCase() === c.key.toLowerCase() : ev.key === c.key;
    if (keyMatches) return c;
  }
  return null;
}
