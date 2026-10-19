/**
 * Cockpit-local preferences (DESIGN-COCKPIT-V2 §9.3). the device-side rows
 * of the settings index: density, theme, debug logging, the two splitter
 * numbers, and the two scale knobs (spacing step, motion step).
 *
 *   density. `data-density` on :root (tokens.css §2.7: row heights 24/28/34,
 *             type delta), values scan | work | deep;
 *   theme  . `data-cockpit-theme` on :root (tokens.css §12.1: carbon dark
 *             default; "light" switches every token to the paper logbook);
 *   debug  . whether this browser's console carries the cockpit's diagnostic
 *             messages (`configureClientDebug`, the one emit owner. off is
 *             zero overhead). Device-scoped like the other two: it describes
 *             THIS BROWSER's console, which no other device shares.
 *   spacing. inline override of `--sp-unit` (tokens.css). The whole scale
 *             is a calc of this one length; the click floor (`--hit-min`)
 *             does not follow it.
 *   motion . inline override of `--t-unit` (tokens.css). Sparks and sheets
 *             are multiples of this one duration; `prefers-reduced-motion`
 *             still forces `--t-1`/`--t-2` to 1ms.
 *
 * DELIBERATELY ABSENT (honesty over completeness. reported, not faked):
 *   reduced motion. the cockpit honors the OS `prefers-reduced-motion`
 *     media query (tokens.css + Bead/Sweep check it directly); a cockpit-side
 *     OVERRIDE does not exist in the token system, so no row pretends to be
 *     one. sound. no sound machinery exists anywhere in the cockpit yet
 *     (§11.7's one opt-in event lands with its host surface); a switch wired
 *     to nothing would be a fake control.
 *
 * These rows do NOT write through the settings block: they are per-device,
 * per-person state (localStorage via the one persistence owner), and their
 * served-language descriptions say exactly that. Out-of-contract values are
 * refused with a plain sentence, mirroring the server's behavior for served
 * settings.
 *
 * Restored at module load (the settings/lens module graph loads with the
 * shell's outlets, before the reveal) so the first painted frame wears the
 * kept density/theme.
 *
 * ONE DECLARATION TABLE. Index rows, write/restore/cross-tab, and live
 * read-back all project from LOCAL_DECL. A new preference is one entry —
 * never a second table, never a new `if (id === …)`, never a named atom
 * subscription at a consumer. Consumers void `$cockpitLocalEpoch`.
 */

import { atom } from "nanostores";

import { persistGet, persistSet } from "../../state/persistence.ts";
import { onForeignWrite } from "../../state/cross-tab.ts";
import { ClientError } from "../../data/errors.ts";
import { configureClientDebug } from "../../client-debug.ts";
import type { ExposureModuleEntry } from "../../../shared/ui-schema.ts";
import { settingOptions, type SettingRow } from "./settings-data.ts";

const DENSITY_KEY = "cockpitDensity";
const THEME_KEY = "cockpitTheme";
const DEBUG_KEY = "cockpitDebug";
const EDITOR_SPLIT_KEY = "cockpitEditorSplit";
const SPACING_KEY = "cockpitSpacing";
const MOTION_KEY = "cockpitMotion";

export const DENSITY_ID = "cockpit.density";
export const THEME_ID = "cockpit.theme";
export const DEBUG_ID = "cockpit.debug";
export const EDITOR_SPLIT_ID = "cockpit.editorSplit";
export const SPACING_ID = "cockpit.spacing";
export const MOTION_ID = "cockpit.motion";

/**
 * THE TWO SPLITTER PREFERENCES. how tall the open desk stands, and how much
 * of the editor room the folder tree takes.
 *
 * Their defaults are the CSS tokens' own numbers. the desk token's 280 px
 * and the tree clamp's 24% preferred term. named here because a media
 * query cannot read JS and this module cannot read a stylesheet at load —
 * the same twin pairing shell/config.ts documents for the breakpoints, and
 * a guard holds the two sides equal so they cannot drift.
 *
 * AT THE DEFAULT, NOTHING IS WRITTEN TO THE PAGE: the token keeps its own
 * (possibly responsive) rule, so an untouched cockpit is byte-identical to
 * one from before these preferences existed. Only a CHOSEN value overrides
 * the token, and returning to the default removes the override entirely.
 */
