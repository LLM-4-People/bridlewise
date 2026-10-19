/**
 * COCKPIT FLOW — THE BEAT STATE VOCABULARY (one owner, every consumer).
 *
 * THE USER'S CORRECTION, VERBATIM: "everything else that is not a chat
 * (user/llm) is not very visible except when clicking on it. can it be a
 * chat bubble that looks different depending on warning, success, error
 * without having to click on it. we can still click to show maximum
 * details."
 *
 * So: a beat's STATE must be legible AT REST, at every fisheye level, for
 * every kind. Clicking is for DEPTH (the SCOPE sheet), never for basic
 * legibility. This module is the single place that decides what state a
 * recorded beat is in, and the single place that names it in plain words —
 * because five components each deciding "is this bad?" is five chances to
 * disagree about the same record.
 *
 * ── THE OUTCOME COLOURS: green, yellow, red ───────────────────────────────
 *
 * THE USER'S DIRECT DECISION, VERBATIM: "success green, error red, warning
 * yellow."
 *
 * This REVERSES an earlier rule of ours. We had made OK earn no hue at all —
 * quiet ink and a ✓ — reasoning from the cockpit's colour discipline (§12.2:
 * one live hue, and its rarity IS the meaning) that colouring every succeeded
 * call would drown the failures. The user has decided otherwise, and the
 * user's call wins. It is written down here, at the top of the module that
 * owns the state vocabulary, so that a future reader finds a DECISION rather
 * than what looks like drift — and so nobody "restores" the old behaviour
 * believing they are repairing a regression.
 *
 *   OK      — green  (--ok)
 *   WARN    — yellow (--warn)
 *   ALARM   — red    (--alarm)
 *   WORKING — the ONE live hue (--beam), which already means exactly "this
 *             is happening now" everywhere else in the cockpit and is
 *             therefore not an outcome colour at all.
 *
 * THE NAME IS DERIVED, NOT RESTATED. The set below is the grammar's outcome
 * axis plus `neutral` — `BeatState` is computed from
 * `response/grammar.ts`'s declaration, so the day a fifth outcome exists the
 * type, the glyph table and the words all fail to compile until they say
 * what it looks like. A hand-copied union here was how the beat's
 * `data-state` and the grammar's axis learned to disagree.
 *
 * HOW THEY STAY ONE SYSTEM instead of four coloured things. Each state wears
 * its hue on the SAME affordances, in the same weight and the same slot: the
 * beat's leading edge (tokens.css), the causal gutter glyph and the collapsed
 * status mark (Beat.svelte), and the status chip (ToolBeat.svelte). A green
 * success and a red error are the same object reporting two answers. Contrast
 * for all three is measured against every ground in both themes — see the
 * note on the state edge in tokens.css.
 *
 * HUE IS ADDITIVE, NEVER THE ONLY CARRIER. Every state keeps its GLYPH and
 * its plain WORD (below), so a colour-blind reader, a monochrome screen and a
 * reader across the room all still get the answer. That much of the old
 * discipline is not up for negotiation: colour is the third telling, not the
 * first.
 *
 * `neutral` is for beats that have no state to report (a turn, a seam, a
 * finding). It remains an ABSENCE and renders as one — never a green tick
 * asserting a success nobody measured (§1.1). "Success is green" applies to
 * MEASURED successes only.
 */

import type { Beat } from "./types.ts";
import type { OutcomeStateId } from "../response/grammar.ts";

/** A beat's state is the outcome axis plus `neutral` ("nothing measured to
 * report") — derived from the grammar's declaration, never restated. */
export type BeatState = OutcomeStateId | "neutral";

