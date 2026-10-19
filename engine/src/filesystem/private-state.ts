import { guarded } from "../process/fault-policy.ts";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { randomBytes, sha256 } from "../kernel/integrity.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { isProcessIdentityLive, processIdentity, type ProcessIdentity } from "../process/process-facts.ts";
import { auditEvent } from "../shared/debug/debug-system.ts";

/**
 * THE PRIVATE-STATE MODES AND THE ONE STATE-DIRECTORY CREATOR.
 *
 * Harness state (receipts, locks, the timeline database, key stores, run
 * history, workspace records, task logs) is private to the account that runs
 * the harness, and the immutable receipt owner REFUSES a parent chain that is
 * not (`receipt_parent_unsafe`). A state directory created at the umask's
 * default (0775) was measured on a fresh checkout: whichever writer ran first
 * decided the mode of the whole chain, and seven writers each created their
 * own. So every state-root creator calls {@link ensurePrivateStateDirectory},
 * and the modes come from the one policy value — no module spells them.
 *
 * Only STATE is private. A generic writer (the atomic writer, the editor's
 * create path) never chooses a directory mode: a directory it creates inside a
 * user's project keeps the ordinary umask mode git would give it.
 */
export const PRIVATE_STATE_DIRECTORY_MODE = ROOT_POLICY.filesystemInfrastructure.privateState.directoryMode;
export const PRIVATE_STATE_FILE_MODE = ROOT_POLICY.filesystemInfrastructure.privateState.fileMode;

/**
 * Creates `path` and every missing ancestor at the private-state mode, and
 * returns `path`. Existing directories are never re-permissioned (an operator's
 * deliberate mode is theirs; the receipt owner judges the chain it needs).
 */
export function ensurePrivateStateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: PRIVATE_STATE_DIRECTORY_MODE });
  return path;
}

/**
 * OWNED TEMPORARIES — THE ONE NAMING AND OWNER-LIVENESS RULE for every file
 * or directory a process leaves beside shared state while it works: the
 * atomic writer's temp file, the durable filesystem's and the immutable
 * receipts' pending files, the persisted key's stage, the commit guard's
 * staged-tree materializations, the snapshot's private index and staging
 * object directories, the guardian's per-spawn and probe directories. Each
 * name carries its OWNER — `<pid>-<start time>` — and a nonce of
 * `ROOT_POLICY.filesystemInfrastructure.privateState.temporaryRandomBytes`
 * (the policy's one size). A process killed mid-run (Ctrl-C, a closed
 * terminal, the OOM killer) never reaches its `finally`; what a DEAD owner
 * left can be told from a live one's (a concurrent run), and the start time
 * makes a recycled pid a different owner. What a sweep removes is an audit
 * event. Two forms:
 *
 * - {@link ownedTemporaryName}: `<prefix><pid>-<start>-<nonce>` (a per-run
 *   entry of its own, swept by prefix with {@link sweepAbandonedTemporaries});
 * - {@link ownedSiblingTemporaryName}: `.<target>.<kind>-<pid>-<start>-<nonce>.tmp`
 *   (a hidden file BESIDE the target it is published over, by rename or link:
 *   the atomic writer's, the durable filesystem's and the receipts' pending
 *   files), swept by {@link sweepAbandonedSiblingTemporaries}.
 *
 * {@link ownedTemporaryOwnerOf} is the one parse of both forms (a lister
 * tells an owned temporary, and its live or dead owner, from a real entry).
 */
export function ownedTemporaryName(prefix: string): string {
  const owner = processIdentity();
  return `${prefix}${String(owner.pid)}-${String(owner.startTime ?? 0)}-${randomBytes(TEMPORARY_NONCE_BYTES).toString("hex")}`;
}

const TEMPORARY_NONCE_BYTES = ROOT_POLICY.filesystemInfrastructure.privateState.temporaryRandomBytes;

/** How many hex characters of a target's digest name a sibling temporary whose target is too long to spell. */
const TARGET_DIGEST_HEX_DIGITS = 32;

/**
 * The hidden owned temporary beside `target` (one path segment) for a
 * publication of kind `kind`. A target whose temporary name would pass the
 * filesystem's `NAME_MAX` is named by a digest of the target instead (a long
 * target used to make every write to it fail: wf1b2-design T-L8).
 */
