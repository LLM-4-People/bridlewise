import { checkpointSqlite, establishWalJournal, recordFieldsBound, type AdmittedKeyHome, guarded } from "../kernel/canonical.ts";
/**
 * Thin SQLite DB client wrapping `node:sqlite` for the web-slice
 * projection. CRUD methods for each table; inputs are Zod-validated and
 * results are typed. JSON columns are stringified/parsed at this
 * boundary so callers never touch raw TEXT.
 *
 * The DB file path is configurable (default: `.bridlewise/web.db`
 * under the workspace). `:memory:` is supported for tests.
 *
 * One DbClient owns one DatabaseSync handle. The server creates a
 * single shared instance (see `./index.ts`); route files receive it
 * via dependency injection (no global singleton lookup in routes).
 *
 * ── Single-Party-Owner: userId threading ──
 * EVERY method that reads or writes user-scoped data takes a `userId`
 * parameter and filters ALL queries by it (directly on `user_id`, or via
 * a JOIN chain to the owning project). The DB layer ITSELF enforces the
 * scoping — a route that forgets to pass `userId` cannot read/write
 * another user's data because the method returns null/empty (reads) or
 * throws ForbiddenError / affects 0 rows (writes). The caller-gated
 * `projectBelongsToUser`/`chatBelongsToUser` dance in every route is
 * GONE; the gate is in the owner, not in each call site.
 *
 * projects → direct `user_id` column.
 * chats → JOIN chats ⋈ projects ON user_id.
 * messages → JOIN messages ⋈ chats ⋈ projects ON user_id.
 * tool_calls → JOIN tool_calls ⋈ messages ⋈ chats ⋈ projects.
 * metrics_snapshots → JOIN metrics_snapshots ⋈ chats ⋈ projects.
 * auto_checks → project_id / chat_id →... → projects.user_id.
 * timeline_refs → JOIN timeline_refs ⋈ chats ⋈ projects.
 * tool_settings / prefs → direct `user_id` (already scoped pre-v12).
 *
 * Reads return null/empty when not owned (existence is hidden). CREATE
 * methods verify the parent belongs to the user and throw ForbiddenError
 * (HTTP 403) on ownership failure — a silent null on a create would look
 * like success to the caller. UPDATE/DELETE scope the WHERE clause by the
 * ownership JOIN so a non-owned row is never touched (0 rows affected).
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { admitDatabaseProvenance, databaseProvenanceOf, type DatabaseProvenance } from "../../engine/src/filesystem/database-provenance.ts";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  PROJECT_ROW,
  CHAT_ROW,
  MESSAGE_ROW,
  RUN_ATTRIBUTION_ROW,
  TOOL_CALL_ROW,
  TOOL_PUBLIC_PROJECTION,
  type ToolPublicProjection,
  METRICS_SNAPSHOT_ROW,
  AUTO_CHECK_ROW,
  TIMELINE_REF_ROW,
  TOOL_SETTING_UPSERT_INPUT,
  PROJECT_CREATE_INPUT,
  CHAT_CREATE_INPUT,
  MESSAGE_CREATE_INPUT,
  TOOL_CALL_CREATE_INPUT,
  METRICS_SNAPSHOT_CREATE_INPUT,
  AUTO_CHECK_CREATE_INPUT,
  TIMELINE_REF_CREATE_INPUT,
  MESSAGE_METADATA,
  type ProjectRow,
  type ChatRow,
  type MessageRow,
  type RunAttributionRow,
  type ToolCallRow,
  type MetricsSnapshotRow,
  type AutoCheckRow,
  type TimelineRefRow,
  type ToolSettingRow,
  type ToolSettingUpsertInput,
  type ProjectCreateDbInput,
  type ChatCreateDbInput,
  type MessageCreateInput,
  type ToolCallCreateInput,
  type MetricsSnapshotCreateInput,
  type AutoCheckCreateDbInput,
  type TimelineRefCreateInput,
  type MessageMetadataUpdate,
  type ChatHistory,
  type ChatHistoryPage,
  type ChatMessagePage,
  type HistoryPageFacts,
  type UserRow,
  BOUND_FIELDS_SCHEMA_VERSION,
  UNDELETABLE_TABLES,
  refuseDeleteTriggerName,
  refuseDeleteTriggerSql,
} from "./schema.ts";
import { runMigrations, readSchemaVersion } from "./migrations.ts";
import { createDbCrypto, databaseKeyProof, openRow, sealRow, type DbCrypto } from "./db-crypto.ts";
import { decodeJsonOrNull, encodeJson, snapshotDbWriteArguments } from "./json-columns.ts";
import { getTimelineRecorder } from "../observability/timeline-bridge.ts";
import { TIMELINE_CHECK_STATUS_DOCUMENT, randomUuid, bestEffort } from "../kernel/canonical.ts";
import { sha256 } from "../kernel/digest.ts";
// The per-chat history reads are PAGED; the page size is a configurable
// owned by server/config.ts (the single config authority), never a literal
// here. This module still reads no env vars of its own.
import { serverConfig } from "../kernel/config.ts";
import { ValidationError, ForbiddenError, ConflictError, WebError } from "../kernel/errors.ts";
import { webWarn } from "../observability/debug-bridge.ts";

// ── Configurables ──

// The default DB path is owned by server/config.ts (the centralized config
// authority). Tests pass an explicit path; the server singleton reads it via
// serverConfig.dbPath (see./index.ts). This module no longer reads env vars.

/**
 * Normalize a filesystem path for comparison: resolve to an absolute, canonical
 * form. Two paths that point at the same directory (`/foo/bar`, `/foo/bar/`,
 * `/foo/./bar`) compare equal after normalization. The single owner of the
 * "same project path" comparison (used by `getProjectByPath` /
 * `projectPathBelongsToUser` so a route-supplied path matches a stored
 * project path regardless of trailing-slash / `.` differences).
 */
function normalizePath(path: string): string {
  return resolve(path);
}

/** The durability posture of one connection, as observed rather than asked
 * for. `windowMs` is the requested best-effort checkpoint cadence; zero
 * means this connection runs no checkpoint timer, not a zero-loss guarantee. */
export type DurabilityFacts = Readonly<{ synchronous: string; windowMs: number }>;

export type DbClientConfig = {
  readonly path: string;
  readonly schemaVersion?: number;
  /** `PRAGMA synchronous` override. Defaults to `serverConfig.dbSynchronous`
   * (which states the trade in numbers). Present so a caller with a different
   * durability requirement — or a test measuring one — can say so explicitly
   * rather than mutating global config. */
  readonly synchronous?: string;
  readonly busyTimeoutMs?: number;
  /** Best-effort checkpoint interval override in ms; defaults to
   * `serverConfig.dbDurabilityWindowMs`. 0 disables the checkpoint timer. */
  readonly durabilityWindowMs?: number;
  /** Encryption-at-rest provider. When omitted, a persisted-key DbCrypto
   * is created from `path` (a key in the key home for real DBs; an
   * ephemeral in-process key for `:memory:`). Pass an explicit instance
   * only when you intentionally want plaintext (e.g. createNoopDbCrypto). */
  readonly crypto?: DbCrypto;
  /** Optional passphrase for the encryption key (HARNESS_WEB_DB_KEY). When
   * set, the key is scrypt-derived from the passphrase instead of a key file. */
  readonly passphrase?: string;
  /** An admitted key home (`admitKeyHome`); absent: the one the environment names. */
  readonly keyHome?: AdmittedKeyHome;
  /**
   * Open the connection READ-ONLY, so SQLite itself refuses every write.
   *
   * The async facade's read pool uses this, and the reason is that "the pool
   * only runs reads" should not be a promise kept by a lookup table. The
   * table (`method-kinds.ts`) says which methods go where; this makes the
   * consequence of getting that wrong an immediate, loud
   * `attempt to write a readonly database` instead of a second writer racing
   * the first for the WAL. In WAL mode there is exactly one writer, and here
   * that is a property of the file handles rather than of anyone's care.
   *
   * A read-only connection also cannot set `journal_mode`, cannot run
   * migrations, and runs no checkpoint timer — so all three are
   * skipped, and `schemaVersion` is READ rather than established.
   */
  readonly readOnly?: boolean;
};

// ── Row parsing (each sensitive column is decrypted at the boundary) ──
//
// The crypto instance is threaded into every parse function so reads
// transparently return plaintext to callers. Structural columns (ids,
// timestamps, status, role, session_id, FK ids, check_name,
// model_id, pinned, event_type, event_id, run_id, model_event_type,
// duration_ms) are NOT encrypted (rule: keep queryable fields plaintext).
// Sensitive user content (name, path, title, content, JSON blobs) IS
// encrypted at rest with the persisted key (server/db-crypto.ts).

// Every parser takes the OWNING USER the caller already verified (every read
// is user-scoped): the binding includes it, so a row whose ownership chain an
// edit re-pointed at another user does not open for that user.

function parseProjectRow(row: Record<string, unknown>, crypto: DbCrypto, owner: string): ProjectRow {
  const open = openRow(crypto, "projects", row, owner);
  return PROJECT_ROW.parse({
    id: row["id"],
    name: open["name"],
    // Path is encrypted at rest (it reveals the user's directory structure).
    path: open["path"],
    created_at: row["created_at"],
    updated_at: row["updated_at"],
    config_overlay: decodeJsonOrNull(open["config_overlay"] as string | null),
    user_id: (row["user_id"] as string | null | undefined) ?? null,
    session_id: (row["session_id"] as string | null | undefined) ?? null,
    trashed_at: (row["trashed_at"] as string | null | undefined) ?? null,
  });
}

function parseChatRow(row: Record<string, unknown>, crypto: DbCrypto, owner: string): ChatRow {
  const open = openRow(crypto, "chats", row, owner);
  return CHAT_ROW.parse({
    id: row["id"],
    project_id: row["project_id"],
    title: open["title"],
    created_at: row["created_at"],
    updated_at: row["updated_at"],
    model_id: row["model_id"],
    pinned: (row["pinned"] as number | null | undefined) ?? 0,
    trashed_at: (row["trashed_at"] as string | null | undefined) ?? null,
  });
}

function parseMessageRow(row: Record<string, unknown>, crypto: DbCrypto, owner: string): MessageRow {
  const open = openRow(crypto, "messages", row, owner);
  return MESSAGE_ROW.parse({
    id: row["id"],
    chat_id: row["chat_id"],
    role: row["role"],
    content: open["content"],
    created_at: row["created_at"],
    model_event_type: row["model_event_type"],
    run_id: row["run_id"],
    metadata: decodeJsonOrNull(open["metadata"] as string | null | undefined),
  });
}

function parseToolCallRow(row: Record<string, unknown>, crypto: DbCrypto, owner: string): ToolCallRow {
  const open = openRow(crypto, "tool_calls", row, owner);
  return TOOL_CALL_ROW.parse({
    id: row["id"],
    message_id: row["message_id"],
    call_id: decodeJsonOrNull(open["call_id"] as string | null),
    tool_name: decodeJsonOrNull(open["tool_name"] as string),
    public_projection: decodeJsonOrNull(open["public_projection"] as string | null),
    input: decodeJsonOrNull(open["input"] as string),
    output: decodeJsonOrNull(open["output"] as string | null),
    status: row["status"],
    duration_ms: row["duration_ms"] as number | null,
    // attempt_count is backfilled to 1 by migration v11 (NOT NULL DEFAULT 1);
    // a NULL here (a row that predates the migration on a DB opened with
    // createNoopDbCrypto before migration) falls back to 1 via the schema
    // default so the row shape stays valid.
    attempt_count: (row["attempt_count"] as number | null | undefined) ?? 1,
    created_at: row["created_at"],
  });
}

function parseMetricsSnapshotRow(row: Record<string, unknown>, crypto: DbCrypto, owner: string): MetricsSnapshotRow {
  const open = openRow(crypto, "metrics_snapshots", row, owner);
  return METRICS_SNAPSHOT_ROW.parse({
    id: row["id"],
    chat_id: row["chat_id"],
    snapshot: decodeJsonOrNull(open["snapshot"] as string),
    created_at: row["created_at"],
  });
}

function parseAutoCheckRow(row: Record<string, unknown>, crypto: DbCrypto, owner: string): AutoCheckRow {
  const open = openRow(crypto, "auto_checks", row, owner);
  return AUTO_CHECK_ROW.parse({
    id: row["id"],
    project_id: row["project_id"],
    chat_id: row["chat_id"],
    check_name: row["check_name"],
    status: row["status"],
    output: decodeJsonOrNull(open["output"] as string),
    created_at: row["created_at"],
  });
}

function parseTimelineRefRow(row: Record<string, unknown>, crypto: DbCrypto, owner: string): TimelineRefRow {
  const open = openRow(crypto, "timeline_refs", row, owner);
  return TIMELINE_REF_ROW.parse({
    id: row["id"],
    chat_id: row["chat_id"],
    event_id: row["event_id"],
    event_type: row["event_type"],
    timestamp: row["timestamp"],
    metadata: decodeJsonOrNull(open["metadata"] as string),
  });
}

// tool_settings has no encrypted columns — user_id, tool_name, enabled,
// and config are all structural/queryable. config is a JSON blob (encoded at
// insert, decoded at read — NOT encrypted, since it holds tool/MCP config
// metadata, not user content).
function parseToolSettingRow(row: Record<string, unknown>): ToolSettingRow {
  return {
    id: row["id"] as string,
    user_id: row["user_id"] as string,
    tool_name: row["tool_name"] as string,
    enabled: Number(row["enabled"]) === 1,
    config: decodeJsonOrNull(row["config"] as string | null),
    updated_at: row["updated_at"] as string,
  };
}

// ── Ownership scoping SQL fragments (Single-Party-Owner) ──
//
// Reusable subqueries that resolve a resource id to its owning user. They
// are the choke point: every scoped WHERE/JOIN reuses one of these so the
// user_id filter is applied exactly once, in the owner, never duplicated
// across routes. Each maps a child resource to `projects.user_id`.

/** `projects.id IN (...)` resolving to the user's projects. */
const USER_PROJECTS = "SELECT id FROM projects WHERE user_id = ?";
/** `chats.id IN (...)` resolving to chats under the user's projects. */
const USER_CHATS = `SELECT id FROM chats WHERE project_id IN (${USER_PROJECTS})`;
/** `messages.id IN (...)` resolving to messages under the user's chats. */
const USER_MESSAGES = `SELECT id FROM messages WHERE chat_id IN (${USER_CHATS})`;

// ── The chat→runs mapping (owned here, consumed everywhere) ──
//
// `messages.run_id` is the one authoritative source of "which runs belong
// to this chat": every persisted message records the run that produced it,
// and `timeline_refs.metadata` is client-writable (see `runIdsForChat` for
// the cross-user poison it would allow), so it is never consulted. The
// statement is exported so every reader prepares the SAME bytes — the
// server route composes its user-ownership gate after it
// (`runIdsForChat`), and the dev trace CLI (`scripts/trace.ts --chat`)
// prepares it on its own read-only connection to resolve a chat id to run
// ids before digging the ledger. A hand-copied variant anywhere would be a
// mirror that can drift; this constant is the single owner.

/** `SELECT DISTINCT run_id` for one chat — the chat→runs mapping's owned
 * predicate. Takes the chat id as its one bound parameter. */
export const CHAT_RUN_IDS_SQL =
  "SELECT DISTINCT run_id FROM messages WHERE chat_id = ? AND run_id IS NOT NULL AND run_id != ''";

// ── Keyset paging (see `DbClient.pageAllRows`) ──

/** One paged, user-scoped read. Split into its parts because the owner has to
 * ASSEMBLE the statement — inject the cursor columns, AND the cursor
 * predicate onto the WHERE, and pick the ORDER BY — which it cannot do to an
 * opaque SQL string. */
type PagedRead = Readonly<{
  /** The caller's SELECT list, e.g. `"m.*"`. */
  columns: string;
  /** Everything after `FROM`, ending in the WHERE that scopes the read to
   * one chat and one user. The cursor predicate is ANDed onto that WHERE, so
   * it must be the last clause — no ORDER BY, GROUP BY or LIMIT here. */
  source: string;
  /** The paging key, outermost first. Must be UNIQUE as a tuple and
   * SEEKABLE by an existing index. `as` is the result alias the walk reads
   * the next cursor from. */
  cursor: readonly Readonly<{ expr: string; as: string }>[];
  /** The DECLARED total ordering of what the caller receives, by RESULT
   * column name, outermost first. Applied once over the assembled rows. */
  order: readonly string[];
}>;

/** `(a > ?)` for one column; `((a > ?) OR (a = ? AND b > ?))` for two — the
 * lexicographic "strictly after this tuple", written out so the planner sees
 * an ordinary range predicate on the leading column. */
function keysetPredicate(cursor: PagedRead["cursor"]): string {
  const clauses = cursor.map((col, i) => {
    const equal = cursor.slice(0, i).map((prev) => `${prev.expr} = ?`);
    return `(${[...equal, `${col.expr} > ?`].join(" AND ")})`;
  });
  return `(${clauses.join(" OR ")})`;
}

/**
 * The bind values for `keysetPredicate`, read off the last row of a page.
 *
 * A cursor column that did not come back — a mistyped alias, a SELECT list
 * that dropped it — would bind NULL, every comparison against NULL is false,
 * and the walk would stop after one page. That is silent truncation: the
 * caller receives a prefix of the conversation and nothing says so, which is
 * precisely the failure the paging owner exists to make impossible. So it
 * throws instead.
 */
