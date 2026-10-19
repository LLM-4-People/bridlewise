<script lang="ts">
  import { INSPECTOR_SECTIONS } from "../../../shared/routes.ts";
  /**
   * THE ARM MENU BODY — the arm group's content, host-free (§6.4).
   *
   * ONE BODY, TWO HOSTS (the desk/ChannelScope.svelte shape): the standalone
   * sweep mounts this body inside the shared Popover (ArmMenu.svelte — the
   * harness mounts, where the arm menu is a raised surface over the band),
   * and the shell's right-menu host (shell/RightMenuHost.svelte) mounts the
   * SAME body as the single menu's arm group. Nothing here knows which: the
   * surface chrome (cap, close verb, Esc, outside-press) is the HOST's job,
   * and this file owns only the arm grammar itself.
   *
   * TWO LAYERS OF PREDICATE (the Grafana "default options / advanced
   * options" reading — research/round74-arm-depth/): the four fixed quick
   * rows stay ONE click away (the common cases), and THE PALETTE opens the
   * grammar's real space — the ready composed shapes, the operators named
   * by what they mean, every field the server's own vocabulary declares
   * (insert buttons for the custom entry), and the free-text expression
   * validated by the SERVER at the arm door (its refusal surfaces
   * verbatim; deny-by-default, never a local copy of a refused predicate).
   *
   * THE SECTIONS ARE DISCLOSURES (shell/Disclosure.svelte): the same
   * instrument in both hosts, each section a real button carrying
   * `aria-expanded` + `aria-controls` with a FIXED label and a count that
   * stays visible when collapsed.
   *
   * STORAGE HONESTY (§6.6): set/capture/clear go through `broker.action`
   * against the LIVE `arm.flags` block (arm-sync.ts). Each row states where
   * it lives — "on the record" or "this browser only" — and each palette
   * row states its EVALUATION truth (what evaluates client-side today, what
   * waits on a feed). Firing is ALWAYS client-evaluated (the server says
   * `serverSideFiring: false`), and "context crosses N%" evaluates when a
   * run reports its context — the compose refresh, not per token; the row
   * says so.
   *
   * THE FIRING'S VERBS (oscilloscope semantics): a fired row carries GO
   * (the band seam — plant the head at the firing instant, the same verb a
   * capture row's label runs) and RE-ARM (single-shot per arming; the way
   * back to watching is explicit and manual). The finding the firing docks
   * carries the same two verbs (arm-fire.ts).
   *
   * THE SCOPE CHOICE (the chatId the wire already carries, surfaced): arms
   * and captures record under "this chat" (default — the band the reader
   * arms from is per-chat) or "all my chats" (the wide net), and every
   * cocked row names its scope so the row itself answers "where does this
   * watch?".
   *
   * THE CAPTURES GROUP (UIE-057): a capture is a BOOKMARK the record holds,
   * so the surface that makes one also LISTS them and clears them through
   * the same block's clear verb. A capture's LABEL is its way BACK: the
   * live-word click plants the band's head at the stretch's start.
   */
  import { untrack } from "svelte";
  import { activeWorkspaceId } from "../../state/workspaces.ts";
  import { inspectorDraft, noteInspectorDraft } from "../shell/workspace-view.ts";
  import { becauseArrived, moves, type MovesParam } from "../motion/motion.ts";
  import { RUN_PANE_PAGE_SIZE } from "../flow/flow-config.ts";
  import { armedTriggers, cockedTriggerCount, reArmTrigger } from "./sweep-store";
  import { armCaptureWindow } from "./sweep-store";
  // §6.2: arming, capturing and clearing all WRITE, so none of them is
  // available from a past view. The reason travels on each control.
  import { currentChatId } from "../../state/chats.ts";
  import { asOfHead, isPastView, PAST_VIEW_ACT_REASON } from "../../data/asof.ts";
  import {
    armTriggerSynced,
    armPredicateFor,
    captureRangeSynced,
    capturedRanges,
    capturedRangesFailure,
    capturedRangesState,
    clearAllCapturedRangesSynced,
    clearArmSynced,
    clearCapturedRangeSynced,
    refreshCapturedRanges,
    type ArmFlagWire,
    type ArmScope,
  } from "./arm-sync";
  import {
    ARM_PREDICATE_LABELS,
    LOCAL_STORAGE_NOTE,
    marksStorageDegraded,
    type ArmPredicateKind,
  } from "./marks";
  import {
    armPaletteFieldGroups,
    armPaletteOperators,
    armPaletteRows,
  } from "./arm-palette";
  import { armTriggerLabel, announceArmCapture } from "./arm-fire";
  import { formatClock } from "./now-edge";
  import Disclosure from "../shell/Disclosure.svelte";
  // The capture row's way BACK to the band — the one-shot seam the sweep
  // consumes with its own `setHead`, so a visited capture and a clicked
  // mark cannot behave differently.
  import { requestBandGo } from "./band-request";

  let condition = $state("tool-errors");
  let busy = $state(false);
  let feedbackEvent = $state<{ id: string; signal: string } | null>(null);
  let shownFeedback: typeof feedbackEvent = null;
  const feedbackMotion = $derived.by((): MovesParam => {
    const event = feedbackEvent;
    const visible = lastNote.length > 0;
    if (!visible || event === null || event === shownFeedback) return null;
    shownFeedback = event;
    return { motion: "spark", cause: becauseArrived(event.id, event.signal) };
  });
  let capturePage = $state(0);
  let triggerPage = $state(0);
  let filePath = $state("");
  let contextPct = $state("80");
  let captureLabel = $state("");
  /** The last action's honest outcome sentence, shown in the menu. */
  let lastNote = $state("");
  /** The record scope new arms and captures record under. */
  let scope: ArmScope = $state("chat");
  /** The custom when-eval expression being composed. */
  let customExpr = $state("");
  /** The typed values of the palette's parametrized rows, by row id. */
  let paletteParams = $state<Record<string, string>>({});
  $effect(() => {
    void $activeWorkspaceId;
    untrack(() => {
      let draft: Record<string, unknown> = {};
      const held = inspectorDraft("watch-builder");
      if (held !== undefined) {
        try { const value: unknown = JSON.parse(held); if (value !== null && typeof value === "object" && !Array.isArray(value)) draft = value as Record<string, unknown>; }
        catch { lastNote = "The saved watch draft could not be read. Start a new draft."; }
      }
      condition = typeof draft.condition === "string" && ((draft.condition !== "custom" && Object.hasOwn(ARM_PREDICATE_LABELS, draft.condition)) || paletteRows.some(row => row.id === draft.condition)) ? draft.condition : "tool-errors";
      filePath = typeof draft.filePath === "string" ? draft.filePath : "";
      contextPct = typeof draft.contextPct === "string" ? draft.contextPct : "80";
      captureLabel = typeof draft.captureLabel === "string" ? draft.captureLabel : "";
      customExpr = typeof draft.customExpr === "string" ? draft.customExpr : "";
      scope = draft.scope === "all" ? "all" : "chat";
      paletteParams = {};
      if (draft.paletteParams !== null && typeof draft.paletteParams === "object") {
        for (const row of paletteRows) { const value = (draft.paletteParams as Record<string, unknown>)[row.id]; if (typeof value === "string") paletteParams[row.id] = value; }
      }
      capturePage = typeof draft.capturePage === "number" && Number.isSafeInteger(draft.capturePage) && draft.capturePage >= 0 ? draft.capturePage : 0;
      triggerPage = typeof draft.triggerPage === "number" && Number.isSafeInteger(draft.triggerPage) && draft.triggerPage >= 0 ? draft.triggerPage : 0;
    });
  });
  $effect(() => {
    noteInspectorDraft("watch-builder", JSON.stringify({ condition, filePath, contextPct, captureLabel, customExpr, scope, paletteParams, capturePage, triggerPage }));
  });
  /** True while a head is planted — the menu is read-only. */
  const past = $derived($isPastView);
  /** The band's span, from the store mirror (see the header). Null = the
   * host opened with no band mounted: nothing recorded, nothing to capture,
   * and the row says so. */
  const captureWindow = $derived($armCaptureWindow);
  const paletteRows = $derived(armPaletteRows());
  const paletteGroups = $derived(armPaletteFieldGroups());
  const paletteOperators = $derived(armPaletteOperators());

  const selectedRow = $derived(paletteRows.find((row) => row.id === condition));
  const preview = $derived.by(() => {
    if (selectedRow !== undefined) return selectedRow.build(paletteParams[selectedRow.id] ?? null);
    const mapped = armPredicateFor(condition as ArmPredicateKind,
      condition === "context-crosses" ? contextPct : condition === "file-edited" ? filePath : null);
    return mapped.expressible ? { predicate: mapped.predicate } : { needs: mapped.reason };
  });
  const visibleCaptures = $derived($capturedRanges.slice(capturePage * RUN_PANE_PAGE_SIZE, (capturePage + 1) * RUN_PANE_PAGE_SIZE));
  const visibleTriggers = $derived($armedTriggers.slice(triggerPage * RUN_PANE_PAGE_SIZE, (triggerPage + 1) * RUN_PANE_PAGE_SIZE));
  $effect(() => {
    const captureLast = Math.max(0, Math.ceil($capturedRanges.length / RUN_PANE_PAGE_SIZE) - 1);
    const triggerLast = Math.max(0, Math.ceil($armedTriggers.length / RUN_PANE_PAGE_SIZE) - 1);
    untrack(() => {
      capturePage = Math.min(capturePage, captureLast);
      triggerPage = Math.min(triggerPage, triggerLast);
    });
  });
  function completed(id: string, signal: string): void {
    feedbackEvent = { id, signal };
  }
  async function armSelected(): Promise<void> {
    if (selectedRow !== undefined) await armFromRow(selectedRow);
    else await arm(condition as ArmPredicateKind);
  }

  async function arm(kind: ArmPredicateKind): Promise<void> {
    if (busy || past) return;
    const param =
      kind === "file-edited"
        ? filePath.trim()
        : kind === "context-crosses"
          ? contextPct.trim()
          : kind === "custom"
            ? customExpr.trim()
            : null;
    if (kind === "file-edited" && (param === null || param.length === 0)) {
      lastNote = "not armed — name a path fragment first";
      return;
    }
    busy = true;
    lastNote = "Setting your watch…";
    try {
      const result = await armTriggerSynced(kind, param, scope);
      lastNote = result.note;
      if (result.trigger !== null) {
        completed(result.trigger.id, "your watch was armed");
        if (kind === "custom") customExpr = "";
      }
    } finally { busy = false; }
  }

  /** Arm one of the palette's ready rows — a composed grammar expression
   * through the same custom door (the server validates; the record holds). */
  async function armFromRow(
    row: ReturnType<typeof armPaletteRows>[number],
  ): Promise<void> {
    if (busy || past) return;
    const built = row.build(paletteParams[row.id] ?? null);
    if (!("predicate" in built)) {
      lastNote = `not armed — ${built.needs}`;
      return;
    }
    busy = true;
    lastNote = "Setting your watch…";
    try {
      const result = await armTriggerSynced("custom", built.predicate, scope);
      lastNote = result.note;
      if (result.trigger !== null) {
        completed(result.trigger.id, "your watch was armed");
        paletteParams[row.id] = "";
      }
    } finally { busy = false; }
  }

  /** Append a vocabulary field or an operator token to the custom entry. */
  function insertToken(token: string): void {
    const base = customExpr.trim().length === 0 ? "" : `${customExpr.trimEnd()} `;
    customExpr = `${base}${token} `;
  }

  async function clear(id: string): Promise<void> {
    const t = $armedTriggers.find((x) => x.id === id);
    if (t === undefined) return;
    const result = await clearArmSynced(t);
    lastNote = result.note;
  }

  /** The fired row's re-arm — explicit, manual (oscilloscope semantics). */
  function reArm(id: string): void {
    const t = reArmTrigger(id);
    if (t !== null) {
      lastNote = `re-armed: ${armTriggerLabel(t)} — waiting again`;
    }
  }

  async function capture(): Promise<void> {
    if (busy || past) return;
    if (captureWindow === null) {
      lastNote = "nothing on the band to capture yet";
      return;
    }
    busy = true;
    lastNote = "Saving your capture…";
    try {
    const result = await captureRangeSynced(
      captureWindow.t0,
      captureWindow.t1,
      captureLabel,
      scope,
    );
    lastNote = result.note;
    if (result.saved) {
      captureLabel = "";
      // The new bookmark lists below — a capture that does not APPEAR in
      // its own list would be the one-way door again.
      completed(result.flag!.id, "your capture was saved");
      await refreshCapturedRanges();
    }
    } finally { busy = false; }
  }

  /** Clear ONE captured range (the record's authority, via arm-sync). */
  async function clearCapture(flag: ArmFlagWire): Promise<void> {
    lastNote = (await clearCapturedRangeSynced(flag)).note;
  }

  /** Clear EVERY listed capture. */
  async function clearAllCaptures(): Promise<void> {
    lastNote = (await clearAllCapturedRangesSynced()).note;
  }

  // List the record's captures whenever the body mounts — mounting IS the
  // opening, in both hosts (the Popover mounts this body only while open;
  // the right-menu host mounts it only while the arm group is open). The
  // read carries the ambient head (arm.flags is ranged), so a past view
  // lists them as of that instant; only the WRITE verbs refuse there.
  $effect(() => {
    void $currentChatId;
    void $asOfHead;
    untrack(() => void refreshCapturedRanges());
  });
