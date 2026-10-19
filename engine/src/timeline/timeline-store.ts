import { checkpointSqlite, establishWalJournal } from "../filesystem/sqlite-wal.ts";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { admitDatabaseProvenance } from "../filesystem/database-provenance.ts";
import type { KeyObject } from "node:crypto";
import { registerCiphertextProbe, resolvePersistedKey } from "../filesystem/persisted-key.ts";
import { createTimelineSealing, type TimelineSealing } from "./timeline-sealing.ts";
import { SPECTRUM_MAX_BINS } from "../../../shared/constants.ts";

import { extractErrorMessage, InputError, SecurityError } from "../kernel/errors.ts";
import { bestEffort } from "../shared/best-effort.ts";
import { guarded } from "../process/fault-policy.ts";
import { auditEvent } from "../shared/debug/debug-system.ts";
import { DEFAULT_TIMELINE_QUERY_LIMIT } from "../kernel/config-contracts.ts";
import { deepFreeze, sha256 } from "../kernel/integrity.ts";
// THE SAME DETECTOR THE EGRESS USES, ON THE SAME BYTES. See
// `projectPayload` below for why the ledger consults it at all.
import { redactForLLMContext, detectProtocolIdentitySensitiveSpans } from "../privacy/redaction-engine.ts";
import { redactOperationalText } from "../privacy/operational-redaction.ts";
import { DEFAULT_PRIVACY_POLICY } from "../privacy/privacy-policy.ts";
import { redactSecretFileText } from "../privacy/secret-files.ts";
import {
  isTimelineEdgeType,
  isTimelineEventType,
  isTimelineOutcome,
  TIMELINE_DOMAIN,
  TIMELINE_SCHEMA_VERSION,
  type EventLedgerStoragePort,
  type TimelineActor,
  type TimelineChainVerification,
  type TimelineCorrelation,
  type TimelineDocumentInput,
  type TimelineDocumentRecord,
  type TimelineEdgeInput,
  type TimelineEdgeRecord,
  type TimelineErrorSummary,
  type TimelineEventRecord,
  type TimelineEventSummary,
  type TimelineEventType,
  type TimelineIntentInput,
  type TimelineObservationInput,
  type TimelineOccurrenceCounts,
  type TimelineRecordingGapCounts,
  type TimelineStandaloneEventInput,
  type TimelineStoreOptions,
  type TimelineTerminalInput,
  type TimelineFileEffectFact,
  type TimelineFileEffectFacts,
  type TimelineFileEffectFactsFilter,
  type TimelineCheckStatusFact,
  type TimelineCheckStatusFacts,
  type TimelineCheckStatusFactsFilter,
  type TimelineSpectrum,
  type TimelineSpectrumFilter,
  type TimelineRunActivitySummary,
  type TimelineRunTokenUsage,
  TIMELINE_FILE_EFFECT_DOCUMENT,
  TIMELINE_PREIMAGE_DOCUMENT,
  type TimelineOriginalPurpose,
  TIMELINE_TOKEN_USAGE_DOCUMENT,
  TIMELINE_CHECK_STATUS_DOCUMENT,
  decodeTokenUsageDocument,
} from "./timeline-types.ts";
import { ALL_MIGRATIONS, ENFORCED_APPEND_ONLY_TRIGGERS, PROJECTION_COLUMNS } from "./timeline-schema.ts";
import {
  assertTerminalProvenanceAbsent,
  computeChainHash,
  CORRELATION_FIELD_NAMES,
  DECIMAL_SEQUENCE_PATTERN,
  formatSequence,
  generateIdentifier,
  GENESIS_SEQUENCE,
  HEX_64_PATTERN,
  IDENTIFIER_PATTERN,
  MAXIMUM_CORRELATION_FIELDS,
  MAXIMUM_DESCRIPTION_BYTES,
  MAXIMUM_IDENTIFIER_CHARACTERS,
  nextLedgerSequence,
  snapshotLedgerInput,
  assertTimelineDocument,
  assertTimelineDocumentByteLimit,
  LedgerPersistenceUncertainError,
  ZERO_CHAIN_HASH,
} from "./ledger-primitives.ts";

type Stmt = ReturnType<DatabaseSync["prepare"]>;

/** Preserve SQLite's complete signed int64 range at every read boundary. */
function prepareStatement(db: DatabaseSync, sql: string): Stmt {
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  return statement;
}

type WriteState = { active: boolean; uncertain: boolean };

function assertWritable(state: WriteState): void {
  if (state.uncertain) throw new LedgerPersistenceUncertainError();
  if (state.active) throw new SecurityError("Timeline mutation is reentrant", "timeline_mutation_reentrant");
}

/** One synchronous transaction owner for event appends and projection rebuilds. */
function writeTransaction<T>(db: DatabaseSync, state: WriteState, work: () => T): T {
  assertWritable(state);
  state.active = true;
  let began = false;
  let commitAttempted = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    began = true;
    const result = work();
    commitAttempted = true;
    db.exec("COMMIT");
    return result;
  } catch (error) {
    // Cleanup or state inspection reports centrally with no caught data; its
    // failure cannot establish that retry is safe.
    const aborted = bestEffort(() => {
      if (!db.isTransaction) return !commitAttempted;
      // A failed BEGIN must not roll back somebody else's transaction.
      if (!began) return false;
      db.exec("ROLLBACK");
      return !db.isTransaction;
    }) ?? false;
    if (!aborted) {
      state.uncertain = true;
      throw new LedgerPersistenceUncertainError();
    }
    throw error;
  } finally {
    state.active = false;
  }
}


type Clock = () => string;

type TimelineStoreConfig = Readonly<{
  maxDocumentBytes?: number;
  maxDocuments?: number;
  maxEdges?: number;
  sqliteCacheSize?: number;
  sqliteBusyTimeoutMs?: number;
  /** How long committed events may sit unsynced, in ms. See
   * `DEFAULT_DURABILITY_WINDOW_MS` — this is the bound that makes
   * `synchronous=NORMAL` a stated trade rather than an assumed one. 0
   * disables the timer. */
  durabilityWindowMs?: number;
  /** Rows a query without a `limit` returns (`timeline.queryDefaultLimit`). */
  queryDefaultLimit?: number;
}>;

type TimelineLimits = Readonly<{
  maxDocumentBytes: number;
  maxDocuments: number;
  maxEdges: number;
}>;

const DEFAULT_CLOCK: Clock = () => new Date().toISOString();

import {
  DEFAULT_DURABILITY_WINDOW_MS,
  DEFAULT_MAXIMUM_DOCUMENT_BYTES,
  DEFAULT_MAXIMUM_DOCUMENTS,
  DEFAULT_MAXIMUM_EDGES,
  DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
  DEFAULT_SQLITE_CACHE_SIZE,
  DEFAULT_TIMELINE_SYNCHRONOUS,
  QUERY_BATCH_SIZE,
} from "./timeline-config.ts";
const MAXIMUM_DOCUMENT_BYTES = DEFAULT_MAXIMUM_DOCUMENT_BYTES;
const MAXIMUM_DOCUMENTS = DEFAULT_MAXIMUM_DOCUMENTS;
const MAXIMUM_EDGES = DEFAULT_MAXIMUM_EDGES;

/** Chunk size for batched `IN (...)` lookups in doQuery (stays under SQLite's variable limit). */

export type { EventLedgerStoragePort };

/**
 * THE LINEAGE STATEMENTS — the one text of each question the store asks about
 * an effect's pairing, exported so the query-plan test plans exactly what the
 * store runs (`engine/test/timeline/query-plans.test.ts`). Each is served by
 * migration 11's `idx_event_log_effect_lineage` (SCALE-CR1 C5): without it the
 * planner walked the whole ledger per lookup.
 */
export const TIMELINE_LINEAGE_STATEMENTS = Object.freeze({
  intent: "SELECT * FROM event_log WHERE ledger_id = ? AND record_kind = 'intent' AND effect_id = ? LIMIT 2",
  terminal: "SELECT event_id FROM event_log WHERE ledger_id = ? AND record_kind = 'terminal' AND effect_id = ? LIMIT 1",
  pendingIntents: "SELECT * FROM event_log AS i WHERE i.ledger_id = ? AND i.record_kind = 'intent' AND i.effect_id IS NOT NULL " +
    "AND NOT EXISTS (SELECT 1 FROM event_log AS t WHERE t.ledger_id = i.ledger_id AND t.record_kind = 'terminal' AND t.effect_id = i.effect_id)",
});

/**
 * THE MIGRATIONS A LEDGER FILE STILL OWES (SCALE-CR1 C10), read without
 * writing: the names of the known migrations its registry does not hold. A
 * file that does not exist yet, or holds no ledger, owes none here — opening
 * it creates the current schema in milliseconds. Read-only, so a host can
 * decide BEFORE opening the store whether the open would block (a migration
 * over a large ledger: migration 9 measured 488.8 s on a 10 GB ledger).
 */
