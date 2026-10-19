/**
 * THE ON-DISK FILES OF ONE HARNESS DATABASE — one owner for their names.
 *
 * A database is never one file: SQLite keeps `-wal` and `-shm` beside it, the
 * migration runner keeps verified pre-upgrade copies (`.pre-v<N>`), and a copy
 * being written lives at a private staging name until it is verified and
 * moved into place. Every consumer that must treat "the database" as a set
 * asks here — the migration backup (`server/db/migrations.ts`), the key tool
 * (`server/db/key-rotation.ts`) and the keep-out list
 * (`self-protection/keep-out.ts`), which keeps every one of them away from
 * confined processes and the server's file door — so a new sibling cannot be
 * protected in one place and forgotten in the other.
 *
 * A staging copy is named by the owned-temporary convention
 * (`private-state.ts`: owner pid + start time), so a copy a crashed upgrade
 * left behind is recognisable as abandoned and swept by the next upgrade —
 * and, until then, is still part of the family.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, statSync, type Dirent } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { hasErrorCode } from "../kernel/errors.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { ownedTemporaryName, sweepAbandonedTemporaries } from "./private-state.ts";

/** The marker between a database's name and the schema version its copy preceded. */
const PRE_MIGRATION_MARKER = ".pre-v";

/** The marker of a copy still being written (owned by a live or dead upgrade). */
const STAGING_MARKER = ".staging-";

/** The verified copy taken before a re-key (one slot; the next re-key replaces it). */
export const PRE_REKEY_MARKER = ".pre-rekey";

/**
 * THE OLD LAYOUT's key file beside its database (before the key home): still
 * a member of the family, so a database the registry knows keeps an
 * unrelocated (or interrupted) key beside it away from every confined process
 * too. The relocation tool (`server/db/key-rotation.ts`) reads the name here.
 */
export const LEGACY_KEY_BASENAME = "db-key";
/** The old salt beside its key (`<key>.salt`, passphrase mode). */
export const LEGACY_SALT_SUFFIX = ".salt";
/** A staged next key/salt, beside the one it replaces. */
export const NEXT_SUFFIX = ".next";

function isFileBacked(dbPath: string): boolean {
  return dbPath.length > 0 && dbPath !== ":memory:";
}

/** Where the copy taken before migrating to `version` lives. */
export function preMigrationBackupPath(dbPath: string, version: number): string {
  return `${resolve(dbPath)}${PRE_MIGRATION_MARKER}${version}`;
}

/** The pre-migration copies present beside `dbPath`, oldest version first. */
export function preMigrationBackups(dbPath: string): readonly Readonly<{ path: string; version: number }>[] {
  const absolute = resolve(dbPath);
  const prefix = `${basename(absolute)}${PRE_MIGRATION_MARKER}`;
  return siblingNames(absolute)
    .filter((name) => name.startsWith(prefix) && /^\d+$/u.test(name.slice(prefix.length)))
    .map((name) => ({ path: join(dirname(absolute), name), version: Number(name.slice(prefix.length)) }))
    .sort((a, b) => a.version - b.version);
}

/** Where the copy taken before re-keying `dbPath` lives. */
export function preRekeyCopyPath(dbPath: string): string {
  return `${resolve(dbPath)}${PRE_REKEY_MARKER}`;
}

/** The verified copy taken before conversations are archived and removed (one slot; the next archive replaces it). */
const PRE_ARCHIVE_MARKER = ".pre-archive";
/** The folder a database's archives are written to: a member of its family (the name starts with the database's own). */
const ARCHIVE_FOLDER_MARKER = ".archive";

/** Where the copy taken before archiving and removing conversations lives. */
export function preArchiveCopyPath(dbPath: string): string {
  return `${resolve(dbPath)}${PRE_ARCHIVE_MARKER}`;
}

/** The database's archive area: beside it, named from it, so the keep-out list holds it with the rest of the family. */
export function databaseArchiveFolder(dbPath: string): string {
  return `${resolve(dbPath)}${ARCHIVE_FOLDER_MARKER}`;
}

