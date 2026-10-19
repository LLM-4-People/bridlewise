/**
 * THE WAL JOURNAL OWNER — how a SQLite store enters write-ahead logging, and
 * how its checkpoints report what they actually did. The engine timeline and
 * the web database both ask here.
 */
import type { DatabaseSync } from "node:sqlite";
import { reportBestEffortFailure } from "../shared/debug/debug-system.ts";

/** SQLite's primary result code for a lock another connection holds (extended codes keep it in the low byte). */
const SQLITE_BUSY = 5;

function isSqliteBusy(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === "number" && (code & 0xff) === SQLITE_BUSY;
}

/**
 * Put `db` into WAL mode, waiting for other openers within the connection's
 * own busy timeout (`PRAGMA busy_timeout`, which the caller installs first).
 *
 * WHY A BUSY TIMEOUT ALONE IS NOT ENOUGH. Switching a file that is not yet in
 * WAL mode (every brand-new file's first openers) promotes a read lock to a
 * write lock. When two connections do that at once, waiting could deadlock, so
 * SQLite answers one of them SQLITE_BUSY at once WITHOUT consulting its busy
 * handler, "hoping that this will induce the first process to release its read
 * lock" (sqlite.org/c3ref/busy_handler.html). Measured: 3 processes opening one
 * fresh timeline failed "database is locked" in 2 of 10 rounds.
 *
 * THE REMEDY IS THE DOCUMENTED ONE, WITH NO POLLING CONSTANT. The refused
 * statement has already released its lock; the connection then waits for the
 * other opener's switch by taking the write lock FROM NOTHING (`BEGIN
 * IMMEDIATE` — no lock held, so no deadlock is possible and the busy handler
 * does wait), releases it, and asks again (a file already in WAL mode needs no
 * promotion). The deadline is the busy timeout; past it the last refusal
 * stands. Any other failure is thrown as it is.
 */
export function establishWalJournal(db: DatabaseSync, busyTimeoutMs: number): void {
  const deadline = Date.now() + busyTimeoutMs;
  for (;;) {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
    }
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
  }
}

export type SqliteCheckpointResult = Readonly<{
  status: "complete" | "incomplete" | "not-applicable" | "failed";
}>;

/** Checkpoint progress is observable; it is not a per-event fsync receipt. */
function failedCheckpoint(): SqliteCheckpointResult {
  reportBestEffortFailure();
  return { status: "failed" };
}

/**
 * Run `PRAGMA wal_checkpoint(<mode>)` and say what it did, from its own result
 * row (`busy`, `log`, `checkpointed`), never from the absence of an exception:
 * a TRUNCATE that a reader blocked answers `busy = 1` and throws nothing.
 * A failure and an incomplete TRUNCATE are reported centrally; an incomplete
 * PASSIVE checkpoint is not — with readers active it is the normal outcome of
 * the periodic timer, and reporting it would flood the channel every tick.
 */
export function checkpointSqlite(db: DatabaseSync, mode: "PASSIVE" | "TRUNCATE"): SqliteCheckpointResult {
  try {
    const statement = db.prepare(`PRAGMA main.wal_checkpoint(${mode})`);
    statement.setReadBigInts(true);
    const row = statement.get() as { busy: bigint; log: bigint; checkpointed: bigint } | undefined;
    if (row === undefined || (row.busy !== 0n && row.busy !== 1n)) return failedCheckpoint();
    if (row.busy === 0n && row.log === -1n && row.checkpointed === -1n) return { status: "not-applicable" };
    if (row.log < 0n || row.checkpointed < 0n || row.checkpointed > row.log) return failedCheckpoint();
    const complete = row.busy === 0n && (mode === "TRUNCATE" ? row.log === 0n && row.checkpointed === 0n : row.log === row.checkpointed);
    if (!complete && mode === "TRUNCATE") reportBestEffortFailure();
    return { status: complete ? "complete" : "incomplete" };
  } catch {
    return failedCheckpoint();
  }
}
