<script lang="ts">
  /**
   * THE OPEN DESK (§3.4 CONTEXT DESK · §3.5 BREAKER PANEL): the 280px
   * panel above the composer, mounted by the shell through the file
   * convention (shell/contract.ts → `src/cockpit/desk/DeskPanel.svelte`).
   *
   * Left: channel strips: one per context source of the NEXT turn, from
   * the `run.compose` read (served by the same assembly the run executes;
   * every bar/token count is that read's measured number). Bottom line:
   * NEXT TURN total/limit + the model selector (§3.4: models the server
   * actually serves, selection through the existing client path).
   *
   * Right: breaker rows: one per available tool, from the `tools.breaker`
   * read (state from the per-user override rows the safety gate consults;
   * counts folded from the ledger). Flips land at the next tool decision.
   *
   * A read that fails renders the column's honest absence: the desk shows
   * nothing rather than guessing. Nothing here polls: reads happen on
   * mount/chat-change, after acts (read-back), at the run boundary, and on
   * invalidation events (desk-feed owns all of it).
   */
  // §6.2: choosing the next turn's model is a write, refused from a past view.
  // `isPastView` disables the control BEFORE the click; `assertLiveForWrite`
  // is the guarantee ON the path (see `onModelChange`).
  import {
    assertLiveForWrite,
    isPastView,
    PAST_VIEW_ACT_REASON,
  } from "../../data/asof.ts";
  import { getContext, onMount, tick } from "svelte";

  import { getModels, setChatModel } from "../../client.ts";
  import { currentChat, currentChatId } from "../../state/chats.ts";
  import { isStreaming, messages } from "../../state/chat-messages.ts";
  import { allModels, modelsCatalog } from "../../state/models.ts";
  import { SHELL_CONTEXT_KEY, type ShellApi } from "../shell/contract.ts";
  import Disclosure from "../shell/Disclosure.svelte";
  import { INSPECTOR_SECTIONS } from "../../../shared/routes.ts";
  import { closeRightMenu } from "../shell/right-menu.ts";
  import Answer from "../response/Answer.svelte";
  import { absent, failed, pending } from "../response/grammar.ts";
  import { chordLabel } from "../shell/chords.ts";
  import {
    executingToolName,
    fmtPercent,
    fmtTokens,
    stripsFrom,
    toolsEdgeSummary,
    trimNumbering,
  } from "./desk-data.ts";
  import {
    breakerLoads,
    breakerProvKey,
    composeLoads,
    composeProvKey,
    requestDesk,
  } from "./desk-feed.ts";
  import { breakerRowFocus } from "./desk-bus.ts";
  import ChannelStrip from "./ChannelStrip.svelte";
  import BreakerRow from "./BreakerRow.svelte";

  let { shell = getContext<ShellApi>(SHELL_CONTEXT_KEY) }: { shell?: ShellApi } = $props();

  const kSwitch = chordLabel({ key: "j", primary: true });

  const chatId = $derived($currentChatId);

  // ── Loads (desk-feed owns the machine; this component only renders) ─────
  $effect(() => {
    const id = chatId;
    if (id !== null) requestDesk(id);
  });

  const composeLoad = $derived(chatId !== null ? ($composeLoads[chatId] ?? null) : null);
  const breakerLoad = $derived(chatId !== null ? ($breakerLoads[chatId] ?? null) : null);

  const strips = $derived(
    composeLoad !== null && composeLoad.kind === "measured"
      ? stripsFrom(composeLoad.view)
      : null,
  );
  const numbering = $derived(
    composeLoad !== null && composeLoad.kind === "measured"
      ? trimNumbering(composeLoad.view)
      : null,
  );
  const contextOverridden = $derived(composeLoad?.kind === "measured" && (
    composeLoad.view.settings.mutedChannels.length > 0 || composeLoad.view.settings.mutedMemoryIds.length > 0 ||
    composeLoad.view.settings.pinnedMemoryIds.length > 0 || (composeLoad.view.settings.trimBeforeTurn ?? 1) > 1
  ));

  /** The §3.5 closed-desk summary spelled here too: the panel header names
   * the same measured fact when ≠ all-on. */
  const edgeSummary = $derived(
    breakerLoad !== null && breakerLoad.kind === "measured"
      ? toolsEdgeSummary(breakerLoad.rows)
      : null,
  );

  /** The tool genuinely executing NOW: from the one run stream's store
   * (the flow ingests the same events; no second stream, no timer). */
  const executing = $derived(executingToolName($messages, $isStreaming));

  // ── Model selector (§3.4 bottom line) ───────────────────────────────────
  let modelNote = $state<string | null>(null);
  let modelPending = $state(false);
  $effect(() => { void chatId; modelNote = null; });
  /** The `<select>` itself: needed to put the control back on the recorded
   * model when a write is refused (see `onModelChange`). */
  let modelSelectEl = $state<HTMLSelectElement | null>(null);

  onMount(() => {
    // The catalog is server-served; the cockpit boot does not fetch it, so
    // the desk (its one consumer) does: through the existing client path.
    if ($modelsCatalog === null) {
      void getModels().catch(() => {
        modelNote = "models not readable right now";
      });
    }
  });

  /**
   * WHAT THIS CONVERSATION'S NEXT TURN WILL ACTUALLY RUN ON: from the two
   * places that decide it, in the server's own precedence, and from nowhere
   * else.
   *
   * It used to read `$currentChat?.modelId ?? $currentModelId ?? ""`, and
   * `currentModelId` resolves through `selectedModelId`: a GLOBAL atom that
   * is not chat-scoped. Pick a model in conversation A (the atom is written)
   * and open conversation B, which never chose one: B's record says null, the
   * fallback reached past the catalog default into A's leftover selection, and
   * the picker named a model B's next turn was never going to use. That is the
   * same lie as the defect above, one surface earlier: the control claiming
   * an effect it does not have: so the global atom is off this path entirely.
   *
   * The chain now mirrors `server/routes/run.ts::resolveRunModelId` exactly:
   * the chat's recorded model, else the default the user SAVED. There is no
   * third step any more: the server-wide default model the bridge used to
   * fall through to is deleted, so if neither of those two answers, nothing
   * does and the desk says so rather than naming a model that was never
   * chosen.
   *
   * When neither exists the value is "" and the placeholder option below is
   * what shows: never the first model in the list, which is what a bare
   * `<select>` with an unmatched value would silently display.
   */
  const selectedModel = $derived($currentChat?.modelId ?? $modelsCatalog?.defaultModel ?? "");

  /** True when nothing has been chosen for this chat AND the served catalog
   * names no default: the one case where the desk cannot say what will run. */
  const modelUnnamed = $derived(selectedModel.length === 0);

  async function onModelChange(ev: Event): Promise<void> {
    const id = (ev.currentTarget as HTMLSelectElement).value;
    const chat = chatId;
    if (id.length === 0 || chat === null || modelPending) return;
    modelPending = true;
    modelNote = null;
    try {
      // A PAST VIEW IS READ-ONLY (§6.2), and this write does NOT pass the
      // Broker's door: `setChatModel` is a client.ts call, so `broker.action`
      //: which is where `assertLiveForWrite` normally runs: is not on this
      // path at all. Choosing a model from a view of 10:14:21 would have
      // changed which model the LIVE next turn runs. The assertion is applied
      // here, at this call's own door, so the guarantee does not depend on the
      // `disabled` attribute below (which is the courtesy, not the promise).
      //
      // WHY IT STAYS DIRECT rather than moving to `broker.action`: no
      // registered block declares a per-chat model action. The mounted
      // actions are `tools.breaker/set`, `arm.flags/set`, `custody.state/keep`
      // and `/undo`, `settings.customizations/set`, `checks.auto/run` and the
      // compose verbs: none of them owns the chat's model. Routing this
      // through the Broker would mean declaring a new server action, which is
      // a server change, not a write-door fix.
      assertLiveForWrite();
      // NOTHING IS PAINTED OPTIMISTICALLY HERE, deliberately. The previous
      // revision called `selectModel(id)` before awaiting the write: its own
      // comment said "painting the chosen model and then failing the write
      // would leave the desk showing a model this conversation is not going to
      // use", and then did exactly that, into a global atom the run route
      // never reads. The write below updates the chat record (and, through
      // `updateChatInStore`, `$currentChat.modelId`), so the picker repaints
      // from the ONE fact that decides the run. A failed write therefore snaps
      // the control back to the model that is really recorded, which is the
      // honest outcome: the refusal is spelled in `modelNote` beside it.
      await setChatModel(chat, id);
    } catch (err) {
      if (chat !== chatId) return;
      modelNote = err instanceof Error ? err.message : String(err);
      // AND THE CONTROL GOES BACK TO THE TRUTH. A refused write leaves
      // `selectedModel` unchanged, so Svelte's `value={…}` has nothing to
      // re-apply and the browser would keep showing the option the user
      // clicked: the picker naming a model this conversation is not going to
      // use, which is the whole defect. The element is reset by hand because
      // the DOM, not the state, is what drifted.
      if (modelSelectEl !== null) modelSelectEl.value = selectedModel;
    } finally {
      modelPending = false;
    }
  }

  // ── Row jump (the tool beat's `breaker` verb: desk-bus) ────────────────
  let panelEl = $state<HTMLElement | null>(null);
  let highlightTool = $state<string | null>(null);
  let jumpNote = $state<string | null>(null);
  let seenFocusSeq = 0;

  $effect(() => {
    const req = $breakerRowFocus;
    if (req === null || req.seq === seenFocusSeq) return;
    // Wait for the rows to be in the DOM (the desk may just have opened).
    const rows = breakerLoad;
    if (rows === null || rows.kind !== "measured") return;
    seenFocusSeq = req.seq;
    jumpNote = null;
    void tick().then(() => {
    if ($breakerRowFocus?.seq !== req.seq || !panelEl?.isConnected) return;
    const el = panelEl?.querySelector<HTMLElement>(
      `[data-tool="${CSS.escape(req.tool)}"]`,
    );
    if (el === undefined || el === null) {
      jumpNote = `no breaker row for "${req.tool}": the tool is not in this install's manifest`;
      return;
    }
    highlightTool = req.tool;
    el.scrollIntoView({ block: "nearest" });
    el.focus();
    });
  });

  function clearHighlight(ev: FocusEvent): void {
    // The jump highlight lives exactly as long as the row keeps focus: a
    // user gesture placed it, the user leaving takes it away.
    const next = ev.relatedTarget;
    if (highlightTool === null) return;
    if (next instanceof Node && panelEl?.contains(next) === true) {
      const still = (next as HTMLElement).closest?.(`[data-tool="${CSS.escape(highlightTool)}"]`);
      if (still !== null && still !== undefined) return;
    }
    highlightTool = null;
  }

  /** True while the cockpit is showing a past instant: no writes possible. */
  const past = $derived($isPastView);
