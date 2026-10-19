<script lang="ts">
  /**
   * A turn beat (spec §3.2): your words or the model's, rendered as a CHAT
   * BUBBLE — the web-native shape for a message. The terminal vibe is kept:
   * soft-but-modern corners, hairline bezel, mono metadata, the
   * electron-beam caret while streaming, the causal gutter glyph outside
   * the bubble. Bubbles do NOT compress (Beat.svelte forces `level: full`
   * for turns) — no click-to-unwrap.
   *
   * The bubble holds ONLY the message content (prose, reasoning fold,
   * measured footer). It renders NO options of its own: a turn's verbs go
   * in the beat's ONE options row (Beat.svelte `.options`), which is the
   * same row, in the same form, under every kind. A turn-shaped verb footer
   * living here was one of the three different placements the user was
   * looking at when they said the options "should be similar".
   *
   * A SILENT MODEL TURN IS NOW A SCOPE-ONLY BEAT.
   *
   * Three passes on one row, and the last one is the user's. An empty
   * assistant message first rendered as an EMPTY BUBBLE ("it shows as empty
   * turn in the chat"). We replaced the bubble with the quiet line below plus
   * the measured footer, arguing that a bare gap is worse than a sentence.
   * The user has now seen that and wants neither, verbatim: "this can just be
   * hidden, no need to show : the model returned nothing for this turn, the
   * model acted without commenting — its tool calls are below / ↑4,180 / ↓21
   * tok / gemma-4-31b". They are right that the sentence is a caption on a
   * picture that is already there — the tool beats directly below it ARE the
   * turn's content.
   *
   * SO THE FLOW NO LONGER DRAWS THE ROW AT ALL (`rendersInFlow` in
   * beat-state.ts, applied by Beat.svelte), and the branch below is what the
   * beat's SCOPE shows when someone opens it. That is where the MEASUREMENT
   * went: tokens, first-word latency, tok/s and the responding model are real
   * measurements of a real turn, so they stay in the record and stay
   * reachable — one level deep instead of on the surface. Nothing was dropped
   * to fix a layout problem (§1.1).
   *
   * The model turn carries its THINKING BLOCK (ThinkingFold.svelte — open
   * while the model is thinking, folded the instant the answer begins) and the
   * measured footer — every number from the envelope, absent numbers absent.
   * The in-flight text streams from the streamingTail atom (O(1) per token —
   * the log array is never rewritten per token).
   */
  import { streamingTail } from "../../state/chat-messages.ts";
  import Prose from "../render/Prose.svelte";
  import StreamPulse from "./StreamPulse.svelte";
  import ThinkingFold from "./ThinkingFold.svelte";
  import { waitStage, waitStartedAt } from "./wait-stage.ts";
  import { MS_PER_SECOND } from "../../../shared/constants.ts";
  import {
    STREAM_RATE_MIN_SAMPLES,
    STREAM_RATE_WINDOW_MS,
    TURN_CODE_FOLD_LINES,
  } from "../render/render-config.ts";
  import {
    setThinkingFold,
    thinkingFoldVersion,
    thinkingOpen,
    thinkingState,
    thinkingTextOf,
  } from "./thinking-fold.ts";
  import { arrivalVersion, observedFor, turnLatency } from "./turn-timing.ts";
  import type { Beat } from "./types.ts";
  import Answer from "../response/Answer.svelte";
  import { absent } from "../response/grammar.ts";

  let { beat }: { beat: Beat } = $props();

  const turn = $derived(beat.turn!);

  /** A turn with no prose and no reasoning: it acted instead of speaking. */
  const isSilent = $derived(
    turn.text.length === 0 &&
    !turn.streaming &&
    (turn.reasoning === undefined || turn.reasoning.length === 0),
  );

  /**
   * The prose renderer is only mounted when there ARE words. A streaming turn
   * that has produced thinking and no answer yet would otherwise draw an empty
   * paragraph box above its thinking block — a gap with nothing in it, which
   * is the same "empty turn in the chat" the silent-turn branch above exists
   * to avoid, arriving from the other direction.
   */
  const hasBody = $derived(turn.text.length > 0 || (turn.streaming && $streamingTail.length > 0));

  /**
   * THE TWO LATENCIES, DEDUPED AT THEIR ONE OWNER.
   *
   * A DESIGN DECISION — not a user correction. An earlier version of this
   * comment quoted the user as saying "'first word' was already showing, so
   * make sure you dedup". The user never said it. The dedup is right on its own
   * merits and is kept; only the false attribution was removed.
   *
   * `turnLatency` (turn-timing.ts) is that dedup and it
   * is the ONLY place the decision is made: a turn with no thinking reports
   * ONE number, named `ttft`, because its first answer word IS its first token
   * of any kind — the same measurement never appears twice under two names. A
   * thinking turn reports the answer-word latency as a SECOND, differently
   * named number only because it is a genuinely different quantity, and only
   * when the record actually carries both.
   */
  const latency = $derived(turnLatency(turn));

  // ── The thinking block (§ thinking-fold.ts owns the rule) ────────────────

  /** Reading the version atom is what makes an explicit toggle re-derive; the
   *  automatic transitions arrive as a new `beat` object. */
  const think = $derived.by(() => {
    void $thinkingFoldVersion;
    return { state: thinkingState(beat), open: thinkingOpen(beat) };
  });
  // The rule lives in thinking-fold.ts — this file had a second private copy
  // of its body, which is how the owner and its duplicate drift apart.
  const thinkingText = $derived(thinkingTextOf(beat));


  /**
   * ── AND THE THIRD CHANNEL, WHICH REACHES NO STORE AT ALL ────────────────
   *
   * THE USER'S REPORT, VERBATIM: "i noticed that the animation for the artifact
   * tool, when its running does not work, it does work for llm. basically the
   * animation shows up, but always stop moving and counting between 400-600
   * tokens, until it fully finishes."
   *
   * The 400–600 is the length of the model's PROSE PREAMBLE before it starts
   * emitting the `create_artifact` call; everything after it is tool-call
   * ARGUMENTS — an entire HTML document — and `src/client.ts` discards every
   * one of those frames ("Partial arguments are not accumulated"). So they
   * never reach `streamingTail`, so no store-derived count can see them, and the rail
   * sat dead for the whole artifact while the model worked flat out. Pre-
   * existing, and not artifact-specific: ANY tool call with sizeable arguments
   * froze it, artifacts merely turned a blink into a stall.
   *
   * `flow/run-stream.ts` now counts those frames and `observedFor` reports the
   * total. Read through `arrivalVersion` — a signal ONLY this component
   * subscribes to — because it fires per received frame, and anything
   * structural listening to it would rebuild a beat per token.
   *
   * A turn re-read from the database has NO arrival record — frames are not
   * persisted — so it reports zero here and draws no rail. That absence is the
   * honest answer and is asserted; see `showRail`.
   */
  const observed = $derived.by(() => {
    void $arrivalVersion;
    const id = turn.sourceId;
    // ONLY WHAT WAS ACTUALLY OBSERVED ARRIVING. Nothing is substituted here.
    //
    // This line previously read `Math.max(seen.chars, railTail.length)`, to
    // keep the number from dropping when a turn is re-read. That was
    // FABRICATED DATA and it is the exact thing this codebase exists to
    // refuse. The rail is an arrival instrument: its cells advance once per
    // received frame and its count is characters OBSERVED ARRIVING. A turn
    // re-read from the database had no arrivals in this session — its words
    // came back in one HTTP response — so substituting the committed text's
    // length made the rail light up and print a figure for a stream that
    // never happened. Monotonicity is not a reason to state something
    // untrue; the honest answer to "no arrivals were observed" is to draw no
    // instrument at all (§1.1, and StreamPulse's own motion law).
    return id !== undefined ? observedFor(id) : { chars: 0, channel: null };
  });

  /**
   * THE RAIL IS THE LIVE WAIT. It fills the pre-first-character window so a
   * streaming turn is never an empty bubble ("now it shows a empty chat before
   * the animation"), and it walks while characters arrive. The moment the turn
   * completes it leaves: the measured rate stays in the footer as `tok/s`, and
   * an arrival instrument on a finished turn would claim a stream that is over.
   *
   * The STAGE is passed only while this turn is the one streaming. The wait
   * milestones belong to the run in flight, and handing them to a finished
   * turn would let its head creep forward as some LATER run progressed —
   * motion with no event of its own behind it.
   */
  const showRail = $derived(turn.who === "model" && turn.streaming);

  /**
   * Characters per second over the recent window, from the arrivals' OWN
   * timestamps. Null until two arrivals give it a span to divide by —
   * inventing one from a single arrival is fabrication.
   */
  let liveRate = $state<number | null>(null);
  let rateLastLen = 0;
  const rateArrivals: { at: number; chars: number }[] = [];
  $effect(() => {
    const len = observed.chars;
    if (len < rateLastLen) {
      rateLastLen = 0;
      rateArrivals.length = 0;
      liveRate = null;
    }
    if (len === rateLastLen) return;
    const now = performance.now();
    const arrived = len - rateLastLen;
    rateLastLen = len;
    rateArrivals.push({ at: now, chars: arrived });
    while (rateArrivals.length > 0 && now - rateArrivals[0]!.at > STREAM_RATE_WINDOW_MS) {
      rateArrivals.shift();
    }
    if (rateArrivals.length < STREAM_RATE_MIN_SAMPLES) return;
    const spanMs = now - rateArrivals[0]!.at;
    if (spanMs <= 0) return;
    // The first sample marks the window's start instant, so its own characters
    // landed BEFORE the span — counting them would inflate the rate.
    let sum = 0;
    for (let i = 1; i < rateArrivals.length; i += 1) sum += rateArrivals[i]!.chars;
    liveRate = (sum / spanMs) * 1000;
  });

  /**
   * ── THE ONE RATE, IN THE UNIT THAT IS ACTUALLY MEASURED RIGHT NOW ───────
   *
   * A DESIGN DECISION (provenance corrected — not a user instruction), and they only reconcile one way:
   *   [FABRICATED QUOTE REMOVED — the user never said this; the decision below stands on its own merits] · [FABRICATED QUOTE REMOVED — the user never said this; the decision below stands on its own merits] · "during generation also, not
   *   just after" · [FABRICATED QUOTE REMOVED — the user never said this; the decision below stands on its own merits] · "why can't we
   *   measure tok/s also"
   *
   * THE ANSWER TO THE LAST ONE, because it decides the whole design: we cannot
   * measure tokens per second DURING generation, because the provider does not
   * tell us how many tokens it has produced until the turn is over. Verified
   * against the provider directly rather than assumed — with
   * `stream_options: {include_usage: true}` set exactly as the harness sets it,
   * a 57-chunk response carried `usage` in ONE chunk, and that chunk was the
   * 57th. Nor can the count be recovered from the frames: the same capture had
   * 46 deltas against 157 completion tokens, so a delta is not a token.
   * WHY CHARACTERS AND NOT TOKENS, put the way the question was actually
   * asked — "if we count char during generation why cant we count token":
   * because the characters ARE the payload. Every frame carries text, so
   * counting them is reading what arrived. A TOKEN is not a unit the wire
   * carries; it is a fact about how the MODEL's tokenizer split that text, and
   * the provider states it once, at the end, in `usage`. We are not declining
   * to count something that is there — there is nothing there to count.
   *
   * We could tokenize the received text ourselves in the browser, and that
   * would be a real measurement — of OUR tokenization. It would be a different
   * number from the provider's: a different tokenizer, per model family (ten
   * are configured here across glm, qwen, kimi and gemma), and blind to what
   * `completion_tokens` includes but never sends as text. The live figure would
   * then disagree with the `↓ tok` total sitting on the same row, which is
   * worse than an honest absence. That is a trade worth offering, not one to
   * take silently.
   *
   * So the footer holds ONE rate slot and it reports the throughput that is
   * genuinely measured at that moment: characters per second while the stream
   * is running, tokens per second the instant the token count exists. Both are
   * measurements; neither is converted into the other. Deriving a live tok/s
   * from a characters-per-second figure would need a characters-per-token
   * ratio nobody has measured for the turn in flight — that is a projection,
   * and §4.2 permits one only with its derivation stated on it, never printed
   * bare as a measurement.
   */
  const rateSay = $derived(
    latency.tokPerSec !== undefined
      ? `${latency.tokPerSec} tok/s`
      : liveRate !== null
        ? `${Math.round(liveRate).toLocaleString("en-US")} c/s`
        : null,
  );

  /**
   * THE DEDUP SAVINGS FACE — the wire's own numbers for THIS call's input.
   *
   * The dedup layer folds repeated passages out of the input before the
   * request; the "dedup" frame carries the measurement (chars
   * before/after, the reduction pct, how many repeated blocks were
   * removed) and the turn's record holds it, so the footer that shows
   * ↑tok — the number the folding changed — also shows what was folded.
   * The chars are chars and are never converted to tokens: the provider's
   * token count beside them measures the whole request (system prompt +
   * history + tool schemas), a different unit and a different scope, and
   * a conversion nobody measured would be a projection wearing a
   * measurement's clothes.
   *
   * ABSENCE IS THE HONEST NOTHING. The server sends no event for a call
   * that removed nothing, so a turn without a summary renders no face —
   * never "−0%", a zero that measures nothing. An `applied: false`
   * payload (the server does not send one today; the wire's own field
   * says it may) renders no face either.
   */
  const dedupSay = $derived(
    turn.dedupSummary !== undefined && turn.dedupSummary.applied
      ? `dedup −${turn.dedupSummary.charReductionPct}% · ${fmt(turn.dedupSummary.originalChars)}→${fmt(turn.dedupSummary.dedupedChars)} chars · ${turn.dedupSummary.removedBlocks} repeated block${turn.dedupSummary.removedBlocks === 1 ? "" : "s"} folded`
      : null,
  );

  /**
   * THE MASKED-INPUT FACE — the wire's own numbers for THIS call's input.
   *
   * The redaction choke point masks sensitive values out of the system
   * prompt, the history and the prompt before the request leaves the
   * machine, and the "redaction" frame carries the fact (how many values,
   * split by how confidently each was identified) to the turn's record,
   * so the footer that shows ↑tok — the number the masking changed —
   * also shows what was hidden. The COUNT LEADS and the confidence
   * split follows, because "1 value matched a credential this server
   * holds" and "1 value looked like one after the words around it" are
   * different things to be told, and a single number would flatten a
   * guess into the authority of a proof. Zero parts never render — an
   * honest nothing, not "0 inferred".
   *
   * VALUES ALREADY HIDDEN UPSTREAM are stated as their own sentence,
   * never folded into the count: this pass cannot know why those spans
   * were masked, so it must not lend them its confidence split. An
   * upstream-only notice (this call masked nothing new) still renders —
   * the user's input was rewritten either way.
   *
   * THE MASKED VALUE ITSELF NEVER APPEARS — not here, not anywhere. The
   * payload carries counts, categories and value-free reasons only (a
   * preview of a secret is the secret), and this face reads only those
   * known fields: a corrupt blob that smuggles an extra value-shaped
   * field finds no template hole to render through. The value-free
   * reasons stay reachable on hover — the check-against-what-you-typed
   * detail, one line per masked span.
   */
  const redactionSay = $derived.by(() => {
    const notice = turn.redactionNotice;
    if (notice === undefined) return null;
    if (notice.maskedCount === 0) {
      return notice.maskedUpstream > 0
        ? `redaction ${notice.maskedUpstream} value${notice.maskedUpstream === 1 ? "" : "s"} ${notice.maskedUpstream === 1 ? "was" : "were"} already hidden upstream`
        : null;
    }
    const parts = [`${notice.maskedCount} value${notice.maskedCount === 1 ? "" : "s"} hidden`];
    if (notice.proven > 0) parts.push(`${notice.proven} proven`);
    if (notice.format > 0) parts.push(`${notice.format} format-matched`);
    if (notice.inferred > 0) parts.push(`${notice.inferred} inferred`);
    if (notice.maskedUpstream > 0) {
      parts.push(
        `${notice.maskedUpstream} more ${notice.maskedUpstream === 1 ? "was" : "were"} hidden upstream`,
      );
    }
    return `redaction ${parts.join(" · ")}`;
  });

  /** The value-free reason per masked span, one line each, on hover —
   * the detail the footer's one line cannot hold. Null when the notice
   * carries no reasons (an upstream-only notice genuinely has none). */
  const redactionWhy = $derived.by(() => {
    const notice = turn.redactionNotice;
    if (notice === undefined || notice.reasons.length === 0) return null;
    return notice.reasons
      .map((r) => `${r.confidence} ${r.category} · ${r.maskedLength} chars · ${r.explanation}`)
      .join("\n");
  });

  /**
   * True when this turn has ANY measured number to report.
   *
   * Declared AFTER `rateSay`, which it reads. It used to sit ~170 lines above
   * it, relying on `$derived` laziness to paper over a reference to a
   * block-scoped binding that did not exist yet — a temporal-dead-zone throw
   * one evaluation-order change away, and invisible to `tsc` because `tsc`
   * does not read this file.
   */
  const hasFooter = $derived(
    turn.inputTokens !== undefined ||
    turn.outputTokens !== undefined ||
    latency.ttftMs !== undefined ||
    rateSay !== null ||
    dedupSay !== null ||
    redactionSay !== null ||
    turn.responseModel !== undefined,
  );


  /**
   * What a silent turn says. `actedInstead` is the ordinary case (the model
   * called tools); the other sentence is for a turn that produced literally
   * nothing, which is worth saying out loud rather than drawing as a gap.
   *
   * Which one applies is read from the RECORD — a turn that reported token
   * usage did run — never guessed. Nothing here invents content.
   *
   * AN INTERRUPTED turn speaks its own ending first: the reconcile's
   * verdict (a client observation, never the model's words) is the one
   * sentence the row exists to carry — a turn whose run died before any
   * word was kept has no footer to explain it and no beats beneath it.
   */
  const silentLine = $derived(
    turn.incompleteReason !== undefined
      ? turn.incompleteReason
      : hasFooter
        ? "the model acted without commenting — its tool calls are below"
        : "the model returned nothing for this turn"
  );

  /**
   * The text the prose renderer sees: committed text plus, while this turn
   * is the one streaming, the in-flight tail. Concatenated at RENDER time —
   * the log array is still never rewritten per token (§3.8), so the O(1)
   * streaming property is unchanged.
   */
  const bodyText = $derived(turn.streaming ? turn.text + $streamingTail : turn.text);

  function fmt(n: number): string {
    return n.toLocaleString("en-US");
  }

  /**
   * A latency in the unit a person reads it in. A thinking model's ttft is
   * routinely seconds and occasionally minutes (26s and 136s were measured in
   * this session), and "136,412ms" is a number the eye has to parse before it
   * means anything. Nothing is rounded away that changes the reading: below a
   * second the millisecond is the story, above it the tenth of a second is.
   */
  function ms(value: number): string {
    if (value < MS_PER_SECOND) return `${fmt(Math.round(value))}ms`;
    return `${(value / MS_PER_SECOND).toFixed(1)}s`;
  }
