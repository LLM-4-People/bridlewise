/**
 * Database field encryption — app-level encryption-at-rest for sensitive
 * columns using Node's built-in `crypto` module (AES-256-GCM).
 *
 * THE BUG THIS REPLACES: the previous `db-encryption.ts` generated a
 * per-process random key when `HARNESS_WEB_DB_KEY` was unset. On every
 * server restart a NEW random key was generated, so all previously-
 * encrypted `enc:` fields became unrecoverable ciphertext — every project
 * lost access to its directory. The previous fix REMOVED encryption
 * entirely, leaving the DB plaintext at rest. The user rejected that:
 * "protecting data also means protecting the database... we need to
 * encrypt everything in the db per browser session, not just path."
 *
 * THE CORRECT FIX: persist the key. The AES-256 key lives in a file in the
 * KEY HOME (`engine/src/filesystem/self-protection/key-home.ts`: one private
 * per-user folder outside every checkout, state folder and grant; mode 0600).
 * On first run the key is generated (32 random bytes) and written. On every subsequent run
 * the key is loaded from the file. The key therefore SURVIVES server
 * reboots, so all existing `enc:` data can be decrypted. This is the fix
 * the user asked for: "The previous bug was that the key was random
 * per-process. The fix is NOT to remove encryption — it's to PERSIST the
 * key."
 *
 * Key sources (in priority order, all PERSISTED):
 * 1. `HARNESS_WEB_DB_KEY` passphrase → scrypt-derived key over a RANDOM
 * per-database salt kept in the key home (the passphrase is the persisted
 * secret; no key file is used). A database that predates random salts and
 * already holds ciphertext adopts the old fixed one (`resolveDatabaseKey`)
 * until the re-key tool (`scripts/db-key.ts rekey`) retires it.
 * 2. Default → load-or-create a 32-byte random key file (mode 0600) in the
 * key home. This is the DEFAULT for real file DBs; it requires no env var.
 * 3. `:memory:` DB → an ephemeral in-process key (no file). Used by tests
 * that do not exercise cross-process persistence.
 *
 * Encrypted columns: `ENCRYPTED_COLUMNS` below (the one list; every read and
 * write goes through its row doors `openRow`/`sealRow`). Each value is BOUND
 * to its table, column, row, parents and owning user (AEAD associated data,
 * `fieldBinding` over the codec's `fieldAad`).
 *
 * NOT encrypted (rule: IDs/timestamps/status/role stay plaintext so they
 * remain queryable and indexable): id, project_id, chat_id, message_id,
 * created_at, updated_at, timestamp, status, role, session_id,
 * check_name, model_id, pinned, event_type, event_id, run_id,
 * model_event_type, duration_ms.
 *
 * Format: `enc:` + base64(iv[12] + authTag[16] + ciphertext). The `enc:`
 * prefix identifies stored ciphertext. Live writes always encrypt plaintext,
 * including strings that already start with that prefix. Existing-ciphertext
 * admission belongs to versioned migrations, never the plaintext write API.
 *
 * No new runtime deps: only `node:crypto` + `node:fs`.
 */

import { KeyObject } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { WebError } from "../kernel/errors.ts";
import { serverConfig } from "../kernel/config.ts";
import { BOUND_FIELDS_SCHEMA_VERSION, FIRST_ENCRYPTED_SCHEMA_VERSION } from "./schema.ts";
import { resolvePersistedKey, persistedKeyDisposition, registerCiphertextProbe, PERSISTED_KEY_BYTES, type AdmittedKeyHome, type PersistedKey, type PersistedKeyOptions, createEncryptedFieldCodec, ENCRYPTED_FIELD_PREFIX, ENCRYPTED_FIELD_IV_BYTES, ENCRYPTED_FIELD_TAG_BYTES, UNBOUND_FIELD, fieldAad, ownerSealAad, OWNER_SEAL_METADATA_KEY } from "../kernel/canonical.ts";