export const EDITOR_SPLIT_DEFAULT = 24;
export const EDITOR_SPLIT_MIN = 12;
export const EDITOR_SPLIT_MAX = 60;
/** Twin of tokens.css `--sp-unit`. The click floor does not follow this. */
export const SPACING_DEFAULT = 4;
export const SPACING_MIN = 2;
export const SPACING_MAX = 8;
/** Twin of tokens.css `--t-unit`. Reduced-motion still wins on --t-1/--t-2. */
export const MOTION_DEFAULT = 30;
export const MOTION_MIN = 15;
export const MOTION_MAX = 90;

/** The module namespace these rows belong to (their ids' own prefix). */
export const LOCAL_MODULE_ID = "cockpit";

/**
 * The CATEGORY these rows live under. declared here, beside the rows, for
 * exactly the reason the served modules declare theirs beside their
 * registrations (`shared/exposure/module.ts`).
 *
 * The settings index does not know these two rows are special. It asks for
 * declarations and groups by them; this is this file's declaration, in the
 * same wire shape the server sends. Add a third device preference and it
 * lands in this category with no edit to the room. the same property the
 * served side has, kept on the side of the wire that has no server.
 */
export const LOCAL_MODULES: readonly ExposureModuleEntry[] = Object.freeze([
  Object.freeze({
    id: LOCAL_MODULE_ID,
    title: "How the cockpit looks to you",
    purpose:
      "How this screen is drawn for you and no one else. kept in this browser, never sent, and never part of what the install serves to anybody using it.",
  }),
]);

const DENSITY_VALUES = ["scan", "work", "deep"] as const;
const THEME_VALUES = ["carbon", "logbook"] as const;
const DEBUG_VALUES = ["off", "on"] as const;

/** Current local values. Named atoms stay for Desk / editor splitters
 * that preview a number without going through the write door. */
export const cockpitDensity = atom<string>("work");
export const cockpitTheme = atom<string>("carbon");
export const cockpitDebug = atom<string>("off");
export const cockpitEditorSplit = atom<number>(EDITOR_SPLIT_DEFAULT);
export const cockpitSpacing = atom<number>(SPACING_DEFAULT);
export const cockpitMotion = atom<number>(MOTION_DEFAULT);

/**
 * THE LIVE-READ EPOCH. Every accepted write, restore, and foreign adoption
 * bumps this. The index and the sheet void `$cockpitLocalEpoch` once —
 * they do not name a preference atom, so a new declaration cannot silently
 * paint stale. Preview drags (applyDeskHeight) do not bump: they are not
 * a preference write.
 */
export const cockpitLocalEpoch = atom(0);
function bumpLocal(): void {
  cockpitLocalEpoch.set(cockpitLocalEpoch.get() + 1);
}

function applyDensity(value: string): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.density = value;
}

function applyTheme(value: string): void {
  if (typeof document === "undefined") return;
  if (value === "logbook") document.documentElement.setAttribute("data-cockpit-theme", "light");
  else document.documentElement.removeAttribute("data-cockpit-theme");
}

/** Density and theme apply through a :root attribute; debug applies through
 * the one client emit owner. same shape, different target. Off is the
 * zero-overhead state (`clientWarn`/`clientLog` return at their first guard). */
function applyDebug(value: string): void {
  configureClientDebug({ enabled: value === "on" });
}

/**
 * The splitter pair applies through a :root INLINE override of the CSS
 * token. the same element the density/theme attributes land on, so every
 * consuming rule restyles in place. At the DEFAULT the override is removed
 * rather than restated: the token's own rule (which for the editor tree is
 * responsive) stays the one owner of the untouched state.
 */
export function applyEditorSplit(value: number): void {
  applyTokenOverride("--editor-tree-w", "%", value, EDITOR_SPLIT_DEFAULT);
}

