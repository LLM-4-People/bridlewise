/**
 * Stale-process classifier — the pure VERDICT half of the sd.mjs
 * server-lifecycle script.
 *
 * sd.mjs owns the server lifecycle, and its reconciliation needs two kinds
 * of logic: the /proc walk + kill pipeline (imperative, lives in sd.mjs
 * beside the kill discipline it shares) and the VERDICT logic — which argv
 * shapes belong to this repo's server tree, which candidate pid is stale,
 * which pidfile entries are live. The same file is also where the launch's
 * operator-visible verdicts live (the serving-tree line, the boot binding,
 * the post-launch serving verification, the boot-refusal stderr tail) —
 * pure over their inputs, driven by the owning suite without /proc.
 *
 * THE SPLIT: the live /proc enumeration, the argv pattern tables and
 * the pidfile read moved to the census owner
 * (`server/observability/process-census.ts`) so the anatomy view consumes
 * the SAME logic instead of a copy — sd.mjs, `scripts/trace.ts anatomy` and
 * the `observability.anatomy` block read all import it from there. This
 * module keeps the PURE
 * verdict (`classifyStaleProcess`) and RE-EXPORTS the moved pieces so its
 * existing importers (sd.mjs, the owning test) keep resolving to the one
 * owner. The defect history this section guarded is unchanged:
 *
 * The defect this section exists for is measured, not theorized: an
 * orphaned `server/index.ts` (PPID 1, ~2.5h) survived every
 * `sd.mjs restart` because it held an OS-assigned ephemeral loopback port
 * (bound via a zero web-port override — no source names the port, so the
 * `ss`-based kill on 5173/5174 never saw it) and no pidfile (`.dev/*.pid`
 * list only the current tree). Ports and pidfiles answer "what does the
 * current tree own"; this classifier answers "what did previous trees
 * leak".
 */

import { COMMAND_ENVIRONMENT } from "../engine/src/process/environment-projection.ts";
import { USER_FOLDER_BOOT_VARIABLES } from "../engine/src/filesystem/user-folders.ts";

// The pattern owner + the live pidfile read live in the census owner now;
// re-exported here so every existing importer resolves to the ONE owner
// (no copy, no drift — the owning test imports these names from here and
// stays green).
export {
  SERVER_TREE_ARGV_SPECS,
  HARNESS_TOOL_ARGV_SPECS,
  argvMatchesServerTree,
  classifyArgv,
  livePidfilePids,
  censusProcesses,
  censusChainOf,
  censusProvenanceOf,
} from "../server/observability/process-census.ts";

/** The verdict for one candidate pid. */
export type StaleVerdict = Readonly<{ stale: boolean; reason: string }>;

/**
 * THE WRONG-TREE VERDICT — the status line that names WHICH TREE one
 * running server pid serves.
 *
 * The measured incident this exists for: a drive/fix round restarted the
 * dev server and got the PRODUCT tree's process — every fix read as
 * missing live (breaker rows stale, toggles answering the old copy, the
 * other tree's web.db 404ing the chat ids) until `/proc/<pid>/cwd`
 * spelunking found the wrong working directory. `sd.mjs status` said
 * RUNNING and named the pids, but never named the TREE, so the one fact
 * that would have caught the hazard in one glance was printed nowhere.
 *
 * The line is a verdict, not decoration: a cwd that is a DIFFERENT tree
 * must say NOT THIS TREE and name both trees plus the remedy, because a
 * driver who sees `serving: /home/example/bridlewise` in a
 * `/home/example/bridlewise-testing` terminal is looking at exactly the
 * ~15-minute trap, and the sentence is what closes it. An unreadable cwd
 * says so — never a guess, and never silently blank.
 *
 * PURE over its inputs so the owning test drives every branch without
 * /proc; the live read stays in sd.mjs (`readPidCwd` — one readlink of
 * `/proc/<pid>/cwd`, derived, never a process scrape).
 */
