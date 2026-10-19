/**
 * READING A DESIGN TOKEN FROM A CANVAS — the one owner, and the one signal.
 *
 * ── THE DEFECT THIS EXISTS FOR, MEASURED ──────────────────────────────────
 *
 * A canvas cannot consume `var(--beam)`. `ctx.fillStyle` needs a concrete
 * string, so every painter in this cockpit has to resolve tokens through
 * `getComputedStyle` at some moment. WHICH moment is the entire question, and
 * it is invisible in the diff: `getComputedStyle(host).getPropertyValue("--beam")`
 * reads identically whether it sits in `onMount` or in the paint.
 *
 * The SWEEP put it in `onMount`, into a `$state` palette, and never read it
 * again. Switching Theme from Carbon to Logbook re-derives EVERY token the
 * band uses — `src/cockpit/tokens.css` `:root[data-cockpit-theme="light"]`
 * declares new values for all eight category hues, `--alarm`, `--beam`,
 * `--ground-1`, `--ground-2`, `--line-1`, `--ink-2` and `--ink-3`, which is
 * the whole of `SweepPalette` — so the band went on painting a dark carbon
 * housing, dark grounds and dark inks onto a warm paper page until something
 * else happened to remount it.
 *
 * ***A TOKEN READ ONCE IS NOT A TOKEN.*** It is a screenshot of a token, and
 * a screenshot does not have a theme.
 *
 * ── WHY THERE ARE TWO HALVES HERE AND NOT ONE ─────────────────────────────
 *
 * Reading at paint time is only half a fix, and the missing half is the half
 * that looks done. A painter that resolves tokens inside `paint()` is still
 * wrong if NOTHING RE-RUNS `paint()` when the theme changes: the values would
 * be fresh if anyone asked, and nobody asks. The band would stay dark exactly
 * as before, and every line of the diff would look correct.
 *
 * So this module owns both:
 *
 *   `withPaintTokens(el, fn)`  — the only door to a token reader, and the
 *                                reader is a PARAMETER of the paint, revoked
 *                                the moment the paint returns.
 *   `designConditions`         — the signal a repaint must be bound to. It
 *                                changes when the document's design
 *                                conditions change, and a painter that reads
 *                                it re-runs.
 *
 * ── LADDER, and where it genuinely stops (§0) ─────────────────────────────
 *
 * Rung 1 (physically impossible) — unavailable, specifically: `ctx.fillStyle`
 * accepts any string and the engine has no way to tell one resolved this
 * frame from one resolved at mount. There is no OS or engine facility that
 * knows a string's age.
 *
 * Rung 2 (unrepresentable) — unavailable, specifically: a resolved colour IS
 * a `string`, because that is what the canvas API demands, so a branded
 * `PaintColor` is assignable to `fillStyle` and certifies nothing at the only
 * place it would matter. And the bad state is not a FORGED value — the stale
 * palette was built correctly by the right function from the right element.
 * The value is honest; its AGE is the lie, and a type has no access to age.
 *
 * Rung 3 (unreachable by shape) — REACHED inside a painter: the only way to
 * obtain a reader is to enter a paint scope, so there is no mount-time
 * binding for a paint to close over. The bypass that remains, stated rather
 * than hidden: the STRINGS the reader returns can still be assigned to an
 * outer variable. Which is what the next rung is for.
 *
 * Rung 4 (runtime choke point) — REACHED, twice. The reader is REVOKED when
 * the paint returns, so "keep the reader and use it next frame" throws a
 * sentence naming the defect instead of quietly answering with last frame's
 * theme. And `designConditions` is one subscription over the one element
 * every theme and density change lands on, so a painter binds to the signal
 * rather than to whichever store happened to cause this change — a theme set
 * by the OS, by a future served preference, or by a test all move the same
 * attribute.
 */

import { atom } from "nanostores";

/**
 * Stylesheet-less (jsdom, a painter that has not mounted) projections of
 * the token owner's DARK declarations. THE one JS table — not a second
 * palette. Hexes are pinned byte-for-byte to `tokens.css`; `--sp-3` is the
 * resolved product of `--sp-unit * 3` (the scale is calc in CSS, and jsdom
 * does not compute it). A new paint that needs a fallback adds a row here
 * and the pin test reds until the owner agrees.
 */
export const TOKEN_FALLBACKS = Object.freeze({
  "--alarm": "#e26a5f",
  "--beam": "#8fd3ff",
  "--ground-1": "#15181d",
  "--ground-2": "#1b1f25",
  "--line-1": "#262b33",
  "--ink-2": "#a6adb8",
  "--ink-3": "#79818d",
  "--ink-4": "#4d545e",
  "--reel-w": "320px",
  "--reel-h": "88px",
  "--hit-min": "40px",
  "--hairline-w": "1px",
  "--sp-unit": "4px",
  "--sp-3": "12px",
} as const);

export type TokenFallbackName = keyof typeof TOKEN_FALLBACKS;

