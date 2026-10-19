#!/usr/bin/env node
/**
 * Server lifecycle script — the SINGLE reliable way to start/stop/restart
 * the dev server. Agents MUST use this (the "Server lifecycle" flow).
 *
 * Usage:
 *   node scripts/sd.mjs start — stop what this lifecycle started, refuse if another holds the ports, start fresh, wait for health
 *   node scripts/sd.mjs stop — stop what this lifecycle recorded starting (the orchestrator and its server groups), each confirmed gone
 *  node scripts/sd.mjs restart — stop + start
 *   node scripts/sd.mjs status — report PIDs + port status
 *
 * Why this exists: agents kept using `pkill`, `fuser -k`, `kill -9`, or
 * forgetting to kill the old server — causing the browser to hit STALE
 * code. This script stops what its own lifecycle STARTED — the processes its
 * spawn records (`.dev/*.pid`) name — through the process-facts owner's one
 * terminate loop (each confirmed gone), names whatever else holds the ports
 * (`processesListeningOn`: procfs sockets, not pattern matching) without
 * stopping it (KILL-OWNED-ONLY: only the run that started a process stops
 * it), and verifies health before reporting success.
 *
 * STALE-PROCESS RECONCILIATION (why ports + pidfiles were not enough): an
 * orphaned `server/index.ts` whose PPID is 1 survives every restart below
 * when it holds NO service port (a test child started with
 * HARNESS_WEB_PORT=0 binds an OS-assigned ephemeral loopback port, so the
 * `ss` kill on 5173/5174 never sees it) and no pidfile (`.dev/*.pid` hold
 * only the CURRENT tree's pids). Measured on this machine: such an orphan
 * lived ~2.5h through every `sd.mjs restart`. So `status`, `start`, and
 * `stop` additionally enumerate THIS REPO'S OWN server-tree processes
 * through /proc and reconcile them against the pidfiles and the service
 * ports (see the stale classifier below), and NAME them: no record says
 * this lifecycle started them, so it does not stop them.
 */
import { execSync, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEP_CACHE_DIR, staleDepCacheVerdict } from "./vite-dep-cache.ts";
import { pollServedModule } from "./served-module-probe.ts";
import {
  extractServedCss,
  findUnscopedSizingSelectors,
  unscopedCssVerdict,
} from "./svelte-css-scope-probe.ts";

// The API port mirrors server/config.ts's DEFAULT_PORT (5174, overridable via
// HARNESS_WEB_PORT). Read at launch time so a custom port is respected by the
// health check + the port scan (not a hardcoded duplicate that drifts from
// config.ts). The web port (5173) is Vite's strictPort and is NOT a HARNESS_*
// config var, so it stays literal here.
const API_PORT = Number(process.env.HARNESS_WEB_PORT ?? 5174);
const WEB_PORT = 5173;
const PORTS = [WEB_PORT, API_PORT];
const HEALTH_URL = `http://127.0.0.1:${API_PORT}/api/health`;
const HEALTH_TIMEOUT_MS = 30_000;

// The boot's tree: the working directory sd.mjs is invoked from — the tree
// the launched unit is told to serve (`--working-directory`) and the tree
// the post-launch serving verification must find on the service ports.
// Named once so the binding line, the launch, and the verification can
// never disagree about which tree this boot stands for.
const BOOT_CWD = process.cwd();

// Where this boot's child stderr goes. Under systemd-run the transient
// unit's stderr defaults to the journal — invisible to the operator — so
// the launch redirects it to this file instead, and the health-check
// failure prints its tail: a typed, quotable boot refusal (a startup
// pin's InputError) is a sentence the operator must see, not a mystery.
// Truncated before every launch, so the tail is always THIS boot's. Lives
// in .dev/ beside the pidfiles — the lifecycle's own ignored state dir.
const BOOT_STDERR_LOG = join(BOOT_CWD, DEV_PID_DIRECTORY, "boot.stderr.log");
// The tail bound: a refusal sentence plus its stack fits comfortably; a
// bounded tail is what points at the refusal, never the whole log.
const BOOT_STDERR_TAIL_LINES = 30;

