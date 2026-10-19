/**
 * Cockpit shell config — the single home for the shell's tunable numeric
 * constants (DESIGN-COCKPIT-V2 §2). Values that are SPEC geometry (§2.4
 * slot caps, §2.7 breakpoints) live here so components consume named
 * constants, never inline literals; the CSS-side twins live in
 * `src/cockpit/tokens.css` (the media-query breakpoints cannot read JS and
 * the JS matchMedia cannot read CSS vars, so both sides name the same
 * number and this file documents the pairing).
 *
 * @config-owner cockpit shell constants (breakpoints, slot caps, hint timing)
 */

/** §2.7 — the SCOPE side-docks at viewport ≥ this width (px). CSS twin:
 * none needed — docking is driven by matchMedia state (Cockpit.svelte adds
 * the `wide` class), so the number lives ONLY here. */
export const SIDE_DOCK_MIN_PX = 1900;

/** §2.7 — the shell folds at this width (px): room rail → one grip, HORIZON
 * monitors hide, sweep halves. CSS twin: `tokens.css` `@media (max-width:
 * 1100px)`. A media query cannot read JS, so both sides name the number;
 * `tests/cockpit/shell-fold-owner.test.ts` holds them equal. Rooms that
 * split a two-column layout at the same fold consume THIS constant — they
 * do not restate 1100. */
export const NARROW_FOLD_PX = 1100;

/** The run pane (the conversation's right-side inspector) docks beside the
 * flow while the viewport holds the flow's floor (tokens.css
 * --flow-min-docked: 720px) beside the pane's width (tokens.css --scope-w:
 * min(560px, 42vw)) AND the side rail (tokens.css --side-rail-w, 28px — a
 * real flex member of the same row since the single-menu round). Below
 * this the pane overlays the flow rather than squeezing the conversation
 * under its readability floor.
 *
 * THE ARITHMETIC counts every non-shrinking member of the flow region's
 * row at its full width. --scope-w is 42vw (not yet 560) below 1334px, so
 * the binding leg at the dock point is the vw share, not the cap:
 * viewport − 0.42·viewport − 28 ≥ 720 → viewport ≥ (720 + 28) / 0.58 →
 * 1290. The old spelling `560 + 720 = 1280` predated the side rail and
 * the 42vw leg both, so at 1280-1289 the docked menu squeezed the flow to
 * 714-719px — under the floor this constant exists to hold. The 560 cap's
 * own leg (560 + 720 + 28 = 1308 ≤ viewport from 1334, where the cap
 * starts) is never the binding one. CSS twin: none — the pane's
 * dock/overlay is driven by matchMedia state in Cockpit.svelte, so the
 * number lives ONLY here; tests/cockpit/e2e/right-menu-geometry-
 * owner.spec.ts pins the ladder at the width either side of it. */
export const RUN_PANE_DOCK_MIN_PX = Math.ceil((720 + 28) / (1 - 0.42));

/** §2.4 — at most 3 annunciator slots in the HORIZON. */
export const MAX_ANNUNCIATORS = 3;

/** §2.4 — at most 4 pinned monitors in the HORIZON. */
export const MAX_MONITORS = 4;

/** Grammar hint auto-dismiss (ms) — long enough to read a chord meaning,
 * short enough to never feel parked (§2.7 honesty hint). */
export const HINT_DISMISS_MS = 2400;

/** Fallback delay (ms) before registering the service worker when
 * `requestIdleCallback` is unavailable (e.g. older browsers). Lets first
 * paint win over the SW registration. Lives here because the cockpit entry
 * owns registration and the cockpit import law keeps `client-config.ts`
 * out of its graph. */
export const SW_REGISTER_FALLBACK_DELAY_MS = 1_000;

/** Format an epoch-ms instant as the logbook's HH:MM:SS line time. */
export function logTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString("en-GB", { hour12: false });
}
