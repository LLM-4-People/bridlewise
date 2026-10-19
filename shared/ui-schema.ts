/**
 * UI schema wire types — shared between the server (schema builder) and the
 * client (renderer). Pure type declarations + the schema version constant.
 * No `@harness/*` imports so the server (NodeNext module resolution) can
 * import this without the client path aliases.
 *
 * The server's `server/schema/ui-schema.ts` is the canonical builder; this
 * file is the single source of truth for the wire SHAPE consumed by the
 * frontend. The frontend imports these types directly.
 *
 * Informed by VS Code contribution points (views, commands, menus,
 * configuration, when-clauses): the schema is declarative; the frontend
 * renders from it.
 */

// v2 adds `modules` — the Module declarations that supersede the
// menu/panel/widget triple. Bumped so a client built against v1 can detect
// the change rather than silently receiving a shape it cannot render.
import type { ModuleEntry, ModuleGroup, SelKey } from "./module-contract.ts";
import type { BlockActionsManifest } from "./block-contract.ts";

export const UI_SCHEMA_VERSION = "bridlewise-ui-schema/v2" as const;

// ── Slot types ──

export type PanelSlot = "sidebar" | "main" | "right-panel" | "modal";
export type WidgetSlot = "header-info" | "header-actions" | "chat-bar";

// ── Schema entry types ──
//
// MenuEntry / PanelEntry / WidgetEntry describe the DELETED menu/panel/widget
// declarations: the server now serves their wire fields as empty arrays (see
// server/schema/ui-schema.ts::buildUiSchema for why the fields did not drop
// with the arrays), and the only remaining consumers of these types are the
// old shell's stores, which are condemned with it. The types, the fields,
// their slot vocabularies and `routeWhenClause` all leave the contract when
// that tree does.

export type MenuEntry = Readonly<{
  readonly id: string;
  readonly label: string;
  readonly icon?: string;
  readonly route?: string;
  readonly order: number;
  /**
   * Which navigation GROUP this surface belongs to.
   *
   * Grouping is an editorial judgement ("Git and Files both belong to
   * Workspace"), not something derivable from the route name — so it is
   * DECLARED here, next to the surface it describes. It used to live as a
   * hardcoded `ROUTE_GROUP` lookup table inside `server/schema/derive-
   * modules.ts`, i.e. a second declaration of the menu, in a module whose
   * job is derivation. Required, so a new tab cannot silently land in a
   * default group.
   */
  readonly group: ModuleGroup;
  readonly when?: string;
  readonly children?: readonly MenuEntry[];
  /**
  * Secondary tabs are grouped into the TabBar's overflow "hamburger" menu
   * (less frequently used — declutters the primary bar). The overflow
   * grouping is data-driven (owned by the schema, not a hardcoded Set in
   * TabBar.svelte) so a new tab is added to `MENUS` with `secondary: true`
   * if it should overflow — no component change needed.
   */
  readonly secondary?: boolean;
}>;

export type PanelEntry = Readonly<{
  readonly id: string;
  readonly slot: PanelSlot;
  readonly component: string;
  readonly order: number;
  /**
   * The route this panel IS, when it is a navigable destination.
   *
   * DECLARED data, not recovered from the `when` string. The schema builder
   * derives the visibility predicate from it (`routeWhenClause`), so the
   * route appears exactly once in the declaration and the predicate is
   * generated. Consumers that need the route (the module generator, the
   * shell's stage resolution) read THIS field; nothing regex-parses a
   * predicate to get it back.
   */
  readonly route?: string;
  readonly when?: string;
  readonly props?: Readonly<Record<string, unknown>>;
  /**
   * Selection keys this panel PUBLISHES when the user picks something in it.
   *
   * Declared on the panel because the panel is the authored surface; the
   * module generator copies it onto the derived module (`derive-modules.ts`),
   * so the linkage is stated once, next to the thing that does it.
   */
  readonly selects?: readonly SelKey[];
  /**
   * Selection keys this panel RE-PROJECTS in response to.
   *
   * This is a claim about observable behaviour — the rail renders a bond mark
   * meaning "follows the selection" for any surface that declares one — so it
   * belongs only on a panel that genuinely re-reads when the key changes.
   * Declaring it to decorate a surface would make the mark meaningless on the
   * surfaces where it is true.
   */
  readonly reactsTo?: readonly SelKey[];
}>;