/**
 * WHOSE VOICE a beat is in.
 *
 * THE USER'S SECOND CORRECTION, VERBATIM: "also what is sent by the harness
 * (hallucination, bias, etc) should look different, so we can easily
 * differentiate what the harness sends vs everything else."
 *
 *   `conversation` — the exchange itself: your words, the model's words, and
 *                    the model's ACTIONS (tool calls, the file effects they
 *                    produce, the checks those trip). All of it is somebody
 *                    doing something in the conversation, so all of it wears
 *                    the bubble.
 *
 *   `system`       — the machinery talking ABOUT the conversation rather
 *                    than in it: the harness's own events (hallucination and
 *                    bias detection, self-healing, steering, safety
 *                    interventions) and the computer's findings and seams.
 *
 *   `operator`     — YOU, changing the machine rather than talking to it:
 *                    pinning a memory, muting a channel, moving the trim
 *                    point, flipping a breaker, arming an auto-trip, saving a
 *                    setting. "show when we steer, manipulate context, trim,
 *                    etc" — the user's own words for the gap this fills.
 *
 * WHY THIS IS A REGISTER AND NOT A FOURTH GROUND. The palette already spends
 * three grounds on depth; a fourth would push the eye past what it can sort,
 * and colour is committed to STATE (below). So the system voice is carried
 * by REGISTER instead — no fill, a leading rule, and the engraved mark —
 * which is exactly the register the computer's findings already speak in
 * (§1.3, §4). Harness events are the same species of utterance, so they join
 * that family rather than inventing one.
 *
 * THREE MARKS INSIDE THE ONE FAMILY, deliberately. A finding is `∴` — the
 * computer CONCLUDED something and carries a derivation that can be
 * examined. A harness event is `!` — the harness OBSERVED or INTERVENED, and
 * there is no derivation behind it. An operator intervention is `≡` — a hand
 * at the controls. One mark for all three would let a detection wear a
 * conclusion's authority, or let your own decision read as the harness's,
 * which is the same class of overclaim this project keeps deleting. Same
 * register (so "not somebody speaking" reads at a glance), three marks (so
 * the claim is not inflated).
 *
 * WHY THE OPERATOR SHARES THE RULE-LED REGISTER RATHER THAN EARNING A FOURTH.
 * The question the VOICE axis answers is "is this the conversation, or is it
 * about the conversation". An intervention is emphatically the second: it is
 * not addressed to the model and the model never reads it — it changes what
 * the model will be given. So it belongs to the rule-led family by meaning,
 * not merely by budget. And the budget is real too: a fourth register would
 * need either a fourth ground (the palette already spends three on depth) or
 * a hue (committed to STATE), so a genuinely new register is not available to
 * spend. The mark carries the distinction, and the beat's own first word is
 * "you", which is the least ambiguous signal of authorship there is.
 *
 * `data-voice` still publishes THREE values rather than folding `operator`
 * into `system`, because they are different answers to "who did this" and a
 * surface that later finds a register to spend must be able to tell them
 * apart without re-deriving it.
 */
export type BeatVoice = "conversation" | "system" | "operator";

/** The kinds the harness speaks in, rather than participates in. */
const SYSTEM_KINDS: ReadonlySet<string> = new Set(["event", "finding", "seam"]);

/**
 * The voice of a beat.
 *
 * The boundary sits at "who did this": a tool call and the file effect it
 * produced are the MODEL acting inside the conversation, and a check delta
 * is the measured consequence of that action — all conversation. An event or
 * a finding is the harness commenting on it — system.
 */
export function beatVoice(beat: Beat): BeatVoice {
  if (beat.kind === "act") return "operator";
  return SYSTEM_KINDS.has(beat.kind) ? "system" : "conversation";
}

/**
 * DOES THIS BEAT OCCUPY SPACE IN THE FLOW? One owner, one answer.
 *
 * THE USER'S DECISION, VERBATIM: "this can just be hidden, no need to show :
 * the model returned nothing for this turn, the model acted without
 * commenting — its tool calls are below / ↑4,180 / ↓21 tok / gemma-4-31b".
 *
 * THE HISTORY, because this is the second reversal on the same row and both
 * were reasonable at the time. An empty assistant message first rendered as
 * an EMPTY BUBBLE ("it shows as empty turn in the chat"). We replaced the
 * bubble with an explanatory line plus the measured footer, on the argument
 * that a bare gap is worse than a sentence. The user has now seen that and
 * wants neither: a turn whose only content was tool calls is ALREADY told by
 * the tool beats directly beneath it, so the sentence is a caption on a
 * picture that is right there.
 *
 * WHAT IS HIDDEN IS ONLY THE ROW. The beat stays in the log with its id and
 * its causal parentage intact — the tool beats below it still name it as
 * their cause — and every measured number it carries (tokens, first-word
 * latency, tok/s, the responding model) is still rendered in full by
 * `TurnBeat` when the beat is opened in its SCOPE, and still reachable from
 * the sweep and the lens. Nothing is dropped to fix a layout problem (§1.1);
 * it simply stops spending a row.
 *
 * A STREAMING turn is never hidden even while its text is empty — it is
 * about to have some, and a row that appeared out of nowhere mid-stream
 * would flicker.
 *
 * AN INTERRUPTED turn is never hidden either, and the exception is the
 * silent rule's own reason inverted: the hiding is honest because the turn's
 * content is told by the beats directly beneath it — and a turn whose run
 * died before any word was kept has NO beats beneath it, no answer, no
 * error row, nothing at all. Hiding it would not remove a caption from a
 * picture; it would erase the only trace the turn ever happened, which is
 * the exact hole the ending face exists to close.
 */
export function rendersInFlow(beat: Beat): boolean {
  if (beat.kind !== "turn") return true;
  const turn = beat.turn;
  if (turn === undefined) return true;
  if (turn.streaming) return true;
  if (turn.incompleteReason !== undefined) return true;
  return turn.text.length > 0 || (turn.reasoning !== undefined && turn.reasoning.length > 0);
}

