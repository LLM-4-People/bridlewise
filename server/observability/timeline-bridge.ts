/**
 * Timeline bridge — the server-side adapter to the canonical harness
 * timeline store. Owns ONE persistent SQLite timeline ledger (configured
 * path + stable ledger id) and exposes a recorder (write) and a query
 * (read) for the route layer.
 *
 * The run route records real lifecycle/message/token-usage events as a run
 * streams; the timeline route queries the same ledger. This replaces the
 * fixture timeline events with real persisted events.
 */

import {
  describeFaultLine,
  registerFatalFaultRecorder,
  setEffectSink,
  withoutEngineSpans,
  generateId,
  createTimelineEffectSink,
  DEFAULT_MAXIMUM_DOCUMENT_BYTES,
  createTimelineStore,
  createTimelineQuery,
  createTimelineRecorder,
  ROOT_POLICY,
  truncateForLedger,
  pendingTimelineMigrations,
} from "../kernel/canonical.ts";
import { runWorkerTask } from "../run/worker-pool.ts";
import { getDatabaseKey } from "../db/bootstrap-key.ts";
import { atomicWriteFile } from "../../engine/src/filesystem/atomic-write.ts";
import { hasErrorCode } from "../../engine/src/kernel/errors.ts";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

import { serverConfig, isDbWorkerThread } from "../kernel/config.ts";
import { webAlwaysOn, webConsoleError, webConsoleInfo, webWarn } from "./debug-bridge.ts";
import { ConfigError, ServiceUnavailableError } from "../kernel/errors.ts";
import { readFileText } from "../filesystem/file-read.ts";
import { sha256 } from "../kernel/digest.ts";
import { getTimelineConfig, performanceResourceDeltasEnabled } from "../kernel/harness-config.ts";
import type { TimelineQuery, TimelineRecorder } from "../kernel/canonical.ts";

const LEDGER_ID_SIDECAR = resolve(dirname(serverConfig.timelineDbPath), "timeline-ledger-id");
const LEDGER_ID_PREFIX = "ledger";
const LEDGER_UUID = z.uuid();

function readOrCreateLedgerId(): string {
  const existing = readLedgerId();
  if (existing !== undefined) return existing;
  if (existsSync(serverConfig.timelineDbPath)) {
    // A concurrent first opener publishes the identity BEFORE it creates the
    // ledger, so a ledger that exists although the identity was absent a
    // moment ago may have just been given one by that opener: read again.
    const published = readLedgerId();
    if (published !== undefined) return published;
    throw new ConfigError("The existing timeline requires its ledger identity", "timeline_ledger_identity_missing");
  }
  const ledgerId = generateId("ledger");
  // THE ONE EXCLUSIVE WRITER: a complete, fsynced private file linked under
  // the name only when it is free (and the folder fsynced), so a concurrent
  // opener reads nothing or the WHOLE winner — never a prefix of it — and no
  // opener ever replaces the identity another one published.
  const written = atomicWriteFile(LEDGER_ID_SIDECAR, ledgerId, {
    exclusive: true, durable: true, exactMode: ROOT_POLICY.filesystemInfrastructure.privateState.fileMode, createParentDirectories: false,
  });
  if (written.success) return ledgerId;
  if (hasErrorCode(written.error, "EEXIST")) {
    const winner = readLedgerId();
    if (winner !== undefined) return winner;
  }
  throw new ConfigError("The timeline ledger identity could not be published", "timeline_ledger_identity_unavailable");
}

function readLedgerId(): string | undefined {
  let stored: string;
  try {
    stored = readFileText(LEDGER_ID_SIDECAR).trim();
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw new ConfigError("The timeline ledger identity could not be read", "timeline_ledger_identity_unavailable");
  }
  if (!stored.startsWith(`${LEDGER_ID_PREFIX}-`) || !LEDGER_UUID.safeParse(stored.slice(LEDGER_ID_PREFIX.length + 1)).success) {
    throw new ConfigError("The timeline ledger identity is invalid", "timeline_ledger_identity_invalid");
  }
  return stored;
}

let store: ReturnType<typeof createTimelineStore> | undefined;
let query: TimelineQuery | undefined;
let recorder: TimelineRecorder | undefined;

