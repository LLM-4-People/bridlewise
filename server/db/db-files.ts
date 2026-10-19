/**
 * THE WRITERS OF A DATABASE'S COPIES — the pre-migration copy's own files
 * (created at a private staging name, removed when an attempt fails or
 * retention no longer keeps them; the rename into place is the move owner's):
 * harness state beside the database, never user code. The NAMES of a
 * database's files (the database, SQLite's companions, the copies and a
 * staging copy) have one owner, `engine/src/filesystem/database-files.ts`,
 * shared with the keep-out list that refuses every one of them.
 */

import { closeSync, constants, lstatSync, openSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { bestEffort, stagingCopyPath } from "../kernel/canonical.ts";
import { HarnessError } from "../../engine/src/kernel/errors.ts";
import { movePath } from "../../engine/src/filesystem/move-path.ts";

/** Create `path` empty and private (0600) for a copy to be written into — never
 * over an existing file and never through a link (`O_EXCL|O_NOFOLLOW`). */
export function createPrivateCopyTarget(path: string): void {
  closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
}

/** Remove one copy (a failed staging file, or one retention no longer keeps); a link is removed, never followed. */
export function removeDatabaseCopy(path: string): void {
  rmSync(path, { force: true });
}

/**
 * A COPY OF `db` AT `target` THAT IS PROVEN, never assumed — the one copy
 * writer for the pre-migration copy and the pre-re-key copy:
 *
 *   - NEVER THROUGH A LINK: anything at `target` that is not a regular file
 *     (a planted symlink sent the whole database to its target) is refused,
 *     typed, before anything is written;
 *   - WRITTEN AT A PRIVATE STAGING NAME created 0600 first
 *     (`O_EXCL|O_NOFOLLOW`), then `VACUUM INTO` it, so the copy is never
 *     world-readable for a moment and a crash never leaves a partial copy at
 *     the final name (a staging copy a crash left is part of the database's
 *     file family, and the next copy sweeps it);
 *   - VERIFIED before it takes the name: it opens, `PRAGMA quick_check` says
 *     ok, and `holds(copy)` (the caller's content check) is true;
 *   - ALWAYS FRESH: an earlier copy at `target` is replaced.
 */
export function writeVerifiedCopy(db: DatabaseSync, target: string, holds: (copy: DatabaseSync) => boolean, what: string): void {
  const location = db.location();
  if (location === null || location === "") return;
  const present = lstatSync(target, { throwIfNoEntry: false });
  if (present !== undefined && !present.isFile()) {
    throw new HarnessError(
      `Refusing to go on: ${target}, where ${what} goes, is not a regular file (a link or a folder), and a copy is never written through one. Remove it and start again.`,
      "db_backup_path_unsafe",
    );
  }
  const staging = stagingCopyPath(location);
  createPrivateCopyTarget(staging);
  try {
    db.prepare("VACUUM INTO ?").run(staging);
    const copy = new DatabaseSync(staging, { readOnly: true });
    try {
      const check = copy.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
      const verdict = check === undefined ? undefined : Object.values(check)[0];
      if (verdict !== "ok" || !holds(copy)) {
        throw new HarnessError(`${what} did not verify (check: ${String(verdict)}), so nothing was changed.`, "db_backup_unverified");
      }
    } finally {
      copy.close();
    }
    movePath(staging, target);
  } catch (error) {
    bestEffort(() => removeDatabaseCopy(staging));
    throw error;
  }
}

/**
 * HOLD THE DATABASE ALONE: out of WAL mode (SQLite refuses that while any
 * other connection has the file open — a running server, idle or not) and in
 * exclusive locking mode, so no process can open it until this connection
 * closes. The one proof that the server is stopped, for every maintenance
 * operation that must run without it (the re-key, the conversation archive);
 * `refusal` is the operation's own typed refusal. The caller returns the file
 * to WAL (`establishWalJournal`) before it closes.
 */
export function holdDatabaseAlone(db: DatabaseSync, dbPath: string, refusalCode: string): void {
  db.exec("PRAGMA busy_timeout = 0");
  try {
    db.exec("PRAGMA journal_mode = DELETE");
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    db.exec("BEGIN EXCLUSIVE");
    db.exec("COMMIT");
  } catch {
    throw new HarnessError(`${dbPath} is open in another process (a running server holds it); nothing was changed. Stop the server first.`, refusalCode);
  }
}
