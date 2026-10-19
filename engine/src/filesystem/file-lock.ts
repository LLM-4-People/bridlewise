/**
 * THE CROSS-PROCESS FILE LOCK — the one lock primitive of the harness. Every
 * lock file is taken, judged, broken and released here; its consumers own
 * only WHERE their lock lives and the error or refusal it maps to:
 *
 *   - `withFileLock` (synchronous, bounded wait, re-entrant): the config write
 *     lock (`kernel/config-write-lock.ts`), the deletion declarations
 *     (`git/declared-deletions.ts`), the run ledgers (`shared/run-history.ts`);
 *   - `acquireFileLock` (asynchronous, bounded wait): the resource locks
 *     (`workflow/resource-lock.ts`: the test lock, the workspace merge
 *     lock) and the retained merge-round script;
 *   - `tryAcquireFileLock` (never waits): the one-instrument test-run lock
 *     (`scripts/tooling/test-run-lock.ts`), which refuses instead of waiting.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * Atomic rename makes every READER see old bytes or new bytes, but two
 * WRITERS can still interleave their read-modify-write cycles around an
 * atomic write each: a writer whose read lands inside another writer's
 * window restores the window's bytes, and the other writer's change
 * vanishes. Measured on the config file, on the deletion declarations (12
 * parallel declares reported success and the record held 7) and on the run
 * ledgers (a copy-back's import racing a suite's append). And the lock
 * itself used to have three owners with three policies (this one broke a
 * LIVE holder after an age; the resource lock did too, after 300 s; the
 * test-run lock refused an unreadable lock forever), each with its own break
 * race (wf-del2-design D1).
 *
 * ── THE RULES, ONE PLACE ──────────────────────────────────────────────────
 *
 * - ACQUIRE: the holder's record is published through the one exclusive
 *   writer (`atomicWriteFile` exclusive + durable: complete and fsynced
 *   before `link(2)` names it). The kernel refuses the link when the lock
 *   exists, so two contenders never both take a free lock, and a reader
 *   never sees a partial record.
 * - A LIVE HOLDER IS NEVER BROKEN. The record names its holder by pid AND
 *   start time AND this user (`isOwnProcessIdentityLive`: a recycled pid, pid 1 or another user's process is no holder);
 *   while that process lives the lock is its own, however long it holds it
 *   (merge-door-final J9). A waiter's bound is its own timeout, never the
 *   holder's age.
 * - A DEAD HOLDER'S lock is broken at once.
 * - AN UNREADABLE LOCK (a file this owner did not write: the link publishes a
 *   record whole, so unparseable means foreign — another format, a
 *   hand-made file) is honoured as held until it is `unreadableAfterMs` old
 *   (the caller's bound; the root policy's `fileLock.staleMs` by default),
 *   then broken. ONE policy for every lock: an unidentifiable holder cannot
 *   wedge a lock forever, and a fresh one is not destroyed on sight.
 * - THE BREAK IS ATOMIC against every other breaker: the breaker takes
 *   `<lock>.break` through the same exclusive writer, re-reads the lock and
 *   breaks it only when it still holds the EXACT record it judged (a dead
 *   holder's nonce), by a rename aside. Two contenders that judged the same
 *   dead holder cannot both break: the second finds the first's fresh live
 *   record and waits on it. The break file lives for a few syscalls; one
 *   left by a breaker that died inside its break is removed once its own
 *   holder is dead (the one residual race, stated: it needs a breaker to die
 *   inside that window AND two contenders to judge its leftover at once).
 * - RELEASE: only what the handle still owns, checked by nonce, so a lock
 *   broken and re-taken by another is never freed by its previous holder;
 *   and at process exit for anything still held.
 * - RE-ENTRANCY (`withFileLock` only): a process that holds a lock and asks
 *   again (a write gate that locks internally, called inside a held cycle)
 *   borrows its own hold.
 * - A HOLD OUTLIVES ITS HOLDER WHILE WHAT IT ADOPTED LIVES: the owner may
 *   name further processes (`adopt`: the supervisor of a command it runs, by
 *   pid AND start time) in its record, rewritten whole under the same nonce.
 *   The lock is live while the holder OR any adopted process lives — so a
 *   holder killed outright never frees the lock under a command still
 *   running (the supervisor ends only after its whole process tree is gone).
 * - EVERY BREAK AND EVERY TIMEOUT is an audit event (`file-lock-broken` with
 *   the reason and the holder, `file-lock-timeout` with the holder waited on).
 *
 * The timing policy is the root policy's (`filesystemInfrastructure.fileLock`);
 * a caller may pass its own configured wait and unreadable bound.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

import { HarnessError } from "../kernel/errors.ts";
import { randomUuid } from "../kernel/integrity.ts";
import { schemaId } from "../kernel/product-identity.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { isOwnProcessIdentityLive, processIdentity } from "../process/process-facts.ts";
import { bestEffort } from "../shared/best-effort.ts";
import { guarded } from "../process/fault-policy.ts";
import { auditEvent } from "../shared/debug/debug-system.ts";
import { atomicWriteFile } from "./atomic-write.ts";
import { ensurePrivateStateDirectory, PRIVATE_STATE_FILE_MODE } from "./private-state.ts";

/** The lock record's dialect, so a foreign or future file is judged unreadable. */
export const FILE_LOCK_SCHEMA_VERSION = schemaId("file-lock", 1);