// THE LAUNCH ENVIRONMENT COMES FROM THE CALLER'S ENVIRONMENT ONLY. A literal
// provider key and the dev admin password used to be built in as fallbacks
// (a credential in a tracked file, pushed to origin — rotate it); an unset
// variable is now simply unset, and the server says what it needs.
const ENV = serverLaunchEnvironment(process.env);

// ── Helpers ──

/** The pids listening on `port` (the process-facts owner's one answer; never an `ss` scrape). */
function pidsOnPort(port) {
  return [...new Set(processesListeningOn([port]).map((listener) => listener.pid))];
}

function allServerPids() {
  return [...new Set(processesListeningOn(PORTS).map((listener) => listener.pid))];
}

/**
 * Names every process on the service ports — NEVER stops one
 * (KILL-OWNED-ONLY, UR-18): a listener found on a global port was not proven
 * spawned by this lifecycle, and only the run that started a process stops
 * it. Each holder's tree is read and named, so an operator sees whose server
 * holds the ports. Answers how many hold them.
 */
function reportPortListeners() {
  const pids = allServerPids();
  for (const pid of pids) console.log(`[sd]   ${servingTreeLine(pid, readPidCwd(pid), BOOT_CWD)}`);
  return pids.length;
}

/**
 * Stops what THIS lifecycle started, by its spawn records: the orchestrator
 * first (its SIGTERM handler stops its children), then any child group a
 * record still names. Nothing found any other way is signalled.
 */
async function stopRecordedServers() {
  const orchestrator = await stopDevOrchestrator(REPO_ROOT);
  if (orchestrator !== "none") console.log(`[sd] Orchestrator: ${orchestrator}`);
  for (const name of recordedDevServers(REPO_ROOT)) {
    const path = join(REPO_ROOT, devPidfilePath(name));
    const owned = readDevPidfile(path);
    if (owned !== undefined) {
      const ending = await stopDevGroup(owned);
      console.log(`[sd] ${name}: group ${owned.pid} ${ending}`);
    }
    removeDevPidfile(path);
  }
}

// ── Stale-process reconciliation ────────────────────────────────────────────
//
// Ports + pidfiles were not enough (see the header): an orphan can hold NO
// service port (the OS-assigned ephemeral bind of a HARNESS_WEB_PORT=0 test
// child) and NO pidfile (`.dev/*.pid` name only the current tree). This
// section enumerates this repository's OWN server-tree processes through
// /proc and reconciles them against what the lifecycle actually owns.
//
// THE SAFETY GATE — READ THIS BEFORE TOUCHING THE CANDIDATE SET: this
// machine hosts OTHER node work (editors, language servers, other repos).
// A process is a candidate ONLY if its /proc/<pid>/cwd IS this repository,
// and the cwd check runs BEFORE the cmdline pattern check — a process whose
// cwd is anywhere else is never a candidate and never signalled, whatever
// its cmdline says. Killing by cmdline pattern without the cwd gate would
// be a footgun pointed at every other workspace on the box.
//
// The VERDICT logic — when a candidate is stale — is PURE and lives in
// scripts/sd-stale-classifier.ts. The /proc ENUMERATION + the argv pattern
// tables live in the census owner (server/observability/process-census.ts)
// — the SAME enumeration the anatomy view consumes (one census primitive,
// no copy); what stays here is the candidate filter (the cwd
// safety gate, re-applied on top of the census) and the report.
import { classifyStaleProcess, livePidfilePids, servingTreeLine, bootBindingLine, bootServingVerdict, bootStderrTailMessage, systemdRunLaunchCommand, serverLaunchEnvironment } from "./sd-stale-classifier.ts";
import { censusProcesses } from "../server/observability/process-census.ts";
import { parentOf, processesListeningOn, workingDirectoryOf } from "../engine/src/process/process-facts.ts";
import { DEV_PID_DIRECTORY, devPidfilePath, readDevPidfile, recordedDevServers, removeDevPidfile, stopDevGroup, stopDevOrchestrator } from "./dev-processes.ts";
import { bootstrapProcess, isEntryPoint } from "../engine/src/runtime/cli-debug.ts";


