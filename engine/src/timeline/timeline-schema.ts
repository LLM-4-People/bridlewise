/**
 * Timeline SQLite schema (S4-aligned, harness-owned, provider-neutral).
 *
 * Implements the physical structures from
 * `docs/research/storage/s4-storage-qualification/SCHEMA-DESIGN.md`:
 *
 * 1. `schema_migrations` — forward-only migration identity ledger.
 * 2. `event_log` — single canonical append-only event envelope.
 * 3. `event_documents` — redacted source facts (request, response, headers,
 * preimage/postimage, payloads).
 * 4. `event_edges` — typed evidence graph (causal, part-of, produced...).
 * 5. `timeline_projection` — rebuildable read model for browsing.
 * 6. `projection_offsets` — source sequence/chain MAC for stale detection.
 *
 * Append-only enforcement is via triggers that reject UPDATE and DELETE on
 * `event_log`, `event_documents` and `event_edges` — see
 * `APPEND_ONLY_TRIGGERS` below, which is the ONE authority for their text and
 * is consumed by the migrations AND by the startup assertion in
 * `timeline-store.ts`. Foreign keys are enabled on every connection. WAL mode plus
 * synchronous=NORMAL with a 1000ms checkpoint window is the durability
 * baseline — the value and the window are owned by `timeline-config.ts`
 * (`DEFAULT_TIMELINE_SYNCHRONOUS`, `DEFAULT_DURABILITY_WINDOW_MS`), which
 * states in numbers what the setting trades and what it does not. It does not
 * change what is written, only when the bytes are flushed: append-only
 * enforcement, foreign keys and the chain hash are unaffected.
 */

import { InputError } from "../kernel/errors.ts";

/**
 * ── THE APPEND-ONLY RULE, AS THE STORAGE ENGINE ENFORCES IT ────────────────
 *
 * This table is the ONE authority for the append-only triggers: the
 * migrations create them from it, and the startup assertion in
 * `timeline-store.ts` (`assertAppendOnlyTriggers`) reads the live schema and
 * compares it against `createSql` here. Neither retypes the other's text, so
 * the rule the engine holds and the rule the assertion checks cannot drift.
 *
 * WHY THE MESSAGE IS A SENTENCE. Whoever trips one of these is the person who
 * most needs to read the rule: a new module that reached past the facade, a
 * migration written years from now, someone at the `sqlite3` prompt. An abort
 * saying "constraint failed" teaches nothing; an abort that names the rule AND
 * the correct move ("append a new event") teaches the whole design in the one
 * moment the reader is paying attention.
 *
 * NO APOSTROPHES IN A MESSAGE. It is embedded in a single-quoted SQL string
 * literal, and an apostrophe would have to be doubled — a quoting rule the
 * next author would have to know about. The generator asserts their absence
 * rather than escaping, so the constraint is visible instead of hidden.
 *
 * `timeline_projection` and `projection_offsets` are deliberately NOT here.
 * They are a REBUILDABLE read model derived from `event_log`; deleting them is
 * how `rebuildProjections()` works, and protecting derived rows would freeze a
 * cache while protecting nothing that is evidence.
 */
type AppendOnlyOperation = "UPDATE" | "DELETE";

type AppendOnlyTrigger = Readonly<{
  name: string;
  table: string;
  operation: AppendOnlyOperation;
  message: string;
  /**
   * The trigger EXACTLY as SQLite stores it in `sqlite_master.sql`.
   *
   * SQLite normalises a `CREATE TRIGGER IF NOT EXISTS …;` statement when it
   * records it: the `IF NOT EXISTS` clause and the trailing semicolon are
   * dropped, and nothing else is touched. So this string — built without
   * either — is byte-identical to what the assertion reads back, and the
   * comparison needs no normalisation step that could paper over a real edit.
   * Probed rather than assumed; `append-only-enforcement.test.ts` asserts the
   * identity against a live database so a future SQLite that normalises
   * differently fails here instead of silently disabling the check.
   */
  createSql: string;
}>;