export function pendingTimelineMigrations(path: string): readonly string[] {
  if (!existsSync(path)) return Object.freeze([]);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    // Admitted like every other open (a process under test never reads a real ledger's schema either).
    admitDatabaseProvenance(db, path, "read");
    const tables = new Set((prepareStatement(db, "SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[]).map((row) => String(row.name)));
    if (!tables.has("schema_migrations") || !tables.has("event_log")) return Object.freeze([]);
    const applied = new Set((prepareStatement(db, "SELECT name FROM schema_migrations").all() as Row[]).map((row) => String(row.name)));
    return Object.freeze(ALL_MIGRATIONS.filter((migration) => !applied.has(migration.name)).map((migration) => migration.name));
  } finally { db.close(); }
}

/**
 * Run a ledger file's pending migrations on a connection of its own and close
 * it (SCALE-CR1 C10): the same runner, transaction and refusals as the
 * store's open, for a host that runs them OFF its serving thread (the web
 * server's migration worker) and opens the store once they are done. Returns
 * the names it applied.
 */
export function migrateTimelineFile(path: string, options: Readonly<{ sqliteBusyTimeoutMs?: number; clock?: Clock }> = {}): readonly string[] {
  const owed = pendingTimelineMigrations(path);
  if (owed.length === 0) return owed;
  const db = new DatabaseSync(path);
  try {
    openLedgerConnection(db, path, DEFAULT_TIMELINE_SYNCHRONOUS, DEFAULT_SQLITE_CACHE_SIZE, options.sqliteBusyTimeoutMs ?? DEFAULT_SQLITE_BUSY_TIMEOUT_MS);
    runMigrations(db, options.clock ?? DEFAULT_CLOCK);
    return owed;
  } finally { db.close(); }
}

export function createTimelineStore(
  options: TimelineStoreOptions & Readonly<{ clock?: Clock; timelineConfig?: TimelineStoreConfig }>,
): EventLedgerStoragePort {
  if (options.path.length === 0) {
    throw new InputError("Timeline store path is empty", "timeline_store_path_empty");
  }
  const ledgerId: string = options.ledgerId === undefined
    ? generateIdentifier("ledger")
    : validateId(options.ledgerId, "timeline_ledger_id_invalid");
  // The durability choice is CONFIGURED, not inherited — timeline-config.ts
  // owns the value and states, in numbers, what it trades and what it does
  // not. An explicit `options.synchronous` still wins, so a caller that needs
  // FULL keeps it.
  const synchronous: string = options.synchronous ?? DEFAULT_TIMELINE_SYNCHRONOUS;
  // Resolved ONCE: every query without a limit (the store's and the query
  // layer's) reads the configured `timeline.queryDefaultLimit` (a2-design H1:
  // it used to read the code constant, so the operator's value moved shard
  // imports but not store queries).
  const queryDefaultLimit = options.timelineConfig?.queryDefaultLimit ?? DEFAULT_TIMELINE_QUERY_LIMIT;
  const clock = options.clock ?? DEFAULT_CLOCK;
  const tc = options.timelineConfig;
  const limits: TimelineLimits = Object.freeze({
    maxDocumentBytes: tc?.maxDocumentBytes ?? MAXIMUM_DOCUMENT_BYTES,
    maxDocuments: tc?.maxDocuments ?? MAXIMUM_DOCUMENTS,
    maxEdges: tc?.maxEdges ?? MAXIMUM_EDGES,
  });
  assertTimelineDocumentByteLimit(limits.maxDocumentBytes);
  const sqliteCacheSize = tc?.sqliteCacheSize ?? DEFAULT_SQLITE_CACHE_SIZE;
  const sqliteBusyTimeoutMs = tc?.sqliteBusyTimeoutMs ?? DEFAULT_SQLITE_BUSY_TIMEOUT_MS;
  const durabilityWindowMs = tc?.durabilityWindowMs ?? DEFAULT_DURABILITY_WINDOW_MS;

  const db = new DatabaseSync(options.path);
  let key: KeyObject;
  let sealing: TimelineSealing;
  try {
    openLedgerConnection(db, options.path, synchronous, sqliteCacheSize, sqliteBusyTimeoutMs);
    runMigrations(db, clock);
    // LAYER 2. The triggers are the enforcement; this is what makes their
    // ABSENCE loud. Run after the migrations, so a ledger that just converged
    // on the current text passes, and BEFORE the store is handed to anyone, so
    // a ledger whose guarantee has been removed is never written to. See
    // `assertAppendOnlyTriggers`.
    assertAppendOnlyTriggers(db, options.path);
    // THE STORE KEY: the caller's admitted one (the web timeline shares the
    // web database's), else this file's own through the one key owner. It
    // seals the originals the projection masked and recognises authenticated
    // field ciphertext in documents. A ledger that already holds sealed
    // originals only ever LOADS its key: minting a new one would leave every
    // seal unopenable, so a missing key is refused, never replaced.
    key = options.key ?? resolvePersistedKey({
      dbPath: options.path,
      disposition: holdsSealedOriginals(db) ? "load-only" : "create-or-load",
    }).key;
    // WHICH KEY: the one this ledger's originals are sealed under, or a
    // typed refusal before anything is sealed or read (a3-design H2).
    sealing = createTimelineSealing(key);
    assertSealKey(db, sealing, ledgerId, options.path);
  } catch (error) {
    // The caller never receives the store, so nothing else can close this
    // handle. Leaking it would hold a file lock on a ledger the process has
    // just refused to use, and a retry would then fail for the wrong reason.
    bestEffort(() => { db.close(); });
    throw error;
  }
  const durabilityTimer = startDurabilityCheckpoints(db, synchronous, durabilityWindowMs);
  /**
   * THE DURABILITY POSTURE, STATED — read back from THIS connection rather
   * than echoed from what we asked for.
   *
   * `PRAGMA synchronous` is per-connection, so a second connection opened to
   * inspect the file reports its own default (FULL) and says nothing at all
   * about the ledger's. Reading it here is the only way the fact can be
   * observed rather than assumed, which is the same rule the whole document
   * is written under: a number nobody read is not evidence.
   *
   * `windowMs` is the configured timer interval, or 0 when disabled. It is
   * not a maximum crash-loss window or a power-loss guarantee.
   */
  const durability = Object.freeze({
    synchronous: readSynchronous(db),
    windowMs: durabilityTimer === null ? 0 : durabilityWindowMs,
  });

  const insertEvent = prepareStatement(db, `
    INSERT INTO event_log (
      event_id, ledger_id, sequence, record_kind, event_type,
      effect_kind, effect_id, observation_id, outcome,
      wall_time, monotonic_ns, trace_id, span_id, parent_event_id,
      actor_kind, actor_id, actor_role,
      run_id, session_id, turn_id, message_id, task_id, attempt_id, agent_id, parent_effect_id,
      intent_hash, result_hash, evidence_hash,
      error_category, error_code, error_message, error_retryable,
      description, payload_ref, payload_digest,
      previous_chain_hash, chain_hash
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?
    )
  `);

  const insertDocument = prepareStatement(db, `
    INSERT INTO event_documents (event_id, position, name, content_json, ordered_json, content_digest, projection_disposition, original_digest)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertEdge = prepareStatement(db, `
    INSERT INTO event_edges (source_event_id, edge_type, target_event_id, target_kind, target_id, position)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  // The read model is projected FROM the row just written to `event_log`,
  // not re-marshalled from the append payload. A second positional argument
  // list is exactly how the projection came to be missing ten columns and to
  // disagree with the ledger about what happened; a SELECT from the authority
  // cannot disagree with the authority. It also means the projection picks up
  // any value the ledger derived at insert time for free.
  const insertProjection = prepareStatement(db, `
    INSERT INTO timeline_projection (${PROJECTION_COLUMNS.join(", ")})
    SELECT ${PROJECTION_COLUMNS.join(", ")} FROM event_log WHERE event_id = ? AND ledger_id = ?
  `);

  const getEventRow = prepareStatement(db, `SELECT * FROM event_log WHERE event_id = ? AND ledger_id = ?`);
  const getDocRows = prepareStatement(db, `SELECT * FROM event_documents WHERE event_id = ? ORDER BY position`);
  const getEdgeRows = prepareStatement(db, `SELECT * FROM event_edges WHERE source_event_id = ? ORDER BY position, edge_id`);
  const getLastRow = prepareStatement(db, `SELECT sequence, chain_hash FROM event_log WHERE ledger_id = ? ORDER BY sequence DESC LIMIT 1`);

  const getIntentRows = prepareStatement(db, TIMELINE_LINEAGE_STATEMENTS.intent);
  const getTerminalRow = prepareStatement(db, TIMELINE_LINEAGE_STATEMENTS.terminal);
  const getPendingIntentRows = prepareStatement(db, TIMELINE_LINEAGE_STATEMENTS.pendingIntents);

  const writeState: WriteState = { active: false, uncertain: false };
  const appendContext = { insertEvent, insertDocument, insertEdge, insertProjection, getLastRow, getIntentRows, getTerminalRow, getEventRow, getDocRows, getEdgeRows, limits, writeState, key: key!, sealing };

  const store = Object.freeze({
    ledgerId,
    schemaVersion: TIMELINE_SCHEMA_VERSION,

    /** What this ledger's durability actually is, read off the connection.
     * Not on `EventLedgerStoragePort` — the port is the ledger's contract and
     * a storage fact is not part of it — but present on the concrete store,
     * the same way `close()` returns `{ checkpointSuccess }` the port types as
     * void. Tests and diagnostics cast to read it. */
    durability(): Readonly<{ synchronous: string; windowMs: number }> {
      return durability;
    },

    appendIntent(input: TimelineIntentInput): TimelineEventRecord {
      assertWritable(writeState);
      input = snapshotLedgerInput(input, "timeline_input_invalid");
      validateIntentInput(input, ledgerId, limits);
      return doAppend(db, ledgerId, {
        recordKind: "intent",
        eventId: input.eventId,
        eventType: input.eventType,
        effectKind: input.effectKind,
        effectId: input.effectId,
        observationId: undefined,
        outcome: undefined,
        wallTime: input.wallTime,
        monotonicNanoseconds: input.monotonicNanoseconds,
        traceId: input.traceId,
        spanId: input.spanId,
        parentEventId: input.parentEventId,
        actor: input.actor,
        correlation: input.correlation,
        description: input.description,
        intentHash: input.intentHash,
        resultHash: undefined,
        evidenceHash: undefined,
        error: undefined,
        payloadRef: undefined,
        payloadDigest: undefined,
        documents: input.documents,
        edges: input.edges,
      }, appendContext);
    },

    appendTerminal(input: TimelineTerminalInput): TimelineEventRecord {
      assertWritable(writeState);
      input = snapshotLedgerInput(input, "timeline_input_invalid");
      validateTerminalInput(input, ledgerId, limits);
      return doAppend(db, ledgerId, {
        recordKind: "terminal",
        eventId: input.eventId,
        eventType: input.eventType,
        effectKind: undefined,
        effectId: input.effectId,
        observationId: undefined,
        outcome: input.outcome,
        wallTime: input.wallTime,
        monotonicNanoseconds: input.monotonicNanoseconds,
        traceId: undefined,
        spanId: undefined,
        parentEventId: undefined,
        actor: { kind: "harness", id: "timeline-store" },
        correlation: undefined,
        description: `terminal:${input.outcome}`,
        intentHash: undefined,
        resultHash: input.resultHash,
        evidenceHash: undefined,
        error: input.error,
        payloadRef: undefined,
        payloadDigest: undefined,
        documents: input.documents,
        edges: input.edges,
      }, appendContext);
    },

    appendObservation(input: TimelineObservationInput): TimelineEventRecord {
      assertWritable(writeState);
      input = snapshotLedgerInput(input, "timeline_input_invalid");
      validateObservationInput(input, ledgerId, limits);
      return doAppend(db, ledgerId, {
        recordKind: "observation",
        eventId: input.eventId,
        eventType: input.eventType,
        effectKind: undefined,
        effectId: input.effectId,
        observationId: input.observationId,
        outcome: undefined,
        wallTime: input.wallTime,
        monotonicNanoseconds: input.monotonicNanoseconds,
        traceId: input.traceId,
        spanId: input.spanId,
        parentEventId: input.parentEventId,
        actor: input.actor,
        correlation: input.correlation,
        description: `observation:${input.eventType}`,
        intentHash: undefined,
        resultHash: undefined,
        evidenceHash: input.evidenceHash,
        error: undefined,
        payloadRef: undefined,
        payloadDigest: undefined,
        documents: input.documents,
        edges: input.edges,
      }, appendContext);
    },

    appendEvent(input: TimelineStandaloneEventInput): TimelineEventRecord {
      assertWritable(writeState);
      input = snapshotLedgerInput(input, "timeline_input_invalid");
      validateStandaloneInput(input, ledgerId, limits);
      return doAppend(db, ledgerId, {
        recordKind: "event",
        eventId: input.eventId,
        eventType: input.eventType,
        effectKind: undefined,
        effectId: undefined,
        observationId: undefined,
        outcome: input.outcome,
        wallTime: input.wallTime,
        monotonicNanoseconds: input.monotonicNanoseconds,
        traceId: input.traceId,
        spanId: input.spanId,
        parentEventId: input.parentEventId,
        actor: input.actor,
        correlation: input.correlation,
        description: input.description,
        intentHash: undefined,
        resultHash: undefined,
        evidenceHash: undefined,
        // Carried whole or not at all. The four error columns are written from
        // ONE value that `validateStandaloneInput` has already accepted in
        // full, so no combination of them can be partially persisted and none
        // of them can be filled in with a placeholder on the way past.
        error: input.error,
        payloadRef: input.payloadRef,
        payloadDigest: input.payloadDigest,
        documents: input.documents,
        edges: input.edges,
      }, appendContext);
    },

    getEvent(eventId: string): TimelineEventRecord | undefined {
      const row = getEventRow.get(eventId, ledgerId) as Row | undefined;
      if (row === undefined) return undefined;
      return hydrate(row as Record<string, unknown>, getDocRows, getEdgeRows);
    },

    query(filter?: Parameters<EventLedgerStoragePort["query"]>[0]): readonly TimelineEventRecord[] {
      return doQuery(db, ledgerId, filter, queryDefaultLimit);
    },

    querySummaries(filter?: Parameters<EventLedgerStoragePort["querySummaries"]>[0]): readonly TimelineEventSummary[] {
      return doQuerySummaries(db, ledgerId, filter, queryDefaultLimit);
    },

    traceMatchesAnyRun(traceId: string, runIds: readonly string[], selectedLedgerId: string): boolean {
      return doTraceMatchesAnyRun(db, validateId(selectedLedgerId, "timeline_ledger_id_invalid"), traceId, runIds);
    },

    count(filter?: Parameters<EventLedgerStoragePort["count"]>[0]): number {
      const where = buildWhere(ledgerId, filter);
      const row = prepareStatement(db, `SELECT COUNT(*) AS c FROM event_log ${where.sql}`).get(...where.params) as { c: number } | undefined;
      return row === undefined ? 0 : Number(row.c);
    },

    occurrenceCounts(): TimelineOccurrenceCounts {
      return doOccurrenceCounts(db);
    },

    recordingGapCounts(eventType?: TimelineEventType): TimelineRecordingGapCounts {
      return doRecordingGapCounts(db, eventType);
    },

    runActivitySummaries(runIds: readonly string[]): readonly TimelineRunActivitySummary[] {
      return doRunActivitySummaries(db, runIds);
    },

    fileEffectFacts(filter: TimelineFileEffectFactsFilter): TimelineFileEffectFacts {
      return doFileEffectFacts(db, filter);
    },

    checkStatusFacts(filter: TimelineCheckStatusFactsFilter): TimelineCheckStatusFacts {
      return doCheckStatusFacts(db, filter);
    },

    spectrum(filter: TimelineSpectrumFilter): TimelineSpectrum {
      return doSpectrum(db, ledgerId, filter);
    },

    nextSequence(): string {
      const row = getLastRow.get(ledgerId) as { sequence: number | bigint; chain_hash: string } | undefined;
      if (row === undefined) return formatSequence(GENESIS_SEQUENCE);
      return formatSequence(nextLedgerSequence(BigInt(row.sequence), "timeline_sequence_exhausted"));
    },

    chainTipHash(): string {
      const row = getLastRow.get(ledgerId) as { chain_hash: string } | undefined;
      return row === undefined ? ZERO_CHAIN_HASH : row.chain_hash;
    },

    verifyChain(ledgerIdFilter?: string): TimelineChainVerification {
      return doVerifyChain(db, ledgerIdFilter ?? ledgerId);
    },

    pendingIntents(): readonly TimelineEventRecord[] {
      // Served by the lineage index (the outer `ledger_id, record_kind` range
      // and the inner terminal probe); the pending set is small, so its
      // sequence order is taken here rather than by a second index.
      const rows = (getPendingIntentRows.all(ledgerId) as Row[])
        .toSorted((a, b) => (BigInt(a.sequence as number | bigint) < BigInt(b.sequence as number | bigint) ? -1 : 1));
      return Object.freeze(rows.map((row) => hydrate(row, getDocRows, getEdgeRows)));
    },

    originalDocuments(eventId: string, purpose: TimelineOriginalPurpose): readonly TimelineDocumentRecord[] | undefined {
      const row = getEventRow.get(eventId, ledgerId) as Row | undefined;
      if (row === undefined) return undefined;
      const at = { ledgerId, eventId, sequence: BigInt(row.sequence as number | bigint).toString(10) };
      const documents = hydrate(row, getDocRows, getEdgeRows).documents;
      const sealed = documents.filter((document) => document.projectionDisposition !== "exact").map((document) => document.name);
      if (sealed.length === 0) return Object.freeze(documents);
      // Every opening of a seal is audited — the names, never the bytes.
      const audit = (outcome: string) => auditEvent("timeline.original.open", { ledgerId, eventId, documents: sealed, purpose, outcome });
      let opened: readonly TimelineDocumentRecord[];
      try {
        opened = documents.map((document) => {
          if (document.projectionDisposition === "exact") return document;
          const text = sealing.open(db, BigInt(document.docId), at, document.originalDigest!);
          const representation = document.contentJson !== null ? { contentJson: text } : { orderedJson: text };
          return Object.freeze({ ...document, ...representation, contentDigest: document.originalDigest!, projectionDisposition: "exact" as const, originalDigest: null });
        });
      } catch (error) {
        audit(typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "failed");
        throw error;
      }
      audit("opened");
      return Object.freeze(opened);
    },

    rebuildProjections(): void {
      doRebuildProjections(db, ledgerId, writeState);
    },

    close(): { checkpointSuccess: boolean } {
      // Stop the window timer BEFORE the connection goes away — a checkpoint
      // fired against a closed DatabaseSync throws, and the TRUNCATE
      // checkpoint below flushes everything the timer would have. Its result
      // is read from the checkpoint's own row: a TRUNCATE a reader blocked
      // throws nothing and is still not a success.
      if (durabilityTimer !== null) clearInterval(durabilityTimer);
      const checkpoint = checkpointSqlite(db, "TRUNCATE");
      db.close();
      return { checkpointSuccess: checkpoint.status === "complete" || checkpoint.status === "not-applicable" };
    },
  }) as EventLedgerStoragePort;

  return store;
}

type Row = Record<string, unknown>;

type AppendCtx = Readonly<{
  insertEvent: Stmt;
  insertDocument: Stmt;
  insertEdge: Stmt;
  insertProjection: Stmt;
  getLastRow: Stmt;
  getIntentRows: Stmt;
  getTerminalRow: Stmt;
  getEventRow: Stmt;
  getDocRows: Stmt;
  getEdgeRows: Stmt;
  limits: TimelineLimits;
  writeState: WriteState;
  key: KeyObject;
  sealing: TimelineSealing;
}>;

type Payload = Readonly<{
  recordKind: "intent" | "terminal" | "observation" | "event";
  eventId: string;
  eventType: string;
  effectKind: string | undefined;
  effectId: string | undefined;
  observationId: string | undefined;
  outcome: string | undefined;
  wallTime: string;
  monotonicNanoseconds: string | undefined;
  traceId: string | undefined;
  spanId: string | undefined;
  parentEventId: string | undefined;
  actor: TimelineActor;
  correlation: TimelineCorrelation | undefined;
  description: string;
  intentHash: string | undefined;
  resultHash: string | undefined;
  evidenceHash: string | undefined;
  error: TimelineErrorSummary | undefined;
  payloadRef: string | undefined;
  payloadDigest: string | undefined;
  documents: readonly TimelineDocumentInput[] | undefined;
  edges: readonly TimelineEdgeInput[] | undefined;
}>;

/**
 * THE LEDGER'S OPERATIONAL PROJECTION — the only door, so there is nothing to
 * remember.
 *
 * A provider that echoes an `Authorization` header in its error body, an
 * edited `.env` whose pre-image is a file effect's document, a command line
 * carrying `--token=…` as its description: each reached `timeline.db` as
 * plaintext, permanently, because the chain is append-only (one failed effect
 * wrote two byte-matches of a live key; CRED-F12 found the full `.env`).
 * `doAppend` is the single function all four record kinds converge on, so the
 * masking happens HERE, before the chain hash is computed over the envelope:
 * the hash covers what was actually stored, and no caller can name the value
 * that reaches SQLite. The detector is the one the egress runs
 * (`redactForLLMContext`); documents go through `redactOperationalText`, which
 * is that detector minus the spans that are authenticated field ciphertext
 * under the store key (memory entries carried in the ledger stay readable).
 *
 * WHAT IS NOT LOST. A document whose projection differs from what was
 * appended keeps its ORIGINAL, sealed (`timeline-sealing.ts`): its row is
 * `protected` and names the original's digest, and a rollback restores the
 * file from the seal, never from the masked text. The failure text and the
 * description are masked without a sealed copy (the encrypted full-fidelity
 * vault of REQ-025 is an open requirement). Identifiers and document names are
 * never masked — a masked id would break the id a reader sends back — they are
 * refused instead when they look sensitive (`validateId`, `validateDocs`).
 *
 * `description` was once left alone because the detector read a UUID whose
 * fourth group is `9acc` as a credential (0.04% of random UUIDs). Re-measured
 * on the current detector (2026-09-29): 0 of 100,000 random UUIDs and 0 of
 * 20,000 `9acc` UUIDs change, while a command-line description carrying a
 * token is masked — so it is projected like the rest.
 *
 * A SECRET FILE'S PRE-IMAGE (`.env`, a key, a credential store —
 * `isSecretFile` over the path its effect document names) first goes through
 * THE secret-file redactor `read_file` serves such a file through: every
 * value hidden, keys and comment markers kept. The detector's value grammar
 * reads prose and code; over a `.env` it left 9 of a 16-character password in
 * the clear (a `#` inside it), and a quoted value or one with spaces whole
 * (a3-correctness M-2). The original is sealed like every changed document.
 */
function projectPayload(payload: Payload, key: KeyObject): Payload {
  const effectPath = fileEffectPath(payload);
  const documents = payload.documents?.map((doc) => {
    const source = doc.contentJson ?? doc.orderedJson;
    if (source === undefined) return doc;
    const text = redactOperationalText(effectPath !== undefined && doc.name === TIMELINE_PREIMAGE_DOCUMENT ? redactSecretFileText(effectPath, source, DEFAULT_PRIVACY_POLICY) : source, key);
    if (text === source) return doc;
    return { name: doc.name, ...(doc.contentJson !== undefined ? { contentJson: text } : { orderedJson: text }), contentDigest: sha256(text) };
  });
  return {
    ...payload, description: redactForLLMContext(payload.description),
    error: payload.error === undefined ? undefined : { ...payload.error, message: redactForLLMContext(payload.error.message) },
    documents,
  };
}

/** The file a file effect's documents describe (its effect document's `path`), or undefined for any other event. */
function fileEffectPath(payload: Payload): string | undefined {
  if (payload.eventType !== "file-effect") return undefined;
  const effect = payload.documents?.find((doc) => doc.name === TIMELINE_FILE_EFFECT_DOCUMENT)?.contentJson;
  const path = effect === undefined ? undefined : decodeEffectDocument(effect)?.path;
  return typeof path === "string" ? path : undefined;
}

/** Admission and derivation share the append's write lock and precede hashing. */
function resolveLineage(payload: Payload, ledgerId: string, ctx: AppendCtx): Payload {
  if (payload.recordKind !== "intent" && payload.recordKind !== "terminal") return payload;
  const intents = ctx.getIntentRows.all(ledgerId, payload.effectId!) as Row[];
  if (payload.recordKind === "intent") {
    if (intents.length !== 0) throw new SecurityError("Timeline effect already has an intent", "timeline_intent_duplicate");
    if (ctx.getTerminalRow.get(ledgerId, payload.effectId!) !== undefined) {
      throw new SecurityError("Timeline effect already ended", "timeline_intent_already_terminal");
    }
    return payload;
  }
  if (intents.length === 0) throw new SecurityError("Timeline terminal has no intent", "timeline_terminal_orphan");
  if (intents.length !== 1) throw new SecurityError("Timeline terminal intent is ambiguous", "timeline_terminal_ambiguous");
  if (ctx.getTerminalRow.get(ledgerId, payload.effectId!) !== undefined) {
    throw new SecurityError("Timeline effect already has a terminal", "timeline_terminal_duplicate");
  }
  const intent = buildEventFields(intents[0]!);
  if (payload.eventType !== intent.eventType) {
    throw new SecurityError("Timeline terminal event type differs from its intent", "timeline_terminal_event_type_mismatch");
  }
  const correlation: Record<string, string> = {};
  for (const key of CORRELATION_FIELD_NAMES) {
    const value = intent[key];
    if (value !== null) correlation[key] = value;
  }
  return {
    ...payload,
    actor: { kind: intent.actorKind, id: intent.actorId, ...(intent.actorRole !== null ? { role: intent.actorRole } : {}) },
    correlation: Object.keys(correlation).length > 0 ? correlation : undefined,
    traceId: intent.traceId ?? undefined,
    spanId: intent.spanId ?? undefined,
    parentEventId: intent.eventId,
  };
}

function doAppend(db: DatabaseSync, ledgerId: string, unredacted: Payload, ctx: AppendCtx): TimelineEventRecord {
  // Projection precedes the write lock; transactional lineage admission then
  // binds the only payload used for hashing, rows and projections.
  const redacted = projectPayload(unredacted, ctx.key);
  return writeTransaction(db, ctx.writeState, () => {
    const p = resolveLineage(redacted, ledgerId, ctx);
    // Read the chain tip INSIDE the BEGIN IMMEDIATE transaction so the
    // RESERVED write lock serializes the read-modify-write. Reading the
    // tip before acquiring the lock is a TOCTOU: two concurrent appenders
    // both read the same (sequence, previous_chain_hash), compute the same
    // next sequence and chain hash, and the second commit inserts a
    // duplicate sequence with a stale previous_chain_hash, silently
    // corrupting the append-only ledger. BEGIN IMMEDIATE guarantees only
    // one appender observes and mutates the tip at a time; contending
    // appenders wait up to PRAGMA busy_timeout for the lock.
    const last = ctx.getLastRow.get(ledgerId) as { sequence: number | bigint; chain_hash: string } | undefined;
    const prevSeq = last === undefined ? 0n : BigInt(last.sequence);
    const nextSeq = nextLedgerSequence(prevSeq, "timeline_sequence_exhausted");
    const prevHash = last === undefined ? ZERO_CHAIN_HASH : last.chain_hash;
    const envelope = buildEnvelope(ledgerId, nextSeq, p);
    const chainHash = computeChainHash(TIMELINE_DOMAIN, prevHash, envelope);

    ctx.insertEvent.run(
      p.eventId, ledgerId, nextSeq, p.recordKind, p.eventType,
      p.effectKind ?? null, p.effectId ?? null, p.observationId ?? null, p.outcome ?? null,
      p.wallTime, p.monotonicNanoseconds ?? null, p.traceId ?? null, p.spanId ?? null, p.parentEventId ?? null,
      p.actor.kind, p.actor.id, p.actor.role ?? null,
      p.correlation?.runId ?? null, p.correlation?.sessionId ?? null,
      p.correlation?.turnId ?? null, p.correlation?.messageId ?? null,
      p.correlation?.taskId ?? null, p.correlation?.attemptId ?? null,
      p.correlation?.agentId ?? null, p.correlation?.parentEffectId ?? null,
      p.intentHash ?? null, p.resultHash ?? null, p.evidenceHash ?? null,
      p.error?.category ?? null, p.error?.code ?? null, p.error?.message ?? null,
      p.error === undefined ? null : (p.error.retryable ? 1 : 0),
      p.description, p.payloadRef ?? null, p.payloadDigest ?? null,
      prevHash, chainHash,
    );

    if (p.documents !== undefined) {
      const at = { ledgerId, eventId: p.eventId, sequence: formatSequence(nextSeq) };
      let pos = 0;
      for (const doc of p.documents) {
        if (pos >= ctx.limits.maxDocuments) throw new InputError("Timeline documents exceed ceiling", "timeline_documents_exceeded");
        // The projection changed this document: its row is `protected`, names
        // the original's digest, and the original is sealed beside it.
        const original = unredacted.documents![pos]!;
        const changed = doc.contentDigest !== original.contentDigest;
        const inserted = ctx.insertDocument.run(p.eventId, pos, doc.name, doc.contentJson ?? null, doc.orderedJson ?? null, doc.contentDigest,
          changed ? "protected" : "exact", changed ? original.contentDigest : null);
        if (changed) {
          recordSealKey(db, ctx.sealing, at.ledgerId);
          ctx.sealing.seal(db, BigInt(inserted.lastInsertRowid), at, (original.contentJson ?? original.orderedJson)!);
        }
        pos += 1;
      }
    }

    if (p.edges !== undefined) {
      let pos = 0;
      for (const edge of p.edges) {
        if (pos >= ctx.limits.maxEdges) throw new InputError("Timeline edges exceed ceiling", "timeline_edges_exceeded");
        ctx.insertEdge.run(p.eventId, edge.edgeType, edge.targetEventId ?? null, edge.targetKind ?? null, edge.targetId ?? null, pos);
        pos += 1;
      }
    }

    ctx.insertProjection.run(p.eventId, ledgerId);
    // Materialize every returned field before COMMIT. No fallible hydration
    // follows the acknowledged write.
    const row = ctx.getEventRow.get(p.eventId, ledgerId) as Row;
    return hydrate(row, ctx.getDocRows, ctx.getEdgeRows);
  });
}

function buildEnvelope(ledgerId: string, sequence: bigint, p: Payload): Readonly<Record<string, unknown>> {
  const e: Record<string, unknown> = {
    schemaVersion: TIMELINE_SCHEMA_VERSION,
    ledgerId,
    sequence: formatSequence(sequence),
    recordKind: p.recordKind,
    eventType: p.eventType,
    eventId: p.eventId,
    wallTime: p.wallTime,
    actor: p.actor,
    description: p.description,
    previousChainHash: "",
  };
  if (p.effectKind !== undefined) e.effectKind = p.effectKind;
  if (p.effectId !== undefined) e.effectId = p.effectId;
  if (p.observationId !== undefined) e.observationId = p.observationId;
  if (p.outcome !== undefined) e.outcome = p.outcome;
  if (p.monotonicNanoseconds !== undefined) e.monotonicNanoseconds = p.monotonicNanoseconds;
  if (p.traceId !== undefined) e.traceId = p.traceId;
  if (p.spanId !== undefined) e.spanId = p.spanId;
  if (p.parentEventId !== undefined) e.parentEventId = p.parentEventId;
  if (p.correlation !== undefined) e.correlation = p.correlation;
  if (p.intentHash !== undefined) e.intentHash = p.intentHash;
  if (p.resultHash !== undefined) e.resultHash = p.resultHash;
  if (p.evidenceHash !== undefined) e.evidenceHash = p.evidenceHash;
  if (p.error !== undefined) e.error = p.error;
  if (p.payloadRef !== undefined) e.payloadRef = p.payloadRef;
  if (p.payloadDigest !== undefined) e.payloadDigest = p.payloadDigest;
  return deepFreeze(e);
}

function hydrate(row: Row, getDocs: Stmt, getEdges: Stmt): TimelineEventRecord {
  const eventId = String(row.event_id);
  const docRows = getDocs.all(eventId) as Row[];
  const edgeRows = getEdges.all(eventId) as Row[];
  return buildRecord(row, docRows, edgeRows);
}

/**
 * ONE `event_log` ROW'S OWN COLUMNS — the single owner of the row shape.
 * `buildRecord` spreads these fields and adds the attachments; the summary
 * projection spreads them alone. A column added here reaches both shapes;
 * the mapping is never restated in a second place.
 */
function buildEventFields(row: Row) {
  return {
    eventId: String(row.event_id),
    ledgerId: String(row.ledger_id),
    sequence: BigInt(row.sequence as number | bigint).toString(10),
    recordKind: String(row.record_kind) as TimelineEventRecord["recordKind"],
    eventType: String(row.event_type) as TimelineEventRecord["eventType"],
    effectKind: row.effect_kind === null ? null : String(row.effect_kind),
    effectId: row.effect_id === null ? null : String(row.effect_id),
    observationId: row.observation_id === null ? null : String(row.observation_id),
    outcome: row.outcome === null ? null : String(row.outcome),
    wallTime: String(row.wall_time),
    monotonicNanoseconds: row.monotonic_ns === null ? null : String(row.monotonic_ns),
    traceId: row.trace_id === null ? null : String(row.trace_id),
    spanId: row.span_id === null ? null : String(row.span_id),
    parentEventId: row.parent_event_id === null ? null : String(row.parent_event_id),
    actorKind: String(row.actor_kind),
    actorId: String(row.actor_id),
    actorRole: row.actor_role === null ? null : String(row.actor_role),
    runId: row.run_id === null ? null : String(row.run_id),
    sessionId: row.session_id === null ? null : String(row.session_id),
    turnId: row.turn_id === null ? null : String(row.turn_id),
    messageId: row.message_id === null ? null : String(row.message_id),
    taskId: row.task_id === null ? null : String(row.task_id),
    attemptId: row.attempt_id === null ? null : String(row.attempt_id),
    agentId: row.agent_id === null ? null : String(row.agent_id),
    parentEffectId: row.parent_effect_id === null ? null : String(row.parent_effect_id),
    intentHash: row.intent_hash === null ? null : String(row.intent_hash),
    resultHash: row.result_hash === null ? null : String(row.result_hash),
    evidenceHash: row.evidence_hash === null ? null : String(row.evidence_hash),
    errorCategory: row.error_category === null ? null : String(row.error_category),
    errorCode: row.error_code === null ? null : String(row.error_code),
    errorMessage: row.error_message === null ? null : String(row.error_message),
    errorRetryable: row.error_retryable === null ? null : Number(row.error_retryable) !== 0,
    description: String(row.description),
    payloadRef: row.payload_ref === null ? null : String(row.payload_ref),
    payloadDigest: row.payload_digest === null ? null : String(row.payload_digest),
    previousChainHash: String(row.previous_chain_hash),
    chainHash: String(row.chain_hash),
  };
}

function buildRecord(row: Row, docRows: Row[], edgeRows: Row[]): TimelineEventRecord {
  const documents: TimelineDocumentRecord[] = docRows.map((d) => Object.freeze({
    docId: Number(d.doc_id),
    eventId: String(d.event_id),
    position: Number(d.position),
    name: String(d.name),
    contentJson: d.content_json === null ? null : String(d.content_json),
    orderedJson: d.ordered_json === null ? null : String(d.ordered_json),
    contentDigest: String(d.content_digest),
    projectionDisposition: String(d.projection_disposition) as TimelineDocumentRecord["projectionDisposition"],
    originalDigest: d.original_digest === null ? null : String(d.original_digest),
  }));
  const edges: TimelineEdgeRecord[] = edgeRows.map((e) => Object.freeze({
    edgeId: Number(e.edge_id),
    sourceEventId: String(e.source_event_id),
    edgeType: String(e.edge_type) as TimelineEdgeRecord["edgeType"],
    targetEventId: e.target_event_id === null ? null : String(e.target_event_id),
    targetKind: e.target_kind === null ? null : String(e.target_kind),
    targetId: e.target_id === null ? null : String(e.target_id),
    position: Number(e.position),
  }));
  return Object.freeze({
    ...buildEventFields(row),
    documents: Object.freeze(documents),
    edges: Object.freeze(edges),
  }) as TimelineEventRecord;
}

/**
 * The LIST read's row projection: the same WHERE, ordering and paging as
 * `doQuery`, without the two batched attachment fetches. Attachments are the
 * detail door's (`getEvent`) to serve; a page of them is the bulk of a flat
 * query's cost while no list consumer reads them.
 */
function doQuerySummaries(
  db: DatabaseSync,
  defaultLedger: string,
  filter: Parameters<EventLedgerStoragePort["querySummaries"]>[0],
  queryDefaultLimit: number,
): readonly TimelineEventSummary[] {
  const where = buildWhere(defaultLedger, filter);
  const limit = filter?.limit ?? queryDefaultLimit;
  const offset = filter?.offset ?? 0;
  const ascending = filter?.ascending ?? true;
  const order = ascending ? "ASC" : "DESC";
  const rows = prepareStatement(db, `SELECT * FROM event_log ${where.sql} ORDER BY sequence ${order} LIMIT ? OFFSET ?`)
    .all(...where.params, limit, offset) as Row[];
  return Object.freeze(rows.map((r) => Object.freeze(buildEventFields(r)) as TimelineEventSummary));
}

/**
 * The lean trace-ownership proof: does this trace hold an event attributed
 * to any of `runIds`? ONE indexed existence lookup — the composite trace
 * index narrows to the trace's rows, the bound JSON run set checks
 * membership, `LIMIT 1` stops at the first owned row. An empty `runIds`
 * can match nothing (a caller with no runs owns no trace), and an empty
 * result is the honest `false`, never a fabricated `true`.
 */
function doTraceMatchesAnyRun(
  db: DatabaseSync,
  defaultLedger: string,
  traceId: string,
  runIds: readonly string[],
): boolean {
  const where = buildWhere(defaultLedger, { traceId, runIds });
  return prepareStatement(db, `SELECT 1 AS hit FROM event_log ${where.sql} LIMIT 1`)
    .get(...where.params) !== undefined;
}

/** SQLite's numeric `PRAGMA synchronous` back as its name. Unknown values are
 * returned verbatim rather than guessed — a durability posture nobody
 * recognises must not be reported as one that is understood. */
function readSynchronous(db: DatabaseSync): string {
  const row = prepareStatement(db, "PRAGMA synchronous").get() as { synchronous?: number } | undefined;
  const value = Number(row?.synchronous ?? -1);
  const names: Readonly<Record<number, string>> = { 0: "OFF", 1: "NORMAL", 2: "FULL", 3: "EXTRA" };
  return names[value] ?? `UNKNOWN(${value})`;
}

/**
 * Best-effort checkpoint cadence, not a maximum crash-loss bound. Reader
 * contention, scheduling and I/O failures can delay checkpoint completion.
 * PASSIVE results describe progress, not an event-specific fsync receipt.
 * The timer is unref'd and disabled under FULL/EXTRA; close separately attempts
 * TRUNCATE and reports its actual result before closing the connection.
 */
function startDurabilityCheckpoints(
  db: DatabaseSync,
  synchronous: string,
  windowMs: number,
): ReturnType<typeof setInterval> | null {
  const upper = synchronous.toUpperCase();
  if (upper === "FULL" || upper === "EXTRA") return null;
  if (!Number.isFinite(windowMs) || windowMs <= 0) return null;
  const timer = setInterval(guarded("timeline.checkpoint", () => {
    checkpointSqlite(db, "PASSIVE");
  }), windowMs);
  timer.unref();
  return timer;
}

/**
 * The ledger connection's open sequence, ONE for the store and the migration
 * worker: the lock wait first (it only configures this connection), then WHOSE
 * ledger it is — before any byte of the file changes (UD-S15; SCALE-CR1-FIX N5:
 * the WAL switch below rewrites the header of a ledger that is not in WAL mode
 * yet, so it may not run before the admission) — then the connection's pragmas.
 */
function openLedgerConnection(db: DatabaseSync, path: string, synchronous: string, cacheSize: number, busyTimeoutMs: number): void {
  // Install the connection's configured lock wait before WAL/setup can contend
  // with another opener or writer. It also covers later BEGIN IMMEDIATE writes.
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  admitDatabaseProvenance(db, path, "write");
  // A fresh file's concurrent first openers are refused by SQLite without the
  // busy handler; the WAL owner waits for them within this same timeout.
  establishWalJournal(db, busyTimeoutMs);
  db.exec(`PRAGMA synchronous = ${synchronous}`);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA temp_store = MEMORY");
  db.exec(`PRAGMA cache_size = ${cacheSize}`);
}

function runMigrations(db: DatabaseSync, clock: Clock): void {
  let current: string | undefined;
  try {
    // The registry read and every pending migration share ONE BEGIN IMMEDIATE:
    // a contending opener re-reads the registry only after it holds the writer
    // lock. (Two first openers used to both read "absent" before any lock, and
    // the second failed on the registry's unique key.)
    writeTransaction(db, { active: false, uncertain: false }, () => {
      db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL, applied_at TEXT NOT NULL
      ) STRICT`);
      const applied = new Map((prepareStatement(db, "SELECT migration_id, name FROM schema_migrations").all() as Row[])
        .map((row) => [String(row.name), BigInt(row.migration_id as number | bigint)] as const));
      // A migration this build does not know was applied by another build (a
      // newer one, or an abandoned draft): its schema carries rules this code
      // cannot see, so nothing is written into it. A KNOWN migration missing
      // from the registry is the supported gap upgrade and is applied by name.
      for (const [name, id] of applied) {
        if (!ALL_MIGRATIONS.some((migration) => migration.name === name && BigInt(migration.id) === id)) {
          throw new SecurityError(`Timeline migration ${name} (#${id}) was applied by a build this one does not know; the ledger is not written by an older or foreign schema`, "timeline_migration_unknown");
        }
      }
      for (const migration of ALL_MIGRATIONS) {
        if (applied.has(migration.name)) continue;
        current = migration.name;
        db.exec(migration.sql);
        prepareStatement(db, "INSERT INTO schema_migrations (migration_id, name, checksum, applied_at) VALUES (?, ?, ?, ?)").run(
          migration.id, migration.name, sha256(migration.sql), clock(),
        );
      }
    });
  } catch (error) {
    if (error instanceof LedgerPersistenceUncertainError || (error instanceof SecurityError && error.code === "timeline_migration_unknown")) throw error;
    throw new SecurityError(`Timeline migration ${current ?? "registry"} failed: ${extractErrorMessage(error)}`, "timeline_migration_failed");
  }
}

/** Whether this ledger already holds a sealed original (its key may then only be loaded, never minted). */
function holdsSealedOriginals(db: DatabaseSync): boolean {
  return prepareStatement(db, "SELECT 1 FROM event_document_originals LIMIT 1").get() !== undefined;
}

function sealKeyMismatch(where: string): SecurityError {
  return new SecurityError(`The timeline ${where} seals its originals under another key than the one this process holds; refused before anything is sealed or read (a second key would split its seals, and neither host could open the other's)`, "timeline_seal_key_mismatch");
}

/**
 * THE KEY IN HAND IS THE LEDGER'S (a3-design H2): its check value must equal
 * the one the ledger recorded at its first seal. A ledger holding seals but
 * no record (sealed before migration 10) proves the key by opening one
 * sealed original, then records it; a ledger with nothing sealed records it
 * at its first seal ({@link recordSealKey}).
 */
function assertSealKey(db: DatabaseSync, sealing: TimelineSealing, ledgerId: string, path: string): void {
  const recorded = prepareStatement(db, "SELECT check_value FROM timeline_seal_key_check WHERE singleton = 1").get() as { check_value: string } | undefined;
  if (recorded !== undefined) {
    if (recorded.check_value !== sealing.keyCheck) throw sealKeyMismatch(path);
    return;
  }
  const sealed = prepareStatement(db, `SELECT d.doc_id, d.original_digest, e.event_id, e.sequence FROM event_documents d JOIN event_log e ON e.event_id = d.event_id
    WHERE d.projection_disposition = 'protected' AND e.ledger_id = ? ORDER BY d.doc_id LIMIT 1`).get(ledgerId) as { doc_id: bigint; original_digest: string; event_id: string; sequence: bigint } | undefined;
  if (sealed === undefined) return;
  try {
    sealing.open(db, sealed.doc_id, { ledgerId, eventId: sealed.event_id, sequence: formatSequence(sealed.sequence) }, sealed.original_digest);
  } catch (error) {
    if (error instanceof SecurityError && error.code === "timeline_sealed_original_unavailable") throw sealKeyMismatch(path);
    throw error;
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    recordSealKey(db, sealing, path);
    db.exec("COMMIT");
  } catch (error) {
    bestEffort(() => { db.exec("ROLLBACK"); });
    throw error;
  }
}

/**
 * Record the seal key's check value (once, inside the caller's write
 * transaction) — and refuse, in that same transaction, a ledger that recorded
 * ANOTHER key meanwhile (two openers with two keys: the second seal fails).
 */
function recordSealKey(db: DatabaseSync, sealing: TimelineSealing, where: string): void {
  prepareStatement(db, "INSERT INTO timeline_seal_key_check (singleton, check_value) SELECT 1, ? WHERE NOT EXISTS (SELECT 1 FROM timeline_seal_key_check)").run(sealing.keyCheck);
  const recorded = prepareStatement(db, "SELECT check_value FROM timeline_seal_key_check WHERE singleton = 1").get() as { check_value: string } | undefined;
  if (recorded?.check_value !== sealing.keyCheck) throw sealKeyMismatch(where);
}

/**
 * THE TIMELINE'S CIPHERTEXT PROBE for the one key owner
 * (`persisted-key.ts`): a ledger sharing a key (every store of one folder
 * does) is asked before a key is minted for another store — an empty ledger
 * beside a sealed one used to mint a replacement that orphaned its
 * neighbour's seals (a3-design H2). A file that is not a ledger (or cannot be
 * read) is not this kind.
 */
registerCiphertextProbe((path) => {
  let db: DatabaseSync;
  try { db = new DatabaseSync(path, { readOnly: true }); } catch { return undefined; }
  try {
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
    if (!tables.has("event_log")) return undefined;
    return tables.has("event_document_originals") && holdsSealedOriginals(db);
  } catch {
    // Not a database, or damaged: not a ledger this probe can answer for.
    return undefined;
  } finally { db.close(); }
});

/**
 * ── LAYER 2: THE GUARANTEE IS CHECKED, NOT ASSUMED ─────────────────────────
 *
 * The triggers are what actually stops an UPDATE or a DELETE, and they hold
 * against every path — this store, a module that skipped it, a migration
 * written years from now, the `sqlite3` prompt. But a trigger is schema, and
 * anyone who can reach the file can `DROP TRIGGER`. `runMigrations` cannot
 * notice: migration 1 is recorded as applied, so it never runs again and never
 * looks. A ledger could therefore be silently mutable for its whole life while
 * every line of code above it still believed it was append-only.
 *
 * So the store refuses to open. Not a warning, not a log line, not a degraded
 * mode: `createTimelineStore` throws, `timeline-bridge.ts` cannot produce a
 * recorder, and nothing records rather than recording into a ledger whose
 * guarantee has been removed. A ledger that cannot promise it is append-only
 * is not a ledger, and continuing to write to it would manufacture exactly the
 * false confidence this whole layer exists to prevent.
 *
 * IT CHECKS THE TEXT, NOT THE NAME. A trigger named `event_log_no_delete`
 * whose body is `SELECT 1` is worse than no trigger at all — it satisfies
 * every existence check and enforces nothing. `sqlite_master.sql` holds the
 * statement as SQLite normalised it, and `ENFORCED_APPEND_ONLY_TRIGGERS[].createSql` is
 * written in exactly that normal form, so the comparison is a byte equality
 * with no normaliser of ours in the middle to be fooled.
 *
 * WHAT IT CANNOT DO, stated so nobody reads more into it: it runs at open. It
 * cannot stop someone dropping a trigger against a live file afterwards, and
 * it cannot stop anyone editing the database with this process not running at
 * all. That attack is not addressed here — it is addressed by the chain hash
 * (`verifyChain`), which makes the alteration VISIBLE afterwards even though
 * nothing could make it UNREACHABLE at the time. The two layers answer
 * different questions and neither replaces the other.
 */
function assertAppendOnlyTriggers(db: DatabaseSync, path: string): void {
  const rows = prepareStatement(db, `SELECT name, sql FROM sqlite_master WHERE type = 'trigger'`)
    .all() as { name: string; sql: string | null }[];
  const live = new Map(rows.map((r) => [r.name, r.sql]));

  const faults: string[] = [];
  for (const trigger of ENFORCED_APPEND_ONLY_TRIGGERS) {
    const found = live.get(trigger.name);
    if (found === undefined || found === null) {
      faults.push(`${trigger.name} is missing (it rejects ${trigger.operation} on ${trigger.table})`);
      continue;
    }
    if (found !== trigger.createSql) {
      faults.push(
        `${trigger.name} does not match the append-only rule. `
          + `expected: ${JSON.stringify(trigger.createSql)}; found: ${JSON.stringify(found)}`,
      );
    }
  }
  if (faults.length === 0) return;

  throw new SecurityError(
    `the append-only guarantee is not in force on ${path}, so this ledger refuses to open. `
      + `The ledger is protected by SQLite triggers that reject UPDATE and DELETE on the recorded `
      + `events; ${faults.length} of ${ENFORCED_APPEND_ONLY_TRIGGERS.length} are missing or altered, which means `
      + `recorded events on this file can be changed or removed. Recording into it would produce a `
      + `record nobody can rely on. Faults: ${faults.join(" | ")}`,
    "timeline_append_only_not_enforced",
  );
}

function doQuery(db: DatabaseSync, defaultLedger: string, filter: Parameters<EventLedgerStoragePort["query"]>[0], queryDefaultLimit: number): readonly TimelineEventRecord[] {
  const where = buildWhere(defaultLedger, filter);
  const limit = filter?.limit ?? queryDefaultLimit;
  const offset = filter?.offset ?? 0;
  const ascending = filter?.ascending ?? true;
  const order = ascending ? "ASC" : "DESC";
  // Batched query plan (option B): fetch full event rows in one query, then
  // fetch all related documents and edges in two batched `IN (...)` queries.
  // This replaces the prior N+1 plan (1 query for event_ids + 3 queries per
  // row) with 1 + 2*ceil(N/QUERY_BATCH_SIZE) queries, eliminating per-row
  // round-trips.
  const rows = prepareStatement(db, `SELECT * FROM event_log ${where.sql} ORDER BY sequence ${order} LIMIT ? OFFSET ?`)
    .all(...where.params, limit, offset) as Row[];
  if (rows.length === 0) return Object.freeze([]);
  const eventIds = rows.map((r) => String(r.event_id));
  const docsByEvent = batchFetchRelated(db, eventIds, "event_documents", "event_id", "position");
  const edgesByEvent = batchFetchRelated(db, eventIds, "event_edges", "source_event_id", "position, edge_id");
  const results: TimelineEventRecord[] = [];
  for (const r of rows) {
    const eventId = String(r.event_id);
    results.push(buildRecord(r, docsByEvent.get(eventId) ?? [], edgesByEvent.get(eventId) ?? []));
  }
  return Object.freeze(results);
}

/**
 * Batch-fetch rows from a related table for many event IDs at once, grouped
 * by the foreign-key column. Uses chunked `IN (...)` queries to stay under
 * SQLite's bound-parameter ceiling. The `table`, `idColumn`, and `orderBy`
 * arguments are internal constants (never user input), so interpolating them
 * into SQL is safe; only `eventIds` are bound as parameters.
 */
function batchFetchRelated(
  db: DatabaseSync,
  eventIds: readonly string[],
  table: string,
  idColumn: string,
  orderBy: string,
): Map<string, Row[]> {
  const byEvent = new Map<string, Row[]>();
  if (eventIds.length === 0) return byEvent;
  for (let i = 0; i < eventIds.length; i += QUERY_BATCH_SIZE) {
    const chunk = eventIds.slice(i, i + QUERY_BATCH_SIZE);
    const placeholders = Array.from({ length: chunk.length }, () => "?").join(",");
    const stmt = prepareStatement(db,
      `SELECT * FROM ${table} WHERE ${idColumn} IN (${placeholders}) ORDER BY ${orderBy}`,
    );
    const fetched = stmt.all(...chunk) as Row[];
    for (const r of fetched) {
      const key = String(r[idColumn]);
      let list = byEvent.get(key);
      if (list === undefined) { list = []; byEvent.set(key, list); }
      list.push(r);
    }
  }
  return byEvent;
}

function buildWhere(defaultLedger: string, filter: Parameters<EventLedgerStoragePort["count"]>[0]): { sql: string; params: (string | number | bigint)[] } {
  const conditions: string[] = ["ledger_id = ?"];
  const params: (string | number | bigint)[] = [filter?.ledgerId ?? defaultLedger];
  if (filter !== undefined) {
    if (filter.errorCode !== undefined) { conditions.push("error_code = ?"); params.push(filter.errorCode); }
    if (filter.runId !== undefined) { conditions.push("run_id = ?"); params.push(filter.runId); }
    if (filter.runIds !== undefined) {
      // One bound JSON array keeps set membership independent of SQLite's
      // whole-statement host-variable ceiling. IN preserves duplicates as
      // set membership, and [] matches no rows. The same predicate serves
      // list/count, trace existence and spectrum before any aggregation.
      conditions.push("run_id IN (SELECT value FROM json_each(?))");
      params.push(JSON.stringify(filter.runIds));
    }
    if (filter.turnId !== undefined) { conditions.push("turn_id = ?"); params.push(filter.turnId); }
    if (filter.agentId !== undefined) { conditions.push("agent_id = ?"); params.push(filter.agentId); }
    if (filter.taskId !== undefined) { conditions.push("task_id = ?"); params.push(filter.taskId); }
    if (filter.eventType !== undefined) { conditions.push("event_type = ?"); params.push(filter.eventType); }
    if (filter.recordKind !== undefined) { conditions.push("record_kind = ?"); params.push(filter.recordKind); }
    if (filter.effectId !== undefined) { conditions.push("effect_id = ?"); params.push(filter.effectId); }
    // Trace scope. Equality, exactly like the correlation filters above, so it
    // ANDs with any of them and leaves ordering and the keyset cursor below
    // untouched — both still ride on `sequence`, which is unique per ledger.
    if (filter.traceId !== undefined) { conditions.push("trace_id = ?"); params.push(filter.traceId); }
    if (filter.fromSequence !== undefined) { conditions.push("sequence >= ?"); params.push(BigInt(filter.fromSequence)); }
    if (filter.toSequence !== undefined) { conditions.push("sequence <= ?"); params.push(BigInt(filter.toSequence)); }
    if (filter.fromWallTime !== undefined) { conditions.push("wall_time >= ?"); params.push(filter.fromWallTime); }
    if (filter.toWallTime !== undefined) { conditions.push("wall_time <= ?"); params.push(filter.toWallTime); }
    if (filter.cursor !== undefined) {
      // Keyset pagination. The comparison follows the sort direction so the
      // cursor always means "strictly after what I have already seen", and it
      // is applied to `sequence` — unique per ledger — so no row can be
      // skipped or repeated across pages, however many appends land between
      // them. `ascending` must be read the same way `doQuery` reads it or the
      // page boundary would walk the wrong way.
      const ascending = filter.ascending ?? true;
      conditions.push(ascending ? "sequence > ?" : "sequence < ?");
      params.push(BigInt(filter.cursor));
    }
  }
  return { sql: `WHERE ${conditions.join(" AND ")}`, params };
}

/**
 * One grouped lifetime count. Every statement here is a covering-index scan
 * (verified by the EXPLAIN assertions in timeline-coverage-counts.test.ts):
 * the grouped column is the leading column of an index and COUNT(*) needs no
 * other column, so no table row is fetched. This is exactly why these counts
 * are FILE-scoped — see the note on `TimelineOccurrenceCounts`.
 */
function groupedCounts(db: DatabaseSync, sql: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of prepareStatement(db, sql).all() as { k: unknown; c: number | bigint }[]) {
    counts[String(row.k)] = Number(row.c);
  }
  return counts;
}