/**
 * The route→visibility-predicate projection — the ONE place the
 * `route == '<route>'` clause is spelled.
 *
 * A panel declares `route`; this builds the `when` clause the generic
 * when-evaluator consumes. Because generation is one-way (route → clause)
 * the two can never disagree, and no consumer has to parse the clause to
 * recover the route.
 */
export function routeWhenClause(route: string): string {
  return `route == '${route}'`;
}

export type WidgetEntry = Readonly<{
  readonly id: string;
  readonly slot: WidgetSlot;
  readonly label?: string;
  readonly icon?: string;
  readonly component?: string;
  readonly signalId?: string;
  readonly format?: string;
  readonly order: number;
  readonly when?: string;
}>;

export type SettingEntry = Readonly<{
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly type: "number" | "string" | "boolean" | "enum" | "object";
  readonly default: number | string | boolean | Readonly<Record<string, unknown>>;
  readonly min?: number;
  readonly max?: number;
  readonly enum?: readonly string[];
  /** Plain printable unit (e.g. "seconds", "tokens") — never internal shorthand. */
  readonly unit?: string;
  /**
   * When a change takes effect, AS DECLARED (and code-verified) by the
   * backend registration. Absent = not declared; the honest UI line is
   * "when this takes effect is not declared" — never a guess.
   */
  readonly effect?: "immediate" | "next-run" | "restart";
  /**
   * Id of the signal that measures this setting's effect — the explicit
   * setting→reading linkage, validated at registration on the backend.
   */
  readonly measuredBy?: string;
  readonly customizationId?: string;
  /**
   * The exposure module that OWNS this setting, as the registration declares
   * it — not as the id happens to be spelled.
   *
   * Forwarded rather than re-derived on the client. Splitting
   * `"search.threshold"` on its dot recovers the namespace *most* of the
   * time, which is the failure mode of a derivation: it is right until a
   * registration declares a module its id does not spell, and then the
   * setting silently lands in a category nobody chose. The declared owner
   * joins a setting to its category (`ExposureModuleEntry` below).
   *
   * Optional on the TYPE because a UI-declared setting (one with no
   * `customizationId`) belongs to no exposure module; absent is the honest
   * answer for those, never a guessed namespace.
   */
  readonly module?: string;
  readonly order: number;
}>;

/**
 * One exposure module, as the registry declares it — the CATEGORY a settings
 * surface groups by.
 *
 * The words come from the module's own registration file
 * (`shared/exposure/registrations/*.ts` → `registerExposureModule`), which is
 * what lets a control surface be derived rather than authored: the twelfth
 * module registered tomorrow arrives here with a real name, and nothing in a
 * component has to be edited for its settings to appear under it.
 *
 * A module that declares nothing does not appear in this list. A consumer
 * that meets a setting whose module is undeclared spells the namespace out
 * (the `humanizeModuleId` fallback) and says the category is underived —
 * absence renders as absence, never as an invented name.
 */
export type ExposureModuleEntry = Readonly<{
  /** The namespace every id in this module is prefixed with, e.g. `"search"`. */
  readonly id: string;
  /** What this area is CALLED, in the product's own words. */
  readonly title: string;
  /** What this area DOES — one plain sentence, no internal vocabulary. */
  readonly purpose: string;
}>;

export type ActionArgSpec = Readonly<{ type: string; required: boolean; description: string }>;

