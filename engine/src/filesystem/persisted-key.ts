/** Host-owned persistent root key. No caller receives serialized key bytes. */
import { createSecretKey, scryptSync, type KeyObject } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, openSync, readSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hasErrorCode, SecurityError } from "../kernel/errors.ts";
import { randomBytes } from "../kernel/integrity.ts";
import { reportBestEffortFailure } from "../shared/debug/debug-system.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { atomicWriteFile } from "./atomic-write.ts";
import { isSqliteFile, legacyInstallIn, legacyKeyIn, NEXT_SUFFIX } from "./database-files.ts";
import { identityKey } from "./path-identity.ts";
import { ensurePrivateStateDirectory } from "./private-state.ts";
import {
  admitHarnessKeyHome,
  databaseBindingRecord,
  databaseKeyFile,
  databaseKeyName,
  databaseSaltFile,
  openStoreRegistry,
  registerHarnessStore,
  type AdmittedKeyHome,
} from "./self-protection/key-home.ts";

/**
 * How a store KIND answers "does the file at `path` hold values sealed under
 * its key?" — `true`/`false` for a file of that kind, `undefined` for one it
 * does not recognise (or cannot read). Each kind's owner registers one (the
 * timeline store: sealed originals; the web database: encrypted fields), so
 * THE key owner below decides mint-or-refuse over every store sharing a key
 * (a3-design H2) — never one store's own view of itself.
 */
export type CiphertextProbe = (path: string) => boolean | undefined;
const CIPHERTEXT_PROBES: CiphertextProbe[] = [];

/** Register a store kind's ciphertext probe (once per kind; its owner module calls it at load). */
export function registerCiphertextProbe(probe: CiphertextProbe): void {
  if (!CIPHERTEXT_PROBES.includes(probe)) CIPHERTEXT_PROBES.push(probe);
}

/**
 * Another registered store SHARING this database's key (a key is named by
 * its store's folder, so every store of that folder shares it) that holds
 * ciphertext under it — or whose kind no loaded probe knows (fail closed):
 * minting a new key for this database would silently orphan that store's
 * values. `undefined` when none does.
 */
function sharingStoreHoldingCiphertext(keyHome: AdmittedKeyHome, dbPath: string): string | undefined {
  // This database's own record is left out BY IDENTITY (a record spelled
  // through a link is still this file), never by spelling.
  const identity = (path: string): string | undefined => (existsSync(path) ? identityKey(statSync(path, { bigint: true })) : undefined);
  const own = identity(dbPath);
  for (const path of openStoreRegistry(keyHome).sharingKey(databaseKeyName(dbPath))) {
    const store = identity(path);
    if (store === undefined || store === own) continue;
    const answers = CIPHERTEXT_PROBES.map((probe) => probe(path));
    if (answers.includes(true) || !answers.includes(false)) return path;
  }
  return undefined;
}

export const PERSISTED_KEY_BYTES = ROOT_POLICY.forensics.algorithms.keyBytes;
const KEY_MODE = ROOT_POLICY.filesystemInfrastructure.privateState.fileMode;
/**
 * Passphrase mode's scrypt salt is RANDOM per database (cred-audit CRED-F13: a
 * salt shared by every installation lets one precomputed dictionary serve all
 * of them), persisted in the key home beside where the key file would be,
 * published exactly like the key (0600, no overwrite, verified). It is not a
 * secret; losing it for a database that holds ciphertext is refused like a
 * lost key, never replaced.
 */
const SALT_BYTES = PERSISTED_KEY_BYTES;
/**
 * The one salt every installation shared before salts were random. A database
 * that already holds ciphertext under it ADOPTS it (its salt file is written
 * with these exact bytes) instead of being re-encrypted: the same key also
 * seals its timeline's protected originals and the memory entries inside that
 * append-only ledger, and a ledger row cannot be rewritten. New databases
 * never use it.
 */