</script>

<div class="desk-panel" bind:this={panelEl}>
  <Disclosure id="setup-sec-model" {...INSPECTOR_SECTIONS["setup-sec-model"]} defaultOpen={true}>
    {#if chatId !== null}
      <div class="next-turn model-line">
        {#if $allModels.length > 0}
          <select
            id="desk-model"
            bind:this={modelSelectEl}
            class="model-select field"
            data-verb-id="chats.model/set"
            value={selectedModel}
            onchange={onModelChange}
            disabled={past || modelPending}
            aria-busy={modelPending}
            title={past ? PAST_VIEW_ACT_REASON : undefined}
            aria-label="model for this conversation's next turn"
          >
            <!-- A `<select>` whose value matches no option shows its FIRST
                 option, so the absence case would read as "glm-5.2": a model
                 nobody chose, named as though someone had. The placeholder is
                 that unmatched value's own option, and it says so. -->
            {#if modelUnnamed}
              <option value="" disabled>not chosen: and you have saved no default</option>
            {/if}
            {#each $allModels as m (m.id)}
              <option value={m.id}>{m.id}</option>
            {/each}
          </select>
        {:else if $modelsCatalog?.setupRequired === true}
          <!-- AN EMPTY PICKER IS NOT A LOADING PICKER. This branch used to
               read "reading the served models…" for both, so a user who had
               configured nothing watched a message that said it was working
               on it: forever. The catalog states which of the two it is, so
               the desk can say the true one and name the way out. -->
          <Answer as="inline" answer={absent("Connect a provider to choose your next model.")} />
        {:else}
          {#if modelNote !== null}<Answer as="inline" answer={failed(modelNote)} />{:else}<Answer as="inline" answer={pending("reading the served models")} />{/if}
        {/if}
        {#if modelNote !== null && $allModels.length > 0}
          <span class="note fail">{modelNote}</span>
        {/if}
      </div>
    {/if}
    <div class="model-details">
    {#if $allModels.length > 0}<p class="model-scope">{$currentChat?.modelId ? "Chosen for this conversation" : $modelsCatalog?.defaultModel ? "Using your account default" : "Choose a model for the next turn"}</p>{/if}
    <button type="button" class="verb" class:primary={$modelsCatalog?.setupRequired === true} data-verb-id="setup.providers" title="Manage provider connections, models and your account default" onclick={() => { shell.openRoom("settings"); closeRightMenu(); }}>{$modelsCatalog?.setupRequired === true ? "Connect a provider" : "Manage models & providers"}</button>
    </div>
  </Disclosure>
  <!-- ── CONTEXT DESK (§3.4) ─────────────────────────────────────────── -->
  <Disclosure id="setup-sec-context" {...INSPECTOR_SECTIONS["setup-sec-context"]} defaultOpen={true}>
    {#if chatId === null}
      <Answer answer={absent(`no conversation open: the desk mixes a conversation's next turn (${kSwitch} opens one)`)} />
    {:else if composeLoad === null || composeLoad.kind === "pending"}
      <Answer answer={pending("measuring the next turn's composition")} />
    {:else if composeLoad.kind === "absent"}
      <Answer answer={failed(`composition not measurable right now (${composeLoad.reason}): the desk shows nothing rather than guessing`)} />
    {:else if strips !== null}
      <!-- LENS: every bar, token count, item and the trim handle below come
           from THIS read. One stamp on the region, resolved up the ancestor
           chain: never one per value. -->
      <div class="composition-summary">
      <div class="next-turn">
        <span class="cap cap-word">Next turn</span>
        <span class="total" data-prov={composeProvKey(chatId)}>
          {fmtTokens(composeLoad.view.total)} / {fmtTokens(composeLoad.view.limit)} tok
          · {fmtPercent(composeLoad.view.total / composeLoad.view.limit)}
        </span>
      </div>
      {#if contextOverridden}<p class="composition-state overridden">
          {composeLoad.view.settings.pinnedMemoryIds.length} pinned · {composeLoad.view.settings.mutedChannels.length + composeLoad.view.settings.mutedMemoryIds.length} muted · history from turn {composeLoad.view.settings.trimBeforeTurn ?? 1}
      </p>{/if}
      </div>
      <div class="strip-list" data-prov={composeProvKey(chatId)}>
        {#each strips as strip (strip.channel.id)}
          <ChannelStrip
            {shell}
            {chatId}
            {strip}
            settings={composeLoad.view.settings}
            asOf={composeLoad.asOf}
            numbering={strip.channel.id === "history" ? numbering : null}
          />
        {/each}
      </div>

    {/if}

    <!-- THE MODEL LINE IS ITS OWN ROW, OUTSIDE THE COMPOSE BRANCHES.
         It used to sit inside the measured branch above, beside the total:
         which meant a `run.compose` read that was pending, absent or simply
         slow removed the model CONTROL from the desk entirely. The two facts
         have different sources (the total is the compose read's arithmetic;
         the model comes from the served catalog and the chat record), so one
         read's failure must not take the other's control away: a user cannot
         be told "composition not measurable right now" and thereby lose the
         ability to choose what the next turn runs on. The provenance stamp
         stays on the total, where the compose read actually owns the number.

         It still requires a conversation: the model is a per-chat fact and
         there is nothing to write it to otherwise. -->

  </Disclosure>

  <!-- ── BREAKER PANEL (§3.5) ────────────────────────────────────────── -->
  <Disclosure id="setup-sec-tools" {...INSPECTOR_SECTIONS["setup-sec-tools"]} defaultOpen={true}>
    <div class="breakers" onfocusoutcapture={clearHighlight}>
    {#if edgeSummary !== null}<p class="override-summary">{edgeSummary}</p>{/if}
    {#if chatId === null}
      <Answer answer={absent("no conversation open: breakers scope to a conversation's runs")} />
    {:else if breakerLoad === null || breakerLoad.kind === "pending"}
      <Answer answer={pending("reading the tools' recorded state")} />
    {:else if breakerLoad.kind === "absent"}
      <Answer answer={failed(`tools not readable right now (${breakerLoad.reason}): nothing is shown rather than guessed`)} />
    {:else}
      {#if jumpNote !== null}
        <p class="note fail">{jumpNote}</p>
      {/if}
      <p class="consequence">Select a tool name for its description and auto-trip settings. Availability changes at the next tool decision.</p>
      <div class="breaker-list" data-prov={breakerProvKey(chatId)}>
        {#each breakerLoad.rows as row (row.id)}
          <BreakerRow
            {shell}
            {chatId}
            {row}
            executing={executing === row.id}
            highlight={highlightTool === row.id}
          />
        {/each}
        {#if breakerLoad.rows.length === 0}
          <Answer answer={absent("no tools are available to this account")} />
        {/if}
      </div>
      <p class="consequence">A running call finishes. Keyboard: press comma on a tool row for auto-trip.</p>
    {/if}
    </div>
  </Disclosure>
</div>

<style>
  .desk-panel { display: flex; flex-direction: column; min-width: 0; gap: var(--sp-4); }
  .model-scope, .consequence { margin: 0; color: var(--ink-3); font-size: var(--f-data-size); }
  .strip-list, .breaker-list, .breakers { display: flex; flex-direction: column; min-width: 0; }
  .next-turn { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); padding: var(--sp-2) 0; }
  .model-line { padding: var(--sp-2) 0 0; }
  .model-details { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-2); }
  .composition-summary { padding: var(--sp-2) var(--sp-3); background: var(--accent-soft); border-bottom: var(--hairline-w) solid var(--accent); }
  .composition-state { padding-bottom: var(--sp-2); }
  .next-turn .cap { width: auto; padding: 0; }
  .total { font-family: var(--face-sans); font-variant-numeric: tabular-nums; color: var(--accent); font-size: var(--f-ui-size); font-weight: var(--f-micro-weight); }
  .model-select { width: 100%; min-width: var(--hit-min); min-height: var(--hit-min); padding: var(--sp-2); border: var(--hairline-w) solid var(--line-2); border-radius: var(--radius-2); background: var(--ground-2); color: var(--ink-1); font: var(--f-ui-size) var(--face-sans); }
  .note { font-size: var(--f-data-size); }
  .note.fail { color: var(--alarm); }
  .override-summary { color: var(--warn); }
  .composition-state { margin: 0; font: var(--f-data-size) var(--face-sans); color: var(--ink-2); }
  .composition-state.overridden { color: var(--warn); }
</style>
