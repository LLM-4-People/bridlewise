/**
 * THE KEY'S LIFECYCLE TOOL — for installs made before keys moved to the key
 * home, and for retiring a key (or the old shared passphrase salt).
 *
 *   - `relocateDatabaseKey`: moves ONE install's key (and passphrase salt)
 *     from its old place beside the database — `.bridlewise/db-key`, the
 *     legacy `.code-harness/db-key`, a custom key path — into the key home
 *     (`engine/src/filesystem/self-protection/key-home.ts`), after PROVING it
 *     opens that database (at least one sealed value; a database with nothing
 *     sealed proves nothing and needs `forceEmpty`), and registers the
 *     database and the timeline beside it. Run by that install's own
 *     operator: it changes where that install's code looks for its key.
 *     Crash-safe: the key is published whole (the one key writer) before the
 *     old copy is removed, and a re-run finishes.
 *   - `registerLegacyInstalls`: REGISTER the installs that still keep a key
 *     beside their database (found under the given folders — other
 *     checkouts, labs, backups, engine timelines — by the engine's bounded
 *     `findLegacyInstalls`, which the key tool runs off the event loop) —
 *     never move a key: another checkout's code still reads its key where it is.
 *     Registered, each install's whole family is kept out by identity; an
 *     unregistered one is still refused by shape (`database-files.ts`
 *     `legacyInstallIn`), this adds every depth. One outcome per install,
 *     never an abort.
 *   - `rekeyDatabase`: re-encrypts every encrypted field under a NEW key (key
 *     file mode) or a new RANDOM salt (passphrase mode — this retires the old
 *     fixed salt a pre-v20 database adopted), after a verified pre-re-key
 *     copy, KEEPING the old key (or salt) as a retired key in a slot of its
 *     own (named by its fingerprint), so the copy and every earlier
 *     pre-migration copy still open — after any number of re-keys, each
 *     under the key it was sealed with. Refused
 *     while any other connection holds the database (a running server): the
 *     tool takes the database out of WAL mode and holds it exclusively for
 *     the whole operation. Crash-safe: the new key is staged beside the old
 *     one, the fields are re-encrypted in one transaction, and only then is
 *     the staged key moved into place; every open refuses while a staged key
 *     exists (`persisted_key_rekey_in_flight`) and a re-run finishes. REFUSED
 *     while a timeline sharing the key (found through the registry's pairing)
 *     holds history: the ledger is append-only and its sealed originals and
 *     memory entries are bound to the key (the ledger re-seal is recorded as
 *     open work).
 */

import { randomBytes, scryptSync, createSecretKey } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  ADOPTED_FIXED_SALT_BYTES,
  PERSISTED_KEY_BYTES,
  admitHarnessKeyHome,
  databaseKeyFile,
  databaseKeyName,
  databaseSaltFile,
  forgetHarnessStore,
  LEGACY_KEY_BASENAME,
  LEGACY_SALT_SUFFIX,
  NEXT_SUFFIX,
  openStoreRegistry,
  preRekeyCopyPath,
  publishKeyMaterial,
  registerHarnessStore,
  establishWalJournal,
  type AdmittedKeyHome,
  type LegacyInstall,
} from "../kernel/canonical.ts";
import { HarnessError } from "../../engine/src/kernel/errors.ts";
import { webWarn } from "../observability/debug-bridge.ts";
import { DEFAULT_TIMELINE_DB_PATH, serverConfig } from "../kernel/config.ts";
import { createDbCryptoFromKey, databaseKeyProof, ENCRYPTED_COLUMNS, isEncryptedValue, openedBinding, ownedRowsSql, resolveDatabaseKey, type DbCrypto, type EncryptedColumn, type EncryptedTable } from "./db-crypto.ts";
import { holdDatabaseAlone, writeVerifiedCopy } from "./db-files.ts";
import { movePath } from "../../engine/src/filesystem/move-path.ts";
import { readSchemaVersion } from "./migrations.ts";
import { SCHEMA_VERSION_LATEST } from "./schema.ts";

