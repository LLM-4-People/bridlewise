/**
 * Settings data — pure helpers behind the setting sheet + the index
 * (DESIGN-COCKPIT-V2 §9). No DOM, no fetch, no stores: everything here is a
 * function over the SERVED ui-schema + values snapshot, Node-testable.
 *
 * Zero-knowledge law: every word the sheet or the index shows comes from the
 * schema the server serves (labels, descriptions, enum values, units, the
 * save verb's consequence) — nothing is authored here. The fact→setting and
 * setting→surface mappings resolve MECHANICALLY from the registry namespace
 * (`module.name` ids), never from a hand-wired table.
 *
 * Guard: tests/cockpit/settings-data.test.ts (+ the raw-label and one-write-
 * path mutation checks in settings-sheet/room suites).
 */

import type {
  CustomizationValueEntry,
  ExposureModuleEntry,
  SettingEntry,
  SignalEntry,
  UiSchema,
  UiSchemaValues,
} from "../../../shared/ui-schema.ts";
import type { BlockActionDescriptor } from "../../../shared/block-contract.ts";
// The id→human-name spelling rule has ONE owner
// (tests/prevention/ui-declaration-bindings-owner.test.ts::G enforces it), and
// this is it. A namespace with no declared category is spelled out by the same
// function the navigation groups use, so the two never render one id two ways.
import { humanizeId } from "../../../shared/module-contract.ts";

/** The value domain a customization can hold (mirrors the wire). */
export type SettingValue = number | string | boolean | Readonly<Record<string, unknown>>;

/** Decimal SI token quantities. Undefined is intentionally blank; null is
 * invalid or cannot survive a JSON number round trip without changed digits.
 * The expanded string is also the form's preview, so parsing and feedback
 * cannot disagree about what 32k or 1.5m will save. */
