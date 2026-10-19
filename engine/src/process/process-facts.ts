/**
 * PROCESS FACTS FROM THE KERNEL — the one reader of procfs and process liveness.
 *
 * Four modules used to read the same facts four ways: the checkout write door
 * parsed `/proc/<pid>/stat` itself, the web suite's reaper shelled out to
 * `cat`, `ps` and `readlink` for the same fields, the CPU measurement had a
 * third parser of the stat line, and three locks each carried their own
 * `kill(pid, 0)` liveness check with slightly different error handling. One
 * owner now answers each question once, with the parse the stat line needs
 * (field 2 is the executable's name in parentheses and may hold spaces and
 * parentheses: every field is read after the LAST `)`).
 *
 * Every reader answers `undefined` when the process is gone or not readable
 * — a fact about another process is never an exception. The procfs root is
 * the root policy's (`ROOT_POLICY.filesystemInfrastructure.procfsRoot`).
 *
 * Never read here: another process's ENVIRONMENT. It holds that process's
 * secrets, and no yes/no question this repository asks needs it.
 */
import { readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SecurityError } from "../kernel/errors.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { debugLog } from "../shared/debug/debug-system.ts";

const PROCFS = ROOT_POLICY.filesystemInfrastructure.procfsRoot;
/** The suffix procfs appends to a link whose target was unlinked. */
const DELETED_LINK_SUFFIX = " (deleted)";

/** The kernel's clock tick in ms (`USER_HZ` = 100 on every Linux architecture): stat times are in these ticks. */
export const CLOCK_TICK_MS = 10;

/** A path under the procfs root — THE one spelling of where procfs is (`ROOT_POLICY`'s `procfsRoot`). */
export function procfsPath(...segments: readonly string[]): string {
  return join(PROCFS, ...segments);
}

/**
 * One procfs document's text, or `undefined` when it cannot be read (the
 * process exited, is not ours, or there is no procfs): a fact about the
 * system is never an exception.
 */
export function procfsDocument(...segments: readonly string[]): string | undefined {
  try {
    return readFileSync(procfsPath(...segments), "utf8");
  } catch {
    // The process exited, or is not ours to read: it contributes no facts.
    return undefined;
  }
}

/**
 * Whether `pid` names a live process: it exists (EPERM means it exists but is
 * not ours to signal — alive) and it is not a ZOMBIE. A killed process whose
 * parent has not reaped it yet (an orphan waiting on a subreaper that reaps
 * late, like the test supervisor) still answers `kill(pid, 0)`, but it runs
 * nothing and holds nothing: a lock, journal or temporary it owned is its
 * dead owner's. When procfs cannot say (none, or hidepid), existence alone
 * answers. A malformed pid is not alive.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
  }
  const state = statFieldsOf(pid)?.[0];
  return state !== "Z" && state !== "X";
}

function readEntry(pid: number | "self", entry: string): string | undefined {
  return procfsDocument(String(pid), entry);
}

function linkOf(path: string): string | undefined {
  try {
    const target = readlinkSync(path);
    return target.endsWith(DELETED_LINK_SUFFIX) ? target.slice(0, -DELETED_LINK_SUFFIX.length) : target;
  } catch {
    return undefined;
  }
}

/**
 * Whether the process GROUP `pgid` has a live member: `kill(-pgid, 0)`
 * with EPERM (alive, not ours) counted alive. That probe alone also counts
 * the DEAD: a member that exited but was not reaped yet (state Z) still
 * answers for the group's id, and a group of only such members — the
 * subreaper-supervised dev tree leaves exactly that past a stop's grace —
 * would read alive until a reaper that is not the stopper's comes. The
 * members are therefore READ (each one's pgrp and state, the same state
 * rule as {@link isProcessAlive}: Z and X are dead): the group is alive
 * while any one of its members is a live process. When procfs cannot say
 * (no member readable — absent, hidepid, or reaped between the probe and
 * the read), existence alone answers, exactly as {@link isProcessAlive}
 * answers for one pid.
 */
