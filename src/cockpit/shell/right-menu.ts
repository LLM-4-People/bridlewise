/**
 * THE RIGHT MENU — the flow region's ONE inspector column (right-menu.ts).
 *
 * THE USER'S DIRECTIVES, VERBATIM: "we should have a single
 * right menu", "the button should not be some text, it should be an icon
 * or something". The side edge now holds ONE icon button that opens ONE
 * menu; the run/arm split moved INSIDE, where it is a GROUP structure:
 * the run group (the conversation's measured facts — progress, agents,
 * turns, calls, edits, codebase, preparation) and the arm group (the
 * trigger arming + band captures), each group a disclosure with its own
 * cap row, separated by the cap idiom every raised surface opens with.
 *
 * WHY A STORE AND NOT SHELL STATE. The ⌘⇧A chord is CLAIMED by the SWEEP
 * (shell/routing.ts — a permanent claim, by the surface that owns the band
 * the triggers cock on), and the band's own `a` key reaches the same verb
 * from a focused band. Both live in the sweep outlet, which has no seam to
 * the shell's private state — the same reason the planted head, the marks
 * and the run state all cross the outlet boundary through a store. A
 * nanostores atom here is that seam: the shell reads it to mount/host the
 * column, the sweep's claim lands it, and neither side restates the
 * other's state.
 *
 * THE ID NAMES THE GROUP THE MENU IS LANDED AT. `RightMenuId` stopped
 * naming "which column is open" (there is one column) and names the group
 * the reader's gesture aimed at: ⌘R and the rail button land at the run
 * group; ⌘⇧A lands at the arm group. The host renders the SAME menu
 * either way and scrolls to (and expands) the landed group, so the two
 * chords keep their grammar rows and their distinct landings inside one
 * surface — a toggle that governs only ITS OWN group: pressing the landed
 * group's own chord closes the menu (the toggle law the desk and the pane
 * already teach), pressing the OTHER chord re-lands the open menu at that
 * group (the replacement the old two-column host performed, expressed as
 * the same one gesture).
 *
 * RELOAD DOES NOT REOPEN (the one-reveal law, §10.3). The atom starts null
 * and is deliberately NOT persisted: a reload is a fresh boot, the boot
 * frame mounts nothing the reader did not ask for, and the per-workspace
 * view restore (shell/workspace-view.ts) applies only on a real tab switch —
 * its first notification, which is the boot, is skipped by that module's
 * own rule. Deny-by-default is the resting shape.
 *
 * @see src/cockpit/shell/SideRail.svelte — the mouse path (the one icon button)
 * @see src/cockpit/shell/RightMenuHost.svelte — the host (one column, two groups)
 */

import { atom, computed, type ReadableAtom } from "nanostores";

import { registerReset } from "../../state/store-registry";
import type { GrammarTarget } from "./contract.ts";
import { cockedTriggerCount } from "../sweep/sweep-store.ts";
import { INSPECTOR_SECTIONS, type InspectorSectionId } from "../../../shared/routes.ts";

/**
 * The groups the single menu lands at. The id union is the group
 * vocabulary — the chords' two landings — not two menus.
 */
export type RightMenuId = keyof typeof RIGHT_MENU_GROUPS;

/**
 * The plain-words name of each group, for the group caps the host renders
 * (each cap is its chord's mouse path, so its label is the chord's own
 * subject). Declared beside the id union with a `satisfies` clause so a
 * group added without a name is a COMPILE error, never a silent fallback —
 * the total-record rule the registries obey.
 */
export const RIGHT_MENU_GROUPS = {
  setup: { label: "Setup", description: "Choose a model, shape context and manage tools", chord: "desk", context: "workspace", defaultOpen: false, summary: atom<string | null>(null) },
  run: { label: "Activity", description: "Run status, history, tools, files and diagnostics", chord: "run", context: "workspace", defaultOpen: true, summary: atom<string | null>(null) },
  arm: { label: "Watches", description: "Watch a condition and save moments worth keeping", chord: "arm", context: "workspace", defaultOpen: false, summary: computed(cockedTriggerCount, count => count === 0 ? null : `${count} watching`) },
} as const satisfies Record<string, Readonly<{
  label: string; description: string; chord?: GrammarTarget;
  context: "conversation" | "workspace"; defaultOpen: boolean; summary: ReadableAtom<string | null>;
}>>;

/**
 * The single menu's own name — the one landmark label, the dismissal
 * ladder's label, and the icon button's accessible subject. It names both
 * halves honestly rather than picking the run's (the arm group is not a
 * footnote to the run's measurements; it is the other half of the column).
 */
export const RIGHT_MENU_TITLE = "workspace inspector";

const menu = atom<RightMenuId | null>(null);
export const pendingInspectorSection = atom<InspectorSectionId | null>(null);

/** A section address survives lazy body acquisition and is consumed once
 * by the mounted host. Discovery does not mount or query domain bodies. */
export function openInspectorSection(id: InspectorSectionId): void {
  pendingInspectorSection.set(id);
  menu.set(INSPECTOR_SECTIONS[id].group);
}

/** The open menu's landed group, or null when the right edge hosts nothing. */
export const rightMenu: ReadableAtom<RightMenuId | null> = menu;

/**
 * Toggle from any open path — the side-rail icon button, the ⌘R chord,
 * ⌘⇧A, the band's `a` key. A press names a GROUP: when the menu is closed
 * (or landed at the other group) it opens AT that group; when the menu is
 * already landed at that group the press closes it — the same toggle law
 * one surface with one grip teaches, applied per group.
 */
export function toggleRightMenu(id: RightMenuId): void {
  menu.set(menu.get() === id ? null : id);
}

/**
 * Open (set, not toggle) — for a request that is not a gesture on the
 * surface itself: the LLM's `{ kind: "pane" }` view request asks for the
 * run group the way a link would, and a second request while it is
 * already open must be the idempotent no-op it always was.
 */
export function openRightMenu(id: RightMenuId): void {
  menu.set(id);
}

/** Close — the host's close verb, Esc's dismissal, a workspace switch. */
export function closeRightMenu(): void {
  pendingInspectorSection.set(null);
  menu.set(null);
}

// Sign-out forgets what was open: a fresh session must not come back to
// someone else's open inspector column. Registered with the one reset
// owner, so no caller has to remember.
registerReset("cockpit-right-menu", closeRightMenu);