// ── Configurables (algorithm constants — NOT user-tunable, fixed by AES-256-GCM) ──

/** AES-256 key length in bytes (single owner — migrations v4 imports this). */
export const DB_KEY_LENGTH = PERSISTED_KEY_BYTES; // AES-256
/** GCM IV/nonce length in bytes (single owner — migrations v4 imports this). */
export const DB_IV_LENGTH = ENCRYPTED_FIELD_IV_BYTES; // 96-bit nonce (GCM standard)
/** GCM authentication tag length in bytes (single owner — migrations v4 imports this). */
export const DB_AUTH_TAG_LENGTH = ENCRYPTED_FIELD_TAG_BYTES; // 128-bit authentication tag
const ENCRYPTION_PREFIX = ENCRYPTED_FIELD_PREFIX;
// ── What each encrypted value is bound to ──

/**
 * THE ENCRYPTED COLUMNS, and what each table's values are bound to: the
 * OWNING USER (the root of every ownership chain, always), the row's direct
 * `parents` (its chat, message or project) and the row itself (`key`) — so a
 * ciphertext copied into another row, column or table fails authentication,
 * and so does a row whose chain was edited to reach another user at ANY
 * depth: re-parenting a chat into another user's project leaves every one of
 * its messages and tool calls unreadable to that user (secc-security
 * SECC-V-A1; the chain used to stop at the immediate parent, so the children
 * followed a moved chat). Parent columns never change after insert (a guard
 * pins it). `owner`/`ownerJoin` say how a BULK reader (the re-key tool) reaches
 * each row's owning user; every per-request read already holds it. One list:
 * the reads, the writes and the key tool use it (v20 has its own frozen copy).
 */
export const ENCRYPTED_COLUMNS = {
  projects: { key: "id", parents: [], columns: ["name", "path", "config_overlay"], owner: "t.user_id", ownerJoin: "" },
  chats: { key: "id", parents: ["project_id"], columns: ["title"], owner: "p.user_id", ownerJoin: "LEFT JOIN projects p ON p.id = t.project_id" },
  messages: { key: "id", parents: ["chat_id"], columns: ["content", "metadata"], owner: "p.user_id", ownerJoin: "LEFT JOIN chats c ON c.id = t.chat_id LEFT JOIN projects p ON p.id = c.project_id" },
  tool_calls: { key: "id", parents: ["message_id"], columns: ["call_id", "tool_name", "public_projection", "input", "output"], owner: "p.user_id", ownerJoin: "LEFT JOIN messages m ON m.id = t.message_id LEFT JOIN chats c ON c.id = m.chat_id LEFT JOIN projects p ON p.id = c.project_id" },
  metrics_snapshots: { key: "id", parents: ["chat_id"], columns: ["snapshot"], owner: "p.user_id", ownerJoin: "LEFT JOIN chats c ON c.id = t.chat_id LEFT JOIN projects p ON p.id = c.project_id" },
  auto_checks: { key: "id", parents: ["project_id", "chat_id"], columns: ["output"], owner: "p.user_id", ownerJoin: "LEFT JOIN projects p ON p.id = t.project_id" },
  timeline_refs: { key: "id", parents: ["chat_id"], columns: ["metadata"], owner: "p.user_id", ownerJoin: "LEFT JOIN chats c ON c.id = t.chat_id LEFT JOIN projects p ON p.id = c.project_id" },
  users: { key: "id", parents: [], columns: ["password_hash"], owner: "t.id", ownerJoin: "" },
  user_model_prefs: { key: "user_id", parents: [], columns: ["config_json"], owner: "t.user_id", ownerJoin: "" },
  user_prompt_prefs: { key: "user_id", parents: [], columns: ["prefs_json"], owner: "t.user_id", ownerJoin: "" },
} as const satisfies Readonly<Record<string, Readonly<{ key: string; parents: readonly string[]; columns: readonly string[]; owner: string; ownerJoin: string }>>>;
export type EncryptedTable = keyof typeof ENCRYPTED_COLUMNS;
export type EncryptedColumn<T extends EncryptedTable> = (typeof ENCRYPTED_COLUMNS)[T]["columns"][number];

