/**
 * Dev orchestrator — starts the API server and Vite dev server together,
 * tracks their PIDs, and guarantees clean shutdown via process groups.
 *
 * PID files live in .dev/ (gitignored). The companion dev-stop.ts reads
 * these files to kill exactly these process groups — no pattern matching.
 *
 * Each child is spawned detached (own process group). Killing the negative
 * PID kills the entire group including child workers (Vite/esbuild).
 *
 * Shutdown: SIGTERM each group, wait up to the shutdown grace, SIGKILL any
 * survivor (`dev-processes.ts` `stopDevGroup`, the one terminate loop of the
 * process-facts owner), remove PID files, exit. Use Ctrl-C (SIGINT) or
 * 'npm run dev:stop'. PID files hold a process identity (pid + start time).
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createConnection } from "node:net";
import { ownedChild, ownedSelf, type OwnedProcess } from "../engine/src/process/process-facts.ts";
import { DEV_PID_DIRECTORY, devPidfilePath, removeDevPidfile, stopDevGroup, writeDevPidfile } from "./dev-processes.ts";

// Align with the server config owner (server/config.ts reads HARNESS_WEB_PORT,
// default 5174) so the port-busy precheck targets the port the API server will
// actually bind to. Previously this read the undocumented HARNESS_API_PORT,
// which drifted from the server when an operator set HARNESS_WEB_PORT.
const API_PORT = Number(process.env.HARNESS_WEB_PORT ?? 5174);
const WEB_PORT = 5173; // vite.config.ts strictPort: true

type Managed = { name: string; proc: ChildProcess; pidFile: string; owned: OwnedProcess | undefined };

mkdirSync(DEV_PID_DIRECTORY, { recursive: true });
writeDevPidfile(devPidfilePath("parent"), ownedSelf());

const managed: Managed[] = [];
let shuttingDown = false;
let exitCode = 0;

function start(name: string, pidFile: string, cmd: string, args: string[]): void {
  // detached: true gives the child its own process group (pid === pgid)
  const proc = spawn(cmd, args, {
    stdio: ["ignore", "inherit", "inherit"],
    env: process.env,
    detached: true,
  });
  // Owned ONCE, at spawn (KILL-OWNED-ONLY): the stop signals exactly this
  // process's group, never whatever holds the pid by then.
  const entry: Managed = { name, proc, pidFile, owned: proc.pid === undefined ? undefined : ownedChild(proc) };
  managed.push(entry);

  if (entry.owned !== undefined) writeDevPidfile(pidFile, entry.owned);

  proc.on("exit", (code, signal) => {
    console.log("[" + name + "] exited (code=" + code + ", signal=" + signal + ")");
    removeDevPidfile(pidFile);
    if (!shuttingDown) shutdown(code ?? 1);
  });

  proc.on("error", (err) => {
    console.error("[" + name + "] spawn error: " + err.message);
    removeDevPidfile(pidFile);
    shutdown(1);
  });
}

async function killGraceful(entry: Managed): Promise<void> {
  if (entry.owned === undefined) return;
  const ending = await stopDevGroup(entry.owned);
  if (ending === "killed") console.warn("[" + entry.name + "] SIGTERM timeout — SIGKILL sent");
  if (ending === "unconfirmed") console.warn("[" + entry.name + "] group " + entry.proc.pid + " could not be confirmed stopped");
  removeDevPidfile(entry.pidFile);
}

async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  exitCode = code;
  console.log("\n[dev:all] shutting down...");

  var entries = managed.slice().reverse();
  for (var i = 0; i < entries.length; i++) {
    await killGraceful(entries[i]!);
  }

  removeDevPidfile(devPidfilePath("parent"));
  process.exit(exitCode);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

/**
 * Pre-check: refuse to start if the API or web port is already in use. A
 * busy port would make a child fail to bind and crash mid-shutdown (a
 * confusing exit), so we surface a clear, actionable message BEFORE
 * spawning anything. Uses a TCP connect probe (node:net — no deps, ). A refused connection means the port is free; an accepted
 * connection means something is already listening.
 */
function checkPortFree(port: number, label: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const sock = createConnection({ host: "127.0.0.1", port }, () => {
      sock.end();
      resolve(false); // someone answered → port busy
    });
    sock.on("error", () => resolve(true)); // refused → free
    sock.setTimeout(400, () => { sock.destroy(); resolve(true); });
  });
}

async function precheckPorts(): Promise<void> {
  const apiFree = await checkPortFree(API_PORT, "api");
  const webFree = await checkPortFree(WEB_PORT, "web");
  if (apiFree && webFree) return;
  console.error("[dev:all] a required port is already in use:");
  if (!apiFree) console.error("  - API port " + API_PORT + " is busy.");
  if (!webFree) console.error("  - web port " + WEB_PORT + " is busy.");
  console.error("[dev:all] stop the running server first:  npm run dev:stop");
  console.error("[dev:all] (or free the port manually), then retry.");
  process.exit(1);
}

// Start API first (Vite proxy targets it), then Vite.
await precheckPorts();
start("api", devPidfilePath("api"), "node", ["--experimental-strip-types", "server/index.ts"]);
start("web", devPidfilePath("web"), "npx", ["vite"]);

console.log("[dev:all] starting api + web servers...");
console.log("[dev:all] pid files in " + DEV_PID_DIRECTORY + "/ (use 'npm run dev:stop' to stop)");
