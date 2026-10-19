/**
 * THE JOURNALED MULTI-FILE COMMIT — several files replaced together, all or
 * nothing, surviving a crash at any point: the one owner.
 *
 * `atomicWriteFile` makes ONE file's replacement atomic. Some writers must
 * replace several files as one fact — the test inventory and the root
 * policy's pin of it; a candidate's regenerated outputs copied back into the
 * checkout they describe — and a crash between two renames leaves a tree
 * whose files disagree (measured on the copy-back: a SIGKILL at the sixth
 * rename left `root-policy.ts` replaced and `bundle.js` absent, and nothing
 * recovered it). Two such transactions existed, one journaled and one not;
 * this is the one both use.
 *
 * ── THE PROTOCOL ──────────────────────────────────────────────────────────
 *
 * 1. Every target is asked through the checkout write door (a test process
 *    may not commit into the checkout it tests), and an existing journal is
 *    refused: a previous transaction must be recovered first.
 * 2. The JOURNAL is written COMPLETE (a temp file, fsynced) and only then
 *    published under its name, exclusively (`atomicWriteFile` durable +
 *    exclusive: a reader never sees it empty or half-written, a full disk
 *    leaves nothing, an existing journal is refused): each file's base digest
 *    (or absence), next digest, mode and the names of its staged copies —
 *    names DERIVED from the transaction (a journal naming any other file is
 *    unreadable), and the transaction id is the hash of the plan (a garbled
 *    digest no longer matches it). State `pending`.
 * 3. Each file's PREVIOUS bytes (when it exists) and NEXT bytes are staged
 *    beside it (same directory, so the rename is atomic), fsynced, verified.
 * 4. The next copies are renamed over the targets, in order.
 * 5. The bytes are verified, then the caller's `verify` runs (the copy-back's
 *    `harness check`) — the backups are still on disk. A failure rolls every
 *    file back to its base and rethrows.
 * 6. The journal is marked `verified` (atomically AND durably: a failed
 *    fsync is a failed commit), then the staged copies and the journal are
 *    removed.
 *
 * {@link recoverJournaledCommit} finishes an interrupted transaction on the
 * next run: `verified` → the cleanup is completed; `pending` → every file is
 * put back to its base (or removed, when it did not exist), because nothing
 * verified the new state. A target whose bytes are neither its base nor its
 * next is refused: something else wrote it, and no guess is safe. A
 * rollback is ALL OR NOTHING: every backup it needs is verified (present, its
 * base digest) before any file is restored, so a bad backup refuses the whole
 * recovery (`journaled_commit_backup_invalid`) and leaves the tree as it was.
 *
 * ── A LIVE TRANSACTION IS NEVER RECOVERED ─────────────────────────────────
 *
 * The journal names its OWNER (pid + start time). Recovery of a journal whose
 * owner is still running answers `in-progress` and touches nothing: a
 * concurrent run of a tool that recovers first (every candidate-checkout
 * subcommand does) once rolled back a copy-back whose `harness check` was
 * still running, and the copy-back then reported success over the OLD bytes
 * (wf1c-design H-1, reproduced by wf1c-correctness §4). Before marking a
 * transaction verified, the owner re-reads its journal and every target: a
 * journal that is gone or not its own, or a target no longer at its next
 * bytes, is `journaled_commit_preempted` — never a false success.
 *
 * ── CONCURRENT RECOVERERS AND RETRIES (wf1b2-correctness §4.3) ─────────────
 *
 * - The transaction id covers the OWNER (pid + start time) with the plan, so
 *   a retry of the same plan by another process has its own id and its own
 *   staged names: a slow recoverer of the abandoned attempt can never delete
 *   the retry's backups (it did: the retry then failed its verify with no
 *   base left anywhere).
 * - Recovery runs under the journal's lock (`<journal>.lock`, the one file
 *   lock): concurrent recoverers take turns, and the second finds nothing
 *   left to do (it used to report a false `backup_invalid`).
 * - A journal is removed only while it still names the transaction removing
 *   it (compare, then unlink).
 * - A journal that vanished between the listing and the read (its owner
 *   finished) is gone, never `unreadable`.
 * - A `verified` journal is trusted only when every target holds its next
 *   bytes; otherwise recovery refuses (`journaled_commit_verified_mismatch`)
 *   and keeps every staged copy. The renames are made durable (each target
 *   folder fsynced) before `verified` is written.
 *
 * Rollbacks and recoveries are logged (`auditEvent`). Convergent generators
 * (`harness sync`, the README consumers, the pin authorities) write several
 * files too, but a re-run repairs any crash; they stay off this protocol.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

import { HarnessError } from "../kernel/errors.ts";
import { canonicalHash, canonicalJson, sha256 } from "../kernel/integrity.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { schemaId, statePath } from "../kernel/product-identity.ts";
import { auditEvent } from "../shared/debug/debug-system.ts";
import { isProcessIdentityLive, processIdentity } from "../process/process-facts.ts";
import { atomicWriteFile, fsyncDirectory } from "./atomic-write.ts";
import { withFileLock } from "./file-lock.ts";
import { assertCheckoutWriteAllowed } from "./checkout-write-door.ts";
import { ensurePrivateStateDirectory } from "./private-state.ts";
import { identityOverlapIndex, resolveLocation } from "./path-identity.ts";

const JOURNAL_SCHEMA_VERSION = schemaId("journaled-commit", 3);
/** A transaction id: the leading hex digits of the canonical hash of its plan. */
const TRANSACTION_ID_HEX_DIGITS = 16;
const PRIVATE_FILE_MODE = ROOT_POLICY.filesystemInfrastructure.privateState.fileMode;
const DIGEST = z.string().regex(/^[0-9a-f]{64}$/u);

