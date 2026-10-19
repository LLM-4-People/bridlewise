/**
 * REWIND — the single owner of "this part of the conversation is withdrawn".
 *
 * THE USER'S REPORT, VERBATIM: *"retry, edit & resend are creating new
 * entries, instead of modifying/rerunning the target one. this also includes
 * context I am pretty sure."*
 *
 * They were right about both halves, and the second half is the serious one.
 * Measured before this module existed, against the real run route with only
 * the provider class stubbed (`tests/prevention/rewind-reaches-provider.test.ts`):
 *
 *   retry           → the request handed to `client.stream()` carried the
 *                     ABANDONED assistant turn as accepted history AND two
 *                     copies of the user prompt.
 *   edit & resend   → the request carried the ORIGINAL wording the user had
 *                     just corrected, followed by the correction — so the
 *                     model saw the mistake it was being asked to avoid.
 *
 * Both verbs are ONE operation — rewind to a point and re-run from there —
 * and this module is that one operation. `retry`, `edit & resend` and
 * `rewind here` all route through `run.compose/rewind`, which calls
 * `planRewind` + `recordRewind` here; nothing else truncates a conversation.
 *
 * ── A REWIND IS A RECORDED EVENT, NOT AN ERASURE ───────────────────────────
 *
 * Nothing is deleted. The `messages` rows stay exactly where they are, and a
 * `rollback`-type ledger event is APPENDED naming the anchor and the exact
 * ids withdrawn. What changes is the WORLD — what the next request carries —
 * and the change is driven by reading the record, not by damaging it.
 *
 * This is not a stylistic preference. The ledger became append-only at the
 * storage layer (BEFORE UPDATE / BEFORE DELETE triggers on `event_log`,
 * `event_documents`, `event_edges`), and the abort message states the move:
 * *"To undo an effect, reverse it in the world and append an event recording
 * the reversal."* A rewind is that shape, so it is built that way — and the
 * withdrawn turns therefore remain recoverable and inspectable, which a
 * DELETE could never promise.
 *
 * ── WHY THE EVENT CARRIES THE IDS, NOT JUST THE ANCHOR ─────────────────────
 *
 * A rewind recorded as "everything at or after message M" would be a
 * PREDICATE, and the messages appended by the re-run also sit at or after M.
 * The next assembly would fold that predicate over the new turns and discard
 * them too — the rewind would eat its own replacement, and every subsequent
 * turn after it, silently. So the event records the MEASURED set: the ids
 * that existed at the instant the rewind was recorded. It is a statement
 * about what happened, which is the only kind of statement a ledger holds.
 *
 * ── THE HONORING POINT ─────────────────────────────────────────────────────
 *
 * `server/chat-history.ts::buildConversationHistory` — the one function that
 * turns persisted rows into the model's messages. The run route and the
 * context desk (`run.compose`) both call it, so the desk's strips and the
 * request the provider receives cannot disagree about what was withdrawn.
 * Filtering anywhere else would be a second path for one question.
 */

import { COMPOSE_FOLD_LIMIT } from "../../shared/constants.ts";
import type { RewindMode } from "../../shared/wire-types.ts";
import { sha256 } from "../kernel/digest.ts";
import { webWarn } from "../observability/debug-bridge.ts";
import { NotFoundError } from "../kernel/errors.ts";
import { getTimelineRecorder, getTimelineStore } from "../observability/timeline-bridge.ts";
import type { MessageRow } from "../db/client.ts";

/**
 * The ledger lane. `rollback` is the declared event type for undoing prior
 * work — the same lane `recordRemoval("chat-messages", …)` uses. A rewind is
 * that kind of act, so it lands IN the lane rather than beside it.
 */
const REWIND_EVENT_TYPE = "rollback" as const;
/** Document name carrying the rewind payload. */
export const REWIND_DOCUMENT = "rewind";
/** Description prefix — the fold reads only rows that carry it. */
const REWIND_DESCRIPTION_PREFIX = "rewind:";

/**
 * ── UNDOING AN UNDO ────────────────────────────────────────────────────────
 *
 * A destructive action has to be reversible, and a rewind is no exception to
 * its own rule. The reversal is built the way the abort message says every
 * reversal must be: *"To undo an effect, reverse it in the world and append an
 * event recording the reversal."* So a restore does not edit, delete or
 * annotate the rewind event — the storage layer would refuse, and rightly.
 * It APPENDS a second event in the same lane naming the ids coming back, and
 * the fold below reads both kinds in recorded order.
 *
 * ORDER IS THE WHOLE MECHANISM, which is why the fold walks ascending rather
 * than collecting two sets and subtracting. Withdraw A, restore A, withdraw A
 * again is a real sequence a reader can produce in three clicks, and only the
 * ordered walk ends with A withdrawn. Two sets and a subtraction would end
 * with A live — the last thing the user did, silently undone.
 */