export function parseTokenQuantity(raw: string): Readonly<{ value: number; expanded: string }> | null | undefined {
  const text = raw.trim();
  if (text === "") return undefined;
  const match = /^(?:(\d+)(?:\.(\d*))?|\.(\d+))([km])?$/i.exec(text);
  if (match === null) return null;
  const fraction = match[2] ?? match[3] ?? "";
  const normalize = (digits: string, scale: number): Readonly<{digits:string;scale:number}> => {
    digits = digits.replace(/^0+/, "");
    if (digits === "") return {digits:"0",scale:0};
    let end = digits.length;
    while (end > 0 && digits.charCodeAt(end - 1) === 48) end -= 1;
    return { digits: digits.slice(0,end), scale: scale-(digits.length-end) };
  };
  const suffix = match[4]?.toLowerCase();
  const source = normalize((match[1] ?? "0") + fraction, fraction.length - (suffix === "k" ? 3 : suffix === "m" ? 6 : 0));
  const value = Number(`${source.digits}e${-source.scale}`);
  if (!Number.isFinite(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER) return null;
  const [mantissa, exponent = "0"] = String(value).split("e");
  const [whole, decimal = ""] = mantissa!.split(".");
  const roundTrip = normalize(whole!+decimal, decimal.length-Number(exponent));
  if (roundTrip.digits !== source.digits || roundTrip.scale !== source.scale) return null;
  const {digits,scale} = source;
  const expanded = scale <= 0 ? digits + "0".repeat(-scale)
    : digits.length > scale ? digits.slice(0,-scale)+"."+digits.slice(-scale)
    : "0."+"0".repeat(scale-digits.length)+digits;
  return {value,expanded};
}

/**
 * ONE CHOICE OF AN ENUM SETTING — the token the wire carries, and the words
 * a person reads. They are never the same field, and that is the point.
 *
 * WHY THIS TYPE EXISTS. The wire carries `enum: readonly string[]` — bare
 * server tokens (`round-robin`, `next-run`, `short-term`). Every surface that
 * had that array in its hands rendered the token, because a token IS a
 * renderable string and nothing in the row said otherwise: the segmented
 * control printed `{option}`, the index printed the current member, the
 * provenance line printed the default member, and the reset button printed it
 * again. Four sites, one cause — the row handed out a `readonly string[]`.
 *
 * So the row no longer HAS one. `SettingRow.options` is a list of these, and
 * an option is not a string: `{option}` renders `[object Object]` and
 * `displayed === option` does not typecheck. The bare token is still
 * reachable, deliberately — `commit` must send it — but it has to be asked
 * for by name (`option.value`), which is a different act from forgetting.
 */
export type SettingOption = Readonly<{
  /** What the wire calls this choice, and what a write must send. */
  value: string;
  /** What a person reads. Derived — see `optionWords`. */
  words: string;
}>;

/** One row of the flat index / one sheet's subject. */
export type SettingRow = Readonly<{
  /** The customization id — the registry identity ("search.threshold"). */
  id: string;
  /** "served" rows write through the settings block; "local" rows are
   * device-side cockpit preferences (settings/local-prefs.ts). */
  kind: "served" | "local";
  /** Registry namespace, derived from the id prefix. */
  module: string;
  /** Served plain-words name. NEVER the raw id (labelViolation enforces). */
  label: string;
  /** Served behavior description — what the index searches by. */
  description: string;
  type: "number" | "string" | "boolean" | "enum" | "object";
  defaultValue: SettingValue;
  min?: number;
  max?: number;
  /**
   * The choices of an enum row, each already carrying its words. Deliberately
   * NOT `readonly string[]` — see `SettingOption`.
   */
  options?: readonly SettingOption[];
  unit?: string;
  /**
   * WHEN a change starts mattering, as the registration declares it. Absent =
   * undeclared, and the honest line is "when this takes effect is not
   * declared" — never a guessed "immediately".
   */
  effect?: "immediate" | "next-run" | "restart";
  /**
   * The signal the REGISTRATION names as measuring this setting's effect
   * (validated at registration on the backend). Absent = the registration
   * claims no measurement; a surface must not go looking for one.
   */
  measuredBy?: string;
}>;

/** The id of the settings block — the ONE validated write path (§9.1). */
export const SETTINGS_BLOCK = "settings.customizations";
/** Its declared save action name. */
export const SETTINGS_SET_ACTION = "set";
/** The invalidation event the save's declaration names. */
export const SETTINGS_CHANGED_EVENT = "settings:changed";

/**
 * The diagnostic-modes block — the ARRAY-valued config leaf's own door. The
 * served-row grammar holds scalars and JSON objects (the sheet refuses array
 * JSON by design), so `performance.diagnosticModes.excludedModes` is served
 * as a checkbox-list section whose read and write go through this block, the
 * same fabric the customizations door rides.
 */
export const DIAGNOSTIC_MODES_BLOCK = "settings.diagnosticModes";
/** Its declared save action name. */
export const DIAGNOSTIC_MODES_SET_ACTION = "set";

/** The wire shape the diagnostic-modes block's read serves: the declared
 * mode vocabulary (the engine's own list) and what the config file excludes. */
export type DiagnosticModesState = Readonly<{
  modes: readonly string[];
  excluded: readonly string[];
}>;

// ── Namespace derivation (the registry's id grammar: `module.name`) ────────

/** Owning module from a dotted id ("search.threshold" → "search"). */
export function moduleOf(id: string): string {
  const dot = id.indexOf(".");
  return dot > 0 ? id.slice(0, dot) : id;
}

// ── The raw-key law (mutation-tested) ──────────────────────────────────────

/**
 * A label that is a raw registry key must never render as a row's name —
 * the index speaks behavior words, not internal vocabulary. Returns the
 * violation in plain words, or null for a clean label.
 */
export function labelViolation(label: string, id: string): string | null {
  const trimmed = label.trim();
  if (trimmed.length === 0) return `setting "${id}" has an empty label`;
  if (trimmed === id) return `setting "${id}" label IS the raw key`;
  if (/^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)+$/.test(trimmed))
    return `setting "${id}" label "${trimmed}" is a dotted internal id`;
  if (/_/.test(trimmed)) return `setting "${id}" label "${trimmed}" carries snake_case`;
  return null;
}

// ── The same law, one level down: an ENUM MEMBER is not a word either ─────

