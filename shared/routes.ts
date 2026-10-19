/**
 * The canonical route list — the SINGLE source of truth for the set of
 * surfaces the UI can show, shared by the client and the server.
 *
 * WHY THIS LIVES IN `shared/`
 *
 * The route set has two consumers on opposite sides of the wire:
 *
 *   - the client derives the `Route` type and `isRoute` guard
 *     (`src/state/route.ts`) and the LLM tab→surface mapping
 *     (`src/state/ui-control.ts::TAB_SURFACE`) from it;
 *   - the server (`server/ui-control.ts`) needs the same set to validate the
 *     LLM's `set_tab` action.
 *
 * `tsconfig.server.json` excludes `src/`, so the server cannot import the
 * client's copy. Previously it therefore kept its own hand-written zod enum
 * with a comment saying it "mirrors src/state/route.ts" — a maintained
 * parallel list, which is precisely the drift the single-source-of-truth rule
 * forbids. It also made the drift contract in
 * `tests/prevention/ui-control-surface-owner.test.ts` fail whenever a
 * surface was added, so adding the thirteenth surface required a server edit
 * that nothing but a red test would remind you to make.
 *
 * `shared/` is the seam both sides already import from, so the list lives
 * here and both sides derive. Adding a surface is now a one-line edit here and
 * nowhere else.
 */

/**
 * Every route the UI can be on.
 *
 * `"project-create"` is a transient MODAL route (the create-project dialog),
 * not a tab. It is excluded from the LLM `set_tab` action and from
 * `restoreRoute` (a refresh should not re-open the modal). Consumers that want
 * only the tabs use `TAB_ROUTE_VALUES` below rather than re-deriving the
 * exclusion themselves.
 */
export const ROUTE_VALUES = [
  "chat",
  "project-create",
  "timeline",
  "code",
  "files",
  "git",
  "settings",
  "agents",
  "metrics",
  "memory",
  "tools",
  "extensions",
] as const;
Object.freeze(ROUTE_VALUES);

export type Route = (typeof ROUTE_VALUES)[number];

/**
 * The single modal route. Named once here so neither side re-states the
 * string when filtering it out.
 */
export const MODAL_ROUTE = "project-create" as const;

/**
 * The routes that are TABS — every route except the modal. Derived, so a new
 * route is automatically a tab unless it is the modal.
 */
export const TAB_ROUTE_VALUES = ROUTE_VALUES.filter(
  (r): r is Exclude<Route, typeof MODAL_ROUTE> => r !== MODAL_ROUTE,
);
Object.freeze(TAB_ROUTE_VALUES);

export type TabRoute = (typeof TAB_ROUTE_VALUES)[number];

const ROUTE_SET: ReadonlySet<string> = new Set(ROUTE_VALUES);

/** Runtime guard — deny-by-default at every choke point that accepts a route. */
export function isRoute(v: string): v is Route {
  return ROUTE_SET.has(v);
}

/** Every inspector section is discoverable before its body loads. Bodies
 * consume these declarations directly; UI-control validates the same IDs. */
export const INSPECTOR_SECTIONS = {
  "setup-sec-model": { group: "setup", context: "conversation", label: "Model", keywords: "model provider account default next turn" },
  "setup-sec-context": { group: "setup", context: "conversation", label: "Context", keywords: "next turn composition channels tokens history trim reset memory pin mute source" },
  "setup-sec-tools": { group: "setup", context: "conversation", label: "Tools", keywords: "tools permissions gates breaker reset auto trip failure reason confinement" },
  "run-sec-progress": { group: "run", context: "conversation", label: "Current run", keywords: "stop cancel status model tokens duration trace copy filter" },
  "run-sec-runs": { group: "run", context: "conversation", label: "Run history", keywords: "history replay timeline" },
  "run-sec-agents": { group: "run", context: "conversation", label: "Agents", keywords: "agents delegation roles tasks" },
  "run-sec-turns": { group: "run", context: "conversation", label: "Turn measurements", keywords: "tokens latency measurements scope" },
  "run-sec-calls": { group: "run", context: "conversation", label: "Tool calls", keywords: "tools arguments results output reveal" },
  "run-sec-edits": { group: "run", context: "conversation", label: "Changed files", keywords: "files changes diff review" },
  "run-sec-record": { group: "run", context: "conversation", label: "Errors and interruptions", keywords: "failure error interruption incomplete" },
  "run-sec-ledger": { group: "run", context: "conversation", label: "Event history", keywords: "events history filter outcomes categories" },
  "run-sec-acts": { group: "run", context: "conversation", label: "Your actions", keywords: "actions interventions input" },
  "run-sec-codebase": { group: "run", context: "project", label: "Project state", keywords: "project codebase index reindex read code" },
  "run-sec-preparation": { group: "run", context: "conversation", label: "Input processing", keywords: "input context preparation" },
  "arm-sec-fire-when": { group: "arm", context: "workspace", label: "Create a watch", keywords: "trigger watch condition tool check context threshold path" },
  "arm-sec-palette": { group: "arm", context: "workspace", label: "Advanced expression", keywords: "custom expression operators vocabulary advanced" },
  "arm-sec-capture": { group: "arm", context: "workspace", label: "Save a capture", keywords: "save capture bookmark range label" },
  "arm-sec-captured": { group: "arm", context: "workspace", label: "Saved captures", keywords: "captures bookmarks open share clear" },
  "arm-sec-cocked": { group: "arm", context: "workspace", label: "Your watches", keywords: "watching fired triggers rearm clear" },
  "arm-sec-not-on-record": { group: "arm", context: "workspace", label: "How watches and captures work", keywords: "help limits scope storage" },
} as const;
export type InspectorSectionId = keyof typeof INSPECTOR_SECTIONS;
export type InspectorGroupId = (typeof INSPECTOR_SECTIONS)[InspectorSectionId]["group"];
export const INSPECTOR_SECTION_ENTRIES = Object.freeze(
  (Object.keys(INSPECTOR_SECTIONS) as InspectorSectionId[]).map(id => Object.freeze({
    id, ...INSPECTOR_SECTIONS[id],
    search: (INSPECTOR_SECTIONS[id].label + " " + INSPECTOR_SECTIONS[id].keywords).toLocaleLowerCase(),
  })),
);
export const INSPECTOR_SECTION_IDS = INSPECTOR_SECTION_ENTRIES.map(section => section.id);
const inspectorGroups = new Set<InspectorGroupId>();
for (const section of INSPECTOR_SECTION_ENTRIES) inspectorGroups.add(section.group);
export const INSPECTOR_GROUP_IDS = [...inspectorGroups];
