/**
 * ARM — `arm.flags` (DESIGN-COCKPIT-V2.md §6.4).
 *
 * The retro-trigger's storage: armed trigger predicates and captured ranges,
 * LEDGER-BACKED. Nothing is copied when a range is captured — the record was
 * already there; a capture is a BOOKMARK over the ledger (t0..t1 + label),
 * and a trigger is a stored when-eval predicate. Every state change is an
 * appended ledger event (append-only store: a "clear" is a tombstone event,
 * never a deletion), so the flags themselves are replayable history.
 *
 * PREDICATE VALIDATION — THE AMBIENT VOCABULARY
 *
 * A trigger predicate is a when-eval expression (the SAME grammar the UI's
 * `when` clauses use — `shared/when-eval.ts` is the single parser owner;
 * imported, not re-implemented). Validation is deny-by-default twice:
 * the expression must PARSE, and every identifier root it references must be
 * in `ARM_PREDICATE_VOCABULARY` — the contract for what the live stream can
 * actually bind. A predicate over a vocabulary nothing provides would arm a
 * trigger that can never fire while looking exactly like one that can.
 *
 * HONEST LIMIT, STATED: there is NO server-side firing check on event
 * append in this round — the v1 consumer arms client-side over the live
 * stream and evaluates predicates there. The block descriptor says so, and
 * `serverSideFiring: false` is on every read so no surface can imply the
 * server watches these triggers.
 *
 * OWNERSHIP: flags are per-user. Each event's document carries the acting
 * `userId` (the same value the ambient recording actor carries — written,
 * not inferred), and reads fold ONLY the caller's events. A `chatId`, when
 * given, is verified through the user-scoped `getChat` (404 hides
 * existence).
 */

import { z } from "zod";

import { generateId } from "../kernel/canonical.ts";
import { sha256 } from "../kernel/digest.ts";
import { evalWhen } from "../../shared/when-eval.ts";
import {
  ARM_PREDICATE_VOCABULARY,
  predicateRoots,
} from "../../shared/arm-vocabulary.ts";
import { ARM_FOLD_LIMIT } from "../../shared/constants.ts";
import { ArmPredicateRefusedError, NotFoundError } from "../kernel/errors.ts";
import { getTimelineRecorder, getTimelineStore } from "../observability/timeline-bridge.ts";
import { requireUserContext } from "../auth/user-context.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
import type { RouteContext } from "../router/router.ts";
import { defineBlock, RANGED_UNTIL_PARAM, type BlockHandlerContext } from "./define.ts";

// ── The ambient vocabulary ─────────────────────────────────────────────────

// The vocabulary lives in shared/arm-vocabulary.ts — the ONE map both the
// validator here and the client's arm palette (sweep/arm-palette.ts) derive
// from, so neither end re-states the other. Re-exported for the existing
// consumers that import it from this module.
export { ARM_PREDICATE_VOCABULARY, predicateRoots };

/**
 * Validate a predicate: parses under the shared grammar AND references only
 * ambient-vocabulary roots. Throws a typed guided-family refusal otherwise —
 * an unarmable trigger must be refused at arm time, not discovered silent at
 * fire time.
 *
 * THE REFUSAL'S FAMILY (UIE-085): the request body parsed and the block's
 * zod schema passed — the expression is the USER's answer to a question the
 * arm door asked, and one the contract declines is a designed refusal with
 * its remedy in the sentence, exactly the line the settings family draws
 * between a malformed body (raw 400 `invalid_block_input`, a real failure)
 * and a declined value (the 428 envelope, the browser console quiet). The
 * surface renders the sentence verbatim either way; before this the same
 * refusal answered raw 400 and the BROWSER logged a console error line for
 * every designed refusal at this door.
 */