/** THE TOKEN OVERRIDE DOOR. one :root setProperty. At the default the
 * override is removed so the stylesheet stays the owner of the untouched
 * state. Preview drags (Desk.svelte) call this without persisting. */
function applyTokenOverride(
  cssVar: `--${string}`,
  unit: string,
  value: number,
  defaultValue: number,
): void {
  if (typeof document === "undefined") return;
  if (value === defaultValue) document.documentElement.style.removeProperty(cssVar);
  else document.documentElement.style.setProperty(cssVar, `${value}${unit}`);
}

type EnumDecl = Readonly<{
  kind: "enum";
  id: string;
  storageKey: string;
  label: string;
  description: string;
  values: readonly string[];
  defaultValue: string;
  atom: { get: () => string; set: (v: string) => void };
  apply: (v: string) => void;
}>;

type NumberDecl = Readonly<{
  kind: "number";
  id: string;
  storageKey: string;
  label: string;
  description: string;
  defaultValue: number;
  min: number;
  max: number;
  unit: string;
  atom: { get: () => number; set: (v: number) => void };
  cssVar: `--${string}`;
  cssUnit: string;
}>;

type LocalDecl = EnumDecl | NumberDecl;

/**
 * THE ONE TABLE. Index shape, write path, restore, and cross-tab adoption
 * all project from this. A new local preference is one entry here. never
 * a second array, never a new `if (id === …)` in the door. Guard: LOCAL_ROWS
 * is mapped from this; setLocalPref's source does not name an id.
 */
const LOCAL_DECL: readonly LocalDecl[] = Object.freeze([
  {
    kind: "enum",
    id: DENSITY_ID,
    storageKey: DENSITY_KEY,
    label: "Density",
    description:
      "How tightly every cockpit surface packs its rows. scan fits more on screen, deep gives each row more air. Kept on this device, applies only to you, immediately.",
    values: DENSITY_VALUES,
    defaultValue: "work",
    atom: cockpitDensity,
    apply: applyDensity,
  },
  {
    kind: "enum",
    id: THEME_ID,
    storageKey: THEME_KEY,
    label: "Theme",
    description:
      "Carbon (dark instrument glass) or logbook (light paper) across the whole cockpit. Kept on this device, applies only to you, immediately.",
    values: THEME_VALUES,
    defaultValue: "carbon",
    atom: cockpitTheme,
    apply: applyTheme,
  },
  {
    kind: "enum",
    id: DEBUG_ID,
    storageKey: DEBUG_KEY,
    label: "Debug logging",
    description:
      "Whether this browser's console shows the cockpit's diagnostic messages. off keeps the console silent and costs nothing. Kept on this device, applies only to you, immediately.",
    values: DEBUG_VALUES,
    defaultValue: "off",
    atom: cockpitDebug,
    apply: applyDebug,
  },
  {
    kind: "number",
    id: EDITOR_SPLIT_ID,
    storageKey: EDITOR_SPLIT_KEY,
    label: "Editor tree share",
    description:
      "How much of the editor room the folder tree takes. the hairline between the tree and the file drags too, and double-clicking it returns to the built-in share. Kept on this device, applies only to you, immediately.",
    defaultValue: EDITOR_SPLIT_DEFAULT,
    min: EDITOR_SPLIT_MIN,
    max: EDITOR_SPLIT_MAX,
    unit: "%",
    atom: cockpitEditorSplit,
    cssVar: "--editor-tree-w",
    cssUnit: "%",
  },
  {
    kind: "number",
    id: SPACING_ID,
    storageKey: SPACING_KEY,
    label: "Spacing step",
    description:
      "The one length every padding, gutter and scale multiple is built from. Changing it resizes the whole cockpit at once. The minimum click target does not follow it: that is a safety rule, not a scale. Kept on this device, applies only to you, immediately.",
    defaultValue: SPACING_DEFAULT,
    min: SPACING_MIN,
    max: SPACING_MAX,
    unit: "px",
    atom: cockpitSpacing,
    cssVar: "--sp-unit",
    cssUnit: "px",
  },
  {
    kind: "number",
    id: MOTION_ID,
    storageKey: MOTION_KEY,
    label: "Motion step",
    description:
      "The one duration every spark and sheet is a multiple of. Changing it speeds or slows every named motion at once. The operating system still collapses motion when you ask it to. Kept on this device, applies only to you, immediately.",
    defaultValue: MOTION_DEFAULT,
    min: MOTION_MIN,
    max: MOTION_MAX,
    unit: "ms",
    atom: cockpitMotion,
    cssVar: "--t-unit",
    cssUnit: "ms",
  },
]);

