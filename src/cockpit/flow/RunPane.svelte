<script lang="ts">
  import { INSPECTOR_SECTIONS } from "../../../shared/routes.ts";
  /**
   * THE RUN PANE — the run group's body: the conversation's measured facts
   * as seven collapsible sections (shell/Disclosure.svelte), hosted inside
   * the single right menu's run group (shell/RightMenuHost.svelte).
   *
   * THE USER'S DIRECTIVES, VERBATIM: "sections inside the menu
   * should be expandable/collapsible", "things should be clickable
   * whenever we can". Each section is an APG disclosure — a real button
   * carrying `aria-expanded` + `aria-controls` with a FIXED label and a
   * count that stays visible when the body is collapsed — and each row
   * with a real deep surface is CLICKABLE through it:
   *
   *   a turn row  → its beat's SCOPE sheet (flow/beat-request.ts `scope` —
   *                 the flow's own `openBeat`, the same path ⏎ takes);
   *   a call row  → its beat, focused, scrolled and unfolded (`reveal` —
   *                 the tool beats are sheetless by the beat-state ruling,
   *                 so the inline depth IS the deep surface);
   *   an edit row → the difference sheet (shell scope + rooms/DiffSheet,
   *                 the same sheet the Custody room opens);
   *   the run id  → copy (unchanged); the trace row → the band filter
   *                 (unchanged).
   * Rows with no real surface behind them (the agents) stay FACT rows —
   * no hover affordance where nothing is behind it.
   *
   * HONESTY: every section answers through the response grammar. No run, no
   * agents, no edits, no map — each is an `absent` in plain words, never a
   * spinner and never a fabricated zero. A measured fact that does not
   * exist yet says "not measured yet" while its turn is still earning it,
   * and "not recorded" when no measurement was ever taken — two different
   * absences, never a zero. Sections DEFAULT by their data's presence at
   * mount (open when they hold rows, collapsed when they hold none — the
   * collapsed header still states its count); the reader's toggles from
   * there are the reader's own, local to this mount and unpersisted.
   */
  import Answer from "../response/Answer.svelte";
  import CopyButton from "../render/CopyButton.svelte";
  import Disclosure from "../shell/Disclosure.svelte";
  import { absent, failed, pending, refused } from "../response/grammar.ts";
  import { fmtMs, fmtTokens } from "../desk/desk-data.ts";
  import { logTime } from "../shell/config.ts";
  import {
    runProgress,
    runAgents,
    runEdits,
    runIdentity,
    runTurns,
    runCalls,
    inputPreparation,
    codebaseView,
    requestCodebaseMap,
    runRecordRuns,
    runRecordContents,
    runRecordErrorCodes,
    runLedgerRows,
    runLedgerBeatIds,
    runActs,
    requestRunLedger,
    loadMoreRunLedger,
    runLedgerCategoryFilter,
    runLedgerOutcomeFilter,
  } from "../../state/run-pane.ts";
  import { currentRun, isRunActive, queuedSteers } from "../../state/run-state.ts";
  import { toolCallDurationMs } from "../../state/chat-messages.ts";
  import { currentChatId, currentChat } from "../../state/chats.ts";
  import { streamState } from "../sweep/sweep-store.ts";
  import { formatClock } from "../sweep/now-edge.ts";
  import { SWEEP_CATEGORIES, isErrorEvent } from "../sweep/categories.ts";
  // The run row's go verb: planting the head is a READ navigation, the same
  // one a capture row and a fired trigger use — the round-74 band seam.
  import { requestBandGo } from "../sweep/band-request.ts";
  import { asOfHead } from "../../data/asof.ts";
  import ToolInput from "../render/ToolInput.svelte";
  import { TOOL_CELL_FOLD_LINES } from "../render/render-config.ts";
  import { TIMELINE_QUERY_LIMIT } from "../../../shared/constants.ts";
  import {
    WAIT_MILESTONE_COUNT,
    WAIT_SAY,
    waitStage,
    waitStartedAt,
    waitSteps,
  } from "./wait-stage.ts";
  import type { AgentState } from "../../../shared/types.ts";
  import { toolLabel } from "../../state/tools.ts";
  import { currentProject } from "../../state/projects.ts";
  import { NOT_A_REPOSITORY } from "../../state/git.ts";
  import { RUN_PANE_INDEXING_POLL_MS, RUN_PANE_LANGUAGE_CAP, RUN_PANE_PAGE_SIZE } from "../flow/flow-config.ts";
  import { cancelRun, getGitStatus, refreshTimeline } from "../../client.ts";
  // §6.2: stopping a LIVE run is a write, and this call does NOT pass the
  // Broker's door (cancelRun is a client.ts call, so `broker.action` — where
  // `assertLiveForWrite` normally runs — is not on this path at all). The
  // assertion is applied here, at this call's own door, so a stop pressed
  // from a planted past view cannot reach a live run; the `disabled`
  // attribute below is the courtesy, not the promise.
  import {
    assertLiveForWrite,
    isPastView,
    PAST_VIEW_ACT_REASON,
  } from "../../data/asof.ts";
  import { clientWarn } from "../../client-debug.ts";
  import { action } from "../../data/broker.ts";
  import { uiSchema } from "../../state/schema-store.ts";
  import { configSnapshot } from "../../state/config-snapshot.ts";
  import { timelineScope } from "../../state/timeline-query.ts";
  import {
    scopeTimelineToTrace,
    clearTimelineTraceScope,
  } from "../../client.ts";
  // THE SHELL, for the edit rows' difference sheet: the PathChip precedent
  // (flow/PathChip.svelte) — a non-outlet component under the shell reads
  // the ShellApi from context; a standalone mount (a bare harness) honestly
  // renders the row heads as plain facts instead of dead buttons.
  import { getContext } from "svelte";
  import { SHELL_CONTEXT_KEY, type ShellApi } from "../shell/contract.ts";
  import DiffSheet from "../rooms/DiffSheet.svelte";
  // The turn/call rows' deep paths cross to the flow through the one-shot
  // seam (flow/beat-request.ts) — this pane has no handle into the flow's
  // private open/reveal functions, and the flow consumes the ask with the
  // same functions its own controls run.
  import { requestBeatAction } from "./beat-request.ts";
  import { activeWorkspaceId } from "../../state/workspaces.ts";
  import { inspectorPage, noteInspectorPage } from "../shell/workspace-view.ts";

  const shell = getContext<ShellApi | undefined>(SHELL_CONTEXT_KEY);
  let pageVersion = $state(0);
  function choosePage(id: string, page: number | undefined): void {
    noteInspectorPage(id, page);
    pageVersion += 1;
  }
  function pageNumber(id: string, total: number): number {
    void $activeWorkspaceId;
    void pageVersion;
    const last = Math.max(0, Math.ceil(total / RUN_PANE_PAGE_SIZE) - 1);
    // Until the reader chooses a page, follow the newest recorded activity.
    return Math.max(0, Math.min(inspectorPage(id) ?? last, last));
  }
  function pageRows<T>(id: string, rows: readonly T[]): readonly T[] {
    const first = pageNumber(id, rows.length) * RUN_PANE_PAGE_SIZE;
    return rows.slice(first, first + RUN_PANE_PAGE_SIZE);
  }

  // ── Progress ──
  const progress = $derived($runProgress);

  // ── The stop verb (the run's own control, on the surface that states its
  //    facts) ───────────────────────────────────────────────────────────────
  //
  // WHY HERE, AND NOT THE DESK OR THE WAIT ROW: this pane is the run's
  // inspector — its progress section is where the run's live state is
  // stated, and a verb belongs beside the fact it acts on (the codebase
  // section's re-read verb lives in its cap the same way). The desk is the
  // NEXT turn's composition (a stop there would act on this run from a
  // surface about the next one), and the WaitLine is phase-scoped — it
  // disappears at the first arrival, exactly when a long run needs stopping
  // most.
  //
  // A live `currentRun` is a run of the OPEN chat by construction: the store
  // is cleared on every chat switch (run-state's context reset), so a
  // starting/running view can only be the conversation on screen's. The
  // verb therefore appears exactly while a run of the open chat is live and
  // disappears the moment it settles — no other state to keep in step.
  // The liveness verdict is the run-state owner's computed view-liveness
  // (`isRunActive` — a run exists and is opening or working; `idle` and
  // no-run are NON-terminal yet still not live, so this is not the
  // terminal vocabulary's complement). Every liveness consumer here reads
  // that computed, never a restated set — the verb's render, the stop
  // action's guard (its null check only narrows the run object the POST
  // names), and the clock's tick condition — so a status the vocabulary
  // gains, terminal or live, settles or sustains this pane with no edit
  // in this file. (The status fact's outcome-ink ternary below is the
  // grammar's paint axis, not a liveness decision — it names statuses the
  // same way beat-state's ink mapping does.)
  const hasConversation = $derived($currentChat !== null && $currentChat.projectId === $currentProject?.id);
  const runLive = $derived(hasConversation && $isRunActive);
  /** True while the cockpit is showing a past instant — no writes possible. */
  const past = $derived($isPastView);

  /** In-flight guard: one press is one POST; a second waits. */
  let stopping = $state(false);
  /** The refused stop's own sentence, shown beside the verb — never silence. */
  let stopNote = $state<string | null>(null);

  async function stopRun(): Promise<void> {
    const run = currentRun.get();
    if (run === null || !runLive) return;
    stopping = true;
    stopNote = null;
    try {
      // The EXISTING cancel route — no new server surface. The server aborts
      // the run's controller; the executor publishes the terminal `cancelled`
      // frame; the run view settles as `cancelled` (never `done` — a stop is
      // not a completion) and the stranded tool calls finalize with their
      // own cancelled sentence.
      assertLiveForWrite();
      await cancelRun(run.runId);
    } catch (err) {
      // The run is still live and the stop did not land: say so beside the
      // verb rather than leaving a press that did nothing.
      stopNote = err instanceof Error ? err.message : String(err);
    } finally {
      stopping = false;
    }
  }

  // ── Trace filter ──
  // The button's active state reads the SCOPE store, not local component
  // state: the label stays true even when this trace's filter was set (or
  // cleared) from anywhere else, and a DIFFERENT trace's filter shows this
  // row's action as the filter it would set. The click goes through
  // client.ts, which owns the displaced-scope memory (the honest way back).
  const traceFilterActive = $derived(
    $timelineScope.kind === "trace" && $timelineScope.traceId === progress.traceId,
  );

  // A live elapsed clock: while a run is active the elapsed figure ticks
  // once a second; settled or absent runs hold the run's own start instant.
  let now = $state(Date.now());
  $effect(() => {
    if (progress.startedAt === null || !runLive) {
      return;
    }
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });
  const elapsed = $derived(
    progress.startedAt === null ? null : Math.max(0, now - progress.startedAt),
  );

  // ── Agents ──
  const agentList = $derived($runAgents);

  /** Lifecycle state → the outcome ink it wears (the grammar's own axis). */
  function agentOutcome(a: AgentState): "ok" | "warn" | "alarm" | "working" {
    switch (a.lifecycleState) {
      case "running":
      case "pending":
        return "working";
      case "succeeded":
        return "ok";
      case "failed":
      case "timed-out":
        return "alarm";
      default:
        return "warn";
    }
  }

  // ── Edits ──
  const edits = $derived($runEdits);

  /** The edit row's deep path: the difference sheet, the same scope the
   * Custody room opens — the row's own path through the shell it lives
   * under. No `fileState`: that word is the custody tree's MEASURED state
   * (changed / new / deleted / moved), and this row holds the CALL's status
   * — a different vocabulary that must not dress the sheet's absence
   * sentences in a story it did not measure. */
  function openEditDiff(path: string): void {
    if (shell === undefined) return;
    const projectPath = codebase.projectPath;
    if (projectPath === null) return;
    shell.openScope({
      title: `${path} — what changed`,
      component: DiffSheet,
      props: { projectPath, file: path },
    });
  }

  // ── Identity (merged into the progress section: the same subject — the
  //    current run — and the same one-per-run scalar register) ──
  const identity = $derived($runIdentity);
  const stream = $derived($streamState);
  /**
   * THE TRANSPORT ROW'S INK, derived from the run's own settled status —
   * the discriminator UIE-084 asked for: a "closed" stream is an alarm
   * exactly when the run did not settle with it. "done"/"cancelled" are
   * the run's own account of finishing (the natural close reads calm);
   * everything else — an "error" close, or a close while the run view
   * still expects events — is the real-disconnect class and stays loud.
   * "ending" (the debounced run-end inference) and "live" read calm by
   * the same law.
   */
  function streamOutcome(): "warn" | "alarm" | null {
    if (stream.status === "reconnecting") return "warn";
    if (stream.status === "closed") {
      return progress.status === "done" || progress.status === "cancelled" ? null : "alarm";
    }
    return null;
  }
  // The wait-milestone mirror: the flow's own owner supplies the stage, the
  // words and the step arithmetic — this line only states them where the
  // run's other live facts live, while a send is actually outstanding.
  const waitMirror = $derived.by(() => {
    if (!runLive) return null;
    const stage = $waitStage;
    const startedAt = $waitStartedAt;
    if (startedAt === null || stage === "idle") return null;
    return {
      say: WAIT_SAY[stage],
      steps: waitSteps(stage),
      of: WAIT_MILESTONE_COUNT,
    };
  });

  // ── Turns (the per-turn drilldown) ──
  const turns = $derived($runTurns);

  /** Which absence a missing fact wears: an in-flight turn has not earned
   * its number yet; a settled turn nobody measured says so. Never a zero. */
  function turnFactAbsence(live: boolean): string {
    return live ? "not measured yet" : "not recorded";
  }

  /** The turn row's outcome ink: streaming is work in progress, an
   * interrupted turn is attention, a measured turn is calm. */
  function turnOutcome(t: (typeof turns)[number]): "working" | "warn" | "ok" {
    if (t.live) return "working";
    if (t.incompleteReason !== undefined) return "warn";
    return "ok";
  }

  // ── Calls (the per-call drilldown) ──
  const calls = $derived($runCalls);
  /** The ONE duration owner, fed the row's raw terms and the pane's own
   * ticking clock — the same call the flow's tool beat makes. The say is
   * the honest one: a live elapsed for a running call, the measured span
   * for a settled one, and plain words when no measurement exists. */
  function callDurationSay(c: (typeof calls)[number]): string {
    const d = toolCallDurationMs(c, now);
    return d === null ? "not measured" : fmtMs(d);
  }

  // ── Preparation (the chat-wide rollups) ──
  const preparation = $derived($inputPreparation);

  /** The dedup rollup in the footer's own register, summed: frames folded,
   * chars before → after, the rollup's own saved share, blocks removed. */
  const dedupSay = $derived.by(() => {
    const d = preparation.dedup;
    if (d === null) return null;
    const pct = Math.round(d.savedPct * 100);
    return `${d.framesApplied} call${d.framesApplied === 1 ? "" : "s"} folded · ${fmtTokens(d.charsBefore)}→${fmtTokens(d.charsAfter)} chars · −${pct}% · ${d.blocksRemoved} repeated block${d.blocksRemoved === 1 ? "" : "s"} removed`;
  });

  /** The redaction rollup: the count leads, the confidence split follows,
   * upstream values stay their own sentence part, and the per-tier sums
   * name which kinds were found — zero parts never render. */
  const redactionSay = $derived.by(() => {
    const r = preparation.redaction;
    if (r === null) return null;
    const parts: string[] = [];
    if (r.maskedCount > 0) {
      parts.push(`${fmtTokens(r.maskedCount)} value${r.maskedCount === 1 ? "" : "s"} hidden`);
      if (r.proven > 0) parts.push(`${r.proven} proven`);
      if (r.format > 0) parts.push(`${r.format} format-matched`);
      if (r.inferred > 0) parts.push(`${r.inferred} inferred`);
    }
    if (r.maskedUpstream > 0) {
      parts.push(
        `${r.maskedUpstream} more ${r.maskedUpstream === 1 ? "was" : "were"} hidden upstream`,
      );
    }
    if (parts.length === 0) return null;
    const tiers = Object.entries(r.byTier)
      .filter(([, n]) => n > 0)
      .map(([tier, n]) => `${tier} ×${n}`)
      .join(" · ");
    return `redaction ${parts.join(" · ")}${tiers.length > 0 ? ` · by kind: ${tiers}` : ""}`;
  });

  // ── Codebase ──
  const codebase = $derived($codebaseView);
  let codebaseOpen = $state(false);
  // The load is keyed on the PROJECT PATH alone — reading the whole
  // `codebase` view here would re-fire this effect on the load's own
  // pending→measured writes (a request loop). `currentProject` is the
  // selection owner; its path is the only fact that decides what to load.
  // The working-tree read goes through the single owner (`getGitStatus`
  // feeds state/git.ts from the same response); a refused git read (not a
  // repository) is the store's own business — the section renders whatever
  // the store holds, and a failed read leaves the honest "not checked yet".
  $effect(() => {
    const path = $currentProject?.path ?? null;
    if (path === null || !codebaseOpen) return;
    void requestCodebaseMap(path);
    // A failed working-tree read is reported, never swallowed — the store
    // keeps whatever it last knew (null = "not checked yet" renders).
    void getGitStatus(path).catch((err: unknown) =>
      clientWarn("run-pane", "working-tree read failed:", err),
    );
  });
  // While the server is still reading the code (its 202 answer), re-ask on
  // the pane's own interval — the interval lives and dies with this state,
  // so a settled or absent read polls nothing.
  $effect(() => {
    if (!codebaseOpen || codebase.map.kind !== "indexing") return;
    const path = codebase.projectPath;
    if (path === null) return;
    const t = setInterval(() => void requestCodebaseMap(path, true), indexingPollMs());
    return () => clearInterval(t);
  });

  const reindex = $derived(
    $uiSchema?.blockActions?.["code.map"]?.find((a) => a.name === "reindex") ?? null,
  );

  function indexingPollMs(): number {
    const raw = ($configSnapshot as { config?: { codeIntelligence?: { indexPollMs?: unknown } } } | null)
      ?.config?.codeIntelligence?.indexPollMs;
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 100 && raw <= 60_000) {
      return Math.floor(raw);
    }
    return RUN_PANE_INDEXING_POLL_MS;
  }

  async function rereadCode(): Promise<void> {
    const path = $currentProject?.path;
    if (path === undefined || path === null || reindex === null) return;
    try {
      await action("code.map", "reindex", { path }, { invalidates: reindex.invalidates ?? ["index:ready"] });
      void requestCodebaseMap(path, true);
    } catch (err) {
      clientWarn("run-pane", "re-read the code failed:", err);
    }
  }

  // ── Runs (the record's map) ──
  const recordRuns = $derived($runRecordRuns);

  /** Opening the record's map asks the ONE existing timeline refresh
   * (client.ts refreshTimeline — the same call the run's settle makes) for
   * the streamed window the map derives from, so a reloaded page's map
   * fills from the record instead of waiting for the next run to stream. */
  function onRunsOpenChange(open: boolean): void {
    if (open) {
      void refreshTimeline().catch((err: unknown) =>
        clientWarn("run-pane", "the record map's refresh failed:", err),
      );
    }
  }

  // ── Record (the diagnostic roll-up) ──
  const recordContents = $derived($runRecordContents);
  const recordErrorCodes = $derived($runRecordErrorCodes);
  /** The interrupted/never-answered turns, from the SAME turns derivation
   * the turns section renders — the ending vocabulary's own rollup. */
  const incompleteTurns = $derived($runTurns.filter((t) => t.incompleteReason !== undefined));

  // ── Ledger (the run-scoped event ledger) ──
  const ledger = $derived($runLedgerRows);
  const ledgerBeatIds = $derived($runLedgerBeatIds);
  let ledgerLoading = $state(false);
  /** Mirrors the ledger section's open state (the Disclosure tells it; the
   * read fires only while a reader can see the answer). */
  let ledgerOpen = $state(false);

  function onLedgerOpenChange(open: boolean): void {
    ledgerOpen = open;
    if (open) void requestRunLedger();
  }

  // The question: the section's open asks it, and a chat or head change
  // asks it again — the store's key makes the re-ask idempotent per
  // question. No timer anywhere.
  $effect(() => {
    if (!ledgerOpen) return;
    void $currentChatId;
    void $asOfHead;
    void requestRunLedger();
  });

  // The run's settle: the stream closing means the record grew — re-ask
  // with force, the same signal the sweep's spectrum feed rides.
  let lastLedgerStreamStatus: string | undefined = undefined;
  $effect(() => {
    if (!ledgerOpen) return;
    const status = $streamState.status;
    if (status === "closed" && lastLedgerStreamStatus !== undefined && lastLedgerStreamStatus !== "closed") {
      void requestRunLedger(true);
    }
    lastLedgerStreamStatus = status;
  });

  /** The outcome chip's row ink — the same axis every row paints by, the
   * failure predicate DELEGATED to the counting-policy owner (`isErrorEvent`)
   * so the row's ink and the chips that narrow it can never disagree about
   * what a failure is. */
  function ledgerRowOutcome(r: (typeof ledger.rows)[number]): "ok" | "warn" | "alarm" {
    if (isErrorEvent({ outcome: r.outcome, errorCode: r.errorCode })) return "alarm";
    if (r.outcome === "denied") return "warn";
    return "ok";
  }

  /** The categories present in the loaded page — a chip for a category the
   * page holds no row of would be a promise of rows that do not exist. */
  const ledgerCategories = $derived.by(() => {
    if (ledger.load.kind !== "measured") return [];
    const present = new Set(ledger.rows.map((r) => r.category));
    return SWEEP_CATEGORIES.filter((c) => present.has(c.id));
  });

  async function ledgerLoadMore(): Promise<void> {
    if (ledgerLoading) return;
    ledgerLoading = true;
    try {
      await loadMoreRunLedger();
    } finally {
      ledgerLoading = false;
    }
  }

  // ── Acts (the operator intervention trail) ──
  const acts = $derived($runActs);

  /** The row's own latency, in the pane's duration register. */
  function actLatencySay(ms: number): string {
    return ms === 0 ? "instant" : fmtMs(ms);
  }

  /** True when the record carries any input worth reading back — the same
   * judgment the flow's own act beat makes. */
  function actHasInput(input: unknown): boolean {
    return (
      input !== undefined &&
      input !== null &&
      !(typeof input === "object" && Object.keys(input as object).length === 0)
    );
  }
