/**
 * Web-slice projection schema (SQLite).
 *
 * Canonical-ready projection: this schema models the Project → Chat →
 * Message projection that will migrate to the canonical harness when it
 * admits a Project entity. Until then, the web slice owns this projection.
 * The canonical timeline ledger remains the forensic authority — the
 * `timeline_refs` table stores REFERENCES (event IDs + metadata) to
 * canonical events, never full event content.
 *
 * Conventions:
 * Row schemas describe the shape returned by the DB client after
 * JSON columns are parsed. Column names use snake_case (SQL
 * convention); the server boundary maps to camelCase client views.
 * Input schemas describe validated payloads for inserts/updates.
 * JSON columns (config_overlay, input, output, snapshot, metadata)
 * are stored as TEXT; the DB client parses them at the boundary.
 *
 * Single source of truth: this module owns all projection row + input
 * types for the web-slice DB. Server routes import from here; the DB
 * client imports from here.
 */

import { z } from "zod";
import { MAX_PATH_LENGTH } from "../../shared/constants.ts";
import { EVENT_KIND_SCHEMA } from "../../shared/event-types.ts";
import { DEFAULT_PASSWORD_MIN_LENGTH } from "../kernel/config.ts";

// ── Configurable defaults ──

/**
 * Latest schema version. The migration runner applies migrations up to
 * this version when no explicit target is given. Stored in the
 * `schema_version` table; bumping this value requires adding a matching
 * migration entry in `./migrations.ts`.
 *
 * v10: user_prompt_prefs — per-user system-prompt preferences (encrypted).
 * v11: tool_calls.attempt_count — persists the per-run retry counter so
 * "attempt N" survives a page refresh (all tool-call fields
 * survive refresh; previously attempt_count was in-memory only).
 * v12: multi-user support — `users` table + `user_id` scoping column on
 * every user-data table (projects, tool_settings, user_model_prefs,
 * user_prompt_prefs, auth_sessions). Replaces the anonymous
 * `session_id` scoping key with a real authenticated `user_id` (FK to
 * users). Existing data is backfilled to a seeded admin user derived
 * from the legacy single-password `auth_config` row (or the
 * HARNESS_WEB_AUTH_PASSWORD env). The single shared password is GONE
 * each user has their own username + password.
 * v13: `idx_messages_chat_created` — (chat_id, created_at, rowid). The
 * history CURSOR pages a conversation backwards in its DECLARED order
 * (created_at, then rowid). Without this index that ORDER BY is a temp
 * b-tree over every message in the chat, which is the unbounded read the
 * cursor exists to remove, wearing a sort's clothes. With it, a page is a
 * backwards range scan of exactly the rows returned.
 * v14: `run_executions` — one row per run that has ever begun executing,
 * `run_id` as the PRIMARY KEY. The claim is the executor's FIRST statement,
 * so a second attempt to execute the same run is refused BY THE ENGINE
 * before any provider call can be made. See `RUN_EXECUTION_ROW`.
 * v15: `trashed_at` on projects and chats — the recycle bin. Live lists
 * hide rows with a timestamp; restore clears it. The product path never
 * `DELETE FROM` these tables (files on disk were already safe; the
 * conversation record was not).
 * v16: BEFORE DELETE triggers on the conversation record. A `DELETE FROM`
 * of a project, chat, message, tool call, metrics snapshot, auto-check,
 * timeline ref, or run execution is aborted by the engine — including
 * the sqlite3 CLI and a future method that forgets the recycle bin.
 * v17: `tool_calls.call_id` — the stable callId from the provider's
 * `tool_call_start`, persisted on the row. The callId is the identity the
 * WHOLE system keys tool calls by (the SSE frames, the client's live
 * cards, the gate's block bookkeeping), yet it lived only in the run
 * handler's memory — so a read-back of the chat's tool calls could not be
 * joined to the cards it was read back FOR. The run-end heal (a card whose
 * result frame never reached the client, healed from the ledger row) joins
 * on exactly this column. NULL on rows recorded before v17 (their cards
 * predate the heal; the honest placeholder stays for them).
 * v18: provider call IDs and tool names become encrypted JSON strings;
 * `public_projection` stores a separately encrypted display derivative.
 * Clone preserves original private call IDs while minting new local row IDs.
 * v19: MCP tool names take the naming owner's spec-legal spelling.
 * v20: every encrypted field is bound to its table, column, row and owner
 * (`BOUND_FIELDS_SCHEMA_VERSION`).
 */