/**
 * A fresh private staging name for a copy of `dbPath` about to be written.
 * Copies an ABANDONED upgrade left (its owner no longer runs) are removed
 * first (logged by the sweep owner); a live one's are never touched.
 */
export function stagingCopyPath(dbPath: string): string {
  const absolute = resolve(dbPath);
  const prefix = `${basename(absolute)}${STAGING_MARKER}`;
  sweepAbandonedTemporaries(dirname(absolute), prefix);
  return join(dirname(absolute), ownedTemporaryName(prefix));
}

/**
 * THE FAMILY OF A DATABASE, NAMED ONCE: its folder and the name prefixes of
 * every file that holds (or unlocks) its rows — the database's own name
 * (which starts `-wal`, `-shm`, every `.pre-v<N>`, `.pre-rekey`,
 * `.pre-archive` and `.staging-…` copy, and the `.archive` folder) and the old layout's key (`db-key`, `db-key.salt`, their
 * `.next`). A prefix, not a listing: a copy written after the family was named
 * is a member at once, and a member that comes and goes needs no re-listing.
 */
export function databaseFamily(dbPath: string): Readonly<{ folder: string; prefixes: readonly string[] }> | undefined {
  if (!isFileBacked(dbPath)) return undefined;
  const absolute = resolve(dbPath);
  return Object.freeze({ folder: dirname(absolute), prefixes: Object.freeze([basename(absolute), LEGACY_KEY_BASENAME]) });
}

/** The first bytes of every SQLite 3 database file. */
const SQLITE_HEADER = "SQLite format 3\u0000";

/** Is `path` a regular SQLite database file (its header read; links never followed)? */
export function isSqliteFile(path: string): boolean {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return false; }
  try {
    if (!fstatSync(fd).isFile()) return false;
    const header = Buffer.alloc(SQLITE_HEADER.length);
    return readSync(fd, header, 0, header.length, 0) === header.length && header.toString("latin1") === SQLITE_HEADER;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/** The old layout's key-file names (a live key and a staged next one). */
const LEGACY_KEY_NAMES = [LEGACY_KEY_BASENAME, `${LEGACY_KEY_BASENAME}${NEXT_SUFFIX}`] as const;

/** Names a harness database file takes: its family's own names read first when the siblings are more than the bound. */
const LIKELY_DATABASE_NAME = /\.(?:db|db3|sqlite3?)$/iu;

/**
 * The old layout's key file in `folder` — a `db-key` (or its staged
 * `db-key.next`) of exactly a harness key's size, as a regular file or a link
 * to one (a link is followed for its SIZE only: sec-e-correctness M-4 found a
 * linked key admitted). The key's bytes are never read.
 */
export function legacyKeyIn(folder: string): string | undefined {
  return LEGACY_KEY_NAMES.map((name) => join(folder, name)).find((path) => {
    // A folder this process cannot search holds nothing it could serve.
    let stat;
    try { stat = lstatSync(path, { throwIfNoEntry: false }); if (stat?.isSymbolicLink() === true) stat = statSync(path, { throwIfNoEntry: false }); } catch { return false; }
    return stat !== undefined && stat.isFile() && stat.size === ROOT_POLICY.forensics.algorithms.keyBytes;
  });
}

/**
 * AN INSTALL THAT STILL KEEPS ITS KEY BESIDE ITS DATABASE (the layout before
 * the key home), recognised WITHOUT any registration — by location and shape:
 * a key ({@link legacyKeyIn}) in a folder that also holds a SQLite database.
 * A sibling's first 16 bytes are read, at most `maximumSiblingsRead` of them —
 * database-named siblings (`*.db`, `*.sqlite*`) FIRST, so filler files cannot
 * push the database out of the bound; and a folder whose siblings outrun the
 * bound before a database is found is still an install, FAIL CLOSED
 * (`databases` then lists none: it keeps the folder out, and a scan reports
 * it rather than registering it). Returns the key file and the databases
 * beside it, or undefined.
 */
export function legacyInstallIn(folder: string): Readonly<{ key: string; databases: readonly string[]; searchExhausted?: true }> | undefined {
  const key = legacyKeyIn(folder);
  if (key === undefined) return undefined;
  let entries: readonly Dirent[];
  try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return undefined; }
  const siblings = entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith(LEGACY_KEY_BASENAME))
    .map((entry) => entry.name)
    .sort((a, b) => Number(LIKELY_DATABASE_NAME.test(b)) - Number(LIKELY_DATABASE_NAME.test(a)));
  const bound = ROOT_POLICY.selfProtection.legacyInstalls.maximumSiblingsRead;
  const databases = siblings.slice(0, bound).map((name) => join(folder, name)).filter(isSqliteFile);
  if (databases.length > 0) return Object.freeze({ key, databases: Object.freeze(databases) });
  return siblings.length > bound ? Object.freeze({ key, databases: Object.freeze([]), searchExhausted: true as const }) : undefined;
}