export function ownedSiblingTemporaryName(target: string, kind: string): string {
  const owned = ownedTemporaryName(`${kind}-`);
  const name = `.${target}.${owned}.tmp`;
  return Buffer.byteLength(name) <= ROOT_POLICY.filesystemInfrastructure.fileNameLimitBytes ? name : `.${sha256(target).slice(0, TARGET_DIGEST_HEX_DIGITS)}.${owned}.tmp`;
}

/** Whether `name` is an {@link ownedSiblingTemporaryName} of `kind` (for any target). */
export function isOwnedSiblingTemporary(name: string, kind: string): boolean {
  return ownedTemporaryOwnerOf(name)?.kind === kind;
}

const OWNER_FIELDS = `(\\d+)-(\\d+)-[0-9a-f]{${String(TEMPORARY_NONCE_BYTES * 2)}}`;
const OWNED_SIBLING = new RegExp(`^\\..+\\.([A-Za-z][\\w]*(?:-[A-Za-z][\\w]*)*)-${OWNER_FIELDS}\\.tmp$`, "u");
const OWNED_PER_RUN = new RegExp(`^[\\w.-]+?-${OWNER_FIELDS}$`, "u");

/**
 * THE ONE PARSE of an owned temporary's name (either form): its owner (pid
 * and start time; `null` start time when unknown) and, for a sibling, its
 * kind — or `undefined` for a name that is not an owned temporary.
 */
export function ownedTemporaryOwnerOf(name: string): (ProcessIdentity & Readonly<{ kind: string | null }>) | undefined {
  const sibling = OWNED_SIBLING.exec(name);
  const match = sibling === null ? OWNED_PER_RUN.exec(name) : null;
  const pid = sibling?.[2] ?? match?.[1];
  const start = sibling?.[3] ?? match?.[2];
  if (pid === undefined || start === undefined) return undefined;
  return Object.freeze({ pid: Number(pid), startTime: Number(start) === 0 ? null : Number(start), kind: sibling?.[1] ?? null });
}

/** Whether `name` is an owned temporary (either form) whose owner still runs (a concurrent writer's, never swept). */
export function isOwnedTemporaryLive(name: string): boolean {
  const owner = ownedTemporaryOwnerOf(name);
  return owner !== undefined && isProcessIdentityLive(owner);
}

function escapeForPattern(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}

/** The owned temporary directories this process created and has not removed; each is removed when the process exits. */
const LIVE_OWNED_DIRECTORIES = new Set<string>();
let exitRemovalArmed = false;

function removeLiveOwnedDirectories(): void {
  for (const directory of LIVE_OWNED_DIRECTORIES) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      // Reported, never fatal: the next creation under its parent sweeps it (its owner is dead by then).
      auditEvent("owned-temporary-unremovable", { directory, code: error instanceof Error && "code" in error ? String(error.code) : "unknown" });
    }
  }
  LIVE_OWNED_DIRECTORIES.clear();
}

/**
 * A private directory under `parent` named by {@link ownedTemporaryName}
 * (created exclusively, at the private-state mode), after removing what dead
 * owners left there under the same prefix. The one replacement for
 * `mkdtemp`, whose random names say nothing about who owns them (a killed
 * process's directories stayed forever: 164 guardian spawn directories were
 * found in /tmp).
 *
 * IT DIES WITH ITS PROCESS: a directory nobody removed (a caller that forgot
 * to release it, a test that returned early) is removed when the process
 * exits; one the process could not remove because it was KILLED is swept by
 * the next creation under the same parent, its owner being dead. Remove one
 * earlier with {@link removeOwnedTemporaryDirectory}.
 */
export function createOwnedTemporaryDirectory(parent: string, prefix: string): string {
  sweepAbandonedTemporaries(parent, prefix);
  const directory = join(parent, ownedTemporaryName(prefix));
  mkdirSync(directory, { mode: PRIVATE_STATE_DIRECTORY_MODE });
  if (!exitRemovalArmed) {
    exitRemovalArmed = true;
    process.once("exit", guarded("filesystem.owned-temporaries.exit-removal", removeLiveOwnedDirectories));
  }
  LIVE_OWNED_DIRECTORIES.add(directory);
  return directory;
}

/** Removes an {@link createOwnedTemporaryDirectory} directory now (idempotent). */
export function removeOwnedTemporaryDirectory(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
  LIVE_OWNED_DIRECTORIES.delete(directory);
}

