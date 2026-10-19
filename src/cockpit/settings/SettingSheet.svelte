<script lang="ts">
  /**
   * THE SETTING SHEET (DESIGN-COCKPIT-V2 §9.1): the ONE sheet primitive.
   * A one-setting mini-sheet: served label, served consequence description,
   * the control (drag-scrub numeral / segmented enum / switch), the current
   * MEASURED effect where one genuinely exists, and save through the
   * settings block's declared action: the validated choke point.
   *
   * ── OPEN CONTRACT (for desk / instruments / flow siblings) ─────────────
   * Render an `adjust` verb next to any fact, and on press open this sheet
   * through the shell SCOPE:
   *
   *   import { openSettingSheet, openSettingForSignal } from
   *     "../settings/open.ts";
   *   openSettingSheet(shell, "tools.parallelCap");     // by customization id
   *   openSettingForSignal(shell, "context.utilization"); // by linked signal
   *
   * or directly:
   *
   *   shell.openScope({
   *     title: "adjust",
   *     component: SettingSheet,        // ../settings/SettingSheet.svelte
   *     props: { settingId: "<customizationId | cockpit.density | cockpit.theme>" },
   *   });
   *
   * PAYLOAD SHAPE: `{ settingId: string }`: a served customization id from
   * the exposure registry, or a cockpit-local preference id
   * (settings/local-prefs.ts). Nothing else; the sheet resolves everything
   * (words, bounds, current value, measured effect) from the SERVED schema.
   * The fact→setting mapping is mechanical (settings-data.ts registry
   * linkage): never hand-wire a fact to a setting id that the registry does
   * not link.
   *
   * The index (⌘, SettingsRoom) renders THIS SAME component inline per row
   * (`inline` prop only changes spacing): §9.3: no duplicated controls.
   *
   * WRITE PATH: every served change goes through settings-feed.saveSetting →
   * `broker.action("settings.customizations","set")`. Optimistic (the chosen
   * value paints immediately), read back (the row's value is the server's
   * answer after `settings:changed` re-reads), and an out-of-contract value
   * renders the server's own 400 sentence plainly. Local preferences write
   * through local-prefs.setLocalPref (device-side, same refusal semantics).
   */
  // §6.2: saving a setting is a write, refused from a past view.
  import { isPastView, PAST_VIEW_ACT_REASON } from "../../data/asof.ts";
  import { onMount, tick } from "svelte";

  import { uiSchema, uiSchemaValues } from "../../state/schema-store.ts";
  import { ClientError } from "../../data/errors.ts";
  import { logTime } from "../shell/config.ts";
  import { becauseChanged, moves, type MovesParam } from "../motion/motion.ts";
  import {
    effectLine as effectTimingLine,
    formatSetting,
    labelViolation,
    optionViolation,
    measuredEffect,
    sameSettingValue as sameValue,
    saveDescriptor,
    servedCustomizationEntry,
    servedRow,
    type SettingRow,
    type SettingValue,
  } from "./settings-data.ts";
  import {
    LOCAL_ROWS,
    cockpitLocalEpoch,
    localValue,
    setLocalPref,
  } from "./local-prefs.ts";
  import { NUMERAL_SCRUB_PX_PER_STEP } from "./settings-config.ts";
  import {
    bindSettingsReadback,
    requestSettingsData,
    saveSetting,
    settingsLoadState,
    settingsWrites,
  } from "./settings-feed.ts";
  import Answer from "../response/Answer.svelte";
  import { absent, failed, pending } from "../response/grammar.ts";
  // The READ view of an object value is the same collapsible tree every
  // other JSON in the product wears: one renderer, recorded key order,
  // honest fold counts, through the render layer's public door. Only the
  // DRAFT stays raw text.
  import JsonView from "../render/JsonView.svelte";

  let {
    settingId,
    inline = false,
  }: { settingId: string; inline?: boolean } = $props();

  // ── resolution (served words only: render boundary throws on raw keys) ─
  const localRow = $derived(LOCAL_ROWS.find((r) => r.id === settingId) ?? null);
  const row = $derived.by((): SettingRow | null => {
    if (localRow !== null) return localRow;
    return servedRow($uiSchema, settingId);
  });

  // The raw-key law, enforced at the render boundary (mutation-tested): a
  // row whose label is a raw registry key must never paint as a name.
  const label = $derived.by(() => {
    if (row === null) return "";
    const violation = labelViolation(row.label, row.id);
    if (violation !== null) {
      throw new ClientError("cockpit_contract", `${violation}: the index speaks behavior words, never raw keys (§9.3)`);
    }
    return row.label;
  });

  /**
   * The row's choices, at the same render boundary and by the same law as the
   * label above: a member the derivation genuinely cannot spell (a dotted
   * internal id, a token with no letters) must be LOUD here rather than
   * painted as a button someone is expected to choose. Only this sheet
   * refuses; the index still lists the row, exactly as it does for a bad
   * label: a violation costs one sheet, not the settings room.
   */
  const spelledOptions = $derived.by(() => {
    const options = row?.options ?? [];
    for (const option of options) {
      const violation = optionViolation(option.value);
      if (violation !== null) {
        throw new ClientError(
          "cockpit_contract",
          `${violation}: a choice is offered in words or not at all (§9.3)`,
        );
      }
    }
    return options;
  });

  // Local atoms subscribed so local rows read back live.
  const localCurrent = $derived.by(() => {
    void $cockpitLocalEpoch;
    return localRow === null ? null : localValue(settingId);
  });

  // The values snapshot's own entry for this row: ONE lookup, so the value
  // and the server's masked flag can never disagree. Local rows have no
  // entry (device state, nothing served).
  const servedEntry = $derived(
    localRow !== null ? null : servedCustomizationEntry($uiSchemaValues, settingId),
  );

  /** The server's (or device's) current answer: the read-back truth. */
  const current = $derived.by((): SettingValue | undefined => {
    if (localRow !== null) return localCurrent ?? undefined;
    return servedEntry?.value;
  });

  /** The server's own word that the wire serves this standing value in its
   * masked form: the served value is a display, never a draft. */
  const currentMasked = $derived(servedEntry?.masked === true);

  const descriptor = $derived(localRow !== null ? null : saveDescriptor($uiSchema));
  const effectLine = $derived(
    localRow !== null ? null : measuredEffect($uiSchema, $uiSchemaValues, settingId),
  );
  const load = $derived($settingsLoadState);

  // ── save machine ────────────────────────────────────────────────────────
  type SaveState =
    | { kind: "idle" }
    | { kind: "saving"; revision: number }
    | { kind: "saved"; atMs: number }
    | { kind: "failed"; message: string; unconfirmedRevision?: number };
  let save = $state<SaveState>({ kind: "idle" });
  // Shared ownership survives closing or replacing this editor. Validation
  // feedback and continued drafting cannot release an unresolved request.
  const saving = $derived($settingsWrites.get(settingId)?.kind === "pending");
  const uncertain = $derived($settingsWrites.get(settingId)?.kind === "uncertain");

  /** Optimistic paint: the chosen value, until the read-back replaces it.
   * For a value the display egress hides, the paint becomes the server's own
   * masked read-back the moment the save answers: the raw never stays on
   * screen after the server hid it. */
  let chosen = $state<SettingValue | null>(null);
  let chosenMasked = $state(false);
  const displayed = $derived(chosen ?? current);
  /** What the reader sees is the masked form: a display, never a draft. */
  const displayedMasked = $derived(chosen !== null ? chosenMasked : currentMasked);

  // Read-back reconciliation: when the store's answer catches up with the
  // optimistic choice, the choice has served its purpose. A masked save
  // needs no special case here: its paint IS the server's read-back form,
  // so the re-read answers equal and clears it like any other.
  $effect(() => {
    if (chosen !== null && current !== undefined && sameValue(current, chosen)) {
      chosen = null;
      chosenMasked = false;
    }
  });

  let saveGeneration = 0;
  $effect(() => {
    void settingId;
    saveGeneration += 1;
    save = { kind: "idle" };
    chosen = null;
    chosenMasked = false;
    draft = null;
    draftRevision += 1;
    return () => { saveGeneration += 1; };
  });

  async function commit(value: SettingValue): Promise<boolean> {
    if (row === null || past || saving) return false;
    const targetId = row.id;
    const generation = ++saveGeneration;
    const revision = draftRevision;
    let changed = true;
    save = { kind: "saving", revision };
    chosen = value; // optimistic: the gesture paints in the same frame
    chosenMasked = false;
    try {
      if (row.kind === "local") {
        setLocalPref(row.id, String(value));
      } else {
        const answer = await saveSetting(targetId, value);
        if (generation !== saveGeneration || settingId !== targetId) return false;
        changed = answer.saved;
        if (answer.value !== undefined) {
          // The egress hides what was saved, and the answer carries the
          // read-back in the form the wire serves it: the paint becomes the
          // masked form, so "the value shown is the server's read-back" is
          // true from the moment the note renders.
          chosen = answer.value;
          chosenMasked = answer.masked === true;
        }
      }
      if (generation !== saveGeneration || settingId !== targetId) return false;
      if (draftRevision === revision) draft = null;
      save = changed ? { kind: "saved", atMs: Date.now() } : { kind: "idle" };
      return true;
    } catch (err) {
      if (generation !== saveGeneration || settingId !== targetId) return false;
      chosen = null; // Return to the last confirmed read, without claiming rollback.
      chosenMasked = false;
      const message =
        err instanceof ClientError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      save = { kind: "failed", message, ...(err instanceof ClientError && err.code === "setting_save_unconfirmed" ? { unconfirmedRevision: revision } : {}) };
      return false;
    }
  }

  // ── typed drafts (number / string / object commit on the save verb) ─────
  let draft = $state<string | null>(null);
  let draftRevision = 0;
  $effect(() => {
    if (save.kind === "failed" && save.unconfirmedRevision !== undefined && !uncertain && !saving) {
      if (draftRevision === save.unconfirmedRevision) draft = null;
      save = { kind: "idle" };
    }
  });
  function setDraft(value: string): void { draft = value; draftRevision += 1; }
  const draftShown = $derived.by(() => {
    if (draft !== null) return draft;
    if (row === null) return "";
    // A masked standing value never enters an editable field: prefilled, an
    // edit would send the mask itself back as the new value. The masked
    // form stands in the placeholder (and the reading line above), and the
    // draft starts empty: the only thing a save can send is what was
    // actually typed.
    if (displayedMasked) return "";
    if (row.type === "object") {
      try {
        return displayed === undefined ? "" : JSON.stringify(displayed, null, 2);
      } catch {
        return "";
      }
    }
    return displayed === undefined ? "" : String(displayed);
  });
  const dirty = $derived(
    row !== null && displayed !== undefined &&
      ((draft !== null && draft !== String(displayed)) || (uncertain && !displayedMasked)),
  );
  const pendingNewerDraft = $derived(saving && draft !== null && (save.kind !== "saving" || save.revision !== draftRevision));
  const commitState = $derived(saving ? "pending" : save.kind === "failed" || uncertain ? "failed" : dirty ? "draft" : save.kind === "saved" ? "saved" : "unchanged");
  // Correction is derived from the declared numeric domain, never from an error string.
  const numericCorrection = $derived.by(() => {
    if (row?.type !== "number" || save.kind !== "failed" || draft === null) return null;
    const n = Number(draft);
    if (!Number.isFinite(n)) return "Enter a number.";
    if (row.min !== undefined && n < row.min) return `Enter ${row.min} or more.`;
    if (row.max !== undefined && n > row.max) return `Enter ${row.max} or less.`;
    return null;
  });
  const confirmationMotion = $derived< MovesParam >(save.kind === "saved" ? { motion: "arrive", cause: becauseChanged("setting confirmed", null, save.atMs) } : null);

  function commitDraft(): void {
    if (row === null || past || !dirty || saving || (draft === null && (!uncertain || displayedMasked))) return;
    const text = draft ?? draftShown;
    if (row.type === "number") {
      const num = Number(text);
      if (!Number.isFinite(num)) {
        save = { kind: "failed", message: `"${draft}" is not a number: nothing saved` };
        return;
      }
      void commit(num);
      return;
    }
    if (row.type === "object") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        save = { kind: "failed", message: "that is not valid JSON: nothing saved" };
        return;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        save = { kind: "failed", message: "this setting holds a JSON object: nothing saved" };
        return;
      }
      void commit(parsed as Readonly<Record<string, unknown>>);
      return;
    }
    void commit(text);
  }

  // ── drag-scrub numeral (§9.1): pointer capture, step by declared range ─
  const step = $derived.by(() => {
    if (row === null || row.type !== "number") return 1;
    if (row.min !== undefined && row.max !== undefined) {
      const range = row.max - row.min;
      if (range <= 1) return 0.01;
      if (range <= 10) return 0.1;
    }
    return 1;
  });

  let scrub: { startX: number; startValue: number } | null = null;

  function scrubStart(ev: PointerEvent): void {
    if (row === null || row.type !== "number") return;
    const base = draft !== null ? Number(draft) : typeof displayed === "number" ? displayed : NaN;
    if (!Number.isFinite(base)) return; // no value yet: nothing honest to scrub from
    scrub = { startX: ev.clientX, startValue: base };
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  }

  function scrubMove(ev: PointerEvent): void {
    if (scrub === null || row === null) return;
    const moved = Math.round((ev.clientX - scrub.startX) / NUMERAL_SCRUB_PX_PER_STEP);
    let next = scrub.startValue + moved * step;
    next = Math.round(next / step) * step;
    next = Number(next.toFixed(4));
    if (row.min !== undefined) next = Math.max(row.min, next);
    if (row.max !== undefined) next = Math.min(row.max, next);
    setDraft(String(next));
  }

  function scrubEnd(): void {
    scrub = null;
  }

  function nudge(ev: KeyboardEvent): void {
    if (row === null || row.type !== "number") return;
    if (ev.key !== "ArrowUp" && ev.key !== "ArrowDown") return;
    ev.preventDefault();
    const base = draft !== null ? Number(draft) : typeof displayed === "number" ? displayed : NaN;
    if (!Number.isFinite(base)) return;
    let next = base + (ev.key === "ArrowUp" ? step : -step);
    next = Number(next.toFixed(4));
    if (row.min !== undefined) next = Math.max(row.min, next);
    if (row.max !== undefined) next = Math.min(row.max, next);
    setDraft(String(next));
  }

  const boundsLine = $derived.by(() => {
    if (row === null || row.type !== "number") return null;
    const unit = row.unit !== undefined ? ` ${row.unit}` : "";
    if (row.min !== undefined && row.max !== undefined)
      return `${row.min}–${row.max}${unit}`;
    if (row.min !== undefined) return `at least ${row.min}${unit}`;
    if (row.max !== undefined) return `at most ${row.max}${unit}`;
    return unit.length > 0 ? `in ${row.unit}` : null;
  });

  let sheetElement: HTMLDivElement | undefined;
  async function resetDefault(): Promise<void> {
    if (row === null || past || saving) return;
    const focused = document.activeElement;
    const owned = focused instanceof HTMLElement && sheetElement?.contains(focused);
    const operation = commit(row.defaultValue);
    await tick();
    if (owned && !focused.isConnected && document.activeElement === document.body) {
      sheetElement?.querySelector<HTMLElement>("input, textarea, [role=radio], [role=switch]")?.focus();
    }
    await operation;
  }

  const atDefault = $derived(row !== null && current !== undefined && sameValue(current, row.defaultValue));
  const hasDetails = $derived(boundsLine !== null || effectLine !== null || save.kind === "saved");
  const showReset = $derived(
    row !== null &&
      displayed !== undefined &&
      !sameValue(displayed, row.defaultValue) &&
      (row.kind === "local" || descriptor !== null),
  );

  onMount(() => {
    // Local preferences are device state: no wire, nothing to bind.
    // INLINE sheets ride the INDEX's load + read-back binding (the room owns
    // both); binding again here would issue a second identical values read
    // per open row for the same news.
    if (localRow !== null || inline) return undefined;
    // A standalone open re-reads the values snapshot: what the sheet shows
    // must be the server's CURRENT answer, not a stale poll (§9.3).
    void requestSettingsData();
    return bindSettingsReadback();
  });

  /** True while the cockpit is showing a past instant: no writes possible. */
  const past = $derived($isPastView);
