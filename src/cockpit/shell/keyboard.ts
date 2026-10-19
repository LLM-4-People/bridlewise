/**
 * The complete keyboard grammar (§2.7) — registered on day one.
 *
 * Routing law: a pressed grammar chord NEVER silently does nothing. Either
 * a claimed handler runs (surfaces claim targets via ShellApi.claimKey), or
 * the shell handles it itself (desk, escape, composer focus), or the
 * grammar hint states the chord's meaning and that its target is not built
 * yet. Silence is a bug.
 *
 * `⌘` accepts the platform primary modifier: metaKey on mac, ctrlKey
 * elsewhere. Bare keys (`[`, `]`, `.`, `,`, `i`, arrows, Enter) are
 * ignored while typing in an editable element — the composer is an input;
 * stealing `.` from it would break typing. `⌘⏎` and `Esc` work everywhere.
 *
 * Chord LABELS are derived per platform through shell/chords.ts (the one
 * chord-spelling owner): a hint on Linux says "Ctrl+J", on a mac "⌘J" —
 * the taught key is always the key that fires (zero-knowledge law).
 */

import type { GrammarTarget } from "./contract.ts";
import { chordLabel, primaryDown } from "./chords.ts";

// The formatter owns platform detection too; re-exported here so grammar
// consumers keep one import site for keyboard facts.
export { detectMac, IS_MAC, chordLabel } from "./chords.ts";

export type ChordSpec = Readonly<{
  target: GrammarTarget;
  /** KeyboardEvent.key match (case-insensitive for letters). */
  key: string;
  primary: boolean; /* platform primary modifier (meta on mac / ctrl elsewhere) */
  shift?: boolean; /* required shift. undefined = shift passes through */
  /** Works through a native control's own keyboard interaction. */
  inControl: boolean;
  /** Human chord label for the hint line — platform-true (chords.ts). */
  chord: string;
  /** What the chord means (plain words, for the not-built-yet hint). */
  means: string;
}>;

/** Build a grammar row: the label is DERIVED from the chord's own keys by
 * the one formatter, so the table cannot teach a key it does not match. */
const row = (spec: Omit<ChordSpec, "chord">): ChordSpec => ({
  ...spec,
  chord: chordLabel({
    key: spec.key,
    // exactOptionalPropertyTypes: an absent flag stays ABSENT (spreading
    // `shift: undefined` into the chord parts is a type error, not a no-op).
    ...(spec.primary !== undefined ? { primary: spec.primary } : {}),
    ...(spec.shift !== undefined ? { shift: spec.shift } : {}),
  }),
});

/** THE grammar table — every §2.7 row. One entry per chord. */
export const GRAMMAR: readonly ChordSpec[] = [
  row({ target: "command", key: "k", primary: true, inControl: true, means: "command grammar in the composer" }),
  row({ target: "switch", key: "j", primary: true, inControl: true, means: "the Switch" }),
  row({ target: "chat", key: "j", primary: true, shift: true, inControl: true, means: "the conversation" }),
  row({ target: "desk", key: ".", primary: true, inControl: true, means: "open/close the desk" }),
  row({ target: "instruments", key: "'", primary: true, inControl: true, means: "Instruments room" }),
  row({ target: "settings", key: ",", primary: true, inControl: true, means: "Settings index" }),
  row({ target: "custody", key: "g", primary: true, inControl: true, means: "Custody room" }),
  row({ target: "editor", key: "e", primary: true, inControl: true, means: "Editor room" }),
  row({ target: "scrub-back", key: "[", primary: false, inControl: false, means: "sweep scrub back (⇧ by run)" }),
  row({ target: "scrub-forward", key: "]", primary: false, inControl: false, means: "sweep scrub forward (⇧ by run)" }),
  row({ target: "focus-prev", key: "ArrowUp", primary: false, inControl: false, means: "previous beat (causal order)" }),
  row({ target: "focus-next", key: "ArrowDown", primary: false, inControl: false, means: "next beat (causal order)" }),
  row({ target: "collapse", key: "ArrowLeft", primary: false, inControl: false, means: "collapse a beat's children" }),
  row({ target: "expand", key: "ArrowRight", primary: false, inControl: false, means: "expand a beat's children" }),
  row({ target: "open-scope", key: "Enter", primary: false, inControl: false, means: "open the focused beat's scope" }),
  row({ target: "escape", key: "Escape", primary: false, inControl: true, means: "close scope / close room / return to now" }),
  // `.` — the focused fact's verb menu — IS NOT IN THIS TABLE ANY MORE.
  //
  // THE USER'S RULING, VERBATIM: "the '...' menu under the message is also
  // useless, all options already showing as buttons." The menu was deleted
  // (flow/Flow.svelte states the entry-by-entry inventory), and a chord whose
  // only surface is gone must go with it. Leaving the row here would make `.`
  // print the grammar's "not built yet" hint, which is a different untruth:
  // it WAS built, and it was removed on purpose.
  row({ target: "setting", key: ",", primary: false, inControl: false, means: "the focused fact's setting" }),
  row({ target: "lens", key: "l", primary: true, inControl: true, means: "LENS — explain any pixel" }),
  row({ target: "run", key: "r", primary: true, inControl: true, means: "the run pane" }),
  row({ target: "arm", key: "a", primary: true, shift: true, inControl: true, means: "arm a trigger" }),
  row({ target: "send", key: "Enter", primary: true, inControl: true, means: "send" }),
  // `i` focuses the composer — shell-handled, listed so the table IS the
  // complete grammar (one row per §2.7 line).
  row({ target: "command", key: "i", primary: false, inControl: false, means: "focus the composer" }),
] as const;

