/**
 * COCKPIT FLOW — verb wiring (spec §1.2: no verb, no pixels).
 *
 * Every verb rendered on a beat either runs a REAL client call (functions
 * from src/client.ts — the allowlisted data layer) or a client navigation
 * primitive (expand/copy/prefill), or it renders DISABLED with the honest
 * reason ON it. A verb is never invented here: each `wired: false` entry
 * names exactly what it waits on.
 *
 * The wiring is a factory so the flow's ingestion stays pure and tests can
 * inject inert verbs.
 */

import { runProjectAutoCheck } from "../../client.ts";
import { assertLiveForWrite } from "../../data/asof.ts";
import { action as brokerAction } from "../../data/broker.ts";
import { ClientError } from "../../data/errors.ts";
import { jumpToBreakerRow } from "../desk/desk-bus.ts";
import { UNDO_CONFIRM_WINDOW_MS } from "../rooms/custody-config.ts";
import { SUGGESTION_CAP } from "../rooms/custody-data.ts";
import { beatById } from "./log.ts";
import { armEditAndResend, restoreWithdrawn, rewindAndRerun, rewindConversation } from "./rewind.ts";
import type { Beat, BeatVerb } from "./types.ts";

export type VerbContext = Readonly<{
  chatId: string | null;
  projectId: string | null;
  /** Toggle a beat's expanded state (client navigation primitive). */
  toggleExpand: (beatId: string) => void;
  /** Put text into the composer (client navigation primitive). Null when the
   * host composer exposes no prefill seam — the verb then renders disabled
   * with that reason (§1.2: an affordance whose effect cannot be delivered
   * must not wear a working label). */
  prefillComposer: ((text: string) => void) | null;
  /**
   * Speak a sentence on the shell's hint line. Null when no shell is mounted
   * (the standalone flow has no hint line). The ONE surface a verb's own
   * action can withdraw from under itself: a rewind takes back the beat the
   * verb was pressed on, so the re-run half's refusal must speak somewhere
   * that survives the rewind — the verb's local failure span dies with the
   * beat, unobserved (UIE-014's wire-only 428).
   */
  hint: ((sentence: string) => void) | null;
  /** Find the prompt text of the user turn preceding a model turn. */
  userPromptBefore: (beatId: string) => string | null;
}>;

/**
 * True when a message id is a persisted DB id (rollback's join key). Live
 * client-appended messages carry `msg-…` ids that exist only in this tab;
 * the rollback endpoint cannot address them until the transcript reloads.
 */
function isPersistedMessageId(beatId: string): boolean {
  // beat ids are `b-<messageId>`.
  return beatId.startsWith("b-") && !beatId.startsWith("b-msg-") && !beatId.startsWith("b-evt-");
}

function messageIdOf(beatId: string): string {
  return beatId.slice(2);
}

export function makeVerbsFor(ctx: VerbContext): (beat: Beat) => readonly BeatVerb[] {
  return (beat: Beat): readonly BeatVerb[] => {
    switch (beat.kind) {
      case "turn":
        return beat.turn?.who === "you" ? yourTurnVerbs(beat, ctx) : modelTurnVerbs(beat, ctx);
      case "tool":
        return toolVerbs(beat);
      case "effect":
        return effectVerbs(beat, ctx);
      case "check-delta":
        return checkDeltaVerbs(beat, ctx);
      case "event":
        return eventVerbs(beat, ctx);
      case "finding":
      case "seam":
        return [];
      // An OPERATOR INTERVENTION carries no verbs of its own. It is a thing
      // that HAPPENED, and the control that could do it again lives on the
      // surface it belongs to — the desk's strip, the breaker row, the arm
      // menu. Offering "do it again" here would put a second, differently
      // placed copy of a control the user already has, which is the exact
      // duplication the one-options-row pass removed (§1.2 names the gap
      // instead: there is none, so there are no verbs).
      case "act":
        return [];
    }
  };
}

/**
 * A rewind's own region beat — the inline `rewind` event the server
 * persists when it records a withdrawal — carries the door back. The
 * withdrawal's ledger address travels on the beat (`event.eventId`, the
 * same field the documents fold reads), and the verb names the declared
 * action (`run.compose/restore`, "Restore from here"). This is the one
 * place a beat offers an UN-happening: the event is a record of something
 * the reader can reverse, and the control that reverses it belongs on the
 * record itself, not on some other surface.
 */
