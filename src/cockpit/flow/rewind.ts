/**
 * REWIND — the cockpit's ONE owner for `retry`, `edit & resend` and
 * `rewind here` (DESIGN-COCKPIT-V2 §3.2).
 *
 * THE USER'S REPORT, VERBATIM: *"retry, edit & resend are creating new
 * entries, instead of modifying/rerunning the target one. this also includes
 * context I am pretty sure."*
 *
 * They were describing ONE bug wearing three labels. Before this module the
 * three verbs had three implementations and none of them was the operation
 * the user meant:
 *
 *   retry          → `beginCockpitRun(prompt)` — an APPEND. The run route
 *                    rebuilds history from every persisted message, so the
 *                    request carried the rejected turn as accepted history
 *                    AND two copies of the prompt.
 *   edit & resend  → `prefillComposer(text)` — put words in a box. Sending
 *                    them appended a new turn; the ORIGINAL wording stayed
 *                    in the context the model was about to read.
 *   rewind here    → `rollbackChat` — a DELETE of `messages` rows, with no
 *                    re-run, and nothing left to inspect afterwards.
 *
 * Both verbs the user named are the same operation — **rewind to a point and
 * re-run from there** — and `rewind here` is that operation without the
 * re-run. So there is one owner, and it is this file: every one of the three
 * goes through `rewindConversation`, which is `run.compose/rewind`, which is
 * `server/rewind.ts`. Nothing else in the cockpit truncates a conversation.
 *
 * ── WHY THIS GOES THROUGH `brokerAction` ───────────────────────────────────
 *
 * Because a rewind is an OPERATOR INTERVENTION and the flow already has a
 * representation for one: the `act` beat, added when the user asked to *"show
 * when we steer, manipulate context, trim, etc"*. Every block action passes
 * the Broker's choke point, which records provenance, which `ingest.ts`
 * mints an `act` beat from — carrying the DECLARED title and consequence the
 * server published for the action. Calling `fetch` here instead would have
 * meant inventing a second way to say "a rewind happened", and then keeping
 * two vocabularies true of each other forever.
 *
 * It is also why the past-view refusal is free: `brokerAction` asserts it at
 * the write door before it records anything.
 *
 * ── WHY THE PROMPT COMES BACK FROM THE SERVER ──────────────────────────────
 *
 * `retry` used to read the causing prompt out of the in-memory beat log
 * (`Flow.svelte::userPromptBefore`). History arrives in PAGES now: a
 * conversation opens at its tail and pages backwards. A model turn sitting
 * at the top of the loaded window has its causing prompt in a page the
 * browser has never fetched — so the lookup returned null and the verb
 * rendered *"retry re-sends the causing prompt — none is recorded before
 * this turn"*. That sentence is false. The prompt IS recorded; it is merely
 * not loaded, and the difference between those two is the whole product.
 *
 * The action therefore names the MODEL TURN (the beat the reader is standing
 * on, which is loaded by definition) and the server resolves the causing
 * prompt over the whole conversation, returning it as `promptForRerun`. The
 * client re-sends what the record says, not what it happened to be holding.
 */

import type { RewindMode } from "../../../shared/wire-types.ts";
import { atom } from "nanostores";
import { REWIND_CONFIRM_WINDOW_MS } from "./flow-config.ts";
import { action as brokerAction } from "../../data/broker.ts";
import { assertLiveForWrite } from "../../data/asof.ts";
import { ClientError } from "../../data/errors.ts";
import { isRunActive } from "../../state/run-state.ts";
import { loadChatHistory } from "../../client.ts";
import { registerContextReset } from "../../state/store-registry.ts";
import { beginCockpitRun } from "./run-stream.ts";

// The `at` / `causing-prompt` vocabulary is owned by shared/wire-types.ts
// (it is this action's `mode` field). Re-exported so callers in the flow can
// name it without reaching across the wire boundary themselves.
export type { RewindMode };

/** What `run.compose/rewind` answers with. Measured on the server over the
 * whole conversation, never estimated here. */
