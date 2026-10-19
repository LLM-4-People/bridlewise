<script lang="ts">
  /**
   * The closed-desk CONTEXT GAUGE (spec §2.3, §8.1 "context at the desk").
   * Mounted by the shell's Desk in the gauge slot (shell/contract.ts).
   *
   * Every number is measured: context tokens + limit come from the last
   * run's `context` SSE event (served by the composing code path: §3.7);
   * tok/s is the live turn's measured rate. Absence renders as absence in
   * plain words ("context not measured yet"): never a placeholder bar.
   */
  import { lastRunContext, isStreaming, messages, contextPctOf } from "../../state/chat-messages.ts";
  // §6.2 honest degradation. The breaker half of this gauge IS asOf-reactive
  // (it comes from `tools.breaker`, a ranged block, through the Broker). The
  // CONTEXT half is not: it comes from the run's `context` SSE event, which
  // is a live signal with no ranged read behind it. Showing the live number
  // under a banner that says `viewing 16:00:53` would be the worst kind of
  // lie: true digits, wrong instant: so it states the limit instead.
  import { isPastView, PAST_VIEW_UNSUPPORTED_SENTENCE } from "../../data/asof.ts";
  import { currentChatId } from "../../state/chats.ts";
  import type { OutletProps } from "../shell/contract.ts";
  import Answer from "../response/Answer.svelte";
  import { openInspectorSection } from "../shell/right-menu.ts";
  import { absent } from "../response/grammar.ts";
  import { becauseChanged, moves, type MovesParam } from "../motion/motion.ts";
  import { confinementEdge, executingToolName, toolsEdgeSummary } from "./desk-data.ts";
  import { breakerLoads, confinementLoad, requestBreaker, requestConfinement } from "./desk-feed.ts";

  let { shell }: OutletProps = $props();
  // Outlet-contract prop; the gauge itself reads only measured stores. The
  // reference lives in a $derived so it is closure-safe (no init capture).
  const hasShell = $derived(shell !== null && shell !== undefined);

  /** True while a head is planted: this gauge is showing a past instant. */
  const past = $derived($isPastView);
  // The context reading is withheld (not zeroed, not frozen) while past: an
  // absence with its reason is honest; a stale number is not.
  const ctx = $derived(past ? null : $lastRunContext);
  // The percentage through the ONE derivation (chat-messages contextPctOf —
  // the same number the ARM context triggers evaluate against).
  const pct = $derived(ctx === null ? null : contextPctOf(ctx));

  /** Live measured tok/s of the current turn (from timing metrics as they
   * commit; while streaming, the last assistant message's tps when known). */
  const liveTps = $derived.by(() => {
    if (!$isStreaming) return null;
    const list = $messages;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const m = list[i]!;
      if (m.role === "assistant") return m.timingMetrics?.tps ?? null;
    }
    return null;
  });

  /** A fill bar clamps at 100%. */
  const PCT_FULL = 100;

  // ── Closed-desk breaker edge (§3.5): `tools 31/34` ONLY when ≠ all-on,
  // plus the live tool chip while a call is genuinely in flight. Dark when
  // normal: an all-on set renders NOTHING here.
  const chatId = $derived($currentChatId);
  $effect(() => {
    const id = chatId;
    if (id !== null) requestBreaker(id);
  });
  const toolsSummary = $derived.by(() => {
    const id = chatId;
    if (id === null) return null;
    const load = $breakerLoads[id];
    if (load === undefined || load.kind !== "measured") return null;
    return toolsEdgeSummary(load.rows);
  });
  /** The tool executing NOW, from the one run stream's store (§3.5). */
  const executing = $derived(executingToolName($messages, $isStreaming));

  /**
   * A spark when the live tool's name ARRIVES or CHANGES. Stillness while
   * the same call runs; `becauseChanged` refuses a re-measurement of the
   * same name. First paint already-executing does not spark (previous is
   * null): the run was already in flight when this gauge mounted.
   */
  let lastExecuting: string | null = null;
  const execMotion = $derived.by((): MovesParam => {
    const next = executing;
    const previous = lastExecuting;
    lastExecuting = next;
    if (previous === next || next === null) return null;
    return {
      motion: "arrive",
      cause: becauseChanged("the tool running now", previous, next),
    };
  });

  // ── Confinement (how much of this computer a command can reach) ──────────
  //
  // ASKED ON MOUNT AND AFTER EVERY RUN, not on a timer. The two moments this
  // can change are an operator editing the harness settings and the guardian
  // being rebuilt, and neither is something the desk can observe: so it
  // re-asks at the boundary the reader actually cares about, which is "before
  // I send the next thing".
  $effect(() => {
    void $isStreaming;
    requestConfinement();
  });
  const confinement = $derived($confinementLoad);
  const confinementState = $derived(
    confinement.kind === "measured" ? confinement.view.state : confinement.kind,
  );
  /** The short words. An unread or unreadable answer says exactly that —
   *  it does not borrow the wording of any of the four measured states. */
  const confinementWords = $derived.by(() => {
    if (confinement.kind === "measured") return confinementEdge(confinement.view);
    if (confinement.kind === "pending") return "Command access: checking";
    return "Command access: unknown";
  });
  const confinementTitle = $derived.by(() => {
    if (confinement.kind === "measured") {
      return `${confinement.view.sentence} ${confinement.view.reason}`;
    }
    if (confinement.kind === "pending") {
      return "Asking the server how much of this computer a command can reach.";
    }
    return `How much of this computer a command can reach could not be read: ${confinement.reason}`;
  });

  function fmt(n: number): string {
    return n.toLocaleString("en-US");
  }