export const SCHEMA_VERSION_LATEST = 20;

/**
 * The first migration that writes `enc:` fields under the persisted key (v5).
 * Below it a database holds no ciphertext the key (or passphrase salt) could
 * orphan — v4 only DECRYPTED legacy paths under its own derivation — so the
 * key admission may mint one for it (`resolveDatabaseKey`).
 */
export const FIRST_ENCRYPTED_SCHEMA_VERSION = 5;

/**
 * From this version every stored field is sealed under its binding
 * (`db-crypto.ts` `fieldBinding`), and a passphrase database needs its salt
 * file: below it, the key admission lets the database adopt the old fixed salt.
 */
export const BOUND_FIELDS_SCHEMA_VERSION = 20;

/**
 * THE CONVERSATION RECORD. These tables are never removed by the product
 * path. Hide a project or chat with `trashed_at`; children stay because the
 * parent cannot go. The ONE exception is the conversation archive
 * (`server/db/conversation-archive.ts`, the maintenance shell, server
 * stopped): trashed conversations only, after every row they own is written
 * to a verified archive file, in one transaction that lifts and re-creates
 * these triggers (`DbClient.purgeConversations`; UD-S15).
 * The trigger SQL is derived from this list (migrations v16), so adding a
 * table here without a matching trigger is impossible — the same loop
 * creates every trigger.
 */
export const UNDELETABLE_TABLES = [
  "projects",
  "chats",
  "messages",
  "tool_calls",
  "metrics_snapshots",
  "auto_checks",
  "timeline_refs",
  "run_executions",
] as const;
export type UndeletableTable = (typeof UNDELETABLE_TABLES)[number];

export function refuseDeleteTriggerName(table: UndeletableTable): string {
  return `refuse_delete_${table}`;
}

/** DDL for the v16 trigger. Table names come only from UNDELETABLE_TABLES. */
export function refuseDeleteTriggerSql(table: UndeletableTable): string {
  const name = refuseDeleteTriggerName(table);
  return (
    `CREATE TRIGGER IF NOT EXISTS ${name}\n` +
    `BEFORE DELETE ON ${table}\n` +
    `BEGIN\n` +
    `  SELECT RAISE(ABORT, '${table} rows are never deleted');\n` +
    `END;`
  );
}

// ── Message metadata (the rich per-message data that must survive refresh) ──

/**
 * The durable metadata blob persisted on each assistant message so the
 * full chat exposure (reasoning, tokens, timing, headers, model, finish
 * reason, injected context) survives a page refresh. The client-side
 * ChatMessage view model is reconstructed from this on history reload.
 *
 * Single source of truth: this shape mirrors the optional fields of the
 * client ChatMessage (src/state/chat-messages.ts). The run stream
 * accumulates these fields during streaming and persists the blob on
 * `finish`. The history endpoint returns it; hydrateChatFromHistory
 * spreads it back onto the ChatMessage. Every field is optional because
 * not every message has reasoning/headers/tool-calls.
 */