export type RewindOutcome = Readonly<{
  /** The ledger event that recorded the rewind. */
  eventId: string;
  /** First message withdrawn, inclusive. */
  anchorMessageId: string;
  /** Every id withdrawn, in the conversation's declared order. */
  discardedMessageIds: readonly string[];
  /** How many were withdrawn — the server's own count. */
  discarded: number;
  /** The anchor's recorded text when the anchor is a user turn, else null. */
  promptForRerun: string | null;
}>;

/** Why a rewind cannot run right now, or null when it can. Refused at the
 * ONE door all three rewind verbs pass (this module), so no verb can forget
 * the check — and refused as a typed client error whose sentence the verb
 * control renders beside itself. */
function liveRunBlockReason(): string | null {
  if (!isRunActive.get()) return null;
  return "a run is still live in this conversation — steering reaches it now; the rewind waits until it settles (stop it, or let it finish)";
}

/**
 * Record the rewind and reload the corrected conversation.
 *
 * The reload is not cosmetic: the transcript store still holds the withdrawn
 * turns, and every later assembly the CLIENT does (the composer's next send,
 * the desk's strips) reads from it. Leaving them there would put the browser
 * and the server into disagreement about what the conversation is — which is
 * the same class of lie as sending them.
 *
 * ── THE TWO-PRESS CONFIRM ─────────────────────────────────────────────────
 *
 * A rewind is a destructive verb wearing three labels (`rewind here`,
 * `retry`, `edit & resend`), and it now confirms like every other
 * destructive verb in this product (the custody undo's shape, the recycle
 * verb's shape): the first press THROWS the confirm sentence — the verb
 * control renders it beside itself — and arms the target; a second press
 * inside REWIND_CONFIRM_WINDOW_MS performs. Measured live (UIE-039): one
 * press of `rewind here` withdrew 165 messages, the whole conversation,
 * with no confirm and no way back. The `alreadyArmed` bypass exists for
 * ONE caller — the send that consumes an armed edit, whose first press
 * was the `edit & resend` verb itself (it armed the replacement and said
 * so), making the send the second gesture of the pair: one confirm
 * covering the whole replace, never two for one correction.
 */
export async function rewindConversation(
  chatId: string,
  toMessageId: string,
  mode: RewindMode,
  opts: Readonly<{ alreadyArmed?: boolean }> = {},
): Promise<RewindOutcome> {
  // A rewind under a LIVE run would withdraw turns the streaming run is
  // still reading — its next request would be built over a transcript the
  // reader just changed underneath it. This is the door `retry`, `edit &
  // resend` and `rewind here` all pass, so the refusal covers all three at
  // once; steering is the live-run door for words, and the rewind doors
  // wait. Checked HERE (at the operation, not the verb factory) because
  // liveness changes after the verbs are minted — a verb rendered while no
  // run existed can be pressed after one started.
  // Checked HERE (at the operation, not the verb factory) because the view
  // can change after the verbs are minted; and BEFORE the confirm so a
  // read-only view can never plant an armed target — a stale arm is a
  // destructive intent nobody disarmed.
  assertLiveForWrite();
  const blocked = liveRunBlockReason();
  if (blocked !== null) throw new ClientError("chat_run_live", blocked);
  if (opts.alreadyArmed !== true) {
    const key = confirmKeyOf(chatId, toMessageId, mode);
    const armed = armedRewindConfirm.get();
    if (armed === null || armed.key !== key || Date.now() - armed.at > REWIND_CONFIRM_WINDOW_MS) {
      // ONE slot, not a map of targets: "press again" means the LAST
      // destructive intent pressed. A second target's first press REPLACES
      // the arm (the reader changed their mind about which turn to take
      // back) rather than leaving a second live confirm that could fire a
      // beat the reader stopped aiming at.
      armedRewindConfirm.set({ key, at: Date.now() });
      throw new ClientError(
        "rewind_confirm",
        "rewind takes back this turn and everything after it — press again to take them back (the record keeps them; restore from here brings them back)",
        undefined,
        // The arm's own key — the sentence renders only while THIS key owns
        // the slot, so a retarget clears the first target's face (UIE-043).
        key,
      );
    }
    armedRewindConfirm.set(null);
  }
  const outcome = await brokerAction<RewindOutcome>(
    "run.compose",
    "rewind",
    { chatId, toMessageId, mode },
    // `compose:changed` re-measures the desk's strips; `chat:changed` is the
    // event the conversation surfaces listen on.
    { invalidates: ["compose:changed", "chat:changed"] },
  );
  await loadChatHistory(chatId);
  return outcome;
}

