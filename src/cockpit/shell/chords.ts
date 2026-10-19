/**
 * THE chord formatter — the ONE owner of on-screen chord spelling.
 *
 * Zero-knowledge law: the screen must teach the truth. The primary
 * modifier that actually fires a chord is the command key on a mac and
 * Ctrl everywhere else (matchChord in keyboard.ts routes on exactly this
 * split), so the LABEL must say the same thing: mac renders glyph style
 * ("⌘⇧N"), every other platform renders spelled style
 * ("Ctrl+Shift+N"). A legend that shows the mac glyph on a Linux box
 * teaches a key that does not exist there.
 *
 * Every on-screen chord mention in the cockpit routes through
 * `chordLabel`; the guard (tests/cockpit/cockpit-chord-owner.test.ts)
 * fails if the mac command glyph appears in any other cockpit source
 * outside comments. Do not write the glyph anywhere else.
 */

export function detectMac(nav: Readonly<{ platform?: string; userAgent?: string }>): boolean {
  const p = nav.platform ?? "";
  const ua = nav.userAgent ?? "";
  return /mac/i.test(p) || /mac os x/i.test(ua);
}

/** The platform truth, read once. No navigator (SSR/tests) ⇒ not a mac. */
export const IS_MAC: boolean = detectMac(typeof navigator !== "undefined" ? navigator : {});

// The mac-only glyphs — these constants are the only place the command
// glyph may exist in cockpit source (guard-enforced).
const PRIMARY_GLYPH = "⌘"; /* command */
const SHIFT_GLYPH = "⇧"; /* shift */
const ENTER_GLYPH = "⏎"; /* return */

/**
 * Is the platform primary modifier down?
 *
 * The one place this test is spelled, for the same reason the LABEL has one
 * owner: a surface that reads `ev.metaKey` for itself is a surface writing a
 * private keyboard registry, which is how the Switch ended up with two
 * chords no control on screen could fire (see shell/room-chords.ts and the
 * mouse-path guard, which now refuses a raw read outside this module).
 */
export function primaryDown(
  ev: Readonly<{ metaKey: boolean; ctrlKey: boolean }>,
  mac: boolean = IS_MAC,
): boolean {
  return mac ? ev.metaKey : ev.ctrlKey;
}

/** A chord in the grammar's own vocabulary (matches ChordSpec fields). */
export type ChordParts = Readonly<{
  /** KeyboardEvent.key ("j", "Enter", "ArrowUp", "[", …). */
  key: string;
  /** Requires the platform primary modifier (meta on mac / ctrl elsewhere). */
  primary?: boolean;
  /** Requires shift. May be spelled out as undefined by a grammar row that
   * leaves it unset; reads always compare against `true`. */
  shift?: boolean | undefined;
}>;

function keyLabel(key: string, mac: boolean): string {
  switch (key) {
    case "Enter":
      return mac ? ENTER_GLYPH : "Enter";
    case "Escape":
      return "Esc";
    case "ArrowUp":
      return "↑";
    case "ArrowDown":
      return "↓";
    case "ArrowLeft":
      return "←";
    case "ArrowRight":
      return "→";
    default:
      return /^[a-z]$/i.test(key) ? key.toUpperCase() : key;
  }
}

/**
 * Format a chord for THIS platform (or an explicit one, for tests).
 * mac: "⌘⇧N" · elsewhere: "Ctrl+Shift+N" — the taught key IS
 * the key that fires.
 */
export function chordLabel(parts: ChordParts, mac: boolean = IS_MAC): string {
  const key = keyLabel(parts.key, mac);
  if (mac) {
    return `${parts.primary === true ? PRIMARY_GLYPH : ""}${parts.shift === true ? SHIFT_GLYPH : ""}${key}`;
  }
  const segments: string[] = [];
  if (parts.primary === true) segments.push("Ctrl");
  if (parts.shift === true) segments.push("Shift");
  segments.push(key);
  return segments.join("+");
}
