<script lang="ts">
  /**
   * The uniform beat anatomy (spec §3.2):
   *
   *   [gutter 32px] [body: measure or bleed] [verbs, right-aligned, at rest]
   *
   * The gutter carries the causal spine line, the kind glyph, and lights as
   * part of the causal ribbon when this beat is on the focused chain (§6.5).
   * The causal fisheye decides the representation (full / ghost / tick) and
   * every compressed beat states its computed reason on focus.
   *
   * MOUSE PATHS (MOUSE-FIRST law, v2.1) — the flow used to move by ↑↓ and
   * open by Enter, with no clickable counterpart. Now:
   *
   *   - CLICK anywhere on a beat focuses it. The gutter is the causal
   *     handle: hovering it lights the spine and says so, and clicking it
   *     re-lights the causal chain through this beat (§6.5) — that is how a
   *     mouse "follows the chain".
   *   - every beat carries a hover/focus-revealed OPTIONS ROW under its
   *     content, holding its wired verbs and then the grammar grips that
   *     still have something to do FOR THAT KIND: expand-or-collapse (← →)
   *     where the fisheye actually compresses the kind, and scope (⏎) where
   *     the kind actually opens a sheet. The scope grip is labelled "scope",
   *     not "open": several beats carry their OWN `open` verb (a tool's
   *     output, an effect's file) and the two sat side by side meaning
   *     different things. The grip names the surface it opens; the verb keeps
   *     its own word.
   *   - ONE CLICK, ONE OUTCOME. A body click on a tool or effect card
   *     EXPANDS IT IN PLACE, and does nothing else.
   *
   *     THE USER'S CORRECTION, VERBATIM: "when clicking on a tool, it shows
   *     up on the right side on top of expanding in the chat, I just want
   *     expanding in the chat."
   *
   *     This REVERSES an earlier decision of ours — that an instrument beat
   *     opens its SCOPE on a body click, "because inspecting a card IS the
   *     natural web action". It was reasonable, but the click had grown to do
   *     two things at once: it expanded the card inline AND threw a sheet
   *     open on the right. Two surfaces from one gesture is a gesture you
   *     cannot aim. Recorded as a DECISION so nobody restores it thinking
   *     they are fixing a regression.
   *
   *     THAT FIX WAS NOT ENOUGH, and the user said so twice more: "sometimes
   *     when clicking around the tool open on the right side, I don't want
   *     that", then "scope also opens on a right menu." The body click had
   *     stopped opening the sheet, but the `scope` grip in the hover-revealed
   *     row and the `⋯` menu's own row still did — three ways in, two of them
   *     easy to hit while clicking around a card. So for a TOOL BEAT there is
   *     now NO path to a sheet at all: no grip, no menu (deleted outright),
   *     and ⏎ opens the card in place instead. `opensScopeSheet`
   *     (beat-state.ts) is the one owner of that, read by this row and by the
   *     chord alike.
   *
   *     WHAT THE SHEET SHOWED IS NOT LOST. It rendered four things the open
   *     card did not — the clock time, the causal parent as a followable
   *     thing, every verb including the refusing ones with their reasons, and
   *     the precise record — and all four now render UNDER the open card
   *     (BeatDepth.svelte). The user's other standing rule applies here: a
   *     control "should first bring more details and second just be
   *     clickable", so the details had to move before the control could go.
   *
   *     A beat with no inline depth (check delta, harness event, finding)
   *     therefore does nothing on a body click but take focus. It used to
   *     open the sheet, which was the same hidden second surface with none of
   *     the expansion to justify it; its `scope` grip is right there and
   *     visible. A TURN bubble never took a body click either — prose is for
   *     reading and selecting, and a sheet opening under every stray click
   *     would fight the selection.
   *
   * Every grip clears the pointer target floor (--hit-min, §12.5): the ink
   * stays engraved-micro and quiet, the HIT AREA is 24px in both axes.
   *
   * Every mouse control's tooltip is generated from the grammar table
   * (mouseTitleFor), so the click path teaches the chord and cannot teach a
   * key the router does not fire.
   */
  import { mouseTitleFor } from "../shell/keyboard.ts";
  import { gestureKeysFor } from "../shell/mouse-paths.ts";
  import TurnBeat from "./TurnBeat.svelte";
  import ToolBeat from "./ToolBeat.svelte";
  import EffectBeat from "./EffectBeat.svelte";
  import CheckDeltaBeat from "./CheckDeltaBeat.svelte";
  import EventBeat from "./EventBeat.svelte";
  import ActBeat from "./ActBeat.svelte";
  import Seam from "./Seam.svelte";
  import FindingNote from "../computer/FindingNote.svelte";
  import Verb from "./Verb.svelte";
  import BeatDepth from "./BeatDepth.svelte";
  import type { Beat } from "./types.ts";
  import { compressesInFlow, renderedLevel, type FisheyeResult } from "./fisheye.ts";
  import { groupSummary, type GroupPlace } from "./grouping.ts";
  import {
    beatState,
    beatVoice,
    opensScopeSheet,
    rendersInFlow,
    stateWord,
    STATE_GLYPH,
  } from "./beat-state.ts";
  import { fmtDurationMs, oneLineSummary } from "../render/shapes.ts";
  import { GHOST_ARG_CHARS, GHOST_OUT_CHARS } from "../render/render-config.ts";
  import { toolCallDurationMs } from "../../state/chat-messages.ts";

  let {
    beat,
    fisheye,
    focused,
    onChain,
    group = null,
    expanded,
    projectPath,
    onfocusbeat,
    onoverridebeat,
    onopenbeat,
    onexpandbeat,
    onfocuscause = undefined,
  }: {
    beat: Beat;
    fisheye: FisheyeResult;
    focused: boolean;
    onChain: boolean;
    /** Where this beat sits in its batch of consecutive tool calls, or null
     * when it stands alone (grouping.ts owns the rule). */
    group?: GroupPlace | null;
    expanded: boolean;
    projectPath: string | null;
    onfocusbeat: (id: string) => void;
    /** Fisheye override for THIS beat (the ← → grammar). */
    onoverridebeat: (id: string, value: "expand" | "collapse") => void;
    /** Focus this beat and open its SCOPE (the ⏎ grammar, the `scope` grip
     * and the menu row — never a body click, see the note above). */
    onopenbeat: (id: string) => void;
    /** Toggle this beat's INLINE expansion — the body click, and nothing
     * else. Beats with no inline depth simply never call it. */
    onexpandbeat: (id: string) => void;
    /** Follow the causal chain from the open card's inline depth: focus the
     * parent AND bring it into view. Absent when the host cannot move the
     * flow — the reference then renders as plain text (§1.2). */
    onfocuscause?: ((id: string) => void) | undefined;
  } = $props();

  const tExpand = mouseTitleFor("expand");
  const tCollapse = mouseTitleFor("collapse");
  const tOpen = mouseTitleFor("open-scope");

  /**
   * THE ROW IS THE MOUSE PATH FOR MOVING THE FOCUS. Clicking a beat focuses
   * it, which is the pointer's whole answer to `↑`/`↓` — more direct than any
   * control could be, since you click the fact you want rather than stepping
   * toward it. The chord is taught here, from the grammar table
   * (shell/mouse-paths.ts), as `aria-keyshortcuts`: assistive technology
   * announces it, and a virtualized stream does not pay a tooltip per row for
   * a fact the reader learns once.
   */
  const focusKeys = gestureKeysFor("focus-prev", "focus-next");

  /** A ghost row keeps its primary verb only. */
  const GHOST_VERB_COUNT = 1;

  const GLYPHS: Record<string, string> = {
    turn: "›",
    tool: "⊙",
    effect: "Δ",
    "check-delta": "✓",
    event: "!",
    finding: "∴",
    seam: "·",
    // A hand at the controls — the operator's own mark inside the rule-led
    // family (beat-state.ts states why it shares that register).
    act: "≡",
  };
  const glyph = $derived(
    beat.kind === "turn" && beat.turn?.who === "model" ? "‹" : GLYPHS[beat.kind] ?? "·",
  );

  // Which beats the fisheye actually compresses is owned by fisheye.ts
  // (renderedLevel) — the beat MENU reads the same rule, so the move it
  // offers is always the move this beat can make.
  const level = $derived(renderedLevel(beat.kind, fisheye.level));

  /* ══ BATCHED TOOL CALLS ═══════════════════════════════════════════════════
   *
   * THE USER'S REQUIREMENT, VERBATIM: "multiple tool calls in a row should be
   * batched and shown together." A run of consecutive tool calls is ONE act
   * of work with several parts, and it now reads as one: the members share a
   * container, the first draws the batch's cap, and COMPRESSED the whole
   * batch costs one row instead of one row per call — which is most of the
   * value, since three collapsed calls used to cost three rows.
   *
   * HOW THE COMPRESSED BATCH COSTS ONE ROW. Exactly one member draws the
   * compressed row — the REPRESENTATIVE, which is the batch's first member —
   * and it states the batch's aggregate ("3 tool calls · 1 failed"). The
   * others render nothing at all and therefore measure zero, the same
   * mechanism a hidden empty turn uses. No `{#each}` key changes and no row
   * is merged in the index, so a call arriving mid-batch can never remount
   * the batch or force it to re-measure — the defect an earlier generation of
   * this UI hit by keying a group on its members' joined ids.
   *
   * ABNORMALITY STILL RESISTS COMPRESSION, and the two rules cooperate here
   * rather than colliding. The fisheye holds an ABNORMAL beat at `full`
   * (fisheye.ts), so a batch containing a failure has that failing call drawn
   * in full while its quiet siblings compress around it — which is exactly
   * "the failing member is the one shown when space is tight", achieved
   * without either rule knowing about the other.
   *
   * ── WHAT A BATCH COSTS AT REST, AND WHY IT IS NO LONGER ONE ROW ──────────
   *
   * THE DECISION THIS REVERSES, recorded so nobody "repairs" it: a compressed
   * batch used to cost EXACTLY ONE ROW. The first member drew the aggregate
   * ("10 tool calls · all done") and every other member rendered nothing at
   * all, measuring zero.
   *
   * THE USER LOOKED AT THAT AND REPORTED IT AS THE DEFECT: ten calls behind
   * one line is ten facts you cannot see and did not agree to hide. "Batched
   * and shown together" asked for the ten to read as ONE ACT — which is what
   * the shared container, the closed-up rhythm and the unbroken causal spine
   * do — not for nine of them to disappear. A cap is a summary of rows that
   * are there; a cap with nothing under it is a replacement for them.
   *
   * SO: every member draws its own row at every level, and the first member
   * ALSO draws the cap. What compression buys is the row's SIZE (a 26px line
   * instead of a card), which is the fisheye's actual job, rather than the
   * row's EXISTENCE. A batch of ten now rests at roughly one cap plus ten
   * readable lines — visible without a click, and still unmistakably one act.
   */
  const inGroup = $derived(group !== null);
  /** The batch's aggregate, drawn once per group by its first member — at
   *  EVERY level, above whatever that level draws for the member itself. */
  const groupCap = $derived(group !== null && group.first ? groupSummary(group) : null);

  /* ══ THE COMPRESSION LADDER FOR A TOOL CALL ═══════════════════════════════
   *
   * ONE TABLE, stated once, because two separate reports turned out to be the
   * same question asked from both ends:
   *
   *   "tool call still shows as ultra collapsed … until I click on them"
   *   "when collapsing further a tool call, we just have its checkmark, we
   *    lose the name and everything, just … then a checkmark"
   *
   * THE PRINCIPLE: compression drops DETAIL, never IDENTITY. A beat that
   * cannot say what it is has compressed past the point of being worth any
   * pixels at all. Detail leaves in this order — output, input, timing — and
   * the name and the status are the last two things standing.
   *
   *   LEVEL          FIELDS RENDERED, IN ORDER
   *   ─────────────  ─────────────────────────────────────────────────────────
   *   tick           status(glyph) · tool-name
   *   ghost          status(glyph+word) · tool-name · attempt? ·
   *                  input-hint → output-hint · duration?
   *   full, at rest  the same fields as `ghost`, inside the beat's card
   *                  (ToolBeat.svelte's one-line head)
   *   full, opened   status(glyph+word) · tool-name · attempt? · duration? ·
   *                  the WHOLE input cell ↓ the WHOLE output cell
   *
   * `ghost` and `full`-at-rest carry the SAME fields on purpose: the user's
   * rule is two states and no third — "either expanded in one line or fully
   * expanded into multiple lines". The fisheye still distinguishes them, but
   * as PROMINENCE (the card's ground, hairline and state edge), never as
   * information. `tick` is only reachable by a deliberate manual collapse
   * (fisheye.ts refuses to send a tool call there automatically), so it is
   * the one rung where the reader has actively asked for less — and even
   * there the call still says its name.
   *
   * Fields marked `?` are conditional on the RECORD (did the call record an
   * attempt count? a duration?) and never on the outcome, which is what keeps
   * a success and a failure the identical object at every rung.
   *
   * ── THE COMPRESSED TOOL CALL — ONE LINE, THE WHOLE FIELD TABLE ────────────
   *
   * THE USER'S REPORT, VERBATIM: "tool call still shows as ultra collapsed,
   * like this, until I click on them."
   *
   * A compressed tool call used to render ONE blob of text — the tool's name,
   * its primary argument and a hint of its output, joined into a single
   * string — with the status carried by a glyph beside it. Everything else
   * the card states at rest was simply gone: the attempt count, and the
   * MEASURED DURATION. So a reader could not learn how long a call took
   * without clicking it back open, which is exactly the "click to find out"
   * the whole bubble system exists to remove.
   *
   * The compressed row now renders the SAME NAMED FIELDS the card's head
   * renders, in the same order, on one line:
   *
   *     status · tool-name · attempt · input-hint → output-hint · duration
   *
   * That is the answer to "the same amount of detail collapsed as expanded"
   * at the level where it was actually failing. Expanded still buys something
   * real — the FULL input and the FULL output, rendered in their true shapes
   * — but nothing you can only learn by clicking is a fact about the call.
   *
   * SYMMETRY IS PRESERVED BY CONSTRUCTION. Every field below is conditional
   * on the RECORD (does the call carry an attempt count? a duration?) and
   * never on the outcome, so a success and a failure emit the identical
   * `data-field` sequence at this level — which `flow-tool-symmetry.test.ts`
   * compares element for element.
   */
  const toolGhost = $derived.by(() => {
    if (beat.kind !== "tool" || beat.tool === undefined) return null;
    const t = beat.tool;
    const measured = toolCallDurationMs(t, Date.now());
    return {
      label: t.label,
      attempt: t.attemptCount !== undefined && t.attemptCount > 1 ? t.attemptCount : null,
      arg: oneLineSummary(primaryArg(t.input), GHOST_ARG_CHARS),
      // The recorded output, summarized the same way at the same budget
      // whichever way the call went. This used to substitute the word
      // "failed" for a failing call — throwing away the server's real
      // message, and then saying the one thing the status mark beside it had
      // already said.
      out:
        t.output === undefined || t.output === null || t.output === ""
          ? ""
          : oneLineSummary(t.output, GHOST_OUT_CHARS),
      duration: measured === null ? undefined : measured,
    };
  });


  function ghostText(b: Beat): string {
    switch (b.kind) {
      case "turn":
        return `${b.turn!.who === "you" ? "you" : "model"}: ${clip(b.turn!.text, 90)}`;
      case "effect": {
        const e = b.effect!;
        const counts =
          e.added !== undefined && e.removed !== undefined ? ` +${e.added} −${e.removed}` : "";
        return `${e.path}${counts}`;
      }
      case "check-delta":
        return `${b.checkDelta!.checkName}: ${b.checkDelta!.from} → ${b.checkDelta!.to}`;
      case "event":
        return `${b.event!.eventKind}: ${clip(b.event!.text, 90)}`;
      case "act": {
        // Compressed, an intervention still says WHO and WHAT — the declared
        // title when the manifest has one, the bare path when it does not.
        // The state mark beside it already reports whether it went through.
        const a = b.act!;
        return `you: ${clip(a.title ?? `${a.block} · ${a.action}`, 90)}`;
      }
      default:
        return "";
    }
  }
  /** The argument a tool call leads with, when its input names one. */
  function primaryArg(input: unknown): unknown {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
    const o = input as Record<string, unknown>;
    const lead =
      o["path"] ?? o["file"] ?? o["filePath"] ?? o["command"] ?? o["query"] ?? o["pattern"];
    return lead ?? input;
  }

  function clip(s: string, n: number): string {
    const one = s.replace(/\s+/g, " ").trim();
    return one.length > n ? `${one.slice(0, n - 1)}…` : one;
  }

  /** A compressed beat's natural move is OUT; a full beat's is IN. */
  const grows = $derived(level !== "full");

  /**
   * The verbs the OPTIONS ROW shows: the ones that can actually be PRESSED.
   *
   * ── WHY A DISABLED VERB DOES NOT STAND IN THIS ROW ───────────────────────
   *
   * THE USER'S REPORT: between every tool card sat the line
   *
   *     open   run again– no block declares a re-run action for a single …
   *     breaker   COLLAPSE   SCOPE   ⋯
   *
   * — the same truncated apology, cut off mid-sentence, repeated identically
   * down the entire conversation. §1.2 asks that a disabled verb carry its
   * honest reason as visible text rather than only a tooltip, and that rule
   * is right: a control that refuses must say why. But it says WHY ONCE, TO
   * SOMEONE WHO REACHED FOR IT — a refusal printed unbidden on every row is
   * not honesty, it is a sentence the reader has to skip hundreds of times,
   * and truncated to 48 characters it is not even a sentence.
   *
   * So the reason moved to where the reach happens, and it moved WHOLE:
   *
   *   - the SCOPE sheet renders every verb, disabled ones included, with its
   *     full reason (BeatScope.svelte) — for the kinds that have a sheet;
   *   - for a kind with no sheet, the OPEN CARD's inline depth does the same
   *     (BeatDepth.svelte), which is the surface that replaced it;
   *   - the row itself no longer draws the verb at all, at any level.
   *
   * (The `⋯` menu was a third such surface. It is deleted — every one of its
   * entries duplicated a control already on the row, or a gesture already
   * more direct; see the note in Flow.svelte.)
   *
   * Nothing is hidden and nothing is invented: the verb still exists in
   * `beat.verbs`, still carries its reason, and is still one gesture away on
   * a surface with room to print it. This was already the rule at the
   * COLLAPSED levels, for the same reason at a smaller scale; it is now the
   * rule everywhere, because a full-width row turned out to have no more
   * appetite for a repeated refusal than a one-line one.
   *
   * A collapsed row additionally keeps its PRIMARY verb only: it lays out
   * inline on a one-line budget and a second verb would push the grammar
   * grips off the end of the line.
   */
  const wiredVerbs = $derived(beat.verbs.filter((v) => v.wired));
  const optionVerbs = $derived(
    level === "full" ? wiredVerbs : wiredVerbs.slice(0, GHOST_VERB_COUNT),
  );

  /** Your words sit on the right, so the options under them do too. */
  const mine = $derived(beat.kind === "turn" && beat.turn?.who === "you");

  /* THE THREE AXES (beat-state.ts owns both decisions; tokens.css owns the
   * treatment). WHO is `mine` above; VOICE picks the register; STATE tints
   * the leading edge — and nothing else in this system spends colour. */
  const voice = $derived(beatVoice(beat));
  const state = $derived(beatState(beat));
  /** The state in plain words, or null when the beat has none to report. */
  const stateLabel = $derived(stateWord(state));

  /**
   * WHICH BEATS ANSWER A BODY CLICK: the ones that have somewhere to go IN
   * PLACE. A tool call folds its two cells; a file effect folds its diff.
   * Nothing else in the flow carries inline depth, so nothing else claims the
   * gesture — a card that silently did something other than what its
   * neighbours do would be worse than one that does nothing.
   */
  const bodyExpands = $derived(beat.kind === "tool" || beat.kind === "effect");

  function onBodyClick(): void {
    if (!bodyExpands) return;
    // A click that ENDS a text selection is a selection, not a command —
    // never re-fold a card out from under someone copying tool output.
    const sel = typeof getSelection === "function" ? getSelection() : null;
    if (sel !== null && !sel.isCollapsed) return;
    onexpandbeat(beat.id);
  }

  /**
   * WHICH GRAMMAR GRIPS THIS BEAT DRAWS — asked of the owners, never listed.
   *
   * A grip is drawn only where the move it names can change something for
   * THIS kind. Both questions have one owner each and both are DERIVED from
   * the rule they are about, so a kind added or unpinned later is covered
   * without anyone remembering a list:
   *
   *   compressesInFlow — `renderedLevel` pins turns, seams and findings to
   *     `full`, so an expand/collapse grip on one of them writes an override
   *     nothing reads. That is the inert COLLAPSE the user reported: "we have
   *     collapse under every chat message, but the button does not do
   *     anything, so just remove it."
   *   opensScopeSheet — a tool beat has no sheet at all any more, so it draws
   *     no grip that would open one.
   */
  const hasFold = $derived(compressesInFlow(beat.kind));
  const hasSheet = $derived(opensScopeSheet(beat.kind));

  /**
   * THE INLINE DEPTH renders for a kind that has no sheet, when the card the
   * reader opened is actually open. The facts it holds used to live in the
   * sheet; they have to live somewhere, and under the thing they describe is
   * the more direct place (BeatDepth.svelte states the inventory).
   */
  const showsDepth = $derived(!hasSheet && level === "full" && expanded);