/**
 * DOES THIS KIND OPEN A RIGHT-HAND SHEET? One owner, one answer, read by the
 * beat's own options row AND by the ⏎ chord — so a grip cannot exist for a
 * kind the chord refuses, or the other way round.
 *
 * ── THE USER'S RULING, SAID THREE TIMES ───────────────────────────────────
 *
 * "when clicking on a tool, it shows up on the right side on top of expanding
 * in the chat, I just want expanding in the chat." Then, after the first fix:
 * "sometimes when clicking around the tool open on the right side, I don't
 * want that." Then: "scope also opens on a right menu."
 *
 * FOR A TOOL BEAT, NOTHING OPENS A SHEET. Not the grip (it is not rendered),
 * not the chord (Flow.svelte routes ⏎ to the inline expansion for these
 * kinds), not right-click, and not a menu (deleted). The first fix removed
 * the body click only, which is why the report came back twice.
 *
 * NOTHING WAS LOST WITH IT. Everything the sheet added over the open card —
 * when the call happened, what caused it and a way to go there, every verb
 * including the refusing ones with their reasons, and the precise record —
 * renders UNDER the open card now (BeatDepth.svelte). The rule that binds
 * here is the user's own, from the `[view]` exchange: a control "should first
 * bring more details and second just be clickable". Deleting the button
 * without moving what it showed would have failed the first half.
 *
 * Every other kind keeps its sheet, and `shell/ScopeHost.svelte` plus the
 * claim/dismissal ladder are untouched.
 */
const SHEETLESS_KINDS: ReadonlySet<string> = new Set(["tool"]);

export function opensScopeSheet(kind: Beat["kind"]): boolean {
  return !SHEETLESS_KINDS.has(kind);
}

/**
 * The glyph that carries a state by FORM rather than hue. Present for every
 * state that has something to report, absent for `neutral` — an absence of
 * state renders as absence. TOTAL over the derived set: an outcome added to
 * the grammar without a glyph here is a compile error, not a silent blank.
 */
export const STATE_GLYPH = Object.freeze({
  working: "◍",
  ok: "✓",
  warn: "△",
  alarm: "✕",
  neutral: "",
} satisfies Record<BeatState, string>);

/**
 * THE state of one recorded beat, from the record's own fields.
 *
 * Nothing is inferred beyond what the beat carries: a tool with no recorded
 * status is not called a success, and a beat that declares itself abnormal
 * is never quietly reported as fine. Precedence is explicit — the beat's own
 * `abnormal` flag can only ever RAISE the state, never lower it.
 */
export function beatState(beat: Beat): BeatState {
  const own = ownState(beat);
  // A beat that declares itself abnormal is at LEAST a warning, whatever its
  // kind-specific reading said. The flag is the record's own judgement and it
  // cannot be talked down by a kind that has no opinion.
  if (beat.abnormal && (own === "ok" || own === "neutral")) return "warn";
  return own;
}

function ownState(beat: Beat): BeatState {
  switch (beat.kind) {
    case "tool": {
      const status = beat.tool?.status;
      if (status === "error") return "alarm";
      if (status === "running") return "working";
      if (status === "done") return "ok";
      return "neutral";
    }
    case "effect":
      // A recorded file change that carries its counted diff succeeded; one
      // whose diff could not be read reports that, rather than a tick.
      if (beat.effect?.diffError !== undefined) return "warn";
      return "ok";
    case "check-delta": {
      const to = beat.checkDelta?.to;
      if (to === "failed") return "alarm";
      if (to === "passed") return "ok";
      return "neutral";
    }
    case "event":
      // Errors are alarm, always (§12.3 — "error" is not a category hue).
      return beat.event?.eventKind === "client-error" || beat.event?.eventKind === "error"
        ? "alarm"
        : "neutral";
    case "act": {
      // An intervention that did not go through changed NOTHING, and that is
      // an alarm: the reader must not carry on believing the run's behaviour
      // moved. One that settled is an ordinary success and reads as one.
      const state = beat.act?.state;
      if (state === "failed") return "alarm";
      if (state === "done") return "ok";
      return "neutral";
    }
    case "turn": {
      // A turn whose run ended before any word was kept is a failure of the
      // turn — the answer never came and never will. The tool card's
      // stranded-call settle reads the same way (status "error"), because
      // these are the same fact at two altitudes: something was asked for
      // and nothing arrived.
      return beat.turn?.incompleteReason !== undefined ? "alarm" : "neutral";
    }
    default:
      return "neutral";
  }
}

/**
 * The state in plain words, or null when there is nothing to say.
 *
 * Zero-knowledge language (§1.1): "failed", not "ERR"; "working", not a
 * spinner nobody can name. Used by the collapsed rows, where the word IS the
 * legibility — a ghost that shows only a glyph asks the reader to have
 * learned a symbol.
 */
export function stateWord(state: BeatState): string | null {
  switch (state) {
    case "alarm":
      return "failed";
    case "warn":
      return "check this";
    case "working":
      return "working";
    case "ok":
      return "done";
    case "neutral":
      return null;
  }
}
