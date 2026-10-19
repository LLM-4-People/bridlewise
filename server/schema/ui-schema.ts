/**
 * UI schema — the canonical schema-driven extension system for the web UI.
 *
 * The web UI renders dynamically from a schema served by the backend. To add
 * a new menu item, panel, or chat-bar widget, you add a schema entry in
 * `ui-declarations.ts` — no frontend code change is needed. This mirrors the
 * backend's exposure system (`src/shared/exposure/`): signals, actions, and
 * customizations are the backend's schema; this is the UI's schema.
 *
 * Architecture (informed by VS Code contribution points — views, commands,
 * configuration, when-clauses):
 *
 * - `modules` — the surface vocabulary (authored + exposure-derived). The
 * old menu/panel/widget vocabulary is deleted; the wire serves their
 * fields as empty arrays for one release window (see buildUiSchema).
 * - `settings` — config options surfaced to the user. Mirror the backend
 * customization metadata (type, default, min, max, enum, unit).
 * - `actions` — invokable operations. Mirror the backend action metadata.
 * - `signals` — observable value metadata. Mirror the backend signal
 * metadata. Values are read via `/api/schema/ui/values` (functions are
 * NOT serializable; only metadata is in the schema).
 *
 * The schema is the single source of truth for the UI LAYOUT. The frontend
 * fetches it at startup (`GET /api/schema/ui`) and renders from it. The
 * component registry (frontend) maps string keys to Svelte components; only
 * genuinely new visual content needs a registered component.
 *
 * `when` clauses: an optional declarative visibility predicate evaluated
 * against a UI context object (run, project, chat, streaming,...). The
 * evaluator lives in `shared/when-eval.ts` (shared shape — the server
 * emits the string; the client evaluates it). Supported grammar:
 * key — truthy (key present and truthy)
 *!key — falsy
 * key == 'value'string/number equality
 * key!= 'value'inequality
 * key == null — null check
 * expr1 && expr2 — AND
 * expr1 || expr2 — OR
 * (expr) — grouping
 * Dotted paths resolve against nested context (e.g. `run.status`).
 */

import { deriveExposureModules, mergeModules } from "./derive-modules.ts";
import { blockActionsManifest } from "../blocks/define.ts";
import {
  listSignals,
  listActions,
  listCustomizations,
  readSignal,
  executeAction,
  getAction,
  getCustomization,
  setCustomizationValue,
  listExposureModules,
  type Signal,
  type Action,
  type Customization,
  type ExposureModule,
} from "../kernel/canonical.ts";

import {
  UI_DECLARATIONS,
  type UiDeclarations,
} from "./ui-declarations.ts";
import { webWarn } from "../observability/debug-bridge.ts";
import { NotFoundError, SettingValueRefusedError, ValidationError } from "../kernel/errors.ts";
import { InputError } from "../../engine/src/kernel/errors.ts";
import { isHiddenFromUserDisplay } from "../llm/redaction.ts";

// ── Shared wire types (single source of truth: shared/ui-schema.ts) ──
// Local imports: only types used in THIS file's function signatures.
import {
  UI_SCHEMA_VERSION,
  type SignalEntry,
  type ActionEntry,
  type SettingEntry,
  type ExposureModuleEntry,
  type UiSchema,
  type SignalValueEntry,
  type CustomizationValueEntry,
  type UiSchemaValues,
} from "../../shared/ui-schema.ts";

// Re-export the full surface for consumers (server routes, tests).
export {
  UI_SCHEMA_VERSION,
  type MenuEntry,
  type PanelEntry,
  type WidgetEntry,
  type SettingEntry,
  type ExposureModuleEntry,
  type ActionEntry,
  type ActionArgSpec,
  type SignalEntry,
  type PanelSlot,
  type WidgetSlot,
  type UiSchema,
  type SignalValueEntry,
  type CustomizationValueEntry,
  type UiSchemaValues,
} from "../../shared/ui-schema.ts";

// ── Exposure metadata projections (strip non-serializable function fields) ──
// Functions (value, execute, current, set, reset) are NOT JSON-serializable,
// so only the metadata is projected into the schema. Values are read via
// `buildUiSchemaValues()` and the `/api/schema/ui/values` endpoint.

function signalToMeta(signal: Signal): SignalEntry {
  const base: SignalEntry = {
    id: signal.id,
    module: signal.module,
    name: signal.name,
    description: signal.description,
    type: signal.type,
  };
  let entry = base;
  if (signal.unit !== undefined) entry = { ...entry, unit: signal.unit };
  // Declared abnormality bounds, forwarded verbatim — the ONLY basis on
  // which a surface may color a reading as abnormal.
  if (signal.abnormal !== undefined) entry = { ...entry, abnormal: signal.abnormal };
  if (signal.labels !== undefined) entry = { ...entry, labels: signal.labels };
  return entry;
}