export const PUBLIC_MESSAGE_METADATA = z.object({
  reasoning: z.string().optional(),
  tokenMetrics: z
    .object({
      inputTokens: z.number().nonnegative(),
      outputTokens: z.number().nonnegative(),
      totalTokens: z.number().nonnegative(),
      cachedInputTokens: z.number().nonnegative().optional(),
      reasoningTokens: z.number().nonnegative().optional(),
    })
    .optional(),
  timingMetrics: z
    .object({
      startedAt: z.number(),
      firstTokenAt: z.number().optional(),
      finishedAt: z.number().optional(),
      ttftMs: z.number().optional(),
      totalMs: z.number().optional(),
      tps: z.number().optional(),
    })
    .optional(),
  responseHeaders: z.record(z.string(), z.string()).optional(),
  responseModel: z.string().optional(),
  /**
   * The trace id of the HTTP request that produced this assistant message —
   * the address of every ledger event that request recorded. Persisted so
   * the id survives a page refresh and stays reachable from the message
   * itself (the run view that carries it live retires shortly after the
   * run ends, which is exactly when an incident gets investigated).
   */
  traceId: z.string().min(1).optional(),
  finishReason: z.string().optional(),
  /**
   * The dedup summary for the LLM call that produced this assistant
   * message: how much of that call's input the dedup layer folded before
   * the request (chars before/after, pct, blocks removed). The run
   * stream accumulates it from the `dedup` SSE callback exactly the way
   * the response headers/model are accumulated, so the turn's savings
   * survive a page refresh — the savings belong to the call, and the
   * reloaded footer must show the same face the live one did. Absent
   * when the call removed nothing (no event fires — absence is the
   * honest state, never a zero).
   */
  dedupSummary: z
    .object({
      applied: z.boolean(),
      originalChars: z.number().nonnegative(),
      dedupedChars: z.number().nonnegative(),
      charReductionPct: z.number().nonnegative(),
      removedBlocks: z.number().nonnegative(),
      removedLines: z.number().nonnegative(),
      messageCount: z.number().nonnegative(),
    })
    .optional(),
  /**
   * The redaction notice for the LLM call that produced this assistant
   * message: how many values that call's input had masked before the
   * request left the machine, split by how confidently each was
   * identified (proven/format/inferred), the values already masked
   * upstream, and a value-free reason per masked span. Accumulated from
   * the `onRedaction` callback (which fires before the request, hence
   * before the turn's `start` frame) exactly the way the dedup summary
   * is, so the turn's masking face survives a page refresh — the
   * rewriting of the model's input is a fact about the turn, and the
   * reloaded footer must show the same face the live one did. NO field
   * here could carry the masked value itself: a preview of a secret is
   * the secret. Absent when the call masked nothing (no event fires —
   * absence is the honest state, never a zero).
   */
  redactionNotice: z
    .object({
      maskedCount: z.number().nonnegative(),
      proven: z.number().nonnegative(),
      format: z.number().nonnegative(),
      inferred: z.number().nonnegative(),
      maskedUpstream: z.number().nonnegative(),
      byTier: z.record(z.string(), z.number().nonnegative()),
      // Readonly: the server's notice is frozen at its owner
      // (`summarizeRedactions`), and the metadata blob never mutates a
      // reason in place — the persisted shape states that.
      reasons: z
        .array(
          z.object({
            confidence: z.enum(["proven", "format", "inferred"]),
            category: z.string(),
            maskedLength: z.number().nonnegative(),
            explanation: z.string(),
          }),
        )
        .readonly(),
    })
    .optional(),
  context: z
    .object({
      systemPrompt: z.string(),
      toolNames: z.array(z.string()),
      historyLength: z.number().nonnegative(),
      modelId: z.string().optional(),
      // memory + context-manager state (persisted so the Context
      // section survives a page refresh — part of "everything persists").
      recalledMemoryCount: z.number().nonnegative().optional(),
      contextTokens: z.number().nonnegative().optional(),
      historyTokens: z.number().nonnegative().optional(),
      contextTokenLimit: z.number().positive().optional(),
      contextTrimmed: z.boolean().optional(),
    })
    .optional(),
  // exp519 + eventKind persisted so inline event messages (hallucination,
  // steering, bias, self-healing, error, ui_control) survive a page refresh
  // even when they are stored as messages (not just reconstructed from
  // timeline refs). Validated against the canonical EVENT_KIND_SCHEMA (the
  // single vocabulary owner in shared/event-types.ts) — a typo or an
  // unknown value is rejected at the validation layer, not silently
  // persisted. The prior `z.string()` accepted any string (a validation gap
  // + a comment that falsely claimed alignment with the client type).
  eventKind: EVENT_KIND_SCHEMA.optional(),
  /**
   * The CANONICAL ledger event this inline event message IS — the eventId
   * recorded by the run that persisted the message. INTERNAL: it is an
   * address for the documents door (`GET /api/timeline/events/:eventId`),
   * never rendered text. Persisted so the fold survives a page refresh.
   * Absent for events recorded before this field existed, for gate-block
   * SSE frames (which carry no eventId), and for client-side errors that
   * were never recorded in a ledger at all.
   */
  timelineEventId: z.string().min(1).optional(),
  /**
   * For role="error" rows: the failure's own taxonomy code (the model error
   * event's `error.code` — the one writer is the run executor's error
   * projection, and it is the only code that ever reaches a row). INTERNAL:
   * never rendered — with the row's `run_id` it is the key that lets a
   * re-attach's REPLAYED error event recognize its own persisted row and
   * collapse into it instead of appending a same-words twin (the replay
   * dedup lives in the client's `appendErrorMessage`). Absent on error rows
   * recorded before this field existed — an older row simply never joins,
   * which can allow one twin, never swallow a new failure.
   */
  errorCode: z.string().min(1).optional(),
});
export const MESSAGE_METADATA = PUBLIC_MESSAGE_METADATA.extend({
  /** Private opaque host evidence. Never included in public metadata projections. */
  providerEvidence: z.unknown().optional(),
  /** Qualified derivative, interpreted only by the host observation owner. */
  providerObservation: z.unknown().optional(),
});
export type MessageMetadata = z.infer<typeof MESSAGE_METADATA>;