/**
 * The grammar row a target's PRIMARY chord comes from. First row wins:
 * `command` is registered twice (⌘K and the bare `i` alias) and ⌘K is the
 * one a control should teach.
 */
export function grammarRow(target: GrammarTarget): ChordSpec | undefined {
  return GRAMMAR.find((s) => s.target === target);
}

/** Platform-true chord label for a target ("Ctrl+J" here, "⌘J" on a mac). */
export function chordFor(target: GrammarTarget): string {
  return grammarRow(target)?.chord ?? "";
}

/**
 * The tooltip a MOUSE control shows — MOUSE-FIRST law (v2.1): every chord
 * has a visible, clickable path, and that path's tooltip TEACHES the chord.
 *
 * Derived from the grammar table itself, so a control cannot teach a key the
 * router does not fire, and cannot drift when a chord is re-spelled. The
 * label is already platform-true (built by chordLabel at registration), so a
 * Linux box reads "next beat (causal order) · ↓" and a mac reads the glyph.
 *
 * Guard: tests/cockpit/cockpit-mouse-path-owner.test.ts.
 */
export function mouseTitleFor(target: GrammarTarget): string {
  const row = grammarRow(target);
  if (row === undefined) return "";
  return `${row.means} · ${row.chord}`;
}

export function isNativeKeyTarget(t: EventTarget | null, key?: string): boolean {
  if (!(t instanceof Element)) return false;
  if (t instanceof HTMLElement && t.isContentEditable) return true;
  // Comma adjusts the focused fact, including facts stamped on a button.
  // Text entry and native select/typeahead still own the character.
  if (key === ",") return t.closest('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]') !== null;
  // The control owns bare keys; the shell keeps declared global chords and
  // Escape. closest also covers an icon/SVG inside the actual control.
  return t.closest('input, textarea, select, button, a[href], summary, [role="button"], [role="tab"], [role="radio"], [role="checkbox"], [role="switch"], [role="slider"], [role="menuitem"], [role="combobox"]') !== null;
}

/**
 * Match a KeyboardEvent against the grammar table. Pure — unit-testable
 * without a DOM event by passing a shaped literal.
 */
export function matchChord(
  ev: Readonly<{
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  }>,
  opts: Readonly<{ isMac: boolean; inControl: boolean }>,
): ChordSpec | null {
  if (ev.altKey) return null;
  // The platform modifier test has ONE owner (chords.ts) — see the note
  // there, and the guard that refuses a private read anywhere else.
  const primary = primaryDown(ev, opts.isMac);
  for (const spec of GRAMMAR) {
    if (spec.primary !== primary) continue;
    if (spec.shift === true && !ev.shiftKey) continue;
    // Bare-key chords with an explicit shift-variant semantics ([ ]) accept
    // shift; letter chords without spec.shift must not fire on ⇧ (⌘⇧A ≠ ⌘A).
    if (spec.shift === undefined && spec.primary && ev.shiftKey && /^[a-z]$/.test(spec.key)) continue;
    const keyMatches =
      spec.key.length === 1
        ? ev.key.toLowerCase() === spec.key.toLowerCase()
        : ev.key === spec.key;
    if (!keyMatches) continue;
    if (opts.inControl && !spec.inControl) return null; // typing wins
    return spec;
  }
  return null;
}