export const RESTORE_DOCUMENT = "rewind-restore";
/** Description prefix for the reversal. Same lane, distinguishable row. */
const RESTORE_DESCRIPTION_PREFIX = "rewind-restore:";

// `RewindMode` (the `at` / `causing-prompt` vocabulary) is owned by
// shared/wire-types.ts — it is the `mode` field of this action's input, so
// the server and the cockpit read ONE declaration of it.
export type { RewindMode };

export type RewindPlan = Readonly<{
  /** First message withdrawn, inclusive. */
  anchorMessageId: string;
  /** Every id withdrawn, in the conversation's declared order. */
  discardedMessageIds: readonly string[];
  /**
   * Runs this rewind withdrew anything from.
   *
   * They are recorded because the conversation history is not the only door
   * into the model's context. A completed run also stores `User: …\nAssistant:
   * …` as a short-term memory, and memory is recalled into the SYSTEM PROMPT
   * of later turns. Withdrawing the turns without withdrawing the run's memory
   * left the abandoned answer reaching the model anyway, verbatim, by a second
   * path — the exact shape of defect this codebase keeps finding.
   *
   * ── "ANY", NOT "ENTIRELY", AND THE MEASUREMENT THAT SETTLED IT ───────────
   *
   * This condition WAS "entirely": a run kept its memory while any of its
   * messages survived, on the reasoning that such a memory is still true of
   * the conversation. That reasoning does not survive contact with what the
   * memory actually CONTAINS. The stored text is the run's prompt and its
   * FINAL assistant answer, and a rewind always withdraws a suffix — so a run
   * that is partly withdrawn is precisely a run whose final answer is gone,
   * which is the half the memory quotes.
   *
   * `rewind here` is the mode that reaches it: anchored on a MODEL turn, it
   * withdraws the answer and leaves the prompt that caused it live, so the run
   * has a survivor and kept its memory. Measured against the real chain, the
   * next request's system prompt then read:
   *
   *   - [short-term] User: what is the plimbex coefficient
   *     Assistant: the plimbex coefficient is measured in furlongs per candela
   *
   * — the withdrawn answer, verbatim, in the one part of the request nobody
   * looks at. The cost of the other direction is that a partly-withdrawn run
   * loses the RECALL of its surviving prompt; that prompt is still in the
   * conversation and still reaches the model directly, so the trade is a
   * weaker recall against a leak, and it is not close.
   */
  discardedRunIds: readonly string[];
  /**
   * The anchor's own text when the anchor is a user turn — the prompt a
   * re-run should send. Null when the anchor is not a user turn (then the
   * caller has nothing to re-run and must say so rather than invent one).
   */
  promptForRerun: string | null;
}>;

/**
 * Locate the anchor and the set to withdraw, over the chat's declared order.
 *
 * Pure over the rows it is given so it can be tested without a database, and
 * so the ordering it relies on is the caller's stated one
 * (`listMessages` orders by `(created_at, rowid)` — the same total order the
 * history cursor pages through).
 *
 * Returns null when the named message is not in the list: a rewind against a
 * message this chat does not hold is refused, never rounded to the nearest
 * plausible one.
 */