// ── The two-press confirm's armed state ────────────────────────────────────
//
// ONE armed confirm at a time (the newest press owns it). The key carries
// the target AND the mode because `at` and `causing-prompt` on the same
// named turn are different withdrawals — a confirm for one must not
// perform the other. Cleared on every conversation change (an armed
// confirmation is about ONE conversation — the same rule the armed edit
// below obeys, and for the same reason: a stale arm must never fire
// against a conversation nobody aimed it at).
//
// THE SLOT IS OBSERVABLE, and that is the face fix (UIE-043): the confirm
// sentence renders on the Verb control that caught the throw, and the
// sentence's lifetime must FOLLOW the arm — one arm, one rendered face. A
// plain module-local variable could not tell a control that the arm had
// moved on, so a retargeted press left the FIRST target's "press again"
// standing beside the second's: two faces for one arm, and pressing the
// stale one re-armed rather than performed — safe, but untrue copy. The
// atom is the arm's own truth made subscribable; the control reads it and
// clears its face the moment its key no longer owns the slot.
type ArmedRewindConfirm = Readonly<{ key: string; at: number }>;
export const armedRewindConfirm = atom<ArmedRewindConfirm | null>(null);

/** The confirm key of one rewind target. */
function confirmKeyOf(chatId: string, toMessageId: string, mode: RewindMode): string {
  return `${chatId}\0${mode}\0${toMessageId}`;
}

/** Drop the armed confirm (conversation change, and the module reset). */
function clearArmedRewindConfirms(): void {
  armedRewindConfirm.set(null);
}

registerContextReset("flowRewindConfirms", clearArmedRewindConfirms);

// ── The restore door: a withdrawal is reversible by design ──────────────────

/**
 * What `run.compose/restore` answers with. The server measures everything
 * over the RECORDED withdrawal — the caller never supplies the ids to
 * bring back, so this door can only ever reverse exactly what one recorded
 * rewind took.
 */
export type RestoreOutcome = Readonly<{
  /** The ledger event that recorded the reversal. */
  eventId: string;
  /** The withdrawal this restore took back. */
  restoredEventId: string;
  /** Every message id the withdrawal had taken, back in the conversation. */
  restoredMessageIds: readonly string[];
  /** How many came back — the server's own count. */
  restored: number;
}>;

/**
 * Bring one recorded withdrawal back — the door the withdrawn region's own
 * beat carries (`restore from here`).
 *
 * A rewind never deletes anything: the rows stay served, flagged, and the
 * ledger names them, which is exactly what makes the act reversible. The
 * restore appends the reversal (the same append-only law the rewind obeys),
 * the server re-serves the stretch unflagged, and the reload puts the beats
 * back on screen. The same live-run guard as the rewind: a restore under a
 * streaming run would change the transcript underneath it mid-flight.
 */
export async function restoreWithdrawn(chatId: string, eventId: string): Promise<RestoreOutcome> {
  // The same write-door order as the rewind: the read-only refusal first
  // (an unwritable view reverses nothing), the live-run guard second.
  assertLiveForWrite();
  const blocked = liveRunBlockReason();
  if (blocked !== null) throw new ClientError("chat_run_live", blocked);
  const outcome = await brokerAction<RestoreOutcome>(
    "run.compose",
    "restore",
    { chatId, eventId },
    { invalidates: ["compose:changed", "chat:changed"] },
  );
  await loadChatHistory(chatId);
  return outcome;
}