function doOccurrenceCounts(db: DatabaseSync): TimelineOccurrenceCounts {
  const ledgerCounts = groupedCounts(
    db,
    "SELECT ledger_id AS k, COUNT(*) AS c FROM event_log GROUP BY ledger_id",
  );
  const edgeTypeCounts = groupedCounts(
    db,
    "SELECT edge_type AS k, COUNT(*) AS c FROM event_edges GROUP BY edge_type",
  );
  // Derived sums, not extra queries: ledger_id and edge_type are NOT NULL, so
  // every row is in exactly one group and the group totals ARE the totals.
  let totalEvents = 0;
  const ledgers = Object.entries(ledgerCounts).map(([ledgerId, events]) => {
    totalEvents += events;
    return { ledgerId, events };
  });
  let edgeRows = 0;
  for (const c of Object.values(edgeTypeCounts)) edgeRows += c;
  return deepFreeze({
    totalEvents,
    ledgers,
    eventTypeCounts: groupedCounts(
      db,
      "SELECT event_type AS k, COUNT(*) AS c FROM event_log GROUP BY event_type",
    ),
    recordKindCounts: groupedCounts(
      db,
      "SELECT record_kind AS k, COUNT(*) AS c FROM event_log GROUP BY record_kind",
    ),
    edgeTypeCounts,
    edgeRows,
  });
}