/** The database fields' binding domain (the codec's registry, `fieldAad`). */
export const FIELD_BINDING_DOMAIN = "bw-field-v1";

declare const BOUND: unique symbol;
/** The associated data a value is sealed under; only `fieldBinding` (and `UNBOUND`) make one. */
export type FieldBinding = string & { readonly [BOUND]: true };

/**
 * What `table.column` of `row`, owned by `ownerUserId`, is bound to:
 * `fieldAad("bw-field-v1", [table, column, key, owner, ...parents])`. `row`
 * carries the key and EVERY parent column (a whole stored row does; a writer
 * names them) — a missing one, or no owner, is refused, never bound as
 * "none", so a writer that forgot it fails at once instead of sealing a value
 * its reader cannot open.
 */
export function fieldBinding<T extends EncryptedTable>(table: T, column: EncryptedColumn<T>, row: Readonly<Record<string, unknown>>, ownerUserId: string): FieldBinding {
  const shape: Readonly<{ key: string; parents: readonly string[] }> = ENCRYPTED_COLUMNS[table];
  const key = row[shape.key];
  if (typeof key !== "string" || key.length === 0 || typeof ownerUserId !== "string" || ownerUserId.length === 0 || shape.parents.some((name) => !(name in row))) {
    throw new WebError(`Encrypted ${table}.${column} has no complete ownership chain to bind to`, "db_field_binding_invalid");
  }
  const parents = shape.parents.map((name) => { const value = row[name]; return value === null || value === undefined ? null : String(value); });
  return fieldAad(FIELD_BINDING_DOMAIN, [table, column, key, ownerUserId, ...parents]) as FieldBinding;
}

/**
 * What a MEMORY entry's content is bound to: its owning user and the seal id
 * minted with it — the codec's one owner-seal recipe (`ownerSealAad`, the
 * same the ledger's projection uses to keep it intact). Retargeting the
 * entry's user by an edit of the ledger document leaves the content
 * unreadable (secc-design M6). Entries written before binding carry no seal
 * id and stay `UNBOUND` (the ledger is append-only; they cannot be re-sealed).
 */
export function memoryBinding(ownerUserId: string, sealId: string): FieldBinding {
  const aad = ownerSealAad({ metadata: { userId: ownerUserId, [OWNER_SEAL_METADATA_KEY]: sealId } });
  if (aad === undefined) throw new WebError("A memory entry has no owner or seal to bind to", "db_field_binding_invalid");
  return aad as FieldBinding;
}

/** A bulk read of `table` with each row's owning user (`owner_user_id`) and its `rowid` (`rowid_`) beside its columns. */
export function ownedRowsSql(table: EncryptedTable): string {
  const shape = ENCRYPTED_COLUMNS[table];
  return `SELECT t.rowid AS rowid_, t.*, ${shape.owner} AS owner_user_id FROM ${table} t ${shape.ownerJoin}`;
}

/** The empty binding (the engine's `UNBOUND_FIELD`): the pre-v20 fields migrations read and rewrite. */
export const UNBOUND = UNBOUND_FIELD as FieldBinding;

/**
 * THE ROW DOORS: every encrypted column of `table` present in `row`, opened
 * (or sealed) under its chain — one call per row, so a column added to
 * {@link ENCRYPTED_COLUMNS} is encrypted and decrypted everywhere, never
 * wherever someone remembered (secc-design M7). Other columns pass through.
 */
export function openRow<T extends EncryptedTable>(crypto: DbCrypto, table: T, row: Readonly<Record<string, unknown>>, ownerUserId: string): Record<string, unknown> {
  const opened: Record<string, unknown> = { ...row };
  for (const column of ENCRYPTED_COLUMNS[table].columns as readonly EncryptedColumn<T>[]) {
    if (!(column in row)) continue;
    opened[column] = crypto.decryptField(row[column] as string | null | undefined, fieldBinding(table, column, row, ownerUserId));
  }
  return opened;
}