/**
 * Rewind to a point and re-run from it — the operation both `retry` and
 * `edit & resend` actually are.
 *
 * `prompt` is the caller's replacement text (edit & resend). Omitted, the
 * recorded prompt at the anchor is re-sent unchanged (retry). A rewind whose
 * anchor is not a user turn has no prompt to re-run, and rather than invent
 * one the rewind stands alone — the conversation is rewound and the composer
 * is where the next words come from.
 *
 * The live-run guard lives in `rewindConversation` (this passes through it),
 * which is what makes "only when NOT live" true for the re-run arms too: a
 * rewind-then-rerun under a live run would both corrupt the streaming run's
 * context AND start the second concurrent run in one conversation.
 *
 * ── WHERE A REFUSED RE-RUN SPEAKS ─────────────────────────────────────────
 *
 * The rewind half WITHDRAWS the beat the pressed verb was rendered on, so by
 * the time the re-run half runs, the verb's own failure span no longer exists
 * — a refusal spoken there dies with the beat and the reader sees nothing
 * (measured live, UIE-014: the raced 428's sentence was on the wire and on
 * no surface). `onRerunFailure` is where the re-run's failures speak instead:
 * the shell's hint line, which survives the rewind. Omitted, the failure
 * RETHROWS — the caller's local surface is then the honest fallback.
 */
export async function rewindAndRerun(
  args: Readonly<{
    projectId: string;
    chatId: string;
    toMessageId: string;
    mode: RewindMode;
    prompt?: string;
    onRerunFailure?: (sentence: string) => void;
  }>,
): Promise<void> {
  const outcome = await rewindConversation(args.chatId, args.toMessageId, args.mode);
  const prompt = args.prompt ?? outcome.promptForRerun;
  if (prompt === null || prompt.length === 0) return;
  try {
    await beginCockpitRun(args.projectId, prompt, { chatId: args.chatId });
  } catch (err) {
    if (args.onRerunFailure !== undefined) {
      args.onRerunFailure(err instanceof Error ? err.message : String(err));
      return;
    }
    throw err;
  }
}

// ── edit & resend: the armed half ───────────────────────────────────────────
//
// `edit & resend` is two gestures with the user's typing in between, so the
// anchor has to survive from the click to the send. It is held HERE rather
// than in a state store because the cockpit's sole-writer law keeps
// state-store writes inside client.ts, and because this is genuinely
// cockpit-internal: nothing outside the flow's own send path may consume it.
//
// It is a SINGLE slot carrying its chat id. Two conversations cannot each
// have an armed edit, and an armed edit belonging to a conversation you are
// no longer in is never consumed — `consumeArmedEdit` checks the id it was
// armed for, so the worst a stale arm can do is nothing.

type ArmedEdit = Readonly<{ chatId: string; messageId: string }>;

let armed: ArmedEdit | null = null;

/** Arm the next composer send to REPLACE this message instead of following
 * it. Called by the `edit & resend` verb, alongside the prefill. */
export function armEditAndResend(chatId: string, messageId: string): void {
  armed = { chatId, messageId };
}

/** The message the next send would replace in this chat, or null. Read by
 * surfaces that want to say so before the user commits. */
export function armedEditFor(chatId: string): string | null {
  return armed !== null && armed.chatId === chatId ? armed.messageId : null;
}

/** Drop any armed edit. Called when the conversation changes: an anchor from
 * a chat you left must not fire against the one you opened. */
export function clearArmedEdit(): void {
  armed = null;
}

// Self-registered on the chat-change signal, the same way every snapshot
// store is: an anchor is about ONE conversation, and carrying it across a
// switch is how a rewind fires against a conversation nobody aimed it at.
// The chat-id check in `armedEditFor` is the second lock, not the only one.
registerContextReset("flowArmedEdit", clearArmedEdit);

/**
 * If an edit is armed for this chat, perform its rewind and report it.
 *
 * Called by the composer's plain-text route BEFORE the run starts, so the
 * withdrawal is recorded and the history reloaded before the optimistic user
 * turn is appended. Disarmed FIRST: a rewind that throws must not leave the
 * anchor armed for the retry the user is about to attempt, or the second
 * send would try to withdraw a stretch the first one already did.
 *
 * THE SEND IS THE SECOND PRESS OF THE PAIR. The `edit & resend` verb press
 * armed the replacement and said what the send would do, so this call
 * performs the withdrawal without re-confirming — one confirm covering the
 * whole replace (`alreadyArmed`), never two for one correction.
 */
export async function consumeArmedEdit(chatId: string): Promise<RewindOutcome | null> {
  const pending = armedEditFor(chatId);
  if (pending === null) return null;
  clearArmedEdit();
  return await rewindConversation(chatId, pending, "at", { alreadyArmed: true });
}