function keysetValues(
  cursor: PagedRead["cursor"],
  last: Record<string, unknown>,
): readonly (string | number | bigint)[] {
  const values: (string | number | bigint)[] = [];
  for (let i = 0; i < cursor.length; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      const alias = cursor[j]!.as;
      const value = last[alias];
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
        throw new WebError(
          `paging cursor "${alias}" is missing or not comparable (${String(value)}) — ` +
            "the walk would stop after one page and truncate the read silently",
          "paging_cursor_unreadable",
        );
      }
      values.push(value);
    }
  }
  return values;
}

/** Compare two rows by the named result columns, ascending. Numbers and
 * bigints compare numerically (a rowid past 2^53 arrives as a bigint and
 * would sort as a STRING otherwise, putting "10" before "9"); everything else
 * compares as text, which is how SQLite ordered the ISO timestamps this
 * replaces. */
function compareByColumns(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  columns: readonly string[],
): number {
  for (const column of columns) {
    const left = a[column];
    const right = b[column];
    if (
      (typeof left === "number" || typeof left === "bigint") &&
      (typeof right === "number" || typeof right === "bigint")
    ) {
      if (left < right) return -1;
      if (left > right) return 1;
      continue;
    }
    const ls = String(left);
    const rs = String(right);
    if (ls < rs) return -1;
    if (ls > rs) return 1;
  }
  return 0;
}

// ── The history CURSOR (DESIGN-PERFORMANCE §4) ──

/**
 * A position in one conversation's DECLARED order: `(created_at, rowid)`.
 *
 * `created_at` alone is not a position — two messages written in the same
 * millisecond share it, and a cursor that cannot separate them either skips a
 * message or repeats one at every page boundary. `rowid` alone is not the
 * declared order (see `pageAllRows`). The pair is both unique and the order
 * the reader is owed, which is why `idx_messages_chat_created` exists.
 */
export type HistoryCursor = Readonly<{ createdAt: string; rowid: number }>;

/**
 * Separator that cannot occur in an ISO timestamp or a decimal integer.
 */
const CURSOR_SEPARATOR = "\0";

/**
 * THE CREATED_AT A CURSOR CARRIES IS ALWAYS THE DB'S OWN WRITE SHAPE.
 *
 * Every message row this database writes stamps `created_at` with
 * `new Date().toISOString()`, which is ALWAYS
 * `YYYY-MM-DDTHH:MM:SS.sssZ` — fixed width, fixed punctuation. That is
 * not a stylistic fact; it is the load-bearing half of the cursor's
 * lexicographic position (`created_at <= ?` compares TEXT), and it is what
 * makes a malformed timestamp DETECTABLE rather than merely wrong.
 *
 * Measured live (UIE-038): one server process served a page-1
 * `olderCursor` whose createdAt had BOTH colons replaced by '4'
 * (`…T12444444.159Z`). A colon-less timestamp sorts lexicographically
 * BEFORE every real one, so `/history/older` matched zero rows and the
 * endpoint answered `endedBy:"beginning"` while 81 older messages — five
 * whole turns — sat in the database: a FALSE beginning served with a
 * truthful face, the most brutal silent failure this paging has. The
 * database file held every row colon-intact and a restart healed it, so
 * the corruption was in-process and unreproducible on demand. What CAN be
 * done at the owner is what this guard does: refuse the corrupted shape
 * LOUDLY — the page read fails with a typed error and the corrupted value
 * is reported through the debug bridge — so the next occurrence is an
 * honest, diagnosable refusal instead of a conversation that lies about
 * where it starts.
 */
const ISO_TIMESTAMP_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Refuse a cursor whose createdAt is not the shape this database writes.
 * Returns the value when it is, so callers compose; throws the typed
 * unreadable-cursor error when it is not, and REPORTS the corrupted value
 * first — the observability the transient needs, since the refusal alone
 * would say "unreadable" without saying what was read.
 */
function assertCursorCreatedAt(createdAt: string): string {
  if (ISO_TIMESTAMP_SHAPE.test(createdAt)) return createdAt;
  webWarn("history-cursor", "a cursor position failed its own shape check — refusing rather than paging from it", () => ({
    createdAt,
    createdAtChars: [...createdAt].map((ch) => ch.charCodeAt(0)),
  }));
  throw new WebError(
    `history cursor position is not a timestamp this database wrote (created_at: ${createdAt})`,
    "history_cursor_unreadable",
  );
}

/**
 * Encode a cursor for the wire. Base64url rather than the raw pair because a
 * cursor is the SERVER's position, not a client-authored query: a client that
 * can read one starts constructing them, and the first hand-made cursor is a
 * page boundary nobody tested. Encoding does not make it a secret (it is not
 * one — it names the caller's own message) and is not relied on for anything
 * but opacity; `decodeHistoryCursor` validates rather than trusts.
 *
 * THE ENCODED CURSOR ROUND-TRIPS THROUGH ITS OWN DECODER, asserted here at
 * the one door every served cursor leaves through. The pair is two Buffer
 * operations; the assert is what turns a corrupted encode (the measured
 * UIE-038 shape) into a typed refusal at the page that would have served
 * it, instead of a false "beginning" a reader has no way to question.
 */
function encodeHistoryCursor(cursor: HistoryCursor): string {
  assertCursorCreatedAt(cursor.createdAt);
  const encoded = Buffer.from(
    `${cursor.createdAt}${CURSOR_SEPARATOR}${String(cursor.rowid)}`,
    "utf8",
  ).toString("base64url");
  const roundTrip = decodeHistoryCursor(encoded);
  if (roundTrip.createdAt !== cursor.createdAt || roundTrip.rowid !== cursor.rowid) {
    webWarn("history-cursor", "an encoded cursor failed its own round-trip — refusing rather than serving it", () => ({
      createdAt: cursor.createdAt,
      rowid: cursor.rowid,
      encoded,
    }));
    throw new WebError(
      "history cursor did not survive its own encode/decode round-trip",
      "history_cursor_unreadable",
    );
  }
  return encoded;
}

/**
 * Decode a wire cursor, or REFUSE.
 *
 * A malformed cursor must not degrade into "start from the beginning" or
 * "start from the end": either would hand the reader a page from somewhere
 * other than where they asked, and the transcript would look like it had
 * jumped. It throws, the route maps it to 400, and the client says so.
 *
 * The createdAt is held to the same shape check the encoder asserts — a
 * cursor that decodes to a position this database could not have written
 * (the colon-less UIE-038 shape) is refused with the same typed error
 * rather than trusted to page from.
 */
export function decodeHistoryCursor(raw: string): HistoryCursor {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    throw new WebError("history cursor is not decodable", "history_cursor_unreadable");
  }
  const at = decoded.indexOf(CURSOR_SEPARATOR);
  if (at <= 0) {
    throw new WebError("history cursor is not a (created_at, rowid) pair", "history_cursor_unreadable");
  }
  const createdAt = assertCursorCreatedAt(decoded.slice(0, at));
  const rowid = Number(decoded.slice(at + 1));
  if (!Number.isSafeInteger(rowid) || rowid < 0) {
    throw new WebError("history cursor carries no usable row position", "history_cursor_unreadable");
  }
  return { createdAt, rowid };
}

/**
 * APPROXIMATE JSON BYTES of a decrypted row value — the byte budget's meter.
 *
 * It is an ESTIMATE and says so: it counts the bytes that dominate a history
 * payload (string content, in UTF-16 code units, which is a lower bound on
 * UTF-8 bytes and equal for ASCII) plus a flat allowance per non-string leaf
 * and per key. What it deliberately does NOT do is `JSON.stringify` the value
 * to measure it — that would serialise the whole payload twice, once to
 * decide the page and once to send it, which is exactly the cost the page
 * exists to bound.
 *
 * The estimate can only be WRONG LOW by structure, never by content, and the
 * headroom between `DEFAULT_CHAT_HISTORY_PAGE_BYTES` and §5's 500KB budget is
 * that difference. `tests/prevention/history-payload-bounded.test.ts` measures
 * the real serialized response and fails if the headroom is ever spent.
 */
/** Per-tool-call bytes that are not its input or output: the id, the tool
 * name, the status, the timestamps and the JSON structure around them. */
const TOOL_CALL_ROW_OVERHEAD = 160;

const JSON_SIZE = Object.freeze({
  /** `"…"` — the two quotes a string leaf serialises with. */
  quotes: 2,
  /** `null` / `true` / a typical number, generously. */
  scalar: 8,
  /** `[]` or `{}` — a container's own delimiters. */
  brackets: 2,
  /** `,` between elements. */
  comma: 1,
  /** `":"` plus the comma — a key's own punctuation. */
  keyPunctuation: 3,
  /** Deeper than any row shape this schema produces; a value nested past it
   * is counted as one scalar rather than walked, so a pathological blob can
   * neither stall the meter nor stack-overflow it. */
  maxDepth: 12,
});

function approximateJsonBytes(value: unknown, depth = 0): number {
  if (depth > JSON_SIZE.maxDepth) return JSON_SIZE.scalar;
  if (value === null || value === undefined) return JSON_SIZE.scalar;
  if (typeof value === "string") return value.length + JSON_SIZE.quotes;
  if (typeof value === "number" || typeof value === "boolean") return JSON_SIZE.scalar;
  if (Array.isArray(value)) {
    let total = JSON_SIZE.brackets;
    for (const item of value) {
      total += approximateJsonBytes(item, depth + 1) + JSON_SIZE.comma;
    }
    return total;
  }
  if (typeof value === "object") {
    let total = JSON_SIZE.brackets;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      total += k.length + JSON_SIZE.keyPunctuation + approximateJsonBytes(v, depth + 1);
    }
    return total;
  }
  return JSON_SIZE.scalar;
}

// ── Durability: observed synchronous mode and checkpoint cadence ──

/** SQLite's numeric `PRAGMA synchronous` back as its name. An unrecognised
 * value is returned verbatim rather than guessed — a durability posture
 * nobody recognises must not be reported as one that is understood. */
function readSynchronous(db: DatabaseSync): string {
  const row = db.prepare("PRAGMA synchronous").get() as { synchronous?: number } | undefined;
  const value = Number(row?.synchronous ?? -1);
  const names: Readonly<Record<number, string>> = { 0: "OFF", 1: "NORMAL", 2: "FULL", 3: "EXTRA" };
  return names[value] ?? `UNKNOWN(${value})`;
}

/**
 * Best-effort checkpoint cadence under NORMAL. The configured timer interval
 * is not a maximum crash-loss bound: scheduling, active readers, I/O failures
 * and checkpoint progress can delay completion. FULL/EXTRA disable this timer;
 * their synchronous posture is reported separately, not as zero elapsed time.
 */
function startDurabilityCheckpoints(
  db: DatabaseSync,
  synchronous: string,
  windowMs: number,
): ReturnType<typeof setInterval> | null {
  const upper = synchronous.toUpperCase();
  if (upper === "FULL" || upper === "EXTRA") return null;
  if (!Number.isFinite(windowMs) || windowMs <= 0) return null;
  const timer = setInterval(guarded("db.checkpoint", () => {
    checkpointSqlite(db, "PASSIVE");
  }), windowMs);
  timer.unref();
  return timer;
}

// ── Client ──

/** One owned table's rows of an archived conversation set, exactly as stored. */
export type ConversationTableRows = Readonly<{ table: string; rows: readonly Readonly<Record<string, unknown>>[] }>;
/** Every row a set of conversations owns, parents first (`DbClient.conversationRows`). */
export type ConversationRows = Readonly<{ chatIds: readonly string[]; tables: readonly ConversationTableRows[] }>;

export class DbClient {
  private readonly db: DatabaseSync;
  // One last SQL shape per authored callsite, scoped to this connection.
  // Values still bind on every execution; no rows or ownership decisions are
  // cached. Tagged-template identities make the bound the finite callsite
  // population, including dynamic query shapes, rather than observed inputs.
  private statements = new WeakMap<TemplateStringsArray, {
    sql: string; statement: StatementSync; values: readonly unknown[] | undefined;
  }>();
  private readonly dbPath: string;
  private readonly crypto: DbCrypto;
  readonly schemaVersion: number;
  // Transaction nesting depth — 0 outside any transaction. The outermost
  // call uses BEGIN/COMMIT/ROLLBACK; nested calls use SAVEPOINT/RELEASE so
  // production code can safely call withTransaction from inside another
  // withTransaction without partial commits.
  private transactionDepth = 0;
  /** Best-effort checkpoint timer; null under FULL/EXTRA or when disabled.
   * Its interval is not a maximum crash-loss bound. */
  private readonly durabilityTimer: ReturnType<typeof setInterval> | null;
  /** What this connection's durability actually is — read back off the
   * connection, not echoed from what was asked for. See `durability`. */
  private readonly durabilityFacts: DurabilityFacts;
  /** True when SQLite opened this connection read-only (the facade's read
   * pool). Every write-side step in the constructor is skipped, and the
   * engine refuses writes regardless of what this class believes. */
  private readonly readOnly: boolean;

  /** Whose database this is, read off its header after admission (UD-S15). */
  readonly provenance: DatabaseProvenance;

  constructor(config: DbClientConfig) {
    this.dbPath = config.path;
    if (config.path !== ":memory:") {
      mkdirSync(dirname(config.path), { recursive: true });
    }
    // Resolve the encryption-at-rest provider. Default: a persisted-key
    // DbCrypto for this db path (its key in the key home, admitted by
    // `resolveDatabaseKey`). The key is generated once and persisted, so it
    // SURVIVES server reboots — the fix for the per-process random key bug
    // that lost every project path.
    this.crypto = config.crypto ?? createDbCrypto({
      dbPath: config.path,
      ...(config.readOnly !== undefined ? { readOnly: config.readOnly } : {}),
      ...(config.passphrase !== undefined ? { passphrase: config.passphrase } : {}),
      ...(config.keyHome !== undefined ? { keyHome: config.keyHome } : {}),
    });
    this.readOnly = config.readOnly === true;
    this.db = new DatabaseSync(config.path, this.readOnly ? { readOnly: true } : {});
    let timer: ReturnType<typeof setInterval> | null = null;
    try {
      // The env value is validated once, by its config owner
      // (HARNESS_WEB_DB_BUSY_TIMEOUT_MS); a caller's override is trusted code.
      const busyTimeoutMs = config.busyTimeoutMs ?? serverConfig.dbBusyTimeoutMs;
      this.db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      // WHOSE DATABASE THIS IS, before anything is read or written through
      // it (UD-S15): a process under test refuses a real (product-stamped)
      // database; the product stamps a database it opens for writing.
      admitDatabaseProvenance(this.db, config.path, this.readOnly ? "read" : "write");
      this.provenance = config.path === ":memory:" ? "unstamped" : databaseProvenanceOf(this.db);
      this.db.exec("PRAGMA foreign_keys = ON");
      // Enable WAL mode so a crash (no clean close) does not lose committed
      // data — the WAL is replayed on next open. This is the durability
      // guarantee the data-loss tests verify.
      // A read-only connection cannot CHANGE the journal mode; it inherits
      // whatever the file already is (WAL, set by the writer that created it).
      // A fresh file's concurrent first openers are refused by SQLite without
      // the busy handler; the WAL owner waits for them within the same timeout.
      if (!this.readOnly) establishWalJournal(this.db, busyTimeoutMs);
      // THE DURABILITY CHOICE, MADE RATHER THAN INHERITED. Without this line
      // SQLite's compiled-in default (FULL) applied, and a message write cost
      // TWO fsyncs — 11.0ms measured, of which ~17µs was the actual work. The
      // value and the window it opens are owned by server/config.ts
      // (DEFAULT_DB_SYNCHRONOUS, DEFAULT_DB_DURABILITY_WINDOW_MS), which states
      // in numbers what the setting trades and what it does not. It changes
      // WHEN bytes are flushed, never whether they are written.
      //
      // The value is validated to an enum in config.ts before it reaches this
      // interpolation; an unrecognised string never gets here.
      const synchronous = config.synchronous ?? serverConfig.dbSynchronous;
      if (!this.readOnly) this.db.exec(`PRAGMA synchronous = ${synchronous}`);
      // Migrations are a WRITE, so a read-only connection reads the version the
      // writer established instead of establishing one. Opening the pool AFTER
      // the writer is ready is what makes that version correct rather than
      // whatever happened to be on disk first; see `thread-backend.ts`.
      this.schemaVersion = this.readOnly
        ? readSchemaVersion(this.db)
        : runMigrations(this.db, config.schemaVersion, this.crypto);
      // THE KEY PROVES ITSELF before this connection seals anything: a key
      // that does not open the rows already there (another install's, a key
      // home restored from the wrong backup, a re-key half-applied by hand)
      // would seal every new row under a key the right one cannot read.
      if (!this.readOnly && databaseKeyProof(this.db, this.crypto) === "wrong") {
        throw new WebError(`The database key does not open ${config.path}: a sealed value there did not decrypt. Nothing was written. Start the server with this database's own key (the key home it was created with).`, "db_key_wrong");
      }
      // From here on this key seals BOUND fields: recorded in the key home, so
      // migration 20 never re-seals a value planted under it later.
      if (!this.readOnly && this.schemaVersion >= BOUND_FIELDS_SCHEMA_VERSION && this.crypto.bindingRecord !== undefined) recordFieldsBound(this.crypto.bindingRecord);
      const windowMs = config.durabilityWindowMs ?? serverConfig.dbDurabilityWindowMs;
      this.durabilityTimer = timer = this.readOnly
        ? null
        : startDurabilityCheckpoints(this.db, synchronous, windowMs);
      this.durabilityFacts = Object.freeze({
        synchronous: readSynchronous(this.db),
        windowMs: this.durabilityTimer === null ? 0 : windowMs,
      });
    } catch (error) {
      if (timer !== null) clearInterval(timer);
      bestEffort(() => this.db.close());
      throw error;
    }
  }