/**
 * THE WORDS FOR ONE CHOICE, DERIVED — never looked up.
 *
 * A table mapping `round-robin → "Round robin"` would be a second vocabulary
 * beside the registry's, and the first member declared after it was written
 * would render as its token while the table sat there looking authoritative.
 * So there is no table. The spelling rule this project already owns —
 * `humanizeId`, the same function that names a navigation group nobody has
 * declared a label for — is applied to the member token, and that is the whole
 * derivation. A member added to a registration tomorrow arrives spelled.
 *
 * WHAT THE DERIVATION CAN AND CANNOT DO, said plainly because the limit is
 * real and the fix for it is not in this repo:
 *
 *   `round-robin` → `Round robin`      `next-run`  → `Next run`
 *   `short-term`  → `Short term`       `oldest`    → `Oldest`
 *   `nextRun`     → `Next Run`         `relevance` → `Relevance`
 *
 * — because those tokens CARRY their words. `fifo`, `lifo` and `tfidf` do not,
 * and no function over the token can invent them: `humanizeId("fifo")` is
 * `"Fifo"`, which is better than `fifo` and is still not the words a person
 * needs. Nothing here can distinguish `fifo` from `oldest` by inspection —
 * both are lowercase letter runs — so this derivation deliberately does NOT
 * pretend to. The place that knows an acronym is an acronym is the
 * DECLARATION (`shared/exposure/customization.ts::makeEnumCustomization` and
 * the registrations beside it), and the structural fix is for the wire to
 * carry declared words per member. That is a contract change across both
 * repositories and it is recorded as its own task, not smuggled in as a map.
 */
export function optionWords(member: string): string {
  return humanizeId(member.trim());
}

/**
 * A member the derivation genuinely cannot spell, in plain words, or null.
 *
 * This is the LOUD half, and it is narrow ON PURPOSE. It catches the members
 * that are structurally internal vocabulary — a dotted id, a path, a token
 * with no letters in it at all — where capitalising the first character
 * produces something a reader would rightly call a bug. It does NOT catch an
 * acronym, and claiming otherwise would be the more dangerous failure: a
 * violation nobody can act on trains people to override the check.
 *
 * Returned rather than thrown, for the same reason `labelViolation` is: the
 * index must still render every row it was served (a violation must be
 * visible, not hide a whole screen), and the SHEET for the offending setting
 * refuses at its render boundary. One bad member costs one sheet, not the
 * settings room.
 */
export function optionViolation(member: string): string | null {
  const token = member.trim();
  if (token.length === 0) return `an enum choice with an empty token has no words to show`;
  if (/[./:@\\]/.test(token))
    return `enum choice "${token}" is a dotted or pathed internal id — no capitalisation makes that words`;
  if (!/[a-zA-Z]/.test(token))
    return `enum choice "${token}" carries no letters, so there are no words in it to spell`;
  return null;
}

/** Every choice of an enum row, spelled. The ONE builder; `toRow` and the
 * local preference rows both come through it, so served and device-side
 * choices cannot be spelled two different ways. */
export function settingOptions(members: readonly string[]): readonly SettingOption[] {
  return Object.freeze(
    members.map((value) => Object.freeze({ value, words: optionWords(value) })),
  );
}

// ── Served rows ────────────────────────────────────────────────────────────

/**
 * Every served customization as an index row, in the schema's own order.
 * Rows whose label violates the raw-key law are still RETURNED (the render
 * boundary throws on them — a violation must be loud, not silently hidden).
 */
export function servedRows(schema: UiSchema | null): readonly SettingRow[] {
  if (schema === null) return [];
  const rows: SettingRow[] = [];
  for (const s of schema.settings) {
    if (s.customizationId === undefined) continue;
    rows.push(toRow(s));
  }
  return rows;
}

function toRow(s: SettingEntry): SettingRow {
  const id = s.customizationId ?? s.id;
  const base: SettingRow = {
    id,
    kind: "served",
    // The DECLARED owner first (the registration says which module owns this
    // knob); the id's namespace only when the wire carries no declaration —
    // an older server, whose settings then group by their spelling, which is
    // the same answer for every registration that exists today and an honest
    // approximation rather than an invented category.
    module: s.module ?? moduleOf(id),
    label: s.label,
    description: s.description,
    type: s.type,
    defaultValue: s.default,
  };
  let row = base;
  if (s.min !== undefined) row = { ...row, min: s.min };
  if (s.max !== undefined) row = { ...row, max: s.max };
  if (s.enum !== undefined) row = { ...row, options: settingOptions(s.enum) };
  if (s.unit !== undefined) row = { ...row, unit: s.unit };
  if (s.effect !== undefined) row = { ...row, effect: s.effect };
  if (s.measuredBy !== undefined) row = { ...row, measuredBy: s.measuredBy };
  return row;
}