function appendOnlyTrigger(table: string, operation: AppendOnlyOperation, message: string): AppendOnlyTrigger {
  if (message.includes("'")) {
    throw new InputError(
      `append-only trigger message for ${table} contains an apostrophe, which would break the SQL string literal it is embedded in: ${message}`,
      "timeline_append_only_message_unquotable",
    );
  }
  const name = `${table}_no_${operation.toLowerCase()}`;
  return Object.freeze({
    name,
    table,
    operation,
    message,
    createSql: `CREATE TRIGGER ${name}\nBEFORE ${operation} ON ${table}\nBEGIN\n  SELECT RAISE(ABORT, '${message}');\nEND`,
  });
}

export const APPEND_ONLY_TRIGGERS: readonly AppendOnlyTrigger[] = Object.freeze([
  appendOnlyTrigger(
    "event_log",
    "UPDATE",
    "the ledger is append-only: a recorded event cannot be altered. "
      + "To correct the record, append a new event that states the correction.",
  ),
  appendOnlyTrigger(
    "event_log",
    "DELETE",
    "the ledger is append-only: a recorded event cannot be removed. "
      + "To undo an effect, reverse it in the world and append an event recording the reversal.",
  ),
  appendOnlyTrigger(
    "event_documents",
    "UPDATE",
    "the ledger is append-only: the evidence attached to a recorded event cannot be altered. "
      + "Append a new event carrying the corrected evidence.",
  ),
  appendOnlyTrigger(
    "event_documents",
    "DELETE",
    "the ledger is append-only: the evidence attached to a recorded event cannot be removed. "
      + "It is what makes the event checkable.",
  ),
  appendOnlyTrigger(
    "event_edges",
    "UPDATE",
    "the ledger is append-only: a recorded causal link cannot be altered. "
      + "Append a new event carrying the corrected links.",
  ),
  appendOnlyTrigger(
    "event_edges",
    "DELETE",
    "the ledger is append-only: a recorded causal link cannot be removed. "
      + "It is how an effect is traced back to what caused it.",
  ),
]);

/**
 * The triggers as a migration body: dropped and recreated, so a ledger created
 * before this text existed converges on it instead of keeping whatever it was
 * first given. `IF NOT EXISTS` is deliberately absent — a create that silently
 * does nothing is how two ledgers end up enforcing two different rules.
 */
const APPEND_ONLY_TRIGGER_SQL = APPEND_ONLY_TRIGGERS
  .map((t) => `DROP TRIGGER IF EXISTS ${t.name};\n${t.createSql};`)
  .join("\n\n");

