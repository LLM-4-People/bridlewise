/**
 * UI-control application — the single client-side owner that maps a
 * validated `UiControlAction` (from the `control_interface` tool / the
 * `ui_control` SSE event) to the corresponding cockpit surfaces.
 *
 * LLM control of the interface. The server validates the action
 * (server/ui-control.ts is the single source of truth) and emits a
 * `ui_control` SSE event; the client listener (src/client.ts) calls
 * `applyUiControlAction` here so the UI changes on demand (agents act
 * interactively; every backend feature exposed).
 *
 * WHERE THE ACTIONS LAND. The tab vocabulary is the server's
 * (`shared/routes.ts::TAB_ROUTE_VALUES`); the surfaces are the cockpit's
 * (shell rooms + the flow). `TAB_SURFACE` below is the one mapping between
 * the two, typed exhaustive over the tab union so a tab added to the
 * contract refuses to compile until this file says where it lands — the
 * drift between the enum and the mapping is a build error, not a runtime
 * surprise. A tab that maps to `null` has NO cockpit surface, and the
 * honest answer is a plain sentence saying so (never a silent no-op, never
 * a pretend navigation).
 *
 *   set_tab       → the shell view seam (cockpit/shell/view-request.ts):
 *                   a room request or the flow; the shell honors it through
 *                   the same doors a chord uses.
 *   set_theme     → the device theme preference
 *                   (cockpit/settings/local-prefs.ts::setLocalPref) — the
 *                   same one write path the settings sheet uses.
 *   open_settings → the settings room, via the same seam.
 *   toggle_panel  → right toggles the shared inspector; left is unavailable.
 *
 * Plain .ts — Node-testable via Vitest.
 */

import type { UiControlAction } from "../../shared/types.ts";
import { TAB_ROUTE_VALUES, INSPECTOR_SECTION_ENTRIES, INSPECTOR_GROUP_IDS, INSPECTOR_SECTIONS } from "../../shared/routes.ts";
import { requestShellView } from "../cockpit/shell/view-request.ts";
import type { RoomId } from "../cockpit/shell/contract.ts";
import { setLocalPref, THEME_ID } from "../cockpit/settings/local-prefs.ts";
import { rightMenu, closeRightMenu, openRightMenu } from "../cockpit/shell/right-menu.ts";

type TabRoute = (typeof TAB_ROUTE_VALUES)[number];

/**
 * Where each server tab lands in the cockpit. `"flow"` is the conversation
 * itself (no room on screen); `"pane"` is the run pane docked beside it;
 * `null` is the honest absence — the cockpit has no such surface and says
 * so. Exhaustive by type: adding a tab to `shared/routes.ts` without
 * deciding its surface here is a compile error (the strongest drift guard
 * available — no scan universe to get wrong).
 */
export const TAB_SURFACE: Readonly<Record<TabRoute, RoomId | "flow" | "pane" | null>> =
  Object.freeze({
    chat: "flow", // the conversation IS the flow
    timeline: "flow", // the flow renders the run's beats, past and present
    code: "editor",
    files: "editor",
    git: "custody", // uncommitted work, by producing conversation
    settings: "settings",
    metrics: "instruments",
    agents: "pane", // the run pane's agents section (live, beside the flow)
    memory: null,
    tools: null,
    extensions: null,
  });

/**
 * The cockpit theme value for each LLM theme word. The wire vocabulary is
 * dark/light (server/ui-control.ts); the device preference's contract is
 * carbon/logbook (local-prefs.ts). One mapping, beside its consumer.
 */
const THEME_VALUE: Readonly<Record<"dark" | "light", string>> = Object.freeze({
  dark: "carbon",
  light: "logbook",
});

/**
 * Apply a validated UI-control action to the cockpit. Returns a short
 * human-readable description of what changed (for an inline chat event +
 * diagnostics). The side effects live with their owners — the shell honors
 * the view request, the local-pref door applies and persists the theme.
 */
export function applyUiControlAction(a: UiControlAction): string {
  switch (a.action) {
    case "list_inspector":
      return INSPECTOR_SECTION_ENTRIES.map(section => `${section.group}/${section.id}: ${section.label}`).join("\n");
    case "inspect": {
      if (a.mode !== "open" && a.mode !== "close" && a.mode !== "toggle") return "inspect needs an open, close or toggle mode — no change.";
      if (a.group !== undefined && !INSPECTOR_GROUP_IDS.includes(a.group)) return "Unknown inspector group — no change.";
      if (a.section !== undefined && !Object.hasOwn(INSPECTOR_SECTIONS, a.section)) return "Unknown inspector section — no change.";
      if (a.group !== undefined && a.section !== undefined && INSPECTOR_SECTIONS[a.section].group !== a.group) return "Inspector section belongs to a different group — no change.";
      requestShellView({ kind: "pane", mode: a.mode, ...(a.group === undefined ? {} : { group: a.group }), ...(a.section === undefined ? {} : { section: a.section }) });
      return `Requested inspector ${a.mode}${a.section === undefined ? "" : ` at ${INSPECTOR_SECTIONS[a.section].label}`}.`;
    }
    case "set_tab": {
      const tab = a.tab;
      if (tab === undefined) return "set_tab is missing the 'tab' field — no change.";
      if (!(TAB_ROUTE_VALUES as readonly string[]).includes(tab)) {
        return `Unknown tab '${tab}' — no change.`;
      }
      const surface = TAB_SURFACE[tab as TabRoute];
      if (surface === null) {
        return `The cockpit has no ${tab} surface — nothing was opened.`;
      }
      if (surface === "flow") {
        requestShellView({ kind: "flow" });
        return `Showing the flow (the ${tab} view lives there now).`;
      }
      if (surface === "pane") {
        requestShellView({ kind: "pane" });
        return `Opened the run pane (the ${tab} surface).`;
      }
      requestShellView({ kind: "room", id: surface });
      return `Opened the ${surface} room (the ${tab} surface).`;
    }
    case "toggle_panel": {
      const panel = a.panel;
      if (panel === "right") {
        if (rightMenu.get() === null) { openRightMenu("run"); return "Opened the workspace inspector."; }
        closeRightMenu();
        return "Closed the workspace inspector.";
      }
      if (panel === "left") {
        return `The interface no longer has a collapsible ${panel} panel — its content lives on the field now. Nothing to toggle.`;
      }
      return "toggle_panel is missing the 'panel' field — no change.";
    }
    case "set_theme": {
      const theme = a.theme;
      if (theme === "dark" || theme === "light") {
        setLocalPref(THEME_ID, THEME_VALUE[theme]);
        return `Set the theme to ${theme} (${THEME_VALUE[theme]}).`;
      }
      return "set_theme is missing the 'theme' field — no change.";
    }
    case "open_settings": {
      requestShellView({ kind: "room", id: "settings" });
      return "Opened Settings.";
    }
  }
}