/** Thrown when a paint reads a token with no stylesheet value and no table row. */
export class UnknownPaintToken extends Error {
  readonly code = "cockpit_contract";
  constructor(name: string) {
    super(
      `no stylesheet-less fallback for ${name} — add it to TOKEN_FALLBACKS ` +
        `(the one JS table, pinned to tokens.css) or pass an explicit fallback`,
    );
    this.name = "UnknownPaintToken";
  }
}

/**
 * A token reader, valid only inside the paint it was made for.
 *
 * `name` is the custom property. An explicit `fallback` is a TEST SENTINEL
 * or a cascade miss (Sweep's empty string). Production paints omit it and
 * the door fills from `TOKEN_FALLBACKS` — callers do not restate hex.
 */
export type PaintTokenReader = (name: string, fallback?: string) => string;

/** Thrown when a reader is used after the paint it belonged to has ended. */
export class StaleTokenRead extends Error {
  readonly code = "cockpit_contract";
  constructor() {
    super(
      "a design-token reader outlived the paint it was made for — resolve tokens " +
        "inside the paint, never once at mount, or the canvas keeps painting the " +
        "theme that was active when it was created",
    );
    this.name = "StaleTokenRead";
  }
}

/**
 * THE ONLY DOOR to a design token from a painter.
 *
 * The reader lives for the duration of `fn` and is revoked on the way out —
 * including when `fn` throws, because a painter that throws half way through
 * a frame is exactly the case where a stashed reader would survive.
 */
export function withPaintTokens<T>(
  el: Element | null | undefined,
  fn: (read: PaintTokenReader) => T,
): T {
  let live = true;
  // Resolved ONCE PER PAINT, not once per token: `getComputedStyle` forces
  // style resolution, and asking for it per property is how a paint path
  // turns into a reflow storm. One handle, many reads, all of this frame.
  const style =
    el != null && typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
  const read: PaintTokenReader = (name, fallback) => {
    if (!live) throw new StaleTokenRead();
    if (style !== null) {
      const value = style.getPropertyValue(name).trim();
      if (value.length > 0) return value;
    }
    if (fallback !== undefined) return fallback;
    const pinned = TOKEN_FALLBACKS[name as TokenFallbackName];
    if (pinned !== undefined) return pinned;
    throw new UnknownPaintToken(name);
  };
  try {
    return fn(read);
  } finally {
    live = false;
  }
}

// ── The signal ────────────────────────────────────────────────────────────

/**
 * THE ATTRIBUTES THAT CHANGE WHAT A TOKEN RESOLVES TO, on the one element
 * that carries them. Named here so a painter's dependency is a NAMED SIGNAL
 * and not a guess: `data-cockpit-theme` selects the logbook palette,
 * `data-density` remaps the row and spacing scale, `class` is watched
 * because a theme applied by class rather than attribute is the shape every
 * other framework reaches for and would otherwise pass unnoticed, and `style`
 * because the local-prefs token-override door (`applyTokenOverride`) writes
 * `--sp-unit`/`--t-unit` as :root inline overrides that remap every derived
 * rung (the Switch geometry re-reads `--reel-h`/`--sp-*` on this signal).
 */
const WATCHED_ATTRIBUTES = ["data-cockpit-theme", "data-density", "class", "style"] as const;

/**
 * A counter that advances whenever the document's design conditions change.
 *
 * It is a COUNTER rather than the theme's name on purpose: a painter must
 * repaint when the conditions change, and it must not have to know what they
 * changed TO. A painter that switched on `"light"` would be a second place
 * the theme vocabulary lives, and the two would eventually disagree.
 */
export const designConditions = atom<number>(0);

let observer: MutationObserver | null = null;
let subscribers = 0;

function attachDesignConditionsObserver(): void {
  if (typeof document === "undefined" || typeof MutationObserver !== "function") return;
  observer = new MutationObserver(() => {
    designConditions.set(designConditions.get() + 1);
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [...WATCHED_ATTRIBUTES],
  });
}

/**
 * Bind to the design conditions. Returns the release.
 *
 * One observer serves every painter — the cockpit has several canvases and
 * one document, so a per-painter observer would be N callbacks watching one
 * element. Refcounted so the last painter to leave takes it down.
 */
export function watchDesignConditions(): () => void {
  subscribers += 1;
  if (subscribers === 1) attachDesignConditionsObserver();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    subscribers -= 1;
    if (subscribers === 0 && observer !== null) {
      observer.disconnect();
      observer = null;
    }
  };
}

/** Test seam: the attributes actually observed, for a guard that must not
 * take the list on trust. */
export function watchedDesignAttributes(): readonly string[] {
  return WATCHED_ATTRIBUTES;
}

/** Test seam: whether an observer is currently attached. A refcount that
 * leaks is a listener that outlives every cockpit it was opened for. */
export function designConditionsObserverAttached(): boolean {
  return observer !== null;
}