export const MIGRATION_1_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  migration_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS event_log (
  event_id TEXT PRIMARY KEY NOT NULL,
  ledger_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  record_kind TEXT NOT NULL,
  event_type TEXT NOT NULL,
  effect_kind TEXT,
  effect_id TEXT,
  observation_id TEXT,
  outcome TEXT,
  wall_time TEXT NOT NULL,
  monotonic_ns TEXT,
  trace_id TEXT,
  span_id TEXT,
  parent_event_id TEXT REFERENCES event_log(event_id),
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_role TEXT,
  run_id TEXT,
  session_id TEXT,
  turn_id TEXT,
  message_id TEXT,
  task_id TEXT,
  attempt_id TEXT,
  agent_id TEXT,
  parent_effect_id TEXT,
  intent_hash TEXT,
  result_hash TEXT,
  evidence_hash TEXT,
  error_category TEXT,
  error_code TEXT,
  error_message TEXT,
  error_retryable INTEGER,
  description TEXT NOT NULL,
  payload_ref TEXT,
  payload_digest TEXT,
  previous_chain_hash TEXT NOT NULL,
  chain_hash TEXT NOT NULL,
  UNIQUE (ledger_id, sequence)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_event_log_ledger_seq ON event_log (ledger_id, sequence);
CREATE INDEX IF NOT EXISTS idx_event_log_run ON event_log (run_id);
CREATE INDEX IF NOT EXISTS idx_event_log_turn ON event_log (turn_id);
CREATE INDEX IF NOT EXISTS idx_event_log_agent ON event_log (agent_id);
CREATE INDEX IF NOT EXISTS idx_event_log_task ON event_log (task_id);
CREATE INDEX IF NOT EXISTS idx_event_log_event_type ON event_log (event_type);
CREATE INDEX IF NOT EXISTS idx_event_log_record_kind ON event_log (record_kind);
CREATE INDEX IF NOT EXISTS idx_event_log_effect_id ON event_log (effect_id);
CREATE INDEX IF NOT EXISTS idx_event_log_wall_time ON event_log (wall_time);
CREATE INDEX IF NOT EXISTS idx_event_log_parent ON event_log (parent_event_id);

CREATE TABLE IF NOT EXISTS event_documents (
  doc_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL REFERENCES event_log(event_id),
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  content_json TEXT,
  ordered_json TEXT,
  content_digest TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_event_documents_event ON event_documents (event_id);
CREATE INDEX IF NOT EXISTS idx_event_documents_name ON event_documents (name);

CREATE TABLE IF NOT EXISTS event_edges (
  edge_id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_event_id TEXT NOT NULL REFERENCES event_log(event_id),
  edge_type TEXT NOT NULL,
  target_event_id TEXT REFERENCES event_log(event_id),
  target_kind TEXT,
  target_id TEXT,
  position INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX IF NOT EXISTS idx_event_edges_source ON event_edges (source_event_id);
CREATE INDEX IF NOT EXISTS idx_event_edges_target ON event_edges (target_event_id);
CREATE INDEX IF NOT EXISTS idx_event_edges_type ON event_edges (edge_type);

${APPEND_ONLY_TRIGGER_SQL}
`;

export const MIGRATION_2_SQL = `
CREATE TABLE IF NOT EXISTS timeline_projection (
  projection_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL REFERENCES event_log(event_id),
  ledger_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  wall_time TEXT NOT NULL,
  record_kind TEXT NOT NULL,
  event_type TEXT NOT NULL,
  run_id TEXT,
  turn_id TEXT,
  agent_id TEXT,
  task_id TEXT,
  effect_id TEXT,
  outcome TEXT,
  description TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_timeline_projection_ledger_seq ON timeline_projection (ledger_id, sequence);
CREATE INDEX IF NOT EXISTS idx_timeline_projection_run ON timeline_projection (run_id);
CREATE INDEX IF NOT EXISTS idx_timeline_projection_turn ON timeline_projection (turn_id);
CREATE INDEX IF NOT EXISTS idx_timeline_projection_agent ON timeline_projection (agent_id);
CREATE INDEX IF NOT EXISTS idx_timeline_projection_event_type ON timeline_projection (event_type);

CREATE TABLE IF NOT EXISTS projection_offsets (
  projection_name TEXT PRIMARY KEY,
  source_ledger_id TEXT NOT NULL,
  source_sequence INTEGER NOT NULL,
  chain_mac TEXT NOT NULL
) STRICT;
`;

/**
 * Columns of `event_log` that the browsing read model deliberately does NOT
 * carry.
 *
 * SCHEMA-DESIGN.md §5: `timeline_projection` is a *redacted* rebuildable read
 * model — it holds no raw payload reference and no ciphertext metadata. These
 * are the chain-integrity and content-address columns, which belong to the
 * forensic table and answer no browsing question.
 *
 * This list is the ONLY authored part of the projection's column set. A
 * prevention test walks the live schema and requires every OTHER `event_log`
 * column to exist in `timeline_projection`, so a column added to the ledger
 * either reaches the read model or appears here as a visible, reviewed
 * exclusion. That is what stops the read model from quietly going lossy again:
 * it was missing `actor_kind`, `actor_id`, `actor_role`, `trace_id`,
 * `span_id`, `parent_event_id` and all four `error_*` columns — precisely the
 * causality and failure detail a browsing model exists to show.
 */
export const PROJECTION_EXCLUDED_EVENT_COLUMNS: readonly string[] = Object.freeze([
  "previous_chain_hash",
  "chain_hash",
  "intent_hash",
  "result_hash",
  "evidence_hash",
  "payload_ref",
  "payload_digest",
]);

/**
 * Columns carried by `timeline_projection`, in insert order. Shared by the
 * migration, the per-append insert, and the rebuild so the three cannot
 * disagree about the shape of the read model.
 */
export const PROJECTION_COLUMNS: readonly string[] = Object.freeze([
  "event_id",
  "ledger_id",
  "sequence",
  "wall_time",
  "monotonic_ns",
  "record_kind",
  "event_type",
  "effect_kind",
  "effect_id",
  "observation_id",
  "outcome",
  "trace_id",
  "span_id",
  "parent_event_id",
  "actor_kind",
  "actor_id",
  "actor_role",
  "run_id",
  "session_id",
  "turn_id",
  "message_id",
  "task_id",
  "attempt_id",
  "agent_id",
  "parent_effect_id",
  "error_category",
  "error_code",
  "error_message",
  "error_retryable",
  "description",
]);

const PROJECTION_COLUMN_LIST = PROJECTION_COLUMNS.join(", ");

/**
 * Migration 3 — the read model carries the whole browsing surface.
 *
 * `timeline_projection` shipped with 13 of the ledger's columns and dropped
 * the rest, so anything reading the projection instead of `event_log` saw a
 * timeline with no actor attribution, no trace/span identity, no parent event
 * and no error detail. Rebuilt here from `event_log`, which is the authority,
 * so existing ledgers gain the full surface without a separate backfill step.
 */
// Not exported. Migrations 1 and 2 predate the dead-export baseline and are
// grandfathered there; 3 and 4 are consumed only by the MIGRATIONS table
// below, so exporting them would add a dead export rather than remove one.
const MIGRATION_3_SQL = `
DROP TABLE IF EXISTS timeline_projection;

CREATE TABLE timeline_projection (
  projection_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL REFERENCES event_log(event_id),
  ledger_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  wall_time TEXT NOT NULL,
  monotonic_ns TEXT,
  record_kind TEXT NOT NULL,
  event_type TEXT NOT NULL,
  effect_kind TEXT,
  effect_id TEXT,
  observation_id TEXT,
  outcome TEXT,
  trace_id TEXT,
  span_id TEXT,
  parent_event_id TEXT,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_role TEXT,
  run_id TEXT,
  session_id TEXT,
  turn_id TEXT,
  message_id TEXT,
  task_id TEXT,
  attempt_id TEXT,
  agent_id TEXT,
  parent_effect_id TEXT,
  error_category TEXT,
  error_code TEXT,
  error_message TEXT,
  error_retryable INTEGER,
  description TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_timeline_projection_ledger_seq ON timeline_projection (ledger_id, sequence);
CREATE INDEX IF NOT EXISTS idx_timeline_projection_run ON timeline_projection (run_id);
CREATE INDEX IF NOT EXISTS idx_timeline_projection_turn ON timeline_projection (turn_id);
CREATE INDEX IF NOT EXISTS idx_timeline_projection_agent ON timeline_projection (agent_id);
CREATE INDEX IF NOT EXISTS idx_timeline_projection_event_type ON timeline_projection (event_type);
CREATE INDEX IF NOT EXISTS idx_timeline_projection_trace ON timeline_projection (trace_id);
CREATE INDEX IF NOT EXISTS idx_timeline_projection_parent ON timeline_projection (parent_event_id);

INSERT INTO timeline_projection (${PROJECTION_COLUMN_LIST})
SELECT ${PROJECTION_COLUMN_LIST} FROM event_log ORDER BY ledger_id, sequence;
`;

/**
 * Migration 4 — `event_log` is indexed for the trace filter it now answers.
 *
 * `timeline_projection` gained `idx_timeline_projection_trace` in migration 3,
 * but every read in `timeline-store.ts` (`doQuery`, `count`, `verifyChain`)
 * goes to `event_log`, which had no trace index at all. A trace filter without
 * one is a full ledger scan per call.
 *
 * COMPOSITE, AND IN THIS ORDER, rather than the bare `(trace_id)` the other
 * correlation filters use. The query the filter actually produces is
 * `WHERE ledger_id = ? AND trace_id = ? [AND sequence > ?] ORDER BY sequence`:
 * two equality columns, then a range on `sequence` that is also the sort key
 * and the keyset-pagination predicate. Leading with `(ledger_id, trace_id)`
 * makes both equalities seekable and leaves `sequence` ordered WITHIN the
 * matched span, so the cursor page boundary and the ORDER BY are both served
 * by the index and neither needs a sort. A single-column `(trace_id)` index
 * would satisfy the filter and then force a temp B-tree sort for the ordering
 * — which is where the cost of a paginated trace read lives.
 */
const MIGRATION_4_SQL = `
CREATE INDEX IF NOT EXISTS idx_event_log_ledger_trace_seq ON event_log (ledger_id, trace_id, sequence);
`;

/**
 * Migration 5 — the spectrum aggregation reads its four columns from one
 * covering index.
 *
 * `spectrum()` (the SWEEP density read) visits either a run-bounded slice
 * (rides `idx_event_log_run`, already present) or a TIME-bounded slice of the
 * whole file: `SELECT wall_time, event_type, outcome, error_code FROM
 * event_log [WHERE wall_time >= ? AND wall_time <= ?]`. The bare
 * `idx_event_log_wall_time` would serve the range but then fetch every
 * matched table row for the other three columns — for the whole-file case
 * that is a row fetch per event in the ledger, per read. Leading with
 * `wall_time` keeps the range seekable; carrying `event_type`, `outcome` and
 * `error_code` makes the statement an index-only pass (COVERING in the plan,
 * asserted by timeline-spectrum.test.ts), so the read touches no table row
 * at any scope.
 */
const MIGRATION_5_SQL = `
CREATE INDEX IF NOT EXISTS idx_event_log_spectrum ON event_log (wall_time, event_type, outcome, error_code);
`;

/**
 * Migration 6 — the append-only rule states itself, on every ledger.
 *
 * The triggers have always been there; what they SAID was
 * `event_log is append-only: updates are forbidden` — a table name and a
 * prohibition. Whoever trips a trigger is exactly the person who needs the
 * rule and the correct move, and they get one line to read it in.
 *
 * DROP-then-CREATE rather than `CREATE … IF NOT EXISTS`, because the triggers
 * already exist on every ledger in the field and an `IF NOT EXISTS` create
 * would leave every one of them saying the old thing forever. Migration 1
 * builds from the same `APPEND_ONLY_TRIGGERS` table, so a ledger created after
 * this change gets the same text one migration earlier and this one is a
 * no-op re-issue — that is the intended shape, not a redundancy: the authority
 * is the table, and both migrations are ways of getting the file to agree
 * with it.
 *
 * A ledger is NOT unprotected between the drop and the create: the whole
 * migration body runs inside the BEGIN/COMMIT that `runMigrations` wraps
 * around it, and the ledger has a single writer.
 */
const MIGRATION_6_SQL = APPEND_ONLY_TRIGGER_SQL;

/**
 * Migration 7 — `event_log` is indexed for the event-type fold queries every
 * run start pays.
 *
 * The fold reads (the compose state, both rewind folds, the memory store
 * reload) all issue `WHERE ledger_id = ? AND event_type = ? [AND sequence >
 * ?] ORDER BY sequence`: two equality columns, then the sequence range that
 * is also the sort key — the same shape migration 4 fixed for `trace_id`.
 * Without a composite index the planner serves the ORDER BY from
 * `idx_event_log_ledger_seq` and filters `event_type` row by row, which is a
 * walk of the WHOLE ledger per fold: measured on a 1.44M-event dev ledger at
 * ~230-350ms per query, three to four of them per run start, so every start
 * paid a ~1.1s constant tax that grew with the ledger — misread for rounds
 * as "long chats start slowly" because a long conversation is also what
 * grows the ledger fastest. Leading with `(ledger_id, event_type)` makes
 * both equalities seekable and leaves `sequence` ordered within the matched
 * span, so the fold, the cursor and the ORDER BY are all served by the index
 * and none needs a sort.
 */
const MIGRATION_7_SQL = `
CREATE INDEX IF NOT EXISTS idx_event_log_ledger_type_seq ON event_log (ledger_id, event_type, sequence);
`;

/** Each ledger owns an independent rebuild position for a projection. */
const MIGRATION_8_SQL = `
ALTER TABLE projection_offsets RENAME TO projection_offsets_v7;
CREATE TABLE projection_offsets (
  projection_name TEXT NOT NULL,
  source_ledger_id TEXT NOT NULL,
  source_sequence INTEGER NOT NULL,
  chain_mac TEXT NOT NULL,
  PRIMARY KEY (projection_name, source_ledger_id)
) STRICT;
INSERT INTO projection_offsets SELECT projection_name, source_ledger_id, source_sequence, chain_mac FROM projection_offsets_v7;
DROP TABLE projection_offsets_v7;
`;

/**
 * The sealed originals' own append-only rule (migration 9 creates the table,
 * so migration 1 cannot carry it). The store asserts these beside
 * `APPEND_ONLY_TRIGGERS` at every open: {@link ENFORCED_APPEND_ONLY_TRIGGERS}.
 */
const SEALED_ORIGINAL_TRIGGERS: readonly AppendOnlyTrigger[] = Object.freeze([
  appendOnlyTrigger(
    "event_document_originals",
    "UPDATE",
    "the ledger is append-only: the sealed original of a recorded document cannot be altered. "
      + "Append a new event carrying the corrected evidence.",
  ),
  appendOnlyTrigger(
    "event_document_originals",
    "DELETE",
    "the ledger is append-only: the sealed original of a recorded document cannot be removed. "
      + "It is what a rollback restores exactly.",
  ),
]);

/** The seal key's check value is recorded once and never changed (migration 10). */
const SEAL_KEY_CHECK_TRIGGERS: readonly AppendOnlyTrigger[] = Object.freeze([
  appendOnlyTrigger(
    "timeline_seal_key_check",
    "UPDATE",
    "the ledger is append-only: the check value of the key its originals are sealed under cannot be changed. "
      + "A ledger is sealed under one key for its whole life.",
  ),
  appendOnlyTrigger(
    "timeline_seal_key_check",
    "DELETE",
    "the ledger is append-only: the check value of the key its originals are sealed under cannot be removed. "
      + "It is how a second key is refused at open.",
  ),
]);

/** Every append-only trigger a ledger must carry: the store refuses to open without all of them. */
export const ENFORCED_APPEND_ONLY_TRIGGERS: readonly AppendOnlyTrigger[] = Object.freeze([...APPEND_ONLY_TRIGGERS, ...SEALED_ORIGINAL_TRIGGERS, ...SEAL_KEY_CHECK_TRIGGERS]);

/**
 * Migration 9 — a document the ledger could not store as given keeps its
 * original, SEALED.
 *
 * The store writes every document through the operational projection
 * (`projectPayload` in timeline-store.ts): a detected secret is masked in the
 * public row. A document whose projection differs from what was appended is
 * `protected`: its row carries the digest of the ORIGINAL (`original_digest`),
 * and the original itself is kept only encrypted, in
 * `event_document_originals` (AES-256-GCM under the store key, bound to the
 * ledger, event and sequence; chunked at the forensic input bound). That is
 * what a rollback restores from, so a file whose pre-image held a secret is
 * restored exactly while no file of the ledger holds the secret in the clear
 * (CRED-F12). Every existing document was stored as given (`exact`).
 *
 * The CHECKs keep the two facts in step: a protected row always names its
 * original's digest, an exact row never does.
 */
const MIGRATION_9_SQL = `
ALTER TABLE event_documents ADD COLUMN projection_disposition TEXT NOT NULL DEFAULT 'exact' CHECK (projection_disposition IN ('exact', 'protected'));
ALTER TABLE event_documents ADD COLUMN original_digest TEXT CHECK ((projection_disposition = 'protected') = (original_digest IS NOT NULL));
CREATE TABLE event_document_originals (
  doc_id INTEGER NOT NULL REFERENCES event_documents(doc_id),
  chunk INTEGER NOT NULL CHECK (chunk >= 0),
  sealed TEXT NOT NULL,
  PRIMARY KEY (doc_id, chunk)
) STRICT;
${SEALED_ORIGINAL_TRIGGERS.map((trigger) => `${trigger.createSql};`).join("\n")}
`;

/**
 * Migration 10 — WHICH KEY the originals are sealed under (a3-design H2).
 * One row, written at the ledger's first seal: the key's check value
 * (`computeKeyCheckValue`, never the key). Every open compares it with the
 * key in hand and refuses another (`timeline_seal_key_mismatch`), so a ledger
 * never collects seals under two keys. Append-only like the rest.
 */
const MIGRATION_10_SQL = `
CREATE TABLE timeline_seal_key_check (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  check_value TEXT NOT NULL CHECK (length(check_value) = 64)
) STRICT;
${SEAL_KEY_CHECK_TRIGGERS.map((trigger) => `${trigger.createSql};`).join("\n")}
`;

/**
 * Migration 11 — THE EFFECT LINEAGE IS SEEKABLE (SCALE-CR1 C5).
 *
 * Every paired effect asks the ledger twice whether its effect already has an
 * intent and a terminal (`resolveLineage` in timeline-store.ts), and boot
 * reconciliation asks which intents have no terminal. Without an index that
 * leads with all three equalities the planner chose
 * `idx_event_log_ledger_type_seq (ledger_id=?)` — a walk of the WHOLE ledger
 * (one ledger id per file) — measured at 147-164 s per lookup on a 10 GB
 * ledger, synchronously, twice per provider call.
 *
 * The column order serves the three shapes from one index: the intent and
 * terminal lookups (three equalities) and the pending-intent scan (the outer
 * `ledger_id, record_kind` range, the inner terminal probe). PARTIAL over
 * `effect_id IS NOT NULL`: 99.7% of real events carry no effect, so the index
 * holds only the paired rows (every `effect_id = ?` term implies the
 * predicate, so the planner may use it). `engine/test/timeline/query-plans.test.ts`
 * holds the planner to it.
 */
const MIGRATION_11_SQL = `
CREATE INDEX IF NOT EXISTS idx_event_log_effect_lineage ON event_log (ledger_id, record_kind, effect_id) WHERE effect_id IS NOT NULL;
`;

export const ALL_MIGRATIONS = [
  Object.freeze({ id: 1, name: "timeline-source-tables-v1", sql: MIGRATION_1_SQL }),
  Object.freeze({ id: 2, name: "timeline-projections-v1", sql: MIGRATION_2_SQL }),
  Object.freeze({ id: 3, name: "timeline-projection-full-surface-v1", sql: MIGRATION_3_SQL }),
  Object.freeze({ id: 4, name: "timeline-event-log-trace-index-v1", sql: MIGRATION_4_SQL }),
  Object.freeze({ id: 5, name: "timeline-event-log-spectrum-index-v1", sql: MIGRATION_5_SQL }),
  Object.freeze({ id: 6, name: "timeline-append-only-triggers-plain-words-v1", sql: MIGRATION_6_SQL }),
  Object.freeze({ id: 7, name: "timeline-event-log-type-fold-index-v1", sql: MIGRATION_7_SQL }),
  Object.freeze({ id: 8, name: "timeline-projection-offset-ledger-key-v1", sql: MIGRATION_8_SQL }),
  Object.freeze({ id: 9, name: "timeline-document-sealed-originals-v1", sql: MIGRATION_9_SQL }),
  Object.freeze({ id: 10, name: "timeline-seal-key-check-v1", sql: MIGRATION_10_SQL }),
  Object.freeze({ id: 11, name: "timeline-effect-lineage-index-v1", sql: MIGRATION_11_SQL }),
] as const;

export const MIGRATION_NAMES: readonly string[] = ALL_MIGRATIONS.map((m) => m.name);