export type ActionEntry = Readonly<{
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly icon?: string;
  readonly actionId?: string;
  /**
   * The DECLARED owning module (`sys.<ns>` namespace of a backend exposure
   * action, e.g. `"awareness"` for `awareness.refresh`) — FORWARDED by the
   * schema builder from the registry's own declaration, never re-derived
   * from the id's spelling (the same rule `SettingEntry.module` and
   * `SignalEntry.module` follow: a registration that chose a module the id
   * does not imply must not be silently re-filed). Absent when the
   * declaration named none — a UI-declared action with no backend module —
   * and the consumer groups it under its honest catch-all rather than
   * inventing one.
   */
  readonly module?: string;
  readonly args?: Readonly<Record<string, ActionArgSpec>>;
  readonly order: number;
}>;

export type SignalEntry = Readonly<{
  readonly id: string;
  readonly module: string;
  readonly name: string;
  readonly description: string;
  readonly type: string;
  /** The unit a numeric value is expressed in ("ms", "ratio", …). Absent
   * (or explicitly undefined) for non-numeric signals, which have no honest
   * unit. */
  readonly unit?: string | undefined;
  /**
   * Declared abnormality bounds (numeric signals only): a value strictly
   * above `warnAbove` / strictly below `warnBelow` is abnormal by the owning
   * module's own semantics. Absent = no declared abnormality; a surface must
   * not invent one.
   */
  readonly abnormal?: Readonly<{ warnAbove?: number; warnBelow?: number }>;
  readonly labels?: readonly string[];
}>;

// ── The full schema ──

export type UiSchema = Readonly<{
  readonly version: string;
  /**
   * Module declarations — the surface vocabulary that supersedes
   * menus/panels/widgets. Populated by the schema builder from the authored
   * MODULES plus the exposure generator.
   *
   * Required (not optional) so a builder that forgets to emit it fails at
   * compile time rather than serving a schema whose modules silently vanish.
   */
  readonly modules: readonly ModuleEntry[];
  readonly menus: readonly MenuEntry[];
  readonly panels: readonly PanelEntry[];
  readonly widgets: readonly WidgetEntry[];
  readonly settings: readonly SettingEntry[];
  readonly actions: readonly ActionEntry[];
  readonly signals: readonly SignalEntry[];
  /**
   * Block id → its declared action affordances (title, consequence, input
   * template), derived from the block registry by the schema builder. This
   * is how a surface offers a verb next to a fact with zero bespoke wiring:
   * the words come from the declaration, the route from the id, and an
   * action absent here has no handler and must not be rendered.
   *
   * Optional on the TYPE (older fixtures construct schemas without it; an
   * absent manifest renders as no verbs, never as invented ones), always
   * emitted by the live builder.
   */
  readonly blockActions?: BlockActionsManifest;
  /**
   * The exposure modules, as declared — the category vocabulary a settings
   * surface groups by (§9.3). Derived from the registry, never authored by a
   * consumer: a namespace→name table living in a component is what this field
   * exists to delete, and it is the reason a module added tomorrow appears in
   * the settings index with no component change.
   *
   * Optional on the TYPE (older fixtures construct schemas without it; an
   * absent list renders every category by its spelled-out namespace, which is
   * honest), always emitted by the live builder.
   */
  readonly exposureModules?: readonly ExposureModuleEntry[];
}>;

// ── Value snapshot (current values for signals + customizations) ──

export type SignalValueEntry = Readonly<{
  readonly id: string;
  readonly value: number | string | boolean;
}>;

export type CustomizationValueEntry = Readonly<{
  readonly id: string;
  readonly value: number | string | boolean | Readonly<Record<string, unknown>>;
  /**
   * The display egress hides (part of) the standing value, so `value` is
   * served in its masked form — never the raw it stands for. Present exactly
   * when the server masked something; absent = the served value is the whole
   * truth. A settings surface uses this to keep a masked literal out of its
   * editable fields: the masked form is a display, never a draft.
   */
  readonly masked?: true;
}>;

export type UiSchemaValues = Readonly<{
  readonly signals: readonly SignalValueEntry[];
  readonly customizations: readonly CustomizationValueEntry[];
}>;