function eventVerbs(beat: Beat, ctx: VerbContext): readonly BeatVerb[] {
  if (ctx.chatId === null || beat.event?.eventKind !== "rewind" || beat.event.eventId === undefined) {
    return [];
  }
  const chatId = ctx.chatId;
  const eventId = beat.event.eventId;
  return [
    {
      id: "run.compose/restore",
      label: "Restore from here",
      wired: true,
      writes: true,
      // Routed through the block door (`restoreWithdrawn`), so the
      // past-view refusal + the recorded provenance are the door's own.
      run: async () => {
        await restoreWithdrawn(chatId, eventId);
      },
    },
  ];
}

/**
 * THE THREE VERBS ARE ONE OPERATION — see `src/cockpit/flow/rewind.ts`.
 *
 * `edit & resend`, `retry` and `rewind here` all rewind to a point and
 * (except the last) re-run from it. They used to be three implementations,
 * none of which rewound: two appended and one deleted. They now route
 * through `rewindConversation` / `rewindAndRerun`, which is the single
 * `run.compose/rewind` door — so extending one of them extends the path all
 * three are on, rather than adding a fourth.
 */
function yourTurnVerbs(beat: Beat, ctx: VerbContext): readonly BeatVerb[] {
  const text = beat.turn?.text ?? "";
  const prefillSink = ctx.prefillComposer;
  const addressable = ctx.chatId !== null && isPersistedMessageId(beat.id);
  const verbs: BeatVerb[] = [];

  if (prefillSink !== null && addressable) {
    const chatId = ctx.chatId!;
    verbs.push({
      id: "composer.prefill",
      label: "Edit & resend",
      mark: "edit",
      // It ARMS a write; the write itself happens on send. Flagged so the
      // control refuses in a past view rather than arming an anchor that
      // would then fire against the live conversation.
      writes: true,
      wired: true,
      run: () => {
        assertLiveForWrite();
        // Two halves of one gesture: the words go in the composer, and the
        // message they REPLACE is armed so the send withdraws it instead of
        // following it. Without the second half the model still receives the
        // original wording — the very thing the user just corrected.
        armEditAndResend(chatId, messageIdOf(beat.id));
        prefillSink(text);
        // ONE CONFIRM COVERS THE REPLACE. The press is the FIRST gesture of
        // the destructive pair: the send that consumes the armed edit is the
        // second, so the reader is told HERE — at the arm — what the send
        // will take back, in the same inline shape every other destructive
        // verb confirms with. The sentence renders beside this verb; the
        // withdrawal itself needs no second confirm when the send lands.
        throw new ClientError(
          "rewind_confirm",
          "the send replaces this turn — it and everything after it is taken back when you send (the record keeps them; restore from here brings them back)",
        );
      },
    });
  } else {
    verbs.push({
      id: "composer.prefill",
      label: "Edit & resend",
      mark: "edit",
      wired: false,
      reason:
        prefillSink === null
          ? "this mount has no composer connected to prefill — copy the text instead"
          : "edit & resend replaces the saved message — this turn gets its saved id when the conversation reloads",
    });
  }

  if (addressable) {
    const chatId = ctx.chatId!;
    verbs.push({
      id: "run.compose/rewind",
      label: "Rewind here",
      wired: true,
      // `brokerAction` asserts the past-view refusal at the write door
      // itself; the flag is what lets the CONTROL say so first (§6.2).
      writes: true,
      run: async () => {
        // Withdraws this turn and everything after it. Nothing is deleted:
        // the ledger records the withdrawal and the rows stay served,
        // flagged. `at` — the turn you are standing on is the first thing
        // taken back, which is what "rewind HERE" means.
        await rewindConversation(chatId, messageIdOf(beat.id), "at");
      },
    });
  } else {
    verbs.push({
      id: "run.compose/rewind",
      label: "Rewind here",
      wired: false,
      reason:
        "rewind addresses the saved record — this turn gets its saved id when the conversation reloads",
    });
  }
  return verbs;
}