</script>

<div class="gauge" data-outlet={hasShell ? "shell" : "standalone"} data-run={$isStreaming && !past ? "live" : null} title={ctx !== null && ctx.contextTokens !== undefined ? "measured by the composing code path, served with the run's context event" : undefined}>
  {#if ctx !== null && ctx.contextTokens !== undefined}
    <button type="button" class="verb bare context-summary" data-verb-id="composer.context" title="Measured context used by the last request. Open next-turn context controls." onclick={() => openInspectorSection("setup-sec-context")}>
    <span class="row">
      <!-- "context USED", not bare "context": the open desk's header one
           surface up reads "context desk · next turn", and two labels that
           differ only by a word the eye skips were being read as one fact.
           This gauge is the MEASURED use (what the last composed request
           actually held); the desk composes what the NEXT one will. -->
      <span class="engraved">Context used</span>
      <span class="value">{ctx.contextTokenLimit !== undefined ? `${pct}%` : `${fmt(ctx.contextTokens)} tok`}</span>
      {#if $isStreaming && !past}<span class="live" aria-label="run streaming">●</span>{/if}
    </span>
    {#if ctx.contextTokenLimit !== undefined}
      <div class="tick-track" role="img" aria-label="context {pct}% of {fmt(ctx.contextTokenLimit)} tokens">
        <div class="tick-fill" style:width="{Math.min(PCT_FULL, pct ?? 0)}%"></div>
      </div>
      <div class="detail">{fmt(ctx.contextTokens)} / {fmt(ctx.contextTokenLimit)} tok{liveTps !== null ? ` · ${liveTps} tok/s` : ""}</div>
    {/if}
    </button>
  {:else if past}
    <Answer as="inline" answer={absent(`context: ${PAST_VIEW_UNSUPPORTED_SENTENCE}`)} />
  {:else}
    <Answer as="inline" answer={absent("Context not measured yet")} />
  {/if}
  {#if (executing !== null && !past) || toolsSummary !== null}
    <div class="tools-edge">
      {#if executing !== null && !past}
        <span class="live-tool" use:moves={execMotion} title="this tool's call is running now: from the live run stream">● {executing}</span>
      {/if}
      {#if toolsSummary !== null}
        <span class="tools-count" title="tools on / tools available: shown only when not all are on">{toolsSummary}</span>
      {/if}
    </div>
  {/if}
  <!--
    HOW MUCH OF THIS COMPUTER A COMMAND CAN REACH.

    Always rendered: there is no state in which this is dark. The reading
    that matters most is the ORDINARY one ("this whole computer"), and a
    badge that only lights up when something is wrong would leave the
    dangerous case looking exactly like a healthy one. A failed read says so
    in words rather than falling back to the reassuring answer.

    Clicking it opens the desk, which is where the setting that decides it
    lives: the same gesture the grip and the rest of the gauge already
    answer, not a second one to learn.
  -->
  <button
    type="button"
    class="confinement"
    data-verb-id="tools.confinement/why"
    data-confinement={confinementState}
    title={confinementTitle}
    aria-label="How much of this computer a command can reach: {confinementWords}"
    onclick={() => shell?.hint(confinementTitle)}
  >{confinementWords}</button>
</div>

<style>
  .gauge {
    display: flex;
    flex-direction: row;
    flex-wrap: wrap;
    gap: var(--sp-1) var(--sp-3);
    min-width: 0;
    align-items: center;
    justify-content: flex-start;
    overflow-wrap: anywhere;
  }
  .context-summary { flex-wrap: wrap; gap: var(--sp-1) var(--sp-2); }
  .tick-track { display: none; }
  .row {
    display: flex;
    gap: var(--sp-2);
    align-items: baseline;
  }
  .value {
    font-family: var(--face-sans);
    font-size: var(--f-data-size);
    font-variant-numeric: tabular-nums;
    color: var(--ink-1);
  }
  .live {
    color: var(--beam);
    font-size: var(--f-micro-size);
  }
  /* The context tick is component-named (not the generic `bar`/`fill`): the
     composer row in shell/Desk.svelte is also a `.bar`, and Svelte's scoped
     styles only isolate a selector the compiler proves is used: a stale
     dev hot-update can emit one component's rules unscoped, so a shared
     generic name leaks across components and crushes the other surface. */
  .tick-track {
    width: var(--monitor-w);
    height: var(--tick-h);
    background: var(--line-1);
  }
  .tick-fill {
    height: 100%;
    background: var(--ink-2);
    transition:
      width var(--t-2) var(--ease-out),
      background var(--t-2) var(--ease-out);
  }
  /* The monotonically-growing fact of a live run wears the live hue so it
   * is the one mark legible across a room. At rest the fill is ink: calm. */
  .gauge[data-run="live"] .tick-fill {
    background: var(--beam);
  }
  @media (prefers-reduced-motion: reduce) {
    .tick-fill {
      transition: none;
    }
  }
  .detail {
    font-family: var(--face-mono);
    font-size: var(--f-micro-size);
    font-variant-numeric: tabular-nums;
    color: var(--ink-3);
  }
  .tools-edge {
    display: flex;
    gap: var(--sp-2);
    align-items: baseline;
  }
  .live-tool {
    color: var(--beam);
    font-family: var(--face-mono);
    font-size: var(--f-micro-size);
  }
  .tools-count {
    color: var(--warn);
    font-family: var(--face-mono);
    font-size: var(--f-micro-size);
    font-variant-numeric: tabular-nums;
  }
  /* The reading is a control (it teaches its own reason), so it must not
     look like one: no chrome, no box, just the words at the gauge's own
     register. */
  .confinement {
    appearance: none;
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
    /* The pointer floor comes from the token, not from a number restated
       here: a control small enough to miss is a control that does not work,
       and the size that counts as missable is one decision, made once. */
    min-height: var(--hit-min);
    min-width: var(--hit-min);
    display: flex;
    align-items: center;
    justify-content: flex-start;
    text-align: left;
    font-family: var(--face-sans);
    font-size: var(--f-micro-size);
    color: var(--ink-3);
  }
  /* Unconfined is the LOUD state, because it is the one with consequences.
     Confined is quiet: nothing is wrong, and a badge shouting about a
     correct condition trains the eye to ignore the same badge when it
     matters. */
  .confinement[data-confinement="off"] {
    color: var(--warn);
  }
  .confinement[data-confinement="unavailable"],
  .confinement[data-confinement="unknown"],
  .confinement[data-confinement="absent"] {
    color: var(--warn);
  }
</style>
