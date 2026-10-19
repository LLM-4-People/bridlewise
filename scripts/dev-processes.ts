/**
 * THE DEV SERVERS' PID FILES AND SHUTDOWN — shared by the orchestrator
 * (`dev-all.ts`, which writes them) and the stopper (`dev-stop.ts`, which
 * reads them), so the two can never disagree about where the files live,
 * what they hold or how a group is stopped.
 *
 * A pid file holds a PROCESS IDENTITY (pid + start time, the process-facts
 * owner's record), never a bare pid: a pid recycled by an unrelated process
 * after a crash must not be signalled. The census (`server/observability/
 * process-census.ts` `livePidfilePids`) reads the same records.
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isProcessIdentityLive,
  processesListeningOn,
  readSpawnRecord,
  terminate,
  workingDirectoryOf,
  writeSpawnRecord,
  type OwnedProcess,
  type PortListener,
  type TerminationEnding,
} from "../engine/src/process/process-facts.ts";

/** The lifecycle's own ignored state folder (`/.dev/` in `.gitignore`). */
export const DEV_PID_DIRECTORY = ".dev";

/** This repository's root (the dev servers' working directory), derived from this file's location. */
export const DEV_REPOSITORY_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** The orchestrator's pid file name. */
const ORCHESTRATOR = "parent";

/**
 * How long a stopped dev server group gets between SIGTERM and SIGKILL.
 * INTERIM static value (one home): the dev lifecycle has no config section
 * yet; its registered setting is owned by the CFG migration.
 */
export const DEV_SHUTDOWN_GRACE_MS = 3000;

/** The pid file of `name` (`parent`, `api`, `web`). */
export function devPidfilePath(name: string): string {
  return join(DEV_PID_DIRECTORY, `${name}.pid`);
}

/** Records the process this run spawned (`owned`) in `path`: the lifecycle's spawn record, the only proof a later stop has. */
export function writeDevPidfile(path: string, owned: OwnedProcess): void {
  writeSpawnRecord(path, owned);
}

/** The process a pid file records, or `undefined` (absent, unreadable, or not an identity record). */
export function readDevPidfile(path: string): OwnedProcess | undefined {
  return readSpawnRecord(path);
}

export function removeDevPidfile(path: string): void {
  rmSync(path, { force: true });
}

/**
 * Stops the process GROUP a dev server leads (spawned detached: pid = pgid),
 * the one this lifecycle recorded when it spawned it — through the one
 * terminator, which stops only what the run spawned (KILL-OWNED-ONLY) and
 * never a recycled pid's group.
 */
export async function stopDevGroup(owned: OwnedProcess): Promise<TerminationEnding> {
  return (await terminate({ group: owned }, { graceMs: DEV_SHUTDOWN_GRACE_MS })).ending;
}

/**
 * The names of the dev servers whose pid files `root` holds (`api`, `web`),
 * the orchestrator's excluded.
 */
export function recordedDevServers(root: string = DEV_REPOSITORY_ROOT): readonly string[] {
  const directory = join(root, DEV_PID_DIRECTORY);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((file) => file.endsWith(".pid")).map((file) => file.slice(0, -".pid".length)).filter((name) => name !== ORCHESTRATOR);
}

/** Where `pid` runs, for a line that names a process this lifecycle will not stop. */
export function workingDirectoryLine(pid: number): string {
  return `(working directory ${workingDirectoryOf(pid) ?? "unreadable"})`;
}

/** Whether `pid` is a process of THIS repository's tree (its working directory is `root`). */
export function runsInRepository(pid: number, root: string = DEV_REPOSITORY_ROOT): boolean {
  return workingDirectoryOf(pid) === root;
}

/**
 * Stops the dev ORCHESTRATOR (`dev-all.ts`) of `root` by its recorded
 * identity — never by a process-list pattern (which matched every checkout's
 * orchestrator on the machine). It is one process whose SIGTERM handler stops
 * each child group in turn (each up to two graces: SIGTERM, then SIGKILL and
 * its confirmation), so it gets that plus its own grace. A recorded
 * orchestrator that no longer runs, runs elsewhere, or whose pid was
 * recycled, is not signalled; its pid file, when there is one, is removed either way.
 */
export async function stopDevOrchestrator(root: string = DEV_REPOSITORY_ROOT): Promise<TerminationEnding | "none"> {
  const path = join(root, devPidfilePath(ORCHESTRATOR));
  const owned = readDevPidfile(path);
  const children = recordedDevServers(root).length;
  let ending: TerminationEnding | "none" = "none";
  if (owned !== undefined && isProcessIdentityLive(owned) && runsInRepository(owned.pid, root)) {
    ending = (await terminate(owned, { graceMs: DEV_SHUTDOWN_GRACE_MS * (2 * children + 1) })).ending;
  }
  if (existsSync(path)) removeDevPidfile(path);
  return ending;
}

/**
 * Whatever listens on `ports` (this process aside): said, never stopped
 * (KILL-OWNED-ONLY — a listener found on a port is not proven spawned by
 * this run; the run that started it stops it).
 */
export function portListeners(ports: readonly number[]): readonly PortListener[] {
  return processesListeningOn(ports).filter(({ pid }) => pid !== process.pid);
}