function actionToMeta(action: Action): ActionEntry {
  const base: ActionEntry = {
    id: action.id,
    label: action.name,
    description: action.description,
    order: 0,
    // The DECLARED owning module, forwarded verbatim (never re-derived from
    // the id) so a consumer can group the action where its registration
    // filed it — the same forwarding rule the signal and customization
    // projections follow.
    module: action.module,
  };
  let entry = base;
  if (action.args) {
    entry = { ...entry, args: action.args };
  }
  return entry;
}

function customizationToMeta(cust: Customization, order: number): SettingEntry {
  const base: SettingEntry = {
    id: cust.id,
    label: cust.name,
    description: cust.description,
    type: cust.type,
    default: cust.default,
    order,
  };
  let entry = base;
  if (cust.min !== undefined) entry = { ...entry, min: cust.min };
  if (cust.max !== undefined) entry = { ...entry, max: cust.max };
  if (cust.enum !== undefined) entry = { ...entry, enum: cust.enum };
  if (cust.unit !== undefined) entry = { ...entry, unit: cust.unit };
  // Effect timing: forwarded ONLY when the registration declares it (and the
  // declared vocabulary's `unspecified` is treated as undeclared). An absent
  // field is the honest signal for "when this takes effect is not declared".
  const effect = cust.contract?.effect;
  if (effect !== undefined && effect !== "unspecified") {
    entry = { ...entry, effect };
  }
  // The declared setting→signal measurement linkage (registration-validated).
  if (cust.measuredBy !== undefined) entry = { ...entry, measuredBy: cust.measuredBy };
  entry = { ...entry, customizationId: cust.id };
  // The DECLARED owning module — forwarded, not re-derived from the id, so a
  // setting joins the category its registration chose rather than the one its
  // spelling implies (shared/ui-schema.ts::SettingEntry.module).
  entry = { ...entry, module: cust.module };
  return entry;
}

/**
 * One declared exposure module on the wire — the settings surface's CATEGORY.
 *
 * A pure forward of the registry's own declaration. Nothing is renamed and
 * nothing is defaulted: a module the registry does not declare simply is not
 * in the list, and the client spells its namespace out rather than being
 * handed an invented name.
 */
function exposureModuleToMeta(m: ExposureModule): ExposureModuleEntry {
  return { id: m.id, title: m.title, purpose: m.purpose };
}

// ── Schema builder ──

let schemaBuilt: UiSchema | null = null;

/**
 * Build (and memoize) the full UI schema by merging the UI declarations
 * (menus, panels, widgets — the layout) with the live exposure metadata
 * (signals, actions, customizations — what the backend exposes).
 *
 * Idempotent: returns the same frozen object on repeated calls.
 */
export function buildUiSchema(decls: UiDeclarations = UI_DECLARATIONS): UiSchema {
  if (schemaBuilt !== null && decls === UI_DECLARATIONS) return schemaBuilt;

  const schema: UiSchema = Object.freeze({
    version: UI_SCHEMA_VERSION,
    // Authored modules plus the exposure generator (so the registry reaches
    // the screen without hand-written components). Authored always wins a
    // collision. The legacy menus/panels bridge is gone with the arrays it
    // projected.
    modules: mergeModules(decls.modules, deriveExposureModules()),
    // The menu/panel/widget declarations are DELETED, but the wire keeps
    // their fields as EMPTY ARRAYS rather than dropping them: the old shell
    // and its stores (typed against these fields) are still standing until
    // the entry swap deletes them, and dropping the fields would cascade
    // type breakage through a tree that is already condemned — an empty
    // vocabulary is the honest value ("this server declares no menus"),
    // while a missing field would be a wire-shape change made mid-window.
    // The fields and their entry types leave the contract WITH that tree.
    menus: Object.freeze([]),
    panels: Object.freeze([]),
    widgets: Object.freeze([]),
    settings: Object.freeze([
      ...decls.settings,
      ...listCustomizations().map((c, i) => customizationToMeta(c, decls.settings.length + i)),
    ]),
    actions: Object.freeze([
      ...decls.actions,
      ...listActions().map((a) => actionToMeta(a)),
    ]),
    signals: Object.freeze(listSignals().map((s) => signalToMeta(s))),
    // The verb manifest: derived from the block registry, never authored, so
    // a client cannot render an affordance no handler serves. Blocks are
    // registered by `registerAllRoutes` at boot — before the first schema
    // request builds (and memoizes) this object.
    blockActions: blockActionsManifest(),
    // The category vocabulary, straight from the registrations. This is what
    // makes the settings index DERIVED: a namespace declared tomorrow arrives
    // here, and the room groups by it with no component edit.
    exposureModules: Object.freeze(listExposureModules().map((m) => exposureModuleToMeta(m))),
  });

  if (decls === UI_DECLARATIONS) schemaBuilt = schema;
  return schema;
}

/**
 * Read current values for every registered signal + customization. Used by
 * the `/api/schema/ui/values` endpoint so the frontend can display live
 * signal/customization values without N round-trips.
 */