</script>

<!--
  A BEAT THE FLOW DOES NOT DRAW COSTS NOTHING — not a row, not a gutter
  segment, not an options line. `rendersInFlow` (beat-state.ts) is the one
  owner of that decision and states why; today the only such beat is a model
  turn that produced no words, whose measured numbers are still rendered in
  full by its SCOPE. Emitting nothing at all is what makes the row free: the
  virtualizer measures 0 and the causal spine closes over the gap.
-->
{#if rendersInFlow(beat)}
<!-- svelte-ignore a11y_click_events_have_key_events (keyboard focus/keys are owned by the Flow's roving listbox) -->
<div
  class="beat kind-{beat.kind} level-{level} reveal-on-hover"
  class:in-group={inGroup}
  class:group-first={group?.first === true}
  class:group-last={group?.last === true}
  class:focused
  class:mine
  class:on-chain={onChain}
  class:abnormal={beat.abnormal}
  role="option"
  aria-selected={focused}
  tabindex={-1}
  id="beat-{beat.id}"
  data-beat-id={beat.id}
  aria-keyshortcuts={focusKeys}
  data-voice={voice}
  data-state={state}
  onclick={() => onfocusbeat(beat.id)}
>
  <!-- The causal handle: click anywhere on it to focus this beat and
       re-light the chain through it. The gutter carries no BUTTON of its
       own — a 32px column cannot hold a 24px target above and below the
       glyph without making the focused row taller than the resting one,
       and a row that grows on focus would re-measure in the virtualizer.
       The ▲▼ stepper therefore lives in the cluster, where every target
       clears the floor. -->
  <div class="gutter" title="click to follow the causal chain through this beat">
    <span class="spine" aria-hidden="true"></span>
    <span class="beat-glyph" aria-hidden="true">{glyph}</span>
  </div>

  <!-- The stack: the beat's content, and UNDER IT the one options row.
       Every kind has the same two children in the same order — that is the
       whole of the uniformity rule. -->
  <div class="stack">
    {#if groupCap !== null && group !== null}
      <!-- THE BATCH CAP, AT EVERY LEVEL. It states the aggregate at rest, so
           a mixed batch can never read as clean: the count, and the WORST
           state among the members, in the same words and the same hue the
           members' own status marks use (grouping.ts owns "worst wins"). It
           is a CAP OVER ROWS THAT ARE THERE — every member still draws its
           own line beneath it (see the note in the script). It carries no
           verbs: a genuinely group-level verb does not exist yet, and
           duplicating a per-call verb up here is exactly the
           two-places-for-one-idea the options row pass removed. -->
      <div class="group-cap" data-field="group-cap" data-state={group.worst}>
        <span class="group-mark" aria-hidden="true"
          >{STATE_GLYPH[group.worst]}</span
        >
        <span class="group-text engraved trunc">{groupCap}</span>
      </div>
    {/if}

    <!-- THE LINE: the beat's content, and its options row. They STACK at
         `full` and share one row at the collapsed levels — a one-line ghost
         has no second line to give. Wrapping them here (rather than letting
         `.stack` change direction) is what lets the batch cap sit above both
         without being dragged into the collapsed row's flex line. -->
    <div class="line">
    <!-- EVERY LEVEL HAS ONE ANATOMY, and it is the same anatomy for a
         success, a failure and a call in flight. The `data-field` names are
         what `flow-tool-symmetry.test.ts` compares: it renders this beat at
         each level once per status and requires the field sequences to match
         exactly. Outcome may change what a field CONTAINS (the state glyph,
         the summarized output); it may not change which fields exist. -->
    {#if level === "tick"}
      <div class="tick-row">
        <span class="tick-mark" data-field="tick-mark"></span>
        <!-- LEGIBLE AT REST AT EVERY LEVEL: even the most compressed
             representation states how the fact went. A tick you have to
             click to read the status of is the defect the user reported. -->
        {#if stateLabel !== null}
          <span class="state-mark" data-state={state} title={stateLabel} data-field="status"
            >{STATE_GLYPH[state]}</span
          >
        {/if}
        <!-- COMPRESSION DROPS DETAIL, NEVER IDENTITY (the user's report:
             "when collapsing further a tool call, we just have its
             checkmark, we lose the name and everything"). A checkmark alone
             is a claim that SOMETHING succeeded — unreadable, unsearchable,
             and indistinguishable from the call above it. A beat that cannot
             say what it is has compressed past the point of being worth any
             pixels at all, so the NAME is the last field to go, not the
             first. It costs one word. -->
        {#if toolGhost !== null}
          <span class="ghost-name tick-name" data-field="tool-name">{toolGhost.label}</span>
        {/if}
        {#if focused}<span class="reason trunc" data-field="reason">{fisheye.reason}</span>{/if}
      </div>
    {:else if level === "ghost"}
      <div class="ghost-row">
        {#if stateLabel !== null}
          <!-- THE STATUS, IN FORM *AND* IN WORDS at this level too. The glyph
               alone made a reader hover to learn whether a call succeeded;
               the word costs four characters and removes the hover. -->
          <span class="state-mark" data-state={state} data-field="status"
            ><span class="state-glyph" aria-hidden="true">{STATE_GLYPH[state]}</span
            ><span class="engraved">{stateLabel}</span></span
          >
        {/if}
        {#if toolGhost !== null}
          <!-- The card head's field table, on one line. Every condition here
               is on the RECORD, never on the outcome — that is what keeps a
               ghosted success and a ghosted failure the same object. -->
          <span class="ghost-name" data-field="tool-name">{toolGhost.label}</span>
          {#if toolGhost.attempt !== null}
            <span class="ghost-meta" data-field="attempt">attempt {toolGhost.attempt}</span>
          {/if}
          {#if toolGhost.arg.length > 0}
            <span class="ghost-text trunc" data-field="input-hint">{toolGhost.arg}</span>
          {/if}
          {#if toolGhost.out.length > 0}
            <span class="ghost-out trunc" data-field="output-hint">→ {toolGhost.out}</span>
          {/if}
          {#if toolGhost.duration !== undefined}
            <span class="ghost-meta" data-field="duration">{fmtDurationMs(toolGhost.duration)}</span>
          {/if}
        {:else}
          <span class="ghost-text trunc" data-field="ghost-text">{ghostText(beat)}</span>
        {/if}
        {#if focused}<span class="reason trunc" data-field="reason">{fisheye.reason}</span>{/if}
      </div>
    {:else}
      <!-- svelte-ignore a11y_click_events_have_key_events (⏎ on the focused beat is the keyboard twin, owned by the Flow) -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="body"
        class:bleed={beat.bleed}
        class:openable={bodyExpands}
        title={bodyExpands ? "click to expand or fold this in place" : undefined}
        onclick={onBodyClick}
      >
        {#if beat.kind === "turn"}
          <TurnBeat {beat} />
        {:else if beat.kind === "tool"}
          <ToolBeat {beat} {expanded} />
        {:else if beat.kind === "effect"}
          <EffectBeat {beat} {expanded} {projectPath} />
        {:else if beat.kind === "check-delta"}
          <CheckDeltaBeat {beat} />
        {:else if beat.kind === "event"}
          <EventBeat {beat} />
        {:else if beat.kind === "act"}
          <ActBeat {beat} />
        {:else if beat.kind === "seam"}
          <Seam {beat} />
        {:else if beat.kind === "finding" && beat.finding !== undefined}
          <FindingNote
            sentence={beat.finding.sentence}
            derivation={beat.finding.derivation}
            verbs={[]}
            mark={false}
          />
        {/if}

        <!-- MORE DETAIL, IN PLACE. What the SCOPE sheet used to add for this
             kind, now under the card it describes — because the kinds that
             render this are exactly the kinds that no longer open a sheet. -->
        {#if showsDepth}
          <BeatDepth {beat} onfocuscause={onfocuscause} />
        {/if}
      </div>
    {/if}

    <!-- THE OPTIONS ROW — the one place a beat's options live, in the one
         form they take, for EVERY kind (user message, model message, tool
         call, effect, check, event, finding). The beat's own WIRED verbs
         first, then a hairline, then whichever grammar grips can still change
         something for this kind (expand/collapse, scope). Alignment follows
         the CONTENT it sits under: right under a right-aligned user bubble,
         left under everything else.

         QUIET UNTIL WANTED (the user's binding correction: "buttons beside
         the chat should show only when we have our mouse over the actual
         message"). The row is always LAID OUT and only its opacity moves, so
         revealing it can never shift the page or re-measure the beat. -->
    <div class="options reveal-item">
      {#each optionVerbs as verb (verb.id)}
        <Verb {verb} />
      {/each}
      {#if optionVerbs.length > 0 && (hasFold || hasSheet)}
        <span class="options-rule" aria-hidden="true"></span>
      {/if}
      <!-- NO CONTROL WITHOUT AN EFFECT, PER KIND (§1.2). Both grips are
           conditioned on the kind's OWN answer, from the owner of the rule
           each one names — so a kind the fisheye cannot compress draws no
           expand/collapse, and a kind with no sheet draws no scope. A row
           that ends up with nothing at rest is the honest outcome, not a
           gap to fill. -->
      {#if hasFold}
        {#if grows}
          <button
            class="verb beat-grip "
            data-verb-id="flow.fisheye/expand"
            data-chord-target="expand"
            title={tExpand}
            onclick={(e) => { e.stopPropagation(); onoverridebeat(beat.id, "expand"); }}
          >Expand</button>
        {:else}
          <button
            class="verb beat-grip "
            data-verb-id="flow.fisheye/collapse"
            data-chord-target="collapse"
            title={tCollapse}
            onclick={(e) => { e.stopPropagation(); onoverridebeat(beat.id, "collapse"); }}
          >Collapse</button>
        {/if}
      {/if}
      {#if hasSheet}
        <button
          class="verb beat-grip "
          data-verb-id="flow.scope/open"
          data-chord-target="open-scope"
          title={tOpen}
          onclick={(e) => { e.stopPropagation(); onopenbeat(beat.id); }}
        >Details</button>
      {/if}
    </div>
    </div>
  </div>
</div>
{/if}

<style>
  /* THE BEAT'S TWO COLUMNS — the causal gutter, and the stack.
   *
   * There is no third column. There used to be one, holding the beat's
   * controls, and it did two kinds of damage:
   *
   *   - it RESERVED INLINE WIDTH on the right even when it held nothing, so
   *     the body could never reach the flow's true right edge and a
   *     right-aligned user bubble stopped ~187px short of it (measured at
   *     1536px). A right-aligned message that stops short does not read as a
   *     deliberate margin — it reads as misaligned;
   *   - it put every beat's options somewhere other than under the beat,
   *     which on a wide screen separated a ghost tool call's `open` verb
   *     from its own subject by ~1900px.
   *
   * The options now sit UNDER the content, in one row, in one form, for
   * every kind (see .options). The body therefore spans the full remaining
   * width and the only thing between it and the edge is the page gutter. */
  .beat {
    display: grid;
    grid-template-columns: var(--gutter-beat) minmax(0, 1fr);
    align-items: start;
    padding: var(--beat-pad-y) var(--gutter-bleed) var(--beat-pad-y) 0;
  }
  /* A COLLAPSED BEAT IS ONE LINE (§3.2): the vertical budget drops to
   * --beat-ghost-h / --beat-tick-h, and nothing in the gutter or the options
   * row is allowed to push past it (see .beat-glyph and .options below).
   * FULL beats keep their rhythm — this is about the collapsed levels, not
   * about compressing prose. */
  .beat.level-ghost,
  .beat.level-tick {
    align-items: center;
    padding-top: var(--beat-pad-collapsed);
    padding-bottom: var(--beat-pad-collapsed);
  }
  /* The stack: the batch cap (when this beat draws one), then the line. */
  .stack {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  /* The line: content, then the options row under it. At a collapsed level
   * the two share ONE line instead of stacking — a one-line ghost has no
   * second line to give, and the row keeps the same component, the same
   * type and the same order either way. */
  .line {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .level-ghost .line,
  .level-tick .line {
    flex-direction: row;
    align-items: center;
  }
  .gutter {
    position: relative;
    align-self: stretch;
    display: flex;
    flex-direction: column;
    align-items: center;
    /* The causal handle is a click target: the pointer says so, and the
     * spine brightens under the pointer so the chain reads as grabbable. */
    cursor: pointer;
  }
  .beat:hover .spine {
    background: var(--line-2);
  }
  .beat:hover.on-chain .spine {
    background: var(--beam);
  }
  .options-rule {
    width: var(--hairline-w);
    align-self: stretch;
    background: var(--line-1);
    margin: 0 var(--sp-1);
  }
  .spine {
    position: absolute;
    top: 0;
    bottom: 0;
    width: var(--hairline-w);
    background: var(--line-1);
  }
  .on-chain .spine {
    background: var(--beam);
    width: var(--sp-0);
  }
  .beat-glyph {
    position: relative;
    margin-top: var(--sp-2);
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--outcome-ink, var(--ink-3));
    background: var(--ground-0);
    line-height: var(--lh-tight);
    padding: var(--sp-0) 0;
  }
  /* At a collapsed level the gutter draws the causal spine and nothing
   * more: the glyph keeps its ink but drops the lead that would otherwise
   * set the row height from the gutter column. */
  .level-ghost .beat-glyph,
  .level-tick .beat-glyph {
    margin-top: 0;
    padding: 0;
  }
  .level-tick .beat-glyph {
    font-size: var(--f-nano-size);
  }
  /* The gutter mark carries the state too, so the causal spine reads as a
   * column of outcomes at any zoom — a literal one: green, yellow, red down
   * the gutter (the user's direct call, recorded in beat-state.ts). The hue
   * is the OWNED mapping, read once from `--outcome-ink` (set by the card's
   * `data-state` in tokens.css) rather than re-stated per state here — a
   * re-stated mapping drifts from the grammar the day a state re-points.
   * All four are the same mark in four hues; none is emphasised over the
   * others by weight or size, because the gutter's job is to let the column
   * be READ, not to argue about which row matters. */
  .on-chain .beat-glyph { color: var(--beam); }
  /* Focus is indicated by the causal gutter/chain, not a competing
   * background behind the bubble (v2.2 — the focused beat's luminance
   * layer fought the bubble's own ground, hurting readability). */
  .body { min-width: 0; }
  /* A card with inline depth announces that clicking it folds it. Cards with
   * none, and prose bubbles, deliberately keep the text cursor — a pointer
   * over something that does nothing is a promise the surface cannot keep. */
  .body.openable { cursor: pointer; }

  /* ══ THE OPTIONS ROW ══════════════════════════════════════════════════
   *
   * ONE row, ONE form, under EVERY kind — user message, model message, tool
   * call, effect, check, event, finding. Before this the same information
   * was laid out three different ways: verbs inside the bubble for turns,
   * a `.verbs-under` footer for instrument cards, and a right-hand cluster
   * column for the grammar grips. Three placements for one idea is what the
   * user was looking at when they said the options "should be similar".
   *
   * FORM is uniform, and so is BEHAVIOUR: the row is QUIET UNTIL WANTED for
   * every kind.
   *
   * ── THE DECISION THIS REVERSES ───────────────────────────────────────────
   *
   * Instrumental rows (tool, effect, check, event, finding) used to carry
   * their options AT REST, exempted from the hover reveal on the mouse-first
   * argument that "a control that only exists under the pointer is not
   * discoverable". The user has now seen that exemption in practice and
   * overruled it, verbatim: "buttons beside the chat should show only when
   * we have our mouse over the actual message."
   *
   * They are right, and the screenshot says why better than the argument
   * did: at the density the flow actually reaches, a column of tool calls
   * carried a permanent row of controls between every pair of cards, and the
   * controls out-massed the content they belonged to. Worse, a row sitting in
   * the gap BETWEEN two cards does not read as belonging to either — so the
   * at-rest version was not even buying the discoverability it was defended
   * for. Revealing on hover fixes both at once: the row appears attached to
   * exactly one beat, the one the pointer is on.
   *
   * DISCOVERABILITY IS NOT LOST. Every wired verb is here the moment the
   * pointer is on the beat or the keyboard focuses it; the SCOPE sheet (for
   * the kinds that have one) and the open card's inline depth (for the kinds
   * that do not) each carry the FULL set including the refusing verbs and
   * their reasons.
   *
   * KEYBOARD PARITY (a11y): `.focused` is the flow's roving-listbox target,
   * so the keyboard reveals the row exactly as the pointer does; and
   * `:focus-within` keeps it up while a grip inside it holds focus, so
   * tabbing into the row cannot make the row vanish under the caret.
   *
   * NO LAYOUT SHIFT: the row is LAID OUT at all times and only its opacity
   * moves — a virtualized beat must never change height because the pointer
   * entered it (§3.8), which is also why the reveal never uses `display`.
   *
   * ALIGNMENT follows the content it sits under: right under a right-aligned
   * user bubble, left under everything else. */
  .options {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-start;
    gap: var(--sp-1);
    /* HUGGING ITS OWN BEAT. The row used to be pushed --sp-2 below its card
     * and then sat in the middle of the --beat-pad-y gap between two beats,
     * which is what made its ownership ambiguous. It now sits tight under
     * the content it acts on, so even mid-reveal it is unmistakably the
     * lower edge of ONE card. */
    padding-top: var(--sp-0);
    min-width: 0;
  }
  .mine .options {
    justify-content: flex-end;
  }
  /* The reveal itself is the OWNED hover-reveal pattern (tokens.css,
   * `.reveal-on-hover .reveal-item`) — the beat marks itself the container
   * (`.beat.reveal-on-hover` on the root element) and this row the item.
   * The beat keeps its OWN extra trigger: `.focused`, the flow's roving-
   * listbox state, so the keyboard reveals the row exactly as the pointer
   * does (the owned pattern's `:focus-within` covers the pointer's twin). */
  .beat.focused .options {
    opacity: var(--opacity-on);
  }
  @media (prefers-reduced-motion: reduce) {
    /* The owned reveal's transition still runs on the beat's own focused
     * trigger; collapse it here so a focused row blinks in place like every
     * other motion under the preference. */
    .options {
      transition: none;
    }
  }
  /* A COLLAPSED BEAT'S OPTIONS NEVER SET ITS HEIGHT.
   *
   * Every grip clears the 24px pointer floor (--hit-min) and must keep
   * clearing it — but a 24px floor stacked under a 22px line is exactly what
   * made a one-line ghost 88px tall: 23px of text in a row whose height was
   * decided by controls the reader could not even see yet. At a collapsed
   * level the row is therefore given ZERO height and shares the content's
   * line. Its children still measure 24×24 and are still 24×24 targets; they
   * simply hang off a zero-height line instead of propping the row open, so
   * the beat's height stays a pure function of its CONTENT. */
  .level-ghost .options,
  .level-tick .options {
    flex-wrap: nowrap;
    height: 0;
    padding-top: 0;
    padding-left: var(--sp-1);
  }
  /* ══ THE BATCH CONTAINER ═════════════════════════════════════════════════
   * Consecutive tool calls read as ONE act of work. The rhythm between them
   * closes up (the beat's own vertical padding goes, so they sit as parts of
   * one thing rather than as neighbours), and the causal spine runs unbroken
   * down the whole batch — which it already did, and now looks like it. The
   * cap is drawn once, by the first member. */
  .beat.in-group {
    padding-top: 0;
    padding-bottom: 0;
  }
  .beat.in-group.group-first { padding-top: var(--beat-pad-y); }
  .beat.in-group.group-last { padding-bottom: var(--beat-pad-y); }
  /* …but a COLLAPSED batch edge costs what a collapsed beat costs. The two
   * rules above give the batch its breathing room against its neighbours at
   * `full`; at a compressed level they were adding a full beat's padding to
   * a one-line row, which put the batch's first and last members 8px over
   * the one-line budget. This never showed while compressed members drew
   * nothing at all — the edges were the only rows left — and surfaced the
   * moment every member started drawing its own line again. Four classes, so
   * it wins over the two rules above without !important. */
  .beat.in-group.group-first.level-ghost,
  .beat.in-group.group-first.level-tick { padding-top: var(--beat-pad-collapsed); }
  .beat.in-group.group-last.level-ghost,
  .beat.in-group.group-last.level-tick { padding-bottom: var(--beat-pad-collapsed); }
  /* The cap is an engraved label, not a heading: it names the batch and its
   * worst outcome and then gets out of the way. */
  .group-cap {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: 0 var(--sp-2) var(--sp-1);
  }
  .group-mark {
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    line-height: var(--lh-tight);
    /* The same outcome hues as everywhere else, read from the owned mapping
     * (`--outcome-ink`, set by the cap's own `data-state` in tokens.css) —
     * a batch that contains a failure wears the failure's colour (see
     * grouping.ts "worst wins"), and no per-state restatement can drift. */
    color: var(--outcome-ink, var(--ink-3));
    flex: none;
  }
  /* The engraved recipe is owned by tokens.css (.cockpit .engraved). */

  /* THE COLLAPSED ROWS. Each is held to its budget from tokens.css and
   * centres its content, so the whole beat costs one line (ghost) or one
   * mark (tick) instead of the 88px the stacked controls used to force. */
  .ghost-row, .tick-row {
    display: flex;
    gap: var(--sp-2);
    align-items: center;
    padding: 0 var(--sp-2);
    min-width: 0;
    overflow: hidden;
  }
  .ghost-row { height: var(--beat-ghost-h); }
  .tick-row { height: var(--beat-tick-h); }
  .ghost-text {
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    line-height: var(--lh-tight);
    color: var(--ink-3);
    /* The two hints are the only elastic parts of the compressed row: they
     * SHRINK and ellipsize so that the fields on either side of them — the
     * tool's name, the measured duration — are never the things pushed off
     * the end of the line. What a narrow window loses is the tail of a
     * summary, not a whole field. */
    min-width: 0;
    flex: 1 1 auto;
  }
  /* A tick's name rides the tick's smaller register — the row is still a
   * mark, it is now a mark that says which call it is. */
  .tick-name {
    font-size: var(--f-nano-size);
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  /* The tool's own name leads the compressed row and never shrinks. */
  .ghost-name {
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    line-height: var(--lh-tight);
    color: var(--ink-2);
    white-space: nowrap;
    flex: none;
  }
  /* The output side of the transformation — quieter than the input, the same
   * relationship the open card's two cells have. The COMPRESSED twin of the
   * open card's result preview, so it carries the same register that field
   * was moved to (ink-3): a summarized OUTPUT is recorded data, and ink-4
   * sat under the 3:1 floor on both themes (UIE-046). */
  .ghost-out {
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    line-height: var(--lh-tight);
    color: var(--ink-3);
    min-width: 0;
    flex: 1 1 auto;
  }
  /* Measured numbers and the attempt count: the micro register the card's
   * head uses for exactly the same fields. */
  .ghost-meta {
    font-family: var(--face-mono);
    font-size: var(--f-micro-size);
    line-height: var(--lh-tight);
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    flex: none;
  }
  /* The collapsed status mark: FORM first (the glyph), then hue — success
   * green, error red, warning yellow, live beam (the user's direct call,
   * recorded in beat-state.ts). Titled, so the word is one hover away without
   * spending a second line on it. The four are ONE affordance in four hues,
   * same glyph size, same weight, same slot; hue is additive, never the only
   * carrier, so a monochrome or colour-blind reader still has the mark and
   * its title. */
  .state-mark {
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    line-height: var(--lh-tight);
    color: var(--ink-3);
    flex: none;
    display: inline-flex;
    align-items: baseline;
    gap: var(--sp-1);
  }
  /* The status WORD beside the glyph — the same affordance the open card's
   * head wears, in the engraved register (owned by tokens.css), so the two
   * read as one instrument reporting at two sizes rather than as two
   * different marks. Its ink stays the outcome's — the mark carries the hue. */
  .state-glyph { line-height: var(--lh-tight); }
  /* The collapsed status mark reads the SAME owned mapping as the gutter
   * glyph — `--outcome-ink` set by the card's `data-state` in tokens.css —
   * so the tick, the ghost and the open card can never disagree about what
   * `warn` looks like, and a grammar re-point lands here for free. */
  .state-mark[data-state] { color: var(--outcome-ink, var(--ink-3)); }
  .tick-mark {
    width: var(--sp-3);
    height: var(--tick-h);
    background: var(--line-2);
    align-self: center;
    flex: none;
  }
  .reason {
    font-family: var(--face-mono);
    font-size: var(--f-micro-size);
    line-height: var(--lh-tight);
    /* The fisheye's explanation is informative text on a compressed row —
     * the same sub-3:1 class the output hints were (UIE-046); it joins the
     * ghost-meta register (same size class, ink-3). */
    color: var(--ink-3);
    flex: none;
  }
</style>