/**
 * ── LISTEN FIRST; THE LEDGER IS READY WHEN ITS MIGRATIONS ARE (SCALE-CR1 C10) ──
 *
 * The server used to open the ledger eagerly before it listened, and a ledger
 * that owed migrations ran them right there: migration 9 over a 10 GB ledger
 * blocked the boot for 488.8 s with nothing answering, not even the health
 * check. `startTimeline()` (the boot calls it and does not wait) opens a
 * ledger that owes nothing at once, as before; one that owes migrations has
 * them run by a worker (`timeline-migration-worker.ts`, the store's own
 * runner) while the server listens. Meanwhile:
 *
 *  - liveness and readiness are separate: `/api/health` answers, and says
 *    `ledger: "migrating"` (the `timeline.readiness` signal says the same);
 *  - whatever needs the ledger is refused typed and retryable
 *    (`ServiceUnavailableError`, `timeline_migrating`, HTTP 503): a run start
 *    is not recorded half-way, and the client retries;
 *  - effects that would have been recorded are COUNTED, and when the ledger
 *    opens one `recording-gap` event names the window and the count, so the
 *    gap is a recorded fact rather than a silent hole.
 *
 * A migration the store refuses leaves the ledger `failed` (the reason
 * logged, always on); the server keeps answering and refuses ledger work.
 */
export type TimelineReadiness = Readonly<{
  state: "unopened" | "migrating" | "ready" | "failed";
  pendingMigrations: readonly string[];
  since: string;
  reason?: string;
}>;

let readiness: TimelineReadiness = Object.freeze({ state: "unopened", pendingMigrations: [], since: new Date().toISOString() });
let starting: Promise<void> | undefined;
let unrecordedWhileMigrating = 0;

/** The open ledger the effect sink records into; undefined while it is not open (the effect is counted). */
let sinkTarget: Readonly<{ recorder: TimelineRecorder; maxDocumentBytes: number }> | undefined;
let sinkInstalled = false;

/**
 * THE ONE EFFECT-SINK INSTALLATION (once per process): it records into the
 * open ledger, and while the ledger is migrating (no target yet) it counts
 * what it could not record — an optional effect is dropped and counted, a
 * required one is refused (`RequiredRecordingError`), so nothing claims a
 * record it does not have. Suppress instrumentation around EACH synchronous
 * transition, never the stream lifetime.
 */
function installEffectSink(): void {
  if (sinkInstalled) return;
  sinkInstalled = true;
  setEffectSink(createTimelineEffectSink(() => {
    if (sinkTarget === undefined) {
      unrecordedWhileMigrating += 1;
      return undefined;
    }
    return { recorder: sinkTarget.recorder, documentOptions: { maxDocumentBytes: sinkTarget.maxDocumentBytes, resourceDeltasEnabled: performanceResourceDeltasEnabled() } };
  }, {
    transition: withoutEngineSpans,
    onUnmappedKind(record) {
      webWarn("timeline-bridge", "effect kind has no ledger lane mapping; recorded under the resource floor", () => ({ kind: record.kind, name: record.name }));
    },
  }));
}

/** The ledger's readiness (liveness is the health route answering at all). */
export function timelineReadiness(): TimelineReadiness {
  return readiness;
}

/** The document a `recording-gap` event carries. */
const RECORDING_GAP_DOCUMENT = "recording-gap";

/**
 * Open the ledger for this server, off the listen path when it owes
 * migrations. Idempotent; the boot calls it without waiting. Resolves when
 * the ledger is ready (or has failed: the state says which).
 */