export function planRewind(
  messages: readonly MessageRow[],
  toMessageId: string,
  mode: RewindMode,
  alreadyDiscarded: ReadonlySet<string> = new Set(),
): RewindPlan | null {
  const namedIndex = messages.findIndex((m) => m.id === toMessageId);
  if (namedIndex < 0) return null;

  let anchorIndex = namedIndex;
  if (mode === "causing-prompt") {
    // Walk back to the user turn that caused the named turn. It is at-or-
    // before the named message; `at` on a user message and `causing-prompt`
    // on that same message therefore agree, which is what makes the two
    // modes one operation rather than two.
    anchorIndex = -1;
    for (let i = namedIndex; i >= 0; i -= 1) {
      const row = messages[i]!;
      if (row.role === "user" && !alreadyDiscarded.has(row.id)) {
        anchorIndex = i;
        break;
      }
    }
    if (anchorIndex < 0) return null;
  }

  const anchor = messages[anchorIndex]!;
  const discarded: string[] = [];
  const runsTouched = new Set<string>();
  for (let i = anchorIndex; i < messages.length; i += 1) {
    const row = messages[i]!;
    // A record-fact row (the `event` role — a withdrawal's own "taken back
    // from here" row, its "brought back" reversal, and the run-level
    // annotations the executor persists) is the RECORD'S voice, not a turn.
    // Turns come and go; the facts about the coming and going never do —
    // a rewind that withdrew them would erase the transcript's memory of
    // the interventions that shaped it, and every re-run's fresh turns
    // would then sit beside a record that forgot how they got there.
    if (row.role === "event") continue;
    // Already-withdrawn rows are not re-recorded. The event is a statement
    // about what THIS rewind withdrew; counting a previous rewind's turns
    // again would inflate every number a reader is shown about it.
    if (alreadyDiscarded.has(row.id)) continue;
    discarded.push(row.id);
    if (row.run_id !== null && row.run_id !== undefined && row.run_id !== "") {
      runsTouched.add(row.run_id);
    }
  }

  return Object.freeze({
    anchorMessageId: anchor.id,
    discardedMessageIds: Object.freeze(discarded),
    discardedRunIds: Object.freeze([...runsTouched]),
    promptForRerun: anchor.role === "user" ? anchor.content : null,
  });
}

type RewindDoc = Readonly<{
  chatId: string;
  userId: string;
  anchorMessageId: string;
  discardedMessageIds: readonly string[];
  discardedRunIds: readonly string[];
  mode: RewindMode;
}>;

/**
 * Append the rewind to the ledger.
 *
 * Throws on failure, unlike `recordRemoval` — and the difference is the
 * point. `recordRemoval` records something that has ALREADY been destroyed,
 * so a throw there would report failure for an operation that succeeded. Here
 * the event IS the operation: no row has been touched, and if the record
 * cannot be written then the rewind has not happened and the caller must hear
 * that instead of a success it can never account for.
 */
export function recordRewind(doc: RewindDoc): string {
  const contentJson = JSON.stringify(doc);
  const record = getTimelineRecorder().recordEvent({
    eventType: REWIND_EVENT_TYPE,
    description: `${REWIND_DESCRIPTION_PREFIX}${doc.chatId} to ${doc.anchorMessageId} (${doc.discardedMessageIds.length})`,
    outcome: "succeeded",
    documents: [
      {
        name: REWIND_DOCUMENT,
        contentJson,
        contentDigest: sha256(contentJson),
      },
    ],
  });
  return record.eventId;
}

/**
 * One recorded withdrawal, as a reader is shown it.
 *
 * `restored` is carried on the SAME row rather than as a separate list,
 * because "this stretch was taken back, and then brought back" is one fact
 * about one event and splitting it would let a surface show half of it.
 */
export type WithdrawnStretch = Readonly<{
  /** The ledger event that recorded the withdrawal. The restore names it. */
  eventId: string;
  /** When it was recorded. */
  at: string;
  anchorMessageId: string;
  messageIds: readonly string[];
  /** The runs this withdrawal also took out of memory recall. */
  runIds: readonly string[];
  mode: RewindMode;
  /** True once a restore has brought this stretch back. */
  restored: boolean;
}>;

/**
 * Append the reversal of a recorded rewind.
 *
 * Takes the ids from the RECORDED event rather than from the caller, so a
 * restore can only ever bring back exactly what that rewind withdrew — a
 * caller cannot use this door to un-withdraw a turn some other rewind took,
 * or to name an id that was never withdrawn at all.
 *
 * Returns the reversal's own event id. Throws like `recordRewind` and for the
 * same reason: the event IS the restore.
 */
