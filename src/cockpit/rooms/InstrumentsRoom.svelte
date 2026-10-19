<script lang="ts">
  /**
   * THE INSTRUMENTS ROOM (DESIGN-COCKPIT-V2 §8) — the honest index of
   * every measured signal, dark-cockpit style. ⌘' summons it; its
   * existence at `src/cockpit/rooms/InstrumentsRoom.svelte` is what makes
   * the shell's registered chord real (file-convention mount).
   *
   * One uniform grid: cells share the token-declared width and minimum height, grouped
   * by feature module under the registry's SERVED display path ("Context
   * signals", …), no gaps, no featured tiles, no ranking. The room opens
   * INSTANTLY from the served registry (<200ms law) with every cell in its
   * honest absence state; the feed's first sample fills values in place —
   * zero layout shift, absence-first.
   *
   * Verbs are resolved MECHANICALLY per cell (instruments-data.ts):
   * bounding setting → `adjust` (opens the settings surface's sheet
   * through the shell SCOPE with a plain payload; honestly disabled with
   * its reason until that sheet lands) · declared block action → the verb
   * via broker.action · always `ask` → prefills the composer's `?`
   * grammar. `pin` → HORIZON monitor (≤4; a 5th asks which to displace,
   * INLINE, not a modal). Color exists ONLY on a declared-threshold
   * crossing — the registry declares none today, so everything is quiet
   * ink, honestly.
   */
  import { onMount } from "svelte";

  import { action } from "../../data/broker.ts";
  // §6.2 honest degradation. Instrument cells are fed by the LIVE signal
  // channel, not by a ranged block read — there is no `until` to pass. So
  // while a head is planted the room says what it cannot do, once, and every
  // cell renders its absence state with that reason rather than a live
  // number under a past-view banner.
  import { isPastView, PAST_VIEW_UNSUPPORTED_SENTENCE, assertLiveForWrite, PAST_VIEW_ACT_REASON } from "../../data/asof.ts";
  import { ClientError } from "../../data/errors.ts";
  import { refusalReason } from "../../data/absence.ts";
  import { authState } from "../../state/auth.ts";
  import { executeSchemaAction } from "../../client.ts";
  import { VERB_MARK_WORD } from "../shell/verb-marks.ts";
  import { uiSchema } from "../../state/schema-store.ts";
  import type { ActionEntry } from "../../../shared/ui-schema.ts";
  import type { OutletProps } from "../shell/contract.ts";
  import { whileRoomVisible } from "../shell/room-visibility.ts";
  import {
    ACTION_ARM_WINDOW_MS,
    ACTION_RESULT_TRUNCATE_CHARS,
  } from "./instruments-config.ts";
  import {
    ACTION_CONFIRM_FACE,
    actionVerbId,
    buildGroups,
    compactActionResult,
    countInstruments,
    formatMeasuredValue,
    isTwoPressAction,
    requiredArgNames,
    resolveVerbs,
    takeActionPress,
    type ActionArm,
    type InstrumentVerb,
  } from "./instruments-data.ts";
  import Answer from "../response/Answer.svelte";
  import { failed, refused } from "../response/grammar.ts";
  import {
    acquireInstrumentsFeed,
    bindMonitorsToShell,
    collectingSince,
    displaceMonitor,
    feedRunning,
    lastFeedError,
    monitorStorageDegraded,
    pinMonitor,
    pinnedMonitors,
    signalCurrent,
    signalHistory,
    unpinMonitor,
  } from "./instruments-feed.ts";
  import {
    SHEET_SCOPE_TITLE,
    loadSettingSheet,
    settingSheetExists,
  } from "./setting-sheet-seam.ts";
  import InstrumentCell from "./InstrumentCell.svelte";
  import MonitorRef from "./Monitor.svelte";

  let { shell }: OutletProps = $props();

  /** True while the cockpit is showing a past instant (§6.2). */
  const past = $derived($isPastView);

  // ── the served registry (instant — already in the store from boot) ─────
  const schema = $derived($uiSchema);
  const groups = $derived(buildGroups(schema));
  const settings = $derived(schema?.settings ?? []);
  const manifest = $derived(schema?.blockActions);

  /** signalId → its ≤2 mechanical verbs, resolved once per schema. */
  const verbsById = $derived.by(() => {
    const map = new Map<string, readonly InstrumentVerb[]>();
    if (schema === null) return map;
    for (const s of schema.signals) map.set(s.id, resolveVerbs(s, settings, manifest));
    return map;
  });

  // ── live feed state ────────────────────────────────────────────────────
  const current = $derived($signalCurrent);
  const history = $derived($signalHistory);
  const since = $derived($collectingSince);
  const feedError = $derived($lastFeedError);
  const pinned = $derived($pinnedMonitors);
  const pinnedIds = $derived(new Set(pinned.map((m) => m.signalId)));
  // Recomputed whenever the pinned set changes — the only moment a write
  // (and therefore a storage refusal) can have happened.
  const pinNote = $derived.by(() => {
    void pinned;
    return monitorStorageDegraded();
  });

  const counts = $derived(
    countInstruments(
      schema?.signals ?? [],
      new Set(Object.keys(current)),
      feedRunning() || since !== null,
    ),
  );

  // ── setting sheet seam (the settings sibling's component) ──────────────
  const sheetAvailable = settingSheetExists();
  let SheetComp = $state<unknown | null>(null);

  onMount(() => {
    bindMonitorsToShell(shell);
    if (sheetAvailable) void loadSettingSheet().then((c) => (SheetComp = c));
    // KEPT ALIVE (shell/RoomHost.svelte): the room mounts once and is then
    // shown/hidden, so the feed hold hangs off VISIBILITY rather than mount.
    //
    // Quiet when hidden, warm when shown, and never blank in between: the
    // release stops the poll, it does not clear `signalCurrent` or
    // `signalHistory`, so every cell's last measured value stands with its own
    // asOf and the reopen paints all 112 of them in frame one. Re-acquiring
    // samples immediately, so the numbers are re-measured underneath what is
    // already on screen. (Pinned monitors hold the feed independently — the
    // HORIZON must keep updating with the room closed.)
    return whileRoomVisible("instruments", acquireInstrumentsFeed);
  });

  // ── verbs ──────────────────────────────────────────────────────────────
  let actionBusy = $state(false);

  // ── the exposure actions fold ────────────────────────────────────────────
  //
  // Each module group that DECLARES exposure actions folds them under its
  // grid, and the fold's verbs execute through the ONE wire door
  // (client.ts executeSchemaAction → POST /api/schema/ui/actions/:id,
  // admin-only by the route's own gate). The derivation is from the SERVED
  // schema — never a hand list — so all 64 backend exposure actions (and
  // any the schema serves beside them) appear with no edit here.

  /** Open folds, per module (collapsed by default — the fold is the room's
   * secondary surface; the grid is what it opens for). */
  let openFolds = $state<ReadonlySet<string>>(new Set());
  /** The ONE armed destructive verb (two-press grammar; a different press
   * re-arms). */
  let armedAction = $state<ActionArm | null>(null);
  /** Actions currently executing — the honest busy face, per verb. */
  let busyActions = $state<ReadonlySet<string>>(new Set());
  /** The last outcome line per action id: done (role=status), or the
   * refusal/failure the answer grammar renders. */
  type ActionNote =
    | Readonly<{ kind: "ok"; line: string }>
    | Readonly<{ kind: "refused"; reason: string }>
    | Readonly<{ kind: "failed"; reason: string }>;
  let actionNotes = $state<Record<string, ActionNote>>({});

  function toggleFold(module: string): void {
    const next = new Set(openFolds);
    if (next.has(module)) next.delete(module);
    else next.add(module);
    openFolds = next;
    // Opening a fold disarms any armed verb from another: the reader has
    // moved to a different surface, and an armed control that survives the
    // move is a trap for the next press.
    armedAction = null;
  }

  function disarmAction(): void {
    armedAction = null;
  }

  /** Why THIS action verb cannot fire from the fold right now, or null. */
  function actionBlockedReason(entry: ActionEntry): string | null {
    if (past) return PAST_VIEW_ACT_REASON;
    if (!$authState.isAdmin) {
      return "the exposure wire door is admin-only — sign in as the admin to run module actions";
    }
    const required = requiredArgNames(entry);
    if (required.length > 0) {
      return `needs ${required.join(", ")} — an action with required arguments runs from its own caller, not a bare press`;
    }
    return null;
  }

  function noteAction(id: string, note: ActionNote): void {
    actionNotes = { ...actionNotes, [id]: note };
  }

  async function runAction(entry: ActionEntry): Promise<void> {
    if (busyActions.has(entry.id)) return;
    busyActions = new Set([...busyActions, entry.id]);
    try {
      // An exposure action is a WRITE against the live harness (the route
      // records it in the ledger like every act); a planted past view is
      // read-only, so the door asserts here — the disabled face above is
      // the courtesy, this is the promise (the RunPane stop's precedent).
      assertLiveForWrite();
      const result = await executeSchemaAction(entry.id);
      noteAction(entry.id, {
        kind: "ok",
        line: `${entry.label} — done · ${compactActionResult(result, ACTION_RESULT_TRUNCATE_CHARS)}`,
      });
      armedAction = null;
    } catch (err) {
      // The wire door's own refusal (unknown action, a refused execution) is
      // an honest answer in the grammar's vocabulary; only a genuinely
      // broken attempt is a failure. Both render on the fold's answer line.
      const reason = refusalReason(err);
      if (reason !== null) noteAction(entry.id, { kind: "refused", reason });
      else {
        noteAction(entry.id, {
          kind: "failed",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      const next = new Set(busyActions);
      next.delete(entry.id);
      busyActions = next;
    }
  }

  function pressAction(entry: ActionEntry): void {
    if (actionBlockedReason(entry) !== null) return;
    if (!isTwoPressAction(entry.id)) {
      void runAction(entry);
      return;
    }
    // TWO-PRESS (the recycle confirm's rule): the first press arms — the
    // face changes to the confirm word and nothing fires — and only a
    // second press of the SAME verb inside the window fires.
    const { arm, fire } = takeActionPress(armedAction, { id: entry.id }, Date.now());
    armedAction = arm;
    if (fire) void runAction(entry);
  }

  // ── THE WINDOW THE DISARM TITLE PROMISES, KEPT ────────────────────────────
  //
  // "an armed action … reverts on its own after 4s" — the disarm verb's own
  // title and the two-press window (ACTION_ARM_WINDOW_MS) said this for two
  // rounds while no timer existed anywhere in the arm path: an armed
  // destructive confirm sat armed FOREVER, and a reader returning to the
  // fold minutes later fired the action with one press believing it fresh
  // (UIE-007). The timer is the arm's shadow: one per armed verb, restarted
  // by a re-arm (the effect re-runs on the new arm object), taken back by
  // every path that disarms (the verb, a fold move, a fired run — each sets
  // `armedAction` to null, which re-runs this effect into its no-timer
  // branch), and torn down with the room on unmount. It counts from the
  // ARM's own clock, not from the effect's — the same clock the second
  // press is judged by, so the face reverts exactly when the window the
  // title names has passed.
  $effect(() => {
    const armed = armedAction;
    if (armed === null) return;
    const left = Math.max(0, ACTION_ARM_WINDOW_MS - (Date.now() - armed.armedAt));
    const timer = setTimeout(() => {
      armedAction = null;
    }, left);
    return () => clearTimeout(timer);
  });

  // No `signalId` parameter: every branch below acts on the VERB's own
  // declared payload (its prefill, its customization id, its block action),
  // so the signal it came from was passed in and never read.
  async function runVerb(verb: InstrumentVerb): Promise<void> {
    if (verb.kind === "ask") {
      // The reference gesture: leave the index, land in the composer with
      // the `?` grammar prefilled — the composer's own hint enumerates
      // what is computable from there.
      shell.closeRoom();
      shell.prefillComposer(verb.prefill);
      return;
    }
    if (verb.kind === "adjust") {
      if (SheetComp === null) return; // honestly disabled upstream
      // The settings sibling's published payload: `{ settingId }` — the
      // served customization id our MECHANICAL resolution produced.
      shell.openScope({
        title: SHEET_SCOPE_TITLE,
        component: SheetComp,
        props: { settingId: verb.customizationId },
      });
      return;
    }
    // verb.kind === "action" — the declared block action, via the Broker.
    if (actionBusy) return;
    actionBusy = true;
    try {
      await action(verb.blockId, verb.actionName, verb.input, {
        invalidates: verb.invalidates,
      });
      shell.hint(`${verb.label} — done, recorded`);
    } catch (err) {
      shell.hint(
        err instanceof ClientError
          ? `${verb.label} — refused: ${err.message}`
          : `${verb.label} — did not reach the server`,
      );
    } finally {
      actionBusy = false;
    }
  }

  // ── pin flow (≤4; the 5th asks INLINE which to displace) ──────────────
  let displaceAskFor = $state<string | null>(null);

  function onPin(signalId: string): void {
    if (pinnedIds.has(signalId)) {
      unpinMonitor(signalId);
      if (displaceAskFor === signalId) displaceAskFor = null;
      return;
    }
    const outcome = pinMonitor(signalId);
    if (outcome === "full") displaceAskFor = signalId;
  }

  function displaceWith(oldId: string): void {
    if (displaceAskFor === null) return;
    displaceMonitor(oldId, displaceAskFor);
    displaceAskFor = null;
  }

  function monitorLabel(signalId: string): string {
    return schema?.signals.find((s) => s.id === signalId)?.name ?? signalId;
  }

  function monitorValue(signalId: string): string {
    const s = current[signalId];
    if (s === undefined) return "collecting";
    const meta = schema?.signals.find((x) => x.id === signalId);
    // Same formatter as the cell — the monitor is a reference to the same
    // measured fact, never a second derivation.
    return meta === undefined ? String(s.v) : formatMeasuredValue(s.v, meta.type, meta.unit);
  }
</script>

<div class="instruments" data-room="instruments">
  {#if past}
    <p class="past-note" role="status">
      these instruments read the live signal channel — {PAST_VIEW_UNSUPPORTED_SENTENCE}
    </p>
  {/if}
  <header class="strip">
    <span class="counts" aria-live="polite">
      {#if schema === null}
        signal registry not loaded — the boot column reports schema availability
      {:else}
        {counts.declared} signals declared
        · {counts.measured} measured
        {#if counts.collecting > 0}· {counts.collecting} collecting{/if}
        {#if counts.notMeasured > 0}· {counts.notMeasured} not measured yet{/if}
      {/if}
    </span>
    {#if feedError !== null}
      <span class="feed-error">signal channel {feedError}</span>
    {/if}
    {#if pinNote !== null}
      <!-- A degradation that stayed silent would be the HORIZON lying
           about durability — the pins are real, their persistence is not. -->
      <span class="feed-error">pins last this session only — {pinNote}</span>
    {/if}
  </header>

  {#if displaceAskFor !== null}
    <!-- INLINE displace ask (§8.2) — a strip in the room's own flow, not a
         modal: 4 monitors are pinned; picking one swaps it for the new pin. -->
    <div class="displace" data-displace-ask>
      <span class="ask-words">
        4 monitors pinned — pick one to hand its slot to “{monitorLabel(displaceAskFor)}”:
      </span>
      {#each pinned as m (m.signalId)}
        <MonitorRef
          label={monitorLabel(m.signalId)}
          value={monitorValue(m.signalId)}
          asOf={current[m.signalId]?.t ?? since ?? m.pinnedAt}
          points={history[m.signalId] ?? []}
          verbId="instruments.displace"
          onOpen={() => displaceWith(m.signalId)}
        />
      {/each}
      <button
        class="verb cancel"
        data-verb-id="instruments.displace-cancel"
        aria-label={VERB_MARK_WORD.cancel}
        title="keep as is"
        onclick={() => (displaceAskFor = null)}
      >{VERB_MARK_WORD.cancel}</button>
    </div>
  {/if}

  {#each groups as group (group.module)}
    <section class="module" aria-label={group.title}>
      <h2 class="module-title engraved">{group.title}</h2>
      <div class="grid">
        {#each group.signals as signal (signal.id)}
          <InstrumentCell
            {signal}
            sample={current[signal.id]}
            points={history[signal.id] ?? []}
            verbs={verbsById.get(signal.id) ?? []}
            collectingSince={since}
            pastReason={past ? PAST_VIEW_UNSUPPORTED_SENTENCE : null}
            pinned={pinnedIds.has(signal.id)}
            sheetAvailable={sheetAvailable && SheetComp !== null}
            onVerb={(verb) => void runVerb(verb)}
            onPin={() => onPin(signal.id)}
          />
        {/each}
      </div>
      {#if group.actions.length > 0}
        <!-- THE EXPOSURE ACTIONS FOLD — the module's "act on the system"
             surface, derived from the served schema (never a hand list). The
             verbs wear the served labels; the press grammar is two-shaped
             (destructive verbs confirm with a second press, safe ones fire);
             the outcome renders on the fold's own answer line. -->
        <div class="actions-fold" data-actions-fold={group.module}>
          <button
            class="fold-head"
            type="button"
            data-verb-id="instruments.actions/fold"
            aria-expanded={openFolds.has(group.module)}
            title="the actions this module exposes — they run against the live harness and are recorded"
            onclick={() => toggleFold(group.module)}
          >{openFolds.has(group.module) ? "▾" : "▸"} actions ({group.actions.length})</button>
          {#if openFolds.has(group.module)}
            <ul class="action-list">
              {#each group.actions as entry (entry.id)}
                {@const blocked = actionBlockedReason(entry)}
                {@const note = actionNotes[entry.id]}
                {@const armed = armedAction?.id === entry.id}
                <li class="action-row" data-action-id={entry.id}>
                  <button
                    class="verb"
                    type="button"
                    data-verb-id={actionVerbId(entry.id)}
                    data-state={armed ? "armed" : undefined}
                    disabled={blocked !== null || busyActions.has(entry.id)}
                    title={blocked
                      ?? (isTwoPressAction(entry.id)
                        ? `${entry.description} — press twice: the first press arms it, the second runs it`
                        : entry.description)}
                    onclick={() => pressAction(entry)}
                  >{busyActions.has(entry.id)
                    ? `${entry.label}…`
                    : armed
                      ? ACTION_CONFIRM_FACE
                      : entry.label.toLowerCase()}</button>
                  {#if note !== undefined}
                    {#if note.kind === "ok"}
                      <p class="act-line" role="status">{note.line}</p>
                    {:else if note.kind === "refused"}
                      <p class="act-line" role="alert">
                        <Answer as="inline" answer={refused(note.reason)} />
                      </p>
                    {:else}
                      <p class="act-line" role="alert">
                        <Answer as="inline" answer={failed(`${entry.label} did not run — ${note.reason}`)} />
                      </p>
                    {/if}
                  {:else if blocked !== null}
                    <span class="act-reason">{blocked}</span>
                  {/if}
                </li>
              {/each}
            </ul>
            {#if group.actions.some((a) => isTwoPressAction(a.id))}
              <button
                class="verb bare quiet"
                type="button"
                data-verb-id="instruments.actions/disarm"
                title={`an armed action runs on its second press and reverts on its own after ${Math.round(ACTION_ARM_WINDOW_MS / 1000)}s — this puts it back now, without running anything`}
                onclick={disarmAction}
              >{VERB_MARK_WORD.cancel}</button>
            {/if}
          {/if}
        </div>
      {/if}
    </section>
  {/each}
</div>

<style>
  .instruments {
    width: 100%;
    max-width: var(--instruments-max-w);
    margin: 0 auto;
    padding: var(--sp-4) var(--gutter-bleed) var(--sp-7);
    display: flex;
    flex-direction: column;
    gap: var(--sp-5);
    align-self: start;
  }
  .strip {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--sp-3);
  }
  .counts {
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--ink-3);
  }
  .past-note {
    margin: 0;
    font-size: var(--f-ui-size);
    color: var(--warn);
  }
  .feed-error {
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--ink-4);
  }
  .displace {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--sp-2);
    padding: var(--sp-2) var(--sp-3);
    border: var(--hairline-w) solid var(--line-2);
    border-radius: var(--radius-1);
    background: var(--ground-1);
  }
  .ask-words {
    font-size: var(--f-ui-size);
    color: var(--ink-1);
  }
  .module {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  /* The actions fold — the module's secondary surface under its grid. The
   * head is a quiet row (mono micro register); the list is one row per
   * action: the verb, then its outcome line when it has one. */
  .actions-fold {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }
  .fold-head {
    align-self: flex-start;
    padding: 0;
    border: none;
    background: none;
    cursor: pointer;
    font-family: var(--face-mono);
    font-size: var(--f-micro-size);
    color: var(--ink-4);
  }
  .fold-head:hover {
    color: var(--ink-2);
  }
  .action-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }
  .action-row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--sp-2);
  }
  .act-line {
    margin: 0;
    min-width: 0;
    font-family: var(--face-mono);
    font-size: var(--f-micro-size);
    color: var(--ink-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
  .act-reason {
    font-size: var(--f-micro-size);
    color: var(--ink-4);
  }
  /* The engraved recipe is owned by tokens.css (.cockpit .engraved). */
  .module-title {
    margin: 0;
  }
  /* Shared-width cells grow vertically with their real content. */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, var(--instrument-w)), 1fr));
    gap: 0;
  }
</style>