function doRecordingGapCounts(
  db: DatabaseSync,
  eventType: TimelineEventType | undefined,
): TimelineRecordingGapCounts {
  const one = (sql: string, ...params: string[]): number => {
    const row = prepareStatement(db, sql).get(...params) as { c: number | bigint } | undefined;
    return row === undefined ? 0 : Number(row.c);
  };
  if (eventType !== undefined) {
    // Deny-by-default: an untyped caller passing an undeclared event type is
    // refused, not answered with a plausible 0 for a vocabulary that does not
    // exist. Same check every append path applies.
    if (!isTimelineEventType(eventType)) {
      throw new InputError("Timeline event type is invalid", "timeline_event_type_invalid");
    }
    // All three are bounded searches of idx_event_log_event_type: only rows
    // of the requested type are visited.
    return deepFreeze({
      events: one("SELECT COUNT(*) AS c FROM event_log WHERE event_type = ?", eventType),
      withoutRun: one(
        "SELECT COUNT(*) AS c FROM event_log WHERE event_type = ? AND run_id IS NULL",
        eventType,
      ),
      withoutTrace: one(
        "SELECT COUNT(*) AS c FROM event_log WHERE event_type = ? AND trace_id IS NULL",
        eventType,
      ),
    });
  }
  // Whole-file: `run_id IS NULL` is a covering IS-NULL search of
  // idx_event_log_run. There is no bare trace index, so the trace gap rides
  // the composite (ledger_id, trace_id, sequence) index instead — a covering
  // search per ledger, summed; the ledger list itself is a covering scan of
  // idx_event_log_ledger_seq. The total equals the whole-file count because
  // ledger_id is NOT NULL.
  let events = 0;
  let withoutTrace = 0;
  for (const row of prepareStatement(db, "SELECT ledger_id AS k, COUNT(*) AS c FROM event_log GROUP BY ledger_id")
    .all() as { k: unknown; c: number | bigint }[]) {
    events += Number(row.c);
    withoutTrace += one(
      "SELECT COUNT(*) AS c FROM event_log WHERE ledger_id = ? AND trace_id IS NULL",
      String(row.k),
    );
  }
  return deepFreeze({
    events,
    withoutRun: one("SELECT COUNT(*) AS c FROM event_log WHERE run_id IS NULL"),
    withoutTrace,
  });
}