const ADOPTED_FIXED_SALT = Buffer.from("bridlewise-web-db-encryption-salt-v2", "utf8");
/** The adopted fixed salt's length — how the re-key tool recognises it (a random salt is {@link SALT_BYTES}). */
export const ADOPTED_FIXED_SALT_BYTES = ADOPTED_FIXED_SALT.length;
export type PersistedKeyOptions = Readonly<{
  dbPath: string;
  /** The admitted key home (`self-protection/key-home.ts`); absent: the one the environment names, admitted here. */
  keyHome?: AdmittedKeyHome;
  passphrase?: string;
  /** The owning store admits creation before opening or migrating its state.
   * `adopt-fixed-salt` (passphrase mode only; the key-file mode reads it as
   * `load-only`): the store has decided its database predates random salts. */
  disposition: "create-or-load" | "load-only" | "adopt-fixed-salt";
}>;
export type PersistedKey = Readonly<{
  key: KeyObject;
  persisted: boolean;
  filePath: string | null;
  /**
   * The key home's binding record for this key (`databaseBindingRecord`):
   * where the store records that its fields are bound, and where migration 20
   * learns it must never re-seal an unbound value. Absent for an ephemeral
   * key (an in-memory database starts empty).
   */
  bindingRecord?: string;
}>;

function fail(code: string): never {
  reportBestEffortFailure();
  throw new SecurityError("Persistent encryption key could not be admitted", code);
}
export function persistedKeyDisposition(dbPath: string, readOnly: boolean): PersistedKeyOptions["disposition"] {
  if (readOnly) return "load-only";
  if (dbPath === ":memory:") return "create-or-load";
  try { statSync(dbPath); return "load-only"; } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return "create-or-load";
    return fail("persisted_key_source_unavailable");
  }
}
function closeOwned(fd: number): void {
  try { closeSync(fd); } catch { return fail("persisted_key_close_failed"); }
}
function syncDirectory(path: string): void {
  const fd = openSync(dirname(path), constants.O_RDONLY);
  let failed = false;
  try { fsyncSync(fd); } catch { failed = true; return fail("persisted_key_sync_failed"); }
  finally { try { closeOwned(fd); } catch (error) { if (!failed) throw error; } }
}
function readKey(path: string, admitsSize: (bytes: number) => boolean = (bytes) => bytes === PERSISTED_KEY_BYTES): Buffer | undefined {
  let fd: number;
  // Admission must reach fstat even for a FIFO; a blocking open would wait
  // for a writer before we could refuse this non-regular key source.
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    return fail("persisted_key_read_failed");
  }
  let failed = false;
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || !admitsSize(before.size) || (before.mode & 0o7777) !== KEY_MODE) {
      return fail("persisted_key_file_invalid");
    }
    const expected = before.size;
    const bytes = Buffer.alloc(expected + 1);
    let read = 0;
    while (read < bytes.length) {
      const count = readSync(fd, bytes, read, bytes.length - read, null);
      if (count === 0) break;
      read += count;
    }
    const after = fstatSync(fd);
    if (read !== expected || after.size !== expected || (after.mode & 0o7777) !== KEY_MODE) {
      return fail("persisted_key_file_invalid");
    }
    // Every opener establishes its own required sync acknowledgement, including
    // a loser that can read immediately after link but before the winner syncs.
    fsyncSync(fd);
    syncDirectory(path);
    return bytes.subarray(0, expected);
  } catch (error) {
    failed = true;
    if (error instanceof SecurityError) throw error;
    return fail("persisted_key_read_failed");
  } finally { try { closeOwned(fd); } catch (error) { if (!failed) throw error; } }
}
/**
 * Load the owned file at `path`, or publish `mint()` there once (never over
 * another): through THE ONE exclusive writer (`atomicWriteFile` exclusive +
 * durable: a complete, fsynced private temporary linked under the name only
 * if it is free, then the folder fsynced — a power cut can lose neither the
 * bytes nor the key's directory entry), and the winner of a race is read back
 * and admitted like any existing key.
 */