export function servingTreeLine(pid: number, cwd: string | null, thisRoot: string): string {
  if (cwd === null) {
    return `pid ${String(pid)} serving: (unreadable — /proc/${String(pid)}/cwd could not be read)`;
  }
  if (cwd !== thisRoot) {
    return (
      `pid ${String(pid)} serving: ${cwd} — NOT THIS TREE (this tree is ${thisRoot}); ` +
      "stop from the parent, then start from the tree you are working in"
    );
  }
  return `pid ${String(pid)} serving: ${cwd}`;
}

/**
 * THE BOOT BINDING LINE — what `start`/`restart` print BEFORE anything is
 * launched: the tree this boot will serve (the working directory the
 * launched unit is told to run in) and the config file that tree's server
 * will load.
 *
 * The measured defect: the service ports are global and the launch serves
 * the tree it is invoked from, but the launch output named no tree — an
 * operator who started from the wrong tree drove the other tree's app
 * while every gate judged theirs, and the one discriminating fact was
 * printed nowhere until `status` was run by hand.
 */
export function bootBindingLine(cwd: string, configPath: string): string {
  return `Boot binding: serving tree ${cwd} (config: ${configPath})`;
}

/** The post-launch serving-tree verdict for one running server pid. */
export type BootServingVerdict = Readonly<{ refused: boolean; line: string }>;

/**
 * THE SERVING-TREE VERIFICATION — what `start`/`restart` judge AFTER
 * health: each running server pid's actual tree (read from /proc) against
 * the tree this launch was invoked from. Health proves a server ANSWERS on
 * the ports; it does not prove WHICH tree's server answered, and the ports
 * being global means a racing launch could have health answer from another
 * tree's process — the wrong-tree hazard's worst case, silent before this
 * verdict existed.
 *
 * A POSITIVE different-tree read REFUSES (`refused: true`; the line is the
 * serving line's own vocabulary, naming both trees and the remedy — this
 * delegates to it, so status and the launch can never disagree about a
 * tree). An unreadable cwd is printed honestly and is NOT a refusal:
 * absence is said, never guessed, and the health check stays the boot's
 * liveness gate — the verification refuses only what it positively read.
 */
export function bootServingVerdict(
  pid: number,
  serving: string | null,
  bootCwd: string,
): BootServingVerdict {
  if (serving === null) {
    return { refused: false, line: servingTreeLine(pid, null, bootCwd) };
  }
  if (serving === bootCwd) {
    return {
      refused: false,
      line: `${servingTreeLine(pid, serving, bootCwd)} — the invoked tree, verified`,
    };
  }
  return { refused: true, line: servingTreeLine(pid, serving, bootCwd) };
}

/**
 * THE LAUNCH ARGUMENTS' SHELL QUOTING — the one layer between the launch's
 * argument list and the words systemd-run receives.
 *
 * The launch runs through `execSync`, and execSync executes its command
 * string through `/bin/sh` — the string is re-parsed by a shell before
 * systemd-run ever sees the words. An unquoted join let a space in a path
 * (the working directory, the stderr log) split one intended argument
 * into two systemd-run arguments, and lets a shell metacharacter in a
 * setenv value (the API key, the auth password) be interpreted rather
 * than passed. Single quotes are the layer that leaves nothing
 * interpretable — every character literal, with the embedded single-quote
 * spliced by the standard close-quote, backslash-escape, reopen-quote
 * trick — so a later argument cannot re-open what an earlier one closed.
 *
 * PURE over its input so the owning suite drives a real `/bin/sh` with a
 * space-carrying path and asserts each argument arrives as ONE word.
 */
export function posixShellQuoted(arg: string): string {
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

const DEFAULT_SERVER_ENV_NAMES = new Set(COMMAND_ENVIRONMENT);

/**
 * The dev server's launch environment, shared by systemd and direct launch.
 * Web configuration owns HARNESS_WEB_*; the root config path has its existing
 * name, and the private homes' boot settings (the key home, the evidence
 * store, their XDG bases: USER_FOLDER_BOOT_VARIABLES, one list) pass through (no provider
 * key: the server reads providers from its DB). Ordinary process essentials reuse the server's
 * canonical default subprocess environment, without inheriting a caller's
 * unrelated credentials or execution-injection variables.
 */
export function serverLaunchEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === "string" && (
      DEFAULT_SERVER_ENV_NAMES.has(name) ||
      name.startsWith("HARNESS_WEB_") || name === "HARNESS_CONFIG_PATH" || USER_FOLDER_BOOT_VARIABLES.includes(name)
    )) selected[name] = value;
  }
  return selected;
}

