/**
 * UI-control action schema — the single owner of the `control_interface`
 * tool's action contract (LLM control of the interface).
 *
 * The LLM calls the `control_interface` tool to change the web UI on demand:
 * switch tabs, toggle side panels, set the theme, or open settings. The run
 * route emits a `ui_control` SSE event carrying the validated action; the
 * frontend listener applies it. This module is the ONE place the action
 * shape is defined, so the tool manifest, the executor, the run route, and
 * the client listener cannot drift.
 *
 * Pure (Zod only) — fully testable in Node with adversarial input. Invalid actions are rejected with a typed result (never a silent
 * fallback).
 */

import { z } from "zod";

import { TAB_ROUTE_VALUES, INSPECTOR_GROUP_IDS, INSPECTOR_SECTION_IDS, INSPECTOR_SECTION_ENTRIES, INSPECTOR_SECTIONS } from "../../shared/routes.ts";

/**
 * The tab routes the LLM can navigate to — DERIVED from the canonical route
 * list, not mirrored.
 *
 * This was a hand-written enum whose own comment said it "mirrors
 * src/state/route.ts". `tsconfig.server.json` excludes `src/`, so the server
 * could not import the client's copy and kept a parallel list instead — the
 * drift the single-source-of-truth rule exists to prevent. Adding a surface
 * meant remembering to edit this enum, with nothing but a red drift test
 * (now tests/prevention/ui-control-surface-owner.test.ts) to remind you.
 *
 * The list now lives in `shared/routes.ts`, which both sides already
 * import from, and `TAB_ROUTE_VALUES` is the modal exclusion applied once at
 * the owner. Adding a route requires no edit here at all.
 */
export const UI_CONTROL_TABS = z.enum(TAB_ROUTE_VALUES);
export type UiControlTab = z.infer<typeof UI_CONTROL_TABS>;

export const UI_CONTROL_ACTION = z.strictObject({
  action: z.enum(["set_tab", "toggle_panel", "set_theme", "open_settings", "inspect", "list_inspector"]),
  /** For set_tab: the tab to navigate to. Ignored for other actions. */
  tab: UI_CONTROL_TABS.optional(),
  /** For toggle_panel: which side panel to toggle. Ignored for other actions. */
  panel: z.enum(["left", "right"]).optional(),
  /** For set_theme: the theme to apply. Ignored for other actions. */
  theme: z.enum(["dark", "light"]).optional(),
  mode: z.enum(["open", "close", "toggle"]).optional(),
  group: z.enum(INSPECTOR_GROUP_IDS).optional(),
  section: z.enum(INSPECTOR_SECTION_IDS).optional(),
});
export type UiControlAction = z.infer<typeof UI_CONTROL_ACTION>;

/**
 * The canonical value lists, derived from the Zod schemas above (the single
 * owner). Consumers that need the action/tab/panel/theme enumerations — the
 * tool manifest's inputSchema enums, the executor's invalid-args help text,
 * the run route, the client listener — import THESE arrays so a value added
 * to a `z.enum` here reaches every consumer automatically (no parallel
 * hardcoded copy that can silently drift). `z.enum` exposes `.options` at
 * runtime; `.optional()` wraps the inner enum, so the optional fields use
 * `.unwrap().options` to reach the underlying enumeration.
 */
export const UI_CONTROL_ACTION_NAMES = UI_CONTROL_ACTION.shape.action.options as readonly string[];
export const UI_CONTROL_TAB_NAMES = UI_CONTROL_TABS.options as readonly string[];
export const UI_CONTROL_PANEL_NAMES = UI_CONTROL_ACTION.shape.panel.unwrap().options as readonly string[];
export const UI_CONTROL_THEME_NAMES = UI_CONTROL_ACTION.shape.theme.unwrap().options as readonly string[];
export const UI_CONTROL_INSPECTOR_GROUP_NAMES = UI_CONTROL_ACTION.shape.group.unwrap().options as readonly string[];
export const UI_CONTROL_INSPECTOR_SECTION_NAMES = UI_CONTROL_ACTION.shape.section.unwrap().options as readonly string[];
export const UI_CONTROL_INSPECTOR_MODES = UI_CONTROL_ACTION.shape.mode.unwrap().options as readonly string[];

/**
 * The single owner of the action→required-field contract. Each action
 * requires one optional field to be present (set_tab→tab, toggle_panel→
 * panel, set_theme→theme); open_settings requires none (null). The manifest
 * schema, the executor's invalid-args help text, and the validator all read
 * THIS record so the contract cannot drift across the three sites.
 */
export const ACTION_REQUIRED_FIELD: Readonly<Record<string, string | null>> = Object.freeze({
  set_tab: "tab",
  toggle_panel: "panel",
  set_theme: "theme",
  open_settings: null,
  inspect: "mode",
  list_inspector: null,
});

/**
 * A help string for an invalid `control_interface` call, built dynamically
 * from the canonical action list + the required-field mapping (the single
 * owner). Used by the executor so the error message never hardcodes a
 * parallel copy of the action contract (a value added to the schema reaches
 * the error message automatically).
 */
export function describeActionRequirements(): string {
  const parts = UI_CONTROL_ACTION_NAMES.map((action) => {
    const field = ACTION_REQUIRED_FIELD[action] ?? null;
    return field === null ? `${action}→(none)` : `${action}→${field}`;
  });
  return `Provide a valid 'action' plus the field that action requires: ${parts.join(", ")}.`;
}

/**
 * Validate an untrusted `control_interface` argument blob. Returns the
 * typed action on success, or null on any validation failure (the caller
 * surfaces a typed error to the LLM — never a silent fallback that applies
 * a half-parsed action to the user's UI). Cross-field consistency is
 * enforced from the single owner `ACTION_REQUIRED_FIELD`: each action
 * requires its named field to be present (open_settings requires none).
 */
export function validateUiControlAction(args: unknown): UiControlAction | null {
  let parsed: unknown;
  try {
    parsed = UI_CONTROL_ACTION.parse(args);
  } catch {
    return null;
  }
  const a = parsed as UiControlAction;
  if (a.action === "inspect" && a.section !== undefined && a.group !== undefined
    && INSPECTOR_SECTIONS[a.section].group !== a.group) return null;
  const required = ACTION_REQUIRED_FIELD[a.action] ?? null;
  if (required === null) return a;
  return (a as Record<string, unknown>)[required] !== undefined ? a : null;
}

/**
 * A human-readable description of a validated action — used as the tool
 * result returned to the LLM so it knows the action was applied (and how).
 */
export function describeUiControlAction(a: UiControlAction): string {
  switch (a.action) {
    case "set_tab":
      return `Switched the UI to the "${a.tab}" tab.`;
    case "toggle_panel":
      return `Toggled the ${a.panel} side panel.`;
    case "set_theme":
      return `Set the theme to ${a.theme}.`;
    case "open_settings":
      return `Opened the settings tab.`;
    case "inspect":
      return `Requested inspector ${a.mode}: ${a.section ?? a.group ?? "current workspace"}.`;
    case "list_inspector":
      return INSPECTOR_SECTION_ENTRIES.map(section => `${section.group}/${section.id}: ${section.label} (${section.keywords})`).join("\n");
  }
}