export function startTimeline(): Promise<void> {
  if (starting !== undefined) return starting;
  assertLedgerWriterThread();
  const dbPath = resolve(serverConfig.timelineDbPath);
  const owed = pendingTimelineMigrations(dbPath);
  if (owed.length === 0) {
    openTimeline();
    starting = Promise.resolve();
    return starting;
  }
  const since = new Date().toISOString();
  readiness = Object.freeze({ state: "migrating", pendingMigrations: owed, since });
  webConsoleInfo(`[bridlewise web] the ledger owes ${String(owed.length)} migration(s) (${owed.join(", ")}); they run in the background and the server answers meanwhile`);
  // What would have been recorded meanwhile is counted, not lost silently
  // (the one sink, with no target yet: `installEffectSink`).
  installEffectSink();
  const timelineConfig = getTimelineConfig();
  starting = runWorkerTask<readonly string[]>({
    workerUrl: new URL("./timeline-migration-worker.ts", import.meta.url),
    workerData: { path: dbPath, ...(timelineConfig.sqliteBusyTimeoutMs !== undefined ? { busyTimeoutMs: timelineConfig.sqliteBusyTimeoutMs } : {}) },
    errorClass: ServiceUnavailableError,
    label: "timeline-migration",
    // NO deadline: a migration's time scales with the ledger, and stopping one
    // only rolls it back for the next boot to redo. The serving thread is not
    // waiting on it, so a bound would protect nothing.
    timeoutMs: 0,
    validateOk: (message) => {
      const applied = (message as { applied?: unknown }).applied;
      return Array.isArray(applied) ? applied as readonly string[] : undefined;
    },
  }).then((applied) => {
    // `ready` before the open (the open refuses while migrating); a failed
    // open leaves no store behind and the catch below says `failed`.
    readiness = Object.freeze({ state: "ready", pendingMigrations: [], since: new Date().toISOString() });
    const { recorder: opened } = openTimeline();
    // The ledger IS open from here on. A gap record that cannot be written is
    // reported, never a `failed` state over a ledger that records
    // (SCALE-CR1-FIX M9c).
    try {
      const gap = JSON.stringify({ from: since, to: readiness.since, effectsNotRecorded: unrecordedWhileMigrating, migrations: applied });
      opened.recordEvent({
        eventType: "ledger",
        description: `recording-gap: ${String(unrecordedWhileMigrating)} effect(s) not recorded while the ledger migrated`,
        documents: [{ name: RECORDING_GAP_DOCUMENT, contentJson: gap, contentDigest: sha256(gap) }],
      });
    } catch (error) {
      webAlwaysOn("timeline", "the ledger opened, but its recording-gap event could not be written", { effectsNotRecorded: unrecordedWhileMigrating, fault: describeFaultLine(error) });
    }
    webConsoleInfo(`[bridlewise web] the ledger is ready (${applied.join(", ")} applied)`);
  }).catch((error: unknown) => {
    const reason = describeFaultLine(error);
    readiness = Object.freeze({ state: "failed", pendingMigrations: owed, since: new Date().toISOString(), reason });
    webConsoleError(`[bridlewise web] the ledger could not be migrated or opened; ledger work is refused until it is fixed: ${reason}`);
  });
  return starting;
}

/**
 * THE LEDGER HAS EXACTLY ONE WRITER, AND IT IS THE MAIN THREAD.
 *
 * The async data facade runs the database client on worker threads. If one of those
 * threads reached the ledger, two things this product refuses would happen at
 * once:
 *
 *  - a SECOND store would open over the same file and extend the same hash
 *    chain, so the chain would stop being evidence of anything; and
 *  - the event would be recorded with NO ambient causality, because
 *    AsyncLocalStorage does not cross a thread. It would not fail — it would
 *    quietly record a correlation-free event, which is recorded absence
 *    dressed as recorded presence.
 *
 * Neither is a latency question, so neither is negotiable for one. The DB
 * workers set `HARNESS_DB_WORKER`; opening the ledger there THROWS. The facade
 * appends check-status events on the main thread instead, inside the caller's
 * async context (see `createAutoCheckReturningTransition` in server/db/).
 */
function assertLedgerWriterThread(): void {
  if (isDbWorkerThread()) {
    throw new ConfigError(
      "the timeline ledger was opened from a DB worker thread. The ledger has one " +
        "writer, on the main thread: a second writer races the chain hash, and a " +
        "worker has no recording context so the event would carry no causality. " +
        "Record on the main thread after the write returns.",
      "ledger_opened_off_main_thread",
    );
  }
}