export function isProcessGroupAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
  let memberSeen = false;
  for (const pid of allProcessIds()) {
    const fields = statFieldsOf(pid);
    if (fields === undefined || Number(fields[STAT_FIELD.pgrp - 3]) !== pgid) continue;
    memberSeen = true;
    const state = fields[0];
    if (state !== "Z" && state !== "X") return true;
  }
  // Every readable member is a dead process awaiting its reaper: the group
  // is stopped. No member was readable at all: procfs cannot say, and the
  // existence probe's word stands (alive).
  return !memberSeen;
}

/** Sends `signal` to every process of the group `pgid`; `false` when the group is gone (ESRCH). Only {@link terminate} signals. */
function signalProcessGroup(pgid: number, signal: NodeJS.Signals): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

/** How long a SIGKILL sent without grace waits for the kernel's confirmation (the kernel does not refuse it; it only reaps). */
const KILL_CONFIRMATION_MS = 2_000;

/** How a {@link terminate} ended: nothing to stop, stopped by SIGTERM within the grace, killed after it, or still there. */
export type TerminationEnding = "gone" | "terminated" | "killed" | "unconfirmed";

/**
 * KILL-OWNED-ONLY (UR-18): A PROCESS IS STOPPED ONLY BY THE RUN THAT SPAWNED IT.
 *
 * An {@link OwnedProcess} is a process identity (pid + start time, the one
 * identity rule) this run can prove it spawned, and nothing else is one:
 * {@link terminate} takes no other target. It is made only here —
 * {@link ownedChild} (a live descendant of this process, read from its
 * parent chain when the caller takes it, so a process this run started
 * through a supervisor counts), {@link ownedSelf} (this process, for its
 * own lifecycle's record) and {@link readSpawnRecord} (the record a run wrote
 * with {@link writeSpawnRecord} when it spawned the process). A process found
 * any other way — on a port, in a process scan, from a pid somebody typed —
 * is never ours to stop: a run that killed a neighbour's qualification by
 * its process group (2026-10-08) is the reason. A forged object of the same
 * shape is refused at run time too (`termination_not_owned`).
 */
export type OwnedProcess = ProcessIdentity & Readonly<{ owned: true }>;

const OWNED = new WeakSet<object>();

/** The refusal: a target this run cannot prove it spawned (a security refusal: nothing is signalled). */
class TerminationNotOwned extends SecurityError {
  constructor(message: string) {
    super(message, "termination_not_owned");
    this.name = "TerminationNotOwned";
  }
}

/**
 * THE ONE OWNERSHIP RULE (security K-1/MF-6, design K1): a process is owned
 * only by its FULL identity — a pid AND its start time. A start time procfs
 * could not give (null) owns nothing: a bare pid may be recycled by any
 * process by the time it is signalled. The same rule the lock applies
 * (`file_lock_identity_unknown`).
 */
function own(identity: ProcessIdentity): OwnedProcess {
  if (identity.startTime === null) throw new TerminationNotOwned(`pid ${String(identity.pid)} has no start time: a bare pid is no identity, so nothing is owned (a recycled pid would be signalled)`);
  const owned = Object.freeze({ pid: identity.pid, startTime: identity.startTime, owned: true as const });
  OWNED.add(owned);
  return owned;
}

/**
 * The process `child` names, owned: it must be alive and descend from this
 * process (its parent chain reaches `process.pid`) when it is taken — take
 * it when the child is spawned (or announced by a supervisor this run
 * started), and keep it.
 */
export function ownedChild(child: Readonly<{ pid?: number | undefined }>): OwnedProcess {
  const pid = child.pid;
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1) throw new TerminationNotOwned(`no process to own: the spawn has no pid (${String(pid)})`);
  const identity = processIdentity(pid);
  if (!isProcessAlive(pid) || !ancestorsOf(pid).includes(process.pid)) {
    throw new TerminationNotOwned(`pid ${String(pid)} does not descend from this process (${String(process.pid)}): only the run that spawned a process may stop it`);
  }
  return own(identity);
}

/**
 * The process a supervisor THIS RUN STARTED announced it spawned (its first
 * receipt line, on the pipe only this run reads): the supervisor's own spawn
 * record. Read when the supervisor ended without its receipt — its command,
 * re-parented by then, is no longer a descendant, and only this announcement
 * ties it to the run. The one caller is the supervised run
 * (engine/src/process/supervised-run.ts), held by the process-liveness guard.
 */