/**
 * Every process that is a stale-reconciliation CANDIDATE: a census process
 * whose cwd IS this repository AND whose classification came from a
 * SERVER-TREE pattern. THE SAFETY GATE runs here, on top of the census:
 * the census may LOOK at anything (it is read-only), but a process is a
 * report candidate ONLY after its cwd was re-checked to BE this repository —
 * processes outside this repo are never candidates, never signalled,
 * whatever their cmdline says. (Bystanders and operator tools the census
 * labels — vitest, tsserver, the trace CLI — fail this filter and are
 * never signalled.)
 */
export async function repoServerTreeProcesses(repoRoot) {
  const census = await censusProcesses(repoRoot, { cpuSampleMs: 0 });
  return census
    .filter((p) => p.cwd === repoRoot && p.classification.scope === "server-tree")
    .map((p) => ({
      pid: p.pid,
      argv: [...p.argv],
      ageSeconds:
        p.startedAtWallIso === null
          ? null
          : Math.max(0, Math.round((Date.now() - Date.parse(p.startedAtWallIso)) / 1000)),
    }))
    .sort((a, b) => a.pid - b.pid);
}

/** The stale subset of this repo's server-tree processes, right now. */
export async function staleServerProcesses(repoRoot) {
  const candidates = await repoServerTreeProcesses(repoRoot);
  if (candidates.length === 0) return [];
  const pidfilePids = livePidfilePids(join(repoRoot, DEV_PID_DIRECTORY));
  const portPids = allServerPids();
  return candidates
    .map((candidate) => ({
      ...candidate,
      verdict: classifyStaleProcess({ pid: candidate.pid, pidfilePids, portPids, ppidOf: parentOf }),
    }))
    .filter((candidate) => candidate.verdict.stale);
}

function formatAge(seconds) {
  if (seconds === null || seconds === undefined) return "unknown";
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

/**
 * One running server pid's working tree, read from /proc — the tree its
 * process actually serves. Derived, never scraped: one readlink, no ps, no
 * pattern that can match the wrong process. THE ONE READER for /proc/<pid>/cwd
 * in this script: the stale report and the status line's
 * serving verdict both come through here, so the two can never disagree
 * about which tree a pid belongs to. Null when the read fails (the pid died,
 * or it is not ours to inspect) — absence, never a guessed path.
 */
function readPidCwd(pid) {
  return workingDirectoryOf(pid) ?? null;
}

/**
 * Names the stale server-tree processes of this repo — never stops them
 * (KILL-OWNED-ONLY: a process found by a scan is not proven spawned by this
 * lifecycle). Answers how many there are.
 */
export async function reportStaleProcesses(repoRoot) {
  const stale = await staleServerProcesses(repoRoot);
  if (stale.length === 0) return 0;
  console.warn(`[sd] WARNING: ${stale.length} stale server-tree process(es) from this repo (not in pidfiles, not on service ports) — not stopped, no record says this lifecycle started them:`);
  for (const s of stale) {
    console.warn(`[sd]   pid ${s.pid} (age ${formatAge(s.ageSeconds)}) ${s.argv.join(" ")}`);
  }
  return stale.length;
}


/**
 * This boot's captured child stderr, or null when the log is unreadable
 * (the unit never started, or the redirect failed) — absence, never a
 * guess; the tail message says so by name.
 */
function readBootStderr() {
  try { return readFileSync(BOOT_STDERR_LOG, "utf8"); } catch { return null; }
}

function checkHealth() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const code = execSync(`curl -s -o /dev/null -w '%{http_code}' --max-time 2 ${HEALTH_URL} 2>/dev/null`, { encoding: "utf8" }).trim();
      if (code === "200") return true;
    } catch {}
    execSync("sleep 0.5");
  }
  return false;
}

/**
 * THE SERVED-SCOPE PROBE. Fetches one known component's served style module
 * from the LIVE dev server and refuses a boot that serves its sizing CSS
 * UNSCOPED. The component is the desk shell — its `.bar` was the rule the
 * stale hot-update served bare. A refusal EXITS NON-ZERO so a wedged dev
 * server cannot be reported "UP"; a probe that cannot reach the server or
 * read a payload logs NOT JUDGED and does not fail the boot (the health check
 * is the boot's gate; this probe only refuses a POSITIVE unscoped read).
 */
