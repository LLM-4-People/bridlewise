/**
 * COCKPIT FLOW — composer submission routing (spec §5.3, the one input).
 *
 * Three grammars, routed at submit:
 *   (plain) — a message to the model. TWO arms, decided by the open chat's
 *             own run state:
 *               · a LIVE run → steerCurrentRun — the message queues for the
 *                 run's next turn (the run does not restart; a second
 *                 concurrent run in one conversation is unreachable by
 *                 construction). The sent message renders as a STEERED beat
 *                 (turn.steered) and the outcome states the queue;
 *               · no live run → beginCockpitRun (the real run path,
 *                 run-stream.ts — the one stream that also feeds the sweep).
 *                 With a project open but NO conversation, the send creates
 *                 one first (client.ts createChat selects it, so the HORIZON
 *                 place updates the moment it exists);
 *   `?`     — ask the computer (ask.ts) → the answer docks in the flow as a
 *             finding beat (zero model tokens);
 *   `/`     — a registered block action (commands.ts) → broker.action.
 *
 * Pure routing logic, Node-testable: every outcome is a typed value with a
 * plain sentence; refusals state exactly what is missing. The caller (the
 * Flow outlet, via ShellApi.onComposerSubmit) renders outcomes through the
 * shell's hint line and the flow itself.
 */

import { createChat, steerCurrentRun } from "../../client.ts";
import { refusalReason } from "../../data/absence.ts";
import { assertLiveForWrite } from "../../data/asof.ts";
import { isRunActive } from "../../state/run-state.ts";
import { chordLabel } from "../shell/chords.ts";
import { beginCockpitRun } from "./run-stream.ts";
import { consumeArmedEdit } from "./rewind.ts";
import { ASKABLE, parseAsk, runAsk } from "../computer/ask.ts";
import { matchCommands, parseCommand, runCommand } from "../computer/commands.ts";
import { asFinding } from "../computer/findings.ts";
import { dockAskFinding } from "./dock.ts";

export type ComposerRouteContext = Readonly<{
  projectId: string | null;
  chatId: string | null;
  projectPath: string | null;
  /**
   * THE WORDS ARE IN THE TRANSCRIPT — fired the instant that is true, which is
   * BEFORE the server has accepted the run.
   *
   * THE DEFECT THIS CLOSES, reported as: the message "stays a long time in the
   * message box" while the reply area reads "your message is in" for five to
   * ten seconds. Both halves are one cause. `beginCockpitRun` writes the user
   * turn SYNCHRONOUSLY (`sendUserMessage`) and only then awaits `startRun`,
   * which is the server accepting the run and can take seconds. The composer
   * was cleared on the RESOLVED promise, so for that whole window the reader
   * saw their sentence twice: once as a beat in the flow, and once still
   * sitting in the box they thought they had emptied.
   *
   * Clearing on this callback instead ties the box to the fact that actually
   * decides it — the words are recorded — rather than to a slow round trip
   * that has nothing to do with whether the composer should still hold them.
   * It also meets the action-acknowledgement budget (§1.5 F2: < 100ms), which
   * a wait on `startRun` cannot.
   *
   * IT FIRES ONLY AFTER THE WRITE. Every refusal that happens BEFORE the
   * transcript is touched — nothing typed, no project open, a planted head —
   * returns without calling this, so those keep the user's words for
   * correction exactly as before.
   */
  onCommitted?: () => void;
}>;

/** How many near-miss commands the refusal hint previews. */
const COMMAND_PREVIEW_COUNT = 3;

/** Platform-true Switch chord for refusal hints (the one spelling owner). */
const SWITCH_CHORD = chordLabel({ key: "j", primary: true });

/** Auto-created conversation titles are the user's own first words. */
const CHAT_TITLE_MAX_CHARS = 48;

function chatTitleFrom(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  return oneLine.length > CHAT_TITLE_MAX_CHARS
    ? `${oneLine.slice(0, CHAT_TITLE_MAX_CHARS).trimEnd()}…`
    : oneLine;
}

export type RouteOutcome = Readonly<{
  kind: "sent" | "steered" | "finding" | "command" | "refused" | "failed";
  /** Plain sentence for the hint line ("" for a plain send — the flow shows it). */
  message: string;
}>;

export type GrammarMenuItem = Readonly<{
  head: string;
  detail: string;
}>;

/**
 * THE EMPTY-COMPOSER REFUSAL, owned here because this module owns what a
 * submission is refused for — every surface that needs to say why a send
 * cannot fire with nothing typed (the shell's no-flow hint, the disabled
 * send button's title) reads this one sentence instead of restating it. A
 * second spelling would drift the day one of them is reworded.
 */
export const COMPOSER_EMPTY_REASON = "nothing typed yet";

/**
 * The LIVE grammar menu for a composer value, per keystroke (§5.3): `/`
 * lists matching registered block actions (labels/consequences VERBATIM
 * from the declarations — never invented here); `?` lists the askable
 * questions. Plain text returns [] — no menu over ordinary words.
 */
export function grammarMenuFor(value: string): readonly GrammarMenuItem[] {
  if (value.startsWith("/")) {
    return matchCommands(value.slice(1).trim()).map((m) => ({
      head: `/${m.entry.id}`,
      detail:
        m.entry.blockedReason === null
          ? m.entry.consequence
          : `not runnable here — ${m.entry.blockedReason}`,
    }));
  }
  if (value.startsWith("?")) {
    const parsed = parseAsk(value);
    return ASKABLE.map((q) => ({
      head: q.usage,
      detail:
        parsed.ok && parsed.parsed.question.id === q.id
          ? `→ ${q.blockId}`
          : q.description,
    }));
  }
  return [];
}