export type FileLockContent = Readonly<{
  schemaVersion: string;
  pid: number;
  /** The holder's start time: a recycled pid is another holder. Required: a bare pid is not an identity (process-facts.ts). */
  startTime: number;
  acquiredAt: string;
  nonce: string;
  /** Who holds it, in the caller's words (a runner, a resource owner), named in every refusal; `null`: unnamed. Read back bounded, its control characters escaped. */
  holder: string | null;
  /** Further processes whose life extends the hold (see the header), each by pid AND start time; empty for most locks. */
  adopted: readonly Readonly<{ pid: number; startTime: number }>[];
}>;

/** What a caller's timeout refusal is built from. */
export type FileLockTimeout = (message: string, details: Readonly<{ lockPath: string }>) => HarnessError;

export type FileLockOptions = Readonly<{
  /** Who asks: written into the record, named to every contender (`holder`). */
  holder?: string | null;
  /** How long a waiting acquire waits (the policy's `timeoutMs` by default). */
  timeoutMs?: number;
  /** How often a waiting acquire looks again (the policy's `pollIntervalMs` by default). */
  pollIntervalMs?: number;
  /** How old an UNREADABLE lock file must be before it is broken (the policy's `staleMs` by default). */
  unreadableAfterMs?: number;
}>;

/**
 * A hold this process owns; `release` is idempotent and frees only this hold;
 * `adopt` names a further process whose life extends the hold.
 */
export type FileLockHandle = Readonly<{ lockPath: string; nonce: string; acquiredAt: string; release: () => void; adopt: (pid: number) => void }>;

/**
 * One attempt's answer: `taken`; `held` by a live holder (named); `unreadable`
 * (a foreign file younger than the bound); `contended` (breaks kept racing
 * other contenders and never settled — try again).
 */
export type FileLockAttempt =
  | Readonly<{ state: "taken"; handle: FileLockHandle }>
  | Readonly<{ state: "held"; holder: FileLockContent }>
  | Readonly<{ state: "unreadable" }>
  | Readonly<{ state: "contended" }>;

/** How many times one attempt breaks and retries before it answers `contended`. */
const MAX_BREAKS_PER_ATTEMPT = 8;

/** The holds this process owns, by lock path (the nonce each release checks). */
const owned = new Map<string, string>();

/** `withFileLock`'s re-entrancy: how deep this process is inside its own hold of a lock. */
const depths = new Map<string, number>();

/** A process named by pid AND start time — the one identity rule: a bare pid, or a pid with no start time, is no identity. */
function isIdentity(entry: unknown): entry is Readonly<{ pid: number; startTime: number }> {
  if (typeof entry !== "object" || entry === null) return false;
  const { pid, startTime } = entry as { pid?: unknown; startTime?: unknown };
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 && typeof startTime === "number" && Number.isInteger(startTime) && startTime >= 0;
}

/**
 * A holder label as it may be SHOWN: control characters escaped (no terminal
 * escape, no forged second line), bounded to the policy's length — applied
 * when the record is READ, whoever wrote it.
 */
export function printableHolderLabel(label: string): string {
  // Control characters, and the format characters that reorder or break what a terminal shows (bidi embeddings,
  // overrides and isolates, the line and paragraph separators): security L-2.
  const escaped = label.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const maximum = ROOT_POLICY.filesystemInfrastructure.fileLock.maximumHolderCharacters;
  return escaped.length > maximum ? `${escaped.slice(0, maximum - 1)}…` : escaped;
}

/** `value` is an instant exactly as `Date.prototype.toISOString` writes it. */
function isWrittenInstant(value: string): boolean {
  const instant = new Date(value);
  return !Number.isNaN(instant.getTime()) && instant.toISOString() === value;
}

