import { DEFAULT_TIMELINE_QUERY_LIMIT } from "../kernel/config-contracts.ts";
import { SecurityError } from "../kernel/errors.ts";
import { InputError } from "../kernel/errors.ts";
import { canonicalHash, deepFreeze, generateId, sha256 } from "../kernel/integrity.ts";
import type {
  EventLedgerStoragePort,
  FileEffectRestorer,
  RollbackEffect,
  RollbackOptions,
  RollbackPlan,
  RollbackResult,
  TimelineEventRecord,
} from "./timeline-types.ts";
import { isRollbackPlannedRecordKind, rollbackEventDisposition, TIMELINE_FILE_EFFECT_DOCUMENT, TIMELINE_PREIMAGE_DOCUMENT } from "./timeline-types.ts";

/**
 * Timeline rollback.
 *
 * Per delivery map item 3: "Rollback must restore exact governed
 * effects and preserve the original evidence."
 *
 * Rollback is an append-only operation: the original events are never
 * modified or deleted (enforced by the store's append-only triggers). A
 * rollback admits an intent before callbacks and a terminal with `rolled-back-by` edges
 * pointing to each restored effect. The original evidence remains fully
 * traversable.
 *
 * For file effects: if a `FileEffectRestorer` is provided, the rollback
 * restores the preimage content via the restorer callback. The preimage
 * is stored in the original effect's `event_documents` (document name
 * `preimage`). A pre-image the ledger's projection masked (a `.env` holding a
 * token) is handed to the restorer as its SEALED ORIGINAL, opened with the
 * store key (`originalDocuments`) — never the masked text, which would
 * corrupt the file. If no restorer is provided, a reversible file effect is
 * counted as a failed restoration; its plan classification remains reversible.
 *
 * The plan covers EVERY event after the target: it pages ascending through
 * the tip fixed at planning time (a single query used to stop at the store's
 * default page, so a rollback over more than a page of later events silently
 * left the older effects in place and still reported success).
 *
 * For git effects: rollback records a compensating event but does not
 * attempt to reverse git operations (per the S4 design: "Feature rollback
 * never rewrites source events: it appends checkpoint/rollback events and
 * restores repository/deployment state through their own guarded ports").
 * Git reversal requires the guarded git port, which is a separate slice.
 *
 * Irreversible effects (network, process, provider) are recorded as
 * skipped with a typed reason.
 */

type Clock = () => string;

const DEFAULT_CLOCK: Clock = () => new Date().toISOString();

type RollbackControllerOptions = Readonly<{
  clock?: Clock;
}>;

export function createRollbackController(
  store: EventLedgerStoragePort,
  options?: RollbackControllerOptions,
): RollbackController {
  const clock = options?.clock ?? DEFAULT_CLOCK;
  return deepFreeze({
    plan(rollbackOptions: RollbackOptions): RollbackPlan {
      return computePlan(store, rollbackOptions);
    },
    execute(rollbackOptions: RollbackOptions): RollbackResult {
      const rollbackPlan = computePlan(store, rollbackOptions);
      return executeRollback(store, rollbackPlan, rollbackOptions, clock);
    },
    canRollback(event: TimelineEventRecord): boolean {
      return rollbackEventDisposition(event.eventType).reversible && isRollbackPlannedRecordKind(event.recordKind);
    },
  });
}

export type RollbackController = Readonly<{
  plan(options: RollbackOptions): RollbackPlan;
  execute(options: RollbackOptions): RollbackResult;
  canRollback(event: TimelineEventRecord): boolean;
}>;