</script>

<!-- THE ONE FOOTER, rendered by both registers (a4-design M4: two copies
     had drifted — the absence line lived in the bubble's only, so a settled
     tool-only turn with a ttft and no usage said nothing about its tokens). -->
{#snippet footer()}
  <div class="footer">
    <!-- THE TWO MEASURED RATES LEAD THE ROW, and they are the only chromatic
         pixels in it. Ordering and hue are a design decision (see the .beam
         rule below), not a user instruction. -->
    {#if latency.ttftMs !== undefined}<span class="beam" data-field="ttft">ttft {ms(latency.ttftMs)}</span>{/if}
    {#if rateSay !== null}<span class="beam" data-field="tps">{rateSay}</span>{/if}
    {#if dedupSay !== null}<span data-field="dedup">{dedupSay}</span>{/if}
    {#if redactionSay !== null}<span data-field="redaction" title={redactionWhy ?? undefined}>{redactionSay}</span>{/if}
    {#if turn.inputTokens !== undefined}<span>↑{fmt(turn.inputTokens)}</span>{/if}
    {#if turn.outputTokens !== undefined}<span>↓{fmt(turn.outputTokens)} tok</span>{/if}
    {#if turn.responseModel !== undefined}<span>{turn.responseModel}</span>{/if}
    <!-- THE RAIL, ONLY WHILE THIS TURN IS STREAMING. The same instrument the
         flow's tail was showing while this turn had no row yet. When the turn
         completes it unmounts; tok/s in this footer is the measurement that
         stays. -->
    {#if showRail}
      <StreamPulse
        chars={observed.chars}
        channel={observed.channel}
        stage={turn.streaming ? $waitStage : "idle"}
        startedAt={turn.streaming ? $waitStartedAt : null}
      />
    {/if}
    {#if !turn.streaming && turn.inputTokens === undefined && turn.outputTokens === undefined}
      <Answer as="inline" answer={absent("tokens not measured for this turn")} />
    {/if}
  </div>
{/snippet}

{#if isSilent}
  <!-- NOT a bubble: the quiet register, so a turn that said nothing cannot
       look like a turn that said something. -->
  <div class="turn silent">
    <span class="silent-line">{silentLine}</span>
    {#if hasFooter}{@render footer()}{/if}
  </div>
{:else}
  <div class="turn" class:you={turn.who === "you"}>
    <div class="bubble">
      <!-- THE THINKING COMES FIRST, because that is the order it happened in
           and the order it is read in: the model thinks, then it answers.
           It used to sit UNDER the answer, which was harmless while it was
           always folded and wrong the moment it is the only thing on screen.
           A block that must be watched while it streams cannot live below a
           box that is about to fill with the answer. -->
      {#if think.state !== "absent"}
        <ThinkingFold
          text={thinkingText}
          open={think.open}
          live={think.state === "live"}
          onToggle={() => setThinkingFold(beat.id, !think.open)}
        />
      {/if}

      {#if hasBody}
        <div class="body" class:streaming={turn.streaming}>
          <Prose text={bodyText} codeMaxLines={TURN_CODE_FOLD_LINES} />
        </div>
      {/if}

      {#if turn.who === "you" && turn.steered === true}
        <!-- THE STEERED STATE (the steer routing): this message did not start
             a run of its own — it queued for the live run's next turn. The
             reader must not mistake the next model turn for a reply to a new
             run: this line says what their words are doing while the current
             turn finishes. Quiet mono, the bubble's own metadata register. -->
        <p class="steered-note" data-field="steered-note">
          steered the live run — the model receives this after the current turn
        </p>
      {/if}

      {#if turn.who === "model"}
        <!-- Never empty: streaming shows the rail, a settled turn with usage
             shows the numbers, and one without says so through the grammar. -->
        {@render footer()}
      {/if}
    </div>
  </div>
{/if}

<style>
  .turn {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    padding: var(--sp-1) 0;
    min-width: 0;
  }
  .turn.you {
    align-items: flex-end;
  }
  /* THE BUBBLE MUST NEVER BE NARROWER THAN THE MEASURE.
   *
   * It used to carry `max-width: var(--measure)`. That looks right and is
   * wrong: `ch` is FONT-RELATIVE, and the bubble's own font is the 13.5px
   * sans UI face while the prose inside it is the 15.5px reading face. The
   * same 76ch token therefore resolved to ~553px on the bubble and ~635px
   * on the prose — so the bubble won, and prose never actually got its
   * measure (at 1536px the column read at ~36% of the viewport with the
   * middle of the screen empty).
   *
   * The measure has ONE owner now: the prose blocks themselves, sized in
   * the font they are read in (MdBlocks). The bubble hugs whatever its
   * widest child asks for — 76ch of prose, or a code block / table / diff
   * that legitimately bleeds wider (§2.1). */
  .bubble {
    width: fit-content;
    max-width: 100%;
    min-width: 0;
    background: var(--ground-2);
    border: var(--hairline-w) solid var(--line-1);
    border-radius: var(--radius-bubble);
    padding: var(--bubble-pad-y) var(--bubble-pad-x);
    display: flex;
    flex-direction: column;
    gap: var(--bubble-gap);
  }
  /* You vs model: you is raised + lighter border; model is grounded + hairline. */
  .you .bubble {
    background: var(--ground-3);
    border-color: var(--line-2);
    box-shadow: var(--shadow-sheet);
  }
  .body {
    min-width: 0;
  }
  /* The steered message's own state line — the bubble's metadata register
   * (mono, quiet ink), a fact about the message rather than content. */
  .steered-note {
    margin: var(--sp-1) 0 0;
    font-family: var(--face-mono);
    font-size: var(--f-micro-size);
    color: var(--ink-3);
  }
  /* The electron-beam caret rides the END of the last rendered block, so it
   * sits at the tip of the streaming sentence exactly like a terminal caret
   * — instead of dropping to a line of its own below the prose. It is a
   * pseudo-element (no extra DOM per token) reaching into the Prose
   * component's last child; that is the one :global() this file needs, and
   * it exists because the caret belongs to the TURN, not to the shared
   * prose renderer (which has no notion of streaming). */
  .streaming :global(.prose > :last-child)::after {
    content: "";
    display: inline-block;
    width: var(--caret-w);
    height: 1lh;
    margin-left: var(--sp-0);
    vertical-align: text-bottom;
    background: var(--beam);
  }
  /* The thinking block's own grip and body live in ThinkingFold.svelte — one
   * owner for the section, so the fold rule and its pixels cannot drift. */
  .footer {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-3);
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    font-variant-numeric: tabular-nums;
    color: var(--ink-3);
  }
  /* ── THE MEASURED RATES WEAR THE LIVE HUE ─────────────────────────────
   *
   * A DESIGN DECISION, ratified in review — NOT a user instruction. An earlier
   * version of this comment attributed it to the user as a verbatim quote; the
   * user never said it, and the quote was removed. Provenance of a decision is
   * a fact like any other here: inventing one is the same defect as inventing a
   * measurement, and it is worse for surviving in the source where the next
   * reader treats it as settled.
   *
   * Written down as a decision rather than left to look like drift, because it
   * spends `--beam` outside the list §12.2 reserves it for
   * (the streaming caret, the bead, the sweep head, causal ribbons, live
   * chips) and a later reader would otherwise "restore" the rule believing
   * they were repairing a regression.
   *
   * It is also defensible on the spec's own terms: these two are the only
   * numbers in the row that are RATES OF A LIVE THING — how fast the answer
   * started and how fast it is arriving — and the rate slot literally carries
   * the live figure while the stream runs. The token totals and the model name
   * beside them are settled facts and stay ink. */
  .beam { color: var(--beam); font-variant-numeric: tabular-nums; }
  /* The quiet register for a silent turn — a line, never a bubble. */
  .silent {
    flex-direction: row;
    align-items: baseline;
    gap: var(--sp-3);
    flex-wrap: wrap;
  }
  .silent-line {
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--ink-3);
    font-style: italic;
  }
</style>