function openTimeline(): Readonly<{ store: ReturnType<typeof createTimelineStore>; query: TimelineQuery; recorder: TimelineRecorder }> {
  if (store !== undefined && query !== undefined && recorder !== undefined) {
    return { store, query, recorder };
  }
  if (readiness.state === "migrating" || readiness.state === "failed") {
    throw new ServiceUnavailableError(
      readiness.state === "migrating"
        ? `The ledger is migrating (${readiness.pendingMigrations.join(", ")}, since ${readiness.since}); retry shortly.`
        : `The ledger could not be migrated or opened (${readiness.reason ?? "unknown reason"}); ledger work is refused.`,
      readiness.state === "migrating" ? "timeline_migrating" : "timeline_unavailable",
    );
  }
  assertLedgerWriterThread();
  const dbPath = resolve(serverConfig.timelineDbPath);
  mkdirSync(dirname(dbPath), { recursive: true });
  // THE CONFIG FILE IS THE SOURCE OF TRUTH FOR THE LEDGER'S OPERATIONAL
  // LIMITS. The store was opened here WITHOUT `timelineConfig`, so the web
  // ledger silently ran on the engine's 1 MiB / 32-document inline defaults
  // while `bridlewise.config.json` declared 16 MiB / 1,000,000 — a config
  // the operator set and this bridge never read. The section is handed over
  // verbatim (the store owns its defaults for absent fields, so none are
  // restated here); the resolved per-document cap is kept for the sink's
  // bounding below, which must agree with the limit the store enforces.
  const timelineConfig = getTimelineConfig();
  // The web timeline seals with the WEB DATABASE's key (one admitted key for
  // the web DB, its memory entries and this ledger's sealed originals; the
  // key home records the pairing, which the key tool checks before a re-key).
  // The timeline path is its own store identity, never a key source.
  const rootKey = getDatabaseKey();
  store = createTimelineStore({
    path: dbPath,
    key: rootKey.key,
    ledgerId: readOrCreateLedgerId(),
    // Only the fields the config file declares are handed over — an absent
    // field stays absent so the store's own declared default applies.
    timelineConfig: {
      ...(timelineConfig.maxDocumentBytes !== undefined ? { maxDocumentBytes: timelineConfig.maxDocumentBytes } : {}),
      ...(timelineConfig.maxDocuments !== undefined ? { maxDocuments: timelineConfig.maxDocuments } : {}),
      ...(timelineConfig.maxEdges !== undefined ? { maxEdges: timelineConfig.maxEdges } : {}),
      ...(timelineConfig.sqliteCacheSize !== undefined ? { sqliteCacheSize: timelineConfig.sqliteCacheSize } : {}),
      ...(timelineConfig.sqliteBusyTimeoutMs !== undefined ? { sqliteBusyTimeoutMs: timelineConfig.sqliteBusyTimeoutMs } : {}),
      ...(timelineConfig.queryDefaultLimit !== undefined ? { queryDefaultLimit: timelineConfig.queryDefaultLimit } : {}),
    },
  });
  // The per-document bound the store will enforce, resolved from the same
  // config the store was opened with. Undefined means the store's inline
  // default is in force (no `maxDocumentBytes` in the config file), and the
  // sink bounds against that same default rather than a second number.
  const maxDocumentBytes = timelineConfig.maxDocumentBytes ?? DEFAULT_MAXIMUM_DOCUMENT_BYTES;
  query = createTimelineQuery(store);
  recorder = createTimelineRecorder({
    store,
    // FALLBACK ONLY. The effective actor comes from the ambient recording
    // context (see recording-context.ts); this applies when something records
    // outside any boundary, which is a wiring gap worth seeing in the ledger.
    actor: { kind: "harness", id: "web-ui", role: "runtime" },
  });

  const activeRecorder = recorder;
  sinkTarget = Object.freeze({ recorder: activeRecorder, maxDocumentBytes });
  installEffectSink();

  // THE FATAL FAULT'S LEDGER LANE (SCALE-CR1 C2): an uncaught exception is
  // fail-stop, and on its way out the fault policy records it here, once, as a
  // `process-fault` event (redacted by the store like every description and
  // error message) before the process exits 70 for its supervisor.
  registerFatalFaultRecorder((fault, origin) => {
    activeRecorder.recordEvent({
      eventType: "error",
      description: `process-fault: ${origin}`,
      outcome: "failed",
      error: { category: "process", code: "process_uncaught_exception", message: truncateForLedger(`${fault.name}${fault.code === undefined ? "" : ` [${fault.code}]`}: ${fault.message}`), retryable: false },
    });
  });

  readiness = Object.freeze({ state: "ready", pendingMigrations: [], since: new Date().toISOString() });
  return { store, query, recorder };
}

