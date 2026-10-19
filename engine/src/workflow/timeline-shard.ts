import { dirname, join } from "node:path";

import { extractErrorMessage, InputError, SecurityError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { canonicalizeLedgerJson } from "../kernel/ledger-canonical.ts";
import { DEFAULT_TIMELINE_QUERY_LIMIT, type TimelineConfig } from "../kernel/config-contracts.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { debugLog, handleError } from "../shared/debug/debug-system.ts";
import { createTimelineStore } from "../timeline/timeline-store.ts";
import { assertTimelineDocument } from "../timeline/ledger-primitives.ts";
import {
  isTimelineOutcome,
  type EventLedgerStoragePort,
  type TimelineChainVerification,
  type TimelineCorrelation,
  type TimelineDocumentInput,
  type TimelineDocumentRecord,
  type TimelineEdgeInput,
  type TimelineErrorSummary,
  type TimelineEventRecord,
  type TimelineStandaloneEventInput,
} from "../timeline/timeline-types.ts";
import { ensurePrivateStateDirectory } from "../filesystem/private-state.ts";

/**
 * Workspace timeline shard — per-workspace event ledger with an idempotent
 * canonical import on merge.
 *
 * While an agent works inside its git worktree, every workspace lifecycle
 * event is appended to a SQLite shard under the canonical state root
 * (`<stateRoot>/workspace-shards/<workspaceId>/timeline.db`, ledger id
 * `workspace-<workspaceId>`). The shard deliberately lives OUTSIDE the
 * worktree so appending timeline evidence never dirties the agent's tree
 * (the merge-time clean-tree proof would fail otherwise), while remaining
 * inside the never-pushed `.bridlewise/state` boundary.
 *
 * On a successful merge the integrator imports the shard into the
 * canonical ledger:
 *
 * - Only standalone events are supported. An existing identity is skipped
 * only when its complete logical import projection matches exactly.
 * - Chain integrity is re-established inside the canonical ledger: each
 * imported event is appended through `appendEvent`, so its
 * `previousChainHash`/`chainHash` link into the canonical chain. The
 * shard's own chain remains verifiable inside the shard file.
 * - Import order follows the shard's decimal sequence so causal parents
 * always land before their children.
 */

export const WORKSPACE_SHARDS_DIRECTORY = "workspace-shards" as const;
export const WORKSPACE_SHARD_DB_FILENAME = "timeline.db" as const;

export type WorkspaceShardImportResult = Readonly<{
  sourceEvents: number;
  imported: number;
  skipped: number;
}>;

export function workspaceShardLedgerId(workspaceId: string): string {
  return `workspace-${workspaceId}`;
}

function workspaceShardDirectory(stateRootAbsolute: string, workspaceId: string): string {
  return join(stateRootAbsolute, WORKSPACE_SHARDS_DIRECTORY, workspaceId);
}

export function workspaceShardDbPath(stateRootAbsolute: string, workspaceId: string): string {
  return join(workspaceShardDirectory(stateRootAbsolute, workspaceId), WORKSPACE_SHARD_DB_FILENAME);
}

export function openWorkspaceTimelineShard(
  options: Readonly<{
    stateRootAbsolute: string;
    workspaceId: string;
    timelineConfig?: Partial<TimelineConfig>;
  }>,
): EventLedgerStoragePort {
  const dbPath = workspaceShardDbPath(options.stateRootAbsolute, options.workspaceId);
  ensurePrivateStateDirectory(dirname(dbPath));
  return createTimelineStore({
    path: dbPath,
    ledgerId: workspaceShardLedgerId(options.workspaceId),
    ...(options.timelineConfig !== undefined ? { timelineConfig: options.timelineConfig } : {}),
  });
}

export function verifyWorkspaceShardChain(shard: EventLedgerStoragePort): TimelineChainVerification {
  return shard.verifyChain();
}

/**
 * Verify source integrity, then walk its captured tip in bounded ascending
 * pages after the native verification cursor is closed. Each append owns
 * its transaction: a refusal retains the committed valid prefix and source.
 * An end-tip check detects observed growth; it is not writer quiescence and
 * never authorizes deleting the shard.
 */
export function importWorkspaceTimelineShard(
  options: Readonly<{
    shard: EventLedgerStoragePort;
    canonical: EventLedgerStoragePort;
    queryDefaultLimit?: TimelineConfig["queryDefaultLimit"];
  }>,
): WorkspaceShardImportResult {
  const { shard, canonical } = options;
  const limit = options.queryDefaultLimit ?? DEFAULT_TIMELINE_QUERY_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > ROOT_POLICY.timeline.limits.maxDocuments) {
    throw new InputError("Workspace shard query limit is invalid", "workspace_shard_query_limit_invalid");
  }
  const readTip = () => shard.querySummaries({ ledgerId: shard.ledgerId, ascending: false, limit: 1 })[0]?.sequence;
  const tip = readTip();
  const assertUnchangedTip = () => {
    if (readTip() !== tip) {
      throw new InputError("Workspace shard changed during import; retain and re-import its source", "workspace_shard_source_changed");
    }
  };
  let cursor: string | undefined;
  let sourceEvents = 0;
  let imported = 0;
  let skipped = 0;
  try {
    const verification = verifyWorkspaceShardChain(shard);
    if (!verification.valid) {
      throw new InputError("Workspace shard chain integrity verification failed", "workspace_shard_chain_invalid", {
        verifiedRecords: verification.verifiedRecords,
        ...(verification.code !== undefined ? { reason: verification.code } : {}),
        ...(verification.breakAtSequence !== undefined ? { sequence: verification.breakAtSequence } : {}),
      });
    }
    assertUnchangedTip();
    while (tip !== undefined && cursor !== tip) {
      const events = shard.query({ ledgerId: shard.ledgerId, ascending: true, limit, toSequence: tip, ...(cursor !== undefined ? { cursor } : {}) });
      if (events.length === 0 || events.length > limit) {
        throw new InputError("Workspace shard did not reach its captured tip", "workspace_shard_progress_invalid");
      }
      for (const event of events) {
        if (event.ledgerId !== shard.ledgerId || (cursor !== undefined && BigInt(event.sequence) <= BigInt(cursor)) || BigInt(event.sequence) > BigInt(tip)) {
          throw new InputError("Workspace shard page did not progress within its captured bounds", "workspace_shard_progress_invalid");
        }
        // The EXACT originals, never the shard's projection: a protected
        // document's masked text would be re-appended as an `exact` one and
        // its seal (the shard key's, bound to the shard's event) lost — a
        // later rollback would write the masked text back (a3-correctness
        // H-1). The canonical append re-projects and re-seals it under the
        // canonical key; the identity comparison reads both sides the same way.
        const input = toStandaloneInput(event, exactDocuments(shard, event), canonical.ledgerId);
        const existing = canonical.getEvent(event.eventId);
        if (existing !== undefined) {
          if (existing.ledgerId !== canonical.ledgerId || !canonicalizeLedgerJson(input).equals(canonicalizeLedgerJson(toStandaloneInput(existing, exactDocuments(canonical, existing), canonical.ledgerId)))) {
            throw new InputError("Workspace shard event identity conflicts with canonical content", "workspace_shard_identity_conflict");
          }
          skipped += 1;
        } else {
          canonical.appendEvent(input);
          imported += 1;
        }
        sourceEvents += 1;
        cursor = event.sequence;
      }
    }
    assertUnchangedTip();
    const result = deepFreeze({ sourceEvents, imported, skipped });
    debugLog("workflow", "info", "Workspace shard import completed; source retained", () => ({ ...result }));
    return result;
  } catch (error) {
    handleError(error, { module: "workflow-timeline-shard", operation: "import", sourceEvents, imported, skipped });
    throw error;
  }
}