/**
 * The errors that mean "this folder cannot be listed" as a lasting fact:
 * absent, not a folder, not readable by this user, a link loop, a name too
 * long, or a device that does not answer (a WSL drive that is not ready) —
 * so no process of this user, a confined child included, can read below it.
 * A TRANSIENT failure (EMFILE, ENFILE, ENOMEM, EAGAIN, EINTR, anything
 * unknown) is not a verdict about the folder: the child could read it later,
 * so it is thrown (the keep-out list fails closed; a search fails loudly).
 * One classification for every walk that looks for installs.
 */
export const UNLISTABLE_DIRECTORY_CODES = ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP", "ENAMETOOLONG", "EIO", "ENODEV", "ENXIO"] as const;

export type LegacyInstall = Readonly<{ folder: string; key: string; databases: readonly string[]; searchExhausted?: true }>;

/** What a search for legacy installs saw: the installs, how many folders it walked, how many it could not list, and whether it stopped at its budget. */
export type LegacyInstallSearch = Readonly<{ installs: readonly LegacyInstall[]; foldersWalked: number; unlistableFolders: number; truncated: boolean }>;

/**
 * THE INSTALLS UNDER `roots` that still keep a key beside their database
 * ({@link legacyInstallIn}) — at every depth, links not followed, the one
 * skip list (`legacyInstalls.skippedFolders`) never entered, and at most
 * `folderBudget` folders walked: a search that reached its budget says so
 * (`truncated`) and reports only what it saw, so a caller scans the rest by
 * naming deeper roots. Read-only; the admin action runs it off the server's
 * event loop (a home folder is a million folders, measured at 48 s).
 */
export function findLegacyInstalls(roots: readonly string[], folderBudget: number): LegacyInstallSearch {
  const skipped: ReadonlySet<string> = new Set(ROOT_POLICY.selfProtection.legacyInstalls.skippedFolders);
  const installs: LegacyInstall[] = [];
  const stack = roots.map((root) => resolve(root));
  let foldersWalked = 0, unlistableFolders = 0;
  while (stack.length > 0 && foldersWalked < folderBudget) {
    const folder = stack.pop()!;
    foldersWalked += 1;
    let entries: readonly Dirent[];
    try { entries = readdirSync(folder, { withFileTypes: true }); } catch (error) {
      if (!hasErrorCode(error, ...UNLISTABLE_DIRECTORY_CODES)) throw error;
      unlistableFolders += 1;
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !skipped.has(entry.name)) stack.push(join(folder, entry.name));
    }
    const install = legacyInstallIn(folder);
    if (install !== undefined) installs.push(Object.freeze({ folder, ...install }));
  }
  return Object.freeze({
    installs: Object.freeze(installs.sort((a, b) => a.folder.localeCompare(b.folder))),
    foldersWalked,
    unlistableFolders,
    truncated: stack.length > 0,
  });
}

function siblingNames(absolute: string): readonly string[] {
  try {
    return readdirSync(dirname(absolute));
  } catch {
    // No folder yet: nothing beside the database exists.
    return [];
  }
}