export function recordRestore(
  chatId: string,
  userId: string,
  target: WithdrawnStretch,
): string {
  // THE DOUBLE-RESTORE REFUSAL LIVES HERE, AT THE APPEND, NOT IN THE CALLER.
  //
  // A caller checks `stretch.restored` and then calls this — but between the
  // read and the append a second, concurrent restore of the SAME withdrawal
  // can pass the same check (the handler's `await`s yield the loop), and both
  // then append a reversal for one withdrawal: the record double-counts, and
  // every reader of it is told the turns came back twice. Measured under
  // full-suite worker pressure: `Promise.all([restore(id), restore(id)])`
  // returned 200 twice. The handler cannot close that window — the read and
  // the append are separated by its own awaits — so the refusal is repeated
  // HERE, synchronously, with no await between the re-read and the append:
  // in this one process the pair is then atomic, and the second caller sees
  // the first caller's row and is refused. (The route keeps its own
  // `stretch.restored` check as the friendly 404; this one is the
  // correctness boundary, and it throws the same refusal.)
  const alreadyRestored = rewindRowsForChat(chatId, userId).some(
    (row) => row.restoresEventId === target.eventId,
  );
  if (alreadyRestored) {
    throw new NotFoundError(
      `Withdrawal ${target.eventId} has already been brought back`,
    );
  }
  const doc = {
    chatId,
    userId,
    restoresEventId: target.eventId,
    anchorMessageId: target.anchorMessageId,
    discardedMessageIds: target.messageIds,
    // The RUNS come back too. A restore that returned the turns but left the
    // run withdrawn would put the conversation back while leaving its memory
    // permanently unrecallable — half an undo, and the half nobody can see.
    discardedRunIds: target.runIds,
    mode: target.mode,
  };
  const contentJson = JSON.stringify(doc);
  const record = getTimelineRecorder().recordEvent({
    eventType: REWIND_EVENT_TYPE,
    description: `${RESTORE_DESCRIPTION_PREFIX}${chatId} of ${target.eventId} (${target.messageIds.length})`,
    outcome: "succeeded",
    documents: [
      {
        name: RESTORE_DOCUMENT,
        contentJson,
        contentDigest: sha256(contentJson),
      },
    ],
  });
  return record.eventId;
}