/** The sealing twin of {@link openRow}: `row` holds plaintext for the encrypted columns it names. */
export function sealRow<T extends EncryptedTable>(crypto: DbCrypto, table: T, row: Readonly<Record<string, unknown>>, ownerUserId: string): Record<string, unknown> {
  const sealed: Record<string, unknown> = { ...row };
  for (const column of ENCRYPTED_COLUMNS[table].columns as readonly EncryptedColumn<T>[]) {
    if (!(column in row)) continue;
    sealed[column] = crypto.encryptField(row[column] as string | null | undefined, fieldBinding(table, column, row, ownerUserId));
  }
  return sealed;
}

// ── Types ──

export type DbCrypto = Readonly<{
  /** Encrypt a plaintext string bound to `binding`. Returns `enc:` + base64(iv+tag+ciphertext). */
  readonly encryptField: (plaintext: string | null | undefined, binding: FieldBinding) => string | null;
  /** Authenticate stored ciphertext under `binding`; nonempty plaintext, corruption or another binding is a fixed typed refusal. */
  readonly decryptField: (ciphertext: string | null | undefined, binding: FieldBinding) => string | null;
  /** Whether stored ciphertext authenticates under `binding` (no plaintext leaves). */
  readonly authenticates: (ciphertext: string, binding: FieldBinding) => boolean;
  /** Whether the key is persisted (file or passphrase). Ephemeral keys return false. */
  readonly isPersisted: () => boolean;
  /** The resolved key file path (for diagnostics), or null when ephemeral/passphrase. */
  readonly keyFilePath: () => string | null;
  /** The key home's binding record for this key (`PersistedKey.bindingRecord`), or undefined for an ephemeral key. */
  readonly bindingRecord?: string;
}>;

export type DbCryptoOptions = Readonly<{
  /** The DB file path; its key lives in the key home. */
  readonly dbPath: string;
  /** An admitted key home; absent: the one the environment names. */
  readonly keyHome?: AdmittedKeyHome;
  /** Optional passphrase (HARNESS_WEB_DB_KEY). When set, no key file is used. */
  readonly passphrase?: string;
  readonly readOnly?: boolean;
}>;

// ── Public API ──

/**
 * Create a DbCrypto instance bound to one key. The key is resolved ONCE
 * (at creation) and cached for the instance lifetime — there is no per-call
 * key derivation, so encrypt/decrypt are cheap.
 */
export function createDbCrypto(options: DbCryptoOptions): DbCrypto {
  return createDbCryptoFromKey(resolveDatabaseKey(options));
}

/**
 * THE ONE key admission for the web database (the process owner
 * `bootstrap-key.ts`, the thread backend and a direct client all ask here).
 * A key (or passphrase salt) is minted only where no ciphertext can be
 * orphaned by it, and a missing one is REFUSED where some can:
 *
 *   - a missing database (or `:memory:`) mints;
 *   - a read-only connection only loads (the writer opened first);
 *   - a database that never reached the first encrypting migration (a v4
 *     install upgrading: its rows are plaintext), or whose encrypted columns
 *     hold nothing yet, mints — a new key loses nothing there;
 *   - a database at v5+ that HOLDS ciphertext only loads: a key minted for it
 *     would seal new rows no restored key could read, and leave the old ones
 *     unreadable (data loss). Its missing key is refused, never replaced;
 *   - except that a passphrase database written before random salts (schema
 *     below v20, so no salt file was ever needed) adopts the old fixed salt,
 *     keeping its ciphertext and its timeline readable.
 *
 * An unreadable file is never "older" (see `storedDatabaseFacts`): nothing is
 * minted or adopted for it.
 */