export const TOOL_PUBLIC_PROJECTION = z.object({
  observationKey: z.string().min(1),
  toolName: z.string(),
  input: z.unknown(),
  output: z.unknown(),
});
export type ToolPublicProjection = z.infer<typeof TOOL_PUBLIC_PROJECTION>;

// ── Row schemas (DB → typed object) ──

export const PROJECT_ROW = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  config_overlay: z.unknown().nullable(),
  /**
  * The owning user id (FK to users.id). The scoping key for ALL user data
   * (multi-user isolation — v12). Nullable only for rows that predate v12
   * and were not backfilled; new rows are ALWAYS created with a user_id.
   */
  user_id: z.string().nullable(),
  /** Legacy anonymous-browser session id (v2). Superseded by user_id; kept
   * inert for migration continuity (no query filters by it anymore). */
  session_id: z.string().nullable(),
  /**
   * Recycle-bin timestamp (ISO). Null = live. A set value hides the
   * project from live lists; restore clears it. Never a hard delete.
   */
  trashed_at: z.string().nullable().optional(),
});
export type ProjectRow = z.infer<typeof PROJECT_ROW>;

export const CHAT_ROW = z.object({
  id: z.string().min(1),
  project_id: z.string().min(1),
  title: z.string().min(1),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  model_id: z.string().nullable(),
  pinned: z.number().int().nonnegative().default(0),
  /** Recycle-bin timestamp (ISO). Null = live. See projects.trashed_at. */
  trashed_at: z.string().nullable().optional(),
});
export type ChatRow = z.infer<typeof CHAT_ROW>;

export const MESSAGE_ROW = z.object({
  id: z.string().min(1),
  chat_id: z.string().min(1),
  role: z.enum(["user", "assistant", "tool", "error", "event"]),
  content: z.string(),
  created_at: z.string().min(1),
  model_event_type: z.string().nullable(),
  run_id: z.string().nullable(),
  metadata: z.unknown().nullable(),
});
export type MessageRow = z.infer<typeof MESSAGE_ROW>;

/** Narrow ownership/turn projection; content is the first canonical user
 * row for that run, while turn counts every user row in its conversation. */
export const RUN_ATTRIBUTION_ROW = z.object({
  runId: z.string().min(1),
  chatId: z.string().min(1),
  chatTitle: z.string(),
  turn: z.number().int().positive().nullable(),
  requestContent: z.string().nullable(),
});
export type RunAttributionRow = z.infer<typeof RUN_ATTRIBUTION_ROW>;

export const TOOL_CALL_ROW = z.object({
  id: z.string().min(1),
  message_id: z.string().min(1),
  /**
   * Original provider call identity, encrypted at rest with the arguments.
   * Local row id is independent. NULL means no provider identity was recorded.
   */
  call_id: z.string().min(1).nullable(),
  public_projection: TOOL_PUBLIC_PROJECTION.nullable(),
  tool_name: z.string().min(1),
  input: z.unknown(),
  output: z.unknown().nullable(),
  status: z.enum(["running", "done", "error"]),
  duration_ms: z.number().nullable(),
  /**
  * How many times this tool was attempted in its run (retries included).
   * Persisted so the "attempt N" badge survives a page refresh (:
   * all tool-call fields survive refresh). 1 for a fresh successful call;
   * N for the Nth retry of a previously-failed call. Defaults to 1 for
   * rows created before v11 (the migration backfills 1).
   */
  attempt_count: z.number().int().positive().default(1),
  created_at: z.string().min(1),
});
export type ToolCallRow = z.infer<typeof TOOL_CALL_ROW>;