const JOURNAL_SCHEMA = z.strictObject({
  schemaVersion: z.literal(JOURNAL_SCHEMA_VERSION),
  transactionId: z.string().length(TRANSACTION_ID_HEX_DIGITS).regex(/^[0-9a-f]+$/u),
  owner: z.strictObject({ pid: z.number().int().positive(), startTime: z.number().int().nonnegative().nullable() }),
  state: z.enum(["pending", "verified"]),
  files: z.array(z.strictObject({
    path: z.string().min(1),
    baseSha256: DIGEST.nullable(),
    nextSha256: DIGEST,
    mode: z.number().int().nonnegative(),
    /** The base's permission bits (recorded, never read back from the backup's own mode: a planted setuid copy restored setuid). */
    baseMode: z.number().int().min(0).max(0o7777).nullable(),
    previousPath: z.string().min(1).nullable(),
    nextPath: z.string().min(1),
  })).min(1),
});

type Journal = z.infer<typeof JOURNAL_SCHEMA>;

/** One file of a transaction: its root-relative path (`/`-separated), its next bytes and the mode it must hold. */
export type JournaledFile = Readonly<{ path: string; bytes: Uint8Array; mode: number }>;

export type JournaledCommitOptions = Readonly<{
  /** Called at each phase: `journal-written`, `staged`, `committed:<path>`, `verified`. */
  onPhase?: (phase: string) => void;
  /** Runs after the renames with the backups still on disk; a throw rolls the transaction back. */
  verify?: () => void;
}>;

/**
 * Where the journal named `name` lives under `root`: the one journal home,
 * `<root>/.bridlewise/state/journals/<name>.json` — git-ignored with the rest
 * of the state root, so a crash's journal is never staged, snapshotted or
 * committed, and `harness check` can list what is pending.
 */
export function journalPathFor(root: string, name: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(name)) throw failure(`journal name must be a lowercase slug: ${name}`);
  return join(resolve(root), statePath("state", "journals"), `${name}.json`);
}

/**
 * Every journal present under `root`, with what it needs: `in-progress` (its
 * owner is running), `abandoned` (its owner is gone: the next run of the
 * owning tool must recover it) or `unreadable` (a garbled journal: by hand).
 * `harness check` fails on anything but `in-progress`.
 */