function probeServedCssScope() {
  const component = "src/cockpit/shell/Desk.svelte";
  // The probe fetches the STYLE module. vite-plugin-svelte serves the
  // component's scoped CSS from the component module's own compile metadata
  // (`meta.svelte.css`), populated when the COMPONENT is compiled. A style
  // request that arrives BEFORE the component's compile has populated that
  // metadata falls through to the raw file (the DESK-CSS-2 race). The warm +
  // settle-and-poll mechanics (component first — the browser's order — then
  // poll the artifact read through a window and refuse only a PERSISTENT bad
  // read) are owned by scripts/served-module-probe.ts; what stays here is the
  // CSS-specific half: the URLs and the unscoped-sizing judgment.
  const componentUrl = `http://127.0.0.1:${WEB_PORT}/${component}`;
  const styleUrl = `http://127.0.0.1:${WEB_PORT}/${component}?svelte&type=style&lang.css`;
  const get = (url) =>
    execSync(`curl -s --max-time 8 ${JSON.stringify(url)} 2>/dev/null`, { encoding: "utf8" });
  const judge = (body) => {
    const css = extractServedCss(body);
    if (css === null) throw new Error("no style payload yet"); // still settling — retry, never judged
    return unscopedCssVerdict(component, findUnscopedSizingSelectors(css));
  };
  const outcome = pollServedModule(() => { get(componentUrl); }, () => get(styleUrl), judge);
  if (outcome.kind === "settled-clean") {
    console.log("[sd] served-CSS scope probe: OK (component sizing CSS is scoped).");
    return;
  }
  if (outcome.kind === "not-judged") {
    // The window closed without one judgeable read — absence, not a pass and
    // not a refusal: the health check is the boot's gate; this probe only
    // refuses a POSITIVE unscoped read.
    console.log("[sd] served-CSS scope probe: NOT JUDGED (no style payload read within the settle window).");
    return;
  }
  console.error(`[sd] served-CSS scope probe REFUSED the boot (still unscoped after the settle window): ${outcome.judgment}`);
  process.exit(1);
}

// ── Commands ──

async function cmdStop() {
  console.log("[sd] Stopping dev server...");
  // What THIS lifecycle started, by its spawn records — never what merely
  // holds a port or matches a scan (KILL-OWNED-ONLY).
  await stopRecordedServers();
  const holders = reportPortListeners();
  await reportStaleProcesses(REPO_ROOT);
  console.log(holders === 0 ? "[sd] Server stopped." : `[sd] Server stopped; ${holders} process(es) this lifecycle did not start still hold the service ports (named above, not stopped).`);
}