function rowFromDecl(decl: LocalDecl): SettingRow {
  if (decl.kind === "enum") {
    return {
      id: decl.id,
      kind: "local",
      module: LOCAL_MODULE_ID,
      label: decl.label,
      description: decl.description,
      type: "enum",
      defaultValue: decl.defaultValue,
      options: settingOptions(decl.values),
    };
  }
  return {
    id: decl.id,
    kind: "local",
    module: LOCAL_MODULE_ID,
    label: decl.label,
    description: decl.description,
    type: "number",
    defaultValue: decl.defaultValue,
    min: decl.min,
    max: decl.max,
    unit: decl.unit,
  };
}

/** The local rows, in index shape. Projected from LOCAL_DECL. never a
 * second handwritten table of the same ids. */
export const LOCAL_ROWS: readonly SettingRow[] = LOCAL_DECL.map(rowFromDecl);

/** Test seam: the declaration table's ids, so a row without a wire reds. */
export function localWireIds(): readonly string[] {
  return LOCAL_DECL.map((d) => d.id);
}

function declFor(id: string): LocalDecl | undefined {
  return LOCAL_DECL.find((d) => d.id === id);
}

/** Read a local preference's current value. Null for an unknown id. */
export function localValue(id: string): string | number | null {
  return declFor(id)?.atom.get() ?? null;
}

/**
 * A number row's value judged against ITS OWN declared bounds. never
 * clamped (the splitter clamps while dragging; a WRITE outside the contract
 * is a refusal, same as an unknown enum member). The verdict carries its
 * reason so every door can speak it or decline on it without a catch.
 */
function judgedNumber(
  row: SettingRow,
  value: string,
): Readonly<{ ok: true; num: number }> | Readonly<{ ok: false; why: string }> {
  const num = Number(value);
  if (!Number.isInteger(num)) {
    return { ok: false, why: `"${value}" is not a whole number. refused unchanged` };
  }
  if ((row.min !== undefined && num < row.min) || (row.max !== undefined && num > row.max)) {
    return {
      ok: false,
      why: `${num} is outside this preference's range (${row.min ?? "…"} to ${row.max ?? "…"}${row.unit !== undefined ? ` ${row.unit}` : ""}). refused unchanged`,
    };
  }
  return { ok: true, num };
}

/** The throwing door. the local WRITE path refuses in plain words. */
function parsedNumber(row: SettingRow, value: string): number {
  const judged = judgedNumber(row, value);
  if (!judged.ok) throw new ClientError("invalid_value", judged.why);
  return judged.num;
}

/**
 * Set a local preference. the ONE local write path. Out-of-contract values
 * are refused with a plain sentence (mirroring the server's 400 for served
 * settings), never clamped or silently dropped.
 *
 * DELIBERATELY DIRECT. not routed through `broker.action`, and deliberately
 * NOT carrying `assertLiveForWrite` (§6.2 write-door audit).
 *
 * The read-only rule bounds what can be changed about the RECORDED WORLD:
 * `broker.action` refuses while a head is planted because an act fired from a
 * view of 10:14:21 would land on the live server and be recorded at a moment
 * the screen is not showing. These rows are neither. They are device
 * state written to this browser's own storage, never sent, never recorded,
 * never read back with an `asOf`. there is nothing about them that a planted
 * head could make dishonest, and there is no block action to route them
 * through because nothing travels.
 *
 * The SHEET nonetheless disables the local rows during a past view
 * (SettingSheet.svelte), which is stricter than this door: the surface can
 * only ever be more conservative than the door, never less, so the control
 * never claims a refusal this function would contradict.
 */
