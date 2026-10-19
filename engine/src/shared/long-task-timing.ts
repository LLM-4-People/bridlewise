import { existsSync, statSync } from "node:fs";

import { bestEffort } from "./best-effort.ts";

/**
 * Shared long-task timing helpers (EXP481 DRY fix).
 *
 * `src/tools/concurrent/long-task-runner.ts` computes the heartbeat-age and
 * elapsed duration from the same state files (heartbeat file, pid file, task
 * dir). The duplicate anonymous `bestEffort` bodies were flagged by
 * `no-duplicate-function-bodies`. This module is the single canonical owner
 * of that computation; the call site imports it instead of duplicating the
 * arrow body.
 */

/**
 * @returns the heartbeat age in ms (now − heartbeat-file mtime), or `null`
 * when the heartbeat file does not exist. Best-effort: a stat
 * failure yields `null` (the task is treated as having no heartbeat).
 */
export function readLastHeartbeatMs(hbFile: string): number | null {
  if (!existsSync(hbFile)) return null;
  return bestEffort(() => Date.now() - statSync(hbFile).mtimeMs) ?? null;
}

/**
 * @returns the elapsed duration in ms (now − start-stamp). The start stamp is
 * the pid-file mtime when present, else the task-dir mtime.
 * Best-effort: a stat failure yields `0` (the task is treated as just
 * started).
 */
export function readElapsedMs(pidFile: string, taskDir: string): number {
  return bestEffort(() => {
    const startStamp = existsSync(pidFile) ? statSync(pidFile).mtimeMs : statSync(taskDir).mtimeMs;
    return Date.now() - startStamp;
  }) ?? 0;
}