export function validatePredicate(expr: string): void {
  try {
    // The evaluator parses (and caches) the expression; an empty context is
    // fine — only syntax is judged here, truthiness is the client's job.
    evalWhen(expr, {});
  } catch (error) {
    throw new ArmPredicateRefusedError(
      `arm predicate does not parse: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const unknown = predicateRoots(expr).filter((r) => ARM_PREDICATE_VOCABULARY[r] === undefined);
  if (unknown.length > 0) {
    throw new ArmPredicateRefusedError(
      `arm predicate references unknown vocabulary: ${unknown.join(", ")} (known roots: ${Object.keys(ARM_PREDICATE_VOCABULARY).join(", ")})`,
    );
  }
}

// ── Ledger encoding ────────────────────────────────────────────────────────

/** Event type the arm events ride on (a declared, closed-registry member). */
const ARM_EVENT_TYPE = "checkpoint" as const;
/** Document name carrying the flag payload. */
export const ARM_DOCUMENT = "arm";
// The fold ceiling (`ARM_FOLD_LIMIT`) is owned by shared/constants.ts.

type ArmDoc = Readonly<{
  op: "set" | "capture" | "clear";
  id: string;
  userId: string;
  predicate?: string;
  t0?: number;
  t1?: number;
  label?: string;
  chatId?: string;
}>;

function recordArmEvent(op: ArmDoc["op"], doc: ArmDoc): void {
  const contentJson = JSON.stringify(doc);
  getTimelineRecorder().recordEvent({
    eventType: ARM_EVENT_TYPE,
    description: `arm:${op} ${doc.id}`,
    outcome: "succeeded",
    documents: [
      {
        name: ARM_DOCUMENT,
        contentJson,
        contentDigest: sha256(contentJson),
      },
    ],
  });
}

export type ArmFlag = Readonly<{
  id: string;
  kind: "trigger" | "range";
  predicate?: string;
  t0?: number;
  t1?: number;
  label?: string;
  chatId?: string;
  /** Wall time the flag was recorded (ISO, from the ledger row). */
  recordedAt: string;
}>;

export type ArmFlagsRead = Readonly<{
  flags: readonly ArmFlag[];
  /** Stated limit: the server does NOT evaluate these on event append. */
  serverSideFiring: false;
}>;

function decodeArmDoc(contentJson: string | undefined): ArmDoc | undefined {
  if (contentJson === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const r = parsed as Record<string, unknown>;
  if (typeof r.op !== "string" || typeof r.id !== "string" || typeof r.userId !== "string") {
    return undefined;
  }
  return r as unknown as ArmDoc;
}

/**
 * Fold the caller's arm events into the live flag set: set/capture insert,
 * clear tombstones. Events are read oldest→newest so a clear after a set
 * wins; a re-used id after a clear re-arms (append-only semantics).
 */
export function foldArmFlags(
  userId: string,
  options?: Readonly<{ chatId?: string; untilMs?: number }>,
): ArmFlagsRead {
  const events = getTimelineStore().query({
    eventType: ARM_EVENT_TYPE,
    ascending: true,
    limit: ARM_FOLD_LIMIT,
    ...(options?.untilMs !== undefined
      ? { toWallTime: new Date(options.untilMs).toISOString() }
      : {}),
  });
  const flags = new Map<string, ArmFlag>();
  for (const event of events) {
    if (!event.description.startsWith("arm:")) continue;
    const doc = decodeArmDoc(event.documents.find((d) => d.name === ARM_DOCUMENT)?.contentJson ?? undefined);
    if (doc === undefined) continue;
    if (doc.userId !== userId) continue;
    if (options?.chatId !== undefined && doc.chatId !== options.chatId) continue;
    if (doc.op === "clear") {
      flags.delete(doc.id);
      continue;
    }
    flags.set(doc.id, Object.freeze({
      id: doc.id,
      kind: doc.op === "set" ? ("trigger" as const) : ("range" as const),
      ...(doc.predicate !== undefined ? { predicate: doc.predicate } : {}),
      ...(doc.t0 !== undefined ? { t0: doc.t0 } : {}),
      ...(doc.t1 !== undefined ? { t1: doc.t1 } : {}),
      ...(doc.label !== undefined ? { label: doc.label } : {}),
      ...(doc.chatId !== undefined ? { chatId: doc.chatId } : {}),
      recordedAt: event.wallTime,
    }));
  }
  return Object.freeze({ flags: Object.freeze([...flags.values()]), serverSideFiring: false });
}

// ── Registration ───────────────────────────────────────────────────────────

const ReadInput = z.strictObject({
  chatId: z.string().min(1).max(256).optional(),
  /** Inclusive upper bound, epoch ms — the ranged-read convention
   * (`RANGED_UNTIL_PARAM`, declared once in define.ts). */
  until: RANGED_UNTIL_PARAM.optional(),
});

const SetInput = z.strictObject({
  predicate: z.string().min(1).max(512),
  label: z.string().min(1).max(120).optional(),
  chatId: z.string().min(1).max(256).optional(),
});

const CaptureInput = z
  .strictObject({
    t0: z.number().int().positive(),
    t1: z.number().int().positive(),
    label: z.string().min(1).max(120),
    chatId: z.string().min(1).max(256).optional(),
  })
  .refine((v) => v.t0 < v.t1, { message: "t0 must be before t1" });

const ClearInput = z.strictObject({
  id: z.string().min(1).max(128),
});

async function requireOwnedChat(
  db: AsyncDbClient,
  ctx: RouteContext,
  chatId: string | undefined,
  userId: string,
): Promise<void> {
  if (chatId !== undefined && (await db.getChat(chatId, userId)) === null) {
    throw new NotFoundError(`Chat ${chatId} not found`);
  }
  void ctx;
}

export function defineArmBlocks(db: AsyncDbClient): void {
  defineBlock({
    id: "arm.flags",
    title: "Armed triggers and captured ranges",
    description:
      "Ledger-backed retro-trigger flags: armed when-eval predicates and captured time ranges (bookmarks over the ledger — nothing is copied). Firing is evaluated CLIENT-side over the live stream; the server does not watch these on append, and every read says so.",
    read: {
      input: ReadInput,
      output: z.object({ flags: z.array(z.object({}).loose()), serverSideFiring: z.literal(false) }),
      ttlMs: 5_000,
      handler: async (input, { ctx }: BlockHandlerContext): Promise<ArmFlagsRead> => {
        const user = await requireUserContext(ctx, db);
        await requireOwnedChat(db, ctx, input.chatId, user.userId);
        return foldArmFlags(user.userId, {
          ...(input.chatId !== undefined ? { chatId: input.chatId } : {}),
          ...(input.until !== undefined ? { untilMs: input.until } : {}),
        });
      },
    },
    actions: {
      set: {
        input: SetInput,
        title: "Arm trigger",
        consequence:
          "Arms a watch for this condition on the live activity; when it happens, a flag drops at that instant. Stays armed until you clear it.",
        invalidates: ["arm:changed"],
        handler: async (input, { ctx }: BlockHandlerContext): Promise<ArmFlag> => {
          const user = await requireUserContext(ctx, db);
          await requireOwnedChat(db, ctx, input.chatId, user.userId);
          validatePredicate(input.predicate);
          const id = generateId("arm");
          recordArmEvent("set", {
            op: "set",
            id,
            userId: user.userId,
            predicate: input.predicate,
            ...(input.label !== undefined ? { label: input.label } : {}),
            ...(input.chatId !== undefined ? { chatId: input.chatId } : {}),
          });
          return Object.freeze({
            id,
            kind: "trigger" as const,
            predicate: input.predicate,
            ...(input.label !== undefined ? { label: input.label } : {}),
            ...(input.chatId !== undefined ? { chatId: input.chatId } : {}),
            recordedAt: new Date().toISOString(),
          });
        },
      },
      capture: {
        input: CaptureInput,
        title: "Capture range",
        consequence:
          "Saves this stretch of recorded activity under a name so you can come back to it; nothing is copied and nothing is changed.",
        invalidates: ["arm:changed"],
        handler: async (input, { ctx }: BlockHandlerContext): Promise<ArmFlag> => {
          const user = await requireUserContext(ctx, db);
          await requireOwnedChat(db, ctx, input.chatId, user.userId);
          const id = generateId("arm");
          recordArmEvent("capture", {
            op: "capture",
            id,
            userId: user.userId,
            t0: input.t0,
            t1: input.t1,
            label: input.label,
            ...(input.chatId !== undefined ? { chatId: input.chatId } : {}),
          });
          return Object.freeze({
            id,
            kind: "range" as const,
            t0: input.t0,
            t1: input.t1,
            label: input.label,
            ...(input.chatId !== undefined ? { chatId: input.chatId } : {}),
            recordedAt: new Date().toISOString(),
          });
        },
      },
      clear: {
        input: ClearInput,
        title: "Clear flag",
        consequence:
          "Removes this trigger or saved range from your list right away; the recorded history it pointed at is untouched.",
        invalidates: ["arm:changed"],
        handler: async (input, { ctx }: BlockHandlerContext): Promise<Readonly<{ cleared: true; id: string }>> => {
          const user = await requireUserContext(ctx, db);
          const current = foldArmFlags(user.userId);
          if (!current.flags.some((f) => f.id === input.id)) {
            // Deny-by-default and existence-hiding: another user's flag id and
            // a never-existing id answer identically.
            throw new NotFoundError(`Flag ${input.id} not found`);
          }
          recordArmEvent("clear", { op: "clear", id: input.id, userId: user.userId });
          return Object.freeze({ cleared: true as const, id: input.id });
        },
      },
    },
  });
}