export const METRICS_SNAPSHOT_ROW = z.object({
  id: z.string().min(1),
  chat_id: z.string().min(1),
  snapshot: z.unknown(),
  created_at: z.string().min(1),
});
export type MetricsSnapshotRow = z.infer<typeof METRICS_SNAPSHOT_ROW>;

export const AUTO_CHECK_ROW = z.object({
  id: z.string().min(1),
  project_id: z.string().nullable(),
  chat_id: z.string().nullable(),
  check_name: z.string().min(1),
  status: z.enum(["running", "passed", "failed", "warning"]),
  output: z.unknown(),
  created_at: z.string().min(1),
});
export type AutoCheckRow = z.infer<typeof AUTO_CHECK_ROW>;

export const TIMELINE_REF_ROW = z.object({
  id: z.string().min(1),
  chat_id: z.string().min(1),
  event_id: z.string().min(1),
  event_type: z.string().min(1),
  timestamp: z.string().min(1),
  metadata: z.unknown(),
});
export type TimelineRefRow = z.infer<typeof TIMELINE_REF_ROW>;

/**
 * Per-user tool setting ("tools should be per user"). One row per
 * (user_id, tool_name). The `enabled` column is the per-user override of
 * the global config default; `config` holds per-user MCP/tool config JSON.
 * When a tool has NO row for a user, the global config default applies
 * (enabled unless explicitly disabled).
 *
 * Single source of truth: the global config's `tools.enabled` list is the
 * DEFAULT; this table is the per-user OVERRIDE. The merge logic lives in
 * the tools-bridge (`getEnabledToolManifestForUser`), not scattered.
 */
export const TOOL_SETTING_ROW = z.object({
  id: z.string().min(1),
  user_id: z.string().min(1),
  tool_name: z.string().min(1).max(256),
  enabled: z.boolean(),
  config: z.unknown().nullable(),
  updated_at: z.string().min(1),
});
export type ToolSettingRow = z.infer<typeof TOOL_SETTING_ROW>;

/**
 * ONE EXECUTION PER RUN — and the engine is what says so.
 *
 * A run is created by its start request and executed exactly once. Before the
 * executor assembles a prompt, calls a provider, or dispatches a tool, it
 * INSERTs this row. `run_id` is the PRIMARY KEY, so a second attempt raises
 * `SQLITE_CONSTRAINT_PRIMARYKEY` and the second executor never reaches the
 * provider. That property does not depend on any code being correct: it
 * survives a module that skips the facade, a route added years from now, and
 * the `sqlite3` CLI.
 *
 * WHY A TABLE AND NOT A FLAG. The predecessor was an in-memory boolean on the
 * run record which was written four times and read zero — computed, discarded,
 * and therefore worth nothing. A process-local flag also cannot answer the
 * question across a restart, and cannot answer it at all for a caller that
 * reached the executor by a door nobody has written yet. The database can.
 *
 * The row is never deleted. It is the record that this run was executed, which
 * is the same fact the claim rests on — deleting it to "free" the id would
 * re-open the very duplicate it exists to refuse.
 */
export const RUN_EXECUTION_ROW = z.object({
  run_id: z.string().min(1),
  user_id: z.string().min(1),
  claimed_at: z.string().min(1),
});
export type RunExecutionRow = z.infer<typeof RUN_EXECUTION_ROW>;

export const SCHEMA_VERSION_ROW = z.object({
  version: z.number().int().nonnegative(),
  applied_at: z.string().min(1),
});
export type SchemaVersionRow = z.infer<typeof SCHEMA_VERSION_ROW>;

// ── Auth (multi-user — authentication; v12) ──

/**
 * A registered user. `username` is UNIQUE (the login identity). `password_hash`
 * is the scrypt hash (encrypted at rest by DbCrypto). `is_admin` flags the
 * first registered user (and any promoted thereafter) — the first user
 * becomes the admin (directive). This table REPLACES the legacy
 * single-password `auth_config` row as the identity authority.
 */
export const USER_ROW = z.object({
  id: z.string().min(1),
  username: z.string().min(1),
  /** scrypt hash (encrypted at rest). Format: scrypt$N$r$p$saltB64$hashB64. */
  password_hash: z.string().min(1),
  is_admin: z.number().int().min(0).max(1),
  created_at: z.string().min(1),
});
export type UserRow = z.infer<typeof USER_ROW>;