export function ownedAnnouncement(announced: ProcessIdentity): OwnedProcess {
  if (!Number.isInteger(announced.pid) || announced.pid <= 1) throw new TerminationNotOwned(`an announcement names no process (${String(announced.pid)})`);
  // The identity the supervisor announced AT SPAWN (its unreaped child's start time), never one read now:
  // by now the pid may lead another group (security K-2).
  return own(announced);
}

/** This process, owned by itself: what its lifecycle records so that a later step of the same run can stop it. */
export function ownedSelf(): OwnedProcess {
  return own(processIdentity());
}

/** Records `owned` at `path` (the one identity record) when the run spawns it: the proof a later step of the run stops it by. */
export function writeSpawnRecord(path: string, owned: OwnedProcess): void {
  if (!OWNED.has(owned)) throw new TerminationNotOwned(`a spawn record holds only a process this run owns (pid ${String(owned.pid)})`);
  writeFileSync(path, processIdentityRecord(owned), { encoding: "utf8", mode: ROOT_POLICY.filesystemInfrastructure.privateState.fileMode });
}

/**
 * The process a spawn record holds, owned, or `undefined` (absent, unreadable,
 * not an identity record, or a record with no start time: a bare pid owns
 * nothing, and is said).
 */
export function readSpawnRecord(path: string): OwnedProcess | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const identity = parseProcessIdentityRecord(text);
  if (identity === undefined) return undefined;
  if (identity.startTime === null) {
    debugLog("process", "warn", `the spawn record ${path} names pid ${String(identity.pid)} with no start time: it owns nothing, so nothing is stopped by it`, () => ({ path, pid: identity.pid }));
    return undefined;
  }
  return own(identity);
}

/**
 * What {@link terminate} stops: one owned process (by its identity — a pid
 * recycled by another process meanwhile is never signalled), or the process
 * group an owned process leads (spawned detached: pid = pgid). A group is
 * still the owned one while its leader runs, or while the leader is gone but
 * members remain (the kernel never hands a live group's id to a new
 * process); a leader's pid now held by ANOTHER process means the group is
 * gone, never that the new process's group is ours.
 */
export type TerminationTarget = OwnedProcess | Readonly<{ group: OwnedProcess }>;

/**
 * THE ONE TERMINATE-POLL-KILL LOOP: SIGTERM, wait up to `graceMs` for the
 * target to go, then SIGKILL and wait a further grace for the kernel to
 * confirm (a grace of 0: SIGKILL at once, sent before the call first
 * yields). A target that is not ours to signal (EPERM) is left alone and
 * reported `unconfirmed` (never an unhandled rejection in a shutdown handler).
 * A target this run cannot prove it spawned ({@link OwnedProcess}) is refused
 * before any signal. The grace is the caller's configured value: this owner
 * holds no timing.
 */
export async function terminate(target: TerminationTarget, options: Readonly<{ graceMs: number; pollMs?: number }>): Promise<Readonly<{ ending: TerminationEnding; waitedMs: number }>> {
  const owned = "group" in target ? target.group : target;
  if (!OWNED.has(owned)) throw new TerminationNotOwned(`pid ${String(owned.pid)} was not taken as this run's own (ownedChild, ownedSelf or a spawn record): refused, nothing signalled`);
  const started = Date.now();
  const pollMs = options.pollMs ?? Math.max(10, Math.min(100, Math.floor(options.graceMs / 10)));
  const alive = (): boolean => {
    if (!("group" in target)) return isProcessIdentityLive(owned);
    if (isProcessAlive(owned.pid) && !isProcessIdentityLive(owned)) return false;
    return isProcessGroupAlive(owned.pid);
  };
  // Every signal is sent only while the target is still the one named: a
  // recycled pid (identity target) or an emptied group is never signalled.
  const send = (signal: NodeJS.Signals): "sent" | "gone" | "refused" => {
    if (!alive()) return "gone";
    try {
      return "group" in target ? (signalProcessGroup(owned.pid, signal) ? "sent" : "gone") : (process.kill(owned.pid, signal), "sent");
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "refused";
    }
  };
  const waitGone = async (graceMs: number): Promise<boolean> => {
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      if (!alive()) return true;
      await new Promise((resolveWait) => setTimeout(resolveWait, pollMs));
    }
    return !alive();
  };
  const ended = (ending: TerminationEnding) => Object.freeze({ ending, waitedMs: Date.now() - started });
  if (!alive()) return ended("gone");
  // No grace: SIGKILL at once (sent before this call first yields), then the kernel's confirmation.
  if (options.graceMs === 0) {
    const kill = send("SIGKILL");
    if (kill === "gone") return ended("gone");
    if (kill === "refused") return ended("unconfirmed");
    return ended((await waitGone(KILL_CONFIRMATION_MS)) ? "killed" : "unconfirmed");
  }
  const term = send("SIGTERM");
  if (term === "gone") return ended("gone");
  if (term === "refused") return ended("unconfirmed");
  if (await waitGone(options.graceMs)) return ended("terminated");
  if (send("SIGKILL") !== "sent") return ended(alive() ? "unconfirmed" : "killed");
  return ended((await waitGone(options.graceMs)) ? "killed" : "unconfirmed");
}