</script>

{#if past}
  <p class="note outcome" role="status">{PAST_VIEW_ACT_REASON}</p>
{/if}

<p class="note">Watches react while this browser receives events.</p>
{#if lastNote.length > 0}
<div class="feedback" role="status" aria-live="polite">
  <span class="feedback-spark" aria-hidden="true" use:moves={feedbackMotion}>✦</span>
  <span>{lastNote}</span>
</div>
{/if}
<fieldset class="scope">
  <legend class="note">Apply to</legend>
  <label class="pred scope-opt"><input type="radio" name="arm-scope" value="chat" bind:group={scope} disabled={past || busy} />This conversation</label>
  <label class="pred scope-opt"><input type="radio" name="arm-scope" value="all" bind:group={scope} disabled={past || busy} />All my conversations</label>
</fieldset>
<Disclosure id="arm-sec-fire-when" label={INSPECTOR_SECTIONS["arm-sec-fire-when"].label} keywords={INSPECTOR_SECTIONS["arm-sec-fire-when"].keywords} defaultOpen={true}>
  <div class="quick-watches">
    <button type="button" class="verb quick-watch" data-action="arm.flags/set" disabled={past || busy} title="Watch for any tool error" onclick={() => void arm("tool-errors")}>Tool fails <span aria-hidden="true">↗</span></button>
    <button type="button" class="verb quick-watch" data-action="arm.flags/set" disabled={past || busy} title="Watch for a failing check" onclick={() => void arm("check-fails")}>Check fails <span aria-hidden="true">↗</span></button>
  </div>
  <label class="builder-label" for="watch-condition">When this happens</label>
  <select id="watch-condition" class="param condition" bind:value={condition} disabled={past || busy}>
    <option value="tool-errors">A tool fails</option>
    <option value="check-fails">A check fails</option>
    <option value="context-crosses">Context reaches a threshold</option>
    <option value="file-edited">A matching file changes</option>
    {#each paletteRows as row (row.id)}<option value={row.id}>{row.label}</option>{/each}
  </select>
  {#if condition === "context-crosses"}
    <label class="builder-label" for="context-threshold">Context threshold (%)</label>
    <input id="context-threshold" class="param" type="text" inputmode="numeric" bind:value={contextPct} name="context-percent-threshold" aria-label="context percent threshold" />
    <p class="note">Checked when the run reports context usage.</p>
  {:else if condition === "file-edited"}
    <label class="builder-label" for="watch-path">Path contains</label>
    <input id="watch-path" class="param" type="text" placeholder="src/auth/" bind:value={filePath} name="file-path-fragment" aria-label="file path fragment" />
    <p class="note">This path match is stored in this browser only.</p>
  {:else if selectedRow?.paramPlaceholder != null}
    <label class="builder-label" for="watch-parameter">{selectedRow.paramPlaceholder}</label>
    <input id="watch-parameter" class="param" type="text" placeholder={selectedRow.paramPlaceholder} bind:value={paletteParams[selectedRow.id]} name="palette-param-{selectedRow.id}" aria-label="{selectedRow.label} — {selectedRow.paramPlaceholder}" />
  {/if}
  {#if selectedRow !== undefined}<p class="note">{selectedRow.evaluation}</p>{/if}
  <div class="condition-preview"><span class="note">Condition preview</span><code>{"predicate" in preview ? preview.predicate : preview.needs}</code></div>
  <button type="button" class="verb primary" data-action="arm.flags/set" disabled={past || busy} title={past ? PAST_VIEW_ACT_REASON : "Save this condition and start watching"} onclick={() => void armSelected()}>{busy ? "Working…" : "Start watching"}</button>
</Disclosure>
<Disclosure id="arm-sec-palette" label={INSPECTOR_SECTIONS["arm-sec-palette"].label} keywords={INSPECTOR_SECTIONS["arm-sec-palette"].keywords} defaultOpen={false}>
  <!-- THE CUSTOM WHEN-EVAL ENTRY: a free-text expression, submitted through
       the same arm door — the SERVER validates it, and its refusal sentence
       surfaces verbatim (deny-by-default; a refused predicate is never
       armed anywhere). -->
  <div class="row">
    <input class="param expr" type="text"
      placeholder="a when-eval expression, e.g. event.type == 'run'"
      bind:value={customExpr} name="arm-custom-expression"
      aria-label="a custom when-eval expression" />
    <button type="button" class="verb " data-action="arm.flags/set"
      disabled={past} title={past ? PAST_VIEW_ACT_REASON : undefined}
      onclick={() => void arm("custom")}>Arm</button>
  </div>
  <p class="note under">validated by the record when armed — its refusal answers here verbatim</p>

  <!-- THE OPERATORS — the grammar's own tokens (from the parser that
       accepts them), each named by what it means. -->
  <div class="row wrap">
    <span class="note">operators</span>
    {#each paletteOperators as op (op.token)}
      <button type="button" class="menu-chip"
        data-verb-id="arm-palette.op"
        title="insert {op.label} into the expression"
        onclick={() => insertToken(op.token)}>{op.token}</button>
    {/each}
  </div>

  <!-- EVERY FIELD THE VOCABULARY DECLARES — grouped by root (the APG's
       grouping advice), each field an insert button carrying its root's
       plain-words meaning and its evaluation truth. NOT a listbox: the
       rows are buttons, and the listbox role does not support interacting
       with elements inside an option. -->
  {#each paletteGroups as group (group.root)}
    <div class="vocab-group">
      <p class="note vocab-root">{group.root} — {group.meaning}</p>
      <div class="row wrap">
        {#each group.fields as f (f.path)}
          <button type="button" class="menu-chip field-chip"
            data-verb-id="arm-palette.field"
            title="{f.evaluation} — insert into the expression"
            onclick={() => insertToken(f.path)}>{f.field}</button>
        {/each}
      </div>
    </div>
  {/each}
</Disclosure>

<Disclosure id="arm-sec-capture" label={INSPECTOR_SECTIONS["arm-sec-capture"].label} keywords={INSPECTOR_SECTIONS["arm-sec-capture"].keywords} defaultOpen={true}>
  <div class="row">
    <input class="param label" type="text" placeholder="What should you remember?"
      bind:value={captureLabel} name="capture-label" aria-label="capture label" />
    <button type="button" class="verb " data-action="arm.flags/capture"
      onclick={() => void capture()}
      title={past ? PAST_VIEW_ACT_REASON : undefined}
      disabled={past || busy || captureWindow === null}>Save capture</button>
  </div>
  {#if captureWindow === null}
    <p class="note under">Run a conversation to record activity, then save its visible time range here.</p>
  {:else}
    <p class="note under">bookmarks {formatClock(captureWindow.t0)}–{formatClock(captureWindow.t1)} on the record — nothing is copied</p>
  {/if}
</Disclosure>

<!-- Section identity exists while its data is pending or empty, so an addressed landing is never lost to acquisition. -->
  <Disclosure id="arm-sec-captured" label={INSPECTOR_SECTIONS["arm-sec-captured"].label} keywords={INSPECTOR_SECTIONS["arm-sec-captured"].keywords} count={$capturedRanges.length}>
    {#if $capturedRangesState === "pending"}<p class="note" role="status">Checking saved captures…</p>{/if}
    {#if $capturedRangesFailure !== null}<p class="note outcome" role="status">{$capturedRangesFailure}</p>{/if}
    {#if $capturedRangesState === "ready" && $capturedRanges.length === 0}<p class="note">No saved captures in this context yet. Save a moment above to return to it here.</p>{/if}
    {#each visibleCaptures as f (f.id)}
      <div class="row">
        <span class="flag">⚑</span>
        {#if f.t0 !== undefined}
          <!-- THE CAPTURE'S WAY BACK — its label is the live word it always
                should have been: one click plants the band's head at the
                stretch's start (the same verb a mark click runs), so a
                bookmark is a place you return to, not a row you read. -->
          <button
            type="button"
            class="live-word capture-go trunc"
            data-verb-id="arm-menu.capture-go"
            title="return to this stretch on the band"
            onclick={() => requestBandGo(f.t0!)}
          >{f.label ?? "unnamed stretch"}</button>
        {:else}
          <span class="pred trunc">{f.label ?? "unnamed stretch"}</span>
        {/if}
        {#if f.t0 !== undefined && f.t1 !== undefined}
          <span class="pred mono nowrap">· {formatClock(f.t0)}–{formatClock(f.t1)}</span>
        {/if}
        {#if f.t0 !== undefined}
          <!-- THE CAPTURE→FINDING SHARE — the campaign's standing item, landed:
               a capture the reader wants kept in front of them docks as a
               finding through the ONE admission controller, with the capture's
               own address as its derivation (nothing copied). It is a
               browser-side note, not a record write: it stays available in a
               past view, exactly like the row's go — and where the wire's
               optional shape carries no address, the verb does not render
               (a finding with no derivation to name is not proposed). -->
          <button type="button" class="verb " data-verb-id="arm-menu.capture-share"
            title="share this capture as a finding — its address rides along"
            onclick={() => announceArmCapture(f)}>Share</button>
        {/if}
        <button type="button" class="verb " data-action="arm.flags/clear"
          disabled={past} title={past ? PAST_VIEW_ACT_REASON : undefined}
          onclick={() => void clearCapture(f)}>Clear</button>
      </div>
    {/each}
    {@render pageControls("captures", capturePage, $capturedRanges.length, (page) => capturePage = page)}
    {#if $capturedRanges.length > 0}<div class="row">
      <button type="button" class="verb " data-action="arm.flags/clear"
        disabled={past} title={past ? PAST_VIEW_ACT_REASON : undefined}
        onclick={() => void clearAllCaptures()}>Clear all</button>
    </div>{/if}
  </Disclosure>

<!-- The section renders fired rows too (they carry the go / re-arm verbs),
       so its OWN count is the cocked count — the same derived atom the group
       cap reads. Two surfaces, one owner, one number. -->
  <Disclosure id="arm-sec-cocked" label={INSPECTOR_SECTIONS["arm-sec-cocked"].label} keywords={INSPECTOR_SECTIONS["arm-sec-cocked"].keywords} count={$cockedTriggerCount}>
    {#if $armedTriggers.length === 0}<p class="note">No watches yet. Create a condition above to catch the next event.</p>{/if}
    {#each visibleTriggers as t (t.id)}
      <div class="row">
        <span class="watch-state" class:fired={t.firedAtMs !== null}>{t.firedAtMs === null ? "Watching" : "Fired"}</span>
        <span class="pred">
          {armTriggerLabel(t)}
          {#if t.firedAtMs !== null}
            at {formatClock(t.firedAtMs)}
          {/if}
        </span>
        <span class="menu-chip label-chip">{t.storage === "ledger" ? "on the record" : "this browser only"} · {t.scope === "all" ? "all chats" : "this chat"}</span>
        {#if t.firedAtMs !== null}
          <!-- THE FIRED ROW'S VERBS: go (the band seam — the same verb a
               capture row runs) and re-arm (explicit, oscilloscope
               semantics). Navigation is the reader's choice, never
               automatic — a mid-run head plant would switch every
               asOf-reactive surface without consent. -->
          <button type="button" class="verb " data-verb-id="arm-menu.fired-go"
            title="plant the band at the firing instant"
            onclick={() => requestBandGo(t.firedAtMs!)}>Go</button>
          <button type="button" class="verb " data-verb-id="arm-menu.re-arm"
            disabled={past} title={past ? PAST_VIEW_ACT_REASON : "watch again — single-shot, one arming at a time"}
            onclick={() => reArm(t.id)}>Re-arm</button>
        {/if}
        <button type="button" class="verb " data-action="arm.flags/clear"
          disabled={past} title={past ? PAST_VIEW_ACT_REASON : undefined}
          onclick={() => void clear(t.id)}>Clear</button>
      </div>
    {/each}
    {@render pageControls("watches", triggerPage, $armedTriggers.length, (page) => triggerPage = page)}
  </Disclosure>

<Disclosure id="arm-sec-not-on-record" label={INSPECTOR_SECTIONS["arm-sec-not-on-record"].label} keywords={INSPECTOR_SECTIONS["arm-sec-not-on-record"].keywords} defaultOpen={false}>
  <!-- THE NEEDS-SERVER BOUNDARIES — honest absence rows, each with its
       way-out sentence in the grammar's own terms. Collapsed by default:
       these are the limits, not the work. -->
  <p class="note under">This browser evaluates watches over the live stream; the server fires none. The record stores armed predicates, not firings. Fired state syncs between this browser's tabs; the firing's mark and finding return to its instant. Another browser can re-arm a recorded predicate.</p>
  <p class="note under">Capture names are fixed. To rename one, clear it and capture the same range again.</p>
  <p class="note under">File-path matches stay in this browser. A custom expression over event.description can match an exact description on the record.</p>
  <p class="note under">{LOCAL_STORAGE_NOTE}</p>
</Disclosure>





{#if marksStorageDegraded() !== null}<p class="note storage" role="status">Browser storage is unavailable. Local marks and watches last only this session.</p>{/if}

{#snippet pageControls(id: string, page: number, count: number, choose: (page: number) => void)}
  {#if count > RUN_PANE_PAGE_SIZE}
    <nav class="page-controls" aria-label={id}>
      <button type="button" class="verb" data-verb-id="arm-menu.{id}.first" title="First page" disabled={page === 0} onclick={() => choose(0)}>First</button>
      <button type="button" class="verb" data-verb-id="arm-menu.{id}.previous" title="Previous page" disabled={page === 0} onclick={() => choose(page - 1)}>Previous</button>
      <span>{page + 1} / {Math.ceil(count / RUN_PANE_PAGE_SIZE)}</span>
      <button type="button" class="verb" data-verb-id="arm-menu.{id}.next" title="Next page" disabled={(page + 1) * RUN_PANE_PAGE_SIZE >= count} onclick={() => choose(page + 1)}>Next</button>
      <button type="button" class="verb" data-verb-id="arm-menu.{id}.last" title="Last page" disabled={(page + 1) * RUN_PANE_PAGE_SIZE >= count} onclick={() => choose(Math.ceil(count / RUN_PANE_PAGE_SIZE) - 1)}>Last</button>
    </nav>
  {/if}
{/snippet}

<style>
  .feedback { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-3); background: var(--accent-soft); border-radius: var(--radius-1); font-size: var(--f-data-size); color: var(--ink-2); }
  .feedback-spark { flex: none; color: var(--accent-capture); }
  .quick-watches { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: var(--sp-2); }
  .quick-watch { display: flex; justify-content: space-between; gap: var(--sp-2); color: var(--accent); background: var(--accent-soft); padding: var(--sp-2) var(--sp-3); }
  .builder-label { color: var(--ink-2); font-size: var(--f-data-size); }
  .condition { width: 100%; }
  .condition-preview { padding: var(--sp-2) var(--sp-3); border-left: var(--focus-ring-width) solid var(--accent-secondary); background: var(--ground-2); display: flex; flex-direction: column; gap: var(--sp-1); }
  .condition-preview code { white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--f-data-size); }
  .primary { background: var(--accent); color: var(--ground-0); min-height: var(--horizon-h); font-size: var(--f-data-size); }
  .page-controls { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-1); font-size: var(--f-data-size); }
  .watch-state { color: var(--accent); font-size: var(--f-nano-size); }
  .watch-state.fired { color: var(--accent-capture); }

  /* The surface itself is the HOST's (the shared Popover, or the right
   * menu's arm group) — this file styles only what is INSIDE it, so the
   * arm menu is recognisably the same instrument in both hosts. */
  .row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-height: var(--hit-min);
  }
  .row.wrap {
    flex-wrap: wrap;
  }
  /* A predicate sentence (or any row text) breaks rather than pushing: the
   * armed row's label can be a long when-eval expression holding unbreakable
   * snake_case tokens, and a flex child defaults to min-width:auto — one
   * long token became the whole column's minimum width at the overlay
   * widths. min-width 0 + anywhere keeps the row's grammar (the verbs still
   * park page-right) and lets the sentence wrap inside its own box. */
  .pred {
    color: var(--ink-2);
    font-size: var(--f-data-size);
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .mono {
    font-family: var(--face-mono);
  }
  .nowrap {
    white-space: nowrap;
  }
  /* The capture's way back consumes the owned live-word recipe (tokens.css
   * — the dotted underline); this keeps only the row's own type register. */
  .capture-go {
    font-size: var(--f-data-size);
    color: var(--ink-2);
  }
  .param {
    font: inherit;
    font-size: var(--f-data-size);
    min-height: var(--row-h);
    background: var(--ground-2);
    color: var(--ink-1);
    border: var(--hairline-w) solid var(--line-1);
    border-radius: var(--radius-1);
    padding: var(--sp-0) var(--sp-1);
  }
  .label { flex: 1; min-width: 0; }
  .expr { flex: 1; min-width: 0; font-family: var(--face-mono); }
  .row .verb {
    margin-left: auto;
  }
  /* A fired row carries three verbs (go, re-arm, clear): only the FIRST
   * takes the auto margin that parks the group page-right — the rest sit
   * beside it on the row's own gap. */
  .row .verb ~ .verb {
    margin-left: 0;
  }
  /* The scope radios: the fieldset carries the legend's register, the
   * options read as the rows' own grammar (plain words, hit floor). */
  .scope {
    border: 0;
    margin: 0;
    padding: 0;
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    min-height: var(--hit-min);
  }
  .scope .note {
    margin: 0;
  }
  .scope-opt {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-1);
    cursor: pointer;
  }
  .scope-opt input {
    accent-color: var(--accent);
  }
  /* The vocabulary field chips read one step brighter than the operator
   * tokens: they are the NOUNS the expression names, the thing you would
   * insert. The body is the one menu-chip recipe (tokens.css); this is the
   * register modifier only. */
  .field-chip {
    color: var(--ink-1);
  }
  .vocab-group {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }
  .vocab-root {
    margin: 0;
  }
  .flag { color: var(--ink-2); }
  /* Notes sit UNDER the row they qualify instead of being crushed into it:
   * a caveat squeezed onto the end of a control line reads as noise, and
   * these caveats are the honest part of the surface. A note can carry a
   * url-ish or snake_case token, so it wraps anywhere rather than pushing
   * the column. */
  .note {
    margin: 0;
    font-size: var(--f-nano-size);
    color: var(--ink-3);
    overflow-wrap: anywhere;
  }
  .note.under { margin-top: calc(-1 * var(--sp-0)); }
  .note.outcome { color: var(--ink-2); }
  .note.storage { border-top: var(--hairline-w) solid var(--line-1); padding-top: var(--sp-2); }
</style>
