/**
 * THE BOOT REFUSAL FOR AN UNREADABLE SETTINGS STORE — one typed line, not a stack.
 *
 * Imported FIRST by `server/index.ts`, before any module that reads the
 * settings at load (the redaction owner does, the debug bootstrap does). An
 * ES module's imports evaluate in order, so this is the earliest point the
 * server can resolve the settings snapshot. At boot there is no last good
 * snapshot to keep serving, so an unreadable or refused store
 * (`config_unreadable`) is a refusal to start: the operator reads one line naming the code and the file,
 * and the process exits with the configuration-error status (`EX_CONFIG`,
 * 78). The refusal itself was already logged, once, by the owner (the
 * always-on console sink). CFG rebinds this preflight to the database store
 * (specs/cfg-final.md CFG-6); it does not add a second one. A temp root
 * inside the safety floor is refused the same way (`temporary_root_kept_out`).
 */
import { fileURLToPath } from "node:url";

import { refreshSettingsSnapshot, CONFIG_UNREADABLE_CODE } from "./harness-config.ts";
import { webConsoleError } from "../observability/debug-bridge.ts";

/** `EX_CONFIG` (sysexits.h): the configuration is wrong; restarting cannot help. */
const EXIT_CONFIGURATION_ERROR = 78;

const boot = refreshSettingsSnapshot();
if (boot.state === "unreadable" || boot.state === "refused") {
  webConsoleError(`[bridlewise web] refusing to start: ${CONFIG_UNREADABLE_CODE} — fix or restore ${boot.path}, then start again`);
  process.exit(EXIT_CONFIGURATION_ERROR);
}

// A TEMP ROOT INSIDE THE SAFETY FLOOR (TMPDIR-KEEPOUT-001): the server would
// refuse its own confined commands' temporary files there. Loaded only once
// the settings are known readable (its owners log through the debug system).
const { temporaryRootKeepOutRefusal } = await import("../../engine/src/filesystem/temporary-root.ts");
const keptOut = temporaryRootKeepOutRefusal(fileURLToPath(new URL("../../engine/", import.meta.url)));
if (keptOut !== undefined) {
  webConsoleError(`[bridlewise web] refusing to start: temporary_root_kept_out — ${keptOut}`);
  process.exit(EXIT_CONFIGURATION_ERROR);
}