/** The timeline that shares a web database's key sits beside it under this name in the old layout. */
const TIMELINE_BASENAME = basename(DEFAULT_TIMELINE_DB_PATH);

function refuseKeyChange(message: string, code: string): never {
  throw new HarnessError(message, code);
}

/** The bytes of a private key-shaped file (0600, regular, never through a link), or undefined when absent. */
function readPrivateFile(path: string): Buffer | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return refuseKeyChange(`${path} could not be opened (${(error as NodeJS.ErrnoException).code ?? "error"}); a key is never read through a link.`, "db_key_file_invalid");
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) refuseKeyChange(`${path} is not a private regular file (mode ${(stat.mode & 0o777).toString(8)}).`, "db_key_file_invalid");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncFolder(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function removeSynced(path: string): void {
  unlinkSync(path);
  syncFolder(dirname(path));
}

function openDatabase(dbPath: string): DatabaseSync {
  if (!existsSync(dbPath)) refuseKeyChange(`There is no database at ${dbPath}.`, "db_key_database_missing");
  return new DatabaseSync(dbPath);
}

/** A crypto over raw key material (key file mode) or a salt (passphrase mode). */
function cryptoFrom(material: Buffer, passphrase: string): DbCrypto {
  return createDbCryptoFromKey({ key: createSecretKey(passphrase.length > 0 ? scryptSync(passphrase, material, PERSISTED_KEY_BYTES) : material), persisted: true, filePath: null });
}

// ── relocate ───────────────────────────────────────────────────────────────

export type RelocationResult = Readonly<{
  database: string;
  from: string;
  to: string;
  mode: "key" | "passphrase-salt";
  outcome: "moved" | "already-moved";
  registered: readonly string[];
}>;

export type RelocationOptions = Readonly<{
  dbPath: string;
  from?: string;
  passphrase?: string;
  keyHome?: AdmittedKeyHome;
  /** Move a key that nothing sealed in the database can prove (a database with no sealed value yet). */
  forceEmpty?: boolean;
}>;

/**
 * Move one install's key into the key home (the one admission's, or the
 * caller's admitted `keyHome`). `from` defaults to the old layout
 * (`<database folder>/db-key`); in passphrase mode (`passphrase` given) the
 * salt beside it moves instead.
 */
export function relocateDatabaseKey(options: RelocationOptions): RelocationResult {
  const dbPath = resolve(options.dbPath);
  const keyHome = options.keyHome ?? admitHarnessKeyHome([dbPath]);
  const legacyKey = resolve(options.from ?? join(dirname(dbPath), LEGACY_KEY_BASENAME));
  const passphrase = options.passphrase ?? "";
  const from = passphrase.length > 0 ? `${legacyKey}${LEGACY_SALT_SUFFIX}` : legacyKey;
  const to = passphrase.length > 0 ? databaseSaltFile(keyHome, dbPath) : databaseKeyFile(keyHome, dbPath);
  const legacy = readPrivateFile(from);
  const current = readPrivateFile(to);
  const mode = passphrase.length > 0 ? "passphrase-salt" : "key";
  if (legacy === undefined) {
    if (current === undefined) refuseKeyChange(`Neither ${from} nor ${to} exists: there is no key to move.`, "db_key_relocation_source_missing");
    return { database: dbPath, from, to, mode, outcome: "already-moved", registered: registerInstallStores(keyHome, dbPath) };
  }
  const isMaterial = (bytes: Buffer): boolean => (passphrase.length > 0 ? bytes.length === PERSISTED_KEY_BYTES || bytes.length === ADOPTED_FIXED_SALT_BYTES : bytes.length === PERSISTED_KEY_BYTES);
  if (!isMaterial(legacy)) refuseKeyChange(`${from} is not a key or salt of this harness (${legacy.length} bytes).`, "db_key_file_invalid");
  const db = openDatabase(dbPath);
  let legacyProof: ReturnType<typeof databaseKeyProof>;
  let currentProof: ReturnType<typeof databaseKeyProof> | undefined;
  try {
    legacyProof = databaseKeyProof(db, cryptoFrom(legacy, passphrase));
    // A key-home file that is not even key-sized (an older tool's interrupted publish) opens nothing.
    if (current !== undefined && !current.equals(legacy)) currentProof = isMaterial(current) ? databaseKeyProof(db, cryptoFrom(current, passphrase)) : "wrong";
  } finally {
    db.close();
  }
  if (current !== undefined && !current.equals(legacy)) {
    // Two different keys for one database: say which one opens it, and move nothing.
    refuseKeyChange(
      `The key home already holds a DIFFERENT key for ${dbPath} (${to}); nothing was moved. The key home's key ${currentProof === "opens" ? "opens the database" : currentProof === "empty" ? "cannot be proven (nothing is sealed yet)" : "does NOT open the database"}; the old key ${from} ${legacyProof === "opens" ? "opens it" : legacyProof === "empty" ? "cannot be proven either" : "does NOT open it"}. Keep the one that opens it and remove the other yourself.`,
      "db_key_relocation_conflict",
    );
  }
  if (legacyProof === "wrong") refuseKeyChange(`${from} does not open ${dbPath} (a sealed field did not decrypt); nothing was moved.`, "db_key_relocation_wrong_key");
  if (legacyProof === "empty" && options.forceEmpty !== true) {
    refuseKeyChange(
      `${dbPath} holds nothing sealed, so nothing proves ${from} is its key; nothing was moved. If you are sure it is, move it with --force-empty (the old file is removed afterwards).`,
      "db_key_relocation_unproven",
    );
  }
  if (current === undefined) publishKeyMaterial(to, legacy);
  removeSynced(from);
  const registered = registerInstallStores(keyHome, dbPath);
  webWarn("db", "database key moved into the key home", () => ({ database: dbPath, from, to, mode }));
  return { database: dbPath, from, to, mode, outcome: "moved", registered };
}

/** Register the database and the old layout's timeline beside it (which shares its key), when present. */
function registerInstallStores(keyHome: AdmittedKeyHome, dbPath: string): readonly string[] {
  const timeline = join(dirname(dbPath), TIMELINE_BASENAME);
  const stores = basename(dbPath) !== TIMELINE_BASENAME && existsSync(timeline) ? [dbPath, timeline] : [dbPath];
  for (const store of stores) registerHarnessStore(keyHome, store, dbPath);
  return stores;
}

// ── scan ───────────────────────────────────────────────────────────────────

export type ScanOutcome = LegacyInstall & Readonly<{ outcome: "registered" } | { outcome: "refused"; code: string; message: string }>;

/**
 * REGISTER every install a search found (never moves a key), one outcome per
 * install: a refusal is reported and the scan goes on. Each database of an
 * install is sealed with that folder's key.
 */
export function registerLegacyInstalls(installs: readonly LegacyInstall[], keyHome?: AdmittedKeyHome): readonly ScanOutcome[] {
  if (installs.length === 0) return [];
  const home = keyHome ?? admitHarnessKeyHome(installs.flatMap((install) => install.databases));
  return installs.map((install): ScanOutcome => {
    // A key beside more files than one search reads (none of them a database
    // within the bound) is kept out fail-closed, never registered blind.
    if (install.searchExhausted === true) {
      return { ...install, outcome: "refused", code: "legacy_install_search_exhausted", message: `${install.folder} keeps a key beside more files than one search reads; no database was found within the bound, so nothing is registered — the folder stays kept out by shape. Move the extra files out, or relocate its key with its database named.` };
    }
    try {
      for (const database of install.databases) registerHarnessStore(home, database, install.databases[0]);
      return { ...install, outcome: "registered" };
    } catch (error) {
      const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "db_key_scan_failed";
      return { ...install, outcome: "refused", code, message: error instanceof Error ? error.message : String(error) };
    }
  });
}

/** Forget one store's registration (a store deleted on purpose); the key home is admitted as for every tool call. */
export function forgetDatabase(dbPath: string, keyHome?: AdmittedKeyHome): Readonly<{ database: string; forgotten: boolean }> {
  const database = resolve(dbPath);
  return { database, forgotten: forgetHarnessStore(keyHome ?? admitHarnessKeyHome([]), database) };
}

// ── rekey ──────────────────────────────────────────────────────────────────

export type RekeyResult = Readonly<{
  database: string;
  mode: "key" | "passphrase-salt";
  outcome: "rekeyed" | "finished-interrupted";
  fields: number;
  copy: string;
  /** The retired key (or salt) this re-key kept, in its own slot: it opens `copy` and every pre-migration copy sealed under it (earlier re-keys' retired keys keep theirs). */
  retired: string;
}>;

/** Every timeline sharing this database's key (the registry's pairing) must hold no history (see the module note). */
function assertTimelinesEmpty(keyHome: AdmittedKeyHome, dbPath: string): void {
  const sharing = openStoreRegistry(keyHome).sharingKey(databaseKeyName(dbPath)).filter((store) => store !== dbPath);
  const beside = join(dirname(dbPath), TIMELINE_BASENAME);
  for (const timeline of [...new Set([...sharing, beside])]) {
    if (!existsSync(timeline)) continue;
    const db = new DatabaseSync(timeline, { readOnly: true });
    try {
      const hasLedger = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'event_log'").get() !== undefined;
      if (hasLedger && db.prepare("SELECT 1 FROM event_log LIMIT 1").get() !== undefined) {
        refuseKeyChange(
          `The timeline ${timeline} shares this database's key and holds history, and the ledger is append-only: its sealed originals and memory entries are bound to the current key, so re-keying the database alone would orphan them. Nothing was changed.`,
          "db_rekey_timeline_bound",
        );
      }
    } finally {
      db.close();
    }
  }
}

/**
 * Re-key one database (see the module note). `passphrase` selects passphrase
 * mode (a new random salt), else a new key file.
 */
export function rekeyDatabase(options: Readonly<{ dbPath: string; passphrase?: string; keyHome?: AdmittedKeyHome }>): RekeyResult {
  const dbPath = resolve(options.dbPath);
  const passphrase = options.passphrase ?? "";
  const mode = passphrase.length > 0 ? "passphrase-salt" : "key";
  const keyHome = options.keyHome ?? admitHarnessKeyHome([dbPath]);
  const target = passphrase.length > 0 ? databaseSaltFile(keyHome, dbPath) : databaseKeyFile(keyHome, dbPath);
  const retiredSlot = (material: Uint8Array): string => (passphrase.length > 0 ? databaseSaltFile(keyHome, dbPath, material) : databaseKeyFile(keyHome, dbPath, material));
  const current = (): Buffer => readPrivateFile(target) ?? refuseKeyChange(`${target} disappeared during the re-key; nothing was changed.`, "db_rekey_key_missing");
  const staged = `${target}${NEXT_SUFFIX}`;
  const copy = preRekeyCopyPath(dbPath);
  const db = openDatabase(dbPath);
  try {
    holdDatabaseAlone(db, dbPath, "db_rekey_database_busy");
    if (readSchemaVersion(db) !== SCHEMA_VERSION_LATEST) {
      refuseKeyChange(`${dbPath} is at schema version ${readSchemaVersion(db)}, not ${SCHEMA_VERSION_LATEST}: start the server once so it upgrades the database, stop it, then re-key.`, "db_rekey_schema_old");
    }
    // An interrupted re-key: the staged material either already opens the
    // database (the fields were re-encrypted; only the move is missing) or
    // never took (the transaction rolled back): finish, or discard it. No
    // process sealed anything meanwhile: every open refuses a staged key.
    const pending = readPrivateFile(staged);
    if (pending !== undefined) {
      if (databaseKeyProof(db, cryptoFrom(pending, passphrase)) === "opens") {
        // The key file still holds the retired material (the interrupted run kept it first).
        const retired = retiredSlot(current());
        movePath(staged, target);
        syncFolder(dirname(target));
        webWarn("db", "interrupted re-key finished", () => ({ database: dbPath, mode }));
        return { database: dbPath, mode, outcome: "finished-interrupted", fields: 0, copy, retired };
      }
      removeSynced(staged);
    }
    assertTimelinesEmpty(keyHome, dbPath);
    const old = resolveDatabaseKey({ dbPath, keyHome, ...(passphrase.length > 0 ? { passphrase } : {}) });
    const oldCrypto = createDbCryptoFromKey(old);
    if (databaseKeyProof(db, oldCrypto) === "wrong") refuseKeyChange(`The current key does not open ${dbPath}; nothing was changed.`, "db_rekey_wrong_key");
    writeVerifiedCopy(db, copy, (backup) => databaseKeyProof(backup, oldCrypto) !== "wrong", "the pre-re-key copy of the database");
    // The copy (and every pre-migration copy) stays sealed under the OLD key:
    // it is kept, retired, in its own slot — the only way they open again.
    // (A re-run keeps the same material in the same slot.)
    const retiring = current();
    const retired = retiredSlot(retiring);
    publishKeyMaterial(retired, retiring, true);
    const material = randomBytes(PERSISTED_KEY_BYTES);
    publishKeyMaterial(staged, material);
    const newCrypto = cryptoFrom(material, passphrase);
    let fields = 0;
    db.exec("BEGIN EXCLUSIVE");
    try {
      fields = reencryptEveryField(db, oldCrypto, newCrypto);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      removeSynced(staged);
      throw error;
    }
    movePath(staged, target);
    syncFolder(dirname(target));
    if (databaseKeyProof(db, newCrypto) === "wrong") refuseKeyChange(`${dbPath} did not open under its new key after re-keying; restore ${copy} (its key is ${retired}).`, "db_rekey_unverified");
    webWarn("db", "database re-keyed", () => ({ database: dbPath, mode, fields }));
    return { database: dbPath, mode, outcome: "rekeyed", fields, copy, retired };
  } finally {
    // Back to the mode every server open expects (it sets WAL itself too), through the one WAL owner.
    try { establishWalJournal(db, serverConfig.dbBusyTimeoutMs); } finally { db.close(); }
  }
}

/** Every encrypted value, re-sealed under the same binding with the new key; one that does not open refuses the whole re-key. */
function reencryptEveryField(db: DatabaseSync, from: DbCrypto, to: DbCrypto): number {
  let count = 0;
  for (const [table, shape] of Object.entries(ENCRYPTED_COLUMNS) as [EncryptedTable, (typeof ENCRYPTED_COLUMNS)[EncryptedTable]][]) {
    for (const column of shape.columns) {
      const rows = db.prepare(`${ownedRowsSql(table)} WHERE t.${column} LIKE 'enc:%'`).all() as Array<Record<string, unknown>>;
      const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
      for (const row of rows) {
        const value = row[column] as string;
        if (!isEncryptedValue(value)) continue;
        const binding = openedBinding(from, table, column as EncryptedColumn<typeof table>, row);
        if (binding === undefined) refuseKeyChange(`${table}.${column} of one row does not open under the current key; nothing was changed.`, "db_rekey_undecodable");
        update.run(to.encryptField(from.decryptField(value, binding), binding), row["rowid_"] as number);
        count += 1;
      }
    }
  }
  return count;
}