/**
 * The legacy single-password-hash row (v8). KEPT for the v12 backfill
 * (the admin user is seeded from this row when it exists) and for
 * migration continuity. NOT used by the auth flow after v12 — `users` is
 * the identity authority. `key` is always "default". `password_hash` is
 * the scrypt hash (encrypted at rest by the DbCrypto layer).
 */
export const AUTH_CONFIG_ROW = z.object({
  key: z.literal("default"),
  password_hash: z.string().min(1),
  created_at: z.string().min(1),
});
export type AuthConfigRow = z.infer<typeof AUTH_CONFIG_ROW>;

/**
 * A session row. `token_hash` is the SHA-256 of the raw session token (the
 * raw token lives only in the cookie). `created_at` + the config TTL govern
 * expiry. `user_id` (v12) links the session to the authenticated user — the
 * scoping key for all user data. `session_id` is the legacy anonymous-browser
 * tracking id (kept for audit; no longer a scoping key).
 */
export const AUTH_SESSION_ROW = z.object({
  token_hash: z.string().min(1),
  user_id: z.string().min(1),
  session_id: z.string().min(1),
  created_at: z.string().min(1),
});
export type AuthSessionRow = z.infer<typeof AUTH_SESSION_ROW>;

/**
 * Per-user model/provider preferences (models in DB, not config).
 * `user_id` scopes to the user. `config_json` is the encrypted JSON blob
 * holding the user's provider + model overrides (encrypted at rest by
 * DbCrypto). `updated_at` for cache invalidation.
 */
export const USER_MODEL_PREF_ROW = z.object({
  id: z.string().min(1),
  user_id: z.string().min(1),
  config_json: z.string().min(1),
  updated_at: z.string().min(1),
});
export type UserModelPrefRow = z.infer<typeof USER_MODEL_PREF_ROW>;

export const USER_MODEL_PREF_UPSERT_INPUT = z.object({
  user_id: z.string().min(1),
  config_json: z.unknown(),
});
export type UserModelPrefUpsertInput = z.infer<typeof USER_MODEL_PREF_UPSERT_INPUT>;

/**
 * Per-user system-prompt preferences (system prompt configurable
 * from the web, stored per-user encrypted in the DB — follows the
 * user_model_prefs pattern). `user_id` scopes to the user; `prefs_json`
 * is the encrypted JSON blob holding the user's system-prompt override +
 * tone / sentence-case / emoji / icon preferences. The chat run route
 * reads from here first (per-user override), falling back to the
 * config-file defaults (the global seed). `updated_at` for cache
 * invalidation.
 */
export const USER_PROMPT_PREF_ROW = z.object({
  id: z.string().min(1),
  user_id: z.string().min(1),
  prefs_json: z.string().min(1),
  updated_at: z.string().min(1),
});
export type UserPromptPrefRow = z.infer<typeof USER_PROMPT_PREF_ROW>;

// ── Input schemas (validated before insert/update) ──
//
// These DB-layer input types are suffixed `*DbInput` to distinguish them
// from the WIRE-input types in `shared/input-schemas.ts` (the
// client-facing shapes). They are a DIFFERENT concern: the DB-layer
// validation uses snake_case field names (SQL convention) + path-derived
// fields like `project_id` (the route injects these from the URL path
// before calling the DB client). The wire types use camelCase + omit the
// path-derived fields. Both derive from zod schemas, but they validate
// at different layers (route → wire; DB client → DB shape). The naming
// split prevents a silent swap (passing a wire `ChatCreateInput` where a
// DB `ChatCreateDbInput` is expected would be a compile error, not a
// runtime bug).

export const PROJECT_CREATE_INPUT = z.object({
  name: z.string().min(1).max(256),
  path: z.string().min(1).max(MAX_PATH_LENGTH),
});
export type ProjectCreateDbInput = z.infer<typeof PROJECT_CREATE_INPUT>;

export const CHAT_CREATE_INPUT = z.object({
  project_id: z.string().min(1),
  title: z.string().min(1).max(256),
  model_id: z.string().min(1).max(256).optional(),
});
export type ChatCreateDbInput = z.infer<typeof CHAT_CREATE_INPUT>;

export const MESSAGE_CREATE_INPUT = z.object({
  chat_id: z.string().min(1),
  role: z.enum(["user", "assistant", "tool", "error", "event"]),
  content: z.string(),
  model_event_type: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  metadata: z.unknown().optional(),
});
export type MessageCreateInput = z.infer<typeof MESSAGE_CREATE_INPUT>;