function loadOrCreate(path: string, dbPath: string, mint: (() => Buffer) | undefined, admitsSize?: (bytes: number) => boolean): Buffer {
  const existing = readKey(path, admitsSize);
  if (existing !== undefined) return existing;
  if (mint === undefined) {
    reportBestEffortFailure();
    throw new SecurityError(missingKeyMessage(path, dbPath), "persisted_key_missing");
  }
  // Minted before publication: a refusal to mint (another store sharing the
  // key holds ciphertext) is the owner's answer, never a publication failure.
  const minted = mint();
  ensurePrivateStateDirectory(dirname(path));
  try {
    publishKeyMaterial(path, minted);
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) return fail("persisted_key_publication_failed");
  }
  const winner = readKey(path, admitsSize);
  if (winner === undefined) return fail("persisted_key_publication_uncertain");
  return winner;
}

/**
 * PUBLISH KEY MATERIAL at `path` — THE ONE key writer (a new key, a relocated
 * one, a staged next key, a retired one): private (0600), complete and fsynced
 * before the name exists, the folder fsynced after (`atomicWriteFile` durable),
 * so a crash leaves the whole file or nothing. Exclusive (`EEXIST` when the
 * name is taken) unless `replace` (the one-slot retired key).
 */
export function publishKeyMaterial(path: string, bytes: Uint8Array, replace = false): void {
  const written = atomicWriteFile(path, bytes, { exclusive: !replace, durable: true, exactMode: KEY_MODE, createParentDirectories: false });
  if (!written.success) throw written.error;
}

/**
 * RECORD that the key behind `bindingRecord` has sealed bound fields (once;
 * published complete, the folder fsynced). Called by the store once its
 * database is at the bound schema.
 */
export function recordFieldsBound(bindingRecord: string): void {
  if (existsSync(bindingRecord)) return;
  const written = atomicWriteFile(bindingRecord, "bound\n", { exclusive: true, durable: true, exactMode: KEY_MODE, createParentDirectories: false });
  if (!written.success && (written.error as { code?: unknown } | undefined)?.code !== "EEXIST") throw written.error;
}

/**
 * A RE-KEY THAT DID NOT FINISH is refused at every open: its fields may
 * already be sealed under the staged next key while the key file still holds
 * the old one, and anything written now would be sealed under a key the
 * finished re-key retires. The key tool finishes it (`rekey` again).
 */
function refuseRekeyInFlight(keyPath: string, dbPath: string): void {
  if (!existsSync(`${keyPath}${NEXT_SUFFIX}`)) return;
  reportBestEffortFailure();
  throw new SecurityError(
    `A re-key of ${resolve(dbPath)} did not finish (the next key ${keyPath}${NEXT_SUFFIX} is still staged). Finish it before starting: \`npm run db-key -- rekey --db ${resolve(dbPath)}\`.`,
    "persisted_key_rekey_in_flight",
  );
}

/**
 * WHAT TO DO ABOUT A MISSING KEY, in this database's own words: its path, and
 * whether the old layout's key still sits beside it (then the relocation, by
 * its real path) — else the key home's backup is the only way back.
 */
function missingKeyMessage(keyPath: string, dbPath: string): string {
  const database = resolve(dbPath);
  const legacy = legacyInstallIn(dirname(database));
  const head = `The database ${database} already exists and its key is not in the key home (${keyPath}). A key is never re-created for existing data.`;
  if (legacy !== undefined) {
    return `${head} Its old key is still beside it (${legacy.key}): move it into the key home with \`npm run db-key -- relocate --db ${database}\` (the admin action database.key.relocate), then start again.`;
  }
  return `${head} No old key sits beside it either: restore the key home (${dirname(keyPath)}) from its backup.`;
}

/**
 * The key home a database's key lives in: the caller's admitted one, or the
 * harness's key home through THE ONE admission (neighbours: the harness
 * checkout, the system temp folder, this database's folder — a key beside its
 * database is exactly what the key home replaces).
 */
