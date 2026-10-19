<script lang="ts">
  /**
   * A tool beat (spec §3.2): the actual input → output transformation. While
   * running, args render as they arrive (the store already applies streamed
   * updates). Output is untrusted — rendered escaped, never {@html}.
   *
   * ── SYMMETRIC DETAIL ─────────────────────────────────────────────────────
   *
   * THE USER'S REQUIREMENT, VERBATIM: "success and error tool call should
   * carry the same amount of details when collapsed and also when expanded".
   *
   * This beat used to close to one line on success and STAY OPEN on failure.
   * That asymmetry was earned when status was invisible until you clicked —
   * the failure had to shout to be noticed at all. It no longer has to: the
   * bubble system (beat-state.ts + the `.beat-card` leading edge in
   * tokens.css) makes every outcome legible AT REST, at every fisheye level.
   * So the auto-expansion bought nothing and cost two real things:
   *
   *   - you could not COMPARE two calls, because a success and a failure were
   *     structurally different objects on the screen;
   *   - you learned DIFFERENT FACTS depending on an outcome you could already
   *     see — a failure told you its whole transformation, a success told you
   *     a hint of it.
   *
   * THE RULE NOW: outcome changes the CONTENT of a cell, never the SHAPE of
   * the beat. The anatomy below is rendered identically for `done` and
   * `error` — same fields, same order, same treatment. Only two things move:
   * the status affordance (glyph + word + the leading edge's hue), and what
   * the OUTPUT cell holds (the result, or the server's real error text, or an
   * honest statement that the record carries neither).
   *
   * `running` shares that one anatomy too, with the output cell honestly
   * pending. It is the ONE status still allowed to influence `open`, and for
   * a reason that is not about outcome: while a call is in flight the
   * transformation is arriving, and watching it arrive is the only thing to
   * do. The moment it settles it closes — the same way, whichever way it
   * went.
   *
   * WHY THIS DOES NOT CONTRADICT "abnormality resists compression"
   * (fisheye.ts). That rule chooses which LEVEL a beat is held at; this rule
   * chooses what a level SHOWS. A failure may still be held at `full` where a
   * success would have ghosted — prominence is allowed to differ. What may
   * never differ is the anatomy of whatever level it lands on.
   *
   * CLARITY (user direction v2.2): args render as readable `key: value`
   * pairs (not a raw JSON dump) so a tool call reads like a terminal
   * invocation, not a debug log. The collapsed one-liner leads with the tool
   * name + its primary arg + a result hint, not raw JSON. Terminal vibe kept:
   * mono, hairlines, the electron-beam caret while streaming.
   *
   * RICH CELLS (v2.1 web-rendering pass): the two cells no longer dump
   * `JSON.stringify` into a <pre>. Input goes to ToolInput (readable rows,
   * collapsible nested values, code blocks for multi-line arguments, a real
   * diff for an argument that genuinely parses as one); output goes to
   * ToolOutput, which renders the shape the RECORDED value actually has —
   * file content highlighted with a number rail, command output with its
   * exit code, search results as a list, structured data as a tree. Both
   * fold long content with the remainder NAMED, never silently cut. The
   * shape decision is data-driven (render/shapes.ts), so a failed call that
   * returned an error object is never dressed up as file content.
   */
  import ArtifactFrame from "../render/ArtifactFrame.svelte";
  import PathChip from "./PathChip.svelte";
  import StreamPulse from "./StreamPulse.svelte";
  import ToolInput from "../render/ToolInput.svelte";
  import ToolOutput from "../render/ToolOutput.svelte";
  import { ONE_LINE_HINT_CHARS, TOOL_CELL_FOLD_LINES } from "../render/render-config.ts";
  import { fmtDurationMs, oneLineSummary } from "../render/shapes.ts";
  import { artifactSummary, artifactViewOf, isArtifactBeat } from "../render/artifact.ts";
  import { beatState, rendersInFlow, stateWord, STATE_GLYPH } from "./beat-state.ts";
  import { startElapsedTick } from "./elapsed-clock.ts";
  import { beatById, logVersion } from "./log.ts";
  import { becauseChanged, moves, type MovesParam } from "../motion/motion.ts";
  import { arrivalVersion, observedFor } from "./turn-timing.ts";
  import { toolCallDurationMs } from "../../state/chat-messages.ts";
  import type { Beat } from "./types.ts";
  import Answer from "../response/Answer.svelte";
  import { absent, failed, pending } from "../response/grammar.ts";

  let { beat, expanded }: { beat: Beat; expanded: boolean } = $props();

  const tool = $derived(beat.tool!);
  /** The one owner decides the state; this component only renders it.
   *  Named `cardState` rather than `state` so the `$state` rune below is
   *  not parsed as a store subscription to this binding. */
  const cardState = $derived(beatState(beat));
  /**
   * THE SHAPE DECISION, and the one place it is made.
   *
   * It reads the USER'S toggle and the LIVE flag, and nothing else. It must
   * never consult `done` or `error`: the instant an outcome can widen or
   * narrow the beat, a success and a failure stop being comparable, which is
   * exactly the defect this pass removed. `flow-tool-symmetry.test.ts` pins
   * it, and its mutation self-check re-introduces the old
   * `|| tool.status === "error"` to prove the pin bites.
   */
  const live = $derived(tool.status === "running");
  const open = $derived(expanded || live);

  /**
   * LIVE ELAPSED — the duration owner already measured `now - startedAt`
   * while the call is running. This beat used to render `tool.durationMs`
   * only, so a long `create_artifact` sat with no clock until the result
   * landed. The clock is WaitLine's: time passing, not arrivals. It ticks
   * only while `live`; a finished call reads the recorded duration and
   * does not keep a timer.
   */
  let nowMs = $state(Date.now());
  $effect(() => {
    if (!live) return;
    return startElapsedTick((n) => {
      nowMs = n;
    });
  });
  const durationMs = $derived(toolCallDurationMs(tool, nowMs));

  /**
   * THE PARENT TURN, when this call is its child. Needed for two facts that
   * live on the turn, not on the tool: the arrival record (rail) and the
   * token totals. Read through `logVersion` so a usage frame or a streaming
   * flag flipping on the parent is seen without this beat being rebuilt.
   */
  const parentBeat = $derived.by(() => {
    void $logVersion;
    if (beat.parentId === null) return undefined;
    return beatById(beat.parentId);
  });

  /**
   * A SILENT PARENT HIDES ITS ROW (`rendersInFlow`). That is when THIS beat
   * is the only spectator surface left — the rail and the token totals would
   * otherwise vanish mid-artifact. While the parent still renders, its
   * footer owns those facts (one instrument).
   */
  const parentHidden = $derived(
    parentBeat !== undefined && parentBeat.kind === "turn" && !rendersInFlow(parentBeat),
  );

  /**
   * Arrivals for the parent turn. Subscribed ONLY while the parent is hidden
   * and this call is live: argument streaming otherwise belongs to TurnBeat,
   * and listening here would rebuild the card per frame (§3.8).
   */
  const observed = $derived.by(() => {
    if (!live || !parentHidden) return { chars: 0, channel: null };
    void $arrivalVersion;
    const id = parentBeat?.turn?.sourceId;
    return id !== undefined ? observedFor(id) : { chars: 0, channel: null };
  });

  const showToolRail = $derived(live && parentHidden && observed.chars > 0);

  /**
   * Token totals from the parent turn, only while that turn is hidden.
   * They are already in the turn footer when the turn is visible; repeating
   * them here would be two instruments asserting one fact. Absence (usage
   * has not landed) renders as absence — never a live tok/s invented from
   * characters.
   */
  const liveTokens = $derived.by(() => {
    if (!live || !parentHidden) return null;
    const turn = parentBeat?.turn;
    if (turn === undefined) return null;
    if (turn.inputTokens === undefined && turn.outputTokens === undefined) return null;
    return { in: turn.inputTokens, out: turn.outputTokens };
  });

  const showLiveProgress = $derived(showToolRail || liveTokens !== null);

  /**
   * A retry is news; the first time this instance sees a count is not.
   * Skip the first assignment so a re-read already carrying "attempt 2"
   * does not spark; an increment while live does.
   */
  let lastAttempt: number | null = null;
  let seenAttempt = false;
  const attemptMotion = $derived.by((): MovesParam => {
    const next = tool.attemptCount ?? null;
    const previous = lastAttempt;
    const had = seenAttempt;
    seenAttempt = true;
    lastAttempt = next;
    if (!had || previous === next || next === null) return null;
    return {
      motion: "arrive",
      cause: becauseChanged("this call's attempt count", previous, next),
    };
  });

  function fmt(n: number): string {
    return n.toLocaleString("en-US");
  }

  /**
   * ── THE ARTIFACT SLOT ─────────────────────────────────────────────────────
   *
   * One tool does not produce a RESULT to be read, it produces a THING to be
   * used: `create_artifact` carries a whole HTML document, and the only
   * faithful rendering of it is the document, running.
   *
   * The slot is decided by the tool's NAME and by the RECORD it carries —
   * never by how the call went — so it appears identically for a call that
   * succeeded and one that failed. That is the same symmetric-detail rule the
   * rest of this beat obeys: a refused artifact gets the same slot in the same
   * place, holding the refusal instead of the frame. `artifact.ts` owns the
   * decision; this component only asks for it.
   *
   * The slot renders whether the beat is open or closed. An artifact is the
   * point of its own beat — collapsing it to a line of source would be like
   * collapsing a photograph to its file size — and the fisheye already has the
   * lever for beats that should shrink: at `ghost` and `tick` this component
   * is not mounted at all.
   */
  const isArtifact = $derived(isArtifactBeat(beat));
  const artifact = $derived(artifactViewOf(beat));

  /**
   * The artifact's arguments MINUS the document itself.
   *
   * CONTAINMENT, not tidiness. A real artifact from the battle test was
   * 55,096 bytes; handed to ToolInput it becomes a 1,177-line code block that
   * the flow's virtualizer then has to measure, in a beat whose whole purpose
   * is being rendered three feet above it. The document has exactly one home
   * on this screen — the frame — and the clipboard button on the frame carries
   * it out verbatim for anyone who wants the source.
   */
  const artifactArgs = $derived.by(() => {
    const v = tool.input;
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const { content: _content, ...rest } = v as Record<string, unknown>;
    return rest;
  });

  /** True when there is any recorded input at all to render. */
  const hasInput = $derived(tool.input !== undefined && tool.input !== null);
  /** True when there is any recorded output at all to render. */
  const hasOutput = $derived(
    tool.output !== undefined && tool.output !== null && tool.output !== "",
  );

  /** The FILE the input names, when it names one — rendered as a door
   * (PathChip) rather than dead text. Path-shaped keys only: a command or a
   * query is a primary arg but not a place the editor can open. */
  const pathArg = $derived.by(() => {
    const v = tool.input;
    if (isArtifact || v === null || typeof v !== "object" || Array.isArray(v)) return null;
    const obj = v as Record<string, unknown>;
    const p = obj["path"] ?? obj["file"] ?? obj["filePath"];
    return typeof p === "string" && p.trim().length > 0 ? p.trim() : null;
  });

  /** The collapsed one-line arg hint: lead with the tool's primary arg
   * (path/command/query/args) when the input names one, else a faithful
   * one-line summary built from the value's own entries. */
  const argHint = $derived.by(() => {
    const v = tool.input;
    // An artifact's identity is its title, kind and size — not the first 120
    // characters of its DOCTYPE, which is what the generic summariser produced
    // (`type=game title=TETRIS — Complete Clone content=<!DOCTYPE html> <html
    // lang="en"> <head> <meta charset…`) and which told a reader nothing.
    if (isArtifact) return artifactSummary(artifact);
    if (v === undefined || v === null) return "";
    if (typeof v === "object" && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      const primary =
        obj["path"] ?? obj["file"] ?? obj["filePath"] ?? obj["command"] ?? obj["query"] ??
        obj["pattern"] ?? obj["prompt"];
      if (primary !== undefined && primary !== null) return oneLineSummary(primary, ONE_LINE_HINT_CHARS);
    }
    return oneLineSummary(v, ONE_LINE_HINT_CHARS);
  });

  /**
   * The collapsed output hint — the SAME slot, the same summarizer and the
   * same truncation whichever way the call went.
   *
   * It used to print the word "failed" for an error, which threw away the
   * server's real message and then said something the status glyph beside it
   * had already said. Now the recorded value is summarized identically in
   * both cases: `export const x = 1;` for one call, `ENOENT: no such file` for
   * the other, clipped at the same character budget.
   *
   * NOTHING IS FABRICATED (§1.1). When the record genuinely carries no
   * output, the slot says so in plain words rather than inventing a result or
   * borrowing the status word — and the sentence names WHY it is empty when
   * the client observed a reason.
   */
  const outputHint = $derived.by(() => {
    if (hasOutput) return oneLineSummary(tool.output, ONE_LINE_HINT_CHARS);
    if (live) return "nothing returned yet";
    if (tool.incompleteReason !== undefined) return `no result — ${tool.incompleteReason}`;
    return "nothing recorded";
  });