function parseContent(text: string): FileLockContent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: a file this owner did not write (see the header), judged unreadable.
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== FILE_LOCK_SCHEMA_VERSION) return null;
  if (!isIdentity(parsed)) return null;
  const { pid, startTime } = parsed;
  // The instant the holder took the lock, as the writer writes it (`toISOString`): anything else — a forged line, a
  // terminal escape — is no record of this owner (security L-2; it is shown in every wait line).
  if (typeof record.acquiredAt !== "string" || !isWrittenInstant(record.acquiredAt)) return null;
  if (typeof record.nonce !== "string" || record.nonce.length === 0) return null;
  const adopted: unknown = record.adopted ?? [];
  if (!Array.isArray(adopted) || !adopted.every(isIdentity)) return null;
  return {
    schemaVersion: record.schemaVersion,
    pid,
    startTime,
    acquiredAt: record.acquiredAt,
    nonce: record.nonce,
    holder: typeof record.holder === "string" && record.holder.length > 0 ? printableHolderLabel(record.holder) : null,
    adopted: adopted.map((entry) => ({ pid: entry.pid, startTime: entry.startTime })),
  };
}

/**
 * The lock file's bytes and age as they are now, or `undefined` when nothing
 * is there — read through a descriptor opened WITHOUT following a link and
 * without blocking, from a regular file of at most the policy's record size.
 * A link, a special file (a FIFO would block a waiter) or an oversized file
 * (a link to /dev/zero would exhaust it) is never read: it is judged
 * unreadable (empty text), with its own age.
 */
function observe(path: string): Readonly<{ text: string; ageMs: number }> | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "ELOOP") return { text: "", ageMs: ageOf(lstatSync(path).mtimeMs) };
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > ROOT_POLICY.filesystemInfrastructure.fileLock.maximumRecordBytes) return { text: "", ageMs: ageOf(stat.mtimeMs) };
    return { text: readFileSync(descriptor, "utf8"), ageMs: ageOf(stat.mtimeMs) };
  } finally {
    closeSync(descriptor);
  }
}

function ageOf(mtimeMs: number): number {
  return Math.max(0, Date.now() - mtimeMs);
}

/** The holder named by a lock file now (`null`: nothing there, or unreadable). */
function readFileLockHolder(lockPath: string): FileLockContent | null {
  const seen = observe(lockPath);
  return seen === undefined ? null : parseContent(seen.text);
}

/** A holder is live while it or a process it adopted is alive, by identity, AS THIS USER (pid 1 or another user's process never holds a lock of this user). */
function isLive(holder: FileLockContent): boolean {
  return isOwnProcessIdentityLive({ pid: holder.pid, startTime: holder.startTime }) || holder.adopted.some((entry) => isOwnProcessIdentityLive(entry));
}

/** The holder a lock file names now when it is live, else `null` (released, dead, or unreadable). */
export function liveFileLockHolder(lockPath: string): FileLockContent | null {
  const holder = readFileLockHolder(lockPath);
  return holder !== null && isLive(holder) ? holder : null;
}

/** Publishes a fresh record at `path` if nothing is there: the nonce, or `undefined` when something is. */
function publish(path: string, holder: string | null): Readonly<{ nonce: string; acquiredAt: string }> | undefined {
  const nonce = randomUuid();
  const { startTime } = processIdentity();
  if (startTime === null) throw new HarnessError("this process's start time cannot be read: a lock record names its holder by pid AND start time", "file_lock_identity_unknown");
  const record: FileLockContent = {
    schemaVersion: FILE_LOCK_SCHEMA_VERSION,
    pid: process.pid,
    startTime,
    acquiredAt: new Date().toISOString(),
    nonce,
    holder,
    adopted: [],
  };
  // A LINK at the lock path is refused LOUDLY by the one writer (`atomic_write_link_refused`): a planted
  // link is never written through, never waited on and never broken quietly.
  const written = atomicWriteFile(path, serializedRecord(record), { exclusive: true, durable: true, exactMode: PRIVATE_STATE_FILE_MODE, createParentDirectories: false });
  if (written.success) return { nonce, acquiredAt: record.acquiredAt };
  if ((written.error as NodeJS.ErrnoException | undefined)?.code === "EEXIST") return undefined;
  throw written.error;
}

/** Unlinks `path` when it still carries `nonce` (a hold, or a break file, this process made). */
function unlinkIfStill(path: string, nonce: string): void {
  const seen = observe(path);
  if (seen !== undefined && parseContent(seen.text)?.nonce === nonce) bestEffort(() => unlinkSync(path));
}