  /**
   * WHAT THIS CONNECTION'S DURABILITY ACTUALLY IS — read back off the
   * connection rather than echoed from what was configured.
   *
   * `PRAGMA synchronous` is per-connection, so a second connection opened to
   * inspect the file reports its own default and proves nothing about this
   * one. A durability posture that can only be confirmed by reading source is
   * a posture nobody can audit at runtime.
   *
   * `windowMs` is the configured checkpoint interval, or zero when disabled.
   * Neither the interval nor synchronous posture is a per-event flush receipt.
   */
  get durability(): DurabilityFacts {
    return this.durabilityFacts;
  }

  /** The DB file path (or `:memory:`). Read-only — for diagnostics + tests. */
  get path(): string {
    return this.dbPath;
  }

  /** Whether the encryption key is persisted (survives reboots). */
  get keyPersisted(): boolean {
    return this.crypto.isPersisted();
  }

  /** The resolved key file path (null when ephemeral or passphrase-derived). */
  get keyFilePath(): string | null {
    return this.crypto.keyFilePath();
  }

  #statement(strings: TemplateStringsArray, ...values: readonly unknown[]): StatementSync {
    const prior = this.statements.get(strings);
    // Equal primitive substitutions have immutable string conversions.
    // Objects and functions must still run their current coercion hooks.
    if (prior?.values !== undefined && values.length === prior.values.length &&
      values.every((value, index) => Object.is(value, prior.values![index]))) return prior.statement;
    const sql = values.length === 0 ? strings[0]! : String.raw({ raw: strings }, ...values);
    const reusableValues = values.every(value => value === null ||
      (typeof value !== "object" && typeof value !== "function" && typeof value !== "symbol"));
    if (prior?.sql === sql) {
      prior.values = reusableValues ? values : undefined;
      return prior.statement;
    }
    const statement = this.db.prepare(sql);
    this.statements.set(strings, { sql, statement, values: reusableValues ? values : undefined });
    return statement;
  }

  close(): void {
    if (this.durabilityTimer !== null) clearInterval(this.durabilityTimer);
    if (!this.readOnly) checkpointSqlite(this.db, "TRUNCATE");
    this.db.close();
    this.statements = new WeakMap();
  }

  /**
   * Run `fn` inside a single SQLite transaction. All writes inside `fn` are
   * committed together (one fsync at COMMIT) or rolled back together on
   * error — no partial writes. This is 10–50× faster than N auto-commit
   * writes for bulk operations (the data-loss-7 test does 11 000 INSERTs:
   * 11 000 auto-commits ≈ 3–4s, one transaction ≈ 100–200ms).
   *
   * Nesting is safe: the outermost call opens a real transaction
   * (BEGIN/COMMIT/ROLLBACK); nested calls open a SAVEPOINT so a nested
   * rollback does not abort the outer transaction. This lets production
   * code call withTransaction from inside another withTransaction
   * (e.g. a route wraps a multi-step write, and a DbClient method it
   * calls also wraps its own write).
   *
   * The error from `fn` is re-thrown unchanged after the rollback — the
   * transaction API itself never swallows errors.
   *
   * "Already inside a transaction" is asked of the CONNECTION
   * (`DatabaseSync.isTransaction`), not only of this class's own depth
   * counter. The counter can only see transactions opened through this door,
   * so anything that opened one another way — a test inspecting intermediate
   * state, a future migration path — made the next `withTransaction` issue a
   * second `BEGIN` and throw "cannot start a transaction within a
   * transaction". Deriving it from the connection means the answer cannot
   * disagree with reality. The counter is still what names the SAVEPOINT, so
   * nested savepoints stay uniquely named.
   */
  withTransaction<T>(fn: () => T): T {
    const nested = this.transactionDepth > 0 || this.db.isTransaction;
    const savepoint = nested ? `tx_sp_${this.transactionDepth}` : null;
    if (nested) {
      this.db.exec(`SAVEPOINT ${savepoint}`);
    } else {
      this.db.exec("BEGIN");
    }
    this.transactionDepth++;
    try {
      const result = fn();
      if (nested) {
        this.db.exec(`RELEASE ${savepoint}`);
      } else {
        this.db.exec("COMMIT");
      }
      return result;
    } catch (error) {
      // Roll back the work done inside fn, then re-throw the original
      // error. A nested rollback uses ROLLBACK TO + RELEASE so the outer
      // transaction can still commit or roll back independently.
      try {
        if (nested) {
          this.db.exec(`ROLLBACK TO ${savepoint}`);
          this.db.exec(`RELEASE ${savepoint}`);
        } else {
          this.db.exec("ROLLBACK");
        }
      } catch (rollbackErr) {
        // If the rollback itself fails (e.g. the connection is broken),
        // surface the original error, not the rollback failure. The
        // caller's error is the root cause; a rollback failure on a
        // broken connection is a secondary symptom — log it for
        // diagnostics but do not mask the original error.
        webWarn("db", "transaction rollback failed (connection may be broken)", () => ({
          savepoint,
          originalError: error instanceof Error ? error.message : String(error),
          rollbackError: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
        }));
      }
      throw error;
    } finally {
      this.transactionDepth = Math.max(0, this.transactionDepth - 1);
    }
  }

  /**
   * Run an ORDERED, user-scoped SELECT in BOUNDED PAGES and return every
   * row it matches.
   *
   * The four per-chat history reads (messages, tool calls, metrics
   * snapshots, timeline refs) previously issued `LIMIT`-less SELECTs and
   * then AES-decrypted + Zod-validated every returned row. The cost of a
   * single chat-history read was therefore unbounded — it grew with how
   * long the conversation was, with no ceiling on the rows materialised in
   * one go.
   *
   * This is the ONE place that bound is applied, so no history read can
   * forget it. Two properties are deliberate:
   *
   *   - The bound is a PAGE SIZE, not a cap. The loop continues until a
   *     short page proves the table is exhausted, so the caller receives
   *     exactly the rows it would have received before. Silently returning
   *     fewer messages than a chat contains would be a worse defect than
   *     the unbounded read — a transcript that quietly loses its oldest
   *     turns looks like data loss to the user and reports nothing.
   *   - The whole walk runs inside ONE transaction, so the pages are cut
   *     from a single consistent snapshot. Without it, a concurrent delete
   *     between two pages would shift the pages and skip a row — which
   *     would reintroduce silent truncation by the back door.
   *
   * ── The paging was accidentally O(n²), and this is the repair ──
   *
   * It paged with `LIMIT ? OFFSET ?`. OFFSET is not a seek: SQLite produces
   * and DISCARDS the first `offset` rows on every page, and because no index
   * satisfied `ORDER BY created_at, rowid`, it also re-sorted the whole
   * matching set each time. So the cost was pages × n, not n. Measured on
   * the same 20,000-message conversation in the `heavy` fixture:
   *
   *     page size    100  →  10,423 ms
   *     page size    500  →   2,513 ms   ← the production default
   *     page size  2,000  →     616 ms
   *     one page          →     130 ms
   *
   * Exactly quadratic: halving the page size doubled the work, for a bound
   * that was never a cap.
   *
   * KEYSET paging replaces it. Each page carries the last row's cursor and
   * asks for what comes after it, so the planner SEEKS instead of counting:
   *
   *     SEARCH m USING INDEX idx_messages_chat_id (chat_id=? AND rowid>?)
   *
   * No discarded rows, no per-page sort. Same 23,930 rows: **58.5 ms**, which
   * is 43× the old walk and 2.2× faster than not paging at all.
   *
   * ── Why the cursor is rowid and the ordering is not ──
   *
   * The cursor must be UNIQUE (or a page boundary can skip or repeat a row)
   * and SEEKABLE by an existing index (or every page is a scan again and the
   * quadratic returns wearing a different hat). `rowid` on the driving table
   * is both: SQLite's `(chat_id)` indexes store `(chat_id, rowid)`, so
   * `chat_id = ? AND rowid > ?` is a direct seek. For tool calls, whose scope
   * comes from the chat two joins away, the cursor is the composite
   * `(m.rowid, tc.rowid)` — the same seek on messages, with the tool call's
   * own rowid breaking ties inside one message.
   *
   * But rowid order is INSERTION order, and the caller is owed the DECLARED
   * order (`created_at`, then rowid). They coincide today and would probably
   * keep coinciding; "probably" is not a contract, and a clock that steps
   * backwards would silently reorder a transcript. So `order` states the real
   * ordering and it is applied once, in memory, over rows already fetched.
   */
  private pageAllRows<T>(
    query: PagedRead,
    params: readonly string[],
    parse: (row: Record<string, unknown>) => T,
  ): readonly T[] {
    const pageRows = serverConfig.chatHistoryPageRows;
    const cursorColumns = query.cursor.map((c) => `${c.expr} AS ${c.as}`).join(", ");
    const head = `SELECT ${query.columns}, ${cursorColumns} FROM ${query.source}`;
    const tail = ` ORDER BY ${query.cursor.map((c) => `${c.expr} ASC`).join(", ")} LIMIT ?`;
    // Two statements rather than one with a sentinel cursor: the first page
    // has nothing to seek past, and a `WHERE rowid > -1` written to make one
    // statement serve both is a predicate the planner must still evaluate for
    // a bound that means "everything".
    //
    // The second is prepared LAZILY, and that is measured rather than tidy:
    // most conversations fit in one page, so preparing a joined keyset query
    // that is never run cost every short history read ~0.5ms of query
    // planning — it turned a 2.93ms read into 3.46ms. A statement nobody
    // executes should cost nothing.
    const firstPage = this.#statement`${head}${tail}`;
    let nextPage: ReturnType<DatabaseSync["prepare"]> | null = null;
    return this.withTransaction(() => {
      const rows: Record<string, unknown>[] = [];
      let page = firstPage.all(...params, pageRows) as ReadonlyArray<Record<string, unknown>>;
      for (;;) {
        for (const row of page) rows.push(row);
        if (page.length < pageRows) break;
        nextPage ??= this.#statement`${head} AND ${keysetPredicate(query.cursor)}${tail}`;
        const last = rows[rows.length - 1]!;
        page = nextPage.all(
          ...params,
          ...keysetValues(query.cursor, last),
          pageRows,
        ) as ReadonlyArray<Record<string, unknown>>;
      }
      // The walk advances on the CURSOR (insertion order, which the indexes
      // can seek); the caller is owed the DECLARED order. Sorting the
      // assembled rows once is O(n log n) over data already in memory —
      // measured at a few ms for 23,930 rows against the 2,513ms the old
      // OFFSET walk spent making SQLite sort the same rows once per page.
      // Doing it here rather than in SQL is what lets every page be a seek.
      rows.sort((a, b) => compareByColumns(a, b, query.order));
      return rows.map(parse);
    });
  }

  // ── Projects ──
  //
  // Multi-user (v12) + Single-Party-Owner: EVERY project query is
  // scoped by `user_id` AT THE DB LAYER. `getProject(id, userId)` is the
  // single accessor — there is NO unscoped read; a route that forgets
  // `userId` gets null (the project is invisible to it), never another
  // user's row. The legacy `getProjectForUser`/`deleteProjectForUser`
  // aliases are consolidated into `getProject`/`deleteProject`.

  /**
   * The caller's live projects, ordered by REAL LAST ACTIVITY, newest first.
   *
   * ONE ORDERING OWNER (the switch-river CLS finding): the Switch river
   * ranks project caps by real chat activity — MAX over the project's
   * chats' `updated_at`, falling back to the project row's own
   * `updated_at` (src/cockpit/rooms/switch-data.ts::activityMs). The wire
   * used to serve the rows by `created_at ASC`, so the river's first fill
   * ranked by the STALE project-row timestamps and re-sorted into the
   * activity order once the chats landed — a post-paint reorder of every
   * cap, measured at CLS 0.1614 against a 0.1 budget for any user whose
   * most-recent project is not also the last-created. The list read now
   * derives the SAME measure server-side and serves the rows in that
   * order, with `updated_at` carrying the activity instant — so the
   * client's first fill (which, before chats land, ranks by the served
   * `updatedAt` alone) IS the river's settled order and no re-sort
   * happens. Ordering by activity is the user-meaningful order everywhere
   * the list is consumed (the river, the boot fallback picker); nothing
   * reads `created_at ASC` order off this list.
   *
   * The JOIN is over the caller's own non-trashed chats, and the measure is
   * read-derived — the `projects.updated_at` column itself stays what it
   * always was (metadata-write time) and is NOT bumped per message, so no
   * write amplification and no backfill: historical activity ranks
   * correctly the moment this query runs.
   */
  listProjects(userId: string): readonly ProjectRow[] {
    const rows = this.#statement`SELECT p.*,
                MAX(p.updated_at, IFNULL(MAX(c.updated_at), p.updated_at)) AS activity_at
           FROM projects p
           LEFT JOIN chats c
                  ON c.project_id = p.id
                 AND c.trashed_at IS NULL
          WHERE p.user_id = ? AND p.trashed_at IS NULL
          GROUP BY p.id
          ORDER BY activity_at DESC, p.created_at ASC, p.rowid ASC`
      .all(userId) as ReadonlyArray<Record<string, unknown>>;
    return rows.map((r) => {
      const row = parseProjectRow(r, this.crypto, userId);
      // `activity_at` is the same measure the ORDER BY ranks by, served AS
      // the row's `updated_at` (the wire view forwards it verbatim). A null
      // can only mean the join lost the fallback — impossible with
      // IFNULL(p.updated_at) — but a missing value must never silently
      // become a fake instant, so the row's own field stands in that case.
      const activity = typeof r["activity_at"] === "string" ? r["activity_at"] : row.updated_at;
      return activity === row.updated_at ? row : { ...row, updated_at: activity };
    });
  }

  /**
   * Get a project by id, scoped to the caller's user id. Returns null if the
   * project does not exist OR belongs to a different user. This is the
   * single user-safe accessor — the gate is in the query, not in each route.
   */
  getProject(id: string, userId: string): ProjectRow | null {
    const row = this.#statement`SELECT * FROM projects WHERE id = ? AND user_id = ? AND trashed_at IS NULL`
      .get(id, userId) as Record<string, unknown> | undefined;
    return row ? parseProjectRow(row, this.crypto, userId) : null;
  }

  createProject(input: ProjectCreateDbInput, userId: string): ProjectRow {
    if (typeof userId !== "string" || userId.length === 0) {
      throw new ValidationError("createProject requires a non-empty userId (the owning user).", "invalid_user_id");
    }
    const valid = PROJECT_CREATE_INPUT.parse(input);
    const now = new Date().toISOString();
    const id = randomUuid();
    // Encrypt the sensitive fields (name + path) at rest. The persisted key
    // (server/db-crypto.ts) survives reboots so the data remains decryptable.
    const sealed = sealRow(this.crypto, "projects", { id, name: valid.name, path: valid.path }, userId);
    this.#statement`INSERT INTO projects (id, name, path, created_at, updated_at, config_overlay, user_id) VALUES (?, ?, ?, ?, ?, NULL, ?)`
      .run(id, sealed["name"] as string, sealed["path"] as string, now, now, userId);
    return this.getProject(id, userId)!;
  }

  /**
   * Rename a project, scoped to the caller's user id. Returns the updated
   * row or null if the project does not exist / is not owned by the caller.
   * Does not touch the project's path or files on disk — only the
   * display name. The WHERE clause enforces ownership; a non-owned rename
   * affects 0 rows and returns null (existence is hidden).
   */
  renameProject(id: string, name: string, userId: string): ProjectRow | null {
    this.#statement`UPDATE projects SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?`
      .run(sealRow(this.crypto, "projects", { id, name }, userId)["name"] as string, new Date().toISOString(), id, userId);
    return this.getProject(id, userId);
  }

  /**
   * Update a project's name and/or path (relink), scoped to the caller's
   * user id. Returns the updated row, or null when no owned row matched
   * (existence is hidden from a non-owner). At least one field is required
   * — the route's wire schema refuses a bare `{}` before this is called.
   * Re-pointing a project touches the RECORD only: nothing on disk moves.
   */
  updateProject(
    id: string,
    fields: Readonly<{ name?: string; path?: string }>,
    userId: string,
  ): ProjectRow | null {
    const sets: string[] = [];
    const values: string[] = [];
    const sealed = sealRow(this.crypto, "projects", { id, ...fields }, userId);
    if (fields.name !== undefined) {
      sets.push("name = ?");
      values.push(sealed["name"] as string);
    }
    if (fields.path !== undefined) {
      sets.push("path = ?");
      values.push(sealed["path"] as string);
    }
    if (sets.length === 0) {
      throw new ValidationError("updateProject requires at least one field (name or path).", "invalid_project_update");
    }
    sets.push("updated_at = ?");
    values.push(new Date().toISOString(), id, userId);
    this.#statement`UPDATE projects SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`
      .run(...values);
    return this.getProject(id, userId);
  }

  /**
   * Move a project to the recycle bin. The row STAYS — `trashed_at` hides
   * it from live lists. The product path never removes the row (that
   * cascaded the conversation record away while claiming only the disk was
   * sacred). NEVER touches files on disk. A second trash of an
   * already-trashed id is a no-op (returns false) so the live list's 404
   * stays honest.
   */
  deleteProject(id: string, userId: string): boolean {
    const now = new Date().toISOString();
    const result = this.#statement`UPDATE projects SET trashed_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND trashed_at IS NULL`
      .run(now, now, id, userId);
    return Number(result.changes ?? 0) > 0;
  }

  /** Undo `deleteProject`. Live lists see the project again. */
  restoreProject(id: string, userId: string): ProjectRow | null {
    const now = new Date().toISOString();
    this.#statement`UPDATE projects SET trashed_at = NULL, updated_at = ? WHERE id = ? AND user_id = ? AND trashed_at IS NOT NULL`
      .run(now, id, userId);
    return this.getProject(id, userId);
  }

  /**
   * Check if a project belongs to the caller's user id. Returns true if the
   * project exists and its user_id matches. Internal ownership probe (takes
   * userId — passes the userId-threading gate) used by the chat/message
   * CREATE methods to verify the parent before inserting a child.
   */
  projectBelongsToUser(projectId: string, userId: string): boolean {
    const row = this.#statement`SELECT 1 FROM projects WHERE id = ? AND user_id = ? LIMIT 1`
      .get(projectId, userId);
    return row !== undefined;
  }

  /**
   * Resolve a project by its on-disk PATH, scoped to the caller's user id.
   * Returns the project row if a project owned by `userId` exists at exactly
   * `path` (after resolve), else null.
   *
   * Single-Party-Owner (route registry security): the editor,
   * git-ops, intelligence, awareness, quality, and file-tree routes all
   * accept a USER-SUPPLIED project `path`/`root` query/body parameter. Before
   * this method, those routes confined the path to `root` (traversal guard)
   * but NEVER verified the root belonged to a project owned by the
   * authenticated user — User B could pass User A's project path and
   * read/write/edit/delete A's files, query A's git status, code graph,
   * awareness, quality (a CRITICAL cross-user leak). This method is the
   * single DB-side gate those routes now call (`requireProjectByPath`) so a
   * path that is not a project owned by the caller is rejected (null → 403).
   *
   * The path is encrypted at rest (AES-256-GCM with a random nonce), so a
   * SQL `WHERE path =?` cannot match — the same plaintext encrypts to a
   * different ciphertext each time. Instead, list the caller's projects
   * (already scoped by `user_id` — Single-Party-Owner DB layer) and compare
   * the decrypted, resolved path. A user has a small number of projects, so
   * the O(n) scan is negligible (and avoids a schema migration for a
   * path-hash column).
   */
  getProjectByPath(path: string, userId: string): ProjectRow | null {
    const resolved = normalizePath(path);
    const rows = this.listProjects(userId);
    for (const row of rows) {
      if (normalizePath(row.path) === resolved) return row;
    }
    return null;
  }

  /**
   * Check if a project PATH belongs to the caller's user id. Returns true if
   * a project owned by `userId` exists at exactly `path`. The path-based
   * ownership probe for the route gate; the id-based probe is
   * `projectBelongsToUser`.
   */
  projectPathBelongsToUser(path: string, userId: string): boolean {
    return this.getProjectByPath(path, userId) !== null;
  }

  /**
   * Check if a chat belongs to the caller's user id. Returns true if the
   * chat exists AND its owning project belongs to the user. Internal
   * ownership probe (takes userId) used by the message/tool_call/metrics/
   * timeline CREATE methods to verify the parent chat before inserting.
   */
  chatBelongsToUser(chatId: string, userId: string): boolean {
    const row = this.#statement`SELECT 1 FROM chats c
         JOIN projects p ON c.project_id = p.id
         WHERE c.id = ? AND p.user_id = ? LIMIT 1`
      .get(chatId, userId);
    return row !== undefined;
  }

  /**
   * Check if a message belongs to the caller's user id (message → chat →
   * project → user_id). Internal ownership probe used by createToolCall
   * to verify the parent message before inserting a tool_call row.
   */
  messageBelongsToUser(messageId: string, userId: string): boolean {
    const row = this.#statement`SELECT 1 FROM messages m
         JOIN chats c ON m.chat_id = c.id
         JOIN projects p ON c.project_id = p.id
         WHERE m.id = ? AND p.user_id = ? LIMIT 1`
      .get(messageId, userId);
    return row !== undefined;
  }

  // ── Chats ──

  listChats(projectId: string, userId: string): readonly ChatRow[] {
    // Sort by recency: pinned chats first (pinned DESC), then most
    // recently active (updated_at DESC, rowid DESC as a stable
    // tiebreaker). The JOIN enforces that the project belongs to the
    // caller — a non-owned projectId yields an empty list (no leak).
    const rows = this.#statement`SELECT c.* FROM chats c
         JOIN projects p ON c.project_id = p.id
         WHERE c.project_id = ? AND p.user_id = ?
           AND c.trashed_at IS NULL AND p.trashed_at IS NULL
         ORDER BY c.pinned DESC, c.updated_at DESC, c.rowid DESC`
      .all(projectId, userId) as ReadonlyArray<Record<string, unknown>>;
    return rows.map((r) => parseChatRow(r, this.crypto, userId));
  }

  getChat(id: string, userId: string): ChatRow | null {
    const row = this.#statement`SELECT c.* FROM chats c
         JOIN projects p ON c.project_id = p.id
         WHERE c.id = ? AND p.user_id = ?
           AND c.trashed_at IS NULL AND p.trashed_at IS NULL`
      .get(id, userId) as Record<string, unknown> | undefined;
    return row ? parseChatRow(row, this.crypto, userId) : null;
  }

  /**
   * Create a chat under a LIVE project. `getProject` is the live accessor
   * (trashed parents are hidden), so a conversation cannot be born into
   * the recycle bin. Ownership of a trashed row is still true via
   * `projectBelongsToUser`; create is a live act and uses the live door.
   * Throws ForbiddenError (HTTP 403) if the parent is missing, not owned,
   * or trashed — a silent null on a create would look like success.
   */
  createChat(input: ChatCreateDbInput, userId: string): ChatRow {
    const valid = CHAT_CREATE_INPUT.parse(input);
    if (this.getProject(valid.project_id, userId) === null) {
      throw new ForbiddenError(`Project ${valid.project_id} does not belong to the caller.`, "chat_parent_not_owned");
    }
    const now = new Date().toISOString();
    const id = randomUuid();
    this.#statement`INSERT INTO chats (id, project_id, title, created_at, updated_at, model_id) VALUES (?, ?, ?, ?, ?, ?)`
      .run(id, valid.project_id, sealRow(this.crypto, "chats", { id, project_id: valid.project_id, title: valid.title }, userId)["title"] as string, now, now, valid.model_id ?? null);
    return this.getChat(id, userId)!;
  }

  /**
   * Rename a chat, scoped to the caller's user id. Returns the updated row
   * or null if the chat does not exist / is not owned. The WHERE clause
   * enforces ownership via the project JOIN subquery (a non-owned rename
   * affects 0 rows → returns null).
   */
  renameChat(id: string, title: string, userId: string): ChatRow | null {
    // The title is sealed to the chat's owner and project, read owned first.
    const chat = this.getChat(id, userId);
    if (chat === null) return null;
    this.#statement`UPDATE chats SET title = ?, updated_at = ?
         WHERE id = ? AND project_id IN (${USER_PROJECTS})`
      .run(sealRow(this.crypto, "chats", { id, project_id: chat.project_id, title }, userId)["title"] as string, new Date().toISOString(), id, userId);
    return this.getChat(id, userId);
  }

  /**
   * Set the model for a chat, scoped to the caller's user id. Returns the
   * updated row or null if not owned/absent.
   */
  setChatModel(id: string, modelId: string | null, userId: string): ChatRow | null {
    this.#statement`UPDATE chats SET model_id = ?
         WHERE id = ? AND project_id IN (${USER_PROJECTS})`
      .run(modelId, id, userId);
    return this.getChat(id, userId);
  }

  /**
   * Move a chat to the recycle bin. The row STAYS — messages and tool
   * calls stay with it. The product path never removes the row. NEVER
   * touches files on disk.
   */
  deleteChat(id: string, userId: string): boolean {
    const now = new Date().toISOString();
    const result = this.#statement`UPDATE chats SET trashed_at = ?, updated_at = ?
         WHERE id = ? AND project_id IN (${USER_PROJECTS}) AND trashed_at IS NULL`
      .run(now, now, id, userId);
    return Number(result.changes ?? 0) > 0;
  }

  /**
   * EVERY ROW A CONVERSATION OWNS, exactly as stored (UD-S15: the archive
   * owner's read) — sealed fields stay sealed, so an archive is as protected
   * as the database it came from. The owned tables are found through the
   * schema's own foreign keys, never a hand list: the `chats` rows named, and
   * every table that references them, recursively (messages, then the tool
   * calls that reference those messages, ...), parents first. Admin scope: the
   * maintenance shell runs it with the server stopped.
   */
  conversationRows(chatIds: readonly string[], userId: string): ConversationRows {
    const tables: ConversationTableRows[] = [];
    const ids = JSON.stringify([...chatIds]);
    const select = (table: string, column: string, values: string): Record<string, unknown>[] =>
      (this.db.prepare(`SELECT * FROM "${table}" WHERE "${column}" IN (SELECT value FROM json_each(?)) ORDER BY rowid`).all(values) as Record<string, unknown>[])
        .map((row) => ({ ...row }));
    // The roots are the named conversations THIS user owns; everything else follows their keys.
    const owned = JSON.stringify((this.db.prepare(`SELECT id FROM chats WHERE id IN (SELECT value FROM json_each(?)) AND project_id IN (${USER_PROJECTS})`).all(ids, userId) as { id: string }[]).map((row) => row.id));
    const visit = (table: string, column: string, values: string): void => {
      const rows = select(table, column, values);
      tables.push(Object.freeze({ table, rows: Object.freeze(rows) }));
      // A table that references itself is read once (its own rows are already selected by the parent's key).
      for (const child of this.#referencingTables(table).filter((reference) => reference.table !== table)) {
        const parentValues = JSON.stringify(rows.map((row) => row[child.parentColumn]));
        visit(child.table, child.column, parentValues);
      }
    };
    visit("chats", "id", owned);
    return Object.freeze({ chatIds: Object.freeze([...chatIds]), tables: Object.freeze(tables) });
  }

  /** The tables whose foreign keys reference `parent` (from the schema itself). */
  #referencingTables(parent: string): readonly Readonly<{ table: string; column: string; parentColumn: string }>[] {
    const names = (this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((row) => row.name);
    return names.flatMap((table) => (this.db.prepare(`SELECT "from", "table", "to" FROM pragma_foreign_key_list(?)`).all(table) as { from: string; table: string; to: string }[])
      .filter((key) => key.table === parent)
      .map((key) => Object.freeze({ table, column: key.from, parentColumn: key.to })));
  }

  /**
   * REMOVE ARCHIVED CONVERSATIONS (UD-S15: the archive owner's deletion; the
   * product path otherwise only trashes). Only TRASHED conversations, all of
   * them or none, in one transaction: the `chats` rows go and the schema's
   * own cascades take every owned row with them; afterwards nothing they
   * owned may remain, or the whole removal rolls back. Returns the rows
   * removed per table.
   */
  purgeConversations(chatIds: readonly string[], userId: string): Readonly<Record<string, number>> {
    return this.withTransaction(() => {
      const ids = JSON.stringify([...chatIds]);
      const trashed = (this.db.prepare(`SELECT COUNT(*) AS n FROM chats WHERE id IN (SELECT value FROM json_each(?)) AND trashed_at IS NOT NULL AND project_id IN (${USER_PROJECTS})`).get(ids, userId) as { n: number }).n;
      if (trashed !== new Set(chatIds).size) {
        throw new ValidationError(`only this user's trashed conversations are removed: ${String(new Set(chatIds).size - trashed)} of the ${String(new Set(chatIds).size)} named are not in the recycle bin (or are not theirs, or do not exist); nothing was removed`, "db_purge_not_trashed");
      }
      const before = this.conversationRows(chatIds, userId);
      // THE ONE EXCEPTION to the never-deleted conversation record (schema.ts
      // UNDELETABLE_TABLES): the refusing triggers of exactly the tables this
      // removal reaches are lifted INSIDE this transaction and re-created
      // from their one definition before it commits (DDL is transactional:
      // a failure anywhere rolls the triggers back with the rows), then
      // proved present. Only the archive owner calls this, after a verified
      // archive of every row it removes.
      const reached = new Set(before.tables.map((entry) => entry.table));
      const lifted = UNDELETABLE_TABLES.filter((table) => reached.has(table));
      for (const table of lifted) this.db.exec(`DROP TRIGGER ${refuseDeleteTriggerName(table)}`);
      this.db.prepare(`DELETE FROM chats WHERE id IN (SELECT value FROM json_each(?)) AND trashed_at IS NOT NULL AND project_id IN (${USER_PROJECTS})`).run(ids, userId);
      for (const table of lifted) this.db.exec(refuseDeleteTriggerSql(table));
      const present = new Set((this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as { name: string }[]).map((row) => row.name));
      const missing = UNDELETABLE_TABLES.filter((table) => !present.has(refuseDeleteTriggerName(table)));
      if (missing.length > 0) throw new ValidationError(`the conversation record's delete refusal is missing on ${missing.join(", ")}; nothing was removed`, "db_purge_triggers_missing");
      const left = this.conversationRows(chatIds, userId).tables.filter((entry) => entry.rows.length > 0);
      if (left.length > 0) {
        throw new ValidationError(`removing the conversations left rows they owned in ${left.map((entry) => entry.table).join(", ")}; nothing was removed`, "db_purge_incomplete");
      }
      const removed: Record<string, number> = {};
      for (const entry of before.tables) removed[entry.table] = (removed[entry.table] ?? 0) + entry.rows.length;
      return Object.freeze(removed);
    });
  }

  /** Undo `deleteChat`. Live lists see the conversation again. */
  restoreChat(id: string, userId: string): ChatRow | null {
    const now = new Date().toISOString();
    this.#statement`UPDATE chats SET trashed_at = NULL, updated_at = ?
         WHERE id = ? AND project_id IN (${USER_PROJECTS}) AND trashed_at IS NOT NULL`
      .run(now, id, userId);
    return this.getChat(id, userId);
  }

  /**
   * THE RECYCLE BIN. Trashed projects, and trashed conversations whose
   * project is still live (a trashed project already covers its chats).
   */
  listTrash(userId: string): Readonly<{
    projects: readonly ProjectRow[];
    chats: readonly ChatRow[];
  }> {
    const projects = (
      this.#statement`SELECT * FROM projects WHERE user_id = ? AND trashed_at IS NOT NULL ORDER BY trashed_at DESC`
        .all(userId) as ReadonlyArray<Record<string, unknown>>
    ).map((r) => parseProjectRow(r, this.crypto, userId));
    const chats = (
      this.#statement`SELECT c.* FROM chats c
           JOIN projects p ON c.project_id = p.id
           WHERE p.user_id = ? AND c.trashed_at IS NOT NULL AND p.trashed_at IS NULL
           ORDER BY c.trashed_at DESC`
        .all(userId) as ReadonlyArray<Record<string, unknown>>
    ).map((r) => parseChatRow(r, this.crypto, userId));
    return { projects, chats };
  }

  /**
   * Toggle the pinned flag on a chat, scoped to the caller's user id.
   * Returns the updated row or null if not owned/absent.
   */
  setChatPinned(id: string, pinned: boolean, userId: string): ChatRow | null {
    this.#statement`UPDATE chats SET pinned = ?
         WHERE id = ? AND project_id IN (${USER_PROJECTS})`
      .run(pinned ? 1 : 0, id, userId);
    return this.getChat(id, userId);
  }

  /**
   * Duplicate a chat: create a new chat under the same project with a
   * "(copy)" title suffix, then copy all messages and their tool_calls.
   * Scoped to the caller's user id — returns null if the source chat is not
   * owned. The new chat is NOT pinned and has a fresh created_at/updated_at.
   * NEVER touches files on disk. All child reads (messages, tool
   * calls) are themselves scoped by the same userId (defense-in-depth).
   */
  duplicateChat(id: string, userId: string): ChatRow | null {
    const source = this.getChat(id, userId);
    if (source === null) return null;
    const newChatId = randomUuid();
    const title = `${source.title} (copy)`;
    // Pre-fetch the source messages + their tool_calls OUTSIDE the
    // transaction (reads), so the transaction holds only the atomic
    // writes. A failure mid-copy (disk full, process crash) would
    // otherwise leave a half-duplicated chat (some messages copied,
    // some not) — wrapping all inserts in one transaction makes the
    // duplicate all-or-nothing.
    const messages = this.listMessages(id, userId);
    const toolCallsByMessage = new Map<string, readonly ToolCallRow[]>();
    for (const msg of messages) {
      toolCallsByMessage.set(msg.id, this.listToolCallsByMessage(msg.id, userId));
    }
    this.withTransaction(() => {
      const now = new Date().toISOString();
      this.#statement`INSERT INTO chats (id, project_id, title, created_at, updated_at, model_id, pinned) VALUES (?, ?, ?, ?, ?, ?, 0)`
        .run(newChatId, source.project_id, sealRow(this.crypto, "chats", { id: newChatId, project_id: source.project_id, title }, userId)["title"] as string, now, now, source.model_id);
      for (const msg of messages) {
        const newMsgId = randomUuid();
        const message = sealRow(this.crypto, "messages", { id: newMsgId, chat_id: newChatId, content: msg.content, metadata: msg.metadata !== null ? encodeJson(msg.metadata) : null }, userId);
        this.#statement`INSERT INTO messages (id, chat_id, role, content, created_at, model_event_type, run_id, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          .run(
            newMsgId,
            newChatId,
            msg.role,
            message["content"] as string,
            msg.created_at,
            msg.model_event_type,
            msg.run_id,
            message["metadata"] as string | null,
          );
        for (const tc of toolCallsByMessage.get(msg.id) ?? []) {
          const call = sealRow(this.crypto, "tool_calls", {
            id: randomUuid(), message_id: newMsgId, tool_name: encodeJson(tc.tool_name),
            call_id: tc.call_id === null ? null : encodeJson(tc.call_id),
            public_projection: tc.public_projection === null ? null : encodeJson(tc.public_projection),
            input: encodeJson(tc.input), output: tc.output !== null ? encodeJson(tc.output) : null,
          }, userId);
          this.#statement`INSERT INTO tool_calls (id, message_id, tool_name, call_id, public_projection, input, output, status, duration_ms, attempt_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            .run(
              call["id"] as string,
              newMsgId,
              call["tool_name"] as string,
              call["call_id"] as string | null,
              call["public_projection"] as string | null,
              call["input"] as string,
              call["output"] as string | null,
              tc.status,
              tc.duration_ms,
              tc.attempt_count,
              tc.created_at,
            );
        }
      }
    });
    return this.getChat(newChatId, userId);
  }

  // ── Messages ──

  /** Every message in a chat, oldest first. Read in bounded KEYSET pages (see
   * `pageAllRows`) — complete, but never as one unbounded materialisation and
   * never by counting rows it then throws away. */
  listMessages(chatId: string, userId: string): readonly MessageRow[] {
    return this.pageAllRows(
      {
        columns: "m.*",
        source: `messages m
           JOIN chats c ON m.chat_id = c.id
           JOIN projects p ON c.project_id = p.id
           WHERE m.chat_id = ? AND p.user_id = ?`,
        // idx_messages_chat_id stores (chat_id, rowid), so this is a seek.
        cursor: [{ expr: "m.rowid", as: "__row" }],
        order: ["created_at", "__row"],
      },
      [chatId, userId],
      (r) => parseMessageRow(r, this.crypto, userId),
    );
  }

  /**
   * How many messages a chat holds, scoped to the caller's user id — the
   * count WITHOUT materialising, decrypting or validating a single row.
   *
   * `listMessages(...).length` answers the same question for ~40µs per row
   * (AES per field plus a Zod parse), which is an unbounded price for a
   * number. A non-owned or absent chat counts 0, like every other read here:
   * existence is not disclosed by the shape of the answer.
   */
  countMessages(chatId: string, userId: string): number {
    const row = this.#statement`SELECT COUNT(*) AS n FROM messages m
         JOIN chats c ON m.chat_id = c.id
         JOIN projects p ON c.project_id = p.id
         WHERE m.chat_id = ? AND p.user_id = ?`
      .get(chatId, userId) as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /**
   * Create a message, scoped to the caller's user id. Verifies the chat
   * belongs to the user; throws ForbiddenError (HTTP 403) if not. Bumps the
   * chat's updated_at (scoped) so the sidebar sorts by recency. Returns the
   * created row (non-null).
   */
  createMessage(input: MessageCreateInput, userId: string): MessageRow {
    const valid = MESSAGE_CREATE_INPUT.parse(snapshotDbWriteArguments("createMessage", [input, userId])[0]);
    if (!this.chatBelongsToUser(valid.chat_id, userId)) {
      throw new ForbiddenError(`Chat ${valid.chat_id} does not belong to the caller.`, "message_parent_not_owned");
    }
    const now = new Date().toISOString();
    const id = randomUuid();
    // ONE TRANSACTION, TWO WRITES.
    //
    // These ran as two auto-commits: 5.08ms for the INSERT and 6.01ms for the
    // UPDATE, 11.0ms in total, of which the actual work is ~17µs. The rest is
    // two fsyncs, and the second one buys nothing — the message row and the
    // recency bump describe ONE event and are already meaningless apart.
    //
    // Correctness, not only cost: as two auto-commits a crash between them
    // leaves a message the sidebar cannot see, because the chat's updated_at
    // still says the conversation is older than its newest turn. One
    // transaction makes the pair all-or-nothing. The batched-write case
    // already proved the shape — 100 messages in one transaction cost 259µs
    // each against 11.0ms apiece as auto-commits.
    //
    // `withTransaction` nests safely (SAVEPOINT), so a caller that already
    // wrapped a multi-step write still gets one commit, not two.
    const sealed = sealRow(this.crypto, "messages", { id, chat_id: valid.chat_id, content: valid.content, metadata: valid.metadata !== undefined ? encodeJson(valid.metadata) : null }, userId);
    this.withTransaction(() => {
      this.#statement`INSERT INTO messages (id, chat_id, role, content, created_at, model_event_type, run_id, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        .run(
          id,
          valid.chat_id,
          valid.role,
          sealed["content"] as string,
          now,
          valid.model_event_type ?? null,
          valid.run_id ?? null,
          sealed["metadata"] as string | null,
        );
      // Bump the chat's updated_at (scoped to the owner) so the sidebar sorts
      // it by recency (last activity). The chat is owned (verified above).
      this.#statement`UPDATE chats SET updated_at = ? WHERE id = ? AND project_id IN (${USER_PROJECTS})`
        .run(now, valid.chat_id, userId);
    });
    return this.getMessage(id, userId)!;
  }

  getMessage(id: string, userId: string): MessageRow | null {
    const row = this.#statement`SELECT m.* FROM messages m
         JOIN chats c ON m.chat_id = c.id
         JOIN projects p ON c.project_id = p.id
         WHERE m.id = ? AND p.user_id = ?`
      .get(id, userId) as Record<string, unknown> | undefined;
    return row ? parseMessageRow(row, this.crypto, userId) : null;
  }

  /**
   * Update a message's content (and optionally its model_event_type), scoped
   * to the caller's user id. Used by the run stream to persist the final
   * accumulated assistant text on the `finish` event. The WHERE enforces
   * ownership — a non-owned message is never touched (0 rows affected).
   */
  updateMessageContent(
    id: string,
    content: string,
    userId: string,
    extras?: Readonly<{ readonly model_event_type?: string }>,
  ): void {
    // The content is sealed to the message's chat and owner; a non-owned message has none here and is not touched.
    const owned = this.#statement`SELECT id, chat_id FROM messages WHERE id = ? AND chat_id IN (${USER_CHATS})`
      .get(id, userId) as { id: string; chat_id: string } | undefined;
    if (owned === undefined) return;
    const sealed = sealRow(this.crypto, "messages", { ...owned, content }, userId)["content"] as string;
    if (extras?.model_event_type !== undefined) {
      this.#statement`UPDATE messages SET content = ?, model_event_type = ?
           WHERE id = ? AND chat_id IN (${USER_CHATS})`
        .run(sealed, extras.model_event_type, id, userId);
    } else {
      this.#statement`UPDATE messages SET content = ?
           WHERE id = ? AND chat_id IN (${USER_CHATS})`
        .run(sealed, id, userId);
    }
  }

  /**
   * Persist the rich per-message metadata blob (reasoning, tokens,
   * timing, headers, model, finish reason, context) so the full chat
   * exposure survives a page refresh. Scoped to the caller's user id — the
   * existing blob is read via the scoped getMessage, and the UPDATE is
   * scoped to the owner. A missing/non-owned or unacknowledged write is a
   * typed refusal; successful return certifies one actual updated row.
   *
   * MERGE (not replace) is the root-cause fix for "page refresh loses
   * token in/out": the previous full-replace clobbered earlier partial
   * persists. When the "start" handler persisted { context } and the
   * "finish" handler later persisted { reasoning, tokenMetrics,... },
   * the finish call REPLACED the blob — losing context. Worse, if the
   * run was interrupted before "finish" (error, disconnect, abort), the
   * blob stayed { context } and ALL accumulated fields (tokens, timing,
   * reasoning) were lost forever. A merge preserves every field written
   * by any handler, in any order, regardless of whether finish arrives.
   *
   * This is the single persistence path for chat exposure data: the same
   * blob is written here and read back by getChatHistory →
   * hydrateChatFromHistory. One way to save, one way to load.
   */
  updateMessageMetadata(id: string, metadata: MessageMetadataUpdate, userId: string): void {
    const validated = MESSAGE_METADATA.partial().parse(snapshotDbWriteArguments("updateMessageMetadata", [id, metadata, userId])[1]);
    // Read-merge-write: preserve previously-persisted fields so partial
    // updates accumulate instead of clobbering. The merge is shallow
    // (top-level keys) — each field is an independent, atomic value, so
    // a shallow merge is correct (no nested partial updates exist).
    // A missing/non-owned message is a failed write, never a successful receipt.
    const existing = this.getMessage(id, userId);
    if (existing === null) throw new ForbiddenError("Message evidence could not be persisted for this owner", "message_metadata_not_owned");
    const prev: Record<string, unknown> =
      existing.metadata !== null && typeof existing.metadata === "object" && !Array.isArray(existing.metadata)
        ? existing.metadata as Record<string, unknown>
        : {};
    const merged = { ...prev, ...validated };
    const result = this.#statement`UPDATE messages SET metadata = ?
         WHERE id = ? AND chat_id IN (${USER_CHATS})`
      .run(sealRow(this.crypto, "messages", { id: existing.id, chat_id: existing.chat_id, metadata: encodeJson(merged) }, userId)["metadata"] as string, id, userId);
    if (Number(result.changes) !== 1) throw new WebError("Message evidence write was not acknowledged", "message_metadata_write_failed");
  }

  /**
   * ── THERE IS DELIBERATELY NO `deleteMessagesAfter` HERE ──────────────────
   *
   * There was one, and it was the only way to trim a conversation. Its single
   * caller — the rollback route — is gone, replaced by WITHDRAWAL: the rows
   * stay, a `rollback` event names the withdrawn ids, and the fold at read
   * time decides what the model receives.
   *
   * The method outlived its caller by a while, held up entirely by its own
   * tests. That is the shape worth naming: a destructive capability with zero
   * production callers still reads as load-bearing, because the tests around
   * it are green and specific, and the next person needing to trim a
   * conversation finds a ready-made, user-scoped, apparently-blessed way to
   * destroy messages. Deleting the method is the enforcement — an absent
   * method cannot be called, which is stronger than any rule saying not to.
   *
   * If message deletion is ever genuinely needed, it belongs behind the same
   * append-a-record-first discipline `recordRewind` uses, not restored here.
   */

  // ── Tool calls ──

  /** Every tool call in a chat, oldest first. Read in bounded KEYSET pages
   * (see `pageAllRows`). `tc.rowid` breaks `created_at` ties so the declared
   * ordering is TOTAL — an ordering with ties is not stable across pages and
   * would let a row be skipped or repeated at a boundary. */
  listToolCallsByChat(chatId: string, userId: string): readonly ToolCallRow[] {
    return this.pageAllRows(
      {
        columns: "tc.*",
        // Driven from `messages` rather than `tool_calls`: the scope is the
        // CHAT, and only messages carry an index for it. Driving from
        // tool_calls made the planner sort every page (USE TEMP B-TREE FOR
        // ORDER BY) — 393ms against 72ms for this shape.
        source: `messages m
           JOIN chats c ON m.chat_id = c.id
           JOIN projects p ON c.project_id = p.id
           JOIN tool_calls tc ON tc.message_id = m.id
           WHERE m.chat_id = ? AND p.user_id = ?`,
        // Composite: seek messages by rowid, break ties inside one message
        // with the tool call's own rowid. Unique as a pair.
        cursor: [
          { expr: "m.rowid", as: "__mrow" },
          { expr: "tc.rowid", as: "__row" },
        ],
        order: ["created_at", "__row"],
      },
      [chatId, userId],
      (r) => parseToolCallRow(r, this.crypto, userId),
    );
  }

  listToolCallsByMessage(messageId: string, userId: string): readonly ToolCallRow[] {
    const rows = this.#statement`SELECT tc.* FROM tool_calls tc
         JOIN messages m ON tc.message_id = m.id
         JOIN chats c ON m.chat_id = c.id
         JOIN projects p ON c.project_id = p.id
         WHERE tc.message_id = ? AND p.user_id = ?
         ORDER BY tc.created_at ASC`
      .all(messageId, userId) as ReadonlyArray<Record<string, unknown>>;
    return rows.map((r) => parseToolCallRow(r, this.crypto, userId));
  }

  /**
   * Create a tool_call row, scoped to the caller's user id. Verifies the
   * parent message belongs to the user (message → chat → project → user_id);
   * throws ForbiddenError (HTTP 403) if not. Returns the created row.
   */
  createToolCall(input: ToolCallCreateInput, userId: string): ToolCallRow {
    const valid = TOOL_CALL_CREATE_INPUT.parse(snapshotDbWriteArguments("createToolCall", [input, userId])[0]);
    if (!this.messageBelongsToUser(valid.message_id, userId)) {
      throw new ForbiddenError(`Message ${valid.message_id} does not belong to the caller.`, "tool_call_parent_not_owned");
    }
    const now = new Date().toISOString();
    const id = randomUuid();
    const call = sealRow(this.crypto, "tool_calls", {
      id, message_id: valid.message_id, tool_name: encodeJson(valid.tool_name),
      call_id: valid.call_id === undefined ? null : encodeJson(valid.call_id),
      public_projection: valid.public_projection === undefined ? null : encodeJson(valid.public_projection),
      input: encodeJson(valid.input), output: valid.output !== undefined ? encodeJson(valid.output) : null,
    }, userId);
    this.#statement`INSERT INTO tool_calls (id, message_id, tool_name, call_id, public_projection, input, output, status, duration_ms, attempt_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      .run(
        id,
        valid.message_id,
        call["tool_name"] as string,
        call["call_id"] as string | null,
        call["public_projection"] as string | null,
        call["input"] as string,
        call["output"] as string | null,
        valid.status,
        valid.duration_ms ?? null,
        valid.attempt_count ?? 1,
        now,
      );
    const row = this.#statement`SELECT * FROM tool_calls WHERE id = ?`
      .get(id) as Record<string, unknown>;
    return parseToolCallRow(row, this.crypto, userId);
  }

  /**
   * Update an existing tool_call row by id, scoped to the caller's user id:
   * set input, output, status, and duration_ms. The WHERE clause enforces
   * ownership via the message→chat→project→user JOIN subquery, so a
   * non-owned tool_call is never touched (0 rows affected). Used by the run
   * stream to persist the final tool execution result (output + done/error
   * status + duration) so tool calls and their errors survive a page
   * refresh.
   */
  updateToolCall(
    id: string,
    userId: string,
    updates: Readonly<{
      readonly input?: unknown;
      readonly output?: unknown;
      readonly status?: "running" | "done" | "error";
      readonly durationMs?: number;
      readonly attemptCount?: number;
      readonly publicProjection?: ToolPublicProjection;
    }>,
  ): void {
    updates = snapshotDbWriteArguments("updateToolCall", [id, userId, updates])[2] as typeof updates;
    const setClauses: string[] = [];
    const params: (string | number | null)[] = [];
    // Sealed fields are bound to the call's message and owner; a non-owned call has none here and is not touched.
    const sealing = updates.publicProjection !== undefined || updates.input !== undefined || updates.output !== undefined;
    const call = sealing
      ? this.#statement`SELECT id, message_id FROM tool_calls WHERE id = ? AND message_id IN (${USER_MESSAGES})`.get(id, userId) as { id: string; message_id: string } | undefined
      : undefined;
    if (sealing && call === undefined) return;
    const sealed = call === undefined ? {} : sealRow(this.crypto, "tool_calls", {
      ...call,
      ...(updates.publicProjection !== undefined ? { public_projection: encodeJson(TOOL_PUBLIC_PROJECTION.parse(updates.publicProjection)) } : {}),
      ...(updates.input !== undefined ? { input: encodeJson(updates.input) } : {}),
      ...(updates.output !== undefined ? { output: encodeJson(updates.output) } : {}),
    }, userId);
    if (updates.publicProjection !== undefined) {
      setClauses.push("public_projection = ?");
      params.push(sealed["public_projection"] as string);
    }
    if (updates.input !== undefined) {
      setClauses.push("input = ?");
      params.push(sealed["input"] as string);
    }
    if (updates.output !== undefined) {
      setClauses.push("output = ?");
      params.push(sealed["output"] as string);
    }
    if (updates.status !== undefined) {
      setClauses.push("status = ?");
      params.push(updates.status);
    }
    if (updates.durationMs !== undefined) {
      setClauses.push("duration_ms = ?");
      params.push(updates.durationMs);
    }
    if (updates.attemptCount !== undefined) {
      setClauses.push("attempt_count = ?");
      params.push(updates.attemptCount);
    }
    if (setClauses.length === 0) return;
    params.push(id, userId);
    this.#statement`UPDATE tool_calls SET ${setClauses.join(", ")}
         WHERE id = ? AND message_id IN (${USER_MESSAGES})`
      .run(...params);
  }

  /**
   * NO TOOL CALL OUTLIVES ITS RUN — the server-side half of the fix.
   *
   * A `tool_calls` row is created `running` when the model announces the call
   * and moved to `done`/`error` when the result arrives. There was exactly one
   * writer that finalised them and it only ran on the success path, so a run
   * that ended any other way left its rows `running` forever: the history
   * endpoint served them back as "running" on every subsequent reload, with no
   * sweeper, no reconciler and no startup pass anywhere in the server.
   *
   * This is called from the executor's `finally`, which now runs on EVERY exit
   * — completion, provider error, cancellation, tool-iteration bound. The
   * row's `output` stays NULL: `output` means WHAT THE TOOL RETURNED, and a
   * sentence the harness wrote where a result belongs is a fabricated tool
   * answer — fed back to a model through the history rebuild, and presented
   * to a user as the tool's own words. The status alone states what is
   * known, and it is also the fact the client's read-back heal needs: a row
   * with a status but no output is an honest absence, never healed into
   * looking like a result.
   *
   * Returns how many rows it finalised, so a caller can report the number
   * rather than assert a clean exit it did not verify.
   */
  finalizeRunningToolCallsForRun(runId: string, userId: string): number {
    if (typeof runId !== "string" || runId.length === 0) return 0;
    const rows = this.#statement`SELECT tc.id AS id FROM tool_calls tc
         JOIN messages m ON tc.message_id = m.id
         WHERE m.run_id = ? AND tc.status = 'running'
           AND tc.message_id IN (${USER_MESSAGES})`
      .all(runId, userId) as ReadonlyArray<Record<string, unknown>>;
    let finalized = 0;
    for (const row of rows) {
      const id = row["id"];
      if (typeof id !== "string") continue;
      this.updateToolCall(id, userId, { status: "error" });
      finalized += 1;
    }
    return finalized;
  }

  // ── Metrics snapshots ──

  /** Every metrics snapshot for a chat, oldest first (the LAST one is the
   * chat's current metrics). Read in bounded pages (see `pageAllRows`);
   * `ms.rowid` makes the ordering total across page boundaries. */
  listMetricsSnapshots(chatId: string, userId: string): readonly MetricsSnapshotRow[] {
    return this.pageAllRows(
      {
        columns: "ms.*",
        source: `metrics_snapshots ms
           JOIN chats c ON ms.chat_id = c.id
           JOIN projects p ON c.project_id = p.id
           WHERE ms.chat_id = ? AND p.user_id = ?`,
        cursor: [{ expr: "ms.rowid", as: "__row" }],
        order: ["created_at", "__row"],
      },
      [chatId, userId],
      (r) => parseMetricsSnapshotRow(r, this.crypto, userId),
    );
  }

  /**
   * Create a metrics snapshot, scoped to the caller's user id. Verifies the
   * chat belongs to the user; throws ForbiddenError (HTTP 403) if not.
   * Returns the created row.
   */
  createMetricsSnapshot(input: MetricsSnapshotCreateInput, userId: string): MetricsSnapshotRow {
    const valid = METRICS_SNAPSHOT_CREATE_INPUT.parse(input);
    if (!this.chatBelongsToUser(valid.chat_id, userId)) {
      throw new ForbiddenError(`Chat ${valid.chat_id} does not belong to the caller.`, "metrics_parent_not_owned");
    }
    const now = new Date().toISOString();
    const id = randomUuid();
    this.#statement`INSERT INTO metrics_snapshots (id, chat_id, snapshot, created_at) VALUES (?, ?, ?, ?)`
      .run(id, valid.chat_id, sealRow(this.crypto, "metrics_snapshots", { id, chat_id: valid.chat_id, snapshot: encodeJson(valid.snapshot) }, userId)["snapshot"] as string, now);
    const row = this.#statement`SELECT * FROM metrics_snapshots WHERE id = ?`
      .get(id) as Record<string, unknown>;
    return parseMetricsSnapshotRow(row, this.crypto, userId);
  }

  // ── Auto checks ──
  //
  // Scope distinction: a check is either PROJECT-level (chat_id IS
  // NULL — runs against the whole project) or CHAT-level (chat_id set —
  // associated with a specific chat). The two list endpoints return
  // NON-overlapping sets so a check never shows under both:
  // listAutoChecksByProject → chat_id IS NULL (project-level only)
  // listAutoChecksByChat → chat_id =? (chat-level only)
  // createAutoCheck is an UPSERT on (check_name, project_id, chat_id) so the
  // same check never appears twice (dedup) — re-running a check replaces the
  // prior result instead of adding a duplicate row. All scoped by userId.

  listAutoChecksByProject(projectId: string, userId: string): readonly AutoCheckRow[] {
    // Project-level checks ONLY (chat_id IS NULL). Chat-scoped checks belong
    // to their chat's list, not the project list — this is the fix for
    // "lint/checks show under both chat AND project". The project_id IN
    // (user's projects) clause enforces ownership.
    const rows = this.#statement`SELECT * FROM auto_checks
         WHERE project_id = ? AND chat_id IS NULL
           AND project_id IN (${USER_PROJECTS})
         ORDER BY created_at DESC`
      .all(projectId, userId) as ReadonlyArray<Record<string, unknown>>;
    return rows.map((r) => parseAutoCheckRow(r, this.crypto, userId));
  }

  listAutoChecksByChat(chatId: string, userId: string): readonly AutoCheckRow[] {
    const rows = this.#statement`SELECT ac.* FROM auto_checks ac
         JOIN chats c ON ac.chat_id = c.id
         JOIN projects p ON c.project_id = p.id
         WHERE ac.chat_id = ? AND p.user_id = ?
         ORDER BY ac.created_at DESC`
      .all(chatId, userId) as ReadonlyArray<Record<string, unknown>>;
    return rows.map((r) => parseAutoCheckRow(r, this.crypto, userId));
  }

  /**
   * UPSERT an auto-check, scoped to the caller's user id. If a check with
   * the same (check_name, project_id, chat_id) already exists, UPDATE its
   * status + output + created_at (the re-run replaces the prior result) —
   * this is the dedup fix for "the same tool shows twice under the same
   * thing". Otherwise INSERT a new row. The (project_id, chat_id) pair
   * defines the scope: chat_id NULL = project-level; chat_id set = chat-
   * level. Verifies the project/chat belongs to the user (throws
   * ForbiddenError if not). Returns the resulting row.
   */
  createAutoCheck(input: AutoCheckCreateDbInput, userId: string): AutoCheckRow {
    const { row, fromStatus, checkName, toStatus, projectId, chatId } =
      this.createAutoCheckReturningTransition(input, userId);
    this.recordCheckStatusEvent(row.id, checkName, fromStatus, toStatus, projectId, chatId);
    return row;
  }

  /**
   * The auto-check upsert WITHOUT the ledger append, returning the status
   * transition so a caller can append it itself.
   *
   * ── Why this split exists: the ledger cannot cross a thread ──
   *
   * The write above is the choke point at which a check's PREVIOUS status
   * still exists anywhere, so the history event has to be recorded here and
   * not at any call site. That reasoning is unchanged. What changed is where
   * "here" runs: under the async facade this method executes on the writer
   * THREAD, and appending to the ledger from there would break two of the
   * things §2 says are never traded.
   *
   *  1. TAMPER-EVIDENCE. The ledger's chain hash links each entry to the one
   *     before it, which is only well-defined while a single writer decides
   *     what "the one before it" is. A worker calling `getTimelineRecorder()`
   *     opens its own store over the same file, so two writers would race to
   *     extend the same chain and the hash would stop proving anything. The
   *     ledger keeps exactly one writer, on the main thread.
   *  2. CAUSALITY. `recordEvent` merges the ambient recording context, which
   *     lives in AsyncLocalStorage. A worker has no such context and would not
   *     fail — it would record the event with NO correlation, silently turning
   *     recorded causality into missing causality. That is the failure mode
   *     this product exists to prevent, arriving through the threading door.
   *
   * So the facade calls this method on the writer and appends the event itself
   * on the main thread, inside the caller's async context, which ALS preserves
   * across `await`. `createAutoCheck` above keeps both halves fused for
   * in-process callers, so recording is still structurally unavoidable through
   * either door.
   */
  createAutoCheckReturningTransition(
    input: AutoCheckCreateDbInput,
    userId: string,
  ): Readonly<{
    row: AutoCheckRow;
    fromStatus: string | null;
    checkName: string;
    toStatus: string;
    projectId: string | null;
    chatId: string | null;
  }> {
    const valid = AUTO_CHECK_CREATE_INPUT.parse(input);
    const projectId = valid.project_id ?? null;
    const chatId = valid.chat_id ?? null;
    // A check MUST be scoped to a project or a chat. When BOTH are null the
    // ownership pre-checks below do not run (no scope id to verify), the
    // dedup lookup matches across ALL users (`project_id IS NULL AND
    // chat_id IS NULL` is not user-scoped), and an unscoped, unowned row is
    // created — a deny-by-default gap. Require at least one scope.
    if (projectId === null && chatId === null) {
      throw new ValidationError("createAutoCheck requires a project_id or chat_id scope.", "invalid_auto_check_scope");
    }
    // Ownership: if a project_id is given it must belong to the user; if a
    // chat_id is given it must belong to the user. A chat-scoped check also
    // implies its project is owned (chatBelongsToUser covers that).
    if (projectId !== null && !this.projectBelongsToUser(projectId, userId)) {
      throw new ForbiddenError(`Project ${projectId} does not belong to the caller.`, "auto_check_parent_not_owned");
    }
    if (chatId !== null && !this.chatBelongsToUser(chatId, userId)) {
      throw new ForbiddenError(`Chat ${chatId} does not belong to the caller.`, "auto_check_parent_not_owned");
    }
    // Atomic dedup + write: the SELECT-then-UPDATE/INSERT must not race.
    // Without a transaction, two concurrent creates with the same scope
    // could both see no existing row and both INSERT — producing the
    // duplicate rows the dedup is meant to prevent (there is no DB-level
    // UNIQUE constraint on (check_name, project_id, chat_id) because SQLite
    // treats NULL as distinct in unique indexes, so chat_id IS NULL
    // project-level checks cannot be deduped at the DB layer). Wrapping the
    // lookup + write in one transaction closes the race.
    // The from-status is read INSIDE the same transaction as the overwrite:
    // it is the one moment the previous status still exists anywhere, which
    // is why the history event is recorded here at the write choke point
    // (every caller — the run route's lint check, the auto-checks route, the
    // checks block action — lands in this method) and not at any call site.
    let fromStatus: string | null = null;
    const row = this.withTransaction(() => {
      const now = new Date().toISOString();
      const existing = this.#statement`SELECT id, status FROM auto_checks WHERE check_name = ? AND project_id IS ? AND chat_id IS ? LIMIT 1`
        .get(valid.check_name, projectId, chatId) as { id?: string; status?: string } | undefined;
      if (existing?.id !== undefined) {
        fromStatus = existing.status ?? null;
        this.#statement`UPDATE auto_checks SET status = ?, output = ?, created_at = ? WHERE id = ?`
          .run(valid.status, sealRow(this.crypto, "auto_checks", { id: existing.id, project_id: projectId, chat_id: chatId, output: encodeJson(valid.output) }, userId)["output"] as string, now, existing.id);
        return this.#statement`SELECT * FROM auto_checks WHERE id = ?`
          .get(existing.id) as Record<string, unknown>;
      }
      const id = randomUuid();
      this.#statement`INSERT INTO auto_checks (id, project_id, chat_id, check_name, status, output, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
        .run(
          id,
          projectId,
          chatId,
          valid.check_name,
          valid.status,
          sealRow(this.crypto, "auto_checks", { id, project_id: projectId, chat_id: chatId, output: encodeJson(valid.output) }, userId)["output"] as string,
          now,
        );
      return this.#statement`SELECT * FROM auto_checks WHERE id = ?`
        .get(id) as Record<string, unknown>;
    });
    return {
      row: parseAutoCheckRow(row, this.crypto, userId),
      fromStatus,
      checkName: valid.check_name,
      toStatus: valid.status,
      projectId,
      chatId,
    };
  }

  /**
   * Append one check-status event to the timeline ledger — the honest history
   * stream BESIDE the upsert above, which keeps only the latest status. The
   * upsert stays (the "latest" read stays one cheap row); this event is what
   * makes "when did this check flip" derivable at all: `synthesis.
   * conversationPulse` refused `checksFlipped` precisely because the UPDATE
   * overwrites the previous status at write time.
   *
   * Correlation is deliberately NOT passed: `recordEvent` merges the ambient
   * recording context, so a check upserted inside a run boundary (the run
   * route's post-run lint) carries that run id, and a check run from the
   * panel outside any run honestly carries none. The chat/project scope
   * travels in the DOCUMENT because the ledger's correlation vocabulary has
   * no chat/project field.
   *
   * Recorded AFTER the transaction commits (never for a rolled-back write),
   * and a recorder failure is warned, not thrown — the check row is already
   * durable, and failing the caller would report a failure that did not
   * happen. Same posture as the editor bridge's file-effect recording.
   */
  private recordCheckStatusEvent(
    checkId: string,
    checkName: string,
    fromStatus: string | null,
    toStatus: string,
    projectId: string | null,
    chatId: string | null,
  ): void {
    recordCheckStatusEvent(checkId, checkName, fromStatus, toStatus, projectId, chatId);
  }

  // ── Timeline refs ──

  /** Every timeline ref for a chat, oldest first. Read in bounded pages
   * (see `pageAllRows`); `tr.rowid` makes the ordering total across page
   * boundaries. */
  listTimelineRefs(chatId: string, userId: string): readonly TimelineRefRow[] {
    return this.pageAllRows(
      {
        columns: "tr.*",
        source: `timeline_refs tr
           JOIN chats c ON tr.chat_id = c.id
           JOIN projects p ON c.project_id = p.id
           WHERE tr.chat_id = ? AND p.user_id = ?`,
        cursor: [{ expr: "tr.rowid", as: "__row" }],
        // Declared on `timestamp`, not `created_at` — this table's order is
        // the recorded event time, not the row's insertion time.
        order: ["timestamp", "__row"],
      },
      [chatId, userId],
      (r) => parseTimelineRefRow(r, this.crypto, userId),
    );
  }

  /**
   * The chat→runs mapping's owned predicate — the ONE statement every
   * reader of "which runs belong to this chat" prepares. `messages.run_id`
   * is the authoritative server-written source (every persisted message
   * records the run that produced it); `timeline_refs.metadata` is
   * deliberately not consulted — that blob is client-writable via POST
   * /api/chats/:id/timeline (metadata is z.unknown()), so trusting its
   * `runId` would let a caller poison their own runId set with another
   * user's run id. Server callers compose the user-ownership gate after it
   * (see `runIdsForChat`); the dev trace CLI (`scripts/trace.ts --chat`)
   * prepares the statement as-is on its own read-only connection — a dev
   * diagnostic that already reads the whole ledger unscoped.
   */
  runIdsForChat(chatId: string, userId: string): readonly string[] {
    if (!this.chatBelongsToUser(chatId, userId)) return [];
    // The run→user mapping uses ONLY `messages.run_id` — the authoritative
    // server-written source, owned by CHAT_RUN_IDS_SQL above this class.
    // The user-ownership gate is composed after it, never duplicated.
    const runIds = new Set<string>();
    const msgRows = this.#statement`${CHAT_RUN_IDS_SQL} AND chat_id IN (${USER_CHATS})`
      .all(chatId, userId) as ReadonlyArray<Record<string, unknown>>;
    for (const r of msgRows) {
      const runId = r["run_id"];
      if (typeof runId === "string") runIds.add(runId);
    }
    return [...runIds];
  }

  /**
   * Resolve the distinct run IDs associated with a project, scoped to the
   * caller's user id: the union of run IDs across all of the project's chats
   * (only chats owned by the user). Used by the timeline route to scope the
   * canonical ledger to a project when no chat is selected. A single JOIN
   * query resolves the set (scoped by projectId + userId on projects) so a
   * project with many chats does not run one query per chat (the prior
   * listChats + per-chat runIdsForChat loop was an N+1). A non-owned project
   * yields an empty list (no leak).
   */
  runIdsForProject(projectId: string, userId: string): readonly string[] {
    const rows = this.#statement`SELECT DISTINCT m.run_id FROM messages m
         JOIN chats c ON m.chat_id = c.id
         JOIN projects p ON c.project_id = p.id
         WHERE p.id = ? AND p.user_id = ?
           AND m.run_id IS NOT NULL AND m.run_id != ''`
      .all(projectId, userId) as ReadonlyArray<Record<string, unknown>>;
    return rows
      .map((r) => r["run_id"])
      .filter((v): v is string => typeof v === "string");
  }

  /** Caller/project-scoped canonical run ownership and producing turn facts.
   * The user window includes no-run rows; only the first user row for each
   * run joins back. Assistant bodies and message metadata are never read.
   * Chat order matches listChats so duplicate run/chat facts retain its
   * existing last-chat-wins behavior. Trashed chats remain owned globally
   * but cannot attribute this project's visible work. */
  runAttributionsForProject(projectId: string, userId: string): readonly RunAttributionRow[] {
    const rows = this.#statement`WITH project_chats AS (
 SELECT c.id,c.title,c.pinned,c.updated_at,c.rowid AS chat_order FROM chats c JOIN projects p ON c.project_id=p.id
 WHERE p.id=? AND p.user_id=? AND c.trashed_at IS NULL AND p.trashed_at IS NULL
), user_turns AS (
 SELECT m.id AS message_id,m.chat_id,m.run_id,m.content,
 ROW_NUMBER() OVER (PARTITION BY m.chat_id ORDER BY m.created_at,m.rowid) AS turn,
 ROW_NUMBER() OVER (PARTITION BY m.chat_id,m.run_id ORDER BY m.created_at,m.rowid) AS run_turn
 FROM messages m JOIN project_chats c ON c.id=m.chat_id WHERE m.role='user'
), runs AS (
 SELECT DISTINCT m.chat_id,m.run_id FROM messages m JOIN project_chats c ON c.id=m.chat_id
 WHERE m.run_id IS NOT NULL AND m.run_id!=''
)
SELECT r.run_id,c.id AS chat_id,c.title,t.turn,t.message_id,t.content FROM runs r JOIN project_chats c ON c.id=r.chat_id
LEFT JOIN user_turns t ON t.chat_id=r.chat_id AND t.run_id=r.run_id AND t.run_turn=1
ORDER BY c.pinned DESC,c.updated_at DESC,c.chat_order DESC`.all(projectId, userId) as ReadonlyArray<Record<string, unknown>>;
    const titles = new Map<string, string>();
    return rows.map((row) => {
      const chatId = row["chat_id"] as string;
      let chatTitle = titles.get(chatId);
      if (chatTitle === undefined) {
        chatTitle = openRow(this.crypto, "chats", { id: chatId, project_id: projectId, title: row["title"] }, userId)["title"] as string;
        titles.set(chatId, chatTitle);
      }
      return RUN_ATTRIBUTION_ROW.parse({
        runId: row["run_id"], chatId, chatTitle, turn: row["turn"],
        requestContent: row["message_id"] == null ? null
          : openRow(this.crypto, "messages", { id: row["message_id"], chat_id: chatId, content: row["content"] }, userId)["content"],
      });
    });
  }

  /**
   * Resolve the distinct run IDs the caller owns across ALL their projects —
   * the union of `messages.run_id` over chats under the user's projects.
   * Single-Party-Owner: the authoritative run→user mapping used to
   * scope GLOBAL data that is keyed by runId but has no direct user_id
   * column — the live agent-state list (`/api/agents`) and a single timeline
   * event (`/api/timeline/events/:eventId`). Without this, User B could see
   * User A's running agents and fetch A's event detail by guessing the
   * event id (a cross-user leak — deny-by-default closes it). The
   * `messages.run_id` column is the authoritative source: every run started
   * via `/api/run/start` persists a message carrying its `run_id` in a chat
   * owned by the user, so the mapping is complete for any run the web UI
   * surfaced. `timeline_refs.metadata` is encrypted at rest, so its runId
   * is not SQL-queryable; the messages source covers the runs that matter.
   */
  allRunIdsForUser(userId: string): readonly string[] {
    const rows = this.#statement`SELECT DISTINCT run_id FROM messages
         WHERE run_id IS NOT NULL AND run_id != ''
           AND chat_id IN (${USER_CHATS})`
      .all(userId) as ReadonlyArray<Record<string, unknown>>;
    return rows
      .map((r) => r["run_id"])
      .filter((v): v is string => typeof v === "string");
  }

  /**
   * Whether a run belongs to the caller: true when any message carrying
   * `run_id = runId` lives in a chat under one of the user's projects. The
   * single gate for the timeline event-detail route (deny-by-default: an
   * event whose run is not the caller's → 404, hiding existence). See
   * `allRunIdsForUser` for the mapping-authority rationale.
   */
  runBelongsToUser(runId: string, userId: string): boolean {
    if (typeof runId !== "string" || runId.length === 0) return false;
    const row = this.#statement`SELECT 1 FROM messages
         WHERE run_id = ? AND chat_id IN (${USER_CHATS})
         LIMIT 1`
      .get(runId, userId) as Record<string, unknown> | undefined;
    return row !== undefined;
  }

  /**
   * CLAIM THE RIGHT TO EXECUTE A RUN — the first statement of any executor.
   *
   * Returns normally when this caller won the claim. Throws `ConflictError`
   * (HTTP 409, code `run_already_executing`) when the run has already been
   * claimed, because the INSERT was refused by SQLite's PRIMARY KEY: the
   * refusal is the engine's, not a check written here, and it therefore holds
   * for callers this module has never heard of.
   *
   * The narrow catch is deliberate. Only a primary-key/unique violation means
   * "someone else has this run"; any other SQLite failure — a missing table, a
   * read-only connection, a disk error — is a genuine fault and is re-thrown
   * unchanged. A broad `catch` here would convert a crash into the verdict
   * "already claimed", which is the shape that turns an outage into a
   * plausible-looking domain answer.
   */
  claimRunExecution(runId: string, userId: string): void {
    if (typeof runId !== "string" || runId.length === 0) {
      throw new ValidationError("A run id is required to claim a run execution.", "invalid_run_id");
    }
    try {
      this.#statement`INSERT INTO run_executions (run_id, user_id, claimed_at) VALUES (?, ?, ?)`
        .run(runId, userId, new Date().toISOString());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // node:sqlite surfaces the constraint in the message; both spellings
      // ("UNIQUE constraint failed", "PRIMARY KEY must be unique") are the
      // same engine refusal, and matching on either is matching on what the
      // engine said rather than on an error code the binding may not expose.
      if (/UNIQUE constraint failed|PRIMARY KEY must be unique/i.test(message)) {
        throw new ConflictError(
          `Run ${runId} is already executing. A run executes exactly once.`,
          "run_already_executing",
        );
      }
      throw err;
    }
  }

  // THERE IS DELIBERATELY NO `runExecutionClaimed` READ.
  //
  // A "has this run been claimed?" accessor was written beside the claim and
  // had no caller — the same wired-but-inert shape as the `isStreaming` flag
  // it replaced, which was written four times and read zero. It is worse than
  // useless here: answering it requires reading ACROSS tenants (the run id is
  // the key, so a claim by anyone refuses everyone), which means the method
  // either takes no user id and breaks the scoping rule every other user-data
  // read obeys, or takes one and answers the wrong question.
  //
  // Nothing needs it. The refusal is `claimRunExecution` throwing, and a
  // caller learns the answer by trying — which is also the only answer that
  // cannot be stale by the time it is used.

  /**
   * Create a timeline ref, scoped to the caller's user id. Verifies the chat
   * belongs to the user; throws ForbiddenError (HTTP 403) if not. Returns
   * the created row.
   */
  createTimelineRef(input: TimelineRefCreateInput, userId: string): TimelineRefRow {
    const valid = TIMELINE_REF_CREATE_INPUT.parse(input);
    if (!this.chatBelongsToUser(valid.chat_id, userId)) {
      throw new ForbiddenError(`Chat ${valid.chat_id} does not belong to the caller.`, "timeline_parent_not_owned");
    }
    const id = randomUuid();
    this.#statement`INSERT INTO timeline_refs (id, chat_id, event_id, event_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?, ?)`
      .run(
        id,
        valid.chat_id,
        valid.event_id,
        valid.event_type,
        valid.timestamp,
        sealRow(this.crypto, "timeline_refs", { id, chat_id: valid.chat_id, metadata: encodeJson(valid.metadata) }, userId)["metadata"] as string,
      );
    const row = this.#statement`SELECT * FROM timeline_refs WHERE id = ?`
      .get(id) as Record<string, unknown>;
    return parseTimelineRefRow(row, this.crypto, userId);
  }

  // ── Tool settings (per-user — v12: tools per user) ──

  /**
   * List all tool settings for a user. Returns the per-user overrides
   * (enabled flag + optional config). The caller merges these with the
   * global config default in the tools-bridge.
   */
  listToolSettings(userId: string): readonly ToolSettingRow[] {
    const rows = this.#statement`SELECT * FROM tool_settings WHERE user_id = ? ORDER BY updated_at DESC`
      .all(userId) as ReadonlyArray<Record<string, unknown>>;
    return rows.map((r) => parseToolSettingRow(r));
  }

  /**
   * Upsert a per-user tool setting (enable/disable + optional config).
   * The (user_id, tool_name) pair is unique — re-toggling replaces the
   * prior row. Returns the resulting row.
   *
   * The `userId` is a separate, server-controlled parameter (NOT part of the
   * input object) — the ownership gate is at the method, not the caller. A
   * route that forgets `userId` gets a ValidationError (deny-by-default),
   * never a silent write for another user.
   *
   * Atomic upsert via `INSERT ... ON CONFLICT(user_id, tool_name) DO
   * UPDATE ... RETURNING` — a single statement that INSERTs, or UPDATEs on
   * collision, and returns the resulting row in one round-trip. This removes
   * the SELECT-then-INSERT/UPDATE race where two concurrent upserts could
   * both see no existing row and both INSERT (the second throwing an
   * unhandled SQLITE_CONSTRAINT on the UNIQUE(user_id, tool_name) index).
   * Mirrors the atomic-upsert pattern in upsertUserModelPrefs /
   * upsertUserPromptPrefs, extended with RETURNING so the row is read back
   * atomically with the write (no second query, no stale read).
   */
  upsertToolSetting(input: ToolSettingUpsertInput, userId: string): ToolSettingRow {
    if (typeof userId !== "string" || userId.length === 0) {
      throw new ValidationError("upsertToolSetting requires a non-empty userId (the owning user).", "invalid_user_id");
    }
    const valid = TOOL_SETTING_UPSERT_INPUT.parse(input);
    const now = new Date().toISOString();
    const row = this.#statement`INSERT INTO tool_settings (id, user_id, tool_name, enabled, config, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, tool_name) DO UPDATE SET enabled = excluded.enabled, config = excluded.config, updated_at = excluded.updated_at
         RETURNING *`
      .get(
        randomUuid(),
        userId,
        valid.tool_name,
        valid.enabled ? 1 : 0,
        valid.config !== undefined ? encodeJson(valid.config) : null,
        now,
      ) as Record<string, unknown>;
    return parseToolSettingRow(row);
  }

  // ── Users + auth sessions (multi-user — v12; authentication) ──
  //
  // These are the IDENTITY / AUTHORITY tables, not tenant user-data: the
  // `users` table IS the user (looked up by id/username during auth), and
  // `auth_sessions` links a session token to a user. They are NOT scoped by
  // a caller-supplied userId (the id IS the user, or the token IS the
  // session); the mechanical userId-threading test exempts them (they do
  // not return tenant data rows like projects/chats).

  /** Count registered users. 0 → setup mode (first register creates admin). */
  countUsers(): number {
    const row = this.#statement`SELECT COUNT(*) AS n FROM users`.get() as { n?: number };
    return row?.n ?? 0;
  }

  /** Look up a user by username (the login identity). Null if not found. */
  getUserByUsername(username: string): UserRow | null {
    const row = this.#statement`SELECT * FROM users WHERE username = ? LIMIT 1`
      .get(username) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return {
      id: row["id"] as string,
      username: row["username"] as string,
      password_hash: (openRow(this.crypto, "users", row, row["id"] as string)["password_hash"] as string | null) ?? (row["password_hash"] as string),
      is_admin: Number(row["is_admin"] ?? 0),
      created_at: row["created_at"] as string,
    };
  }

  /** Look up a user by id. Null if not found. */
  getUserById(id: string): UserRow | null {
    const row = this.#statement`SELECT * FROM users WHERE id = ? LIMIT 1`
      .get(id) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return {
      id: row["id"] as string,
      username: row["username"] as string,
      password_hash: (openRow(this.crypto, "users", row, row["id"] as string)["password_hash"] as string | null) ?? (row["password_hash"] as string),
      is_admin: Number(row["is_admin"] ?? 0),
      created_at: row["created_at"] as string,
    };
  }

  /**
   * Create a user. `passwordHash` is the ALREADY-HASHED scrypt string (the
   * route hashes the plaintext password before calling). The first user
   * registered (when countUsers === 0) becomes the admin (is_admin=1).
   * Throws on username collision (the route maps this to 409). Returns the
   * new row.
   */
  createUser(username: string, passwordHash: string): UserRow {
    const now = new Date().toISOString();
    const id = randomUuid();
    const isAdmin = this.countUsers() === 0 ? 1 : 0;
    const encHash = (sealRow(this.crypto, "users", { id, password_hash: passwordHash }, id)["password_hash"] as string | null) ?? passwordHash;
    this.#statement`INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)`
      .run(id, username, encHash, isAdmin, now);
    return this.getUserById(id)!;
  }

  /**
   * Set a user's password hash (already-hashed scrypt string). Used by the
   * change-password flow. Encrypted at rest.
   */
  setUserPasswordHash(userId: string, passwordHash: string): void {
    const enc = (sealRow(this.crypto, "users", { id: userId, password_hash: passwordHash }, userId)["password_hash"] as string | null) ?? passwordHash;
    this.#statement`UPDATE users SET password_hash = ? WHERE id = ?`
      .run(enc, userId);
  }

  /** Delete a user by id. Returns true if a row was deleted. */
  deleteUser(id: string): boolean {
    const result = this.#statement`DELETE FROM users WHERE id = ?`.run(id);
    return Number(result.changes ?? 0) > 0;
  }

  /** Create an auth session: store the token hash + link to the user id.
   * The browser `sessionId` (the `harness_session` isolation cookie) is kept
   * for audit only — it is NOT a security key. removed session-keying
   * from the rate limiter (it was a bypass vector); the rate limit now keys
   * by the authenticated `userId` (or the un-spoofable client IP). This
   * column is retained for browser-tracking/audit correlation. */
  createAuthSession(tokenHash: string, userId: string, sessionId: string): void {
    const now = new Date().toISOString();
    this.#statement`INSERT OR REPLACE INTO auth_sessions (token_hash, user_id, session_id, created_at) VALUES (?, ?, ?, ?)`
      .run(tokenHash, userId, sessionId, now);
  }

  /**
   * Look up a session by token hash. Returns the linked user id + creation
   * time, or null if not found. The user_id is the scoping key; session_id
   * is the legacy browser-tracking audit field.
   */
  getAuthSession(tokenHash: string): { user_id: string; session_id: string; created_at: string } | null {
    const row = this.#statement`SELECT user_id, session_id, created_at FROM auth_sessions WHERE token_hash = ? LIMIT 1`
      .get(tokenHash) as { user_id?: string; session_id?: string; created_at?: string } | undefined;
    if (row === undefined || row.user_id === undefined || row.created_at === undefined) return null;
    return { user_id: row.user_id, session_id: row.session_id ?? "", created_at: row.created_at };
  }

  /** Delete a session (logout). No-op if the session does not exist. */
  deleteAuthSession(tokenHash: string): void {
    this.#statement`DELETE FROM auth_sessions WHERE token_hash = ?`.run(tokenHash);
  }

  // ── User model preferences (models in DB, not config) ──

  /** Read a user's model/provider config (decrypted JSON). Null if unset. */
  getUserModelPrefs(userId: string): unknown | null {
    const row = this.#statement`SELECT config_json FROM user_model_prefs WHERE user_id = ? LIMIT 1`
      .get(userId) as { config_json?: string } | undefined;
    if (row === undefined || row.config_json === undefined) return null;
    return decodeJsonOrNull(openRow(this.crypto, "user_model_prefs", { user_id: userId, config_json: row.config_json }, userId)["config_json"] as string | null);
  }

  /** Upsert a user's model/provider config (encrypted at rest). */
  upsertUserModelPrefs(userId: string, config: unknown): void {
    const json = JSON.stringify(config);
    const enc = sealRow(this.crypto, "user_model_prefs", { user_id: userId, config_json: json }, userId)["config_json"] as string | null;
    const now = new Date().toISOString();
    // Atomic upsert via ON CONFLICT(user_id) — a single statement that
    // INSERTs, or UPDATEs on collision. Removes the SELECT-then-INSERT
    // race where two concurrent upserts could both see no existing row
    // and both INSERT (the second hitting the UNIQUE(user_id) constraint
    // with an unhandled SQLITE_CONSTRAINT).
    this.#statement`INSERT INTO user_model_prefs (id, user_id, config_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`
      .run(randomUuid(), userId, enc ?? json, now);
  }

  // ── User system-prompt preferences (configurable from web, per-user, encrypted) ──

  /**
   * Read a user's system-prompt preferences (decrypted JSON). Null if unset
   * (the config-file defaults apply). Mirrors the user_model_prefs pattern
   *.
   */
  getUserPromptPrefs(userId: string): unknown | null {
    const row = this.#statement`SELECT prefs_json FROM user_prompt_prefs WHERE user_id = ? LIMIT 1`
      .get(userId) as { prefs_json?: string } | undefined;
    if (row === undefined || row.prefs_json === undefined) return null;
    return decodeJsonOrNull(openRow(this.crypto, "user_prompt_prefs", { user_id: userId, prefs_json: row.prefs_json }, userId)["prefs_json"] as string | null);
  }

  /** Upsert a user's system-prompt preferences (encrypted at rest). */
  upsertUserPromptPrefs(userId: string, prefs: unknown): void {
    const json = JSON.stringify(prefs);
    const enc = sealRow(this.crypto, "user_prompt_prefs", { user_id: userId, prefs_json: json }, userId)["prefs_json"] as string | null;
    const now = new Date().toISOString();
    // Atomic upsert via ON CONFLICT(user_id) — see upsertUserModelPrefs
    // for the race this closes.
    this.#statement`INSERT INTO user_prompt_prefs (id, user_id, prefs_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET prefs_json = excluded.prefs_json, updated_at = excluded.updated_at`
      .run(randomUuid(), userId, enc ?? json, now);
  }

  /**
   * Delete a user's system-prompt preferences row. After this, the GET
   * endpoint returns the config-file defaults (source "default") — this is
   * the real "reset to defaults": the per-user override is removed so the
   * config defaults re-emerge, rather than writing the frontend's hardcoded
   * defaults as a new user override (which would lie about the source AND go
   * stale if the config defaults change). SPO: the SettingsPanel
   * "Reset to defaults" calls this, not a PUT of hardcoded defaults.
   */
  deleteUserPromptPrefs(userId: string): void {
    this.#statement`DELETE FROM user_prompt_prefs WHERE user_id = ?`.run(userId);
  }

  // ── Composite history ──

  /**
   * Full history for a chat, scoped to the caller's user id. Returns null if
   * the chat does not exist / is not owned. All child reads (messages, tool
   * calls, metrics, timeline) are themselves scoped by the same userId
   * (defense-in-depth — even if getChat were bypassed, the child reads
   * would return empty for a non-owned chat).
   */
  getChatHistory(chatId: string, userId: string): ChatHistory | null {
    const chat = this.getChat(chatId, userId);
    if (!chat) return null;
    return {
      chat,
      messages: this.listMessages(chatId, userId),
      tool_calls: this.listToolCallsByChat(chatId, userId),
      metrics_snapshots: this.listMetricsSnapshots(chatId, userId),
      timeline_refs: this.listTimelineRefs(chatId, userId),
    };
  }

  // ── The bounded history reads (DESIGN-PERFORMANCE §4) ──

  /**
   * ONE PAGE OF MESSAGES, NEWEST-END FIRST — the walk both public paged
   * reads share.
   *
   * Reads BACKWARDS from `before` (or from the newest message when `before`
   * is null) and returns the page in the reader's order, oldest first. The
   * whole walk is one transaction so the page, the older-probe and the count
   * are cut from ONE snapshot: without that, a message written between the
   * page and the probe makes `hasOlder` describe a database that no longer
   * matches the rows in hand.
   *
   * TWO BOUNDS, AND THE PAGE ENDS AT WHICHEVER ARRIVES FIRST. `limit` bounds
   * the rows; `chatHistoryPageBytes` bounds the CONTENT, because a row bound
   * is not a payload bound — one tool call returning a large file makes a
   * 200-row page a multi-megabyte response, and §5's table asks for < 500KB.
   *
   * AT LEAST ONE MESSAGE IS ALWAYS RETURNED when one exists, whatever its
   * size. A page that came back empty while claiming there is more would be
   * a cursor that never advances: the reader would ask forever and travel
   * nowhere, which is a hang rather than a bound.
   */
  private pageMessagesBackwards(
    chatId: string,
    userId: string,
    limit: number,
    before: HistoryCursor | null,
  ): Readonly<{ messages: readonly MessageRow[]; facts: HistoryPageFacts }> {
    const budget = serverConfig.chatHistoryPageBytes;
    const scope = `messages m
       JOIN chats c ON m.chat_id = c.id
       JOIN projects p ON c.project_id = p.id
       WHERE m.chat_id = ? AND p.user_id = ?`;
    // ── "STRICTLY BEFORE THIS POSITION", IN TWO PARTS, AND BOTH ARE LOAD-
    // BEARING ─────────────────────────────────────────────────────────────
    //
    // The second half is the exact lexicographic predicate. The first is
    // REDUNDANT to it and is what makes the read a seek: SQLite cannot turn
    // a disjunction into an index range, so with only the second half the
    // plan reads `SEARCH m USING idx_messages_chat_created (chat_id=?)` —
    // it starts at the newest message of the chat and FILTERS backwards to
    // the cursor. That is O(distance from the tail) per page and O(n²) over
    // a walk, which is precisely the quadratic OFFSET defect this cursor
    // replaced, wearing a WHERE clause instead of an OFFSET.
    //
    // With `created_at <= ?` in front the plan becomes
    // `(chat_id=? AND created_at<?)` — a positioned range scan. Ties on
    // `created_at` are admitted by the `<=` and then cut by the rowid leg,
    // so the pair is exactly "before this position" and nothing else.
    // `tests/prevention/history-cursor-owner.test.ts` reads the query plan
    // and fails if the seek is ever lost.
    const olderThan =
      "m.created_at <= ? AND (m.created_at < ? OR (m.created_at = ? AND m.rowid < ?))";
    const cursorParams = (c: HistoryCursor): readonly (string | number)[] => [
      c.createdAt,
      c.createdAt,
      c.createdAt,
      c.rowid,
    ];

    return this.withTransaction(() => {
      const where = before === null ? scope : `${scope} AND ${olderThan}`;
      const params: (string | number)[] = [chatId, userId];
      if (before !== null) params.push(...cursorParams(before));
      const fetched = this.#statement`SELECT m.*, m.rowid AS __row FROM ${where}
           ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`
        .all(...params, limit) as ReadonlyArray<Record<string, unknown>>;

      // ── THE TOOL CALLS COUNT AGAINST THE BUDGET, and this was the hole ──
      //
      // The page's tool calls are fetched AFTER the messages are chosen, so
      // the first version of this budget never saw them. Measured on the
      // `heavy` fixture's 20,000-message conversation: a 200-message page
      // whose messages were 322KB carried 449KB of tool calls — 56% of the
      // response, entirely outside the bound it was supposed to be under.
      // The page came out at 788.8KB against §5's 500KB budget, and every
      // row-count assertion was green.
      //
      // Weighed from the STORED size (`LENGTH` over the ciphertext), which
      // costs no decryption and is an UPPER bound on the plaintext when
      // field encryption is on (base64 expands by ~4/3) and exact when it is
      // off. Over-estimating makes pages smaller, which is the safe
      // direction for a payload bound.
      const toolBytes = this.toolCallBytesByMessage(
        fetched.map((raw) => String(raw["id"])),
      );

      // Newest → oldest, keeping rows until the byte budget is met. The row
      // that crosses the budget is KEPT: a reader owed a message does not
      // stop being owed it because it is large.
      const kept: MessageRow[] = [];
      let bytes = 0;
      let stoppedOnBytes = false;
      for (const raw of fetched) {
        const row = parseMessageRow(raw, this.crypto, userId);
        kept.push(row);
        bytes += approximateJsonBytes(row) + (toolBytes.get(row.id) ?? 0);
        if (bytes >= budget) {
          stoppedOnBytes = kept.length < fetched.length;
          break;
        }
      }
      // Back into the reader's order. The cursor columns come off the RAW
      // rows, which are in the same (descending) order `fetched` is.
      const oldestRaw = fetched[kept.length - 1];
      kept.reverse();

      let endedBy: HistoryPageFacts["endedBy"];
      let hasOlder: boolean;
      if (stoppedOnBytes) {
        // Rows we fetched and did not keep are, by construction, older.
        endedBy = "bytes";
        hasOlder = true;
      } else if (fetched.length === limit) {
        endedBy = "limit";
        hasOlder =
          oldestRaw === undefined
            ? false
            : this.#statement`SELECT 1 FROM ${scope} AND ${olderThan} LIMIT 1`
                .get(
                  chatId,
                  userId,
                  ...cursorParams(cursorOf(oldestRaw)),
                ) !== undefined;
      } else {
        // A short page from an ordered read, inside the same snapshot, is
        // proof the conversation has no older message — the one condition
        // that licenses the surface to say a conversation begins here.
        endedBy = "beginning";
        hasOlder = false;
      }

      return {
        messages: kept,
        facts: {
          limit,
          returned: kept.length,
          hasOlder,
          olderCursor:
            hasOlder && oldestRaw !== undefined
              ? encodeHistoryCursor(cursorOf(oldestRaw))
              : null,
          messageCount: this.countMessages(chatId, userId),
          endedBy,
        },
      };
    });
  }

  /**
   * How many bytes of tool call each of these messages carries — the half of
   * a page's weight that is not in the message rows.
   *
   * `LENGTH()` over the STORED columns: no decryption, no Zod, one indexed
   * query, and the answer is already an upper bound on what the response will
   * carry. `TOOL_CALL_ROW_OVERHEAD` covers the fields that are not the
   * payload (id, tool name, status, timestamps, the JSON structure itself),
   * which are small and near-constant per row.
   */
  private toolCallBytesByMessage(messageIds: readonly string[]): Map<string, number> {
    const weights = new Map<string, number>();
    if (messageIds.length === 0) return weights;
    const holes = messageIds.map(() => "?").join(", ");
    const rows = this.#statement`SELECT message_id,
                SUM(LENGTH(input) + LENGTH(COALESCE(output, '')) + ${TOOL_CALL_ROW_OVERHEAD}) AS weight
         FROM tool_calls WHERE message_id IN (${holes}) GROUP BY message_id`
      .all(...messageIds) as ReadonlyArray<{ message_id?: unknown; weight?: unknown }>;
    for (const row of rows) {
      if (typeof row.message_id === "string") weights.set(row.message_id, Number(row.weight ?? 0));
    }
    return weights;
  }

  /** The tool calls belonging to exactly these messages, in declared order.
   * Re-scoped by chat AND user rather than trusting the ids it was handed:
   * the ids came from a scoped read, and defense-in-depth is what makes that
   * a property of the query rather than of the caller. */
  private toolCallsForMessages(
    messageIds: readonly string[],
    chatId: string,
    userId: string,
  ): readonly ToolCallRow[] {
    if (messageIds.length === 0) return [];
    const holes = messageIds.map(() => "?").join(", ");
    const rows = this.#statement`SELECT tc.* FROM tool_calls tc
         JOIN messages m ON tc.message_id = m.id
         JOIN chats c ON m.chat_id = c.id
         JOIN projects p ON c.project_id = p.id
         WHERE tc.message_id IN (${holes}) AND m.chat_id = ? AND p.user_id = ?
         ORDER BY tc.created_at ASC, tc.rowid ASC`
      .all(...messageIds, chatId, userId) as ReadonlyArray<Record<string, unknown>>;
    return rows.map((r) => parseToolCallRow(r, this.crypto, userId));
  }

  /** The newest `limit` rows of an ordered per-chat collection, returned
   * oldest-first. The conversation-wide collections travel with the TAIL
   * page; nothing about them is claimed on an older page. */
  private tailRows<T>(
    table: string,
    alias: string,
    orderColumn: string,
    chatId: string,
    userId: string,
    limit: number,
    parse: (row: Record<string, unknown>) => T,
  ): readonly T[] {
    const rows = this.#statement`SELECT ${alias}.* FROM ${table} ${alias}
         JOIN chats c ON ${alias}.chat_id = c.id
         JOIN projects p ON c.project_id = p.id
         WHERE ${alias}.chat_id = ? AND p.user_id = ?
         ORDER BY ${alias}.${orderColumn} DESC, ${alias}.rowid DESC LIMIT ?`
      .all(chatId, userId, limit) as Record<string, unknown>[];
    return rows.reverse().map(parse);
  }

  /**
   * THE CONVERSATION AT ITS TAIL — what opening a chat costs now.
   *
   * A 20,000-message conversation used to open by transferring all of it:
   * 75.1MB in 34,665ms against a 30,000ms client timeout, which is to say it
   * could not be opened at all. This returns the newest page plus the cursor
   * that reaches the page before it, so the cost of opening a conversation
   * stops being a function of how long it is.
   *
   * Returns null when the chat does not exist or is not owned — the same
   * answer for both, so existence is not disclosed by the shape of the reply.
   */
  getChatHistoryPage(
    chatId: string,
    userId: string,
    limit: number = serverConfig.chatHistoryTailRows,
  ): ChatHistoryPage | null {
    const chat = this.getChat(chatId, userId);
    if (!chat) return null;
    const { messages, facts } = this.pageMessagesBackwards(chatId, userId, limit, null);
    return {
      chat,
      messages,
      tool_calls: this.toolCallsForMessages(messages.map((m) => m.id), chatId, userId),
      metrics_snapshots: this.tailRows(
        "metrics_snapshots",
        "ms",
        "created_at",
        chatId,
        userId,
        limit,
        (r) => parseMetricsSnapshotRow(r, this.crypto, userId),
      ),
      timeline_refs: this.tailRows(
        "timeline_refs",
        "tr",
        // Declared on `timestamp` — the recorded event time, not the row's
        // insertion time. The same distinction `listTimelineRefs` makes.
        "timestamp",
        chatId,
        userId,
        limit,
        (r) => parseTimelineRefRow(r, this.crypto, userId),
      ),
      page: facts,
    };
  }

  /**
   * THE PAGE BEFORE A CURSOR — the delta the reader travelling backwards
   * receives.
   *
   * Messages and their tool calls, and nothing else: this page has nothing
   * true to say about the conversation's metrics snapshots or timeline refs,
   * and returning empty arrays for them would read as "there are none".
   */
  getChatMessagePage(
    chatId: string,
    userId: string,
    before: string,
    limit: number = serverConfig.chatHistoryTailRows,
  ): ChatMessagePage | null {
    if (this.getChat(chatId, userId) === null) return null;
    const cursor = decodeHistoryCursor(before);
    const { messages, facts } = this.pageMessagesBackwards(chatId, userId, limit, cursor);
    return {
      chat_id: chatId,
      messages,
      tool_calls: this.toolCallsForMessages(messages.map((m) => m.id), chatId, userId),
      page: facts,
    };
  }
}

/** The declared position of a raw message row read by the backwards walk. */
function cursorOf(raw: Record<string, unknown>): HistoryCursor {
  const createdAt = raw["created_at"];
  const rowid = raw["__row"];
  if (typeof createdAt !== "string" || typeof rowid !== "number") {
    // The same refusal `keysetValues` makes, for the same reason: a cursor
    // column that did not come back would silently truncate the walk, and a
    // transcript that quietly loses its oldest turns reports nothing.
    throw new WebError(
      `history page cursor is unreadable (created_at=${String(createdAt)}, rowid=${String(rowid)})`,
      "paging_cursor_unreadable",
    );
  }
  return { createdAt, rowid };
}

/**
 * Append one check-status transition to the timeline ledger.
 *
 * Module-level and exported because it now has TWO callers that must behave
 * identically: `DbClient.createAutoCheck` (the in-process door) and the async
 * facade, which runs the write on the writer THREAD and appends here, on the
 * main thread, for the chain-hash and causality reasons spelled out on
 * `createAutoCheckReturningTransition`. One implementation, so the two doors
 * cannot drift into recording different things — or into one of them
 * recording nothing.
 */
export function recordCheckStatusEvent(
  checkId: string,
  checkName: string,
  fromStatus: string | null,
  toStatus: string,
  projectId: string | null,
  chatId: string | null,
): void {
  try {
    const contentJson = JSON.stringify({ checkId, checkName, fromStatus, toStatus, projectId, chatId });
    getTimelineRecorder().recordEvent({
      eventType: "quality",
      description: `check:${checkName} ${fromStatus ?? "unrecorded"}→${toStatus}`,
      documents: [{
        name: TIMELINE_CHECK_STATUS_DOCUMENT,
        contentJson,
        contentDigest: sha256(contentJson),
      }],
    });
  } catch (err) {
    webWarn("db", "check-status event not recorded", () => ({
      checkName,
      toStatus,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

// Re-export schema types so route files can import everything from one place.
export type {
  ProjectRow,
  ChatRow,
  MessageRow,
  ToolCallRow,
  MetricsSnapshotRow,
  AutoCheckRow,
  TimelineRefRow,
  ProjectCreateDbInput,
  ChatCreateDbInput,
  MessageCreateInput,
  ToolCallCreateInput,
  MetricsSnapshotCreateInput,
  AutoCheckCreateDbInput,
  TimelineRefCreateInput,
  MessageMetadata,
  MessageMetadataUpdate,
  ProjectRenameInput,
  ChatRenameInput,
  ChatPinInput,
  ChatHistory,
  ChatHistoryPage,
  ChatMessagePage,
  HistoryPageFacts,
  ToolSettingRow,
  ToolSettingUpsertInput,
  UserPromptPrefRow,
  UserRow,
  UserRegisterInput,
  UserLoginInput,
} from "./schema.ts";

export { SCHEMA_VERSION_LATEST, MESSAGE_METADATA } from "./schema.ts";