export function resolveDatabaseKey(options: DbCryptoOptions): PersistedKey {
  return resolvePersistedKey({ ...options, disposition: databaseKeyDisposition(options) });
}

function databaseKeyDisposition(options: DbCryptoOptions): PersistedKeyOptions["disposition"] {
  const readOnly = options.readOnly === true;
  const disposition = persistedKeyDisposition(options.dbPath, readOnly);
  if (readOnly || disposition !== "load-only") return disposition;
  const stored = storedDatabaseFacts(options.dbPath);
  if (stored.schemaVersion < FIRST_ENCRYPTED_SCHEMA_VERSION || !stored.holdsCiphertext) return "create-or-load";
  return options.passphrase && stored.schemaVersion < BOUND_FIELDS_SCHEMA_VERSION ? "adopt-fixed-salt" : "load-only";
}

/**
 * What an existing database file says about its key: its highest applied
 * migration (0 when none yet) and whether any encrypted column holds a value.
 * An unreadable file is never "older", so nothing is adopted or minted for it.
 * The probe is a second connection, opened before the store's own: it waits
 * for a concurrent writer like every connection (the configured busy timeout).
 */
function storedDatabaseFacts(dbPath: string): Readonly<{ schemaVersion: number; holdsCiphertext: boolean; webDatabase?: boolean }> {
  let db: DatabaseSync;
  try { db = new DatabaseSync(dbPath, { readOnly: true, timeout: serverConfig.dbBusyTimeoutMs }); } catch { return NEVER_OLDER; }
  try {
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
    const webDatabase = tables.has("schema_version") && Object.keys(ENCRYPTED_COLUMNS).some((table) => tables.has(table));
    const schemaVersion = tables.has("schema_version")
      ? Number((db.prepare("SELECT MAX(version) AS version FROM schema_version").get() as { version?: number | null } | undefined)?.version ?? 0)
      : 0;
    // Only the columns this (possibly old) schema already has are asked about.
    const holdsCiphertext = Object.entries(ENCRYPTED_COLUMNS).some(([table, shape]) => {
      if (!tables.has(table)) return false;
      const present = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
      return shape.columns.some((column) => present.has(column)
        && db.prepare(`SELECT 1 FROM ${table} WHERE ${column} LIKE '${ENCRYPTION_PREFIX}%' LIMIT 1`).get() !== undefined);
    });
    return { schemaVersion, holdsCiphertext, webDatabase };
  } catch {
    // Not a database, damaged, or held past the busy timeout: never "older".
    return NEVER_OLDER;
  } finally { db.close(); }
}

/** An unreadable file's facts: never "older" (nothing is minted or adopted for it), always holding ciphertext. */
const NEVER_OLDER = Object.freeze({ schemaVersion: Number.POSITIVE_INFINITY, holdsCiphertext: true });

/**
 * THE WEB DATABASE'S CIPHERTEXT PROBE for the one key owner
 * (`persisted-key.ts`): a store sharing this database's key is asked before a
 * key is minted for another (a3-design H2). A file this module does not
 * recognise as a web database (or cannot read) is not its kind.
 */
registerCiphertextProbe((path) => {
  const stored = storedDatabaseFacts(path);
  return stored.webDatabase === true ? stored.holdsCiphertext : undefined;
});

/**
 * WHAT A KEY SAYS ABOUT A DATABASE: one sealed value per encrypted column is
 * tried under its row's binding (its owning user from `ownedRowsSql`), else
 * unbound (a field no owner reaches, or one written before binding) —
 * `opens` when a sampled value opens (a wrong key opens none), `wrong` when
 * values were tried and NONE opened, `empty` when nothing is sealed yet
 * (nothing is proven). One damaged value beside readable ones is damage, not
 * a wrong key: it never stops a start. The one proof for the server's open (a
 * wrong key is refused before it seals a row the right key could not read)
 * and the key tool (relocate, rekey).
 */