/**
 * A break file left by a breaker that died inside its break: removed once its
 * holder is dead (or, unreadable, once it is older than the bound). A live
 * breaker is finishing its few syscalls: the caller simply tries again.
 */
function clearAbandonedBreak(breakPath: string, unreadableAfterMs: number): void {
  const seen = observe(breakPath);
  if (seen === undefined) return;
  const breaker = parseContent(seen.text);
  const abandoned = breaker === null ? seen.ageMs >= unreadableAfterMs : !isLive(breaker);
  if (!abandoned) return;
  const again = observe(breakPath);
  if (again === undefined || again.text !== seen.text) return;
  bestEffort(() => unlinkSync(breakPath));
  auditEvent("file-lock-broken", { lockPath: breakPath, reason: breaker === null ? "unreadable-break" : "dead-breaker", holder: breaker });
}

/**
 * THE BREAK: under `<lock>.break`, the lock is moved aside only when it still
 * holds exactly the `judged` bytes (see the header). Whether it broke or not,
 * the caller then tries to acquire again.
 */
function breakJudged(lockPath: string, judged: string, reason: "dead" | "unreadable", holder: FileLockContent | null, unreadableAfterMs: number): void {
  const breakPath = `${lockPath}.break`;
  const breaking = publish(breakPath, `breaking ${lockPath}`);
  if (breaking === undefined) {
    clearAbandonedBreak(breakPath, unreadableAfterMs);
    return;
  }
  try {
    const now = observe(lockPath);
    // Released, or already broken and re-taken by a live holder: nothing to break.
    if (now === undefined || now.text !== judged) return;
    const aside = `${lockPath}.broken-${breaking.nonce}`;
    renameSync(lockPath, aside);
    bestEffort(() => unlinkSync(aside));
    auditEvent("file-lock-broken", { lockPath, reason, holder });
  } finally {
    unlinkIfStill(breakPath, breaking.nonce);
  }
}

function own(lockPath: string, nonce: string, acquiredAt: string): FileLockHandle {
  owned.set(lockPath, nonce);
  if (owned.size === 1) process.once("exit", releaseAllOnExit);
  let released = false;
  return Object.freeze({
    lockPath,
    nonce,
    acquiredAt,
    release: () => {
      if (released) return;
      released = true;
      releaseOwned(lockPath, nonce);
    },
    adopt: (pid: number) => {
      if (released || owned.get(lockPath) !== nonce) return;
      const identity = processIdentity(pid);
      // A process whose start time cannot be read has already ended: nothing of it extends the hold.
      if (identity.startTime !== null) adoptInto(lockPath, nonce, { pid, startTime: identity.startTime });
    },
  });
}

/**
 * Rewrite this hold's record with `identity` adopted (whole, durable, under the
 * same nonce): only the owner writes its record, so the rewrite races nobody
 * but a breaker, which breaks only the exact bytes it judged dead.
 */
/** THE ONE SERIALIZER of a lock record (one JSON line): the first write and every adoption. */
function serializedRecord(record: FileLockContent): string {
  return `${JSON.stringify(record)}\n`;
}

function adoptInto(lockPath: string, nonce: string, identity: Readonly<{ pid: number; startTime: number }>): void {
  const current = readFileLockHolder(lockPath);
  if (current === null || current.nonce !== nonce) return;
  // Ended adopted processes are dropped as a new one joins: the record names what may still run.
  const record: FileLockContent = { ...current, adopted: [...current.adopted.filter((entry) => entry.pid !== identity.pid && isOwnProcessIdentityLive(entry)), identity] };
  const written = atomicWriteFile(lockPath, serializedRecord(record), { durable: true, exactMode: PRIVATE_STATE_FILE_MODE, createParentDirectories: false });
  if (!written.success) throw written.error;
}

function releaseOwned(lockPath: string, nonce: string): void {
  if (owned.get(lockPath) !== nonce) return;
  owned.delete(lockPath);
  if (owned.size === 0) process.removeListener("exit", releaseAllOnExit);
  unlinkIfStill(lockPath, nonce);
}

/** At exit, every lock this process still holds is released (guarded: an exit listener has no caller). */
const releaseAllOnExit = guarded("filesystem.file-lock.exit-release", (): void => {
  for (const [lockPath, nonce] of owned) unlinkIfStill(lockPath, nonce);
  owned.clear();
});

function unreadableBound(options: FileLockOptions): number {
  return options.unreadableAfterMs ?? ROOT_POLICY.filesystemInfrastructure.fileLock.staleMs;
}

/**
 * ONE ATTEMPT, NEVER WAITS: take the lock (breaking a dead holder's, or an
 * unreadable one older than the bound, first), or say who holds it.
 */
