/**
 * DESK bus — the one seam through which another surface addresses the desk
 * (§3.5: "clicking any tool beat's `breaker` verb scrolls the desk to that
 * row").
 *
 * Two tiny stores, both moved ONLY by user action (the one-reveal law is
 * untouched — nothing here fires on boot or on a live event):
 *
 *   - `deskOpenRequests` — a counter the shell's Desk consumes: a bump
 *     means "a user gesture asked for the open desk"; the Desk opens if
 *     closed (never closes — a jump is not a toggle).
 *   - `breakerRowFocus` — the tool row the open desk should scroll to and
 *     focus, with a seq so repeated jumps to the same tool still scroll.
 */

import { atom } from "nanostores";

import { registerReset } from "../../state/store-registry.ts";
import { openInspectorSection } from "../shell/right-menu.ts";

export type BreakerRowFocus = Readonly<{ tool: string; seq: number }>;
export const breakerRowFocus = atom<BreakerRowFocus | null>(null);

/**
 * A user gesture (the tool beat's `breaker` verb) jumps to a tool's breaker
 * row: open the desk if closed, then scroll/focus that row when the panel
 * mounts (the panel consumes `breakerRowFocus`; a row that does not exist
 * renders the panel's honest miss note instead of silence).
 */
export function jumpToBreakerRow(tool: string): void {
  openInspectorSection("setup-sec-tools");
  const prev = breakerRowFocus.get();
  breakerRowFocus.set(Object.freeze({ tool, seq: (prev?.seq ?? 0) + 1 }));
}

export function resetDeskBus(): void {
  breakerRowFocus.set(null);
}

registerReset("desk-bus", resetDeskBus);