function modelTurnVerbs(beat: Beat, ctx: VerbContext): readonly BeatVerb[] {
  const verbs: BeatVerb[] = [
    {
      id: "clipboard.copy",
      label: "Copy",
      mark: "copy",
      wired: true,
      run: async () => {
        await navigator.clipboard.writeText(beat.turn?.text ?? "");
      },
    },
  ];
  // NOTE WHAT IS NOT CONSULTED HERE: `ctx.userPromptBefore`. It searches the
  // IN-MEMORY beat log, and history arrives in pages — a model turn at the
  // top of the loaded window has its causing prompt in a page the browser
  // never fetched, so the lookup returned null and this verb rendered
  // "none is recorded before this turn". The prompt was recorded; it was
  // not loaded. The server resolves it over the whole conversation now, so
  // the verb is wired whenever the TURN ITSELF is addressable — and the
  // turn you are standing on is loaded by definition.
  if (ctx.projectId !== null && ctx.chatId !== null && isPersistedMessageId(beat.id)) {
    const projectId = ctx.projectId;
    const chatId = ctx.chatId;
    verbs.unshift({
      id: "run.compose/rewind",
      label: "Retry",
      wired: true,
      writes: true,
      run: async () => {
        // A retry is a REWIND then a re-run, not an append. Appending left
        // the abandoned turn in the conversation, so the next request handed
        // the model its own rejected output as accepted history — the input
        // most likely to make it repeat the mistake being retried — and
        // carried both copies on every later turn thereafter.
        //
        // `causing-prompt`: the server walks back from this turn to the user
        // message that caused it, withdraws from there, and returns that
        // message's recorded text to re-send.
        //
        // THE RE-RUN'S REFUSAL SPEAKS ON THE HINT LINE: the rewind half has
        // already withdrawn THIS beat, so the failure span this verb renders
        // beside itself is gone before the re-run can fail — the raced 428
        // rode the wire with its sentence and no surface (UIE-014). The
        // shell's hint survives the rewind.
        await rewindAndRerun({
          projectId,
          chatId,
          toMessageId: messageIdOf(beat.id),
          mode: "causing-prompt",
          ...(ctx.hint !== null ? { onRerunFailure: ctx.hint } : {}),
        });
      },
    });
  } else {
    verbs.unshift({
      id: "run.compose/rewind",
      label: "Retry",
      wired: false,
      reason:
        ctx.projectId === null || ctx.chatId === null
          ? "retry re-runs the prompt that caused this turn — no conversation is open"
          : "retry addresses the saved record — this turn gets its saved id when the conversation reloads",
    });
  }
  return verbs;
}

function toolVerbs(beat: Beat): readonly BeatVerb[] {
  const toolName = beat.tool?.name;
  return [
    // ── TWO VERBS REMOVED HERE, both on the user's direct report ────────────
    //
    // `flow.expand` ("open") — THE USER'S REPORT, VERBATIM: "there is
    // something wrong with the buttons below the tool calls, open and
    // collapse do the same thing. we have the collapse." They are right that
    // the row published two controls for one outcome. `open` toggled the
    // card's inline expansion, which is ALSO what a body click does and what
    // the expand/collapse grip reads as — three affordances, one result, and
    // no way for a reader to tell which was which. The ruling was explicit:
    // keep the grip, drop the duplicate. Expansion is still one click on the
    // card, and the grip still names the move.
    //
    // `tools.rerun` ("run again") — it was permanently disabled and printed
    // its refusal, truncated mid-word, on every tool beat in the
    // conversation: "run again– no block declares a re-run action for a
    // single …". §1.2 asks a refusing control to say why; it does not ask a
    // control to advertise a capability that DOES NOT EXIST. Nothing in the
    // action fabric declares a re-run for a single recorded call, and no
    // amount of honest wording turns "this button will never work" into a
    // reason to render it. Re-running a call means starting a new run, which
    // the composer already does. If a block ever declares one, this is where
    // it goes back.
    // The `breaker` verb (§3.2, §3.5): jumps to this tool's breaker row on
    // the open desk — opening the desk if closed (a user gesture) and
    // scrolling/focusing the row (desk-bus). The row carries the real acts
    // (off/on at next boundary, reset, arm); this verb replaced the interim
    // `tools.enabled/toggle` subset once the tools.breaker block landed.
    toolName !== undefined
      ? {
          id: "tools.breaker/row",
          label: "Breaker",
          wired: true,
          run: () => {
            jumpToBreakerRow(toolName);
          },
        }
      : {
          id: "tools.breaker/row",
          label: "Breaker",
          wired: false,
          reason: "the recorded call carries no tool name — no breaker row to open",
        },
  ];
}

/** Beats whose undo is armed (first press seen), by beat id → armed-at ms.
 * Module-level so the two-press confirmation survives verb re-creation. */
const armedUndos = new Map<string, number>();