/** Document name carrying what a removal took away. Module-private: no
 * consumer imports it, and an export nobody consumes is a second public
 * surface for one local string. */
const REMOVAL_DOCUMENT = "removal";

/**
 * ── UNDO OPERATES ON THE WORLD, NEVER ON THE RECORD ────────────────────────
 *
 * Deleting a conversation removes it from retrieval. The fact that it existed,
 * and the fact that someone removed it, both survive — as a new event. The
 * chain only grows; there is no operation anywhere that makes it shorter.
 *
 * This exists because three routes did the opposite. `DELETE /api/chats/:id`,
 * `DELETE /api/projects/:id` and `POST /api/chats/:id/rollback` each destroyed
 * user-visible state and recorded NOTHING: afterwards there was no way to say
 * the conversation had ever been there, who removed it, when, or how much went
 * with it. The event ledger was never touched by any of them — so the record
 * was not falsified, it simply had a hole exactly where the destruction was.
 *
 * WHY THE COUNT IS A PARAMETER AND NOT A GUESS. The caller passes what the
 * delete actually returned — `changes` from the statement, or the boolean the
 * row existed. A number this function invented (an estimate, a pre-count, a
 * zero standing in for "not measured") would be a fabricated fact inside a
 * chain-hashed event, which is the failure this ledger has already had twice.
 * A caller with nothing to report passes nothing, and the document says so by
 * omission rather than by a placeholder.
 *
 * IT IS CALLED AFTER THE DELETE, NEVER BEFORE. Recording an intent to delete
 * and then failing would put an effect in the ledger that did not happen.
 *
 * Actor, run, trace and parent event come from the ambient recording context
 * (`withRecordingContext` in server/router.ts), so "who removed it" is read
 * rather than passed — the same reason `EffectRecord.actor` is ambient.
 */
export function recordRemoval(
  what: "chat" | "project" | "chat-messages",
  detail: Readonly<{ id: string; removed?: number; note?: string }>,
): void {
  const doc = { what, ...detail };
  const contentJson = JSON.stringify(doc);
  try {
    getTimelineRecorder().recordEvent({
      // `rollback` is the ledger's declared lane for undoing prior work;
      // `task` is the lane the block-action door already maps user-invoked
      // verbs to (see the effect-kind table in the timeline vocabulary).
      // Removals are the second kind.
      eventType: what === "chat-messages" ? "rollback" : "task",
      description:
        detail.removed === undefined
          ? `removed ${what} ${detail.id}`
          : `removed ${what} ${detail.id} (${detail.removed})`,
      outcome: "succeeded",
      documents: [{
        name: REMOVAL_DOCUMENT,
        contentJson,
        contentDigest: sha256(contentJson),
      }],
    });
  } catch (recordErr) {
    // The delete has ALREADY happened. Throwing here would report a failure
    // for an operation that succeeded, and would leave the caller unable to
    // tell which half failed. So the failure is made visible instead — and
    // visible is the right word: this is the one case where the record is
    // knowingly incomplete, and a silent catch would hide exactly the gap
    // this function exists to close.
    webWarn("timeline-bridge", "removal could not be recorded", () => ({
      what,
      id: detail.id,
      error: recordErr instanceof Error ? recordErr.message : String(recordErr),
    }));
  }
}

export function getTimelineQuery(): TimelineQuery {
  return openTimeline().query;
}

export function getTimelineRecorder(): TimelineRecorder {
  return openTimeline().recorder;
}

export function getTimelineLedgerId(): string {
  return openTimeline().store.ledgerId;
}

export function getTimelineStore(): ReturnType<typeof createTimelineStore> {
  return openTimeline().store;
}