export function journalsUnder(root: string): readonly Readonly<{ name: string; state: "in-progress" | "abandoned" | "unreadable" }>[] {
  const directory = join(resolve(root), statePath("state", "journals"));
  if (!existsSync(directory)) return [];
  type Listed = Readonly<{ name: string; state: "in-progress" | "abandoned" | "unreadable" }>;
  return readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort().flatMap((entry): Listed[] => {
    const name = entry.slice(0, -".json".length);
    let journal: Journal | undefined;
    try {
      journal = readJournal(join(directory, entry));
    } catch {
      // readJournal's typed refusal IS the answer here: the journal cannot be read.
      return [{ name, state: "unreadable" }];
    }
    // Gone since the listing (its owner finished): not a journal any more.
    if (journal === undefined) return [];
    return [{ name, state: isProcessIdentityLive(journal.owner) ? "in-progress" : "abandoned" }];
  });
}

function failure(message: string): HarnessError {
  return new HarnessError(message, "journaled_commit_failed");
}

function absoluteIn(root: string, path: string): string {
  const absolute = resolve(root, path);
  // Strictly INSIDE the root, by identity (a link or a bind mount is where it points).
  const inside = !isAbsolute(path) && relative(root, absolute).length > 0
    && identityOverlapIndex().atOrUnder(resolveLocation(absolute, "a journaled commit path"), resolveLocation(root, "a journaled commit root"));
  if (!inside) throw failure(`journaled commit path escapes its root: ${path}`);
  return absolute;
}

/**
 * Written complete, fsynced, then published under `path` only if nothing is
 * there (the one atomic writer: `durable` + `exclusive`, exact mode): a
 * staged copy or a journal that already exists is a transaction nobody
 * recovered, a failed fsync is the transaction's failure, and a failed write
 * leaves nothing behind.
 */
function writeExclusiveDurably(path: string, bytes: Uint8Array, mode: number): void {
  const written = atomicWriteFile(path, bytes, { exactMode: mode, exclusive: true, durable: true, createParentDirectories: false });
  if (!written.success) throw failure(`could not write ${path}: ${written.reason ?? "unknown"}`);
}