export async function routeComposerSubmission(
  raw: string,
  ctx: ComposerRouteContext,
): Promise<RouteOutcome> {
  const text = raw.trim();
  if (text.length === 0) {
    return { kind: "refused", message: COMPOSER_EMPTY_REASON };
  }

  if (text.startsWith("?")) {
    if (ctx.projectPath === null) {
      return {
        kind: "refused",
        message: `? asks the computer about a project — none is open (${SWITCH_CHORD} to switch)`,
      };
    }
    const parsed = parseAsk(text);
    if (!parsed.ok) return { kind: "refused", message: parsed.hint };
    try {
      const computed = await runAsk(parsed.parsed, ctx.projectPath);
      dockAskFinding(asFinding(computed, "ask-answer"));
      return { kind: "finding", message: "answered — docked in the flow" };
    } catch (err) {
      return {
        kind: "failed",
        message: `the computer could not answer: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (text.startsWith("/")) {
    const parsed = parseCommand(text);
    if (!parsed.ok) {
      const preview = parsed.matches
        .slice(0, COMMAND_PREVIEW_COUNT)
        .map((m) => `/${m.entry.id}`)
        .join(" · ");
      return {
        kind: "refused",
        message: preview.length > 0 ? `${parsed.hint} — ${preview}` : parsed.hint,
      };
    }
    try {
      const result = await runCommand(parsed.entry);
      return { kind: result.ok ? "command" : "refused", message: result.message };
    } catch (err) {
      return {
        kind: "failed",
        message: `${parsed.entry.label} failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (ctx.projectId === null) {
    return {
      kind: "refused",
      message: `no project is open to send to — ${SWITCH_CHORD} to switch`,
    };
  }
  try {
    // Creating a conversation is a WRITE, and `createChat` is a client.ts
    // call with no Broker door on it — so a send typed while the head is
    // planted would have created a real chat against the live project
    // before `beginCockpitRun` ever got to refuse. Asserted before either.
    assertLiveForWrite();
    let chatId = ctx.chatId;
    if (chatId === null) {
      // No conversation open: the send CREATES one — the run records into
      // a real chat, and client.ts createChat also SELECTS it, so the
      // HORIZON place updates the moment the conversation exists. The
      // title is the user's own words (trimmed), never an invented label.
      chatId = (await createChat(ctx.projectId, { title: chatTitleFrom(text) })).id;
    }
    // ── EDIT & RESEND, second half (src/cockpit/flow/rewind.ts) ───────────
    // `edit & resend` armed a message id when it filled this composer. The
    // send REPLACES that message rather than following it: the rewind is
    // recorded and the corrected history reloaded BEFORE the run starts, so
    // the request the provider receives carries the edited words and not the
    // original ones. Without this, the correction the user just made was
    // invisible to the model — and they edited it *because* the original was
    // wrong. A send with nothing armed is untouched (this returns null).
    // ORDER MATTERS: this runs BEFORE the live-run arm below, and a rewind
    // under a live run is refused by rewind.ts itself — withdrawing turns a
    // streaming run is still reading would corrupt its context, so the
    // refusal (the verb's own honest sentence) is the answer, never a steer.
    await consumeArmedEdit(chatId);
    // ── THE LIVE-RUN ROUTING (the steer door) ─────────────────────────────
    // A plain send while the OPEN chat's run is live STEERS it: the words
    // queue for the run's next turn instead of starting a second concurrent
    // run in the same conversation — the defect this closes (two executors
    // racing one transcript). `isRunActive` reads the client's own run
    // state, which is the open chat's by construction (cleared on every
    // chat switch); after the run settles, this arm is simply unreachable
    // and a plain send begins a new run again. `steerCurrentRun` re-checks
    // liveness at its own door — a run that retires between the two checks
    // answers false and the send falls through to the new-run path.
    if (isRunActive.get()) {
      const steered = await steerCurrentRun(text, {
        ...(ctx.onCommitted !== undefined ? { onCommitted: ctx.onCommitted } : {}),
      });
      if (steered) {
        return {
          kind: "steered",
          message: "steered the live run — the instruction reaches the model after this turn",
        };
      }
    }
    // beginCockpitRun appends the user turn optimistically (the beat
    // appears instantly via the store → ingest path) and opens the ONE SSE
    // stream with the SWEEP feed attached (run-stream.ts — one source, two
    // consumers).
    await beginCockpitRun(ctx.projectId, text, {
      chatId,
      // The composer empties HERE — the moment the words are in the transcript
      // — not when the server finishes accepting the run seconds later.
      ...(ctx.onCommitted !== undefined ? { onCommitted: ctx.onCommitted } : {}),
    });
    return { kind: "sent", message: "" };
  } catch (err) {
    // The failure surfaces here as a sentence on the hint line; the composer
    // keeps the user's words for correction (run-stream.ts performs no store
    // writes — the sole-writer law). A PRINCIPLED refusal (the server
    // declined on purpose, with its own sentence — 428's guided family, a
    // typed 503) speaks as REFUSED, quoting the server; only a broken
    // attempt speaks as FAILED. The wait instrument was already ended by
    // `beginCockpitRun`'s own catch — this is the hint's half of the same
    // outcome, not a second owner of it. The same mapping covers the steer
    // arm's one race: a run that ended between the liveness check and the
    // POST is refused by the steer route itself ("already completed"), and
    // its sentence surfaces here — the honest answer, not a silent retry.
    const refusal = refusalReason(err);
    if (refusal !== null) return { kind: "refused", message: refusal };
    return {
      kind: "failed",
      message: `send failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
