/**
 * Shared exposure registrations — `settings` module.
 *
 * The settings STORE's own state, as signals (the names CFG keeps when the
 * store moves from the file to the database: specs/cfg-final.md §13): whether
 * it is absent (every setting at its documented default), readable, or
 * refused. While a store that was readable is refused (half-saved,
 * hand-edited into invalid JSON, unreadable), the host keeps serving the LAST
 * GOOD snapshot it resolved and refuses every settings save with
 * `config_unreadable`; these signals are how a surface learns that without
 * attempting a save.
 *
 * The live source is installed by the host that resolves the store (the web
 * server installs `getSettingsStoreState` from `server/kernel/harness-config.ts`
 * at boot). With no host source the state reads `unmeasured`: a process that
 * never read the store cannot say what it holds.
 */

import { registerExposureModule, registerSignal } from "../index.ts";
import type { SettingsStoreState } from "../../../kernel/config.ts";

let stateSource: (() => SettingsStoreState) | null = null;
let settingsRegistered = false;

/** Install the live reading of the settings store's state (the web server, at boot). */
export function installSettingsStoreStateSource(source: () => SettingsStoreState): void {
  stateSource = source;
}

export function registerSettingsExposure(): void {
  if (settingsRegistered) return;
  settingsRegistered = true;

  registerExposureModule({
    id: "settings",
    title: "The settings store itself",
    purpose:
      "Whether the settings store can be read right now: absent means every setting uses its default, unreadable means the last readable settings stay in force and no change can be saved until the store is fixed.",
  });

  registerSignal({
    id: "settings.storeState",
    module: "settings",
    name: "Settings Store State",
    description: "absent (no store: every setting at its default), ok, unreadable (the store cannot be read, or was removed after it was read: the last readable settings stay in force and every save is refused until it is fixed), refused (it reads, but a hand edit weakens a section every response depends on, such as privacy: the last readable settings stay in force), or unmeasured (this process never read it).",
    type: "state",
    value: () => stateSource?.().state ?? "unmeasured",
  });
  registerSignal({
    id: "settings.storeRefusal",
    module: "settings",
    name: "Why The Settings Store Is Refused",
    description: "The refusal's reason while the settings store is unreadable or refused (the decoder's or the refusing door's own code and message); empty otherwise.",
    type: "string",
    value: () => stateSource?.().reason ?? "",
  });
}

/** Reset the per-module registration flag (test-only). */
export function resetSettingsRegistration(): void {
  settingsRegistered = false;
}