</script>

<!--
  THE ANATOMY. Every structural node carries a `data-field` name, because the
  symmetry claim is only worth what can be MEASURED: the guard renders this
  component once per status and compares the two field sequences for exact
  equality. A field that appears for one outcome and not the other is a test
  failure, not a review note.

  A field may still be conditional — on whether the RECORD carries it
  (`attempt`, `duration`) or on the level (collapsed vs expanded). It may
  never be conditional on how the call went.
-->
<!--
  TWO STATES, AND ONLY TWO (the user's direction, verbatim): "I want to see
  the toolcall expanded, but not fully expanded, either expanded in one line
  or fully expanded into multiple lines (allowed to also take a larger
  width)."

  So a tool call is EITHER one complete line OR the whole transformation.
  The half-way rendering it used to rest at — a head row, and then a second
  line holding the hints — was neither: two lines of chrome that still made
  you click to see the actual input and output. It is gone. At rest the
  head's fields and the two hints share ONE line; opened, the card takes the
  wider bleed bound and renders both cells in full.
-->
<div class="tool beat-card" class:open class:artifact={isArtifact}>
  <div class="head" class:one-line={!open}>
    <span class="name" data-field="tool-name">{tool.label}</span>
    {#if tool.attemptCount !== undefined && tool.attemptCount > 1}
      <span class="meta" data-field="attempt" use:moves={attemptMotion}>attempt {tool.attemptCount}</span>
    {/if}
    <!-- STATE, LEGIBLE AT REST (the user's correction): the glyph carries it
         by form and the word carries it in plain language, so neither a
         colour-blind reader nor a distant one has to click to know how the
         call went — and the hue carries it at a glance (success green, error
         red, warning yellow: the user's direct call, see beat-state.ts).
         ALL THREE STATES WEAR THE SAME AFFORDANCE, differing only in hue;
         that sameness is what makes them read as siblings. -->
    <span class="chip" data-state={cardState} data-field="status">
      <span class="state-glyph" aria-hidden="true">{STATE_GLYPH[cardState]}</span>
      {stateWord(cardState)}
    </span>
    {#if durationMs !== null}
      <span class="meta" data-field="duration">{fmtDurationMs(durationMs)}</span>
    {/if}
    {#if !open}
      <!-- THE REST OF THE ONE LINE. The two hints sit in the SAME row as the
           head's fields, not on a second line under them — a resting tool
           call is one line, and one line is the whole of it.

           Both are conditional on the RECORD, never on the outcome, which is
           what keeps a resting success and a resting failure the identical
           object (flow-tool-symmetry.test.ts compares them field for
           field). -->
      {#if pathArg !== null}
        <!-- The path IS the hint here, and it is a door (PathChip): the
             chip opens the editor at this file. Same data-field either way —
             the chip is conditional on the RECORD naming a path, never on
             the outcome, so the symmetry contract holds. -->
        <span class="arg-hint trunc" data-field="input-hint"><PathChip path={pathArg} /></span>
      {:else if argHint.length > 0}
        <span class="arg-hint trunc" data-field="input-hint">{argHint}</span>
      {/if}
      <span class="result-hint trunc" data-field="output-hint">→ {outputHint}</span>
    {/if}
  </div>

  <!-- THE LIVE SPECTATOR ROW. Present only while this call is in flight AND
       the parent turn is hidden — otherwise the turn footer already holds
       the rail and the token totals. Elapsed lives on the head (the
       duration field), so this row is the facts that would otherwise
       vanish with a silent turn: the arrival rail, and the measured
       tokens if usage has landed. -->
  {#if showLiveProgress}
    <div class="live-row" data-field="live-progress">
      {#if showToolRail}
        <StreamPulse chars={observed.chars} channel={observed.channel} />
      {/if}
      {#if liveTokens !== null}
        {#if liveTokens.in !== undefined}<span data-field="input-tokens">↑{fmt(liveTokens.in)}</span>{/if}
        {#if liveTokens.out !== undefined}<span data-field="output-tokens">↓{fmt(liveTokens.out)} tok</span>{/if}
      {/if}
    </div>
  {/if}

  <!-- THE ARTIFACT, RUNNING. Present for every `create_artifact` beat and for
       no other, open or closed, whichever way the call went — one slot, whose
       CONTENT is either the live document or the honest reason there is none.
       The condition is on the tool's identity and the record, never on the
       outcome. -->
  {#if isArtifact}
    <div class="artifact-slot">
      <!-- `frameKey` is the BEAT's id, and it is what a runtime error is
           attributed to. Two artifacts in one conversation are two beats, so
           one artifact's crash can never be recorded against the other's frame
           — and because attribution is resolved from the posting WINDOW
           (render/artifact-errors.ts), the key is never something an artifact
           can name for itself.

           `expanded` rides the beat's open state: the expand gesture grows
           the stage VERTICALLY (the taller declared height) — the card's
           width rules below keep the column stable across the gesture. -->
      <ArtifactFrame view={artifact} frameKey={beat.id} expanded={open} />
    </div>
  {/if}

  {#if open}
    <div class="cells">
      <div class="cell" data-field="input-cell" data-untrusted>
        <div class="cell-label engraved" data-field="input-label">input</div>
        {#if hasInput}
          <div data-field="input-body">
            <ToolInput input={isArtifact ? artifactArgs : tool.input} maxLines={TOOL_CELL_FOLD_LINES} />
            {#if live}<span class="caret" aria-hidden="true"></span>{/if}
          </div>
        {:else}
          <!-- "The call has not sent them yet" and "this call takes none" were
               the same pixels. `pending` NAMES what it is waiting for, which
               is what stops it degenerating into a spinner. -->
          <div data-field="input-body">
            {#if live}
              <Answer answer={pending("waiting for the call's arguments")} />
            {:else}
              <Answer answer={absent("this call takes no arguments")} />
            {/if}
          </div>
        {/if}
      </div>
      <div class="arrow" data-field="arrow" aria-hidden="true">↓</div>
      <!-- THE OUTPUT CELL. Its LABEL is the same word for every outcome: this
           cell is what the call returned, and a failure's message is what a
           failing call returns. Naming it "error" for one status and "output"
           for the other made the two cells look like different fields, which
           is the shape difference the user asked to be rid of — and the
           status is already stated three times over (glyph, word, edge). -->
      <div class="cell" data-field="output-cell" data-untrusted>
        <div class="cell-label engraved" data-field="output-label">output</div>
        {#if hasOutput}
          <div data-field="output-body">
            <ToolOutput
              name={tool.name}
              input={tool.input}
              output={tool.output}
              maxLines={TOOL_CELL_FOLD_LINES}
            />
          </div>
        {:else}
          <!-- NO FABRICATION (§1.1). A failure that carries no detail says
               that it carries none; it never gets a message invented for it,
               and the client's own observation is labelled as the client's. -->
          <div data-field="output-body">
            {#if live}
              <Answer answer={pending("waiting for what this call returns")} />
            {:else if tool.incompleteReason !== undefined}
              <Answer
                answer={failed(
                  `no result — ${tool.incompleteReason} (client observation, not the tool's output)`,
                )}
              />
            {:else}
              <Answer answer={absent("the record carries no output for this call")} />
            {/if}
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  /* Ground, hairline, radius, padding and the mono register all come from
   * the shared `.beat-card` vocabulary (tokens.css) — including the leading
   * edge, which the beat's own `data-state` tints. This component states
   * only what is ITS OWN. */
  /* The row header's spine is owned by tokens.css (.cockpit .head); the
   * tool beat's head breathes a step wider between its fields. */
  .head { gap: var(--sp-3); }
  /* AT REST THE HEAD *IS* THE BEAT. It holds every field the card states —
   * name, attempt, status, duration, and both hints — on one line that never
   * wraps. What a narrow window costs is the TAIL of a summary (the two
   * hints shrink and ellipsize); it never costs a whole field, and it never
   * costs a second line. */
  .head.one-line {
    flex-wrap: nowrap;
    min-width: 0;
  }
  /* AN OPEN CARD MAY TAKE MORE ROOM THAN A RESTING ONE (the user's
   * direction: "fully expanded into multiple lines (allowed to also take a
   * larger width)"). --rail is the resting bleed bound and stays the owner
   * of every closed instrument's width; --rail-open is the one step wider an
   * instrument earns by being ASKED for, which is the same §2.1 logic
   * ("instruments bleed") applied to a card the reader deliberately opened.
   * Prose is untouched: --measure still owns running text.
   *
   * THE ARTIFACT CARD IS THE ONE EXCEPTION, and the exception is not written
   * here: expanding an artifact grows the preview VERTICALLY, never wider,
   * so the artifact card holds the run pane's column in both states. The
   * width policy — including that exception — is owned by the shared
   * vocabulary (tokens.css, beside the --rail declarations it governs); a
   * local copy here would be the re-declaration the density guard reds on. */
  .tool.open {
    width: 100%;
    max-width: var(--rail-open);
  }
  .name { color: var(--ink-1); }
  .meta { color: var(--ink-3); font-variant-numeric: tabular-nums; }
  /* Same register as the turn footer's measured row: mono, tabular, wrap.
   * The rail's reserved boxes already keep it from resizing the card as
   * the channel word changes. */
  .live-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-3);
    margin-top: var(--sp-1);
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    font-variant-numeric: tabular-nums;
    color: var(--ink-3);
  }
  /* The status chip's recipe + state hue are owned by tokens.css
   * (`.cockpit .chip` reading `--outcome-ink`). */
  .state-glyph { font-family: var(--face-mono); letter-spacing: normal; }
  /* THE THREE OUTCOME HUES — the user's direct call: "success green, error
   * red, warning yellow." They are siblings on purpose: one affordance, one
   * weight, one treatment, differing only in hue, so a green success and a
   * red error are recognisably the same instrument reporting two answers.
   * `running` keeps the one live hue it has everywhere else in the cockpit.
   * (This replaces an earlier rule that left success uncoloured; see
   * beat-state.ts for the record of the change.) */
  /* The state hue reaches the chip through `--outcome-ink` (set by the
   * `[data-state]` mapping in tokens.css) — never a per-class re-spelling. */
  /* The two cells STACK (input above output) rather than sitting side by
   * side. Splitting the card into two columns halves the room a highlighted
   * code block with a number rail — or a diff's gutter plus two number
   * rails — actually needs. Stacked, each cell gets the full card width and
   * the ↓ still reads as the input→output transformation. The card itself
   * hugs its content and BLEEDS to --rail when the content earns it (§2.1:
   * prose at the measure, instruments bleed). */
  .cells {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    margin-top: var(--sp-1);
  }
  /* The artifact sits between the head and the cells and takes the card's
   * full width. It states no height of its own — the frame declares that from
   * the artifact's kind, so the box cannot be sized by what is inside it. */
  .artifact-slot {
    margin-top: var(--sp-1);
    min-width: 0;
  }
  /* BOTH CELLS ARE THE SAME CELL. A failed call's output cell used to gain a
   * leading alarm rule and an indent, which is a SHAPE difference — the two
   * outcomes no longer laid out the same way and could not be compared line
   * for line. The outcome is carried by the beat's own leading edge and by
   * the status chip above, both of which a success wears too (in green). */
  .cell {
    min-width: 0;
  }
  /* The engraved recipe is owned by tokens.css (.cockpit .engraved). */
  .cell-label {
    margin-bottom: var(--sp-0);
  }
  .arrow {
    /* The arrow introduces the output preview, so it wears the preview's ink
     * (ink-3): it is an informative glyph (which side is the result), which
     * holds WCAG 1.4.11's 3:1 on the card's ground in BOTH themes — ink-4
     * read 2.16:1/2.23:1 there (UIE-046). */
    color: var(--ink-3);
    align-self: center;
    line-height: var(--lh-tight);
  }
  .caret {
    display: inline-block;
    width: var(--sp-1);
    height: 1lh;
    vertical-align: text-bottom;
    background: var(--beam);
  }
  /* The two hints are the elastic part of the resting line: they shrink and
   * ellipsize so the fields around them survive a narrow window intact. */
  .arg-hint,
  .result-hint {
    min-width: 0;
    flex: 1 1 auto;
  }
  .arg-hint { color: var(--ink-2); }
  /* THE OUTPUT PREVIEW IS RECORDED DATA, not retired furniture: ink-4 (the
   * faintest register — placeholders, spent rail cells, retired rows) measured
   * 2.16:1 in Carbon and 2.23:1 in Logbook on the card's ground, under the
   * 3:1 floor for informative text (UIE-046). ink-3 is the register the
   * neighboring data fields already wear (ghost-meta, the status mark), and
   * it clears 3:1 on every ground in both themes — the input/output
   * relationship is preserved one step apart (ink-2 vs ink-3). */
  .result-hint { color: var(--ink-3); }
</style>
