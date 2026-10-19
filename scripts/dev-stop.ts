/**
 * Dev stopper — reads the PID files `dev-all.ts` wrote in .dev/ and stops
 * those process groups. Deterministic: no pattern matching, no pkill, no
 * orphans. Each file holds a process identity (pid + start time), so a pid
 * recycled by an unrelated process is never signalled; a file that holds no
 * identity (unreadable, or a bare pid from an older run) names nothing and is
 * removed. The whole group is stopped (negative PID) so child workers die
 * too: SIGTERM, the shutdown grace, SIGKILL (`dev-processes.ts`
 * `stopDevGroup`, the one terminate loop of the process-facts owner). With no
 * pid file nothing is stopped (KILL-OWNED-ONLY: only a process this
 * lifecycle recorded spawning is ours to stop); whatever listens on the dev
 * ports is NAMED (`portListeners`, the process-facts listener answer), for
 * the run that started it to stop.
 */

import { join } from "node:path";
import { DEV_REPOSITORY_ROOT, devPidfilePath, portListeners, readDevPidfile, recordedDevServers, removeDevPidfile, stopDevGroup, stopDevOrchestrator, workingDirectoryLine } from "./dev-processes.ts";

// Mirror server/config.ts's DEFAULT_PORT (5174, overridable via HARNESS_WEB_PORT)
// so the port-fallback stop targets the port the server actually binds to (not a
// hardcoded 5174 that drifts when an operator sets a custom port). The web port
// (5173) is Vite's strictPort and is NOT a HARNESS_* config var.
const WEB_PORT = 5173;
const API_PORT = Number(process.env.HARNESS_WEB_PORT ?? 5174);

const ENDINGS = {
  gone: "already stopped",
  terminated: "terminated gracefully",
  killed: "SIGTERM timeout — killed",
  unconfirmed: "could not be confirmed stopped",
} as const;

async function stopNamed(name: string): Promise<void> {
  const path = join(DEV_REPOSITORY_ROOT, devPidfilePath(name));
  const owned = readDevPidfile(path);
  if (owned === undefined) {
    console.log("[" + name + "] no process identity recorded — nothing to stop");
  } else {
    console.log("[" + name + "] group " + owned.pid + " " + ENDINGS[await stopDevGroup(owned)]);
  }
  removeDevPidfile(path);
}

async function main(): Promise<void> {
  const recorded = recordedDevServers().length > 0;
  // Stop the orchestrator FIRST so it does not race our shutdown (it would
  // see its children exit and start its own); its SIGTERM handler stops each
  // child group and removes their pid files. What is left is stopped below.
  const orchestrator = await stopDevOrchestrator();
  if (orchestrator !== "none") console.log("[parent] orchestrator " + ENDINGS[orchestrator]);
  if (!recorded) {
    console.log("[dev:stop] no child PID files — nothing this lifecycle started is running");
    for (const { pid, port } of portListeners([WEB_PORT, API_PORT])) console.log("[port " + port + "] pid " + pid + " " + workingDirectoryLine(pid) + " — not started by this lifecycle, not stopped");
    console.log("[dev:stop] done");
    return;
  }
  for (const name of recordedDevServers()) await stopNamed(name);
  console.log("[dev:stop] done");
}

main();