</script>

<div class="sheet" bind:this={sheetElement} class:inline data-setting-sheet data-setting={settingId} data-edit-state={commitState}>
  {#if row === null}
    {#if load.kind === "pending"}
      <Answer answer={pending("reading the served settings")} />
    {:else if load.kind === "failed"}
      <Answer answer={failed(`settings not readable: ${load.reason}`)} />
    {:else}
      <Answer answer={absent(`no setting named “${settingId}” is served: nothing to adjust`)} />
    {/if}
  {:else}
    {#if !inline}
      <header class="head">
        <h2 class="sheet-title">{label}</h2>
      </header>
    {/if}
    <div class="setting-workspace">
    <div class="edit-band" class:numeric-edit={row.type === "number"} class:direct-choice={row.type === "boolean" || row.type === "enum"}>
      <div class="edit-value">
    {#if row.type === "enum"}
      <!-- WORDS ON THE BUTTON, the token on the wire. `option.words` is the
           derivation (settings-data.ts::optionWords); `option.value` is what
           the write sends. The two are different fields precisely so that
           rendering the wrong one is a thing you have to type, not a thing you
           forget: this control used to render `{option}` over a
           `readonly string[]` and a reader chose between `round-robin` and
           `fifo`. The `title` carries the token, because someone reading a log
           or a curl transcript still needs to connect the two. -->
      <div class="segmented" role="radiogroup" aria-label={label}>
        {#each spelledOptions as option (option.value)}
          <button
            class="verb segment"
            aria-busy={saving}
            class:selected={displayed === option.value}
            role="radio"
            aria-checked={displayed === option.value}
            data-verb-id={row.kind === "local" ? "cockpit.pref/set" : "settings.customizations/set"}
            disabled={past || (row.kind === "served" && descriptor === null)}
            aria-disabled={past || saving || (row.kind === "served" && descriptor === null)}
            title={past ? PAST_VIEW_ACT_REASON : `sends “${option.value}”`}
            onclick={() => void commit(option.value)}
          >{option.words}</button>
        {/each}
      </div>
    {:else if row.type === "boolean"}
      <button
        class="verb state-control"
        aria-busy={saving}
        role="switch"
        aria-label={label}
        aria-checked={displayed === true}
        data-verb-id={row.kind === "local" ? "cockpit.pref/set" : "settings.customizations/set"}
        disabled={past || displayed === undefined || (row.kind === "served" && descriptor === null)}
        aria-disabled={past || saving || displayed === undefined || (row.kind === "served" && descriptor === null)}
        title={past ? PAST_VIEW_ACT_REASON : undefined}
        onclick={() => void commit(!(displayed === true))}
      >
        <span class="state-path" aria-hidden="true"></span>
      </button>
    {:else if row.type === "number"}
      <div class="numeral-row">
        <input
          class="field numeral"
          type="text"
          name={row.id}
          inputmode="decimal"
          aria-invalid={numericCorrection !== null}
          aria-describedby={numericCorrection !== null ? `${settingId}-correction` : undefined}
          aria-label={label}
          value={draftShown}
          onpointerdown={scrubStart}
          onpointermove={scrubMove}
          onpointerup={scrubEnd}
          onpointercancel={scrubEnd}
          onkeydown={(ev) => {
            if (ev.isComposing || ev.keyCode === 229) return;
            nudge(ev);
            if (ev.key === "Enter") commitDraft();
          }}
          oninput={(ev) => setDraft(ev.currentTarget.value)}
          title="drag sideways to scrub · ↑↓ to step · type to set"
        />
        {#if row.unit !== undefined}<span class="unit">{row.unit}</span>{/if}
      </div>
    {:else if row.type === "string"}
      <input
        class="field text-field"
        type="text"
        onkeydown={event => { if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) commitDraft(); }}
        name={row.id}
        aria-label={label}
        value={draftShown}
        placeholder={displayedMasked && displayed !== undefined ? formatSetting(row, displayed) : undefined}
        oninput={(ev) => setDraft(ev.currentTarget.value)}
      />
    {:else}
      <!-- The STANDING value, readable: the collapsible tree the rest of
           the product renders JSON with. The textarea below is the DRAFT:
           raw text is the honest editor for JSON until a structured one
           exists, and the two answer different questions (what stands vs
           what you are about to send), so both render. -->
      {#if displayed !== undefined && typeof displayed === "object" && displayed !== null}
        <div class="object-read" aria-label={`${label}: current value`}>
          <JsonView value={displayed} />
        </div>
      {/if}
      <textarea
        class="field object-field"
        name={row.id}
        aria-label={label}
        rows="6"
        value={draftShown}
        placeholder={displayedMasked && displayed !== undefined
          ? "the standing value is partly hidden: type the whole object to replace it"
          : undefined}
        oninput={(ev) => setDraft(ev.currentTarget.value)}
      ></textarea>
    {/if}

      </div>
      <div class="footer">
      {#if row.kind === "local" && (row.type === "number" || row.type === "string")}
        <button
          class="verb save primary commit" aria-busy={saving} data-commit-state={commitState}
          data-verb-id="cockpit.pref/set"
          disabled={past}
          aria-disabled={past || !dirty || saving}
          title={past
            ? PAST_VIEW_ACT_REASON
            : !dirty
              ? "nothing changed yet: edit the value first"
              : undefined}
          onclick={commitDraft}
        ><span class="commit-copy"><strong>{saving ? "Saving…" : commitState === "saved" ? "Saved" : "Save"}</strong></span><span class="commit-mark" use:moves={confirmationMotion} aria-hidden="true"></span></button>
      {/if}

      {#if row.kind === "served" && (row.type === "number" || row.type === "string" || row.type === "object")}
        {#if descriptor !== null}
          <button
            class="verb save primary commit" aria-busy={saving} data-commit-state={commitState}
            data-verb-id="settings.customizations/set"
            aria-describedby={`${settingId}-save-help`}
            disabled={past}
          aria-disabled={past || !dirty || saving}
            title={past
              ? PAST_VIEW_ACT_REASON
              : saving
                ? "saving now"
                : !dirty
                  ? "nothing changed yet: edit the value first"
                  : undefined}
            onclick={commitDraft}
          ><span class="commit-copy"><strong>{saving ? "Saving…" : commitState === "saved" ? "Saved" : "Save"}</strong></span><span class="commit-mark" use:moves={confirmationMotion} aria-hidden="true"></span></button>
          <span class="save-help" id={`${settingId}-save-help`}>{descriptor.consequence}</span>
        {:else}
          <button
            class="verb "
            data-verb-id="settings.customizations/set"
            disabled
            title="the server declares no save action for settings"
            >Save: the server declares no save action for settings</button>
        {/if}
      {/if}

      </div>
      <div class="edit-result" role="status" aria-live="polite">
        {#if numericCorrection !== null}<p class="input-correction" id={`${settingId}-correction`}>{numericCorrection}</p>{/if}
        {#if pendingNewerDraft}<p class="pending-draft">Saving the earlier edit. This draft is not saved yet.</p>{/if}
        {#if row.kind === "served" && row.effect !== "immediate"}<span class="effect-timing deferred">{effectTimingLine(row)}</span>{/if}
        {#if saving && (row.type === "boolean" || row.type === "enum")}<span>Updating…</span>{/if}
        {#if displayed === undefined || ((row.type === "number" || row.type === "string" || row.type === "object") && (dirty || saving || save.kind === "failed" || uncertain || displayedMasked))}
          <span class="reading">{#if displayed === undefined}Value not read yet{:else}Saved value <strong>{formatSetting(row, current)}</strong>{/if}</span>
        {/if}
        {#if save.kind === "saved"}
          {#if draft !== null}<p class="saved-line">Earlier change saved; this draft is unsaved</p>{:else if row.type === "boolean" || row.type === "enum"}<p class="saved-line">Updated</p>{:else}<span class="saved-announcement">Saved</span>{/if}
        {:else if save.kind === "failed"}
          {#if numericCorrection !== null}
            <details class="refusal-details"><summary>Save details</summary><p class="failure">{save.message}</p></details>
          {:else}<p class="failure">{save.message}</p>{/if}
        {:else if uncertain}
          <p class="failure">A previous change could not be confirmed. Check the value, then save it again.</p>
        {/if}
      </div>
    </div>
    <div class="setting-context">
      <p class="description">{row.description}</p>
      <dl class="setting-facts">
        {#if current !== undefined && !atDefault}<div><dt>Default</dt><dd>{formatSetting(row, row.defaultValue)}</dd></div>{/if}
        <div><dt>Scope</dt><dd>{row.kind === "local" ? "This device" : "This install"}</dd></div>
        {#if row.kind === "local" || row.effect === "immediate"}<div><dt>Applies</dt><dd>Immediately</dd></div>{/if}
      </dl>
    </div>
    {#if hasDetails || showReset}<div class="setting-options">
    {#if hasDetails}
    <details class="setting-details">
      <summary>Details</summary>
      <dl class="setting-facts">
        {#if boundsLine !== null}<div><dt>Range</dt><dd class="bounds">{boundsLine}</dd></div>{/if}
        {#if save.kind === "saved"}<div><dt>Last saved</dt><dd>{logTime(save.atMs)}</dd></div>{/if}
        {#if effectLine !== null}<div><dt>Measured</dt><dd class="measured">{effectLine}</dd></div>{/if}
      </dl>
    </details>
    {/if}
      {#if showReset}
        <button
          class="verb "
          data-verb-id={row.kind === "local" ? "cockpit.pref/set" : "settings.customizations/set"}
          disabled={past}
          aria-disabled={past || saving}
          title={past ? PAST_VIEW_ACT_REASON : saving ? "saving now" : undefined}
          onclick={() => void resetDefault()}
        >Return to default</button>
      {/if}
    </div>{/if}
    </div>

  {/if}
</div>

<style>
  /* One rhythm with every other raised surface (--sheet-gap, tokens.css).
   * The interior gutter belongs to whatever hosts this: the SCOPE sheet
   * when it is opened as one, the index row when it is rendered inline:
   * so the sheet never double-pads itself. */
  .sheet {
    display: flex;
    flex-direction: column;
    gap: var(--sheet-gap);
    min-width: 0;
    font-size: var(--f-ui-size);
    color: var(--ink-1);
  }
  .sheet.inline { padding: var(--sp-2) 0 var(--sp-3); }
  .sheet-title { margin: 0; font: var(--f-heading-weight) var(--f-ui-size) var(--face-sans); }
  /* The row header's spine is owned by tokens.css (.cockpit .head); the
   * sheet's head pushes its close affordance to the far edge. */
  .head {
    justify-content: space-between;
    gap: var(--sp-3);
  }
  .description {
    margin: 0;
    color: var(--ink-2);
    max-width: var(--measure);
  }
  .segmented {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
    min-width: 0;
    align-self: flex-start;
  }
  .numeral-row {
    display: flex;
    flex-wrap: wrap;
  }
  .numeral {
    font-variant-numeric: tabular-nums slashed-zero;
    cursor: text;
    touch-action: pan-y;
  }
  .unit {
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--ink-2);
  }
  .bounds {
    font-family: var(--face-sans);
    font-size: var(--f-data-size);
    color: var(--ink-2);
  }
  .text-field,
  .object-field {
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    max-width: var(--measure);
  }
  .object-field {
    resize: vertical;
  }
  /* The standing object, in the shared tree: quiet ground so the DRAFT
   * field below reads as the editable one of the pair. */
  .object-read {
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    background: var(--ground-1);
    border: var(--hairline-w) solid var(--line-1);
    border-radius: var(--radius-1);
    padding: var(--sp-1) var(--sp-2);
    max-width: var(--measure);
    overflow-x: auto;
  }
  .measured {
    margin: 0;
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--ink-2);
  }
  .footer:empty { display: none; }
  .setting-details { color: var(--ink-2); }
  .setting-details[open] { flex-basis: 100%; }
  .reading {
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--ink-2);
  }
  /* The verb recipe is owned by tokens.css (.cockpit .verb); the settings
   * sheet's verbs keep the smaller engraved register (.engraved-ctl, a
   * marker class). */
  .saved-announcement, .save-help { position: absolute; width: var(--hairline-w); height: var(--hairline-w); overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .saved-line {
    margin: 0;
    font-family: var(--face-mono);
    font-size: var(--f-nano-size);
    color: var(--ok);
  }
  .failure {
    margin: 0;
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--alarm);
  }
</style>