/**
 * The entries of `parent` named by {@link ownedTemporaryName} with `prefix`
 * whose owner is no longer running; with no prefix, every owned name there
 * (any prefix, told apart by the owner fields and the policy-sized nonce) — the
 * sweep a test runner makes of its temp root when a run ends, since a test
 * worker ended by a signal runs no exit hook.
 */
export function abandonedTemporaries(parent: string, prefix?: string): readonly string[] {
  let entries: readonly string[];
  try {
    entries = readdirSync(parent);
  } catch {
    // No parent yet: nothing was ever left there.
    return [];
  }
  const prefixed = prefix === undefined ? undefined : new RegExp(`^${escapeForPattern(prefix)}(\\d+)-(\\d+)-[0-9a-f]+$`, "u");
  return entries.filter((entry) => {
    if (prefixed === undefined) {
      const owner = ownedTemporaryOwnerOf(entry);
      return owner !== undefined && owner.kind === null && !isProcessIdentityLive(owner);
    }
    const match = prefixed.exec(entry);
    if (match === null) return false;
    const startTime = Number(match[2]);
    return !isProcessIdentityLive({ pid: Number(match[1]), startTime: startTime === 0 ? null : startTime });
  });
}

/**
 * The {@link ownedSiblingTemporaryName} entries of `directory` whose owner no
 * longer runs (a writer killed between its temp and its publish) — of one
 * `kind` when given (each owner sweeps only its own kind), of any otherwise.
 */
export function abandonedSiblingTemporaries(directory: string, kind?: string): readonly string[] {
  let entries: readonly string[];
  try {
    entries = readdirSync(directory);
  } catch {
    // No directory: nothing was left there.
    return [];
  }
  return entries.filter((entry) => {
    const owner = ownedTemporaryOwnerOf(entry);
    return owner !== undefined && owner.kind !== null && (kind === undefined || owner.kind === kind) && !isProcessIdentityLive(owner);
  });
}

/** The (kind, directory) pairs this process has already swept of abandoned siblings (a writer sweeps each ONCE per process). */
const SIBLING_SWEPT = new Set<string>();

/**
 * Removes the abandoned siblings OF `kind` ({@link abandonedSiblingTemporaries})
 * in `directory` the first time a writer of that kind in this process
 * publishes there (later writes cost nothing), never failing the writer: a
 * crashed writer's temporary no longer stays beside its target forever
 * (wf1b2-design T-M1). A live writer's temporary is never touched, and
 * another owner's kind never is either (WF-1b3b design LOW 5: the atomic
 * writer swept the receipts' `pending` files, erasing the
 * `orphan-publication-temporary` evidence their own scan reports).
 */
export function sweepAbandonedSiblingTemporaries(directory: string, kind: string): readonly string[] {
  const key = `${kind}\0${directory}`;
  if (SIBLING_SWEPT.has(key)) return [];
  SIBLING_SWEPT.add(key);
  return removeAbandoned(directory, abandonedSiblingTemporaries(directory, kind));
}

/**
 * Removes {@link abandonedTemporaries} (logged) and returns the names it
 * removed. A SWEEP NEVER FAILS ITS CALLER: an entry it cannot remove (a
 * subtree made unwritable, another user's, a disappearing mount) is skipped
 * and reported once per sweep — one unremovable leftover used to turn every
 * later creation into a refusal (wf1b2-design T-H1: every confined spawn
 * refused after a `chmod 500` subtree in `/tmp`).
 */
export function sweepAbandonedTemporaries(parent: string, prefix?: string): readonly string[] {
  return removeAbandoned(parent, abandonedTemporaries(parent, prefix));
}

function removeAbandoned(parent: string, abandoned: readonly string[]): readonly string[] {
  const removed: string[] = [];
  const kept: string[] = [];
  for (const entry of abandoned) {
    try {
      rmSync(join(parent, entry), { recursive: true, force: true });
      removed.push(entry);
    } catch (error) {
      // Skipped, never fatal, and reported below with WHY (the error's code).
      kept.push(`${entry} (${error instanceof Error && "code" in error ? String(error.code) : "unknown"})`);
    }
  }
  if (removed.length > 0) auditEvent("abandoned-temporaries-swept", { parent, removed });
  if (kept.length > 0) auditEvent("abandoned-temporaries-unremovable", { parent, kept });
  return removed;
}