export function buildUiSchemaValues(viewer: Readonly<{ isAdmin: boolean }>): UiSchemaValues {
  const signals: SignalValueEntry[] = [];
  for (const s of listSignals()) {
    try {
      // PER CALLER: a signal whose value names the host's layout is served to
      // an admin as it is, to anyone else as its public form (or not at all).
      if (s.visibility?.viewer === "admin" && !viewer.isAdmin) {
        if (s.visibility.publicValue !== undefined) signals.push({ id: s.id, value: s.visibility.publicValue() });
        continue;
      }
      const value = readSignal(s.id);
      signals.push({ id: s.id, value });
    } catch (signalErr) {
      webWarn("ui-schema", "signal read failed", () => ({
        signalId: s.id,
        error: signalErr instanceof Error ? signalErr.message : String(signalErr),
      }));
    }
  }

  const customizations: CustomizationValueEntry[] = [];
  for (const c of listCustomizations()) {
    try {
      const value = c.current();
      // A value the display egress will hide is FLAGGED on its entry: the
      // egress still does the masking (one masking site, the router's
      // choke point), and the flag is derived from the same walk in the
      // same process, so the two can never disagree. A settings surface
      // reads the flag to treat the served masked form as a display, never
      // as a draft — an editable field prefilled with the masked literal
      // would write the mask back as data on the next save.
      customizations.push(
        isHiddenFromUserDisplay(value)
          ? { id: c.id, value, masked: true }
          : { id: c.id, value },
      );
    } catch (customErr) {
      webWarn("ui-schema", "customization read failed", () => ({
        customizationId: c.id,
        error: customErr instanceof Error ? customErr.message : String(customErr),
      }));
    }
  }

  return Object.freeze({
    signals: Object.freeze(signals),
    customizations: Object.freeze(customizations),
  });
}

/**
 * Execute a registered exposure action by id. Returns the action result.
 * Throws a typed error if the action is unknown or execution fails.
 */
export function executeSchemaAction(
  actionId: string,
  args?: Readonly<Record<string, unknown>>,
): unknown {
  const action = getAction(actionId);
  if (!action) {
    throw new NotFoundError(
      `UI schema: unknown action "${actionId}"`,
      "unknown_action",
    );
  }
  return executeAction(actionId, args);
}

/**
 * Set a customization value by id — the SINGLE server-side write path for
 * exposure customizations.
 *
 * Deny-by-default at the lowest choke point: the write goes through the
 * registry's `setCustomizationValue`, which validates the value against the
 * customization's DECLARED contract (type, min, max, enum) before the owning
 * module's `set` callback ever runs. The raw `entry.set(...)` is NOT used —
 * a hand-written registration's `set` is free of any bounds check, so calling
 * it directly silently accepted out-of-range and wrong-typed values even
 * though the schema advertised `min`/`max`/`enum` to the UI. No clamping: an
 * invalid value is refused unchanged.
 *
 * Errors are mapped onto the shared taxonomy: an unknown id is a 404
 * (`unknown_customization`); an invalid value is a DESIGNED validation
 * refusal of the guided family — a 428 `SettingValueRefusedError` with code
 * `invalid_customization_value` and the registry's plain-words sentence. The
 * client expects to render that sentence (the sheet answers the Save press
 * with it), so the refusal travels in the 200 envelope at the block door and
 * never logs as a browser console error; a value a caller could not even
 * shape (`invalid_customization_body`) keeps its raw 400.
 *
 * Enforced mechanically by
 * `tests/prevention/customization-write-path-owner.test.ts`, which
 * round-trips EVERY registered customization (dynamic discovery) and asserts
 * that out-of-contract values are rejected.
 */
export function setSchemaCustomization(
  customizationId: string,
  value: number | string | boolean | Readonly<Record<string, unknown>>,
): void {
  const cust = getCustomization(customizationId);
  if (!cust) {
    throw new NotFoundError(
      `UI schema: unknown customization "${customizationId}"`,
      "unknown_customization",
    );
  }
  try {
    setCustomizationValue(customizationId, value);
  } catch (err) {
    // A value-shaped refusal is DESIGNED and keeps its guided serving: the
    // registry's plain-words bounds sentence (an InputError) and the config
    // gate's schema sentence (a ValidationError) are both the caller's
    // value being declined, so they become the 428 envelope refusal the
    // sheet answers the Save press with. Every other failure keeps its
    // honest error — the config write lock's timeout is a transient
    // refusal that never says the value was wrong, and re-coding it as a
    // value refusal would misname it to the user.
    if (err instanceof InputError || err instanceof ValidationError) {
      throw new SettingValueRefusedError(err.message, "invalid_customization_value");
    }
    throw err;
  }
}

/** Reset the memoized schema (test-only). */
export function resetUiSchemaCache(): void {
  schemaBuilt = null;
}