/**
 * An event's documents EXACTLY as they were appended (a protected document's
 * sealed original opened with its store's key). A seal that cannot be opened
 * refuses the import typed — a masked copy is never imported in its place.
 */
function exactDocuments(store: EventLedgerStoragePort, event: TimelineEventRecord): readonly TimelineDocumentRecord[] {
  if (!event.documents.some((document) => document.projectionDisposition === "protected")) return event.documents;
  let originals: readonly TimelineDocumentRecord[] | undefined;
  try {
    originals = store.originalDocuments(event.eventId, "workspace-shard-import");
  } catch (error) {
    throw new SecurityError(`Workspace shard event ${event.eventId} holds a sealed original that cannot be opened: ${extractErrorMessage(error)}`, "workspace_shard_original_unavailable");
  }
  if (originals === undefined) throw new SecurityError(`Workspace shard event ${event.eventId} has no originals to import`, "workspace_shard_original_unavailable");
  return originals;
}

function toStandaloneInput(event: TimelineEventRecord, exact: readonly TimelineDocumentRecord[], canonicalLedgerId: string): TimelineStandaloneEventInput {
  if (event.recordKind !== "event") {
    throw new InputError("Workspace shard import supports only standalone events", "workspace_shard_record_kind_unsupported");
  }
  if (event.outcome !== null && !isTimelineOutcome(event.outcome)) {
    throw new InputError("Workspace shard outcome is invalid", "workspace_shard_outcome_invalid");
  }
  const documents: TimelineDocumentInput[] = exact.map((document) => ({
    name: document.name,
    ...(document.contentJson !== null ? { contentJson: document.contentJson } : {}),
    ...(document.orderedJson !== null ? { orderedJson: document.orderedJson } : {}),
    contentDigest: document.contentDigest,
  }));
  // Historical matches still require exact document integrity. No current
  // byte cap is applied to a skip; new appends retain the target store cap.
  for (const document of documents) assertTimelineDocument(document);
  const edges: TimelineEdgeInput[] = event.edges.map((edge) => ({
    edgeType: edge.edgeType,
    ...(edge.targetEventId !== null ? { targetEventId: edge.targetEventId } : {}),
    ...(edge.targetKind !== null ? { targetKind: edge.targetKind } : {}),
    ...(edge.targetId !== null ? { targetId: edge.targetId } : {}),
  }));
  const correlation = buildCorrelation(event);
  const error = errorSummaryOf(event);
  return deepFreeze({
    eventId: event.eventId,
    ledgerId: canonicalLedgerId,
    eventType: event.eventType,
    actor: deepFreeze({
      kind: event.actorKind,
      id: event.actorId,
      ...(event.actorRole !== null ? { role: event.actorRole } : {}),
    }),
    ...(correlation !== undefined ? { correlation } : {}),
    description: event.description,
    wallTime: event.wallTime,
    ...(event.monotonicNanoseconds !== null ? { monotonicNanoseconds: event.monotonicNanoseconds } : {}),
    ...(event.traceId !== null ? { traceId: event.traceId } : {}),
    ...(event.spanId !== null ? { spanId: event.spanId } : {}),
    ...(event.parentEventId !== null ? { parentEventId: event.parentEventId } : {}),
    ...(event.payloadRef !== null ? { payloadRef: event.payloadRef } : {}),
    ...(event.payloadDigest !== null ? { payloadDigest: event.payloadDigest } : {}),
    ...(event.outcome !== null ? { outcome: event.outcome } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(documents.length > 0 ? { documents: deepFreeze(documents) } : {}),
    ...(edges.length > 0 ? { edges: deepFreeze(edges) } : {}),
  });
}

/**
 * The shard row's four error columns, re-read as the one summary the ledger
 * now accepts — or `undefined` when the row records no failure.
 *
 * This used to complete a partial row with `code: "unknown"` and
 * `message: ""`, i.e. it INVENTED the detail the import exists to preserve and
 * then let it be chain-hashed into the canonical ledger as though observed.
 * All four columns are written together by `appendEvent`, so a row that has
 * some of them and not others is not a value to be patched up — it is a
 * corrupt or hand-edited source, and importing it is refused rather than
 * completed.
 */
function errorSummaryOf(event: TimelineEventRecord): TimelineErrorSummary | undefined {
  const present = [event.errorCategory, event.errorCode, event.errorMessage, event.errorRetryable]
    .filter((value) => value !== null).length;
  if (present === 0) return undefined;
  if (
    event.errorCategory === null || event.errorCode === null
    || event.errorMessage === null || event.errorRetryable === null
  ) {
    throw new InputError(
      `Timeline shard event ${event.eventId} carries an incomplete error summary`,
      "timeline_shard_error_incomplete",
    );
  }
  return deepFreeze({
    category: event.errorCategory,
    code: event.errorCode,
    message: event.errorMessage,
    retryable: event.errorRetryable,
  });
}

function buildCorrelation(event: TimelineEventRecord): TimelineCorrelation | undefined {
  const correlation: Record<string, string> = {};
  if (event.runId !== null) correlation.runId = event.runId;
  if (event.sessionId !== null) correlation.sessionId = event.sessionId;
  if (event.turnId !== null) correlation.turnId = event.turnId;
  if (event.messageId !== null) correlation.messageId = event.messageId;
  if (event.taskId !== null) correlation.taskId = event.taskId;
  if (event.attemptId !== null) correlation.attemptId = event.attemptId;
  if (event.agentId !== null) correlation.agentId = event.agentId;
  if (event.parentEffectId !== null) correlation.parentEffectId = event.parentEffectId;
  return Object.keys(correlation).length === 0
    ? undefined
    : deepFreeze(correlation as TimelineCorrelation & Record<string, string>);
}