function decodeRewindDoc(contentJson: string | undefined): RewindDoc | undefined {
  if (contentJson === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const r = parsed as Record<string, unknown>;
  if (typeof r.chatId !== "string" || typeof r.userId !== "string") return undefined;
  if (!Array.isArray(r.discardedMessageIds)) return undefined;
  if (!r.discardedMessageIds.every((id) => typeof id === "string")) return undefined;
  return r as unknown as RewindDoc;
}

/** One row of the rewind lane — a withdrawal, or the reversal of one. */
type LedgerRow = Readonly<{
  eventId: string;
  at: string;
  doc: RewindDoc;
  /** The event this row takes back, when it is a restore. */
  restoresEventId: string | null;
}>;

/**
 * Every rewind AND restore row this chat holds, oldest first, for this user.
 *
 * One query for both, because they share a lane and the fold needs them
 * together: reading them as two lists and pairing by timestamp would be a
 * second ordering to keep true of the first.
 *
 * Scoped by BOTH chat and user, like the compose fold beside it: a rewind
 * recorded by one user must not withdraw turns from another user's chat, and
 * the ledger is one file shared by every conversation on this server.
 */
function rewindRowsForChat(chatId: string, userId: string): readonly LedgerRow[] {
  let events;
  try {
    events = getTimelineStore().query({
      eventType: REWIND_EVENT_TYPE,
      ascending: true,
      limit: COMPOSE_FOLD_LIMIT,
    });
  } catch (queryErr) {
    // A ledger that cannot be read is not "no rewinds have happened". The
    // honest failure here is to send the FULL history — which is what the
    // model would have received anyway — and to say loudly that the fold was
    // not applied, rather than silently serving an unrewound conversation as
    // if it were the corrected one.
    webWarn("rewind", "rewind fold could not be read — history is NOT filtered", () => ({
      chatId,
      error: queryErr instanceof Error ? queryErr.message : String(queryErr),
    }));
    return [];
  }
  const rows: LedgerRow[] = [];
  for (const event of events) {
    // The two prefixes are disjoint (`rewind:` and `rewind-restore:`), so
    // neither test can claim the other's rows. It is worth saying because it
    // is a property of the two constants rather than of this code: a restore
    // prefix that BEGAN with the rewind prefix would make every reversal read
    // as a fresh withdrawal of the ids it was bringing back — the reversal
    // performing the act it reverses — and nothing here would notice.
    // `tests/prevention/rewind-reaches-provider.test.ts` holds the property.
    const isRestore = event.description.startsWith(RESTORE_DESCRIPTION_PREFIX);
    if (!isRestore && !event.description.startsWith(REWIND_DESCRIPTION_PREFIX)) continue;
    const doc = decodeRewindDoc(
      event.documents.find((d) => d.name === (isRestore ? RESTORE_DOCUMENT : REWIND_DOCUMENT))
        ?.contentJson ?? undefined,
    );
    if (doc === undefined) continue;
    if (doc.chatId !== chatId || doc.userId !== userId) continue;
    const restores = (doc as unknown as { restoresEventId?: unknown }).restoresEventId;
    rows.push(Object.freeze({
      eventId: event.eventId,
      at: event.wallTime,
      doc,
      restoresEventId: isRestore && typeof restores === "string" ? restores : null,
    }));
  }
  return rows;
}

/**
 * WHAT THIS CONVERSATION HAS TAKEN BACK — the record, made inspectable.
 *
 * A rewind keeps every row and names them in the ledger, which is what makes
 * it recoverable; none of that is worth anything if no surface can reach it.
 * This is that surface's read: one entry per recorded withdrawal, newest
 * first, each saying when it happened, where it started, how many turns it
 * took and whether it has since been brought back.
 */
export function withdrawnStretchesForChat(
  chatId: string,
  userId: string,
): readonly WithdrawnStretch[] {
  const rows = rewindRowsForChat(chatId, userId);
  const restoredEventIds = new Set(
    rows.map((row) => row.restoresEventId).filter((id): id is string => id !== null),
  );
  const stretches: WithdrawnStretch[] = [];
  for (const row of rows) {
    if (row.restoresEventId !== null) continue;
    stretches.push(Object.freeze({
      eventId: row.eventId,
      at: row.at,
      anchorMessageId: row.doc.anchorMessageId,
      messageIds: row.doc.discardedMessageIds,
      runIds: row.doc.discardedRunIds ?? [],
      mode: row.doc.mode,
      restored: restoredEventIds.has(row.eventId),
    }));
  }
  return Object.freeze(stretches.reverse());
}

/** One recorded withdrawal by its event id, or null. The restore door reads
 * the ids it will bring back from HERE rather than from its caller. */
export function withdrawnStretchById(
  chatId: string,
  userId: string,
  eventId: string,
): WithdrawnStretch | null {
  return withdrawnStretchesForChat(chatId, userId).find((s) => s.eventId === eventId) ?? null;
}

/**
 * The FOLD: every message id this chat has withdrawn, for this user.
 *
 * Scoped by BOTH chat and user, like the compose fold beside it: a rewind
 * recorded by one user must not withdraw turns from another user's chat, and
 * the ledger is one file shared by every conversation on this server.
 */
export function discardedMessageIdsForChat(
  chatId: string,
  userId: string,
): ReadonlySet<string> {
  return foldWithdrawnIds(
    rewindRowsForChat(chatId, userId),
    (doc) => doc.discardedMessageIds,
  );
}

/**
 * The union of the ids named by every rewind that has NOT been taken back.
 *
 * PER EVENT, NOT PER ID, and that is the whole correctness of it. Subtracting
 * a restore's ids from a running set looks equivalent and is not: two rewinds
 * can name the SAME RUN (the first withdraws part of a run's turns, a later
 * one withdraws the rest), so removing one rewind's run ids would un-withdraw
 * a run the OTHER rewind still withdraws — and the abandoned answer would come
 * back into the system prompt through the memory channel, which is the exact
 * second door this module exists to close.
 *
 * Deciding per event also makes withdraw → restore → withdraw-again come out
 * right for free: the second withdrawal is a different event, and nothing
 * restored it.
 */
function foldWithdrawnIds(
  rows: readonly LedgerRow[],
  idsOf: (doc: RewindDoc) => readonly string[],
): ReadonlySet<string> {
  const takenBack = new Set(
    rows.map((row) => row.restoresEventId).filter((id): id is string => id !== null),
  );
  const withdrawn = new Set<string>();
  for (const row of rows) {
    if (row.restoresEventId !== null) continue;
    if (takenBack.has(row.eventId)) continue;
    for (const id of idsOf(row.doc) ?? []) withdrawn.add(id);
  }
  return withdrawn;
}

/**
 * The FOLD, second half: every RUN this chat has withdrawn.
 *
 * The honoring point is `applyComposeAdjustments` — the same single place the
 * desk's strips and the run's assembly both pass through — so a withdrawn
 * run's stored interaction stops being recalled into the system prompt.
 */
export function discardedRunIdsForChat(
  chatId: string,
  userId: string,
): ReadonlySet<string> {
  return foldWithdrawnIds(
    rewindRowsForChat(chatId, userId),
    (doc) => doc.discardedRunIds ?? [],
  );
}