</script>

{#snippet pageControls(id: string, total: number)}
  {#if total > RUN_PANE_PAGE_SIZE}
    {@const page = pageNumber(id, total)}
    <nav class="page-controls" aria-label={`${id} pages`}>
      <button type="button" class="verb" data-verb-id={`run-pane.${id}.first`} disabled={page === 0} aria-label={`first ${id}`} onclick={() => choosePage(id, 0)}>First</button>
      <button type="button" class="verb" data-verb-id={`run-pane.${id}.previous`} disabled={page === 0} aria-label={`previous ${id}`} onclick={() => choosePage(id, page - 1)}>Previous</button>
      <span>{page * RUN_PANE_PAGE_SIZE + 1}–{Math.min(total, (page + 1) * RUN_PANE_PAGE_SIZE)} of {total}</span>
      <button type="button" class="verb" data-verb-id={`run-pane.${id}.next`} disabled={(page + 1) * RUN_PANE_PAGE_SIZE >= total} aria-label={`next ${id}`} onclick={() => choosePage(id, page + 1)}>Next</button>
      <button type="button" class="verb" data-verb-id={`run-pane.${id}.latest`} disabled={(page + 1) * RUN_PANE_PAGE_SIZE >= total} aria-label={`latest ${id}`} onclick={() => choosePage(id, undefined)}>Latest</button>
    </nav>
  {/if}
{/snippet}

{#if hasConversation}
<Disclosure id="run-sec-progress" label={INSPECTOR_SECTIONS["run-sec-progress"].label} keywords={INSPECTOR_SECTIONS["run-sec-progress"].keywords} defaultOpen={runLive}>
  {#snippet meta()}
    <!-- THE RUN'S OWN STOP VERB, beside the facts it acts on (the codebase
         section's re-read verb lives in its cap the same way). Rendered
         ONLY while a run of the open chat is live; the run's own settle
         (status `cancelled`, terminal `cancelled` frame) is the outcome the
         reader sees. Keyboard-reachable as a plain button. -->
    {#if runLive}
      <button
        class="verb "
        data-verb-id="run.stop"
        disabled={stopping || past}
        title={past
          ? PAST_VIEW_ACT_REASON
          : "stop this run now — what it already wrote stays; the run settles as cancelled"}
        onclick={() => void stopRun()}
      >Stop</button>
    {/if}
  {/snippet}
  {#if stopNote !== null}
    <Answer answer={failed(`the run was not stopped — ${stopNote}`)} />
  {/if}
  {#if runLive && $queuedSteers > 0}
    <!-- THE STEERED INSTRUCTIONS, counted by the run's own queue: the pane
         is the run's inspector, so the fact that an instruction is WAITING
         for its next turn belongs here, in plain words, exactly where
         every other fact about the run lives. The count comes from the
         server (the steer answer + each `steered` frame). -->
    <p class="queued-line" role="status" data-field="queued-steers">
      {$queuedSteers} instruction{$queuedSteers === 1 ? "" : "s"} queued — the model receives
      {$queuedSteers === 1 ? "it" : "them"} after this turn
    </p>
  {/if}
  {#if waitMirror !== null}
    <!-- THE WAIT-MILESTONE MIRROR — the accepted → connected → answering
         steps, restated on the run's inspector while a send is outstanding.
         ONE manifestation rule honored: the stage, the plain-words sentence
         and the "n of N" arithmetic all come from the flow's own owner
         (wait-stage.ts) — this line adds no second derivation, and it
         disappears at the same instant the flow's wait row does (the stage
         resets at the run's end). -->
    <p class="queued-line" role="status" data-field="wait-stage">
      {waitMirror.say} · step {waitMirror.steps} of {waitMirror.of}
    </p>
  {/if}
  {#if progress.status === null && progress.traceId === null}
    <Answer answer={absent("no active run")} />
  {:else}
    {#if progress.status === null}
      <Answer answer={absent("no active run")} />
    {:else}
      <dl class="facts">
        <div class="fact">
          <dt class="engraved">status</dt>
          <dd data-outcome={progress.status === "running" || progress.status === "starting" ? "working" : progress.status === "error" ? "alarm" : progress.status === "cancelled" ? "warn" : "ok"}>
            {progress.status}
          </dd>
        </div>
        {#if progress.modelLabel !== null}
          <div class="fact"><dt class="engraved">model</dt><dd class="mono">{progress.modelLabel}</dd></div>
        {/if}
        {#if progress.startedAt !== null}
          <!-- THE ABSOLUTE CLOCK beside the elapsed: "12.3s" answers how
               long; "from 14:32:05" answers when — different questions,
               and an inspector owes both. logTime is the shell's own
               clock formatter (the edits rows stamp with the same one). -->
          <div class="fact">
            <dt class="engraved">started</dt>
            <dd class="mono">{logTime(progress.startedAt)}</dd>
          </div>
        {/if}
        {#if identity.projectLabel !== null}
          <!-- The project the RUN is bound to — joined by the run's own
               projectId against the projects store, never "whatever is
               open", so a run started under a project the user has since
               left still names its true binding. -->
          <div class="fact">
            <dt class="engraved">project</dt>
            <dd>{identity.projectLabel}</dd>
          </div>
        {/if}
        <div class="fact">
          <dt class="engraved">elapsed</dt>
          <dd class="mono">{elapsed === null ? "not started" : fmtMs(elapsed)}</dd>
        </div>
        <div class="fact">
          <dt class="engraved">turns</dt>
          <dd class="mono">{progress.turns === 0 ? "none yet" : String(progress.turns)}</dd>
        </div>
        <div class="fact">
          <dt class="engraved">tool calls</dt>
          <dd class="mono">
            {#if progress.toolCalls === 0}
              none yet
            {:else if progress.toolCallsRunning > 0}
              {progress.toolCallsRunning} of {progress.toolCalls} running
            {:else}
              {progress.toolCalls}
            {/if}
          </dd>
        </div>
        <div class="fact">
          <dt class="engraved">tokens</dt>
          <dd class="mono">
            {#if progress.totalTokens === null}
              not measured yet
            {:else}
              {fmtTokens(progress.totalTokens)} ({fmtTokens(progress.inputTokens ?? 0)} in · {fmtTokens(progress.outputTokens ?? 0)} out)
            {/if}
          </dd>
        </div>
        <div class="fact">
          <dt class="engraved">stream</dt>
          <!-- THE SWEEP STREAM'S TRANSPORT STATE — the same one-owner store
               the band's own status reads (sweep-store.ts), so the pane
               and the band can never disagree about whether events are
               arriving. THE INK IS DERIVED, NEVER FREE-STANDING (the
               UIE-084 ruling):
                 "reconnecting" — the transport degraded and is retrying →
                                  attention;
                 "ending"       — the debounced run-end inference; the model
                                  stopped producing and the epilogue may
                                  still tick events → CALM, exactly like
                                  live (this is the face a healthy run's
                                  last window wears; alarm here sent readers
                                  reaching for reload mid-finish);
                 "closed"       — the stream's own terminal fact. ALARM
                                  unless the run's own status settles it as
                                  a natural completion: an "error" close
                                  (the error frame, a lost connection) and
                                  a close over a still-live run are the
                                  r72-class real disconnects and stay loud;
                                  "done"/"cancelled" are the run's own
                                  account of finishing and read calm.
               The last event's clock is the sweep's own formatter. -->
          <dd class="mono" data-field="stream" data-outcome={streamOutcome()}>
            {stream.status} · {fmtTokens(stream.eventsReceived)} event{stream.eventsReceived === 1 ? "" : "s"}{stream.lastEventMs !== null ? ` · last ${formatClock(stream.lastEventMs)}` : ""}
          </dd>
        </div>
      </dl>
    {/if}
    <!-- THE LATEST RECORDED RUN'S TRACE ID — the address of every ledger
         event that request recorded, and a RECORD fact rather than a
         liveness fact: it renders whether or not a run is live, because
         the run view retires moments after a run ends — exactly when an
         incident gets investigated — while the transcript keeps the id.
         An inspector fact, deliberately: this pane exists to state a
         run's precise facts, and this one is what makes the recorded
         evidence reachable (`scripts/trace.ts trace <id>` answers from
         it). The value truncates; the copy affordance carries the full
         id, so the fact is visible, copyable, and never cut. An older
         turn recorded before traces existed states its absence in the
         section's own register, never a blank row. Beside the copy
         affordance sits the trace FILTER action: it scopes the sweep
         band to this trace's chain (scope=trace through the
         sweep.spectrum block, ownership-gated server-side) and toggles
         to its own way back — the honest exit restores the displaced
         chat/project scope rather than inventing a global one. -->
    <dl class="facts">
      {#if identity.runId !== null}
        <!-- THE RUN'S OWN ID — the address the stop verb posts to and the
             sweep's run bins live under, with the same affordance the
             trace row built: the value truncates, the copy button carries
             the full id. A RUN-VIEW fact, unlike the trace: the live
             transcript does not stamp run ids on assistant rows (only
             the persisted record does), so this row goes with the view
             when it retires — it never shows a previous run's id as if
             it were the live one's. -->
        <div class="fact">
          <dt class="engraved">run</dt>
          <dd class="mono trace">
            <span class="trace-value" title={identity.runId}>{identity.runId}</span>
            <CopyButton text={identity.runId} what="copy the run id" />
          </dd>
        </div>
      {/if}
      {#if progress.traceId !== null}
        <div class="fact">
          <dt class="engraved">trace</dt>
          <dd class="mono trace">
            <span class="trace-value" title={progress.traceId}>{progress.traceId}</span>
            <CopyButton text={progress.traceId} what="copy the trace id" />
            <button
              type="button"
              class="verb bare trace-filter"
              data-verb-id="run-pane.trace-filter"
              aria-pressed={traceFilterActive ? "true" : "false"}
              onclick={() =>
                traceFilterActive
                  ? clearTimelineTraceScope()
                  : scopeTimelineToTrace(progress.traceId!)}
              title={
                traceFilterActive
                  ? "clear the trace filter"
                  : "filter the band by this trace"
              }
            >
              {traceFilterActive ? "clear" : "filter"}
            </button>
          </dd>
        </div>
      {:else}
        <div class="fact">
          <dt class="engraved">trace</dt>
          <dd class="mono">not recorded yet</dd>
        </div>
      {/if}
    </dl>
  {/if}
</Disclosure>

<!-- ── RUNS — the record's map: every run the streamed window holds, one row
     each, with the go that plants the head at the run's start (the same
     oscilloscope navigation a capture row and a fired trigger use — a READ,
     so it works in a past view too). The banding owner is the same one the
     band's a11y outline uses, but over a different input set: this list
     reads the streamed window while the outline reads the
     spectrum-measured coverage, so the two agree at rest and may differ
     transiently while a run settles. A run whose opening record is not in
     view (the streamed window is a page, not the whole record — why the
     opening record is absent, the window-local detection cannot say) is a
     TAIL SLICE: its row names its figures as in view instead of presenting
     the slice as the run's whole record — the row must never claim a
     719ms run where a 33.8s one is recorded. ── -->
<Disclosure id="run-sec-runs" label={INSPECTOR_SECTIONS["run-sec-runs"].label} keywords={INSPECTOR_SECTIONS["run-sec-runs"].keywords} count={recordRuns.length} onOpenChange={onRunsOpenChange}>
  {#if recordRuns.length === 0}
    <Answer answer={absent("no runs on the band yet")} />
  {:else}
    <ul class="rows">
      {#each pageRows("runs", recordRuns) as r (r.runId ?? "∅")}
        <li class="row" data-outcome={r.live ? "working" : r.errorCount > 0 ? "alarm" : "ok"}>
          <div class="row-head">
            <span class="name mono trunc" title={r.runId ?? undefined}>
              {r.runId === null ? "not part of a run" : `run ${r.runId.slice(0, 13)}`}
            </span>
            <span class="badge engraved">{r.live ? "live" : "recorded"}</span>
          </div>
          <div class="row-meta mono">
            {#if r.partial}
              in view from {logTime(r.t0)} — the opening record of this run is not in view
              · {r.eventCount} event{r.eventCount === 1 ? "" : "s"} in view
              {#if r.errorCount > 0}
                · <span data-outcome="alarm">{r.errorCount} error{r.errorCount === 1 ? "" : "s"} in view</span>
              {/if}
            {:else}
              {logTime(r.t0)}–{logTime(r.t1)} · {fmtMs(Math.max(0, r.t1 - r.t0))}
              · {r.eventCount} event{r.eventCount === 1 ? "" : "s"}
              {#if r.errorCount > 0}
                · <span data-outcome="alarm">{r.errorCount} error{r.errorCount === 1 ? "" : "s"}</span>
              {/if}
            {/if}
          </div>
          <div class="row-verbs">
            <button
              type="button"
              class="verb bare"
              data-verb-id="run-pane.run-go"
              title={r.partial
                ? "plant the head at this run's first event in view — this run's opening record is not in this window, and the ledger below still holds the run's earlier events"
                : "plant the head at this run's start — the band, the banner and every past view follow"}
              onclick={() => requestBandGo(r.t0)}
            >Go</button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
  {@render pageControls("runs", recordRuns.length)}
</Disclosure>

<!-- ── AGENTS — no row has a deeper surface than its own facts, so these
     stay FACT rows: no hover affordance where nothing is behind it. ── -->
<Disclosure id="run-sec-agents" label={INSPECTOR_SECTIONS["run-sec-agents"].label} keywords={INSPECTOR_SECTIONS["run-sec-agents"].keywords} count={agentList.length}>
  {#if agentList.length === 0}
    <Answer answer={absent("no agents yet")} />
  {:else}
    <ul class="rows">
      {#each pageRows("agents", agentList) as a (a.agentId)}
        <li class="row" data-outcome={agentOutcome(a)}>
          <div class="row-head">
            <span class="name trunc">{a.agentName}</span>
            <span class="badge engraved">{a.lifecycleState}</span>
          </div>
          <div class="row-meta mono">
            {a.turnCount} turn{a.turnCount === 1 ? "" : "s"} · {fmtTokens(a.totalTokens)} tokens
          </div>
          {#if a.lastError !== null}
            <div class="row-error" role="alert">{a.lastError}</div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  {@render pageControls("agents", agentList.length)}
</Disclosure>

<!-- ── TURNS — one row per model turn, oldest first (the order the run made
     them). The row's HEAD is the click path to its beat's fact sheet
     (the dotted-underline idiom, the same shape ArtifactFrame's live word
     wears): a real button inside the row, never a clickable row. ── -->
<Disclosure id="run-sec-turns" label={INSPECTOR_SECTIONS["run-sec-turns"].label} keywords={INSPECTOR_SECTIONS["run-sec-turns"].keywords} count={turns.length}>
  {#if turns.length === 0}
    <Answer answer={absent("no turns yet")} />
  {:else}
    <!-- Every fact is the turn's OWN measurement from the one derivation
         owner; every absence says which absence it is — a fact still being
         earned reads "not measured yet", a fact nobody measured reads
         "not recorded". Never a zero. -->
    <ul class="rows">
      {#each pageRows("turns", turns) as t (t.id)}
        <li class="row" data-outcome={turnOutcome(t)}>
          <div class="row-head">
            <button
              type="button"
              class="live-word row-link"
              data-verb-id="run-pane.turn-scope"
              title="open this turn's fact sheet"
              onclick={() => requestBeatAction(t.id, "scope")}
            >Turn {t.index}</button>
            <span class="badge engraved">
              {#if t.live}streaming{:else if t.incompleteReason !== undefined}incomplete{:else}recorded{/if}
            </span>
          </div>
          {#if t.steered}
            <div class="row-meta" data-field="steered">steered — this turn answered a queued instruction</div>
          {/if}
          {#if t.incompleteReason !== undefined}
            <div class="row-ending">{t.incompleteReason}</div>
          {/if}
          <dl class="facts turn-facts">
            <div class="fact">
              <dt class="engraved">first token</dt>
              <dd class="mono">{t.firstOutputMs !== undefined ? fmtMs(t.firstOutputMs) : turnFactAbsence(t.live)}</dd>
            </div>
            <div class="fact">
              <dt class="engraved">first word</dt>
              <dd class="mono">{t.firstWordMs !== undefined ? fmtMs(t.firstWordMs) : turnFactAbsence(t.live)}</dd>
            </div>
            <div class="fact">
              <dt class="engraved">producing</dt>
              <dd class="mono">{t.generationMs !== undefined ? fmtMs(t.generationMs) : turnFactAbsence(t.live)}</dd>
            </div>
            <div class="fact">
              <dt class="engraved">rate</dt>
              <dd class="mono">{t.tokPerSec !== undefined ? `${t.tokPerSec} tok/s` : turnFactAbsence(t.live)}</dd>
            </div>
            <div class="fact">
              <dt class="engraved">tokens</dt>
              <dd class="mono">
                {#if t.inputTokens !== undefined}
                  {fmtTokens(t.inputTokens)} in · {fmtTokens(t.outputTokens ?? 0)} out
                {:else}
                  {turnFactAbsence(t.live)}
                {/if}
              </dd>
            </div>
            <div class="fact">
              <dt class="engraved">finish</dt>
              <dd class="mono">{t.finishReason !== undefined ? t.finishReason : turnFactAbsence(t.live)}</dd>
            </div>
            <div class="fact">
              <dt class="engraved">model</dt>
              <dd class="mono">{t.responseModel !== undefined ? t.responseModel : turnFactAbsence(t.live)}</dd>
            </div>
          </dl>
        </li>
      {/each}
    </ul>
  {/if}
  {@render pageControls("turns", turns.length)}
</Disclosure>

<!-- ── CALLS — every tool call, oldest first, the measurement ledger beside
     the flow's causality view. The row's HEAD jumps to the call's own beat
     (focus + scroll + its inline depth unfolded): the tool beats are
     sheetless by the beat-state ruling, so the beat IS the deep surface. ── -->
<Disclosure id="run-sec-calls" label={INSPECTOR_SECTIONS["run-sec-calls"].label} keywords={INSPECTOR_SECTIONS["run-sec-calls"].keywords} count={calls.length}>
  {#if calls.length === 0}
    <Answer answer={absent("no calls yet")} />
  {:else}
    <!-- The duration comes from the ONE duration owner fed this row's raw
         terms and the pane's ticking clock, so a running call shows its
         live elapsed and a settled call shows its measured span; a settled
         call with no measurement says so. -->
    <ul class="rows">
      {#each pageRows("calls", calls) as c (c.id)}
        <!-- The ink order is the honesty order: a stranded call (the run
             ended before it reported) is ATTENTION even though its status
             still says running — it is not working and must not wear
             working ink. A refused call keeps the failure ink its status
             already earns; "refused" beside it is the typed fact. -->
        <li class="row" data-outcome={c.incompleteReason !== undefined ? "warn" : c.status === "running" ? "working" : c.status === "error" ? "alarm" : "ok"}>
          <div class="row-head">
            <button
              type="button"
              class="live-word row-link"
              data-verb-id="run-pane.call-reveal"
              title="jump to this call in the conversation"
              onclick={() => requestBeatAction(c.id, "reveal")}
            >{toolLabel(c.toolName)}</button>
            <span class="badge engraved">{c.status}</span>
          </div>
          <div class="row-meta mono">
            {callDurationSay(c)}
            {#if c.attemptCount !== undefined && c.attemptCount > 1}
              · attempt {c.attemptCount}
            {/if}
            {#if c.refused === true}
              · refused
            {/if}
          </div>
          {#if c.incompleteReason !== undefined}
            <div class="row-ending">{c.incompleteReason}</div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  {@render pageControls("calls", calls.length)}
</Disclosure>

<!-- ── EDITS — the FILES the run touched. The row's HEAD opens the
     difference sheet (the same sheet the Custody room opens); with no
     shell (a bare harness mount) it renders as the plain fact it always
     was — the PathChip honest-degradation pattern. ── -->
<Disclosure id="run-sec-edits" label={INSPECTOR_SECTIONS["run-sec-edits"].label} keywords={INSPECTOR_SECTIONS["run-sec-edits"].keywords} count={edits.length}>
  {#if edits.length === 0}
    <Answer answer={absent("no files touched yet")} />
  {:else}
    <ul class="rows">
      {#each pageRows("edits", edits) as e (e.id)}
        <li class="row" data-outcome={e.status === "running" ? "working" : e.status === "error" ? "alarm" : "ok"}>
          <div class="row-head">
            {#if shell !== undefined}
              <button
                type="button"
                class="live-word row-link mono trunc"
                data-verb-id="run-pane.edit-diff"
                title={`show what changed in ${e.path}`}
                onclick={() => openEditDiff(e.path)}
              >{e.path}</button>
            {:else}
              <span class="name mono trunc">{e.path}</span>
            {/if}
            <span class="badge engraved">{e.status}</span>
          </div>
          <div class="row-meta mono">
             {toolLabel(e.toolName)} · {logTime(e.at)}
           </div>
         </li>
       {/each}
     </ul>
   {/if}
  {@render pageControls("edits", edits.length)}
</Disclosure>

<!-- ── RECORD — the diagnostic roll-up: what the streamed window holds
     (events and errors, the same two-number résumé the band reads), the
     interrupted/never-answered turns' own ending sentences, and the distinct
     error codes the failures carry. Every figure names the window it was
     counted over; nothing here re-derives a count another owner holds. ── -->
<Disclosure
  id="run-sec-record"
  label={INSPECTOR_SECTIONS["run-sec-record"].label} keywords={INSPECTOR_SECTIONS["run-sec-record"].keywords}
  count={recordContents.errors + incompleteTurns.length}
  defaultOpen={recordContents.errors > 0 || incompleteTurns.length > 0}
>
  {#if recordContents.events === 0}
    <Answer answer={absent("nothing recorded on the band yet")} />
  {:else}
    <dl class="facts">
      <div class="fact">
        <dt class="engraved">window</dt>
        <dd class="mono" data-field="record-contents">
          {recordContents.events} event{recordContents.events === 1 ? "" : "s"}
          {#if recordContents.errors > 0}
            · <span data-outcome="alarm">{recordContents.errors} error{recordContents.errors === 1 ? "" : "s"}</span>
          {:else}
            · no errors
          {/if}
        </dd>
      </div>
      {#if recordErrorCodes.length > 0}
        <div class="fact">
          <dt class="engraved">error codes</dt>
          <dd class="mono" data-field="record-error-codes">
            {recordErrorCodes.map((c) => `${c.code} ×${c.count}`).join(" · ")}
          </dd>
        </div>
      {/if}
    </dl>
  {/if}
  {#if incompleteTurns.length > 0}
    <ul class="rows" aria-label="interrupted turns">
      {#each pageRows("interruptions", incompleteTurns) as t (t.id)}
        <li class="row" data-outcome="warn">
          <div class="row-head">
            <button
              type="button"
              class="live-word row-link"
              data-verb-id="run-pane.incomplete-turn-scope"
              title="open this turn's fact sheet"
              onclick={() => requestBeatAction(t.id, "scope")}
            >Turn {t.index}</button>
            <span class="badge engraved">incomplete</span>
          </div>
          <div class="row-ending">{t.incompleteReason}</div>
        </li>
      {/each}
    </ul>
  {:else if recordContents.events > 0}
    <p class="queued-line">no interrupted turns</p>
  {/if}
  {@render pageControls("interruptions", incompleteTurns.length)}
</Disclosure>

<!-- ── LEDGER — the run-scoped event ledger: the chat's recorded events from
     the canonical query, paged with the wire's own limit, the truncation
     stated honestly, the chips narrowing what is shown (never the recorded
     total), and a row reveal into the flow for every event the transcript
     holds a beat for. The read fires on this section's open, on the run's
     settle, and on a head change — and a planted head BOUNDS it, so a past
     view reads the past. ── -->
<Disclosure
  id="run-sec-ledger"
  label={INSPECTOR_SECTIONS["run-sec-ledger"].label} keywords={INSPECTOR_SECTIONS["run-sec-ledger"].keywords}
  count={ledger.load.kind === "measured" ? ledger.load.total : null}
  defaultOpen={false}
  onOpenChange={onLedgerOpenChange}
>
  {#if ledger.load.kind === "pending"}
    <Answer answer={pending("reading the conversation's record")} />
  {:else if ledger.load.kind === "refused"}
    <Answer answer={refused(ledger.load.reason)} />
  {:else if ledger.load.kind === "absent"}
    <Answer answer={absent(ledger.load.reason)} />
  {:else}
    {#if ledger.head !== null}
      <!-- The read was BOUNDED by the planted head — say so, the same
           register the banner uses, so the rows are never read as "all". -->
      <p class="queued-line" data-field="ledger-bounded">viewing up to {formatClock(ledger.head)}</p>
    {/if}
    <!-- THE FILTER CHIPS: outcome first (the diagnostic question), then the
         categories the loaded page actually holds. Chips narrow the DISPLAY;
         the recorded total below never moves with them. -->
    <div class="chips" role="group" aria-label="filter the ledger rows">
      {#each ["all", "failed", "denied", "ok"] as want (want)}
        <button
          type="button"
          class="menu-chip"
          data-verb-id="run-pane.ledger-outcome"
          aria-pressed={$runLedgerOutcomeFilter === want ? "true" : "false"}
          onclick={() => $runLedgerOutcomeFilter = want as "all" | "failed" | "denied" | "ok"}
        >{want}</button>
      {/each}
      {#each ledgerCategories as c (c.id)}
        <button
          type="button"
          class="menu-chip"
          data-verb-id="run-pane.ledger-category"
          aria-pressed={$runLedgerCategoryFilter === c.id ? "true" : "false"}
          title={c.label}
          onclick={() => $runLedgerCategoryFilter = $runLedgerCategoryFilter === c.id ? "all" : c.id}
        >{c.id}</button>
      {/each}
    </div>
    {#if ledger.rows.length === 0}
      <Answer answer={absent("no events match this filter in the loaded page")} />
    {:else}
      <ul class="rows">
        {#each pageRows("events", ledger.rows) as r (r.eventId)}
          <li class="row ledger-row" data-outcome={ledgerRowOutcome(r)}>
            <div class="row-head">
              {#if ledgerBeatIds.get(r.eventId) !== undefined}
                <button
                  type="button"
                  class="live-word row-link mono"
                  data-verb-id="run-pane.ledger-reveal"
                  title="jump to this event in the conversation"
                  onclick={() => requestBeatAction(ledgerBeatIds.get(r.eventId)!, "reveal")}
                >{r.eventType}</button>
              {:else}
                <!-- A ledger-only event: recorded, real, and holding no beat
                     in the flow — the row is the fact, with no affordance
                     that pretends a surface exists. -->
                <span class="name mono">{r.eventType}</span>
              {/if}
              {#if r.errorCode !== null}
                <span class="badge engraved" data-outcome="alarm">{r.errorCode}</span>
              {:else if r.outcome !== null}
                <span class="badge engraved">{r.outcome}</span>
              {/if}
            </div>
            <div class="row-meta mono trunc" title={r.description}>
              {r.timeMs !== null ? logTime(r.timeMs) : r.wallTime} · {r.description}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
    <!-- THE HONEST TRUNCATION: rows shown beside the server's total for the
         scope — two numbers because they are two different facts, and a
         filter that narrows the first must never narrow the second. -->
    <p class="queued-line" data-field="ledger-count">
      Matches: {ledger.rows.length} · {ledger.load.rows.length} loaded · {ledger.load.total} recorded
    </p>
    {#if ledger.load.hasMore && ledger.load.nextCursor !== null}
      <button
        type="button"
        class="verb "
        data-verb-id="run-pane.ledger-more"
        disabled={ledgerLoading}
        onclick={() => void ledgerLoadMore()}
      >{ledgerLoading ? "reading…" : `load the next ${fmtTokens(TIMELINE_QUERY_LIMIT)}`}</button>
    {/if}
    {#if ledger.load.kind === "measured" && ledger.load.moreError !== null}
      <!-- A failed page load keeps the standing rows and names its reason —
           never silence, never a blanked page. -->
      <p class="queued-line" data-field="ledger-more-error" role="alert">
        the next page did not load — {ledger.load.moreError}
      </p>
    {/if}
  {/if}
  {@render pageControls("events", ledger.rows.length)}
</Disclosure>

<!-- ── ACTS — the operator intervention trail: the who-did-what-when of
     steering the machine, from the Broker's own write-door log (the same
     record the flow mints its act beats from), each row carrying the
     DECLARED words verbatim. The log is this browser session's bounded
     record — the section says so rather than claiming a per-run
     attribution the record does not carry. A STEER is deliberately absent
     from the population: it is a plain transcript interaction, not a
     broker write, so a steered run shows no steer row here — the caption
     says so rather than leaving the absence to be read as a missing row. ── -->
<Disclosure id="run-sec-acts" label={INSPECTOR_SECTIONS["run-sec-acts"].label} keywords={INSPECTOR_SECTIONS["run-sec-acts"].keywords} count={acts.length}>
  {#if acts.length === 0}
    <Answer answer={absent("no interventions recorded this session")} />
  {:else}
    <ul class="rows">
      {#each pageRows("actions", acts) as a (a.key + String(a.at))}
        <li class="row" data-outcome={a.state === "failed" ? "alarm" : "ok"}>
          <div class="row-head">
            <span class="name trunc" data-field="act-title">
              {a.title ?? `${a.block} · ${a.action} — this action's declared words are not in the loaded manifest`}
            </span>
            <span class="badge engraved">{a.state}</span>
          </div>
          <div class="row-meta mono trunc" title={`${a.block}/${a.action} · ${logTime(a.at)} · ${actLatencySay(a.latencyMs)}`}>
            {a.block}/{a.action} · {logTime(a.at)} · {actLatencySay(a.latencyMs)}
          </div>
          {#if actHasInput(a.input)}
            <div class="what" data-untrusted>
              <ToolInput input={a.input} maxLines={TOOL_CELL_FOLD_LINES} />
            </div>
          {/if}
          {#if a.consequence !== undefined}
            <div class="row-ending-quiet">{a.consequence}</div>
          {/if}
          {#if a.state === "failed"}
            <div class="row-ending" data-field="act-outcome">
              this did not go through{a.errorCode !== undefined ? ` — ${a.errorCode}` : ""}, so nothing about the run changed
            </div>
          {/if}
        </li>
      {/each}
    </ul>
    <p class="queued-line">this session's recorded interventions, newest last — a steered run shows no steer row: steers ride the transcript, not the broker's write-door log</p>
  {/if}
  {@render pageControls("actions", acts.length)}
</Disclosure>

{:else}
  <p class="queued-line">Project files and state are available here. Open a conversation for its activity and history.</p>
{/if}

<!-- ── CODEBASE — the project's measured state; open by default (a one-block
     summary, not a drilldown list). ── -->
<Disclosure id="run-sec-codebase" label={INSPECTOR_SECTIONS["run-sec-codebase"].label} keywords={INSPECTOR_SECTIONS["run-sec-codebase"].keywords} defaultOpen={!hasConversation && $currentProject !== null} onOpenChange={(open) => codebaseOpen = open}>
  {#snippet meta()}
    {#if $currentProject !== null && reindex !== null}
      <button
        class="verb "
        data-verb-id="code.map/reindex"
        title={reindex.consequence}
        onclick={() => void rereadCode()}
      >{reindex.title}</button>
    {/if}
  {/snippet}
  {#if codebase.map.kind === "pending"}
    <Answer answer={pending("reading the repository map")} />
  {:else if codebase.map.kind === "indexing"}
    <Answer answer={pending(codebase.map.reason)} />
  {:else if codebase.map.kind === "refused"}
    <Answer answer={refused(codebase.map.reason)} />
  {:else if codebase.map.kind === "absent"}
    <Answer answer={absent(codebase.map.reason)} />
  {:else if codebase.map.kind === "measured"}
    <dl class="facts">
      <div class="fact"><dt class="engraved">files</dt><dd class="mono">{fmtTokens(codebase.map.map.fileCount)}</dd></div>
      <div class="fact"><dt class="engraved">modules</dt><dd class="mono">{fmtTokens(codebase.map.map.moduleCount)}</dd></div>
      <div class="fact"><dt class="engraved">symbols</dt><dd class="mono">{fmtTokens(codebase.map.map.symbolCount)}</dd></div>
      <div class="fact"><dt class="engraved">lines</dt><dd class="mono">{fmtTokens(codebase.map.map.totalLines)}</dd></div>
      {#if codebase.map.map.languages.length > 0}
        <div class="fact">
          <dt class="engraved">languages</dt>
          <dd class="mono">
            {codebase.map.map.languages.slice(0, RUN_PANE_LANGUAGE_CAP).map((l) => `${l.extension} ×${l.fileCount}`).join(" · ")}
          </dd>
        </div>
      {/if}
    </dl>
    {#if codebase.map.map.fileCount === 0}
      <!-- THE ZERO FACE'S DISCLOSURE (UIE-086): the map counts CODE FILES
           ONLY (the language registry has no markdown/prose grammar — a
           deliberate scope, not an omission), so a project whose files are
           all prose reads honest zeros here. Bare zeros let a reader not
           tell "no code files in this project" from "the map is broken";
           this sentence states what the scan covers, in the same absence
           register every other section speaks. It renders at the zero face
           alone — a project with code lets its counts speak, and a
           not-yet-read map already states its own pending/refused/absent
           face above. True for a prose-only project AND for an empty one
           (neither holds code files), so the sentence claims nothing the
           measurement does not. -->
      <Answer answer={absent("the map reads code files only — zeros are this project's honest measurement: no code files were found, not a failed read (prose, notes and data files are not counted)")} />
    {/if}
  {/if}
  {#if codebase.git !== null && codebase.git.repository === false}
    <!-- A folder with NO repository is not a detached-HEAD repo with a clean
         tree — mapping the zeroed payload onto those words fabricated two
         facts. The honest absence, in the one owned sentence for the same
         fact (state/git.ts — the custody room and the effect beat's diff
         face render the same words). -->
    <Answer answer={absent(NOT_A_REPOSITORY)} />
  {:else if codebase.git !== null}
    <dl class="facts">
      <div class="fact">
        <dt class="engraved">branch</dt>
        <dd class="mono">{codebase.git.branch ?? "detached"}</dd>
      </div>
      <div class="fact">
        <dt class="engraved">working tree</dt>
        <dd class="mono" data-outcome={codebase.git.dirtyFiles > 0 || codebase.git.untrackedFiles > 0 ? "warn" : "ok"}>
          <!-- CLEANLINESS INCLUDES UNTRACKED: a tree holding only files
               git has never been told about is not "clean" — the API's
               own dirtyFiles deliberately excludes them, so the label
               must add what the count hides, or a fresh file reads as
               "nothing changed". -->
          {#if codebase.git.dirtyFiles === 0 && codebase.git.untrackedFiles === 0}
            clean
          {:else if codebase.git.dirtyFiles === 0}
            {codebase.git.untrackedFiles} untracked
          {:else}
            {codebase.git.dirtyFiles} changed · {codebase.git.stagedFiles} staged · {codebase.git.untrackedFiles} untracked
          {/if}
        </dd>
      </div>
    </dl>
  {:else if codebase.gitRefusal !== null}
    <!-- A refused read is NOT "not checked yet": the read was attempted and
         the server declined, with its own sentence and the way out. The
         same refusal the custody room renders verbatim for its probe. -->
    <Answer answer={refused(codebase.gitRefusal.reason)} />
  {:else if codebase.map.kind === "measured"}
    <Answer answer={absent("working tree not checked yet")} />
  {/if}
</Disclosure>

{#if hasConversation}
<!-- ── PREPARATION — the chat-wide rollups, summed across the conversation's
     turns from the SAME per-turn records the flow's footers read. Defaults
     by presence: nothing folded and nothing masked is a collapsed header,
     not two absence sentences at eye level. ── -->
<Disclosure
  id="run-sec-preparation"
  label={INSPECTOR_SECTIONS["run-sec-preparation"].label} keywords={INSPECTOR_SECTIONS["run-sec-preparation"].keywords}
  defaultOpen={preparation.dedup !== null || preparation.redaction !== null}
>
  <!-- The server sends no event when there was nothing to fold or mask, so
       each absence is the honest nothing in plain words, never a zero. -->
  {#if preparation.dedup === null}
    <Answer answer={absent("nothing folded yet")} />
  {:else}
    <dl class="facts">
      <div class="fact">
        <dt class="engraved">dedup</dt>
        <dd class="mono" data-field="dedup-rollup">{dedupSay}</dd>
      </div>
    </dl>
  {/if}
  {#if preparation.redaction === null}
    <Answer answer={absent("nothing masked yet")} />
  {:else if redactionSay === null}
    <Answer answer={absent("nothing masked yet")} />
  {:else}
    <dl class="facts">
      <div class="fact">
        <dt class="engraved">redaction</dt>
        <dd class="mono" data-field="redaction-rollup">{redactionSay}</dd>
      </div>
    </dl>
  {/if}
</Disclosure>
{/if}

<style>
  .page-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
    color: var(--ink-3);
    font-size: var(--f-micro-size);
  }
  .facts {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    margin: 0;
  }
  /* The queued-instruction line — the pane's data register, announced as
   * status so a screen reader hears that the instruction landed. */
  .queued-line {
    margin: 0 0 var(--sp-1);
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--ink-2);
    overflow-wrap: anywhere;
  }
  .fact {
    display: flex;
    align-items: baseline;
    gap: var(--sp-3);
    min-height: var(--hit-min);
  }
  .fact dt {
    flex: none;
    width: var(--run-pane-label-w);
  }
  /* THE FACT VALUE'S OWN FLEX CONTAINMENT: a `dd` in a row-flex defaults to
   * min-width:auto, so one unbreakable token (a run id, a model name, a
   * long error code) becomes the ROW's minimum width and pushes the whole
   * column sideways (the side-scrolling defect this rule kills). min-width
   * 0 lets the dd shrink; overflow-wrap anywhere lets its own text break
   * rather than overflow. The trace row's dd overrides the overflow half
   * (its value ellipsizes instead of wrapping) but keeps the shrink half. */
  .fact dd {
    margin: 0;
    font-size: var(--f-data-size);
    color: var(--ink-1);
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  /* The trace row: the value truncates, the copy affordance never does —
   * the full id is one press away even when the eye sees an ellipsis. The
   * dd keeps min-width 0 (the trace row is the one fact whose children
   * are flex items of their own — the value, the copy chip, the filter —
   * and without it the group's min-content width was the FULL run id plus
   * the controls, 602px measured against a 559px column: the menu body's
   * horizontal scrollbar). The overflow half is visible here so the
   * affordances are never cut by the row's own clipping. */
  .fact dd.trace {
    display: flex;
    align-items: baseline;
    gap: var(--sp-2);
    overflow: visible;
    text-overflow: clip;
  }
  .trace-value {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* The filter action beside the copy affordance: the owned `.verb.bare`
   * recipe (no resting hairline — the row already edges it), never cut by
   * the row's ellipsis, and the pressed state is the word itself changing
   * to "clear" plus the ink shift the pin idiom uses. */
  .trace-filter {
    flex: none;
    white-space: nowrap;
  }
  .trace-filter[aria-pressed="true"] {
    color: var(--ink-1);
  }
  .mono {
    font-family: var(--face-mono);
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .row {
    border: var(--hairline-w) solid var(--line-1);
    border-radius: var(--radius-1);
    padding: var(--sp-2);
    display: flex;
    flex-direction: column;
    gap: var(--sp-0);
    border-left: var(--focus-ring-width) solid var(--ink-4);
  }
  .row[data-outcome="working"] { border-left-color: var(--beam); }
  .row[data-outcome="ok"] { border-left-color: var(--ok); }
  .row[data-outcome="warn"] { border-left-color: var(--warn); }
  .row[data-outcome="alarm"] { border-left-color: var(--alarm); }
  .row-head {
    display: flex;
    align-items: baseline;
    gap: var(--sp-2);
    min-width: 0;
  }
  /* A row-head's own text (a name, a live-word row link) breaks rather
   * than pushes: an unbreakable event type or a long tool name at a narrow
   * overlay width wraps anywhere instead of becoming the column's minimum
   * width. The live-word recipe's own hit floor (min-width: var(--hit-min))
   * is untouched — anywhere only changes how the TEXT inside it wraps. */
  .row-head .name,
  .row-head .row-link {
    overflow-wrap: anywhere;
  }
  .name {
    font-size: var(--f-ui-size);
    color: var(--ink-1);
  }
  /* A CLICKABLE ROW HEAD — the owned live-word recipe (tokens.css
   * `.cockpit .live-word`: unboxed, dotted underline, the pointer floor,
   * the beam hover) plus this pane's own optical alignment: the pad the
   * recipe carries is negated at the lead edge so the underlined word
   * lines up with the row's own left edge. */
  .row-link {
    margin-left: calc(-1 * var(--sp-1));
    font-size: var(--f-ui-size);
    color: var(--ink-1);
  }
  .row-link.mono {
    font-family: var(--face-mono);
  }
  /* The engraved recipe is owned by tokens.css (.cockpit .engraved); the
   * badge owns the edge around the word. The badge carries a RECORDED
   * VALUE (a status, an error code), so it may hold an unbreakable
   * snake_case token: it caps at its row and wraps anywhere rather than
   * pushing the column sideways — the edge bends, the row never scrolls. */
  .badge {
    margin-left: auto;
    flex: none;
    max-width: 100%;
    border: var(--hairline-w) solid var(--line-1);
    border-radius: var(--radius-1);
    padding: 0 var(--sp-1);
    overflow-wrap: anywhere;
  }
  .row-meta {
    font-size: var(--f-nano-size);
    color: var(--ink-4);
  }
  /* The run row's own verb row — the go sits at the lead edge, the same
   * place every row's verbs live, not floated into the meta line. */
  .row-verbs {
    display: flex;
    gap: var(--sp-2);
  }
  /* The filter chips' container. The chips themselves are the ONE menu-chip
   * recipe (tokens.css .cockpit .menu-chip) — the same body the arm group's
   * insert chips and storage labels consume; the pressed grammar (the
   * brighter ink + the stronger edge) is the recipe's own aria-pressed
   * rule, so this file no longer restates a chip body at all. */
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-1);
  }
  /* The act row's input render — the same fold the flow's act beat uses.
   * min-width 0 lets the JSON tree shrink with the column; the tree's own
   * rows wrap their keys rather than becoming the column's minimum (the
   * JsonNode fix) and this box grants them the room to do it. */
  .what {
    min-width: 0;
  }
  /* The declared consequence sentence: the one part of an act row meant to
   * be read rather than scanned, so it keeps the reading face — the flow's
   * own act card rule. A long unbreakable token in it wraps anywhere; a
   * block in a column cannot be trusted to keep its own width otherwise. */
  .row-ending-quiet {
    font-family: var(--face-sans);
    font-size: var(--f-ui-size);
    color: var(--ink-2);
    overflow-wrap: anywhere;
  }
  .row-error {
    font-size: var(--f-data-size);
    color: var(--alarm);
    overflow-wrap: anywhere;
  }
  /* The interrupted turn's own ending, or the stranded call's — the quiet
   * attention register (warn ink), never the alarm of a failure the row
   * did not report. The row's outcome ink already paints its edge. */
  .row-ending {
    font-size: var(--f-data-size);
    color: var(--warn);
    overflow-wrap: anywhere;
  }
  /* A turn row carries a facts list of its own — the same label:value
   * grammar as the section-level facts, one line per measured fact, so a
   * long session reads as a ledger rather than a wall of prose. */
  .turn-facts .fact {
    min-height: 0;
  }
  [data-outcome="working"] { color: var(--beam); }
  [data-outcome="ok"] { color: var(--ok); }
  [data-outcome="warn"] { color: var(--warn); }
  [data-outcome="alarm"] { color: var(--alarm); }
</style>