async function cmdStart() {
  // THE BOOT BINDING — printed BEFORE anything is killed or launched: the
  // tree this boot will serve (the working directory the unit is told to
  // run in) and the config file that tree's server will load. The ports
  // are global and the launch serves the tree it is invoked from — an
  // operator who started from the wrong tree sees it HERE, in one glance,
  // before a single gate or mint runs against the wrong app.
  // The served tree's OWN answer (its server-config owner, which asks the
  // engine's one config-path owner) — never a third spelling of the layout.
  const { DEFAULT_HARNESS_CONFIG_PATH } = await import(pathToFileURL(join(BOOT_CWD, "server", "kernel", "config.ts")).href);
  const configPath = process.env.HARNESS_CONFIG_PATH ?? DEFAULT_HARNESS_CONFIG_PATH;
  console.log(`[sd] ${bootBindingLine(BOOT_CWD, configPath)}`);
  // What THIS lifecycle started before is stopped by its records; a port
  // still held after that is someone else's server, and the boot REFUSES
  // rather than take it down (KILL-OWNED-ONLY).
  await stopRecordedServers();
  if (allServerPids().length > 0) {
    console.error("[sd] The service ports are held by processes this lifecycle did not start:");
    reportPortListeners();
    console.error("[sd] Refused: stop them from the run (or terminal) that started them, then start again.");
    process.exit(1);
  }
  await reportStaleProcesses(REPO_ROOT);

  // Clear a STALE Vite dep-optimizer cache BEFORE boot. The optimizer reuses
  // node_modules/.vite keyed on its own inputs (config hash, lockfile), not on
  // the source the dev server serves — so an edit under server/ or engine/src/
  // leaves a cache that serves the old module graph (504 Outdated Optimize
  // Dep, "Cannot read properties of undefined (reading 'call')" on room
  // loads). The verdict owner is scripts/vite-dep-cache.ts; only a stale cache
  // is cleared — a fresh one is kept so the boot keeps the warm start.
  const staleCache = staleDepCacheVerdict(BOOT_CWD);
  if (staleCache !== null) {
    console.log(`[sd] ${staleCache}`);
    rmSync(join(BOOT_CWD, DEP_CACHE_DIR), { recursive: true, force: true });
    console.log(`[sd] Cleared ${DEP_CACHE_DIR}.`);
  }

  // This boot's stderr capture: truncate the log (the tail printed on a
  // health failure must be THIS boot's, never a previous boot's) and make
  // sure .dev exists BEFORE the unit starts — the service manager opens
  // the StandardError path at unit start, and a missing directory would
  // kill the boot with a failure that reads as anything but what it is.
  mkdirSync(join(BOOT_CWD, DEV_PID_DIRECTORY), { recursive: true });
  writeFileSync(BOOT_STDERR_LOG, "");

  console.log("[sd] Starting dev server...");
  const args = [
    "--user", "--same-dir", "--collect", "--no-block",
    `--working-directory=${BOOT_CWD}`,
    // NAMES ONLY: systemd-run takes each value from its own environment
    // (inherited from this process), so no value — a path, a password — is
    // ever on a command line another process can read in /proc.
    ...Object.keys(ENV).map((name) => `--setenv=${name}`),
    `--property=StandardError=append:${BOOT_STDERR_LOG}`,
    "node", "--experimental-strip-types", "scripts/dev-all.ts",
  ];
  try {
    // The command string is executed through /bin/sh (execSync's shell), so
    // every argument is shell-quoted by the pure owner before the join — a
    // space in the working directory, the stderr log, or a setenv value
    // would otherwise split into two systemd-run arguments (or worse, be
    // interpreted). The quoting is uniform over the whole array: an
    // argument added later is covered the day it lands.
    execSync(systemdRunLaunchCommand(args), { encoding: "utf8", stdio: "pipe" });
  } catch (err) {
    console.error("[sd] systemd-run failed; exit status:", typeof err.status === "number" ? err.status : "unavailable");
    // Fallback: direct spawn — the child's stderr goes to the SAME log via
    // the inherited descriptor, so the health-failure tail reads one file
    // whichever launch path ran.
    console.log("[sd] Falling back to direct spawn...");
    const errFd = openSync(BOOT_STDERR_LOG, "a");
    try {
      const child = spawn("node", ["--experimental-strip-types", "scripts/dev-all.ts"], {
        detached: true, stdio: ["ignore", "ignore", errFd], env: ENV,
      });
      child.unref();
    } finally {
      closeSync(errFd);
    }
  }

  console.log("[sd] Waiting for health check...");
  if (checkHealth()) {
    console.log("[sd] Server is UP (health 200).");
    // THE SERVING-TREE VERIFICATION. Health proves a server ANSWERS on the
    // ports; it does not prove WHICH tree's server answered. Each running
    // pid's actual tree is read from /proc (the one reader) and verified
    // against the boot's tree; a POSITIVE different-tree read REFUSES the
    // boot — the health check answered from a server this launch did not
    // start. An unreadable cwd is printed honestly and judged not a
    // refusal (absence, never a guess — health stays the liveness gate).
    const servingVerdicts = allServerPids().map((pid) => bootServingVerdict(pid, readPidCwd(pid), BOOT_CWD));
    for (const verdict of servingVerdicts) {
      console.log(`[sd]   ${verdict.line}`);
    }
    if (servingVerdicts.some((v) => v.refused)) {
      console.error("[sd] SERVING-TREE VERIFICATION REFUSED the boot: the health check answered from a server serving a different tree than the one sd.mjs was invoked from. Stop it, then start again from the tree you are working in.");
      process.exit(1);
    }
    // THE SERVED-SCOPE PROBE. The health check proves the server answers; it
    // does NOT prove the CSS it serves is scoped. A stale vite-plugin-svelte
    // hot-update serves a component's rule UNSCOPED, and a bare sizing rule
    // leaks onto every same-named class in the app (the desk-composer crush).
    // The classifier owner is scripts/svelte-css-scope-probe.ts; this fetch
    // judges the LIVE served module, the only surface the defect lives on.
    // A probe that cannot read a style payload reports NOT JUDGED, never a
    // guess — a healthy server without this probe still passed health.
    probeServedCssScope();
    await cmdStatus();
  } else {
    console.error("[sd] Server did NOT respond to health check within 30s.");
    console.error("[sd] Ports:", PORTS.map(p => `${p}: ${pidsOnPort(p).length} PIDs`).join(", "));
    // THE BOOT-REFUSAL STDERR TAIL: the child's stderr for THIS boot was
    // captured at launch; a typed, quotable boot refusal (a startup pin's
    // InputError) sits in it when the boot refused — the operator gets the
    // sentence, not a mystery.
    for (const line of bootStderrTailMessage(readBootStderr(), BOOT_STDERR_TAIL_LINES, BOOT_STDERR_LOG).split("\n")) {
      console.error(`[sd] ${line}`);
    }
    process.exit(1);
  }
}