function computePlan(store: EventLedgerStoragePort, options: RollbackOptions): RollbackPlan {
  const targetSequence = parseSequence(options.targetSequence, "timeline_rollback_target_invalid");
  const rollbackId = generateId("rollback");

  const ledgerId = options.ledgerId ?? store.ledgerId;
  if (ledgerId !== store.ledgerId) throw new InputError("Rollback ledger differs from the bound store", "timeline_ledger_mismatch");
  const tip = store.querySummaries({ ledgerId, ascending: false, limit: 1 })[0];
  const through = tip === undefined ? 0n : BigInt(tip.sequence);
  const collected: TimelineEventRecord[] = [];
  let cursor = targetSequence;
  while (cursor < through) {
    const page = store.query({ ledgerId, fromSequence: formatSequence(cursor + 1n), toSequence: formatSequence(through), ascending: true, limit: DEFAULT_TIMELINE_QUERY_LIMIT });
    if (page.length === 0) throw new SecurityError("Rollback plan is incomplete", "timeline_rollback_plan_incomplete");
    for (const event of page) {
      const sequence = BigInt(event.sequence);
      if (event.ledgerId !== ledgerId || sequence !== cursor + 1n || sequence > through) throw new SecurityError("Rollback plan is incomplete", "timeline_rollback_plan_incomplete");
      collected.push(event);
      cursor = sequence;
    }
  }
  const allEvents = collected.reverse();

  const effects: RollbackEffect[] = [];
  const irreversibleEffects: RollbackEffect[] = [];

  for (const event of allEvents) {
    // The record-kind contract lives with the record-kind registry
    // (`timeline-types.ts`), so the planner and the recorders cannot drift.
    if (!isRollbackPlannedRecordKind(event.recordKind)) continue;
    // The rollback disposition (reversible, kind, reason) lives with the
    // event-type registry — the planner reads the registry's own answer, so a
    // new event type added there is dispositional here with no parallel edit.
    const disposition = rollbackEventDisposition(event.eventType);
    const reversible = disposition.reversible;
    const effect: RollbackEffect = deepFreeze({
      eventId: event.eventId,
      sequence: event.sequence,
      eventType: event.eventType,
      effectId: event.effectId,
      description: event.description,
      rollbackKind: disposition.kind,
      reversible,
      ...(reversible ? {} : { reason: disposition.reason ?? "Effect is not reversible" }),
      documents: event.documents,
    });
    effects.push(effect);
    if (!reversible) irreversibleEffects.push(effect);
  }

  return deepFreeze({
    rollbackId,
    targetSequence: formatSequence(targetSequence),
    effects: deepFreeze(effects),
    reversibleCount: effects.length - irreversibleEffects.length,
    irreversibleCount: irreversibleEffects.length,
    irreversibleEffects: deepFreeze(irreversibleEffects),
  });
}