// ── Synthesis facts: per-run activity + decoded file-change records ────────
//
// The exact-join reads behind the web UI's SYNTHESIS blocks. Same cost
// doctrine as the coverage counts above: every statement is index-backed
// (EXPLAIN-asserted in timeline-synthesis-facts.test.ts), and ordering /
// grouping happens in JS over the bounded row sets rather than through a
// TEMP B-TREE sort pass in SQLite.

/** Deny-by-default ceilings for the synthesis reads. */
const MAXIMUM_SUMMARY_RUNS = 500;
const MAXIMUM_FACT_PATHS = 200;
const MAXIMUM_FACT_PATH_CHARACTERS = 4096;
const DEFAULT_FACT_LIMIT = 2000;
const MAXIMUM_FACT_LIMIT = 10000;

/** Decode one `effect` document to a plain object; undefined when it is not one. */
function decodeEffectDocument(contentJson: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

function doRunActivitySummaries(
  db: DatabaseSync,
  runIds: readonly string[],
): readonly TimelineRunActivitySummary[] {
  if (runIds.length > MAXIMUM_SUMMARY_RUNS) {
    throw new InputError("Timeline run summary run count exceeds ceiling", "timeline_run_summary_runs_exceeded");
  }
  // Both statements are bounded searches of idx_event_log_run; aggregation is
  // JS over the run's own rows so no grouping pass is pushed to SQLite.
  const rowsStmt = prepareStatement(db,
    "SELECT sequence, event_type, description, outcome, error_code, wall_time FROM event_log WHERE run_id = ?",
  );
  const usageStmt = prepareStatement(db,
    "SELECT e.sequence AS sequence, d.content_json AS content_json FROM event_log e " +
      "JOIN event_documents d ON d.event_id = e.event_id AND d.name = ? " +
      "WHERE e.run_id = ? AND e.event_type = ?",
  );
  const seen = new Set<string>();
  const summaries: TimelineRunActivitySummary[] = [];
  for (const raw of runIds) {
    const runId = validateId(raw, "timeline_run_id_invalid");
    if (seen.has(runId)) continue;
    seen.add(runId);
    const rows = rowsStmt.all(runId) as Row[];
    if (rows.length === 0) continue; // proven absence: the indexed search ran and matched nothing
    const eventTypeCounts: Record<string, number> = {};
    const toolDescriptionCounts: Record<string, number> = {};
    let errorEvents = 0;
    let failedOutcomes = 0;
    let firstWallTime = String(rows[0]?.wall_time);
    let lastWallTime = firstWallTime;
    let firstSequence = BigInt(rows[0]?.sequence as number | bigint);
    let lastSequence = firstSequence;
    for (const row of rows) {
      const eventType = String(row.event_type);
      eventTypeCounts[eventType] = (eventTypeCounts[eventType] ?? 0) + 1;
      if (eventType === "tool") {
        const description = String(row.description);
        toolDescriptionCounts[description] = (toolDescriptionCounts[description] ?? 0) + 1;
      }
      if (row.error_code !== null) errorEvents += 1;
      if (row.outcome !== null && String(row.outcome) === "failed") failedOutcomes += 1;
      const wallTime = String(row.wall_time);
      if (wallTime < firstWallTime) firstWallTime = wallTime;
      if (wallTime > lastWallTime) lastWallTime = wallTime;
      const sequence = BigInt(row.sequence as number | bigint);
      if (sequence < firstSequence) firstSequence = sequence;
      if (sequence > lastSequence) lastSequence = sequence;
    }
    let samples = 0;
    let unparsedDocuments = 0;
    let promptTokensSum = 0;
    let completionTokensSum = 0;
    let totalTokensSum = 0;
    let first: { sequence: bigint; promptTokens: number } | undefined;
    let last: { sequence: bigint; promptTokens: number } | undefined;
    for (const row of usageStmt.all(TIMELINE_TOKEN_USAGE_DOCUMENT, runId, "token") as Row[]) {
      // The ONE usage decoder (the vocabulary module's owner) — the same
      // decoder the dig reader consumes, so a document that decodes for one
      // reader decodes for both.
      const usage = decodeTokenUsageDocument(String(row.content_json));
      if (usage === undefined) {
        unparsedDocuments += 1;
        continue;
      }
      samples += 1;
      promptTokensSum += usage.promptTokens;
      completionTokensSum += usage.completionTokens;
      totalTokensSum += usage.totalTokens;
      const sequence = BigInt(row.sequence as number | bigint);
      if (first === undefined || sequence < first.sequence) first = { sequence, promptTokens: usage.promptTokens };
      if (last === undefined || sequence > last.sequence) last = { sequence, promptTokens: usage.promptTokens };
    }
    const tokenUsage: TimelineRunTokenUsage = {
      samples,
      unparsedDocuments,
      promptTokensSum,
      completionTokensSum,
      totalTokensSum,
      first: first === undefined ? null : { sequence: first.sequence.toString(10), promptTokens: first.promptTokens },
      last: last === undefined ? null : { sequence: last.sequence.toString(10), promptTokens: last.promptTokens },
    };
    summaries.push({
      runId,
      events: rows.length,
      eventTypeCounts,
      toolDescriptionCounts,
      errorEvents,
      failedOutcomes,
      firstWallTime,
      lastWallTime,
      firstSequence: firstSequence.toString(10),
      lastSequence: lastSequence.toString(10),
      tokenUsage,
    });
  }
  return deepFreeze(summaries);
}

function doFileEffectFacts(
  db: DatabaseSync,
  filter: TimelineFileEffectFactsFilter,
): TimelineFileEffectFacts {
  const runIds = filter.runIds ?? [];
  const paths = filter.paths ?? [];
  if (runIds.length === 0 && paths.length === 0) {
    // Deny-by-default: there is no "all file effects" content read.
    throw new InputError("Timeline file-effect facts need runIds or paths", "timeline_file_effect_scope_missing");
  }
  if (paths.length > MAXIMUM_FACT_PATHS) {
    throw new InputError("Timeline file-effect paths exceed ceiling", "timeline_file_effect_paths_exceeded");
  }
  for (const path of paths) {
    if (typeof path !== "string" || path.length === 0 || path.length > MAXIMUM_FACT_PATH_CHARACTERS) {
      throw new InputError("Timeline file-effect path is invalid", "timeline_file_effect_path_invalid");
    }
  }
  const limit = filter.limit ?? DEFAULT_FACT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAXIMUM_FACT_LIMIT) {
    throw new InputError("Timeline file-effect limit is invalid", "timeline_file_effect_limit_invalid");
  }
  const pathSet = paths.length > 0 ? new Set(paths) : undefined;

  // LEFT JOIN so a file-effect event whose `effect` document is missing is
  // still examined (and counted undecodable) rather than silently absent.
  const selectColumns =
    "SELECT e.event_id AS event_id, e.sequence AS sequence, e.run_id AS run_id, e.trace_id AS trace_id, " +
    "e.wall_time AS wall_time, e.description AS description, d.content_json AS content_json " +
    "FROM event_log e LEFT JOIN event_documents d ON d.event_id = e.event_id AND d.name = ? ";
  let rows: Row[];
  if (runIds.length > 0) {
    // Run-driven: bounded searches of idx_event_log_run, chunked to stay
    // under the bound-parameter ceiling. event_type is a residual filter.
    rows = [];
    const deduped = [...new Set(runIds.map((raw) => validateId(raw, "timeline_run_id_invalid")))];
    for (let i = 0; i < deduped.length; i += QUERY_BATCH_SIZE) {
      const chunk = deduped.slice(i, i + QUERY_BATCH_SIZE);
      const placeholders = Array.from({ length: chunk.length }, () => "?").join(",");
      const stmt = prepareStatement(db,
        `${selectColumns}WHERE e.run_id IN (${placeholders}) AND e.event_type = ?`,
      );
      rows.push(...(stmt.all(TIMELINE_FILE_EFFECT_DOCUMENT, ...chunk, "file-effect") as Row[]));
    }
  } else {
    // Path-driven: bounded search of idx_event_log_event_type — the read
    // visits exactly the file-effect events in the file, never the whole
    // table. Path matching happens on the DECODED document below, so an
    // undecodable effect is counted, not mistaken for a non-match.
    rows = prepareStatement(db, `${selectColumns}WHERE e.event_type = ?`)
      .all(TIMELINE_FILE_EFFECT_DOCUMENT, "file-effect") as Row[];
  }

  // A raw writer could attach several documents named `effect` to one event;
  // the recorder writes exactly one. Keep the first per event so a corrupt
  // row cannot multiply into several "facts".
  const seenEvents = new Set<string>();
  let undecodableEffects = 0;
  let examined = 0;
  const matched: (TimelineFileEffectFact & { readonly seq: bigint })[] = [];
  for (const row of rows) {
    const eventId = String(row.event_id);
    if (seenEvents.has(eventId)) continue;
    seenEvents.add(eventId);
    examined += 1;
    const contentJson = row.content_json;
    const decoded: Record<string, unknown> | undefined =
      contentJson === null || contentJson === undefined
        ? undefined
        : decodeEffectDocument(String(contentJson));
    const path = decoded?.path;
    const operation = decoded?.operation;
    if (typeof path !== "string" || path.length === 0 || typeof operation !== "string") {
      undecodableEffects += 1;
      continue;
    }
    if (pathSet !== undefined && !pathSet.has(path)) continue;
    const seq = BigInt(row.sequence as number | bigint);
    matched.push({
      eventId,
      sequence: seq.toString(10),
      runId: row.run_id === null ? null : String(row.run_id),
      traceId: row.trace_id === null ? null : String(row.trace_id),
      wallTime: String(row.wall_time),
      path,
      operation,
      description: String(row.description),
      seq,
    });
  }
  // Ledger order in JS — no ORDER BY, so the statement plan stays a pure
  // index search with no TEMP B-TREE (asserted by the plan test).
  matched.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
  const truncated = matched.length > limit;
  const facts = matched.slice(0, limit).map(({ seq: _seq, ...fact }) => {
    void _seq;
    return fact;
  });
  return deepFreeze({
    facts,
    fileEffectEventsExamined: examined,
    undecodableEffects,
    truncated,
  });
}

