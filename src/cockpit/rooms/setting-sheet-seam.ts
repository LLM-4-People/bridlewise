/**
 * INSTRUMENTS — the setting-sheet SEAM (DESIGN-COCKPIT-V2 §8.2 adjust,
 * §9.1). The sheet COMPONENT belongs to the settings surface — this room
 * never builds one (coordination by not building). The same
 * file-convention discovery the shell uses for outlets (shell/outlets.ts)
 * finds it here, so the `adjust` verb is honestly disabled with its reason
 * (§1.2 — a verb that cannot act does not pretend to) whenever the sibling
 * has not landed, and a deleted sheet degrades the verb instead of
 * breaking this room's build.
 *
 * PAYLOAD — the settings sibling's own published open contract
 * (`settings/SettingSheet.svelte` header): `{ settingId: <served
 * customization id> }`, opened through the shell SCOPE titled "adjust".
 * Nothing else: the sheet resolves every word, bound and current value
 * from the served schema itself. The instruments side supplies the
 * customization id its MECHANICAL resolution produced (the setting whose
 * `customizationId` IS the signal's id — the registry's own exact link).
 */

type ComponentModule = Readonly<{ default: unknown }>;
type Loader = () => Promise<ComponentModule>;

/** The SCOPE title the sibling's contract names. */
export const SHEET_SCOPE_TITLE = "adjust";

const sheetGlob = import.meta.glob("../settings/SettingSheet.svelte") as Record<string, Loader>;

/** Whether the settings sibling's sheet exists in the tree at all (sync —
 * drives enabled vs disabled-with-reason). */
export function settingSheetExists(): boolean {
  return Object.keys(sheetGlob).length > 0;
}

/** The plain words on the disabled verb while the sheet has not landed. */
export const SHEET_ABSENT_REASON =
  "setting sheet not built yet — the settings surface owns it";

/** Load the sheet component (null while it has not landed). */
export async function loadSettingSheet(): Promise<unknown | null> {
  const keys = Object.keys(sheetGlob);
  if (keys.length === 0) return null;
  const mod = await sheetGlob[keys[0]!]!();
  return mod.default;
}