async function cmdRestart() {
  await cmdStop();
  execSync("sleep 1");
  cmdStart();
}

async function cmdStatus() {
  const pids = allServerPids();
  if (pids.length === 0) {
    console.log(`[sd] Status: STOPPED (no processes on ports ${WEB_PORT}/${API_PORT})`);
  } else {
    console.log("[sd] Status: RUNNING");
    console.log("[sd] PIDs:", pids.join(", "));
    // THE WRONG-TREE HAZARD, MADE VISIBLE: the ports are global, so a server
    // started from the PRODUCT tree answers in this worktree's terminal
    // exactly like this worktree's own — and every fix then reads as
    // missing live (the measured incident cost a drive/fix round ~15
    // minutes of "the fix is not working" before /proc spelunking found the
    // wrong cwd). Each running server pid's ACTUAL tree, read from
    // /proc/<pid>/cwd, is printed beside the pid so the hazard is caught in
    // one glance instead of by forensics.
    for (const pid of pids) {
      console.log(`[sd]   ${servingTreeLine(pid, readPidCwd(pid), REPO_ROOT)}`);
    }
    try {
      const code = execSync(`curl -s -o /dev/null -w '%{http_code}' --max-time 2 ${HEALTH_URL} 2>/dev/null`, { encoding: "utf8" }).trim();
      console.log("[sd] Health:", code === "200" ? "OK (200)" : `FAIL (${code})`);
    } catch {
      console.log("[sd] Health: FAIL (connection refused)");
    }
  }
  for (const p of PORTS) {
    const portPids = pidsOnPort(p);
    console.log(`[sd] Port ${p}: ${portPids.length === 0 ? "free" : portPids.join(", ")}`);
  }
  // Stale reconciliation on status too: report (never kill) this repo's
  // server-tree processes the pidfiles + ports do not own, so an orphan is
  // VISIBLE the moment it exists instead of surviving invisibly.
  const stale = await staleServerProcesses(REPO_ROOT);
  if (stale.length === 0) {
    console.log("[sd] Stale server-tree processes: none");
  } else {
    console.warn(`[sd] WARNING: ${stale.length} stale server-tree process(es) from this repo (not in pidfiles, not on service ports):`);
    for (const s of stale) {
      console.warn(`[sd]   pid ${s.pid} (age ${formatAge(s.ageSeconds)}) ${s.argv.join(" ")}`);
    }
    console.warn("[sd] They were not started by this lifecycle's records, so it does not stop them: stop them from the run that started them.");
  }
}

// ── Main ──

// The repo root for reconciliation: derived from THIS FILE's location, not
// process.cwd(), so the /proc cwd gate is the tree's real root however the
// script was invoked. resolve() normalizes the URL-derived trailing slash —
// readlink("/proc/<pid>/cwd") never carries one, and the gate compares for
// EXACT equality.
const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

// Run the CLI only when executed as a script, never when imported (the
// owning test imports the pure classifier/spec exports above).
if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  const cmd = process.argv[2] || "status";
  switch (cmd) {
    case "start": await cmdStart(); break;
    case "stop": await cmdStop(); break;
    case "restart": await cmdRestart(); break;
    case "status": await cmdStatus(); break;
    default:
      console.error(`Unknown command: ${cmd}. Use: start | stop | restart | status`);
      process.exit(1);
  }
}
