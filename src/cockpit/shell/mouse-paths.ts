/**
 * GESTURE PATHS — the other kind of mouse path, declared so it can be checked.
 *
 * ── THE DEFECT IN THE LAW THIS FIXES ──────────────────────────────────────
 *
 * The mouse-first law says: every actionable keyboard chord must have a
 * discoverable click path. Its guard
 * (tests/cockpit/cockpit-mouse-path-owner.test.ts) enforced that by looking
 * for one thing only — an element carrying `data-chord-target="<target>"`.
 * That is a control-shaped definition of "reachable by mouse", and it is
 * narrower than the law it implements.
 *
 * It showed when the `⋯` beat menu was deleted. The menu held two rows,
 * "focus the fact before this one" and "focus the fact after this one", which
 * existed ONLY to give `↑`/`↓` an attribute-bearing control after the ▲▼
 * stepper was taken off the beat rows. Delete the menu and the guard reports
 * `focus-prev` and `focus-next` as chord-only capabilities — while the actual
 * mouse path for "focus a beat" is CLICKING THAT BEAT: more direct than a
 * menu entry, already discoverable, requiring no knowledge of anything. The
 * guard was demanding a worse path because it was the only shape it could
 * see.
 *
 * ── WHY THIS IS A REGISTRY AND NOT AN EXEMPTION LIST ──────────────────────
 *
 * Widening a guard into uselessness is the failure mode to avoid, so a
 * declaration here is a CLAIM THE GUARD VERIFIES, not a note that turns the
 * check off. For each row it proves, against the named source:
 *
 *   1. the named marker is really rendered there, on an element that is
 *      really interactive (an interactive tag, or one carrying `onclick`);
 *   2. the source really consumes this registry — a declaration that no
 *      surface reads is a comment, and a comment cannot teach a chord;
 *   3. the sentence is present and the CHORD in it comes from the grammar
 *      table (`gestureKeysFor` below), so a gesture path cannot teach a key
 *      the router does not fire — the same rule the attribute paths obey.
 *
 * A target that is neither attribute-reachable nor declared-and-verified here
 * still fails, exactly as before. The mutation self-checks in the guard prove
 * each of the three can fail on its own.
 */

import type { GrammarTarget } from "./contract.ts";
import { grammarRow } from "./keyboard.ts";

export type GesturePath = Readonly<{
  /** The chord this gesture is the mouse path for. */
  target: GrammarTarget;
  /** An attribute the rendered element carries — the thing to look for. */
  marker: string;
  /** The source that renders it. */
  source: string;
  /** The gesture, in plain words, from the reader's side. */
  gesture: string;
}>;

/**
 * THE ONE DECLARED GESTURE PATH TODAY.
 *
 * Moving the beat focus. `↑`/`↓` walk the causal order; the pointer's version
 * of "focus that fact" is to click it, which every beat row answers
 * (Beat.svelte's row is a `role="option"` with an `onclick` that focuses it,
 * inside the flow's roving listbox). Both directions declare the same
 * element, because the same click serves both: you do not click "previous",
 * you click the one you want.
 */
export const GESTURE_PATHS: readonly GesturePath[] = [
  {
    target: "focus-prev",
    marker: "data-beat-id",
    source: "src/cockpit/flow/Beat.svelte",
    gesture: "click the fact you want — every beat row focuses itself on a click",
  },
  {
    target: "focus-next",
    marker: "data-beat-id",
    source: "src/cockpit/flow/Beat.svelte",
    gesture: "click the fact you want — every beat row focuses itself on a click",
  },
  {
    target: "scrub-back",
    marker: "data-scrub-band",
    source: "src/cockpit/sweep/Sweep.svelte",
    gesture: "click the band where you want the head — the band moves the head through time",
  },
  {
    target: "scrub-forward",
    marker: "data-scrub-band",
    source: "src/cockpit/sweep/Sweep.svelte",
    gesture: "click the band where you want the head — the band moves the head through time",
  },
] as const;

/**
 * The keys these targets fire, spelled as `aria-keyshortcuts` wants them —
 * built FROM the grammar table, so the surface that carries the gesture path
 * teaches the real chord to assistive technology without spending a pixel or
 * a hover tooltip on every row of a virtualized stream.
 *
 * This is the consumption the guard requires: the declaration is read by the
 * surface it names, at runtime, rather than only by a test.
 */
export function gestureKeysFor(...targets: readonly GrammarTarget[]): string {
  return targets
    .map((t) => grammarRow(t)?.key)
    .filter((k): k is string => k !== undefined && k.length > 0)
    .join(" ");
}