/** Whether procfs answers for this process at all (absent on non-Linux, under hidepid, in a sandbox without it). */
export function procfsAvailable(): boolean {
  return readEntry(process.pid, "stat") !== undefined;
}

/**
 * The fields of `/proc/<pid>/stat` from field 3 (`state`) on — `proc(5)`
 * field N is index `N - 3` — or `undefined`.
 */
function statFieldsOf(pid: number | "self"): readonly string[] | undefined {
  const stat = readEntry(pid, "stat");
  return stat === undefined ? undefined : parseStatLine(stat);
}

/**
 * The fields of one `stat` line from field 3 on: everything after the LAST
 * `)`, because field 2 (the executable's name, in parentheses) may itself
 * hold spaces and parentheses — splitting the whole line mis-indexes every
 * later field, the standard trap of this file.
 */
export function parseStatLine(line: string): readonly string[] | undefined {
  const close = line.lastIndexOf(")");
  return close < 0 ? undefined : line.slice(close + 2).trim().split(/\s+/u);
}

/** `proc(5)` field numbers this repository reads. */
export const STAT_FIELD = Object.freeze({ ppid: 4, pgrp: 5, utime: 14, stime: 15, cutime: 16, cstime: 17, starttime: 22 });

function statNumber(pid: number, field: number): number | undefined {
  const value = Number(statFieldsOf(pid)?.[field - 3]);
  return Number.isInteger(value) ? value : undefined;
}

/** The facts of one `stat` line a process census needs, or `undefined` (the process exited, or is not ours). */
export type StatFacts = Readonly<{ ppid: number; name: string; utimeTicks: number; stimeTicks: number; starttimeTicks: number }>;

/** {@link StatFacts} of `pid`, read once. */
export function statFactsOf(pid: number): StatFacts | undefined {
  const line = readEntry(pid, "stat");
  const fields = line === undefined ? undefined : parseStatLine(line);
  if (line === undefined || fields === undefined) return undefined;
  const at = (field: number): number => Number(fields[field - 3]);
  const facts = { ppid: at(STAT_FIELD.ppid), utimeTicks: at(STAT_FIELD.utime), stimeTicks: at(STAT_FIELD.stime), starttimeTicks: at(STAT_FIELD.starttime) };
  if (!Object.values(facts).every(Number.isFinite)) return undefined;
  return Object.freeze({ ...facts, name: line.slice(line.indexOf("(") + 1, line.lastIndexOf(")")) });
}

/** The resident set size in bytes (`VmRSS` of `status`), or `undefined`. */
export function residentBytesOf(pid: number): number | undefined {
  const match = readEntry(pid, "status")?.match(/^VmRSS:\s+(\d+) kB$/mu);
  return match === null || match === undefined ? undefined : Number(match[1]) * 1024;
}

/**
 * THE wall-clock time of boot in ms (now minus the `uptime` document), or
 * `undefined` (no procfs: the boot time is unknown, which callers state as
 * absence). The one boot-time answer: a start time in ticks becomes a wall
 * clock only through {@link startWallTimeMsOf}.
 */
export function bootWallTimeMs(): number | undefined {
  const uptime = Number(procfsDocument("uptime")?.split(" ")[0]);
  return Number.isFinite(uptime) && uptime > 0 ? Date.now() - uptime * 1000 : undefined;
}