export function databaseKeyProof(db: DatabaseSync, crypto: DbCrypto): "opens" | "empty" | "wrong" {
  let opened = 0, failed = 0;
  for (const [table, shape] of Object.entries(ENCRYPTED_COLUMNS) as [EncryptedTable, (typeof ENCRYPTED_COLUMNS)[EncryptedTable]][]) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) === undefined) continue;
    const present = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
    for (const column of shape.columns) {
      if (!present.has(column)) continue;
      const row = db.prepare(`${ownedRowsSql(table)} WHERE t.${column} LIKE '${ENCRYPTION_PREFIX}%' LIMIT 1`).get() as Record<string, unknown> | undefined;
      if (row === undefined) continue;
      if (openedBinding(crypto, table, column as EncryptedColumn<typeof table>, row) === undefined) failed += 1; else opened += 1;
    }
  }
  return opened > 0 ? "opens" : failed > 0 ? "wrong" : "empty";
}

/**
 * The binding a stored value (a row read through `ownedRowsSql`) opens under —
 * its chain, else unbound — or undefined.
 */
export function openedBinding<T extends EncryptedTable>(crypto: DbCrypto, table: T, column: EncryptedColumn<T>, row: Readonly<Record<string, unknown>>): FieldBinding | undefined {
  const value = row[column] as string;
  const owner = row["owner_user_id"];
  const bindings = typeof owner === "string" && owner.length > 0 ? [fieldBinding(table, column, row, owner), UNBOUND] : [UNBOUND];
  return bindings.find((binding) => crypto.authenticates(value, binding));
}

/** Build local operations around an admitted native capability. Worker startup
 * clones KeyObject, never these closures or serialized key bytes. */
export function createDbCryptoFromKey(admitted: PersistedKey): DbCrypto {
  const { key, persisted, filePath, bindingRecord } = admitted;
  if (!(key instanceof KeyObject) || key.type !== "secret" || key.symmetricKeySize !== DB_KEY_LENGTH || typeof persisted !== "boolean" || (filePath !== null && typeof filePath !== "string") || (bindingRecord !== undefined && typeof bindingRecord !== "string")) {
    throw new WebError("Database encryption key capability is invalid", "db_key_capability_invalid");
  }
  const codec = createEncryptedFieldCodec(key);
  function encryptField(plaintext: string | null | undefined, binding: FieldBinding): string | null {
    if (plaintext === null || plaintext === undefined || plaintext.length === 0) return plaintext ?? null;
    return codec.encrypt(plaintext, binding);
  }
  function decryptField(ciphertext: string | null | undefined, binding: FieldBinding): string | null {
    if (ciphertext === null || ciphertext === undefined || ciphertext.length === 0) return ciphertext ?? null;
    try { return codec.decrypt(ciphertext, binding); }
    catch { throw new WebError("Encrypted database field could not be authenticated", "db_decryption_failed"); }
  }

  return Object.freeze({
    encryptField,
    decryptField,
    authenticates: (ciphertext: string, binding: FieldBinding) => codec.authenticates(ciphertext, binding),
    isPersisted: () => persisted,
    keyFilePath: () => filePath,
    ...(bindingRecord === undefined ? {} : { bindingRecord }),
  });
}

/**
 * A no-op DbCrypto for callers that explicitly want plaintext (used only
 * by the migration runner when invoked directly without a crypto
 * instance, e.g. migration-mechanics tests). Production code always
 * passes a real createDbCrypto instance via the database client.
 */
export function createNoopDbCrypto(): DbCrypto {
  const identity = (value: string | null | undefined): string | null => value ?? null;
  return Object.freeze({
    encryptField: identity,
    decryptField: identity,
    authenticates: () => true,
    isPersisted: () => false,
    keyFilePath: () => null,
  });
}

/**
 * Whether a stored value is encrypted (has the `enc:` prefix). Used by the
 * migration to skip rows that are already encrypted (idempotent migration).
 */
export function isEncryptedValue(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(ENCRYPTION_PREFIX);
}