/**
 * Decoded check-status history — the read behind `checksFlipped`.
 *
 * COST (EXPLAIN-asserted in timeline-synthesis-facts.test.ts, same idiom as
 * `doFileEffectFacts`):
 * - run-driven: chunked bounded searches of `idx_event_log_run`, with
 *   `event_type = 'quality'` as a residual predicate on the visited rows;
 * - chat-driven: a bounded search of `idx_event_log_event_type` visiting
 *   exactly the `quality` events in the file — chat matching happens on the
 *   DECODED document (the ledger has no chat column), so an undecodable
 *   event is counted, never mistaken for a non-match.
 * Ledger ordering happens in JS, so no statement needs a TEMP B-TREE.
 */
function doCheckStatusFacts(
  db: DatabaseSync,
  filter: TimelineCheckStatusFactsFilter,
): TimelineCheckStatusFacts {
  const runIds = filter.runIds ?? [];
  const chatIds = filter.chatIds ?? [];
  if (runIds.length === 0 && chatIds.length === 0) {
    // Deny-by-default: there is no "all check history" content read.
    throw new InputError("Timeline check-status facts need runIds or chatIds", "timeline_check_status_scope_missing");
  }
  for (const chatId of chatIds) {
    validateId(chatId, "timeline_check_status_chat_id_invalid");
  }
  const limit = filter.limit ?? DEFAULT_FACT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAXIMUM_FACT_LIMIT) {
    throw new InputError("Timeline check-status limit is invalid", "timeline_check_status_limit_invalid");
  }
  const runIdSet = new Set(runIds.map((raw) => validateId(raw, "timeline_run_id_invalid")));
  const chatIdSet = new Set(chatIds);

  // LEFT JOIN so a quality event whose `check-status` document is missing is
  // still examined (and counted undecodable) rather than silently absent.
  const selectColumns =
    "SELECT e.event_id AS event_id, e.sequence AS sequence, e.run_id AS run_id, " +
    "e.wall_time AS wall_time, d.content_json AS content_json " +
    "FROM event_log e LEFT JOIN event_documents d ON d.event_id = e.event_id AND d.name = ? ";
  let rows: Row[];
  if (chatIdSet.size > 0) {
    // Chat matching needs the decoded document, so the visit set is every
    // quality event (event-type-bounded). Run-attributed matches for the
    // union arrive in the same pass — run_id is a selected column.
    rows = prepareStatement(db, `${selectColumns}WHERE e.event_type = ?`)
      .all(TIMELINE_CHECK_STATUS_DOCUMENT, "quality") as Row[];
  } else {
    // Run-driven only: bounded searches of idx_event_log_run, chunked to
    // stay under the bound-parameter ceiling.
    rows = [];
    const deduped = [...runIdSet];
    for (let i = 0; i < deduped.length; i += QUERY_BATCH_SIZE) {
      const chunk = deduped.slice(i, i + QUERY_BATCH_SIZE);
      const placeholders = Array.from({ length: chunk.length }, () => "?").join(",");
      const stmt = prepareStatement(db,
        `${selectColumns}WHERE e.run_id IN (${placeholders}) AND e.event_type = ?`,
      );
      rows.push(...(stmt.all(TIMELINE_CHECK_STATUS_DOCUMENT, ...chunk, "quality") as Row[]));
    }
  }

  const seenEvents = new Set<string>();
  let undecodableCheckEvents = 0;
  let examined = 0;
  const matched: (TimelineCheckStatusFact & { readonly seq: bigint })[] = [];
  for (const row of rows) {
    const eventId = String(row.event_id);
    if (seenEvents.has(eventId)) continue;
    seenEvents.add(eventId);
    examined += 1;
    const contentJson = row.content_json;
    const decoded: Record<string, unknown> | undefined =
      contentJson === null || contentJson === undefined
        ? undefined
        : decodeEffectDocument(String(contentJson));
    const checkName = decoded?.checkName;
    const toStatus = decoded?.toStatus;
    const fromStatus = decoded?.fromStatus;
    const chatId = decoded?.chatId;
    if (typeof checkName !== "string" || checkName.length === 0 || typeof toStatus !== "string" || toStatus.length === 0) {
      undecodableCheckEvents += 1;
      continue;
    }
    const runId = row.run_id === null ? null : String(row.run_id);
    const factChatId = typeof chatId === "string" && chatId.length > 0 ? chatId : null;
    // UNION semantics: attributed to one of the runs OR recorded against one
    // of the chats. (When only runIds were given, the SQL already bounded the
    // visit to those runs, so the predicate is trivially true.)
    const inRunScope = runId !== null && runIdSet.has(runId);
    const inChatScope = factChatId !== null && chatIdSet.has(factChatId);
    if (!inRunScope && !inChatScope) continue;
    const seq = BigInt(row.sequence as number | bigint);
    matched.push({
      eventId,
      sequence: seq.toString(10),
      runId,
      wallTime: String(row.wall_time),
      checkName,
      fromStatus: typeof fromStatus === "string" && fromStatus.length > 0 ? fromStatus : null,
      toStatus,
      chatId: factChatId,
      seq,
    });
  }
  matched.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
  const truncated = matched.length > limit;
  const facts = matched.slice(0, limit).map(({ seq: _seq, ...fact }) => {
    void _seq;
    return fact;
  });
  return deepFreeze({
    facts,
    checkEventsExamined: examined,
    undecodableCheckEvents,
    truncated,
  });
}