/** A start time in ticks since boot as a wall clock in ms, given the boot time; `undefined` when either is unknown. */
export function startWallTimeMs(startTicks: number | undefined, bootMs: number | undefined = bootWallTimeMs()): number | undefined {
  return startTicks === undefined || bootMs === undefined ? undefined : bootMs + startTicks * CLOCK_TICK_MS;
}

/** When `pid` started, as a wall clock in ms, or `undefined`. */
export function startWallTimeMsOf(pid: number): number | undefined {
  return startWallTimeMs(startTimeOf(pid));
}

/**
 * The inodes of the TCP sockets in LISTEN state and their local ports, from
 * the `net/tcp` and `net/tcp6` documents (inode → port). An established
 * connection is not a listener.
 */
function listeningTcpSockets(): ReadonlyMap<string, number> {
  const sockets = new Map<string, number>();
  for (const table of ["tcp", "tcp6"]) {
    for (const [inode, port] of parseListeningSockets(procfsDocument("net", table) ?? "")) sockets.set(inode, port);
  }
  return sockets;
}

/** The LISTEN rows of one `net/tcp{,6}` document, as inode → local port (pure: a test hands it a document). */
export function parseListeningSockets(document: string): ReadonlyMap<string, number> {
  const sockets = new Map<string, number>();
  for (const line of document.split("\n")) {
    const parts = line.trim().split(/\s+/u);
    if (parts.length < 10 || parts[3] !== "0A") continue;
    const local = parts[1] ?? "";
    const colon = local.lastIndexOf(":");
    const port = colon < 0 ? Number.NaN : Number.parseInt(local.slice(colon + 1), 16);
    const inode = parts[9] ?? "";
    if (Number.isInteger(port) && inode.length > 0 && inode !== "0") sockets.set(inode, port);
  }
  return sockets;
}

/** A process holding a listening TCP socket, and the port. */
export type PortListener = Readonly<{ pid: number; port: number }>;

/**
 * THE ONE ANSWER to "which processes listen on these ports": the listening
 * sockets ({@link listeningTcpSockets}) matched to the processes holding them
 * ({@link socketInodesOf}), sorted by port then pid. A process that is not
 * ours to inspect is absent (procfs hides its descriptors), never guessed.
 */
export function processesListeningOn(ports: Iterable<number>): readonly PortListener[] {
  const wanted = new Set(ports);
  const inodeToPort = new Map([...listeningTcpSockets()].filter(([, port]) => wanted.has(port)));
  if (inodeToPort.size === 0) return [];
  const listeners: PortListener[] = [];
  for (const pid of allProcessIds()) {
    for (const port of new Set(socketInodesOf(pid).flatMap((inode) => inodeToPort.get(inode) ?? []))) listeners.push(Object.freeze({ pid, port }));
  }
  return listeners.toSorted((a, b) => a.port - b.port || a.pid - b.pid);
}

/** The socket inodes `pid` holds open (its `socket:[N]` descriptors). */
function socketInodesOf(pid: number): readonly string[] {
  return openFileTargetsOf(pid).flatMap((target) => /^socket:\[(\d+)\]$/u.exec(target)?.[1] ?? []);
}

/** This process's mount table document (`self/mountinfo`), or `undefined`. */
export function mountInfoDocument(): string | undefined {
  return procfsDocument("self", "mountinfo");
}

/** The parent pid, or `undefined`. */
export function parentOf(pid: number): number | undefined {
  const parent = statNumber(pid, STAT_FIELD.ppid);
  return parent !== undefined && parent > 0 ? parent : undefined;
}

/** The process group id, or `undefined`. */
export function processGroupOf(pid: number): number | undefined {
  return statNumber(pid, STAT_FIELD.pgrp);
}

/** The process's start time (clock ticks since boot, `proc(5)` field 22), or `undefined`. */
function startTimeOf(pid: number): number | undefined {
  return statNumber(pid, STAT_FIELD.starttime);
}

/**
 * A process, identified so that a RECYCLED pid is not mistaken for it: the
 * pid plus its start time (`null` where procfs could not say when it was
 * recorded — then the pid alone identifies it).
 */
export type ProcessIdentity = Readonly<{ pid: number; startTime: number | null }>;

/** This process's identity (or another pid's, read now). */
export function processIdentity(pid: number = process.pid): ProcessIdentity {
  return Object.freeze({ pid, startTime: startTimeOf(pid) ?? null });
}