/** The bytes' digest at `path`, `null` when absent; a path that is not a readable file is a typed refusal (never a raw EISDIR/EACCES). */
function digestOf(path: string): string | null {
  try {
    return sha256(readFileSync(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new HarnessError(`${path} cannot be read as a file (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}); resolve it by hand`, "journaled_commit_target_unreadable");
  }
}

function stagedName(path: string, transactionId: string, kind: "previous" | "next"): string {
  return join(dirname(path), `.${basename(path)}.${transactionId}.${kind}`).split(sep).join("/");
}

/**
 * The journal; `undefined` when there is none (it may vanish between a
 * listing and this read: its owner finished); the typed refusal naming it
 * otherwise (a garbled journal is never a raw SyntaxError).
 */
function readJournal(journalPath: string): Journal | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(journalPath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new HarnessError(`the journal at ${journalPath} cannot be read (${(error as Error).message}); inspect the files it names, then remove it`, "journaled_commit_journal_unreadable");
  }
  const journal = JOURNAL_SCHEMA.safeParse(parsed);
  if (!journal.success || !selfConsistent(journal.data)) {
    throw new HarnessError(`the journal at ${journalPath} is not an intact ${JOURNAL_SCHEMA_VERSION} journal; inspect the files it names, then remove it`, "journaled_commit_journal_unreadable");
  }
  return journal.data;
}

/**
 * The transaction id of an attempt: the leading hex digits of the canonical
 * hash of its OWNER and its plan — a retry of the same plan by another
 * process is another transaction, with its own staged names (see the header).
 */
function transactionIdOf(owner: Journal["owner"], files: readonly Readonly<{ path: string; baseSha256: string | null; nextSha256: string }>[]): string {
  return canonicalHash({ owner: { pid: owner.pid, startTime: owner.startTime }, files: files.map(({ path, baseSha256, nextSha256 }) => ({ path, baseSha256, nextSha256 })) }).slice(0, TRANSACTION_ID_HEX_DIGITS);
}

/**
 * A journal describes ITS OWN transaction: the id is the hash of its owner
 * and plan (a flipped digest or a garbled owner no longer matches), and every staged name is the one
 * derived from the path and the id (a garbled name could point recovery at
 * an unrelated file, to read as a backup or to delete in the cleanup).
 */
function selfConsistent(journal: Journal): boolean {
  return transactionIdOf(journal.owner, journal.files) === journal.transactionId && journal.files.every((file) =>
    file.nextPath === stagedName(file.path, journal.transactionId, "next") &&
    file.previousPath === (file.baseSha256 === null ? null : stagedName(file.path, journal.transactionId, "previous")) &&
    (file.baseMode === null) === (file.baseSha256 === null));
}

function cleanup(root: string, journalPath: string, journal: Journal): void {
  for (const file of journal.files) {
    if (file.previousPath !== null) rmSync(absoluteIn(root, file.previousPath), { force: true });
    rmSync(absoluteIn(root, file.nextPath), { force: true });
  }
  // Only while the journal still names THIS transaction (a retry's is never removed).
  let current: Journal | undefined;
  try {
    current = readJournal(journalPath);
  } catch {
    // Unreadable now: not provably ours, so it is left for the operator.
    return;
  }
  if (current?.transactionId === journal.transactionId) rmSync(journalPath, { force: true });
}

/** The journal's own lock: recoverers of one journal take turns (the one file lock). */
function journalLockPath(journalPath: string): string {
  return `${journalPath}.lock`;
}

/**
 * Puts back every file that holds its NEXT bytes: to its base (from its
 * staged previous copy), or removed when it had none. A file still at its
 * base — or changed by someone else — is not touched.
 */
function rollBack(root: string, journal: Journal): void {
  const toRestore = journal.files.toReversed().filter((file) =>
    file.nextSha256 !== file.baseSha256 && digestOf(absoluteIn(root, file.path)) === file.nextSha256);
  // ALL OR NOTHING: every backup is verified before any file is touched, so a
  // missing or wrong backup refuses the recovery with the tree as it was —
  // never a tree with some files at their base and the rest at their next.
  const backups = new Map<string, Readonly<{ bytes: Buffer; mode: number }>>();
  for (const file of toRestore) {
    if (file.baseSha256 === null) continue;
    const previousPath = absoluteIn(root, file.previousPath!);
    let bytes: Buffer | undefined;
    let unreadable: string | undefined;
    try {
      bytes = readFileSync(previousPath);
    } catch (error) {
      // Missing, a directory, unreadable: not a backup of the base either way (the reason is named).
      unreadable = (error as NodeJS.ErrnoException).code ?? (error as Error).message;
    }
    if (bytes === undefined || sha256(bytes) !== file.baseSha256 || file.baseMode === null) {
      throw new HarnessError(
        `the backup of ${file.path} (${file.previousPath!}) is ${unreadable === undefined ? "not its base" : `missing or unreadable (${unreadable})`}; nothing was rolled back — restore it by hand, then remove the journal`,
        "journaled_commit_backup_invalid",
      );
    }
    // The base's mode as the journal recorded it (permission bits only).
    backups.set(file.path, { bytes, mode: file.baseMode });
  }
  for (const file of toRestore) {
    const target = absoluteIn(root, file.path);
    const backup = backups.get(file.path);
    if (backup === undefined) {
      rmSync(target, { force: true });
      continue;
    }
    const restored = atomicWriteFile(target, backup.bytes, { exactMode: backup.mode, durable: true });
    if (!restored.success) throw failure(`journaled commit could not restore ${file.path}: ${restored.reason ?? "unknown"}`);
  }
}

/**
 * Replaces `files` under `root` as one transaction journaled under the name
 * `journal` ({@link journalPathFor}; see the header). Throws
 * `journaled_commit_failed` (or the caller's own `verify` error) after rolling
 * back; a crash leaves the journal for {@link recoverJournaledCommit}.
 */
export function commitJournaled(root: string, journal: string, files: readonly JournaledFile[], options: JournaledCommitOptions = {}): void {
  const canonicalRoot = resolve(root);
  const journalPath = journalPathFor(canonicalRoot, journal);
  const onPhase = options.onPhase ?? (() => undefined);
  const targets = files.map((file) => absoluteIn(canonicalRoot, file.path));
  for (const target of targets) assertCheckoutWriteAllowed(target);
  if (existsSync(journalPath)) throw failure(`a journaled transaction already exists at ${journalPath}; recover it first`);
  const planned = files.map((file, index) => ({ file, target: targets[index]!, baseSha256: digestOf(targets[index]!), nextSha256: sha256(file.bytes) }));
  const owner = { ...processIdentity() };
  const transactionId = transactionIdOf(owner, planned.map(({ file, baseSha256, nextSha256 }) => ({ path: file.path, baseSha256, nextSha256 })));
  const record: Journal = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    transactionId,
    owner,
    state: "pending",
    files: planned.map(({ file, target, baseSha256, nextSha256 }) => ({
      path: file.path,
      baseSha256,
      nextSha256,
      mode: file.mode,
      // The whole permission word, setgid/setuid/sticky included: a rollback restores the file as it was (WF-1b3b design LOW 7).
      baseMode: baseSha256 === null ? null : statSync(target).mode & 0o7777,
      previousPath: baseSha256 === null ? null : stagedName(file.path, transactionId, "previous"),
      nextPath: stagedName(file.path, transactionId, "next"),
    })),
  };
  ensurePrivateStateDirectory(dirname(journalPath));
  writeExclusiveDurably(journalPath, Buffer.from(`${canonicalJson(record)}\n`, "utf8"), PRIVATE_FILE_MODE);
  onPhase("journal-written");
  try {
    for (const [index, { file, target }] of planned.entries()) {
      const entry = record.files[index]!;
      mkdirSync(dirname(target), { recursive: true });
      if (entry.previousPath !== null) {
        const base = readFileSync(target);
        if (sha256(base) !== entry.baseSha256) throw failure(`${file.path} changed after the transaction was planned`);
        writeExclusiveDurably(absoluteIn(canonicalRoot, entry.previousPath), base, entry.baseMode!);
      }
      writeExclusiveDurably(absoluteIn(canonicalRoot, entry.nextPath), file.bytes, file.mode);
      if (digestOf(absoluteIn(canonicalRoot, entry.nextPath)) !== entry.nextSha256) throw failure(`the staged copy of ${file.path} did not verify`);
    }
    onPhase("staged");
    for (const [index, { file, target }] of planned.entries()) {
      renameSync(absoluteIn(canonicalRoot, record.files[index]!.nextPath), target);
      onPhase(`committed:${file.path}`);
    }
    // The renames are durable before anything can be marked verified: a
    // power cut must not keep `verified` and lose a rename (a mixed tree
    // recovery would then declare committed).
    for (const folder of new Set(targets.map((target) => dirname(target)))) fsyncDirectory(folder);
    for (const { file, target, nextSha256 } of planned) {
      if (digestOf(target) !== nextSha256) throw failure(`${file.path} did not verify after the commit`);
    }
    options.verify?.();
  } catch (error) {
    try {
      rollBack(canonicalRoot, record);
      cleanup(canonicalRoot, journalPath, record);
    } catch (rollbackError) {
      throw failure(`${(error as Error).message}; the rollback failed too (${(rollbackError as Error).message}) — the journal at ${journalPath} is kept for recovery`);
    }
    auditEvent("journaled-commit-rolled-back", { transactionId, paths: files.map((file) => file.path), reason: (error as Error).message });
    throw error;
  }
  assertStillOwned(canonicalRoot, journalPath, record);
  const verified = atomicWriteFile(journalPath, `${canonicalJson({ ...record, state: "verified" })}\n`, { exactMode: PRIVATE_FILE_MODE, durable: true });
  if (!verified.success) throw failure(`could not mark the transaction verified: ${verified.reason ?? "unknown"}`);
  onPhase("verified");
  cleanup(canonicalRoot, journalPath, record);
}