function effectVerbs(beat: Beat, ctx: VerbContext): readonly BeatVerb[] {
  const path = beat.effect?.path;
  const verbs: BeatVerb[] = [
    {
      id: "git.diff-patch",
      label: "See what changed",
      wired: true,
      // The EffectBeat component owns the diff fetch (it renders the result);
      // the verb toggles it open — the fetch is a real /api/git/diff-patch read.
      // When the beat's own diff read measured the project as having NO
      // repository, there is nothing an expansion can ever reveal: folding
      // the card would change nothing on screen (the silent dead verb). The
      // press instead states the wire's own sentence for that measured fact —
      // the same inline answer face the two-press undo confirm uses — so the
      // question the verb names gets an honest answer in words.
      run: () => {
        const live = beatById(beat.id) ?? beat;
        const noRepository = live.effect?.noRepositoryReason;
        if (noRepository !== undefined) {
          throw new ClientError("git_diff_no_repository", noRepository);
        }
        ctx.toggleExpand(beat.id);
      },
    },
  ];
  if (ctx.projectId !== null && path !== undefined) {
    const projectId = ctx.projectId;
    verbs.push(
      {
        id: "custody.state/undo",
        label: "Undo this",
        wired: true,
        // Routed through `brokerAction`, so the door already refuses during a
        // past view; the flag is what lets the CONTROL say so first.
        writes: true,
        // Two-press inline confirmation, no modal (§7.2): the FIRST press
        // states the MEASURED loss (± counted from the file's real diff, on
        // the live beat) and arms; only a second press inside the window
        // performs the real restore through the custody block's verb.
        run: async () => {
          // Asserted BEFORE the two-press arming, not just before the write.
          // `brokerAction` would refuse the second press, but the FIRST press
          // happens entirely on this side of the door: during a past view it
          // armed the undo and threw the confirmation sentence — telling the
          // reader "undo discards +12 −3 in x.ts, press again to confirm"
          // about a change the view is not even claiming to show. A refusal
          // has to arrive before the threat does.
          assertLiveForWrite();
          const armedAt = armedUndos.get(beat.id);
          if (armedAt === undefined || Date.now() - armedAt > UNDO_CONFIRM_WINDOW_MS) {
            armedUndos.set(beat.id, Date.now());
            const live = beatById(beat.id) ?? beat;
            const added = live.effect?.added;
            const removed = live.effect?.removed;
            const loss =
              added !== undefined && removed !== undefined
                ? `undo discards +${added} −${removed} in ${path}`
                : `undo discards the unsaved changes in ${path} (± not counted yet)`;
            throw new ClientError(
              "custody_undo_confirm",
              `${loss} — each file returns to its last saved state; press undo again to confirm`,
            );
          }
          armedUndos.delete(beat.id);
          await brokerAction(
            "custody.state",
            "undo",
            { projectId, files: [path] },
            { invalidates: ["custody:changed"] },
          );
        },
      },
      {
        id: "custody.state/keep",
        label: "Keep this",
        wired: true,
        writes: true,
        // A real save of THIS file through the declared verb. The message is
        // the causing request's own words when the record carries them, else
        // the file's own name — recorded facts only, nothing invented.
        run: async () => {
          const prompt = ctx.userPromptBefore(beat.id);
          const firstLine = prompt?.split("\n")[0]?.trim();
          const message =
            firstLine !== undefined && firstLine.length > 0 && !firstLine.startsWith("-")
              ? firstLine.slice(0, SUGGESTION_CAP)
              : `keep ${path}`;
          await brokerAction(
            "custody.state",
            "keep",
            { projectId, files: [path], message },
            { invalidates: ["custody:changed"] },
          );
        },
      },
    );
  } else {
    const gap =
      path === undefined
        ? "the recorded change carries no file path to act on"
        : "this needs the owning project — none is selected";
    verbs.push(
      { id: "custody.state/undo", label: "Undo this", wired: false, reason: `undo restores the file's last saved state — ${gap}` },
      { id: "custody.state/keep", label: "Keep this", wired: false, reason: `keep saves the change into the project's history — ${gap}` },
    );
  }
  return verbs;
}

function checkDeltaVerbs(beat: Beat, ctx: VerbContext): readonly BeatVerb[] {
  const verbs: BeatVerb[] = [];
  if (ctx.projectId !== null && beat.checkDelta !== undefined) {
    const projectId = ctx.projectId;
    const checkName = beat.checkDelta.checkName;
    const chatId = ctx.chatId;
    verbs.push({
      id: "auto-checks.run",
      label: "Rerun",
      wired: true,
      writes: true,
      run: async () => {
        // client.ts path — the Broker's write door is not on it, so the
        // past-view refusal is asserted here (§6.2).
        assertLiveForWrite();
        await runProjectAutoCheck(projectId, {
          checkName,
          ...(chatId !== null ? { chatId } : {}),
        });
      },
    });
  } else {
    verbs.push({
      id: "auto-checks.run",
      label: "Rerun",
      wired: false,
      reason: "rerun needs the owning project — none is selected",
    });
  }
  verbs.push({
    id: "flow.expand",
    label: "Open output",
    wired: true,
    run: () => ctx.toggleExpand(beat.id),
  });
  return verbs;
}