/** Find one served row by customization id. */
export function servedRow(schema: UiSchema | null, id: string): SettingRow | null {
  if (schema === null) return null;
  const entry = schema.settings.find((s) => s.customizationId === id);
  return entry === undefined ? null : toRow(entry);
}

/**
 * The values snapshot's entry for one customization — the ONE finder. The
 * entry (not just its value) is what a settings surface consumes: it carries
 * the server's own `masked` flag, the fact a surface needs to keep a masked
 * literal out of editable fields.
 */
export function servedCustomizationEntry(
  values: UiSchemaValues | null,
  id: string,
): CustomizationValueEntry | undefined {
  if (values === null) return undefined;
  return values.customizations.find((c) => c.id === id);
}

/** The current served value from the values snapshot, or undefined when the
 * snapshot has not answered yet (honest absence, never a fabricated 0). */
export function servedValue(
  values: UiSchemaValues | null,
  id: string,
): SettingValue | undefined {
  return servedCustomizationEntry(values, id)?.value;
}

// ── Value formatting (plain, honest) ───────────────────────────────────────

/** Format a setting value for a row. `undefined` prints its absence. */
export function formatValue(value: SettingValue | undefined, unit?: string): string {
  if (value === undefined) return "not read yet";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "number") {
    const num = Number.isFinite(value) ? String(value) : "—";
    return unit !== undefined && unit.length > 0 ? `${num} ${unit}` : num;
  }
  if (typeof value === "string") return value.length > 0 ? value : "(empty)";
  try {
    const json = JSON.stringify(value);
    return json.length > 48 ? `${json.slice(0, 47)}…` : json;
  } catch {
    return "(structured value)";
  }
}

/**
 * ONE ROW'S VALUE, IN THE WORDS THAT ROW USES — the reader every surface
 * showing a setting's value must come through.
 *
 * `formatValue` above knows the value's TYPE and nothing else, so for an enum
 * it could only ever print the token: a string is a string. This function
 * knows the ROW, which is the only thing that knows a given string is a
 * CHOICE with words already attached. Every raw token that reached a screen
 * reached it through a call that had the row in hand and asked the type-only
 * reader anyway.
 *
 * A value that is not one of the row's own choices prints through
 * `formatValue` unchanged rather than being suppressed: a served value outside
 * its own declared enum is a real fact about the install, and hiding it behind
 * a dash would be the surface deciding the server is wrong.
 */
export function formatSetting(row: SettingRow, value: SettingValue | undefined): string {
  if (value === undefined) return formatValue(undefined, row.unit);
  if (row.options !== undefined && typeof value === "string") {
    const choice = row.options.find((o) => o.value === value);
    if (choice !== undefined) return choice.words;
  }
  return formatValue(value, row.unit);
}

// ── Search — behavior words over the served descriptions (§9.3) ───────────

/**
 * Filter rows by behavior words: every whitespace-separated term must match
 * somewhere in the row's served language (label, description, enum values,
 * unit) or its id — internal names still FIND a row, they just never label
 * one. Empty query returns everything.
 */