function executeRollback(
  store: EventLedgerStoragePort,
  plan: RollbackPlan,
  options: RollbackOptions,
  clock: Clock,
): RollbackResult {
  const ledgerId = options.ledgerId ?? store.ledgerId;
  const rollbackEventId = generateId("rb");
  const wallTime = clock();

  let restoredCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const failedEffects: { effectId: string; reason: string }[] = [];
  const restoredEventIds: string[] = [];

  // Both canRestore and restore are caller effects. Admit the entire batch
  // before either callback: every file effect's EXACT documents (a masked
  // pre-image opened from its seal) are resolved first, and a pre-image that
  // cannot be had — or is not the bytes the effect recorded (its own
  // `preimageDigest`: a masked copy that lost its seal on some path, e.g. a
  // shard import, a3-design H1) — refuses the rollback before anything is
  // touched or recorded. One check at the lowest point closes the class for
  // every path that can lose an original.
  const restorable = new Map<string, RollbackEffect>();
  if (options.fileRestorer !== undefined) {
    for (const effect of plan.effects) {
      if (!effect.reversible || effect.rollbackKind !== "file-effect") continue;
      const documents = effect.documents.some((document) => document.projectionDisposition === "protected")
        ? store.originalDocuments(effect.eventId, "rollback")
        : effect.documents;
      const preimage = documents?.find((document) => document.name === TIMELINE_PREIMAGE_DOCUMENT);
      const text = preimage?.contentJson ?? preimage?.orderedJson ?? null;
      if (documents === undefined || text === null || sha256(text) !== recordedPreimageDigest(documents)) {
        throw new SecurityError("Exact rollback preimage is unavailable", "timeline_rollback_preimage_unavailable");
      }
      restorable.set(effect.eventId, documents === effect.documents ? effect : deepFreeze({ ...effect, documents }));
    }
  }
  store.appendIntent({
    eventId: generateId("rb-intent"), ledgerId, eventType: "rollback", effectKind: "filesystem", effectId: plan.rollbackId,
    actor: options.actor ?? { kind: "harness", id: "rollback-controller", role: "timeline" },
    description: options.description ?? `Rollback to sequence ${plan.targetSequence}`,
    intentHash: canonicalHash(plan), wallTime,
    documents: [{ name: "rollback-plan", contentDigest: canonicalHash(plan) }],
  });
  // A thrown callback or failed terminal append leaves this real intent pending.
  // It cannot undo an already completed external effect or report false success.
  for (const effect of plan.effects) {
    if (!effect.reversible) {
      skippedCount++;
      continue;
    }
    const restored = restoreEffect(restorable.get(effect.eventId) ?? effect, options);
    if (restored) {
      restoredCount++;
      restoredEventIds.push(effect.eventId);
    } else {
      failedCount++;
      failedEffects.push({
        effectId: effect.effectId ?? effect.eventId,
        reason: "Restorer returned failure or no restorer provided",
      });
    }
  }

  const irreversibleSummary = JSON.stringify(plan.irreversibleEffects.map((effect) => ({ eventId: effect.eventId, reason: effect.reason ?? "irreversible" })));
  store.appendTerminal({
    eventId: rollbackEventId,
    ledgerId,
    eventType: "rollback",
    effectId: plan.rollbackId,
    outcome: failedCount === 0 ? "succeeded" : "failed",
    resultHash: canonicalHash({ restoredCount, skippedCount, failedCount, failedEffects, restoredEventIds }),
    wallTime: clock(),
    documents: deepFreeze([
      {
        name: "rollback-plan",
        contentDigest: canonicalHash(plan),
      },
      ...(plan.irreversibleEffects.length > 0 ? [{
        name: "rollback-irreversible-effects",
        contentJson: irreversibleSummary,
        contentDigest: sha256(irreversibleSummary),
      }] : []),
    ]),
    edges: deepFreeze(
      restoredEventIds.map((targetEventId, index) => ({
        edgeType: "rolled-back-by" as const,
        targetEventId,
        position: index,
      })),
    ),
  });

  return deepFreeze({
    rollbackId: plan.rollbackId,
    rollbackEventId,
    restoredCount,
    skippedCount,
    failedCount,
    failedEffects: deepFreeze(failedEffects),
    plan,
  });
}

/** The pre-image digest a file effect recorded (its effect document), or undefined when it recorded none readable. */
function recordedPreimageDigest(documents: RollbackEffect["documents"]): string | undefined {
  const text = documents.find((document) => document.name === TIMELINE_FILE_EFFECT_DOCUMENT)?.contentJson;
  if (text === undefined || text === null) return undefined;
  let effect: unknown;
  try { effect = JSON.parse(text); } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  const digest = (effect as { preimageDigest?: unknown } | null)?.preimageDigest;
  return typeof digest === "string" ? digest : undefined;
}

function restoreEffect(effect: RollbackEffect, options: RollbackOptions): boolean {
  if (effect.rollbackKind === "file-effect") {
    if (options.fileRestorer === undefined) return false;
    if (!options.fileRestorer.canRestore(effect)) return false;
    return options.fileRestorer.restore(effect);
  }
  if (effect.rollbackKind === "test" || effect.rollbackKind === "checkpoint") {
    return true;
  }
  return false;
}

function parseSequence(value: string, code: string): bigint {
  if (typeof value !== "string" || !/^[0-9]+$/u.test(value)) {
    throw new InputError("Timeline sequence is invalid", code);
  }
  const parsed = BigInt(value);
  if (parsed < 0n) {
    throw new InputError("Timeline sequence is out of range", code);
  }
  return parsed;
}

function formatSequence(value: bigint): string {
  return value.toString(10);
}

export type { RollbackOptions, RollbackResult, RollbackPlan, RollbackEffect, FileEffectRestorer };