// ── Spectrum: time-binned density counts (the SWEEP aggregation) ───────────

/**
 * Fold the matched events into `bins` equal-width time bins, counted per
 * event type, with a parallel per-bin count of recorded failure (outcome
 * `failed` OR non-null `error_code`).
 *
 * COST — index-backed at every scope (EXPLAIN-asserted in
 * timeline-spectrum.test.ts):
 *
 * - run-scoped (`runIds`): the shared bound-set predicate; the query planner
 *   chooses an indexed ledger/run search with residual time predicates.
 * - time/current-ledger: an indexed ledger search with time predicates.
 *   The actual emitted statements are plan-tested; ledger isolation means
 *   the old whole-file covering-index-only claim no longer applies.
 *
 * Binning and grouping happen in JS over the matched rows (the store's
 * standing doctrine — no GROUP BY, so no TEMP B-TREE pass), and the bin
 * width derives from the OBSERVED first/last wall time, so the caller
 * renders the range that was measured, never a padded invention.
 */
function doSpectrum(db: DatabaseSync, ledgerId: string, filter: TimelineSpectrumFilter): TimelineSpectrum {
  const bins = filter.bins;
  if (!Number.isInteger(bins) || bins < 1 || bins > SPECTRUM_MAX_BINS) {
    throw new InputError("Timeline spectrum bins is invalid", "timeline_spectrum_bins_invalid");
  }
  const where = buildWhere(ledgerId, {
    ...(filter.traceId !== undefined ? { traceId: validateId(filter.traceId, "timeline_trace_id_invalid") } : {}),
    ...(filter.runIds !== undefined ? { runIds: filter.runIds.map((raw) => validateId(raw, "timeline_run_id_invalid")) } : {}),
    ...(filter.fromWallTime !== undefined ? { fromWallTime: filter.fromWallTime } : {}),
    ...(filter.toWallTime !== undefined ? { toWallTime: filter.toWallTime } : {}),
  });
  const rows = prepareStatement(db,
    `SELECT wall_time, event_type, outcome, error_code FROM event_log ${where.sql}`,
  ).all(...where.params) as Row[];

  // First pass: parse times, find the observed range. A wall_time that does
  // not parse cannot be placed in any bin; it is COUNTED (`unbinnable`),
  // never silently dropped.
  type Parsed = Readonly<{ at: number; eventType: string; failed: boolean }>;
  const parsed: Parsed[] = [];
  let unbinnable = 0;
  let t0Ms = Number.POSITIVE_INFINITY;
  let t1Ms = Number.NEGATIVE_INFINITY;
  let t0 = "";
  let t1 = "";
  for (const row of rows) {
    const wallTime = String(row.wall_time);
    const at = Date.parse(wallTime);
    if (!Number.isFinite(at)) {
      unbinnable += 1;
      continue;
    }
    if (at < t0Ms) { t0Ms = at; t0 = wallTime; }
    if (at > t1Ms) { t1Ms = at; t1 = wallTime; }
    parsed.push({
      at,
      eventType: String(row.event_type),
      failed: (row.outcome !== null && String(row.outcome) === "failed") || row.error_code !== null,
    });
  }

  if (parsed.length === 0) {
    return deepFreeze({
      events: rows.length,
      unbinnable,
      t0: null,
      t1: null,
      binMs: 0,
      bins,
      eventTypeBins: {},
      errorBins: [],
    });
  }

  // Bin width from the OBSERVED span. The +1 puts the last event inside the
  // last bin (a span of exactly binMs*bins would otherwise index one past
  // the end); minimum 1 so a single-instant spectrum still has a width.
  const binMs = Math.max(1, Math.ceil((t1Ms - t0Ms + 1) / bins));
  const eventTypeBins: Record<string, number[]> = {};
  const errorBins: number[] = Array.from({ length: bins }, () => 0);
  for (const event of parsed) {
    const bin = Math.min(bins - 1, Math.floor((event.at - t0Ms) / binMs));
    let typeRow = eventTypeBins[event.eventType];
    if (typeRow === undefined) {
      typeRow = Array.from({ length: bins }, () => 0);
      eventTypeBins[event.eventType] = typeRow;
    }
    typeRow[bin] = (typeRow[bin] ?? 0) + 1;
    if (event.failed) errorBins[bin] = (errorBins[bin] ?? 0) + 1;
  }

  return deepFreeze({
    events: rows.length,
    unbinnable,
    t0,
    t1,
    binMs,
    bins,
    eventTypeBins,
    errorBins,
  });
}

function doVerifyChain(db: DatabaseSync, ledgerId: string): TimelineChainVerification {
  const rows = prepareStatement(db,
    `SELECT ledger_id, event_id, record_kind, event_type, effect_kind, effect_id, observation_id, outcome, wall_time,
            actor_kind, actor_id, actor_role, description, sequence, previous_chain_hash, chain_hash,
            run_id, session_id, turn_id, message_id, task_id, attempt_id, agent_id, parent_effect_id,
            monotonic_ns, trace_id, span_id, parent_event_id, intent_hash, result_hash, evidence_hash,
            error_category, error_code, error_message, error_retryable,
            payload_ref, payload_digest
     FROM event_log WHERE ledger_id = ? ORDER BY sequence ASC`,
  ).iterate(ledgerId);
  let expected = GENESIS_SEQUENCE;
  let prev = ZERO_CHAIN_HASH;
  let verified = 0;
  try {
    // Keep the native read cursor local and synchronous. No callbacks or
    // writes run between steps; other connections see their own snapshots.
    for (;;) {
      const next = rows.next();
      if (next.done) break;
      const row = next.value as Row;
      const seq = BigInt(row.sequence as number | bigint);
      if (seq !== expected) return chainFail("sequence", verified, seq.toString(10));
      if (String(row.previous_chain_hash) !== prev) return chainFail("previous-hash", verified, seq.toString(10));
      if (!hasCanonicalErrorTuple(row)) return chainFail("tamper", verified, seq.toString(10));
      if (recompute(row) !== String(row.chain_hash)) return chainFail("record-hash", verified, seq.toString(10));
      prev = String(row.chain_hash);
      expected += 1n;
      verified += 1;
    }
    return Object.freeze({ valid: true, verifiedRecords: verified, ...(verified === 0 ? { code: "empty" as const } : {}) });
  } finally {
    // Native Next resets on exhaustion, but not on every step/extraction
    // error. Return resets the statement on normal, early and thrown exits.
    // The pinned native iterator guarantees Return; the generic TS iterator
    // type makes it optional, but cleanup here is required.
    rows.return!();
  }
}

function chainFail(code: "previous-hash" | "record-hash" | "sequence" | "tamper", verified: number, at: string): TimelineChainVerification {
  return Object.freeze({ valid: false, verifiedRecords: verified, breakAtSequence: at, code });
}

/** SQL null/boolean aliases must not disappear through hash reconstruction. */
function hasCanonicalErrorTuple(row: Row): boolean {
  const values = [row.error_category, row.error_code, row.error_message, row.error_retryable];
  if (values.every((value) => value === null)) return true;
  if (typeof row.error_category !== "string" || typeof row.error_code !== "string" || typeof row.error_message !== "string" ||
      (row.error_retryable !== 0 && row.error_retryable !== 1 && row.error_retryable !== 0n && row.error_retryable !== 1n)) return false;
  try {
    validateErr({ category: row.error_category, code: row.error_code, message: row.error_message, retryable: Number(row.error_retryable) === 1 });
    return true;
  } catch { return false; }
}

function recompute(row: Row): string {
  const seq = BigInt(row.sequence as number | bigint);
  const e: Record<string, unknown> = {
    schemaVersion: TIMELINE_SCHEMA_VERSION,
    ledgerId: String(row.ledger_id ?? ""),
    sequence: formatSequence(seq),
    recordKind: String(row.record_kind),
    eventType: String(row.event_type),
    eventId: String(row.event_id),
    wallTime: String(row.wall_time),
    actor: { kind: String(row.actor_kind), id: String(row.actor_id) },
    description: String(row.description),
    previousChainHash: "",
  };
  if (row.actor_role !== null) (e.actor as Record<string, unknown>).role = String(row.actor_role);
  const opt: Array<readonly [string, unknown]> = [
    ["effectKind", row.effect_kind], ["effectId", row.effect_id], ["observationId", row.observation_id],
    ["outcome", row.outcome], ["monotonicNanoseconds", row.monotonic_ns], ["traceId", row.trace_id],
    ["spanId", row.span_id], ["parentEventId", row.parent_event_id], ["intentHash", row.intent_hash],
    ["resultHash", row.result_hash], ["evidenceHash", row.evidence_hash],
  ];
  for (const [k, v] of opt) { if (v !== null) e[k] = String(v); }
  if (row.payload_ref !== null) e.payloadRef = String(row.payload_ref);
  if (row.payload_digest !== null) e.payloadDigest = String(row.payload_digest);
  if (row.error_category !== null) {
    e.error = deepFreeze({
      category: String(row.error_category),
      code: String(row.error_code),
      message: String(row.error_message),
      retryable: Number(row.error_retryable) !== 0,
    });
  }
  const corr: Record<string, string> = {};
  const fields: Array<readonly [string, string]> = [
    ["runId", "run_id"], ["sessionId", "session_id"], ["turnId", "turn_id"],
    ["messageId", "message_id"], ["taskId", "task_id"], ["attemptId", "attempt_id"],
    ["agentId", "agent_id"], ["parentEffectId", "parent_effect_id"],
  ];
  for (const [camel, snake] of fields) { if (row[snake] !== null) corr[camel] = String(row[snake]); }
  if (Object.keys(corr).length > 0) e.correlation = deepFreeze(corr);
  return computeChainHash(TIMELINE_DOMAIN, String(row.previous_chain_hash), deepFreeze(e));
}