export function searchRows(
  rows: readonly SettingRow[],
  query: string,
): readonly SettingRow[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return rows;
  return rows.filter((row) => {
    const haystack = [
      row.label,
      row.description,
      row.id,
      row.module,
      row.unit ?? "",
      // BOTH SPELLINGS of every choice. Searching "round robin" must find the
      // row a reader can SEE that phrase on, and searching `round-robin` must
      // still find it too — internal names find a row, they just never label
      // one (the paragraph above). Joining the options themselves would have
      // put `[object Object]` in the haystack and silently ended enum search.
      ...(row.options ?? []).flatMap((o) => [o.value, o.words]),
    ]
      .join(" ")
      .toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
}

// ── Registry linkage: fact ↔ setting, setting ↔ measured effect (§9.1) ────

/**
 * The customization ids a SIGNAL maps to, mechanically: an identical id is
 * the exact linkage (the registry registers some knobs as both signal and
 * customization); otherwise every customization in the signal's namespace.
 * Never hand-wired; an unlinked signal honestly maps to nothing.
 */
export function settingIdsForSignal(
  schema: UiSchema | null,
  signalId: string,
): readonly string[] {
  if (schema === null) return [];
  const ids = new Set(
    schema.settings.filter((s) => s.customizationId !== undefined).map((s) => s.customizationId!),
  );
  if (ids.has(signalId)) return [signalId];
  const signal = schema.signals.find((s) => s.id === signalId);
  const module = signal?.module ?? moduleOf(signalId);
  return [...ids].filter((id) => moduleOf(id) === module);
}

/**
 * The signal that MEASURES a customization.
 *
 * Two DECLARED linkages, in order of precision, and nothing looser:
 *
 *   1. `measuredBy` — the registration names the measuring signal outright
 *      and the backend validates that the signal exists. This is the explicit
 *      claim, so it wins.
 *   2. the identical-id registration — the registry registers some knobs as
 *      both a signal and a customization under one id, which is the same
 *      claim made by coincidence of naming.
 *
 * Anything else is null. Reaching for "a signal in the same namespace" would
 * be a linkage the registry never made.
 *
 * Precedence matters and was wrong before: only (2) was consulted, so every
 * setting that declares `measuredBy` — the explicit, validated form — showed
 * no reading at all, while the surface's own comment claimed the linkage was
 * mechanical.
 */
export function linkedSignal(schema: UiSchema | null, id: string): SignalEntry | null {
  if (schema === null) return null;
  const entry = schema.settings.find((s) => (s.customizationId ?? s.id) === id);
  const declared = entry?.measuredBy;
  if (declared !== undefined) {
    return schema.signals.find((s) => s.id === declared) ?? null;
  }
  return schema.signals.find((s) => s.id === id) ?? null;
}

/**
 * The measured-effect line for a setting (§9.1) — ONLY when genuinely
 * derivable: a DECLARED measuring signal exists AND the values snapshot
 * carries its reading. Otherwise null and the sheet omits the line entirely.
 */
export function measuredEffect(
  schema: UiSchema | null,
  values: UiSchemaValues | null,
  id: string,
): string | null {
  const signal = linkedSignal(schema, id);
  if (signal === null || values === null) return null;
  const reading = values.signals.find((s) => s.id === signal.id)?.value;
  if (reading === undefined) return null;
  return `measured now · ${formatValue(reading, signal.unit)}`;
}

// ── Provenance: is this value a CHOICE, or the built-in default? (§9.3) ────

/**
 * Where a standing value came from, as far as the record actually proves.
 *
 * THE HONEST LIMIT, stated once here so no surface has to re-reason about it:
 * the values snapshot carries a value, not a history. A value that DIFFERS
 * from the declared default proves an explicit change happened — nothing else
 * could have moved it. A value that MATCHES the default proves only that: it
 * cannot distinguish "nobody ever touched this" from "someone set it back".
 *
 * So the two answers are `changed` and `at-default`, not "you set this" and
 * "nobody set this". Claiming the second would be inventing a fact the
 * snapshot does not contain — and the whole point of this surface is that the
 * difference between a choice and a default is stated, not implied.
 */
export type Provenance = "changed" | "at-default" | "unread";

export function provenanceOf(
  row: SettingRow,
  current: SettingValue | undefined,
): Provenance {
  if (current === undefined) return "unread";
  return sameSettingValue(current, row.defaultValue) ? "at-default" : "changed";
}

/** Value equality across the whole value domain (objects compare by shape). */
export function sameSettingValue(a: SettingValue, b: SettingValue): boolean {
  if (typeof a === "object" || typeof b === "object") {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return a === b;
}

/**
 * The provenance sentence, in plain words, with the default spelled out so
 * the reader can see what "the default" actually is without opening anything.
 */
export function provenanceLine(row: SettingRow, current: SettingValue | undefined): string {
  switch (provenanceOf(row, current)) {
    case "unread":
      return "not read yet — nothing is being shown for this value";
    case "at-default":
      // Deliberately NOT "nobody changed this": see the type's doc.
      return `at the built-in default (${formatSetting(row, row.defaultValue)})`;
    case "changed":
      return `changed from the built-in default (${formatSetting(row, row.defaultValue)})`;
  }
}

/**
 * When a change starts mattering, in plain words — DECLARED only.
 *
 * An undeclared timing prints as undeclared. Every registration that says
 * nothing would otherwise be silently promoted to "immediately", which is the
 * exact lie the effect field was added to stop (shared/ui-schema.ts).
 */
export function effectLine(row: SettingRow): string {
  switch (row.effect) {
    case "immediate":
      return "takes effect immediately";
    case "next-run":
      return "takes effect on the next run";
    case "restart":
      return "takes effect after a restart";
    default:
      return "when this takes effect is not declared";
  }
}

// ── Categories — DERIVED from declarations, never authored here (§9.3) ────

/**
 * One category of the settings index: a declared module and the rows it owns.
 *
 * THE PROPERTY THIS PROTECTS. The words come from the registry's own module
 * declarations (`shared/exposure/registrations/*.ts` → `registerExposureModule`,
 * forwarded as `UiSchema.exposureModules`). No table in this file, and none in
 * the room, says what a namespace is called — which is what makes the surface
 * survive the next capability: a module declared tomorrow arrives with its
 * words already attached and its settings group themselves under it.
 *
 * `declared` is the honest flag for the other case. A namespace that owns
 * settings but declares no category still renders (its rows must never become
 * unreachable), under its spelled-out namespace, and SAYS the category is
 * underived. The guard fails on a non-empty set of those, so the fallback is a
 * visible gap rather than a silent one.
 */
export type SettingCategory = Readonly<{
  /** The module namespace — the category's identity, never its label. */
  id: string;
  /** Declared title, or the namespace spelled out when nothing is declared. */
  title: string;
  /** Declared purpose sentence, or null when the module declares none. */
  purpose: string | null;
  /** Whether a declaration backed `title`/`purpose`. */
  declared: boolean;
  rows: readonly SettingRow[];
}>;

/**
 * A namespace spelled for a human — the FALLBACK when nothing is declared.
 *
 * Not a second implementation: it is `shared/module-contract.ts::humanizeId`,
 * the single owner of that spelling rule, re-exported under the noun this
 * surface uses. The registry has its own copy (`shared/exposure/module.ts`)
 * only because the two trees cannot import each other, and that copy's doc
 * says so.
 */
export const humanizeModule = humanizeId;

/**
 * Group rows into categories using ONLY declared words.
 *
 * `declarations` is the joined declaration list — the served
 * `schema.exposureModules` plus any client-side registry that owns rows of its
 * own (the cockpit's device preferences declare theirs in
 * `settings/local-prefs.ts`, beside the rows, for the same reason the server's
 * live beside theirs).
 *
 * Order: declared categories in the order they were declared, then undeclared
 * ones by namespace. Deterministic, so nothing moves between renders, and the
 * gap sorts to the end where it reads as a gap.
 *
 * A category with no rows is NOT returned — an empty group is a heading with
 * nothing behind it. A declaration whose rows are all filtered out by a search
 * is likewise absent from the result; the room says how many categories the
 * search passed over.
 */
export function categorize(
  rows: readonly SettingRow[],
  declarations: readonly ExposureModuleEntry[],
): readonly SettingCategory[] {
  const byModule = new Map<string, SettingRow[]>();
  for (const row of rows) {
    const bucket = byModule.get(row.module);
    if (bucket === undefined) byModule.set(row.module, [row]);
    else bucket.push(row);
  }

  const declaredOrder = new Map<string, number>();
  declarations.forEach((d, i) => declaredOrder.set(d.id, i));

  const out: SettingCategory[] = [];
  for (const [id, moduleRows] of byModule) {
    const decl = declarations.find((d) => d.id === id);
    out.push({
      id,
      title: decl?.title ?? humanizeModule(id),
      purpose: decl?.purpose ?? null,
      declared: decl !== undefined,
      rows: moduleRows,
    });
  }
  out.sort((a, b) => {
    const ra = declaredOrder.get(a.id);
    const rb = declaredOrder.get(b.id);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return a.id.localeCompare(b.id);
  });
  return Object.freeze(out);
}

/**
 * The namespaces that own rows but declare no category — the gap, named.
 * A guard fails on a non-empty list; the room renders them anyway, spelled
 * out, so no setting is ever unreachable because its words are missing.
 */
export function undeclaredCategories(
  rows: readonly SettingRow[],
  declarations: readonly ExposureModuleEntry[],
): readonly string[] {
  const declared = new Set(declarations.map((d) => d.id));
  const missing = new Set<string>();
  for (const row of rows) if (!declared.has(row.module)) missing.add(row.module);
  return Object.freeze([...missing].sort());
}

// ── Surface mapping — honest, mechanical (§9.3 "which surface … a link") ──

export type SurfaceLink = Readonly<{ room: string; label: string }>;

/**
 * Where a MODULE's behavior manifests, as a navigable room — the same
 * derivation `surfaceFor` answers a row's category with, asked for a module
 * id alone. Readings-only modules own no rows, so the settings index can
 * only reach this question by declaration id — and the answer is what keeps
 * such an area's one settings-side surface (its greyed rail tile) from
 * being a dead end: where its readings render is derivable from the same
 * registry facts, or honestly null when nothing is measured and no room of
 * its own is built. Never a hand map: a module registered tomorrow answers
 * mechanically.
 */
export function surfaceForModule(
  schema: UiSchema | null,
  moduleId: string,
  roomExists: (roomId: string) => boolean,
): SurfaceLink | null {
  if (roomExists(moduleId)) {
    return { room: moduleId, label: `manifests in the ${moduleId} room` };
  }
  const hasSignals = schema?.signals.some((s) => s.module === moduleId) ?? false;
  if (hasSignals && roomExists("instruments")) {
    return { room: "instruments", label: "measured in the instruments room" };
  }
  return null;
}

/**
 * Where a setting's behavior manifests, as a navigable room — ONLY where a
 * real mapping exists: the module's own room by NAME EQUALITY (the rooms
 * file convention is namespace-shaped: "tools" → ToolsRoom, "memory" →
 * MemoryRoom), else the instruments room when the module registers signals
 * (its behavior is measured there). `roomExists` is injected so the link
 * only renders for a room that is actually built — a link into a "not built
 * yet" screen would be a fabricated destination.
 */
export function surfaceFor(
  schema: UiSchema | null,
  row: SettingRow,
  roomExists: (roomId: string) => boolean,
): SurfaceLink | null {
  if (row.kind === "local") return null; // manifests everywhere; no ONE surface
  return surfaceForModule(schema, row.module, roomExists);
}

// ── The save verb's served words (§9.1 — the consequence rides the wire) ──

/**
 * ONE declared block action, from the schema's block-action manifest. The
 * generic lookup behind the save verbs — the same words law for every block
 * a settings surface posts to. Null when the server declares none: the
 * surface renders its control honestly disabled, never an invented one.
 */
export function blockActionDescriptor(
  schema: UiSchema | null,
  block: string,
  actionName: string,
): BlockActionDescriptor | null {
  const list = schema?.blockActions?.[block];
  return list?.find((a) => a.name === actionName) ?? null;
}

/**
 * The declared save action for the settings block, from the schema's block-
 * action manifest. Null when the server declares none — the sheet then
 * renders the save verb honestly disabled (§1.2), never an invented one.
 */
export function saveDescriptor(schema: UiSchema | null): BlockActionDescriptor | null {
  return blockActionDescriptor(schema, SETTINGS_BLOCK, SETTINGS_SET_ACTION);
}

/**
 * The declared save action for the diagnostic-modes block — the array
 * section's save words come from the served manifest exactly as the sheet's
 * do (zero-knowledge law: no surface authors its own verb language).
 */
export function diagnosticModesSaveDescriptor(schema: UiSchema | null): BlockActionDescriptor | null {
  return blockActionDescriptor(schema, DIAGNOSTIC_MODES_BLOCK, DIAGNOSTIC_MODES_SET_ACTION);
}