/**
 * THE SYSTEMD-RUN LAUNCH COMMAND — the full string the boot hands to
 * `execSync`, with every argument shell-quoted uniformly (no per-element
 * judgment about which value could carry a space; the flags are quoted as
 * deliberately as the paths, so an argument added tomorrow is covered the
 * day it lands).
 *
 * PURE over its inputs so the owning suite drives the exact command
 * string through the same `/bin/sh` parser execSync uses and watches the
 * argument list arrive unsplit.
 */
export function systemdRunLaunchCommand(args: readonly string[]): string {
  return `systemd-run --user ${args.map(posixShellQuoted).join(" ")}`;
}

/**
 * THE BOOT-REFUSAL STDERR TAIL — the message a failed health check prints
 * so the operator sees the typed, quotable sentence a refused boot left in
 * its stderr instead of a mystery.
 *
 * The measured defect: a boot refused by a typed startup pin (a hand-edited
 * weakening section) failed the health check with "Server did NOT respond"
 * and nothing else — the InputError had gone to the child's stderr, which
 * the launch never captured, so the sentence naming the refused value and
 * the remedy was invisible to the operator holding the terminal. The
 * launch now redirects the boot's stderr to a log beside the pidfiles and
 * prints this message on health failure.
 *
 * PURE over its inputs (the live log read stays in sd.mjs): null is "not
 * captured" (the redirect itself failed — absence said, never a guess), an
 * empty log says the child wrote nothing, and a populated log prints the
 * LAST `lineBound` lines under a header naming both counts and the log's
 * path — bounded, because a tail is what points at a refusal, never the
 * whole log.
 */
export function bootStderrTailMessage(
  stderrText: string | null,
  lineBound: number,
  logPath: string,
): string {
  if (stderrText === null) {
    return `Boot stderr: not captured (no readable stderr log at ${logPath})`;
  }
  const lines = stderrText.split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") {
    lines.pop();
  }
  if (lines.length === 0) {
    return `Boot stderr: empty — the child wrote nothing to stderr before the health check gave up (log: ${logPath})`;
  }
  const kept = lines.length > lineBound ? lines.slice(lines.length - lineBound) : lines;
  const header = `Boot stderr tail (last ${kept.length} of ${lines.length} lines; full log: ${logPath}):`;
  return [header, ...kept.map((line) => `  ${line}`)].join("\n");
}

/**
 * The stale verdict for one candidate pid, PURE over its inputs so the
 * owning test can drive every branch without /proc. A candidate is STALE
 * when it is NONE of: a live pidfile-listed pid, a descendant of one, or
 * the current owner of a service port. Everything else this repo started
 * that the lifecycle does not own is a leak from a previous tree.
 */
export function classifyStaleProcess(input: Readonly<{
  pid: number;
  pidfilePids: readonly number[];
  portPids: readonly number[];
  ppidOf: (pid: number) => number | undefined;
}>): StaleVerdict {
  const { pid, pidfilePids, portPids, ppidOf } = input;
  const owned = new Set<number>([...pidfilePids, ...portPids]);
  if (owned.has(pid)) {
    return { stale: false, reason: "pidfile-listed or service-port owner" };
  }
  // Bounded ancestor walk (64 hops > any real process tree depth): stop at
  // init; ppidOf returning undefined means /proc could not be read (the
  // process died mid-walk) — treat as not-a-descendant, never as stale-proof.
  let cursor = pid;
  for (let hops = 0; hops < 64; hops += 1) {
    const parent = ppidOf(cursor);
    if (parent === undefined || parent <= 1) break;
    if (owned.has(parent)) {
      return { stale: false, reason: "descendant of a live pidfile/port-owner process" };
    }
    cursor = parent;
  }
  return { stale: true, reason: "no pidfile entry, no service port, no live ancestor in the tree" };
}
