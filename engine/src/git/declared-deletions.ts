/**
 * DECLARED DELETIONS — a deliberate deletion is a recorded act, so the
 * move-loss check never has to choose between refusing it and destroying a
 * copy that was kept on purpose.
 *
 * The commit guard's move-loss check (`engine/scripts/verification/
 * staged-move-loss.ts`) refuses a staged deletion whose exact bytes sit at a
 * path git ignores: the signature of a plain `mv` into an ignored folder plus
 * `git add -A`. A DELIBERATE deletion carries the same signature whenever an
 * ignored copy of the file exists for another reason (a `.bkp/` backup, a
 * frozen evidence snapshot, a leaked test fixture), and the check's only other
 * way out, "remove the copy on disk first", destroys the copy. Measured before
 * the step-6 commit: 83 deliberate deletions, 11 kept copies of 4 of them.
 *
 * A declaration says "this exact blob at this exact path is deleted on
 * purpose, and these are its ignored copies". It is made BEFORE the commit and
 * judged BY the commit:
 *
 * - {@link declareDeletions} (`harness deletions declare <path>…`) records, for
 *   each path, the blob HEAD holds there, HEAD itself, how many times HEAD had
 *   moved (the HEAD reflog's length), and the IGNORED COPIES of that blob on
 *   disk (`ignored-copies.ts`, the guard's own pairing), in the checkout's OWN
 *   git directory (`git rev-parse --git-path`; a linked worktree has its own,
 *   so a declaration never reaches another checkout, and it is never staged or
 *   committed). Each path is literal and exact. HEAD must hold a FILE at
 *   exactly that path: a folder is refused, never expanded, and nothing is a
 *   pattern. The file must already be GONE FROM THE DISK: nothing may be at
 *   the path, so a declaration names a deletion that happened, not one that
 *   may happen later.
 * - {@link judgeDeclaration} (the commit guard, and only for a deletion the
 *   move-loss check would refuse) accepts a staged deletion only when a
 *   declaration names the SAME path with the SAME blob, HEAD has not moved
 *   since (the same commit AND the same number of HEAD moves: a
 *   `reset --soft` back to the declared commit is still a move), the path is
 *   STILL absent from the disk, every ignored copy the commit finds is one the
 *   declaration recorded, and the record lives in the git directory being
 *   committed. Otherwise the refusal says which one failed: undeclared,
 *   mismatched (the declared blob is not the one being deleted), stale (HEAD
 *   moved since), expired (the path is on disk again), copies changed (a copy
 *   nobody declared: the file came back and was moved again, or a copy was
 *   made since) or foreign (the record was made for another git directory).
 *   Together, "still absent" and "the same copies" close the path a
 *   declaration used to leave open: declare, restore the file, and a later
 *   accidental move of it was accepted (wf-del-verify V1).
 * - {@link consumeDeclaredDeletions} (the `post-commit` hook) removes every
 *   declaration whose path HEAD no longer holds (the deletion landed) and every
 *   one whose path is back on disk (expired). The record is deleted when
 *   nothing is left. A declaration the commit did not use is kept, stale for
 *   good: HEAD has moved, and no later HEAD can make it pending again.
 * - {@link clearDeclaredDeletions} (`harness deletions clear`) withdraws every
 *   declaration.
 *
 * ONE WRITER AT A TIME. Every change to the record (declare, consume, clear)
 * is a read-modify-write under the one cross-process file lock
 * (`src/filesystem/file-lock.ts`, `<record>.lock` beside it): 12 parallel
 * declares used to report success and record 7, and a declare racing a
 * `clear` wrote back entries the clear had reported withdrawn (V3). Readers
 * (the guard, `status`) take no lock: the record is published atomically.
 *
 * NOT A BYPASS. There is no wildcard, no folder, no "everything staged", no
 * environment switch and no commit flag. The record lives outside the tree and
 * outside the index. Every declaration, acceptance, refusal, consumption and
 * expiry is an audit event through central logging. The record's digest checks
 * for a torn file (`checkout-state-record.ts`); it is not a MAC. An edit that
 * recomputes it is still judged like any declaration: its blob, its HEAD and
 * its copies must match the deletion being committed.
 *
 * ONE LIMIT, STATED. The move count is the HEAD reflog's length, so it is only
 * as honest as the reflog: deleting the entries added since a declaration
 * (`git reflog delete`) brings the count back and a stale declaration reads
 * pending again (wf-del2-correctness NEW-10). What it then covers is still
 * only the exact declared state — the same HEAD, blob, absence and copies —
 * so nothing the declaration did not describe is ever accepted.
 */
import { lstatSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { withFileLock } from "../filesystem/file-lock.ts";
import { HarnessError, InputError } from "../kernel/errors.ts";
import { PRODUCT_NAME, schemaId } from "../kernel/product-identity.ts";
import { auditEvent } from "../shared/debug/debug-system.ts";
import { readCheckoutStateRecord, writeCheckoutStateRecord } from "./checkout-state-record.ts";
import { GIT_OBJECT_NAME } from "./git-port.ts";
import { blobSizes, ignoredCopies } from "./ignored-copies.ts";
import { gitPath, headCommit, headMoves, headVersions, requiredRepositoryToplevel, type GitEnvironment } from "./repository-ownership.ts";

const RECORD_SCHEMA_VERSION = schemaId("declared-deletions", 2);
/** Where the record lives, relative to the checkout's own git directory (`git rev-parse --git-path`). */
const RECORD_GIT_PATH = `${PRODUCT_NAME}/declared-deletions.json`;
const OBJECT_NAME = z.string().regex(GIT_OBJECT_NAME);

const ENTRY_SCHEMA = z.strictObject({
  /** Repository-relative path, exactly as git spells it. */
  path: z.string().min(1),
  /** The blob HEAD held at `path` when it was declared. */
  blob: OBJECT_NAME,
  /** The commit HEAD named when it was declared. */
  head: OBJECT_NAME,
  /** How many times HEAD had moved (the HEAD reflog's length) when it was declared. */
  moves: z.number().int().positive(),
  /** The ignored paths holding the blob's exact bytes when it was declared (sorted). */
  copies: z.array(z.string().min(1)),
});

const RECORD_SCHEMA = z.strictObject({
  schemaVersion: z.literal(RECORD_SCHEMA_VERSION),
  /** The git directory the record was made for (absolute). */
  gitDirectory: z.string().min(1),
  entriesDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  entries: z.array(ENTRY_SCHEMA),
});

/** One declared deletion. */
export type DeclaredDeletion = z.infer<typeof ENTRY_SCHEMA>;
type DeclarationRecord = z.infer<typeof RECORD_SCHEMA>;

/** The engine CLI verbs, as data (the refusals print them). */
export const DECLARE_DELETIONS_VERB = Object.freeze(["harness", "deletions", "declare"] as const);
export const CLEAR_DECLARED_DELETIONS_VERB = Object.freeze(["harness", "deletions", "clear"] as const);

/**
 * What a declaration is worth now. `pending`: it accepts the deletion it
 * names (when the commit's copies are its own). `mismatched`: HEAD's blob at
 * the path is not the declared one. `stale`: HEAD moved since it was
 * declared (for good). `expired`: something is on disk at the path again.
 * `consumed`: HEAD no longer holds the path (the deletion landed).
 */
export type DeclarationState = "pending" | "mismatched" | "stale" | "expired" | "consumed";

/** The commit guard's answer for one staged deletion: accepted only when `declared`. */
export type DeclarationVerdict = "declared" | "undeclared" | "mismatched" | "stale" | "expired" | "copies-changed" | "foreign";

/** The typed code of each refusing verdict (the commit guard prints it; the audit event carries it). */
export const DECLARATION_REFUSAL_CODES: Readonly<Record<Exclude<DeclarationVerdict, "declared">, string>> = Object.freeze({
  undeclared: "staged_move_loss",
  mismatched: "declared_deletion_mismatched",
  stale: "declared_deletion_stale",
  expired: "declared_deletion_expired",
  "copies-changed": "declared_deletion_copies_changed",
  foreign: "declared_deletions_foreign",
});

/** The facts of now a declaration is judged against. */
export type DeclarationFacts = Readonly<{
  /** HEAD's blob at the declared path (`undefined`: HEAD does not hold it). */
  blob: string | undefined;
  /** HEAD now (`null`: an unborn branch). */
  head: string | null;
  /** How many times HEAD has moved (`null`: no HEAD reflog). */
  moves: number | null;
  /** Whether anything is on disk at the declared path. */
  present: boolean;
}>;

/** A checkout's declarations as the commit guard reads them. */
export type DeclaredDeletionsView = Readonly<{
  recordPath: string;
  /** HEAD now (`null`: an unborn branch). */
  head: string | null;
  /** How many times HEAD has moved now (`null`: no HEAD reflog). */
  moves: number | null;
  /** The record was made for another git directory: none of its entries counts. */
  foreignGitDirectory: string | null;
  entries: ReadonlyMap<string, DeclaredDeletion>;
}>;

/** One staged deletion as the commit guard hands it over: its blob, the ignored copies it has now, and whether its path is on disk. */
export type DeletionAtCommit = Readonly<{ path: string; blob: string; copies: readonly string[]; present: boolean }>;

/** The record's location in the checkout whose top level is `top`, in `environment`'s git. */
export function declaredDeletionsPath(top: string, environment: GitEnvironment = "directory"): string {
  return gitPath(top, RECORD_GIT_PATH, environment);
}

/** The git directory a record at `recordPath` belongs to (it lives at `<git dir>/<product>/<file>`). */
function gitDirectoryOf(recordPath: string): string {
  return dirname(dirname(recordPath));
}

function topLevel(root: string, environment: GitEnvironment = "directory"): string {
  return requiredRepositoryToplevel(root, "declared_deletion_not_a_repository", environment);
}

function readRecord(recordPath: string): DeclarationRecord | null {
  return readCheckoutStateRecord(recordPath, RECORD_SCHEMA, (reason) => new HarnessError(
    `the deletion declarations at ${recordPath} cannot be read (${reason}; schema ${RECORD_SCHEMA_VERSION}); withdraw them with \`${CLEAR_DECLARED_DELETIONS_VERB.join(" ")}\` (engine CLI) and declare again`,
    "declared_deletions_unreadable",
  ));
}

function foreign(recordPath: string, gitDirectory: string): HarnessError {
  return new HarnessError(
    `the deletion declarations at ${recordPath} were made for the git directory ${gitDirectory}, not this one; withdraw them with \`${CLEAR_DECLARED_DELETIONS_VERB.join(" ")}\` (engine CLI) and declare again`,
    "declared_deletions_foreign",
  );
}

/** Replaces the record with `entries` (the record goes when none is left). Called under the record's lock. */
function writeRecord(recordPath: string, entries: readonly DeclaredDeletion[]): void {
  if (entries.length === 0) {
    rmSync(recordPath, { force: true });
    return;
  }
  const sorted = entries.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  writeCheckoutStateRecord<DeclarationRecord>(recordPath, { schemaVersion: RECORD_SCHEMA_VERSION, gitDirectory: gitDirectoryOf(recordPath), entries: sorted }, "declared_deletions_unwritable");
}

/** The record of this git directory, refusing one made for another (a copied file). */
function ownRecord(recordPath: string): DeclarationRecord | null {
  const record = readRecord(recordPath);
  if (record !== null && record.gitDirectory !== gitDirectoryOf(recordPath)) throw foreign(recordPath, record.gitDirectory);
  return record;
}

/**
 * Runs one read-modify-write of the record at `recordPath` under its
 * cross-process lock (`<record>.lock`): no two changes interleave.
 */
function withRecordLock<T>(recordPath: string, change: () => T): T {
  return withFileLock(`${recordPath}.lock`, (message, details) => new HarnessError(
    `another process is changing the deletion declarations (${message}); try again`,
    "declared_deletions_busy",
    true,
    details,
  ), change);
}

/**
 * Why a requested path cannot be declared, or `null`. A path is literal: it
 * must be git's own spelling (repository-relative, `/`-separated, no empty,
 * `.` or `..` segment), so no two spellings ever name one file.
 */
function spellingRefusal(path: string): "declared_deletion_path_invalid" | null {
  if (path.length === 0 || path.includes("\0")) return "declared_deletion_path_invalid";
  return path.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ? "declared_deletion_path_invalid" : null;
}

/** Each typed refusal of a path, with the words the refusal prints. */
const REFUSAL_WORDS = Object.freeze({
  declared_deletion_path_invalid: "not a repository-relative path in git's own spelling",
  declared_deletion_not_in_head: "HEAD holds nothing at exactly this path (nothing is a pattern)",
  declared_deletion_not_a_file: "HEAD holds a folder or a submodule here, not a file (a folder is never expanded)",
  declared_deletion_not_deleted: "something is still on disk at this path; delete the file first, then declare it (a declaration names a file that is gone)",
});

/**
 * Whether anything is on disk at `path` in the work tree `top` (a parent that
 * is now a file: nothing). THE one answer of "present" the state rule reads:
 * at declare time, at commit time (the guard imports it) and at consume time.
 */
export function presentOnDisk(top: string, path: string): boolean {
  try {
    return lstatSync(join(top, path), { throwIfNoEntry: false }) !== undefined;
  } catch {
    return false; // a parent that is now a file (ENOTDIR): the path is gone
  }
}

/** The ignored copies of each of `declared` (path → sorted copy paths), asked of the checkout `top`. */
function copiesOf(top: string, declared: readonly Readonly<{ path: string; blob: string }>[], environment: GitEnvironment): ReadonlyMap<string, readonly string[]> {
  const sizes = blobSizes(top, declared.map((entry) => entry.blob), environment);
  const copies = new Map<string, string[]>(declared.map((entry) => [entry.path, []]));
  for (const loss of ignoredCopies(top, declared.map((entry) => ({ ...entry, size: sizes.get(entry.blob)! })), environment)) copies.get(loss.from)!.push(loss.to);
  return new Map([...copies].map(([path, paths]) => [path, paths.toSorted()]));
}

/** The facts of now for each of `entries`, asked of the checkout `top` in `environment`'s git. */
function factsOf(top: string, entries: readonly DeclaredDeletion[], environment: GitEnvironment): (entry: DeclaredDeletion) => DeclarationFacts {
  const head = headCommit(top, environment);
  const moves = headMoves(top, environment);
  const versions = headVersions(top, entries.map((entry) => entry.path), environment);
  return (entry) => ({ blob: versions.get(entry.path)?.objectId, head, moves, present: presentOnDisk(top, entry.path) });
}

/**
 * Declares each of `paths` deleted on purpose: records the blob HEAD holds
 * there, HEAD, HEAD's move count and the blob's ignored copies. All or
 * nothing: one refused path refuses the call (typed, every refused path
 * named) and records nothing. A path declared again is re-bound to now; a
 * kept declaration that expired or was consumed is dropped.
 */
export function declareDeletions(root: string, paths: readonly string[]): Readonly<{ recordPath: string; head: string; declared: readonly Readonly<{ path: string; blob: string; copies: readonly string[] }>[]; total: number }> {
  if (paths.length === 0) throw new InputError(`name at least one path to declare deleted: ${DECLARE_DELETIONS_VERB.join(" ")} <path>…`, "declared_deletion_usage");
  const top = topLevel(root);
  const head = headCommit(top, "directory");
  if (head === null) throw new HarnessError(`nothing is committed in ${top}, so there is nothing to delete`, "declared_deletion_unborn");
  const moves = headMoves(top, "directory");
  if (moves === null) {
    throw new HarnessError(
      `${top} keeps no HEAD reflog, so a declaration could not tell a HEAD that moved and came back from one that never moved; ` +
        "turn it on (git config core.logAllRefUpdates true) and make one commit, then declare",
      "declared_deletion_head_unlogged",
    );
  }
  const requested = [...new Set(paths)];
  const versions = headVersions(top, requested.filter((path) => spellingRefusal(path) === null), "directory");
  const refused: { path: string; code: keyof typeof REFUSAL_WORDS }[] = [];
  const found: { path: string; blob: string }[] = [];
  for (const path of requested) {
    const version = versions.get(path);
    const code = spellingRefusal(path)
      ?? (version === undefined ? "declared_deletion_not_in_head"
        : version.mode === "040000" || version.mode === "160000" ? "declared_deletion_not_a_file"
        : presentOnDisk(top, path) ? "declared_deletion_not_deleted" : null);
    if (code !== null) refused.push({ path, code });
    else found.push({ path, blob: version!.objectId });
  }
  if (refused.length > 0) {
    const codes = [...new Set(refused.map((refusal) => refusal.code))];
    auditEvent("declared-deletion-refused", { head, refused });
    throw new InputError(
      `nothing was declared; ${String(refused.length)} path(s) cannot be declared deleted:\n` +
        refused.map(({ path, code }) => `  ${JSON.stringify(path)}: ${code} (${REFUSAL_WORDS[code]})`).join("\n"),
      codes.length === 1 ? codes[0]! : "declared_deletion_refused",
      { refused: refused.length },
    );
  }
  const copies = copiesOf(top, found, "directory");
  const declared: DeclaredDeletion[] = found.map((entry) => ({ ...entry, head, moves, copies: [...(copies.get(entry.path) ?? [])] }));
  const recordPath = declaredDeletionsPath(top);
  const total = withRecordLock(recordPath, () => {
    const existing = ownRecord(recordPath)?.entries ?? [];
    const facts = factsOf(top, existing, "directory");
    const kept = existing.filter((entry) => !declared.some((next) => next.path === entry.path) && !["consumed", "expired"].includes(declarationState(entry, facts(entry))));
    writeRecord(recordPath, [...kept, ...declared]);
    return kept.length + declared.length;
  });
  const summary = declared.map(({ path, blob, copies: kept }) => ({ path, blob, copies: kept }));
  auditEvent("deletions-declared", { head, moves, recordPath, declared: summary });
  return { recordPath, head, declared: summary, total };
}

/**
 * THE ONE RULE both the guard and the status report use: what `declaration`
 * is worth against `now`. A changed blob is the stronger reason and is named
 * first; then a moved HEAD (for good); then a path that is on disk again.
 */
export function declarationState(declaration: DeclaredDeletion, now: DeclarationFacts): DeclarationState {
  if (now.blob === undefined) return "consumed";
  if (now.blob !== declaration.blob) return "mismatched";
  if (declaration.head !== now.head || declaration.moves !== now.moves) return "stale";
  return now.present ? "expired" : "pending";
}

/**
 * The commit guard's verdict for one staged deletion (git's raw diff against
 * HEAD, with the ignored copies the commit finds and whether the path is on
 * disk). Accepted only when `declared`: the declaration is pending AND every
 * copy the commit finds is one it recorded.
 */
export function judgeDeclaration(view: DeclaredDeletionsView, deletion: DeletionAtCommit): Readonly<{ verdict: DeclarationVerdict; declaration?: DeclaredDeletion; undeclaredCopies?: readonly string[] }> {
  const declaration = view.entries.get(deletion.path);
  if (declaration === undefined) return { verdict: "undeclared" };
  if (view.foreignGitDirectory !== null) return { verdict: "foreign", declaration };
  const state = declarationState(declaration, { blob: deletion.blob, head: view.head, moves: view.moves, present: deletion.present });
  if (state !== "pending") return { verdict: state === "consumed" ? "undeclared" : state, declaration };
  const undeclaredCopies = deletion.copies.filter((copy) => !declaration.copies.includes(copy));
  return undeclaredCopies.length === 0 ? { verdict: "declared", declaration } : { verdict: "copies-changed", declaration, undeclaredCopies };
}

/**
 * The declarations of the git being committed, for the commit guard. Never
 * writes. `environment` is the hook's own (`inherited`): the record, HEAD and
 * HEAD's moves are read from the git whose index is committed, so a record of
 * another git directory (a linked worktree's, under `GIT_DIR` plus
 * `GIT_WORK_TREE`) never covers this commit (V2). A record made for another
 * git directory is returned with `foreignGitDirectory` set (the guard names it
 * in the refusal); an unreadable one throws (`declared_deletions_unreadable`),
 * and a guard that cannot read it refuses.
 */
export function readDeclaredDeletions(root: string, environment: GitEnvironment): DeclaredDeletionsView {
  const top = topLevel(root, environment);
  const recordPath = declaredDeletionsPath(top, environment);
  const record = readRecord(recordPath);
  const own = gitDirectoryOf(recordPath);
  return Object.freeze({
    recordPath,
    head: headCommit(top, environment),
    moves: headMoves(top, environment),
    foreignGitDirectory: record !== null && record.gitDirectory !== own ? record.gitDirectory : null,
    entries: new Map((record?.entries ?? []).map((entry) => [entry.path, entry])),
  });
}

/** Every declaration of the checkout with its state now. Never writes. */
export function declaredDeletionsStatus(root: string, environment: GitEnvironment = "directory"): Readonly<{ recordPath: string; head: string | null; moves: number | null; declarations: readonly Readonly<DeclaredDeletion & { state: DeclarationState }>[] }> {
  const top = topLevel(root, environment);
  const recordPath = declaredDeletionsPath(top, environment);
  const entries = ownRecord(recordPath)?.entries ?? [];
  const facts = factsOf(top, entries, environment);
  return { recordPath, head: headCommit(top, environment), moves: headMoves(top, environment), declarations: entries.map((entry) => ({ ...entry, state: declarationState(entry, facts(entry)) })) };
}

/**
 * After a commit (the `post-commit` hook, in the committing git's
 * environment): every declaration whose path HEAD no longer holds is consumed,
 * every one whose path is on disk again expires; the record goes when nothing
 * is left. The rest stay, stale for good (HEAD moved). A checkout with no
 * record (nearly every commit) is answered by the lock-free reader alone: no
 * state folder, no lock file, no fsync (wf-del2-design D8).
 */
export function consumeDeclaredDeletions(root: string, environment: GitEnvironment = "directory"): Readonly<{ head: string | null; consumed: readonly string[]; expired: readonly string[]; remaining: number }> {
  const top = topLevel(root, environment);
  const recordPath = declaredDeletionsPath(top, environment);
  if (readRecord(recordPath) === null) return { head: headCommit(top, environment), consumed: [], expired: [], remaining: 0 };
  return withRecordLock(recordPath, () => {
    const status = declaredDeletionsStatus(top, environment);
    const consumed = status.declarations.filter((entry) => entry.state === "consumed");
    const expired = status.declarations.filter((entry) => entry.state === "expired");
    const remaining = status.declarations.filter((entry) => entry.state !== "consumed" && entry.state !== "expired").map(({ state: _state, ...entry }) => entry);
    if (consumed.length + expired.length > 0) {
      writeRecord(status.recordPath, remaining);
      if (consumed.length > 0) auditEvent("declared-deletions-consumed", { head: status.head, consumed: consumed.map(({ path, blob }) => ({ path, blob })), remaining: remaining.length });
      if (expired.length > 0) auditEvent("declared-deletions-expired", { head: status.head, expired: expired.map(({ path, blob }) => ({ path, blob })), remaining: remaining.length });
    }
    return { head: status.head, consumed: consumed.map((entry) => entry.path), expired: expired.map((entry) => entry.path), remaining: remaining.length };
  });
}

/** Withdraws every declaration of the checkout (`harness deletions clear`), whatever state the record is in. */
export function clearDeclaredDeletions(root: string): Readonly<{ recordPath: string; cleared: readonly string[] }> {
  const recordPath = declaredDeletionsPath(topLevel(root));
  const cleared = withRecordLock(recordPath, () => {
    let paths: readonly string[] = [];
    try {
      paths = (readRecord(recordPath)?.entries ?? []).map((entry) => entry.path);
    } catch (error) {
      if ((error as HarnessError).code !== "declared_deletions_unreadable") throw error;
    }
    rmSync(recordPath, { force: true });
    return paths;
  });
  auditEvent("declared-deletions-cleared", { recordPath, cleared });
  return { recordPath, cleared };
}

/** One line for the checkout's declarations (the `workspaceGit.declaredDeletions` signal's words). */
export function declaredDeletionsSummary(root: string): string {
  try {
    const { declarations } = declaredDeletionsStatus(root);
    if (declarations.length === 0) return "none";
    const counts = new Map<DeclarationState, number>();
    for (const entry of declarations) counts.set(entry.state, (counts.get(entry.state) ?? 0) + 1);
    return `${String(declarations.length)} declared: ${[...counts].map(([state, count]) => `${String(count)} ${state}`).join(", ")}`;
  } catch (error) {
    const code = (error as HarnessError).code;
    if (code === "declared_deletion_not_a_repository") return "not a git checkout";
    if (code === "declared_deletions_unreadable" || code === "declared_deletions_foreign") return `refused: ${(error as Error).message}`;
    throw error;
  }
}