function doRebuildProjections(db: DatabaseSync, ledgerId: string, state: WriteState): void {
  writeTransaction(db, state, () => {
    prepareStatement(db, "DELETE FROM timeline_projection WHERE ledger_id = ?").run(ledgerId);
    prepareStatement(db, "DELETE FROM projection_offsets WHERE source_ledger_id = ?").run(ledgerId);
    const columns = PROJECTION_COLUMNS.join(", ");
    prepareStatement(db, `
      INSERT INTO timeline_projection (${columns})
      SELECT ${columns}
      FROM event_log WHERE ledger_id = ? ORDER BY sequence ASC
    `).run(ledgerId);
    const last = prepareStatement(db, `SELECT sequence, chain_hash FROM event_log WHERE ledger_id = ? ORDER BY sequence DESC LIMIT 1`).get(ledgerId) as { sequence: bigint; chain_hash: string } | undefined;
    prepareStatement(db, `INSERT INTO projection_offsets (projection_name, source_ledger_id, source_sequence, chain_mac) VALUES ('timeline_projection', ?, ?, ?)`).run(ledgerId, last?.sequence ?? 0n, last?.chain_hash ?? ZERO_CHAIN_HASH);
  });
}

function validateIntentInput(input: TimelineIntentInput, ledgerId: string, limits: TimelineLimits): void {
  validateId(input.eventId, "timeline_event_id_invalid");
  if (input.ledgerId !== ledgerId) throw new InputError("Timeline intent ledger mismatch", "timeline_ledger_mismatch");
  if (!isTimelineEventType(input.eventType)) throw new InputError("Timeline event type is invalid", "timeline_event_type_invalid");
  validateId(input.effectKind, "timeline_effect_kind_invalid");
  validateId(input.effectId, "timeline_effect_id_invalid");
  validateActor(input.actor);
  if (input.correlation !== undefined) validateCorr(input.correlation);
  validateDesc(input.description);
  validateHash(input.intentHash, "timeline_intent_hash_invalid");
  validateTs(input.wallTime, input.monotonicNanoseconds);
  if (input.traceId !== undefined) validateId(input.traceId, "timeline_trace_id_invalid");
  if (input.spanId !== undefined) validateId(input.spanId, "timeline_span_id_invalid");
  if (input.parentEventId !== undefined) validateId(input.parentEventId, "timeline_parent_event_id_invalid");
  if (input.documents !== undefined) validateDocs(input.documents, limits);
  if (input.edges !== undefined) validateEdges(input.edges, limits);
}

function validateTerminalInput(input: TimelineTerminalInput, ledgerId: string, limits: TimelineLimits): void {
  assertTerminalProvenanceAbsent(input);
  validateId(input.eventId, "timeline_event_id_invalid");
  if (input.ledgerId !== ledgerId) throw new InputError("Timeline terminal ledger mismatch", "timeline_ledger_mismatch");
  if (!isTimelineEventType(input.eventType)) throw new InputError("Timeline event type is invalid", "timeline_event_type_invalid");
  validateId(input.effectId, "timeline_effect_id_invalid");
  if (!isTimelineOutcome(input.outcome) || (input.outcome as string) === "pending") {
    throw new InputError("Timeline terminal outcome is invalid", "timeline_outcome_invalid");
  }
  validateHash(input.resultHash, "timeline_result_hash_invalid");
  if (input.error !== undefined) validateErr(input.error);
  validateTs(input.wallTime, input.monotonicNanoseconds);
  if (input.documents !== undefined) validateDocs(input.documents, limits);
  if (input.edges !== undefined) validateEdges(input.edges, limits);
}

function validateObservationInput(input: TimelineObservationInput, ledgerId: string, limits: TimelineLimits): void {
  validateId(input.eventId, "timeline_event_id_invalid");
  if (input.ledgerId !== ledgerId) throw new InputError("Timeline observation ledger mismatch", "timeline_ledger_mismatch");
  if (!isTimelineEventType(input.eventType)) throw new InputError("Timeline event type is invalid", "timeline_event_type_invalid");
  validateId(input.observationId, "timeline_observation_id_invalid");
  if (input.effectId !== undefined) validateId(input.effectId, "timeline_effect_id_invalid");
  validateActor(input.actor);
  if (input.correlation !== undefined) validateCorr(input.correlation);
  if (input.traceId !== undefined) validateId(input.traceId, "timeline_trace_id_invalid");
  if (input.spanId !== undefined) validateId(input.spanId, "timeline_span_id_invalid");
  if (input.parentEventId !== undefined) validateId(input.parentEventId, "timeline_parent_event_id_invalid");
  validateHash(input.evidenceHash, "timeline_evidence_hash_invalid");
  validateTs(input.wallTime, input.monotonicNanoseconds);
  if (input.documents !== undefined) validateDocs(input.documents, limits);
  if (input.edges !== undefined) validateEdges(input.edges, limits);
}

function validateStandaloneInput(input: TimelineStandaloneEventInput, ledgerId: string, limits: TimelineLimits): void {
  validateId(input.eventId, "timeline_event_id_invalid");
  if (input.ledgerId !== ledgerId) throw new InputError("Timeline event ledger mismatch", "timeline_ledger_mismatch");
  if (!isTimelineEventType(input.eventType)) throw new InputError("Timeline event type is invalid", "timeline_event_type_invalid");
  validateActor(input.actor);
  if (input.correlation !== undefined) validateCorr(input.correlation);
  validateDesc(input.description);
  validateTs(input.wallTime, input.monotonicNanoseconds);
  rejectFlattenedError(input);
  // The same check `appendTerminal` applies. Standalone events used to skip it
  // entirely, which is how `code: "unknown"` / `message: ""` reached the chain
  // hash: nothing on this path ever asserted the summary was complete.
  if (input.error !== undefined) validateErr(input.error);
  if (input.traceId !== undefined) validateId(input.traceId, "timeline_trace_id_invalid");
  if (input.spanId !== undefined) validateId(input.spanId, "timeline_span_id_invalid");
  if (input.parentEventId !== undefined) validateId(input.parentEventId, "timeline_parent_event_id_invalid");
  if (input.payloadRef !== undefined) validateId(input.payloadRef, "timeline_payload_ref_invalid");
  if (input.payloadDigest !== undefined) validateHash(input.payloadDigest, "timeline_payload_digest_invalid");
  if (input.documents !== undefined) validateDocs(input.documents, limits);
  if (input.edges !== undefined) validateEdges(input.edges, limits);
}

/**
 * The four flat error fields this input used to carry are GONE, replaced by a
 * single `error: TimelineErrorSummary`. The type system stops a TypeScript
 * caller from passing them; this stops everyone else.
 *
 * Without it the removal would have re-created the very defect it repairs, in
 * a quieter form: an untyped or `as`-cast caller passing `{ errorCode }` would
 * hit an input shape that simply has no such property, so the code would be
 * dropped with no failure — which is exactly what the old
 * `errorCategory !== undefined ? ... : undefined` did. Deny-by-default means
 * an unrecognised error field is a typed rejection naming its replacement, not
 * a silent no-op.
 */
function rejectFlattenedError(input: TimelineStandaloneEventInput): void {
  const candidate = input as unknown as Record<string, unknown>;
  for (const legacy of ["errorCategory", "errorCode", "errorMessage", "errorRetryable"]) {
    if (candidate[legacy] !== undefined) {
      throw new InputError(
        `Timeline event carries flattened error field "${legacy}"; pass a complete "error" summary instead`,
        "timeline_error_flattened",
      );
    }
  }
}

function validateActor(actor: unknown): asserts actor is TimelineActor {
  if (actor === null || typeof actor !== "object" || Array.isArray(actor)) throw new InputError("Timeline actor is invalid", "timeline_actor_invalid");
  const r = actor as Record<string, unknown>;
  validateId(r.kind, "timeline_actor_invalid");
  validateId(r.id, "timeline_actor_invalid");
  if (r.role !== undefined) validateId(r.role, "timeline_actor_invalid");
}

function validateCorr(corr: unknown): asserts corr is TimelineCorrelation {
  if (corr === null || typeof corr !== "object" || Array.isArray(corr)) throw new InputError("Timeline correlation is invalid", "timeline_correlation_invalid");
  const r = corr as Record<string, unknown>;
  if (Object.keys(r).length > MAXIMUM_CORRELATION_FIELDS) throw new InputError("Timeline correlation exceeds field ceiling", "timeline_correlation_invalid");
  for (const k of Object.keys(r)) {
    if (!(CORRELATION_FIELD_NAMES as readonly string[]).includes(k)) throw new InputError("Timeline correlation field is invalid", "timeline_correlation_invalid");
    validateId(r[k], "timeline_correlation_invalid");
  }
}

function validateErr(err: unknown): asserts err is TimelineErrorSummary {
  if (err === null || typeof err !== "object" || Array.isArray(err)) throw new InputError("Timeline error summary is invalid", "timeline_error_invalid");
  const r = err as Record<string, unknown>;
  validateId(r.category, "timeline_error_invalid");
  validateId(r.code, "timeline_error_invalid");
  if (typeof r.message !== "string" || r.message.length === 0 || Buffer.byteLength(r.message, "utf8") > MAXIMUM_DESCRIPTION_BYTES) throw new InputError("Timeline error message is invalid", "timeline_error_invalid");
  if (typeof r.retryable !== "boolean") throw new InputError("Timeline error retryable flag is invalid", "timeline_error_invalid");
}

function validateDocs(docs: readonly unknown[], limits: TimelineLimits): void {
  if (docs.length > limits.maxDocuments) throw new InputError("Timeline documents exceed ceiling", "timeline_documents_exceeded");
  for (const document of docs) {
    assertTimelineDocument(document, limits.maxDocumentBytes);
    // A document's name is how readers find it (a rollback looks up
    // `preimage`): an identity, stored exactly, so a sensitive one is refused.
    if (detectProtocolIdentitySensitiveSpans(document.name).length !== 0) throw new SecurityError("Sensitive material cannot be used as a timeline document name", "timeline_sensitive_identifier");
  }
}

function validateEdges(edges: readonly unknown[], limits: TimelineLimits): void {
  if (edges.length > limits.maxEdges) throw new InputError("Timeline edges exceed ceiling", "timeline_edges_exceeded");
  for (const e of edges) {
    if (e === null || typeof e !== "object" || Array.isArray(e)) throw new InputError("Timeline edge is invalid", "timeline_edge_invalid");
    const r = e as Record<string, unknown>;
    if (typeof r.edgeType !== "string" || !isTimelineEdgeType(r.edgeType)) throw new InputError("Timeline edge type is invalid", "timeline_edge_invalid");
    if (r.targetEventId !== undefined) validateId(r.targetEventId, "timeline_edge_invalid");
    if (r.targetKind !== undefined) validateId(r.targetKind, "timeline_edge_invalid");
    if (r.targetId !== undefined) validateId(r.targetId, "timeline_edge_invalid");
  }
}

function validateDesc(v: unknown): void {
  if (typeof v !== "string" || v.length === 0 || Buffer.byteLength(v, "utf8") > MAXIMUM_DESCRIPTION_BYTES) throw new InputError("Timeline description is invalid", "timeline_description_invalid");
}

function validateId(v: unknown, code: string): string {
  if (typeof v !== "string" || v.length === 0 || v.length > MAXIMUM_IDENTIFIER_CHARACTERS || !IDENTIFIER_PATTERN.test(v)) throw new InputError("Timeline identifier is invalid", code);
  if (detectProtocolIdentitySensitiveSpans(v).length !== 0) throw new SecurityError("Sensitive material cannot be used as a timeline identity", "timeline_sensitive_identifier");
  return v;
}

function validateHash(v: unknown, code: string): void {
  if (typeof v !== "string" || !HEX_64_PATTERN.test(v)) throw new InputError("Timeline hash is invalid", code);
}

function validateTs(wt: string, mn: string | undefined): void {
  if (typeof wt !== "string" || wt.length === 0 || wt.length > 64) throw new InputError("Timeline wall time is invalid", "timeline_timestamp_invalid");
  if (detectProtocolIdentitySensitiveSpans(wt).length !== 0) throw new SecurityError("Sensitive material cannot be used as a timeline timestamp", "timeline_sensitive_identifier");
  if (mn !== undefined && (typeof mn !== "string" || !DECIMAL_SEQUENCE_PATTERN.test(mn))) throw new InputError("Timeline monotonic time is invalid", "timeline_timestamp_invalid");
}