/**
 * The owner's last look before `verified`: its own journal is still there,
 * still pending, and every target still holds its next bytes. Anything else
 * means another run recovered (rolled back) this transaction meanwhile.
 */
function assertStillOwned(root: string, journalPath: string, journal: Journal): void {
  const current = readJournal(journalPath);
  const lost = current === undefined || current.transactionId !== journal.transactionId || current.state !== "pending"
    || current.owner.pid !== journal.owner.pid || current.owner.startTime !== journal.owner.startTime;
  const moved = journal.files.filter((file) => digestOf(absoluteIn(root, file.path)) !== file.nextSha256).map((file) => file.path);
  if (lost || moved.length > 0) {
    throw new HarnessError(
      `the transaction ${journal.transactionId} was preempted before it could be marked verified ` +
        `(${lost ? "its journal was recovered by another run" : `no longer at their new bytes: ${moved.join(", ")}`}); nothing is claimed written`,
      "journaled_commit_preempted",
    );
  }
}

/** What {@link recoverJournaledCommit} did. `in-progress`: the journal's owner is still running; nothing was touched. */
export type JournalRecovery = "none" | "committed" | "rolled-back" | "in-progress";

/**
 * Finishes a transaction a crash interrupted (see the header): `none` when
 * there is no journal, `in-progress` when its owner is still running
 * (untouched), `committed` for a verified one, `rolled-back` for a pending
 * one. Refuses a target whose bytes are neither its base nor its next.
 */