export function setLocalPref(id: string, value: string): void {
  const row = LOCAL_ROWS.find((r) => r.id === id);
  const decl = declFor(id);
  if (row === undefined || decl === undefined) {
    throw new ClientError("unknown_setting", `no cockpit preference named "${id}" exists`);
  }
  if (decl.kind === "number") {
    const num = parsedNumber(row, value);
    decl.atom.set(num);
    applyTokenOverride(decl.cssVar, decl.cssUnit, num, decl.defaultValue);
    persistSet(decl.storageKey, String(num));
    bumpLocal();
    return;
  }
  if (!(row.options ?? []).some((o) => o.value === value)) {
    throw new ClientError(
      "invalid_value",
      `"${value}" is not one of this preference's choices ` +
        `(${(row.options ?? []).map((o) => o.words).join(" · ")}). refused unchanged`,
    );
  }
  decl.atom.set(value);
  decl.apply(value);
  persistSet(decl.storageKey, value);
  bumpLocal();
}

/** Restore + apply the kept preferences. Runs at module load; exported so
 * tests can re-run it against a fresh DOM. */
export function applyStoredCockpitPrefs(): void {
  for (const decl of LOCAL_DECL) {
    if (decl.kind === "enum") {
      const raw = persistGet(decl.storageKey);
      const value = raw !== null && decl.values.includes(raw) ? raw : decl.defaultValue;
      decl.atom.set(value);
      decl.apply(value);
      continue;
    }
    const num = storedNumber(decl.storageKey, decl.id) ?? decl.defaultValue;
    decl.atom.set(num);
    applyTokenOverride(decl.cssVar, decl.cssUnit, num, decl.defaultValue);
  }
  bumpLocal();
}

/** A stored number that the row's own setter would accept, or null. */
function storedNumber(key: string, id: string): number | null {
  const raw = persistGet(key);
  if (raw === null) return null;
  const row = LOCAL_ROWS.find((r) => r.id === id);
  if (row === undefined) return null;
  const judged = judgedNumber(row, raw);
  return judged.ok ? judged.num : null;
}

applyStoredCockpitPrefs();

// ── Cross-tab ─────────────────────────────────────────────────────────────
//
// Both rows describe THE OPERATOR. how this person wants to look at the
// cockpit. so they are the same answer in every tab and every workspace by
// definition. Density in particular was the loudest silent divergence
// available: one tab on `scan` and one on `deep` are two different row
// heights for the same instrument, with nothing on either screen admitting
// the other exists.
//
// ADOPTION IS A PATCH, NOT A REBUILD. Both apply through a single attribute
// on `:root` (`data-density`, `data-cockpit-theme`), which is exactly how the
// local set path applies them. Every consuming rule is a token lookup, so the
// browser restyles in place: no component is torn down, no subtree is keyed
// off either value, and nothing re-runs a layout pass beyond the restyle the
// user's own click would have caused.
//
// A value outside the contract is REFUSED, same as a local set: another tab
// running older code, or a hand-edited storage entry, cannot push this tab
// into a state its own setter would reject.
for (const decl of LOCAL_DECL) {
  onForeignWrite(decl.storageKey, (raw) => {
    if (raw === null) return;
    if (decl.kind === "enum") {
      if (!decl.values.includes(raw)) return;
      decl.atom.set(raw);
      decl.apply(raw);
      bumpLocal();
      return;
    }
    const row = LOCAL_ROWS.find((r) => r.id === decl.id);
    if (row === undefined) return;
    const judged = judgedNumber(row, raw);
    if (!judged.ok) return;
    decl.atom.set(judged.num);
    applyTokenOverride(decl.cssVar, decl.cssUnit, judged.num, decl.defaultValue);
    bumpLocal();
  });
}