/**
 * THE ONE PROCESS-IDENTITY RECORD a pid file, a lock or a journal owner
 * writes: `{"pid":N,"startTime":N|null}` (one line). A bare pid is not an
 * identity (a recycled pid would be signalled), so it is refused.
 */
export function processIdentityRecord(identity: ProcessIdentity = processIdentity()): string {
  return `${JSON.stringify({ pid: identity.pid, startTime: identity.startTime })}\n`;
}

/** The identity a {@link processIdentityRecord} holds, or `undefined` for anything else (a bare pid, another shape). */
export function parseProcessIdentityRecord(text: string): ProcessIdentity | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const { pid, startTime } = parsed as Record<string, unknown>;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
  if (startTime !== null && (typeof startTime !== "number" || !Number.isInteger(startTime) || startTime < 0)) return undefined;
  const identity = Object.freeze({ pid, startTime });
  // Exactly the record's own spelling ({@link processIdentityRecord}): `1.0`,
  // `1e3` or extra fields parse to the same numbers but are not a record this
  // owner wrote (WF-1b3b design LOW: they were accepted).
  return text.trimEnd() === processIdentityRecord(identity).trimEnd() ? identity : undefined;
}

/**
 * Whether the process `identity` names is still running: its pid is alive
 * and, when both start times are known, it is the SAME process (a pid reused
 * by a later process has a later start time).
 */
export function isProcessIdentityLive(identity: ProcessIdentity): boolean {
  if (!isProcessAlive(identity.pid)) return false;
  if (identity.startTime === null) return true;
  const now = startTimeOf(identity.pid);
  return now === undefined || now === identity.startTime;
}

/** The real uid a process runs as (`/proc/<pid>/status`, the first field of `Uid:`), or `undefined` when procfs cannot say. */
export function processUid(pid: number): number | undefined {
  const line = readEntry(pid, "status")?.split("\n").find((entry) => entry.startsWith("Uid:"));
  const uid = Number(line?.slice("Uid:".length).trim().split(/\s+/u)[0]);
  return line !== undefined && Number.isInteger(uid) ? uid : undefined;
}

/**
 * Whether `identity` names a live process (pid AND start time) that runs as
 * THIS process's user: what may hold a lock of this user (security L-1/MF-7).
 * Pid 1 with its real start time, or another user's process, holds nothing:
 * a real holder is always one of this user's own processes.
 */
export function isOwnProcessIdentityLive(identity: ProcessIdentity): boolean {
  return isProcessIdentityLive(identity) && processUid(identity.pid) === process.getuid?.();
}

/** The NUL-split command line, or `undefined` (a kernel thread has an empty one). */
export function commandLineOf(pid: number): readonly string[] | undefined {
  return readEntry(pid, "cmdline")?.split("\0").filter((token) => token.length > 0);
}

/** The working directory, or `undefined`. */
export function workingDirectoryOf(pid: number): string | undefined {
  return linkOf(procfsPath(String(pid), "cwd"));
}

/** The executable's path, or `undefined`. */
export function executableOf(pid: number): string | undefined {
  return linkOf(procfsPath(String(pid), "exe"));
}

/** The paths `pid` holds open (descriptor link targets; sockets and pipes as procfs names them). */
export function openFileTargetsOf(pid: number): readonly string[] {
  const directory = procfsPath(String(pid), "fd");
  let descriptors: readonly string[];
  try {
    descriptors = readdirSync(directory);
  } catch {
    return [];
  }
  return descriptors.map((descriptor) => linkOf(join(directory, descriptor))).filter((target): target is string => target !== undefined);
}

/** Every live pid procfs lists. */
export function allProcessIds(): readonly number[] {
  let entries: readonly string[];
  try {
    entries = readdirSync(PROCFS);
  } catch {
    return [];
  }
  return entries.filter((entry) => /^\d+$/u.test(entry)).map(Number);
}

/** `pid` and its ancestors' pids, nearest first, up to (excluding) init. */
export function ancestorsOf(pid: number): readonly number[] {
  const chain: number[] = [];
  const seen = new Set<number>([pid]);
  for (let current = parentOf(pid); current !== undefined && current > 1 && !seen.has(current); current = parentOf(current)) {
    seen.add(current);
    chain.push(current);
  }
  return chain;
}