export function tryAcquireFileLock(lockPath: string, options: FileLockOptions = {}): FileLockAttempt {
  ensurePrivateStateDirectory(dirname(lockPath));
  return attempt(lockPath, options);
}

/** {@link tryAcquireFileLock} once its folder exists (the waits make the folder once, then poll this). */
function attempt(lockPath: string, options: FileLockOptions): FileLockAttempt {
  const unreadableAfterMs = unreadableBound(options);
  for (let breaks = 0; breaks <= MAX_BREAKS_PER_ATTEMPT; breaks += 1) {
    const taken = publish(lockPath, options.holder ?? null);
    if (taken !== undefined) return { state: "taken", handle: own(lockPath, taken.nonce, taken.acquiredAt) };
    const seen = observe(lockPath);
    if (seen === undefined) continue; // released between the refused link and this read
    const holder = parseContent(seen.text);
    if (holder !== null && isLive(holder)) return { state: "held", holder };
    if (holder === null && seen.ageMs < unreadableAfterMs) return { state: "unreadable" };
    breakJudged(lockPath, seen.text, holder === null ? "unreadable" : "dead", holder, unreadableAfterMs);
  }
  return { state: "contended" };
}

/** This process owns the hold at `lockPath` whose record carries `nonce` (its own acquisition, in this process). */
export function ownsFileLockHold(lockPath: string, nonce: string): boolean {
  return owned.get(lockPath) === nonce;
}

/** Synchronous sleep — Node's built-in main-thread-compatible wait (the lock's waits, and the instrument lock's). */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function timedOut(lockPath: string, timeout: FileLockTimeout, timeoutMs: number): HarnessError {
  const holder = readFileLockHolder(lockPath);
  auditEvent("file-lock-timeout", { lockPath, timeoutMs, holder });
  const named = holder !== null ? ` (held by pid ${String(holder.pid)}${holder.holder === null ? "" : `, ${holder.holder}`}, acquired ${holder.acquiredAt})` : "";
  return timeout(`could not acquire the lock at ${lockPath}${named} within ${String(timeoutMs)}ms`, { lockPath });
}

/**
 * Run `fn` holding the cross-process lock at `lockPath` (created in a private
 * state directory). Synchronous: the wait sleeps between attempts and a wait
 * past the bound throws `timeout(...)`. Re-entrant within one process;
 * released when `fn` returns or throws.
 */
export function withFileLock<T>(lockPath: string, timeout: FileLockTimeout, fn: () => T, options: FileLockOptions = {}): T {
  const depth = depths.get(lockPath);
  if (depth !== undefined) {
    depths.set(lockPath, depth + 1);
    try {
      return fn();
    } finally {
      depths.set(lockPath, depth);
    }
  }
  const { timeoutMs, pollIntervalMs } = { ...ROOT_POLICY.filesystemInfrastructure.fileLock, ...definedOf(options) };
  const deadline = Date.now() + timeoutMs;
  ensurePrivateStateDirectory(dirname(lockPath));
  for (;;) {
    const answer = attempt(lockPath, options);
    if (answer.state === "taken") {
      depths.set(lockPath, 1);
      try {
        return fn();
      } finally {
        depths.delete(lockPath);
        answer.handle.release();
      }
    }
    if (Date.now() >= deadline) throw timedOut(lockPath, timeout, timeoutMs);
    sleepSync(pollIntervalMs);
  }
}

/**
 * Acquire the lock at `lockPath`, waiting asynchronously up to the bound
 * (then `timeout(...)` is thrown). Not re-entrant: a second acquire of a lock
 * this process holds waits for it like any other contender.
 */
export async function acquireFileLock(lockPath: string, timeout: FileLockTimeout, options: FileLockOptions = {}): Promise<FileLockHandle> {
  const { timeoutMs, pollIntervalMs } = { ...ROOT_POLICY.filesystemInfrastructure.fileLock, ...definedOf(options) };
  const deadline = Date.now() + timeoutMs;
  ensurePrivateStateDirectory(dirname(lockPath));
  for (;;) {
    const answer = attempt(lockPath, options);
    if (answer.state === "taken") return answer.handle;
    if (Date.now() >= deadline) throw timedOut(lockPath, timeout, timeoutMs);
    await new Promise((resolveWait) => setTimeout(resolveWait, pollIntervalMs));
  }
}

/** The wait options a caller actually set (an `undefined` never overrides the policy). */
function definedOf(options: FileLockOptions): Partial<Readonly<{ timeoutMs: number; pollIntervalMs: number }>> {
  return {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
  };
}