/**
 * Partial metadata update for an existing message. Used by the run
 * stream to persist the accumulated rich fields (reasoning, tokens,
 * timing, headers, model, finish reason, context) on the `finish`
 * event. All fields optional — only the provided ones are merged.
 */
export const MESSAGE_METADATA_UPDATE = MESSAGE_METADATA.partial();
export type MessageMetadataUpdate = z.infer<typeof MESSAGE_METADATA_UPDATE>;

/**
 * Metadata for inline event messages (role="event"). Carries the event
 * kind (hallucination, steering, bias, self-healing, error, ui_control) +
 * optional description so the chat can render styled inline entries.
 * Persisted in the `metadata` column alongside other message metadata.
 * `eventKind` now validates against the canonical EVENT_KIND_SCHEMA
 * (shared/event-types.ts) — was a 5-value inline enum that drifted
 * from the client's 6-value `EventKind`.
 */
export const MESSAGE_EVENT_METADATA = z.object({
  eventKind: EVENT_KIND_SCHEMA,
  description: z.string().optional(),
});
export type MessageEventMetadata = z.infer<typeof MESSAGE_EVENT_METADATA>;

// ── Rename / pin inputs (sidebar rework) ──

export const PROJECT_RENAME_INPUT = z.object({
  name: z.string().min(1).max(256),
});
export type ProjectRenameInput = z.infer<typeof PROJECT_RENAME_INPUT>;

export const CHAT_RENAME_INPUT = z.object({
  title: z.string().min(1).max(256),
});
export type ChatRenameInput = z.infer<typeof CHAT_RENAME_INPUT>;

export const CHAT_PIN_INPUT = z.object({
  pinned: z.boolean(),
});
export type ChatPinInput = z.infer<typeof CHAT_PIN_INPUT>;

export const TOOL_CALL_CREATE_INPUT = z.object({
  message_id: z.string().min(1),
  tool_name: z.string().min(1).max(256),
  /** The provider's stable callId (`tool_call_start`), when the caller
   *  knows it — the run stream always does. See TOOL_CALL_ROW.call_id. */
  call_id: z.string().min(1).optional(),
  public_projection: TOOL_PUBLIC_PROJECTION.optional(),
  input: z.unknown(),
  output: z.unknown().optional(),
  status: z.enum(["running", "done", "error"]),
  duration_ms: z.number().nonnegative().optional(),
  /**
  * Attempt number for this tool call (1 = first attempt; N = Nth retry
   * of a previously-failed call). Persisted so the "attempt N" badge
   * survives a page refresh. Defaults to 1 (a fresh call).
   */
  attempt_count: z.number().int().positive().optional(),
});
export type ToolCallCreateInput = z.infer<typeof TOOL_CALL_CREATE_INPUT>;

export const METRICS_SNAPSHOT_CREATE_INPUT = z.object({
  chat_id: z.string().min(1),
  snapshot: z.unknown(),
});
export type MetricsSnapshotCreateInput = z.infer<typeof METRICS_SNAPSHOT_CREATE_INPUT>;

export const AUTO_CHECK_CREATE_INPUT = z.object({
  project_id: z.string().min(1).optional(),
  chat_id: z.string().min(1).optional(),
  check_name: z.string().min(1).max(256),
  status: z.enum(["running", "passed", "failed", "warning"]),
  output: z.unknown(),
});
export type AutoCheckCreateDbInput = z.infer<typeof AUTO_CHECK_CREATE_INPUT>;

export const TIMELINE_REF_CREATE_INPUT = z.object({
  chat_id: z.string().min(1),
  event_id: z.string().min(1),
  event_type: z.string().min(1),
  timestamp: z.string().min(1),
  metadata: z.unknown(),
});
export type TimelineRefCreateInput = z.infer<typeof TIMELINE_REF_CREATE_INPUT>;

/**
 * Upsert a per-user tool setting. The (user_id, tool_name) pair is
 * unique; re-toggling replaces the prior row. `config` is optional per-user
 * MCP/tool config JSON (null when only the enabled flag changed).
 *
 * The `user_id` is NOT part of the input shape — it is a separate, server-
 * controlled parameter to `DbClient.upsertToolSetting(input, userId)`. This
 * keeps the ownership gate at the DB method (Single-Party-Owner: the method
 * enforces scoping, not the caller). A caller cannot accidentally pass a
 * client-supplied user_id through the input object.
 */