export function recoverJournaledCommit(root: string, name: string): JournalRecovery {
  const canonicalRoot = resolve(root);
  const journalPath = journalPathFor(canonicalRoot, name);
  if (readJournal(journalPath) === undefined) return "none";
  return withFileLock(journalLockPath(journalPath), (message) => new HarnessError(message, "journaled_commit_recovery_busy"), () => recoverUnderLock(canonicalRoot, journalPath));
}

/** {@link recoverJournaledCommit} holding the journal's lock: the journal is re-read here, never trusted from before the lock. */
function recoverUnderLock(canonicalRoot: string, journalPath: string): JournalRecovery {
  const journal = readJournal(journalPath);
  if (journal === undefined) return "none";
  if (isProcessIdentityLive(journal.owner)) return "in-progress";
  if (journal.state === "verified") {
    // Trusted only when every target holds its next bytes: a garbled state or
    // a lost rename must not delete the only copies of the base.
    const unverified = journal.files.filter((file) => digestOf(absoluteIn(canonicalRoot, file.path)) !== file.nextSha256).map((file) => file.path);
    if (unverified.length > 0) {
      throw new HarnessError(
        `the journal at ${journalPath} says verified, but ${unverified.join(", ")} ${unverified.length === 1 ? "does" : "do"} not hold the new bytes; every staged copy is kept — restore by hand, then remove the journal`,
        "journaled_commit_verified_mismatch",
      );
    }
    cleanup(canonicalRoot, journalPath, journal);
    auditEvent("journaled-commit-recovered", { transactionId: journal.transactionId, outcome: "committed", paths: journal.files.map((file) => file.path) });
    return "committed";
  }
  for (const file of journal.files) {
    const current = digestOf(absoluteIn(canonicalRoot, file.path));
    if (current !== file.baseSha256 && current !== file.nextSha256) {
      throw failure(`${file.path} holds bytes that are neither its base nor its next (${relative(canonicalRoot, journalPath)}); resolve it by hand`);
    }
  }
  rollBack(canonicalRoot, journal);
  cleanup(canonicalRoot, journalPath, journal);
  auditEvent("journaled-commit-recovered", { transactionId: journal.transactionId, outcome: "rolled-back", paths: journal.files.map((file) => file.path) });
  return "rolled-back";
}

/** One line for the journals under `roots` (the `workspaceGit.journals` signal's words). */
export function journalsSummary(roots: readonly string[]): string {
  const journals = [...new Set(roots.map((root) => resolve(root)))].flatMap((root) => journalsUnder(root));
  return journals.length === 0 ? "none" : journals.map((journal) => `${journal.name}: ${journal.state}`).join(", ");
}
