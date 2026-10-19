/**
 * A TEST NEVER OPENS A REAL DATABASE — DECIDED BY THE DATABASE'S OWN
 * PROVENANCE, NOT BY ITS PATH (UD-S15).
 *
 * ── The incident ──
 * The live `web.db` held 204 conversations of 1,000 messages each, written
 * 2026-08-30..09-12 by the performance profile's long-chat phase: it opened
 * a `DbClient` on the hard-coded `.bridlewise/web.db` from the Playwright
 * process (a runner nothing recognised as "under test"), seeded 1,000
 * messages and soft-deleted the chat afterwards. A path check would have
 * needed the right path spelled in the right place; the next test would have
 * spelled another.
 *
 * ── The rule ──
 * Every database the PRODUCT opens for writing carries a stamp in its own
 * header (SQLite's `application_id`): {@link DATABASE_PROVENANCE}.product. A
 * process UNDER TEST (the one answer, `processUnderTest()` of the checkout
 * write door: our runners arm it, and every descendant inherits it) refuses
 * to open a database carrying that stamp — for reading or writing — before
 * anything is read or written (`database_real_under_test`). Databases a test
 * creates carry no stamp (a process under test never stamps); a copy made on
 * purpose by the fixture door (`tests/performance/scale/prepare-fixture.ts`)
 * is restamped {@link DATABASE_PROVENANCE}.fixture, which the product keeps
 * and a test may open. The stamp travels with the file — a rename, a symlink,
 * a copy, any spelling of the path — because it is IN the file.
 *
 * ── Databases that predate the stamp (SCALE-CR1-FIX N5) ──
 * A database the product has not opened for writing since this rule shipped
 * carries no stamp yet (the live 10 GB ledger, another checkout's databases):
 * under the stamp rule alone a test could open one and migrate it. So, under
 * test, an UNSTAMPED database is admitted only when it is the test's own:
 *
 *  - an EMPTY one (no schema yet: the test is creating it) — stamped
 *    {@link DATABASE_PROVENANCE}.test when opened for writing, so a database a
 *    test made stays the test's own when reopened from anywhere;
 *  - one that already holds tables only inside this run's temporary root
 *    (`os.tmpdir()`, the run's own: a fixture a test built directly).
 *
 * Any other unstamped (or foreign-stamped) database that holds tables is
 * refused, before anything is read or written.
 *
 * The doors that call this: the web database's client
 * (`server/db/client.ts`, every connection) and the timeline store
 * (`createTimelineStore`, `migrateTimelineFile`, `pendingTimelineMigrations`).
 */
import type { DatabaseSync } from "node:sqlite";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, relative, isAbsolute } from "node:path";

import { SecurityError } from "../kernel/errors.ts";
import { processUnderTest } from "./checkout-write-door.ts";

/**
 * The `application_id` values (a 32-bit header field SQLite reserves for the
 * application that owns the file; 0 = unset). ASCII tags, so `file(1)` and a
 * hex dump name them: `BWDB` (a real, product-opened database), `BWFX` (a
 * deliberate fixture copy) and `BWTS` (a database a test created).
 */
export const DATABASE_PROVENANCE = Object.freeze({
  product: 0x42574442,
  fixture: 0x42574658,
  test: 0x42575453,
});

export const REAL_DATABASE_UNDER_TEST_CODE = "database_real_under_test";

function applicationIdOf(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA application_id").get() as { application_id?: number | bigint } | undefined;
  return Number(row?.application_id ?? 0);
}

function holdsTables(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get() !== undefined;
}

/** Whether `path` (an existing file) lies inside `root`, both by real path. */
function insideRoot(path: string, root: string): boolean {
  const resolve = (value: string): string => { try { return realpathSync(value); } catch { return value; } };
  const offset = relative(resolve(root), resolve(path));
  return offset.length > 0 && !offset.startsWith("..") && !isAbsolute(offset);
}

/**
 * Admit one connection by the database's provenance, BEFORE the caller reads
 * or writes anything through it. Under test: a product database is refused,
 * and an unstamped one unless it is the test's own (see the header).
 * Otherwise: a writable connection stamps an unstamped database as the
 * product's. An in-memory database has no file and no provenance.
 * `underTest` is this process's one answer; a test states it to drive the
 * product's branch (a test process cannot stop being under test), and
 * `temporaryRoot` the run's temporary root.
 */
export function admitDatabaseProvenance(db: DatabaseSync, path: string, access: "read" | "write", underTest: boolean = processUnderTest(), temporaryRoot: string = tmpdir()): void {
  if (path === "" || path === ":memory:") return;
  const stamp = applicationIdOf(db);
  if (underTest) {
    if (stamp === DATABASE_PROVENANCE.fixture || stamp === DATABASE_PROVENANCE.test) return;
    if (stamp === DATABASE_PROVENANCE.product) {
      throw new SecurityError(
        `a process under test tried to open ${basename(path)}, a database the product itself uses (its header carries the product's stamp); ` +
        "a test opens databases it creates, or a fixture copy made by the fixture door — never a real one",
        REAL_DATABASE_UNDER_TEST_CODE,
      );
    }
    if (!holdsTables(db)) {
      if (access === "write") db.exec(`PRAGMA application_id = ${String(DATABASE_PROVENANCE.test)}`);
      return;
    }
    if (stamp === 0 && insideRoot(path, temporaryRoot)) return;
    throw new SecurityError(
      `a process under test tried to open ${basename(path)}, a database that already holds data, carries no test or fixture stamp and lies outside this run's temporary root — ` +
      "a real database from before the product stamped its databases; a test opens databases it creates, or a fixture copy made by the fixture door",
      REAL_DATABASE_UNDER_TEST_CODE,
    );
  }
  if (access === "write" && stamp === 0) db.exec(`PRAGMA application_id = ${String(DATABASE_PROVENANCE.product)}`);
}

/** Restamp a deliberate COPY as a fixture (the fixture door only): the product keeps the stamp, a test may open it. */
export function markFixtureCopy(db: DatabaseSync): void {
  db.exec(`PRAGMA application_id = ${String(DATABASE_PROVENANCE.fixture)}`);
}

export type DatabaseProvenance = "product" | "fixture" | "test" | "unstamped" | "foreign";

/** The provenance a database file's header states. */
export function databaseProvenanceOf(db: DatabaseSync): DatabaseProvenance {
  const stamp = applicationIdOf(db);
  if (stamp === DATABASE_PROVENANCE.product) return "product";
  if (stamp === DATABASE_PROVENANCE.fixture) return "fixture";
  if (stamp === DATABASE_PROVENANCE.test) return "test";
  return stamp === 0 ? "unstamped" : "foreign";
}