function keyHomeFor(options: PersistedKeyOptions): AdmittedKeyHome {
  return options.keyHome ?? admitHarnessKeyHome([options.dbPath]);
}

/**
 * An install that still keeps its old key BESIDE this database (the layout
 * before the key home) is moved, never re-keyed: whatever its owner decided,
 * its key is only ever loaded, and a missing one is refused naming the
 * relocation (`missingKeyMessage`). A new key minted here would leave the old
 * one, and whatever it sealed, orphaned beside the database.
 */
function keptBesideItsDatabase(dbPath: string): boolean {
  // Asked of THIS database directly: a key beside it and its own SQLite
  // header — never through a bounded listing of its siblings (filler files
  // would push it out of the bound; sec-e-correctness M-4).
  const database = resolve(dbPath);
  return legacyKeyIn(dirname(database)) !== undefined && isSqliteFile(database);
}

export function resolvePersistedKey(options: PersistedKeyOptions): PersistedKey {
  const passphrase = options.passphrase ?? "";
  const inMemory = options.dbPath === ":memory:";
  const random = () => randomBytes(SALT_BYTES);
  if (inMemory) {
    // An in-memory database outlives nothing: an ephemeral key (or salt), no file.
    const key = passphrase.length > 0 ? scryptSync(passphrase, random(), PERSISTED_KEY_BYTES) : randomBytes(PERSISTED_KEY_BYTES);
    return Object.freeze({ key: createSecretKey(key), persisted: false, filePath: null });
  }
  const keyHome = keyHomeFor(options);
  const disposition = options.disposition !== "load-only" && keptBesideItsDatabase(options.dbPath) ? "load-only" : options.disposition;
  // Every database a harness key is admitted for is a harness store: the
  // keep-out list refuses it, by identity, wherever it lives.
  registerHarnessStore(keyHome, options.dbPath);
  refuseRekeyInFlight(passphrase.length > 0 ? databaseSaltFile(keyHome, options.dbPath) : databaseKeyFile(keyHome, options.dbPath), options.dbPath);
  // THE ONE MINT DECISION over every store sharing the key: a new key (or
  // salt) is minted only when no OTHER store sharing it holds ciphertext —
  // an empty ledger beside a sealed one used to mint a replacement that left
  // every seal of its neighbour unopenable (a3-design H2).
  const guarded = (mint: () => Buffer, keyPath: string) => (): Buffer => {
    const holder = sharingStoreHoldingCiphertext(keyHome, options.dbPath);
    if (holder === undefined) return mint();
    reportBestEffortFailure();
    throw new SecurityError(`${missingKeyMessage(keyPath, options.dbPath)} ${holder} shares that key and holds values sealed under it, so a new key is not minted for ${resolve(options.dbPath)} either.`, "persisted_key_missing");
  };
  if (passphrase.length > 0) {
    // A retained database with a missing salt needs recovery, never replacement.
    const saltPath = databaseSaltFile(keyHome, options.dbPath);
    const mint = disposition === "create-or-load" ? guarded(random, saltPath) : disposition === "adopt-fixed-salt" ? () => Buffer.from(ADOPTED_FIXED_SALT) : undefined;
    const salt = loadOrCreate(saltPath, options.dbPath, mint,
      (bytes) => bytes === SALT_BYTES || bytes === ADOPTED_FIXED_SALT.length);
    return Object.freeze({ key: createSecretKey(scryptSync(passphrase, salt, PERSISTED_KEY_BYTES)), persisted: true, filePath: null, bindingRecord: databaseBindingRecord(keyHome, options.dbPath) });
  }
  const filePath = databaseKeyFile(keyHome, options.dbPath);
  // A retained database with a missing key needs recovery, never replacement.
  const mint = disposition === "create-or-load" ? guarded(() => randomBytes(PERSISTED_KEY_BYTES), filePath) : undefined;
  return Object.freeze({ key: createSecretKey(loadOrCreate(filePath, options.dbPath, mint)), persisted: true, filePath, bindingRecord: databaseBindingRecord(keyHome, options.dbPath) });
}