export const TOOL_SETTING_UPSERT_INPUT = z.object({
  tool_name: z.string().min(1).max(256),
  enabled: z.boolean(),
  config: z.unknown().optional(),
});
export type ToolSettingUpsertInput = z.infer<typeof TOOL_SETTING_UPSERT_INPUT>;

// ── Rollback input (used by the rollback route) ──

export const ROLLBACK_INPUT = z.object({
  to_message_id: z.string().min(1),
});
export type RollbackInput = z.infer<typeof ROLLBACK_INPUT>;

// ── User auth inputs (v12: multi-user) ──

/**
 * Create a user. `username` is unique (collision → 409 at the route layer).
 * `password` is the PLAINTEXT password — the route hashes it (scrypt) before
 * calling `db.createUser({ username, password_hash })`. The first user
 * registered becomes the admin (directive).
 */
export const USER_REGISTER_INPUT = z.object({
  username: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.@-]+$/, "Username may only contain letters, digits, and _ . @ -"),
  password: z.string().min(DEFAULT_PASSWORD_MIN_LENGTH).max(1024),
});
export type UserRegisterInput = z.infer<typeof USER_REGISTER_INPUT>;

export const USER_LOGIN_INPUT = z.object({
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(1024),
});
export type UserLoginInput = z.infer<typeof USER_LOGIN_INPUT>;

// ── Composite history payload (one chat's full history) ──

/**
 * Full history for a chat: the chat row plus all messages, tool calls,
 * metrics snapshots, and timeline refs. Returned by the history endpoint
 * as a single payload so the client can hydrate every store on chat
 * switch with one round-trip.
 */
export type ChatHistory = Readonly<{
  readonly chat: ChatRow;
  readonly messages: readonly MessageRow[];
  readonly tool_calls: readonly ToolCallRow[];
  readonly metrics_snapshots: readonly MetricsSnapshotRow[];
  readonly timeline_refs: readonly TimelineRefRow[];
}>;

// ── The history CURSOR (DESIGN-PERFORMANCE §4) ──

/**
 * WHERE A PAGE ENDED, AND WHY — the honest half of a bounded read.
 *
 * A page that simply stops is indistinguishable from a conversation that
 * ends there, and "this is the beginning" is a different statement from
 * "I have not fetched the rest yet" (§1 L3). So every page says which of
 * the two it is, and a reader that has not reached the beginning always
 * holds the cursor that would take it further.
 *
 * `olderCursor` is OPAQUE to the client: it is this server's encoding of
 * `(created_at, rowid)` for the page's oldest message, and no client may
 * construct or interpret one. It is present exactly when `hasOlder` is
 * true, so "there is more, and here is how to ask for it" is one fact
 * rather than two that can disagree.
 */
export type HistoryPageFacts = Readonly<{
  /** The row bound this page was asked for. */
  readonly limit: number;
  /** Messages actually in this page. */
  readonly returned: number;
  /** Older messages exist before this page's oldest. */
  readonly hasOlder: boolean;
  /** Opaque cursor for the page BEFORE this one; null iff `hasOlder` is false. */
  readonly olderCursor: string | null;
  /** How many messages the conversation holds — a COUNT, never a length. */
  readonly messageCount: number;
  /**
   * Which bound ended the page. `beginning` means the conversation has no
   * older message — the ONLY value that licenses the surface to say a
   * conversation starts here.
   */
  readonly endedBy: "limit" | "bytes" | "beginning";
}>;

/** The TAIL page of a conversation: the chat, its newest messages, and the
 * cursor that reaches further back. */
export type ChatHistoryPage = ChatHistory & Readonly<{ readonly page: HistoryPageFacts }>;

/** One page of OLDER messages — a delta, not a conversation. It carries no
 * metrics snapshots and no timeline refs, because it has nothing true to say
 * about them: they are conversation-wide collections delivered with the tail,
 * and an empty array here would read as "there are none". */
export type ChatMessagePage = Readonly<{
  readonly chat_id: string;
  readonly messages: readonly MessageRow[];
  readonly tool_calls: readonly ToolCallRow[];
  readonly page: HistoryPageFacts;
}>;
