/**
 * Versioned migration runner for the web-slice SQLite projection.
 *
 * Each migration is an idempotent `up(db)` function that applies DDL.
 * Migrations are applied in version order inside a transaction. The
 * `schema_version` table tracks the current version.
 *
 * Adding a migration:
 * 1. Bump `SCHEMA_VERSION_LATEST` in `./schema.ts`.
 * 2. Append a migration here with the matching `version` number.
 * 3. The `up` function MUST be idempotent (use `CREATE TABLE IF NOT
 * EXISTS`, `CREATE INDEX IF NOT EXISTS`, etc.) so a fresh DB and
 * a partially-migrated DB converge to the same state.
 *
 * The schema is documented as "canonical-ready projection — migrates
 * to canonical when the Project entity is admitted." When that happens,
 * a future migration either re-exports from canonical or migrates the
 * data; either way, the version counter keeps moving forward so no
 * data is lost.
 */

import { createDecipheriv, scryptSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { removeDatabaseCopy, writeVerifiedCopy } from "./db-files.ts";
import { serverConfig } from "../kernel/config.ts";
import { webWarn } from "../observability/debug-bridge.ts";
// Raw uniqueness through the canonical owner — seed-row ids stay bare UUIDs
// (the owner's randomUuid, never a direct node:crypto import).
import { randomUuid, bestEffort, preMigrationBackupPath, preMigrationBackups } from "../kernel/canonical.ts";
import { HarnessError } from "../../engine/src/kernel/errors.ts";
import { sha256 } from "../kernel/digest.ts";

import {
  BOUND_FIELDS_SCHEMA_VERSION,
  FIRST_ENCRYPTED_SCHEMA_VERSION,
  SCHEMA_VERSION_LATEST,
  UNDELETABLE_TABLES,
  refuseDeleteTriggerSql,
} from "./schema.ts";
import { createNoopDbCrypto, isEncryptedValue, UNBOUND, DB_KEY_LENGTH, DB_IV_LENGTH, DB_AUTH_TAG_LENGTH, type DbCrypto, type FieldBinding } from "./db-crypto.ts";

// ── Migration shape ──

export type Migration = {
  readonly version: number;
  readonly description: string;
  readonly up: (db: DatabaseSync, crypto: DbCrypto) => void;
};

// ── Migration list (ordered by version) ──

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: "initial projection: projects, chats, messages, tool_calls, metrics_snapshots, auto_checks, timeline_refs",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id              TEXT PRIMARY KEY,
          name            TEXT NOT NULL,
          path            TEXT NOT NULL,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL,
          config_overlay  TEXT
        );

        CREATE TABLE IF NOT EXISTS chats (
          id          TEXT PRIMARY KEY,
          project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          title       TEXT NOT NULL,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL,
          model_id    TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_chats_project_id ON chats(project_id);

        CREATE TABLE IF NOT EXISTS messages (
          id                TEXT PRIMARY KEY,
          chat_id           TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
          role              TEXT NOT NULL CHECK (role IN ('user','assistant','tool','error')),
          content           TEXT NOT NULL,
          created_at        TEXT NOT NULL,
          model_event_type  TEXT,
          run_id            TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
        CREATE INDEX IF NOT EXISTS idx_messages_run_id  ON messages(run_id);

        CREATE TABLE IF NOT EXISTS tool_calls (
          id           TEXT PRIMARY KEY,
          message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          tool_name    TEXT NOT NULL,
          input        TEXT NOT NULL,
          output       TEXT,
          status       TEXT NOT NULL CHECK (status IN ('running','done','error')),
          duration_ms  INTEGER,
          created_at   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tool_calls_message_id ON tool_calls(message_id);

        CREATE TABLE IF NOT EXISTS metrics_snapshots (
          id          TEXT PRIMARY KEY,
          chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
          snapshot    TEXT NOT NULL,
          created_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_metrics_snapshots_chat_id ON metrics_snapshots(chat_id);

        CREATE TABLE IF NOT EXISTS auto_checks (
          id          TEXT PRIMARY KEY,
          project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
          chat_id     TEXT REFERENCES chats(id) ON DELETE CASCADE,
          check_name  TEXT NOT NULL,
          status      TEXT NOT NULL CHECK (status IN ('running','passed','failed','warning')),
          output      TEXT NOT NULL,
          created_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_auto_checks_project_id ON auto_checks(project_id);
        CREATE INDEX IF NOT EXISTS idx_auto_checks_chat_id    ON auto_checks(chat_id);

        CREATE TABLE IF NOT EXISTS timeline_refs (
          id          TEXT PRIMARY KEY,
          chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
          event_id    TEXT NOT NULL,
          event_type  TEXT NOT NULL,
          timestamp   TEXT NOT NULL,
          metadata    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_timeline_refs_chat_id ON timeline_refs(chat_id);
        CREATE INDEX IF NOT EXISTS idx_timeline_refs_event_id ON timeline_refs(event_id);
      `);
    },
  },
  {
    version: 2,
    description: "add session_id to projects for multi-user isolation",
    up: (db) => {
      // SQLite ALTER TABLE ADD COLUMN is idempotent-safe: if the column
      // already exists, the error is caught and ignored (idempotent).
      try {
        db.exec("ALTER TABLE projects ADD COLUMN session_id TEXT DEFAULT NULL");
      } catch (err) {
        // Column already exists — duplicate column name error.
        if (!(err instanceof Error && err.message.includes("duplicate column"))) {
          throw err;
        }
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_projects_session_id ON projects(session_id)");
    },
  },
  {
    version: 3,
    description: "add metadata JSON to messages (rich chat exposure persistence) + pinned flag to chats (sidebar rework)",
    up: (db) => {
      // metadata: JSON-encoded MessageMetadata blob (reasoning, tokens,
      // timing, headers, model, finish reason, context). NULL when absent.
      try {
        db.exec("ALTER TABLE messages ADD COLUMN metadata TEXT");
      } catch (err) {
        if (!(err instanceof Error && err.message.includes("duplicate column"))) {
          throw err;
        }
      }
      // pinned: 0 (unpinned) or 1 (pinned). Used by the sidebar to pin chats
      // to the top of their project group (sidebar rework).
      try {
        db.exec("ALTER TABLE chats ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
      } catch (err) {
        if (!(err instanceof Error && err.message.includes("duplicate column"))) {
          throw err;
        }
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_chats_pinned ON chats(pinned)");
    },
  },
  {
    version: 4,
    description: "remove path encryption — decrypt existing enc: paths to plaintext using the configured key (unrecoverable paths left as-is)",
    up: (db) => {
      // The project path was encrypted at rest with a per-process random key
      // (the default when HARNESS_WEB_DB_KEY was unset). On every server
      // restart a NEW random key was generated, so all previously-encrypted
      // paths became unrecoverable ciphertext — projects lost access to
      // their directory. Paths are not sensitive PII, so they are
      // now stored as plaintext.
      //
     // This migration attempts to recover paths encrypted with a CONFIGURED
      // key (HARNESS_WEB_DB_KEY was set). Paths encrypted with the old random
      // key (the default) are unrecoverable — the key was never persisted and
      // is gone. Those rows keep their `enc:` prefix (broken but preserved;
      // chats/messages survive). The user can re-create the project with the
      // correct path. This is honest: the data was already lost when the
      // random key died.
      const keyConfigured = serverConfig.dbEncryptionKey;
      if (keyConfigured.length === 0) return; // No key → nothing to recover.
      const SALT = "bridlewise-web-db-encryption-salt-v1";
      const PREFIX = "enc:";
      const key = scryptSync(keyConfigured, SALT, DB_KEY_LENGTH);
      const rows = db
        .prepare("SELECT id, path FROM projects WHERE path LIKE 'enc:%'")
        .all() as unknown as ReadonlyArray<{ id: string; path: string }>;
      for (const row of rows) {
        try {
          const packed = Buffer.from(row.path.slice(PREFIX.length), "base64");
          if (packed.length < DB_IV_LENGTH + DB_AUTH_TAG_LENGTH) continue;
          const iv = packed.subarray(0, DB_IV_LENGTH);
          const authTag = packed.subarray(DB_IV_LENGTH, DB_IV_LENGTH + DB_AUTH_TAG_LENGTH);
          const encrypted = packed.subarray(DB_IV_LENGTH + DB_AUTH_TAG_LENGTH);
          const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: DB_AUTH_TAG_LENGTH });
          decipher.setAuthTag(authTag);
          const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
          db.prepare("UPDATE projects SET path = ? WHERE id = ?").run(decrypted, row.id);
        } catch (err) {
          // Decryption failed (wrong key / corrupted data) — the path is
          // unrecoverable. Log and leave as-is; chats/messages survive.
          webWarn("migration", "v4 path decrypt failed", () => ({
            projectId: row.id,
            error: err instanceof Error ? err.message : String(err),
          }));
        }
      }
    },
  },
  {
    version: FIRST_ENCRYPTED_SCHEMA_VERSION,
    description: "encrypt ALL sensitive columns at rest with the persisted key (re-encrypt existing plaintext rows; idempotent)",
    up: (db, crypto) => {
      // The user's binding directive: "we need to encrypt everything in the
      // db per browser session, not just path." This migration encrypts the
      // sensitive columns of every existing row using the PERSISTED key
      // (server/db-crypto.ts). The key is stored in a file (or derived from a
      // passphrase) and SURVIVES reboots — the fix for the per-process random
      // key bug that lost every project's path.
      //
     // Idempotent: rows already `enc:`-prefixed (encrypted by a previous run
      // or by the old per-process key) are LEFT AS-IS. Only PLAINTEXT rows are
      // encrypted. This makes the migration safe to re-run and safe against
      // interruption (a row encrypted before the crash stays encrypted).
      //
     // Legacy `enc:` values encrypted with the old random key (never
      // persisted) cannot be recovered here. Ambiguous enc:-prefixed rows
      // remain untouched. Runtime authentication now refuses them with a
      // fixed typed error; it never exposes ciphertext as recovered content.
      //
     // Encrypted columns:
      // projects: name, path, config_overlay
      // chats: title
      // messages: content, metadata
      // tool_calls: input, output
      // metrics_snapshots: snapshot
      // auto_checks: output
      // timeline_refs: metadata
      // NOT encrypted: ids, timestamps, status, role, session_id, FK ids,
      // tool_name, check_name, model_id, pinned, event_type, event_id,
      // run_id, model_event_type, duration_ms (queryable structural fields).
      const enc = (plaintext: string) => crypto.encryptField(plaintext, UNBOUND);
      // ── projects: name, path, config_overlay ──
      const projects = db
        .prepare("SELECT id, name, path, config_overlay FROM projects")
        .all() as unknown as ReadonlyArray<{ id: string; name: string; path: string; config_overlay: string | null }>;
      for (const row of projects) {
        const upd: string[] = [];
        const params: (string | null)[] = [];
        if (!isEncryptedValue(row.name)) { upd.push("name = ?"); params.push(enc(row.name) as string); }
        if (!isEncryptedValue(row.path)) { upd.push("path = ?"); params.push(enc(row.path) as string); }
        if (row.config_overlay !== null && !isEncryptedValue(row.config_overlay)) {
          upd.push("config_overlay = ?"); params.push(enc(row.config_overlay) as string);
        }
        if (upd.length === 0) continue;
        params.push(row.id);
        db.prepare(`UPDATE projects SET ${upd.join(", ")} WHERE id = ?`).run(...params);
      }
      // ── chats: title ──
      const chats = db.prepare("SELECT id, title FROM chats").all() as unknown as ReadonlyArray<{ id: string; title: string }>;
      for (const row of chats) {
        if (isEncryptedValue(row.title)) continue;
        db.prepare("UPDATE chats SET title = ? WHERE id = ?").run(enc(row.title) as string, row.id);
      }
      // ── messages: content, metadata ──
      const messages = db
        .prepare("SELECT id, content, metadata FROM messages")
        .all() as unknown as ReadonlyArray<{ id: string; content: string; metadata: string | null }>;
      for (const row of messages) {
        const upd: string[] = [];
        const params: (string | null)[] = [];
        if (!isEncryptedValue(row.content)) { upd.push("content = ?"); params.push(enc(row.content) as string); }
        if (row.metadata !== null && !isEncryptedValue(row.metadata)) {
          upd.push("metadata = ?"); params.push(enc(row.metadata) as string);
        }
        if (upd.length === 0) continue;
        params.push(row.id);
        db.prepare(`UPDATE messages SET ${upd.join(", ")} WHERE id = ?`).run(...params);
      }
      // ── tool_calls: input, output ──
      const toolCalls = db
        .prepare("SELECT id, input, output FROM tool_calls")
        .all() as unknown as ReadonlyArray<{ id: string; input: string; output: string | null }>;
      for (const row of toolCalls) {
        const upd: string[] = [];
        const params: (string | null)[] = [];
        if (!isEncryptedValue(row.input)) { upd.push("input = ?"); params.push(enc(row.input) as string); }
        if (row.output !== null && !isEncryptedValue(row.output)) {
          upd.push("output = ?"); params.push(enc(row.output) as string);
        }
        if (upd.length === 0) continue;
        params.push(row.id);
        db.prepare(`UPDATE tool_calls SET ${upd.join(", ")} WHERE id = ?`).run(...params);
      }
      // ── metrics_snapshots: snapshot ──
      const snapshots = db
        .prepare("SELECT id, snapshot FROM metrics_snapshots")
        .all() as unknown as ReadonlyArray<{ id: string; snapshot: string }>;
      for (const row of snapshots) {
        if (isEncryptedValue(row.snapshot)) continue;
        db.prepare("UPDATE metrics_snapshots SET snapshot = ? WHERE id = ?").run(enc(row.snapshot) as string, row.id);
      }
      // ── auto_checks: output ──
      const checks = db
        .prepare("SELECT id, output FROM auto_checks")
        .all() as unknown as ReadonlyArray<{ id: string; output: string }>;
      for (const row of checks) {
        if (isEncryptedValue(row.output)) continue;
        db.prepare("UPDATE auto_checks SET output = ? WHERE id = ?").run(enc(row.output) as string, row.id);
      }
      // ── timeline_refs: metadata ──
      const refs = db
        .prepare("SELECT id, metadata FROM timeline_refs")
        .all() as unknown as ReadonlyArray<{ id: string; metadata: string }>;
      for (const row of refs) {
        if (isEncryptedValue(row.metadata)) continue;
        db.prepare("UPDATE timeline_refs SET metadata = ? WHERE id = ?").run(enc(row.metadata) as string, row.id);
      }
    },
  },
  {
    version: 6,
    description: "tool_settings table — per-session tool enable/disable + MCP config (tools per user)",
    up: (db) => {
      // Per-session tool settings. One row per (session_id, tool_name).
      // The global config's `tools.enabled` list is the DEFAULT; this table
      // is the per-session OVERRIDE (a user disabling a tool here does not
      // affect other users). UNIQUE(session_id, tool_name) so re-toggling
      // replaces the prior row. `config` holds per-user MCP/tool config JSON.
      db.exec(`
        CREATE TABLE IF NOT EXISTS tool_settings (
          id          TEXT PRIMARY KEY,
          session_id  TEXT NOT NULL,
          tool_name   TEXT NOT NULL,
          enabled     INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          config      TEXT,
          updated_at  TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_settings_session_tool
          ON tool_settings(session_id, tool_name);
        CREATE INDEX IF NOT EXISTS idx_tool_settings_session_id
          ON tool_settings(session_id);
      `);
    },
  },
  {
    version: 7,
    description: "add 'event' role to messages CHECK constraint (inline chat events: hallucination, steering, bias, self-healing, error)",
    up: (db) => {
      // SQLite cannot ALTER a CHECK constraint in-place. The standard
      // pattern is: create a new table with the updated constraint, copy
      // data, drop the old table, rename. Idempotent: if the messages
      // table already has 'event' in its CHECK (re-run after success),
      // the copy detects no old table and exits early.
      const hasOldTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'")
        .get() !== undefined;
      const checkHasEvent = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'")
        .get() as { sql?: string } | undefined;
      const alreadyMigrated = checkHasEvent?.sql?.includes("'event'") ?? false;

      if (hasOldTable && !alreadyMigrated) {
        db.exec(`
          CREATE TABLE messages_new (
            id                TEXT PRIMARY KEY,
            chat_id           TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
            role              TEXT NOT NULL CHECK (role IN ('user','assistant','tool','error','event')),
            content           TEXT NOT NULL,
            created_at        TEXT NOT NULL,
            model_event_type  TEXT,
            run_id            TEXT,
            metadata          TEXT
          );
        `);
        db.exec(`
          INSERT INTO messages_new (id, chat_id, role, content, created_at, model_event_type, run_id, metadata)
          SELECT id, chat_id, role, content, created_at, model_event_type, run_id, metadata FROM messages;
        `);
        db.exec("DROP TABLE messages");
        db.exec("ALTER TABLE messages_new RENAME TO messages");
        db.exec("CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_messages_run_id  ON messages(run_id)");
      }
    },
  },
  {
    version: 8,
    description: "auth_config + auth_sessions tables — dashboard login/password",
    up: (db, crypto) => {
      // auth_config: single row (key='default') holding the scrypt password
      // hash. The hash column is encrypted at rest by DbCrypto (sensitive).
      db.exec(`
        CREATE TABLE IF NOT EXISTS auth_config (
          key            TEXT PRIMARY KEY DEFAULT 'default',
          password_hash  TEXT NOT NULL,
          created_at     TEXT NOT NULL
        );
      `);
      // auth_sessions: one row per active session token. token_hash is the
      // SHA-256 of the raw cookie token (the raw token is NEVER stored). The
      // session_id links to the isolation session. created_at + the config
      // TTL govern expiry.
      db.exec(`
        CREATE TABLE IF NOT EXISTS auth_sessions (
          token_hash  TEXT PRIMARY KEY,
          session_id  TEXT NOT NULL,
          created_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_auth_sessions_session_id ON auth_sessions(session_id);
      `);
      // Seed the password hash from HARNESS_WEB_AUTH_PASSWORD when set (the
      // env-var setup path). The setup-flow path (POST /api/auth/setup) is
      // used when no env password is configured. The hash is encrypted at
      // rest via DbCrypto. Idempotent: if a row already exists, do
      // not overwrite (the user may have set a different password via setup).
      const envPwd = serverConfig.authPassword;
      if (envPwd.length > 0) {
        const existing = db.prepare("SELECT key FROM auth_config WHERE key = 'default' LIMIT 1").get();
        if (existing === undefined) {
          const salt = "bridlewise-web-auth-salt-v1";
          const hash = scryptSync(envPwd, salt, 32).toString("base64");
          // Store as a scrypt-verifiable hash. We use the auth module's format
          // but inline it here (the migration cannot import auth.ts without a
          // circular dep). Format: scrypt$N$r$p$saltB64$hashB64.
          const saltB64 = Buffer.from(salt).toString("base64");
          const stored = `scrypt$16384$8$1$${saltB64}$${hash}`;
          const enc = crypto.encryptField(stored, UNBOUND);
          db.prepare("INSERT INTO auth_config (key, password_hash, created_at) VALUES ('default', ?, ?)")
            .run(enc ?? stored, new Date().toISOString());
        }
      }
    },
  },
  {
    version: 9,
    description: "user_model_prefs table — per-user model/provider overrides (models in DB, not config)",
    up: (db) => {
      // Per-user model/provider preferences. One row per session_id. The
      // config_json column holds the user's provider + model overrides as
      // encrypted JSON (encrypted at rest by DbCrypto). The chat
      // run route reads from here first, falling back to the config file.
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_model_prefs (
          id           TEXT PRIMARY KEY,
          session_id   TEXT NOT NULL UNIQUE,
          config_json  TEXT NOT NULL,
          updated_at   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_user_model_prefs_session_id ON user_model_prefs(session_id);
      `);
    },
  },
  {
    version: 10,
    description: "user_prompt_prefs table — per-user system-prompt preferences (configurable from web, encrypted in DB)",
    up: (db) => {
      // Per-user system-prompt preferences. One row per session_id (UNIQUE).
      // prefs_json holds the encrypted JSON blob:
      // { systemPromptOverride, tone, sentenceCase, emoji, icons }
      // The chat run route reads from here first (per-user override wins),
      // falling back to the config-file defaults (the global seed). Encrypted
      // at rest by DbCrypto. Mirrors the user_model_prefs pattern
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_prompt_prefs (
          id          TEXT PRIMARY KEY,
          session_id  TEXT NOT NULL UNIQUE,
          prefs_json  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_user_prompt_prefs_session_id ON user_prompt_prefs(session_id);
      `);
    },
  },
  {
    version: 11,
    description: "tool_calls.attempt_count — persist the per-run retry counter so 'attempt N' survives a page refresh",
    up: (db) => {
      // attempt_count: how many times this tool was attempted in its run
      // (1 = first attempt; N = Nth retry of a previously-failed call).
      // Previously this lived ONLY in the run's in-memory
      // toolAttemptCounts Map, so it was lost on every page refresh — the
      // "attempt N" badge vanished on reload (all tool-call fields
      // must survive refresh). Persisted on the tool_call row, backfilled
      // to 1 for rows created before this migration (a fresh successful
      // call is attempt 1, which the UI hides via `attemptCount > 1`).
      try {
        db.exec("ALTER TABLE tool_calls ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 1");
      } catch (err) {
        if (!(err instanceof Error && err.message.includes("duplicate column"))) {
          throw err;
        }
      }
    },
  },
  {
    version: 12,
    description: "multi-user support — users table + user_id scoping on projects/tool_settings/user_model_prefs/user_prompt_prefs/auth_sessions; backfill admin from legacy auth_config/env",
    up: (db, crypto) => {
      // ── users table (the identity authority — replaces single password) ──
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id            TEXT PRIMARY KEY,
          username       TEXT NOT NULL UNIQUE,
          password_hash  TEXT NOT NULL,
          is_admin       INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
          created_at    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
      `);

      // ── add user_id columns to projects + auth_sessions (idempotent) ──
      // These two tables have a nullable/optional session_id, so a plain
      // ALTER TABLE ADD COLUMN user_id is sufficient (new rows set user_id;
      // session_id is left NULL/optional).
      const addColumn = (table: string, col: string) => {
        try {
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
        } catch (err) {
          if (!(err instanceof Error && err.message.includes("duplicate column"))) {
            throw err;
          }
        }
      };
      addColumn("projects", "user_id");
      addColumn("auth_sessions", "user_id");

      db.exec("CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id)");

      // ── rebuild tool_settings + the two prefs tables to drop session_id ──
      //
     // The original v6/v9/v10 migrations declared `session_id TEXT NOT
      // NULL` (and UNIQUE for the prefs tables). The multi-user model scopes
      // by `user_id` instead — keeping `session_id NOT NULL` would force
      // every insert to supply a meaningless session_id. The clean fix
      // is to REBUILD
      // these tables with `user_id NOT NULL` as the scoping key and DROP
      // `session_id` entirely. Idempotent: the rebuild only runs when the
      // table still has the legacy `session_id` column (checked via
      // PRAGMA table_info). Existing rows are backfilled to the admin user
      // (computed below) so no data is orphaned; a fresh install has no
      // rows to copy.
      //
     // adminIdForBackfill is resolved lazily: the admin seed (below) runs
      // AFTER this rebuild in the source order, but the rebuild needs the
      // admin id to backfill old rows. So we resolve the admin id here from
      // the same seed sources (legacy auth_config / env password). When
      // there is no seed (fresh install, no legacy data), there are no old
      // rows to backfill, so adminId is irrelevant (NULL is fine — the
      // INSERT...SELECT copies zero rows).
      function columnExists(table: string, col: string): boolean {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<{ name?: string }>;
        return cols.some((c) => c.name === col);
      }

      // Resolve the admin id for backfill (mirrors the seed below; resolved
      // here so the rebuild can assign old rows to it).
      let adminId: string | null = null;
      {
        const existing = db.prepare("SELECT id FROM users WHERE is_admin = 1 LIMIT 1").get() as { id?: string } | undefined;
        if (existing?.id !== undefined) {
          adminId = existing.id;
        }
      }
      if (adminId === null) {
        let seedHash: string | null = null;
        const legacyRow = db
          .prepare("SELECT password_hash FROM auth_config WHERE key = 'default' LIMIT 1")
          .get() as { password_hash?: string } | undefined;
        if (legacyRow !== undefined && legacyRow.password_hash !== undefined) {
          seedHash = crypto.decryptField(legacyRow.password_hash, UNBOUND) ?? legacyRow.password_hash;
        }
        if (seedHash === null && serverConfig.authPassword.length > 0) {
          const salt = "bridlewise-web-auth-salt-v1";
          const hash = scryptSync(serverConfig.authPassword, salt, 32).toString("base64");
          seedHash = `scrypt$16384$8$1$${Buffer.from(salt).toString("base64")}$${hash}`;
        }
        if (seedHash !== null) {
          adminId = randomUuid();
          const encHash = crypto.encryptField(seedHash, UNBOUND) ?? seedHash;
          db.prepare(
            "INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, 1, ?)",
          ).run(adminId, serverConfig.authUsername, encHash, new Date().toISOString());
        }
      }

      // tool_settings: rebuild to (id, user_id NOT NULL, tool_name, enabled,
      // config, updated_at) with UNIQUE(user_id, tool_name). Backfill old
      // rows to adminId.
      if (columnExists("tool_settings", "session_id")) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS tool_settings_new (
            id          TEXT PRIMARY KEY,
            user_id     TEXT NOT NULL,
            tool_name   TEXT NOT NULL,
            enabled     INTEGER NOT NULL CHECK (enabled IN (0, 1)),
            config      TEXT,
            updated_at  TEXT NOT NULL
          );
        `);
        if (adminId !== null) {
          // Dedup: the legacy table had one row per session_id; multiple
          // sessions' rows would collide on the new UNIQUE(user_id, tool_name)
          // when all map to the admin. Keep only the LATEST row per tool_name
          // (max rowid = most recent insert) so the rebuild is collision-free.
          db.prepare(
            `INSERT INTO tool_settings_new (id, user_id, tool_name, enabled, config, updated_at)
             SELECT id, ?, tool_name, enabled, config, updated_at FROM tool_settings
             WHERE rowid IN (SELECT MAX(rowid) FROM tool_settings GROUP BY tool_name)`,
          ).run(adminId);
        }
        db.exec("DROP TABLE tool_settings");
        db.exec("ALTER TABLE tool_settings_new RENAME TO tool_settings");
        db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_settings_user_tool ON tool_settings(user_id, tool_name)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_tool_settings_user_id ON tool_settings(user_id)");
      }

      // user_model_prefs: rebuild to (id, user_id NOT NULL UNIQUE,
      // config_json, updated_at). Backfill old rows to adminId (keeping only
      // the latest — multiple legacy sessions mapping to one admin would
      // otherwise violate UNIQUE(user_id)).
      if (columnExists("user_model_prefs", "session_id")) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS user_model_prefs_new (
            id           TEXT PRIMARY KEY,
            user_id      TEXT NOT NULL UNIQUE,
            config_json  TEXT NOT NULL,
            updated_at   TEXT NOT NULL
          );
        `);
        if (adminId !== null) {
          db.prepare(
            `INSERT INTO user_model_prefs_new (id, user_id, config_json, updated_at)
             SELECT id, ?, config_json, updated_at FROM user_model_prefs
             ORDER BY updated_at DESC LIMIT 1`,
          ).run(adminId);
        }
        db.exec("DROP TABLE user_model_prefs");
        db.exec("ALTER TABLE user_model_prefs_new RENAME TO user_model_prefs");
        db.exec("CREATE INDEX IF NOT EXISTS idx_user_model_prefs_user_id ON user_model_prefs(user_id)");
      }

      // user_prompt_prefs: rebuild to (id, user_id NOT NULL UNIQUE,
      // prefs_json, updated_at). Backfill old rows to adminId (latest only).
      if (columnExists("user_prompt_prefs", "session_id")) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS user_prompt_prefs_new (
            id          TEXT PRIMARY KEY,
            user_id     TEXT NOT NULL UNIQUE,
            prefs_json  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
          );
        `);
        if (adminId !== null) {
          db.prepare(
            `INSERT INTO user_prompt_prefs_new (id, user_id, prefs_json, updated_at)
             SELECT id, ?, prefs_json, updated_at FROM user_prompt_prefs
             ORDER BY updated_at DESC LIMIT 1`,
          ).run(adminId);
        }
        db.exec("DROP TABLE user_prompt_prefs");
        db.exec("ALTER TABLE user_prompt_prefs_new RENAME TO user_prompt_prefs");
        db.exec("CREATE INDEX IF NOT EXISTS idx_user_prompt_prefs_user_id ON user_prompt_prefs(user_id)");
      }

      // ── seed the admin user + backfill projects/auth_sessions (idempotent) ──
      //
     // The admin may already have been seeded by the rebuild section
      // above (when legacy data existed). This block is idempotent: if a
      // users row already exists, skip. The admin is seeded from (in
      // priority order): the legacy `auth_config` single-password hash
      // (decrypted) OR the HARNESS_WEB_AUTH_PASSWORD env (hashed inline).
      // The username comes from serverConfig.authUsername (default
      // "admin"; env HARNESS_WEB_AUTH_USERNAME). The FIRST user is the
      // admin (is_admin = 1). All existing projects + auth_sessions rows
      // are backfilled to this admin's id so no data is orphaned.
      //
     // If NEITHER auth_config NOR the env password is set AND no users
      // exist, no admin is seeded — the first register flow creates the
      // admin (setup mode). This is correct for a fresh install.
      const userCount = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n?: number };
      if ((userCount.n ?? 0) === 0) {
        let seedHash: string | null = null;
        // Priority 1: the legacy auth_config single-password hash.
        const legacyRow = db
          .prepare("SELECT password_hash FROM auth_config WHERE key = 'default' LIMIT 1")
          .get() as { password_hash?: string } | undefined;
        if (legacyRow !== undefined && legacyRow.password_hash !== undefined) {
          seedHash = crypto.decryptField(legacyRow.password_hash, UNBOUND) ?? legacyRow.password_hash;
        }
        // Priority 2: the env password (HARNESS_WEB_AUTH_PASSWORD), hashed
        // inline using the auth module's format (scrypt$N$r$p$salt$hash).
        if (seedHash === null && serverConfig.authPassword.length > 0) {
          const salt = "bridlewise-web-auth-salt-v1";
          const hash = scryptSync(serverConfig.authPassword, salt, 32).toString("base64");
          const saltB64 = Buffer.from(salt).toString("base64");
          seedHash = `scrypt$16384$8$1$${saltB64}$${hash}`;
        }
        if (seedHash !== null) {
          const seededAdminId = randomUuid();
          const username = serverConfig.authUsername;
          const encHash = crypto.encryptField(seedHash, UNBOUND) ?? seedHash;
          db.prepare(
            "INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, 1, ?)",
          ).run(seededAdminId, username, encHash, new Date().toISOString());
          // Backfill ALL existing projects + auth_sessions to the admin.
          db.prepare("UPDATE projects SET user_id = ? WHERE user_id IS NULL").run(seededAdminId);
          db.prepare("UPDATE auth_sessions SET user_id = ? WHERE user_id IS NULL").run(seededAdminId);
        }
      } else {
        // Users already exist (e.g. the rebuild seeded the admin). Backfill
        // any remaining un-owned projects/auth_sessions to the admin.
        const adminRow = db.prepare("SELECT id FROM users WHERE is_admin = 1 LIMIT 1").get() as { id?: string } | undefined;
        const backfillId = adminRow?.id;
        if (backfillId !== undefined) {
          db.prepare("UPDATE projects SET user_id = ? WHERE user_id IS NULL").run(backfillId);
          db.prepare("UPDATE auth_sessions SET user_id = ? WHERE user_id IS NULL").run(backfillId);
        }
      }
    },
  },
  {
    version: 13,
    description:
      "idx_messages_chat_created — the index the history cursor seeks on, in the conversation's DECLARED order",
    up: (db) => {
      // ── WHY AN INDEX IS PART OF THE CURSOR, NOT AN OPTIMISATION OF IT ────
      //
      // `idx_messages_chat_id` stores (chat_id, rowid), so the existing reads
      // seek by INSERTION order. The declared order of a conversation is
      // (created_at, rowid) — deliberately, because rowid order is only
      // *probably* the same and a clock that steps backwards would silently
      // reorder a transcript (see `DbClient.pageAllRows`).
      //
      // A cursor that pages backwards must seek in the SAME order it hands
      // rows back in, or a page boundary can skip or repeat a message. Asking
      // SQLite for `ORDER BY created_at DESC, rowid DESC LIMIT 200` without
      // this index makes it read and sort EVERY message in the chat to find
      // the newest 200 — an unbounded read producing a bounded answer, which
      // is the defect the cursor exists to remove. With it, the page is a
      // backwards range scan of exactly the rows returned.
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages(chat_id, created_at)",
      );
      // The tail page bounds these two the same way and in THEIR declared
      // orders — metrics by `created_at`, timeline refs by the recorded
      // event `timestamp`, which is not the same column and never was.
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_metrics_snapshots_chat_created ON metrics_snapshots(chat_id, created_at)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_timeline_refs_chat_timestamp ON timeline_refs(chat_id, timestamp)",
      );
    },
  },
  {
    version: 14,
    description:
      "run_executions — the claim row that makes a second execution of one run refusable by SQLite",
    up: (db) => {
      // ── WHY THIS IS A TABLE AND NOT A CHECK ────────────────────────────────
      //
      // A run must execute once. The previous mechanism was an in-memory
      // boolean on the run record, written four times and read zero — the
      // value that would have answered "is this already executing?" was
      // computed and thrown away, so two simultaneous requests each assembled
      // a prompt, each called the provider, and each dispatched the tools.
      // Measured at the wire: two POSTs to /chat/completions, 38,429 bytes
      // each, byte-identical, billed twice; two tool executions of the same
      // call id; two assistant rows under one run id.
      //
      // `run_id` as the PRIMARY KEY moves the refusal into the engine. The
      // executor's FIRST statement is the INSERT, so the loser of the race is
      // rejected before it can assemble a prompt, let alone send one. Nothing
      // in application code has to remain correct for that to hold — not a
      // future route, not a module that skips the facade, not the CLI.
      //
      // `user_id` is carried so the row is a complete record of who executed
      // what, and so a later reconciler can scope by owner without joining
      // back through messages. The row is never deleted: it IS the record
      // that this run executed, and freeing the id would re-open the
      // duplicate.
      db.exec(`
        CREATE TABLE IF NOT EXISTS run_executions (
          run_id      TEXT PRIMARY KEY,
          user_id     TEXT NOT NULL,
          claimed_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_run_executions_user_id ON run_executions(user_id);
      `);
    },
  },
  {
    version: 15,
    description: "recycle bin — trashed_at on projects and chats (no hard delete)",
    up: (db) => {
      db.exec(`
        ALTER TABLE projects ADD COLUMN trashed_at TEXT;
        ALTER TABLE chats ADD COLUMN trashed_at TEXT;
        CREATE INDEX IF NOT EXISTS idx_projects_trashed_at ON projects(trashed_at);
        CREATE INDEX IF NOT EXISTS idx_chats_trashed_at ON chats(trashed_at);
      `);
    },
  },
  {
    version: 16,
    description: "conversation record refuses DELETE (BEFORE DELETE ABORT)",
    up: (db) => {
      // Rung 1: the engine aborts a DELETE of the conversation record.
      // CASCADE on the child FKs never fires because the parent delete
      // does not complete. A new DbClient method cannot bypass this.
      for (const table of UNDELETABLE_TABLES) {
        db.exec(refuseDeleteTriggerSql(table));
      }
    },
  },
  {
    version: 17,
    description: "tool_calls.call_id — the provider's stable callId persisted on the row",
    up: (db) => {
      db.exec(`
        ALTER TABLE tool_calls ADD COLUMN call_id TEXT;
      `);
    },
  },
  {
    version: 18,
    description: "private provider identities and qualified public tool projections",
    up: (db, crypto) => {
      db.exec("ALTER TABLE tool_calls ADD COLUMN public_projection TEXT;");
      const rows = db.prepare("SELECT id, call_id, tool_name, input, output FROM tool_calls").all() as unknown as readonly { id: string; call_id: string | null; tool_name: string; input: string; output: string | null }[];
      const update = db.prepare("UPDATE tool_calls SET call_id = ?, tool_name = ? WHERE id = ?");
      // These columns were plaintext through v17. Provider bytes that begin
      // with enc: are still plaintext here, not an encryption-version marker.
      for (const row of rows) {
        // Authenticate existing encrypted fields with this key before writing
        // new ciphertext. Wrong-key opening must roll back the whole migration,
        // not permanently mix encryption keys in a previously valid database.
        crypto.decryptField(row.input, UNBOUND);
        crypto.decryptField(row.output, UNBOUND);
        update.run(row.call_id === null ? null : crypto.encryptField(JSON.stringify(row.call_id), UNBOUND), crypto.encryptField(JSON.stringify(row.tool_name), UNBOUND), row.id);
      }
    },
  },
  {
    version: 19,
    description: "MCP tool names: the retired mcp:<server>:<tool> spelling becomes the naming owner's spec-legal name",
    up: (db, crypto) => {
      // ONE-TIME RENAME, NOT A SHIM. The harness used to name an MCP tool
      // `mcp:<server>:<tool>`, which is not a legal Responses function name;
      // the one naming owner now mints `mcp__<server>__<tool>` (plus a digest
      // when the tool name needs sanitising). Every stored name a later run
      // READS BACK is renamed here, so nothing downstream ever meets the old
      // spelling and no reader carries a second grammar:
      //   - tool_settings.tool_name  — a user's per-tool switch (plaintext);
      //   - tool_calls.tool_name     — replayed to the model as the call's name;
      //   - tool_calls.public_projection.toolName — the display derivative.
      // NOT renamed, deliberately: the hash-chained timeline (evidence), and a
      // message's recorded `context.toolNames` (what that prompt actually
      // carried — a record of the past, never replayed). A stored name whose
      // server id the naming owner no longer accepts (`_` or `.` in it) is
      // left as it is: no configured server can own it, so it can never be
      // called or toggled again, and inventing a name for it would be a guess.
      const renamed = (name: unknown): string | undefined => {
        if (typeof name !== "string") return undefined;
        const match = /^mcp:([^:]+):(.+)$/su.exec(name);
        if (match === null || !isV19ServerId(match[1]!)) return undefined;
        return v19McpToolName(match[1]!, match[2]!);
      };
      // Keyset batches, never the whole table at once: the history can be
      // large, and the migration runs inside the boot transaction.
      //
      // A RENAME NEVER BRICKS BOOT. Two stored names can map to ONE new name
      // (v19's plain and digest spaces overlapped: `foo.bar` and
      // `foo_bar_70bdbd8f` of one server — secb-security SECB-V-5), and the
      // per-user switch is UNIQUE(user_id, tool_name): the later row KEEPS its
      // old spelling (`UPDATE OR IGNORE`) and is counted and logged — it can
      // no longer be toggled, which is the same fate as a name whose server id
      // the owner refuses. It used to fail the UNIQUE index on every boot.
      const updateSetting = db.prepare("UPDATE OR IGNORE tool_settings SET tool_name = ? WHERE rowid = ?");
      let settingsKept = 0;
      forEachBatch(db, "SELECT rowid, tool_name FROM tool_settings WHERE rowid > ? ORDER BY rowid LIMIT ?", (row: { rowid: number; tool_name: string }) => {
        const next = renamed(row.tool_name);
        if (next !== undefined && Number(updateSetting.run(next, row.rowid).changes) === 0) settingsKept += 1;
      });
      if (settingsKept > 0) webWarn("migration", "v19: tool switches kept their retired name (their new name was taken)", () => ({ rows: settingsKept }));
      // A ROW THAT CANNOT BE READ IS KEPT AS IT IS, counted and logged — one
      // corrupt row used to fail the migration (an untyped SyntaxError) on
      // every boot. But when NO renamable row can be read at all, the key is
      // wrong, and renaming nothing would hide it: that is refused, typed.
      const updateCall = db.prepare("UPDATE tool_calls SET tool_name = ?, public_projection = ? WHERE rowid = ?");
      let callsRead = 0;
      let callsUnreadable = 0;
      forEachBatch(db, "SELECT rowid, tool_name, public_projection FROM tool_calls WHERE rowid > ? ORDER BY rowid LIMIT ?", (row: { rowid: number; tool_name: string; public_projection: string | null }) => {
        const decoded = decodeStoredJson(crypto, row.tool_name);
        if (!decoded.ok) { callsUnreadable += 1; return; }
        callsRead += 1;
        const next = renamed(decoded.value);
        // The projection is the display derivative of the SAME name: a row
        // whose name did not change (every built-in) is not opened again.
        if (next === undefined) return;
        const projection = decodeStoredJson(crypto, row.public_projection);
        const projected = projection.ok && projection.value !== null && typeof projection.value === "object"
          ? projection.value as Record<string, unknown>
          : undefined;
        const nextProjection = projected !== undefined && renamed(projected["toolName"]) !== undefined
          ? crypto.encryptField(JSON.stringify({ ...projected, toolName: renamed(projected["toolName"]) }), UNBOUND)
          : row.public_projection;
        updateCall.run(crypto.encryptField(JSON.stringify(next), UNBOUND), nextProjection, row.rowid);
      });
      if (callsUnreadable > 0 && callsRead === 0) {
        throw new HarnessError(
          `Migration 19 could not read any of the ${callsUnreadable} stored tool calls, so the database key is probably not this database's; nothing was changed. Start the harness with the database's own key.`,
          "db_migration_undecodable", false,
        );
      }
      if (callsUnreadable > 0) webWarn("migration", "v19: unreadable tool-call rows were kept as they are", () => ({ rows: callsUnreadable }));
    },
  },
  {
    version: BOUND_FIELDS_SCHEMA_VERSION,
    description: "every encrypted field is bound to its table, column, row, parents and owning user (AEAD associated data)",
    up: (db, crypto) => {
      // Until now a ciphertext authenticated anywhere: copied into another
      // user's row it decrypted there (cred-audit CRED-F13). Each stored value
      // is re-sealed, with the same key, under ITS OWN FROZEN binding
      // (`V20_ENCRYPTED_COLUMNS`, `v20Binding` below — never the live list,
      // which later versions may extend). The owning user is derived through
      // the ownership joins as they stand now; a row with no owner (an orphan
      // nobody can read) is kept as it is. A value that does not authenticate
      // is kept too (counted, logged): it was unreadable before and stays so.
      //
      // IDEMPOTENT, AND NEVER A RE-BINDING SOURCE: a value already sealed
      // under its binding is left; but a database that already holds bound
      // values AND an unbound one did not come from a single upgrade — the
      // unbound one was planted (a pre-v20 copy's ciphertext moved into a row
      // with the version lowered by an edit, secc-security SECC-V-A2) — so the
      // migration refuses instead of sealing it to its new row. When NOTHING
      // authenticates, the key is not this database's. Either refusal rolls
      // the whole transaction back.
      let resealed = 0, alreadyBound = 0, unreadable = 0, orphaned = 0;
      for (const [table, shape] of Object.entries(V20_ENCRYPTED_COLUMNS)) {
        const update = db.prepare(`UPDATE ${table} SET ${shape.columns.map((column) => `${column} = ?`).join(", ")} WHERE rowid = ?`);
        forEachBatch<{ rowid: number } & Record<string, unknown>>(db,
          `SELECT t.rowid AS rowid, t.${shape.key} AS row_key, ${shape.parents.map((parent) => `t.${parent} AS parent_${parent}`).join(", ")}${shape.parents.length > 0 ? ", " : ""}${shape.owner} AS owner_user_id, ${shape.columns.map((column) => `t.${column} AS ${column}`).join(", ")} FROM ${table} t ${shape.join} WHERE t.rowid > ? ORDER BY t.rowid LIMIT ?`,
          (row) => {
            let changed = false;
            const next = shape.columns.map((column) => {
              const stored = row[column];
              if (typeof stored !== "string" || !isEncryptedValue(stored)) return stored ?? null;
              const owner = row["owner_user_id"];
              if (typeof owner !== "string" || owner.length === 0) { orphaned += 1; return stored; }
              const binding = v20Binding(table, column, String(row["row_key"]), owner, shape.parents.map((parent) => {
                const value = row[`parent_${parent}`]; return value === null || value === undefined ? null : String(value);
              }));
              if (crypto.authenticates(stored, binding)) { alreadyBound += 1; return stored; }
              if (!crypto.authenticates(stored, UNBOUND)) { unreadable += 1; return stored; }
              resealed += 1; changed = true;
              return crypto.encryptField(crypto.decryptField(stored, UNBOUND), binding);
            });
            if (changed) update.run(...(next as (string | null)[]), row.rowid);
          });
      }
      // THE PROOF PER ROW: an unbound value may be sealed to its row only when
      // no bound field ever existed under this key — recorded OUTSIDE the
      // database, in the key home (`bindingRecord`), where neither a database
      // edit nor a confined process reaches. Under a recorded key every
      // unbound value was put there after binding (the counts inside the
      // database can be arranged: secd-security SECD-C1), so none is sealed.
      if (resealed > 0 && crypto.bindingRecord !== undefined && existsSync(crypto.bindingRecord)) {
        throw new HarnessError(
          `Migration 20 found ${resealed} unbound encrypted field(s) in a database whose key has already sealed bound fields (${crypto.bindingRecord}): they were put there after the upgrade (a pre-upgrade copy's ciphertext moved into rows, the version lowered by an edit) and are never sealed to rows they did not come from. A backup is not a re-sealing source. Nothing was changed; restore the database as it was, or remove those values.`,
          "db_migration_rebinding_refused", false,
        );
      }
      if (alreadyBound > 0 && resealed > 0) {
        throw new HarnessError(
          `Migration 20 found ${alreadyBound} field(s) already bound to their rows and ${resealed} unbound one(s): a database is upgraded once, so the unbound values were put there later (a copy restored from a backup?) and are not sealed to rows they did not come from. Nothing was changed; restore the database as it was, or remove those values.`,
          "db_migration_rebinding_refused", false,
        );
      }
      if (unreadable > 0 && resealed === 0 && alreadyBound === 0) {
        throw new HarnessError(
          `Migration 20 could not read any of the ${unreadable} encrypted fields, so the database key is probably not this database's; nothing was changed. Start the harness with the database's own key.`,
          "db_migration_undecodable", false,
        );
      }
      if (unreadable > 0 || orphaned > 0) webWarn("migration", "v20: unreadable or ownerless encrypted fields were kept as they are", () => ({ fields: unreadable, orphaned }));
    },
  },
];

/** The migrations in version order, as `runMigrations` applies them (the list's own order is not relied on). */
const MIGRATIONS_IN_ORDER: readonly Migration[] = Object.freeze([...MIGRATIONS].sort((a, b) => a.version - b.version));

// ── Migration 20's frozen binding (never the live owner) ──
//
// A MIGRATION IS A FACT ABOUT THE PAST (see migration 19's note below): v20
// seals exactly these columns under exactly this binding, whatever the live
// `ENCRYPTED_COLUMNS` / `fieldBinding` (server/db/db-crypto.ts) become. Its
// golden test (tests/unit/db-field-binding-v20.test.ts) pins the bytes and
// that they equal the live binding while the live format is still v1; a
// prevention guard forbids any migration body from importing the live list.

type V20Table = Readonly<{ key: string; parents: readonly string[]; columns: readonly string[]; owner: string; join: string }>;

/** v20: every encrypted column, its row key, its parents and how its owning user is reached. */
const V20_ENCRYPTED_COLUMNS: Readonly<Record<string, V20Table>> = Object.freeze({
  projects: { key: "id", parents: [], columns: ["name", "path", "config_overlay"], owner: "t.user_id", join: "" },
  chats: { key: "id", parents: ["project_id"], columns: ["title"], owner: "p.user_id", join: "LEFT JOIN projects p ON p.id = t.project_id" },
  messages: { key: "id", parents: ["chat_id"], columns: ["content", "metadata"], owner: "p.user_id", join: "LEFT JOIN chats c ON c.id = t.chat_id LEFT JOIN projects p ON p.id = c.project_id" },
  tool_calls: { key: "id", parents: ["message_id"], columns: ["call_id", "tool_name", "public_projection", "input", "output"], owner: "p.user_id", join: "LEFT JOIN messages m ON m.id = t.message_id LEFT JOIN chats c ON c.id = m.chat_id LEFT JOIN projects p ON p.id = c.project_id" },
  metrics_snapshots: { key: "id", parents: ["chat_id"], columns: ["snapshot"], owner: "p.user_id", join: "LEFT JOIN chats c ON c.id = t.chat_id LEFT JOIN projects p ON p.id = c.project_id" },
  auto_checks: { key: "id", parents: ["project_id", "chat_id"], columns: ["output"], owner: "p.user_id", join: "LEFT JOIN projects p ON p.id = t.project_id" },
  timeline_refs: { key: "id", parents: ["chat_id"], columns: ["metadata"], owner: "p.user_id", join: "LEFT JOIN chats c ON c.id = t.chat_id LEFT JOIN projects p ON p.id = c.project_id" },
  users: { key: "id", parents: [], columns: ["password_hash"], owner: "t.id", join: "" },
  user_model_prefs: { key: "user_id", parents: [], columns: ["config_json"], owner: "t.user_id", join: "" },
  user_prompt_prefs: { key: "user_id", parents: [], columns: ["prefs_json"], owner: "t.user_id", join: "" },
});

/** v20: the associated data of one field — `["bw-field-v1", table, column, key, owner, ...parents]` as JSON. */
export function v20Binding(table: string, column: string, key: string, owner: string, parents: readonly (string | null)[]): FieldBinding {
  return JSON.stringify(["bw-field-v1", table, column, key, owner, ...parents]) as FieldBinding;
}

// ── Migration 19's frozen naming (never the live owner) ──
//
// A MIGRATION IS A FACT ABOUT THE PAST: every database it ever runs on must
// receive exactly the names it gave the first one. So migration 19 carries
// its OWN copy of the naming rule as it stood on 2026-09-28 — the live owner
// (`engine/src/mcp/tool-name.ts`) may change its digest, sanitiser or id
// grammar later, and a database migrated after that change would otherwise
// receive different names than one migrated before it. (No later migration
// can re-derive a changed live name: the raw server/tool pair is not stored,
// so a change to the live owner's output orphans the stored names it changes
// — see tool-name.ts.) This copy never changes, and its golden test
// (`tests/unit/mcp-tool-name-migration.test.ts`) pins it.

/** v19: a server id — letters, digits and inner hyphens, at most 111 characters. */
const V19_SERVER_ID = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;
const V19_SERVER_ID_MAX_CHARACTERS = 111;
/** v19: the Responses function-name grammar, 128 characters. */
const V19_FUNCTION_NAME = /^[A-Za-z0-9_-]{1,128}$/u;
const V19_FUNCTION_NAME_MAX_CHARACTERS = 128;
const V19_DIGEST_HEX_CHARACTERS = 8;

function isV19ServerId(serverId: string): boolean {
  return serverId.length <= V19_SERVER_ID_MAX_CHARACTERS && V19_SERVER_ID.test(serverId);
}

function v19McpToolName(serverId: string, toolName: string): string {
  const head = `mcp__${serverId}__`;
  const plain = `${head}${toolName}`;
  if (V19_FUNCTION_NAME.test(plain)) return plain;
  const tag = `_${sha256(`${serverId}\u0000${toolName}`).slice(0, V19_DIGEST_HEX_CHARACTERS)}`;
  const room = V19_FUNCTION_NAME_MAX_CHARACTERS - head.length - tag.length;
  return `${head}${toolName.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, room)}${tag}`;
}

/** A stored encrypted JSON field, decoded — or the fact that it cannot be. */
function decodeStoredJson(crypto: DbCrypto, stored: string | null): Readonly<{ ok: true; value: unknown } | { ok: false }> {
  try {
    const plain = crypto.decryptField(stored, UNBOUND);
    return { ok: true, value: plain === null ? null : JSON.parse(plain) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Rows per batch a row-rewriting migration reads at once. A migration step,
 * not a tunable: large enough that the loop overhead vanishes, small enough
 * that a large table never sits in memory whole.
 */
const MIGRATION_BATCH_ROWS = 500;

/** Visit every row of a keyset query (`WHERE rowid > ? ORDER BY rowid LIMIT ?`) in bounded batches. */
function forEachBatch<Row extends { rowid: number }>(db: DatabaseSync, sql: string, visit: (row: Row) => void): void {
  const page = db.prepare(sql);
  let after = 0;
  for (;;) {
    const rows = page.all(after, MIGRATION_BATCH_ROWS) as unknown as readonly Row[];
    for (const row of rows) visit(row);
    if (rows.length < MIGRATION_BATCH_ROWS) return;
    after = rows.at(-1)!.rowid;
  }
}

// ── Runner ──

/**
 * Apply pending migrations up to `targetVersion` (default: latest).
 * Idempotent: a fresh DB and a partially-migrated DB both converge.
 * Returns the resulting schema version.
 *
 * Two guards around every upgrade, generic to all migrations:
 *   - A database whose version is NEWER than this code knows is refused
 *     (`db_schema_newer`): older code would read renamed rows by their old
 *     meaning and silently lose data (e.g. every MCP tool switch after v19).
 *   - Before a file database takes any pending migration, a copy is taken
 *     (`<db>.pre-v<first pending>`, 0600, `VACUUM INTO`): a row-rewriting
 *     migration is forward-only, so the copy is the way back.
 */
export function runMigrations(
  db: DatabaseSync,
  targetVersion: number = SCHEMA_VERSION_LATEST,
  crypto: DbCrypto = createNoopDbCrypto(),
): number {
  backupBeforeMigrating(db, targetVersion);
  // ONE writer transaction for the registry read and every pending migration:
  // a concurrent opener re-reads the version only after it holds the lock
  // (two first openers used to both apply v1, and the second failed on the
  // registry's primary key).
  db.exec("BEGIN IMMEDIATE");
  let applying: number | undefined;
  try {
    db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const current = readSchemaVersion(db);
    assertSchemaNotNewer(current);
    for (const migration of MIGRATIONS_IN_ORDER) {
      if (migration.version <= current) continue;
      if (migration.version > targetVersion) break;
      applying = migration.version;
      migration.up(db, crypto);
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(migration.version, new Date().toISOString());
    }
    const version = readSchemaVersion(db);
    db.exec("COMMIT");
    return version;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch (rollbackError) {
      webWarn("migration", "rollback failed", () => ({ version: applying, error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError) }));
    }
    throw error;
  }
}

/** Refuse a database written by newer code (see `runMigrations`). */
function assertSchemaNotNewer(current: number): void {
  if (current > SCHEMA_VERSION_LATEST) {
    throw new HarnessError(
      `The database is at schema version ${current}, newer than this harness knows (${SCHEMA_VERSION_LATEST}). It was written by a newer version; opening it here could misread its data. Run the newer harness, or restore the pre-upgrade copy (<db>.pre-v<N>) it left beside the database.`,
      "db_schema_newer",
    );
  }
}

/**
 * Copy a file database before its first pending migration (see
 * `runMigrations`) — a copy that is PROVEN, never assumed:
 *
 *   - ALWAYS FRESH. Any earlier copy at the name is replaced: a copy left by
 *     an attempt that rolled back is older than the rows written since (the
 *     old "an existing file is the copy" short-circuit accepted an EMPTY file
 *     as the backup, secb-security SECB-V-6).
 *   - WRITTEN AT A TEMPORARY NAME CREATED 0600 FIRST (`O_EXCL|O_NOFOLLOW`),
 *     then `VACUUM INTO` it, so the copy is never world-readable for a moment
 *     and a crash never leaves a partial copy at the final name.
 *   - VERIFIED before it takes the name: it opens, `PRAGMA quick_check` says
 *     ok, and its schema version is the one being upgraded from.
 *   - NEVER THROUGH A LINK: anything at the final name that is not a regular
 *     file (a planted symlink sent the whole database to its target) is
 *     refused, typed, and the upgrade does not start.
 *   - RETAINED `dbBackupRetention` deep: older copies are purged once the new
 *     one is in place (a copy keeps rows users later deleted).
 */
function backupBeforeMigrating(db: DatabaseSync, targetVersion: number): void {
  const location = db.location();
  if (location === null || location === "") return;
  const hasVersions = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get() !== undefined;
  if (!hasVersions) return; // a fresh database has nothing to lose
  const current = readSchemaVersion(db);
  assertSchemaNotNewer(current);
  const pending = MIGRATIONS_IN_ORDER.find((migration) => migration.version > current && migration.version <= targetVersion);
  if (pending === undefined) return;
  const backup = preMigrationBackupPath(location, pending.version);
  writeVerifiedCopy(db, backup, (copy) => readSchemaVersion(copy) === current, "the pre-upgrade copy of the database");
  const retained = serverConfig.dbBackupRetention;
  for (const old of preMigrationBackups(location).slice(0, -retained)) {
    bestEffort(() => removeDatabaseCopy(old.path));
  }
  webWarn("migration", "database copied (verified) before a schema upgrade", () => ({ from: current, to: targetVersion, backup, retained }));
}

export function readSchemaVersion(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
    .get() as { version?: number } | undefined;
  return row?.version ?? 0;
}
