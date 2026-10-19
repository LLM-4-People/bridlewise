/**
 * Adjust-in-place openers (DESIGN-COCKPIT-V2 §9.1) — the open-contract
 * siblings consume. `,` on a focused fact / the `·adjust` verb calls one of
 * these; the sheet itself is the ONE primitive (SettingSheet.svelte, whose
 * header documents the SCOPE payload shape).
 *
 * The fact→setting mapping resolves MECHANICALLY from the registry linkage
 * (settings-data.settingIdsForSignal): an identical-id registration is the
 * exact link; a namespace match is the honest fallback; no link means the
 * caller hears the gap through the shell hint — a verb is never wired to an
 * invented setting.
 */

import type { ShellApi } from "../shell/contract.ts";
import { uiSchema } from "../../state/schema-store.ts";
import { servedRow, settingIdsForSignal } from "./settings-data.ts";
import { LOCAL_ROWS } from "./local-prefs.ts";
import { requestIndexQuery } from "./settings-feed.ts";
import SettingSheet from "./SettingSheet.svelte";

/** Open THE setting sheet for one setting id (served or cockpit-local). */
export function openSettingSheet(shell: ShellApi, settingId: string): void {
  const known =
    LOCAL_ROWS.some((r) => r.id === settingId) ||
    servedRow(uiSchema.get(), settingId) !== null;
  shell.openScope({
    title: known ? "adjust" : `adjust — “${settingId}” is not a served setting`,
    component: SettingSheet,
    props: { settingId },
  });
}

/**
 * Open the adjust surface for a SIGNAL (the fact under a pixel):
 *   exactly one linked setting  → its sheet;
 *   several (namespace matches) → the index, pre-searched to the namespace;
 *   none                        → the honest hint, nothing opens.
 */
export function openSettingForSignal(shell: ShellApi, signalId: string): void {
  const ids = settingIdsForSignal(uiSchema.get(), signalId);
  if (ids.length === 1) {
    openSettingSheet(shell, ids[0]!);
    return;
  }
  if (ids.length > 1) {
    requestIndexQuery(signalId.includes(".") ? signalId.slice(0, signalId.indexOf(".")) : signalId);
    shell.openRoom("settings");
    return;
  }
  shell.hint(`no served setting is linked to ${signalId} — nothing to adjust`);
}
