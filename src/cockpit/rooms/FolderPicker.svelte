<script lang="ts">
  /**
   * THE FOLDER PICKER — choose a folder on the SERVER's disk.
   *
   * The web UI runs against the server's filesystem, so choosing a project
   * folder cannot be a browser file dialog (that yields a name, not a
   * path). This browses the server's real directory listing routes:
   * navigate into a folder (click / Enter), expand it in place (the
   * twisty / ArrowRight), go up (the "up a folder" row / Backspace), and
   * make a new folder inside the one you are standing in.
   *
   * KEYBOARD — the APG tree-view grammar (w3.org/WAI/ARIA/apg/patterns/treeview):
   * ArrowUp/ArrowDown walk the visible rows; ArrowRight opens a closed row
   * (or steps into an open one); ArrowLeft closes an open row (or steps to
   * its parent); Enter opens the focused folder; Backspace goes up. Focus
   * is a real roving focus over real button rows, the same discipline the
   * editor's file tree keeps.
   *
   * DENY-BY-DEFAULT. The only paths this can ever name are paths the server
   * answered with: the opening choices come from the roots route, every
   * later row from a list answer, and a folder the server refuses (gone,
   * unreadable, outside the allowed roots) is said in the refusal's own
   * words — never rendered as empty, never guessed.
   *
   * THE ANSWER. The folder the picker stands on (the listed anchor) is the
   * selection; the confirm verb hands it to the caller through `onselect`.
   * The picker holds no opinion about what the folder is FOR — new project,
   * relink, anything — that is the caller's sentence to write.
   */
  import { tick } from "svelte";

  import {
    createFolder,
    listDirectories,
    listDirectoryRoots,
  } from "../../client.ts";
  // Creating a folder is a WRITE on the server's disk, and `createFolder` is
  // a client.ts call with no Broker write door on it. The assertion is what
  // keeps a mkdir from firing while the cockpit is showing a past instant
  // (the same guarantee the Switch's own create gestures carry).
  import { assertLiveForWrite } from "../../data/asof.ts";
  import { ClientError } from "../../data/errors.ts";
  import { VERB_MARK, VERB_MARK_WORD } from "../shell/verb-marks.ts";
  import Answer from "../response/Answer.svelte";
  import { absent, failed, pending } from "../response/grammar.ts";
  import {
    applyListing,
    applyRefusal,
    enterDirectory,
    focusPath,
    initialPickerState,
    markReading,
    moveFocus,
    needsRead,
    newFolderNameProblem,
    selectPath,
    stepUp,
    toggleExpanded,
    visibleRows,
    type PickerState,
  } from "./folder-picker.ts";

  let {
    onselect,
    oncancel,
    /** Accessible label for the listing (the caller's noun for what is
     * being chosen — "the project's folder", "the new project's folder"). */
    subject,
    /** When set, choosing is refused and this is why (a past view, etc.). */
    blocked = null,
  }: {
    onselect: (path: string) => void;
    oncancel: () => void;
    subject: string;
    blocked?: string | null;
  } = $props();

  let picker = $state<PickerState>(initialPickerState([]));
  let boot = $state<"reading" | "ready" | "failed">("reading");
  let bootReason = $state("");
  let rowEls = $state<Record<string, HTMLButtonElement | null>>({});

  // ── inline new folder ──
  let makingFolder = $state(false);
  let newName = $state("");
  let newNameNote = $state<string | null>(null);
  let newNameEl: HTMLInputElement | undefined = $state();
  let busy = $state(false);

  const rows = $derived(visibleRows(picker));
  const atListing = $derived.by(() => {
    if (picker.at === null) return null;
    const d = picker.dirs[picker.at];
    return d !== undefined && d.kind === "read" ? d.listing : null;
  });
  const atRefusal = $derived.by(() => {
    if (picker.at === null) return null;
    const d = picker.dirs[picker.at];
    return d !== undefined && d.kind === "refused" ? d.reason : null;
  });
  const atReading = $derived(
    picker.at !== null &&
      (picker.dirs[picker.at] === undefined || picker.dirs[picker.at]?.kind === "reading"),
  );
  // The confirm verb's answer: the anchor when it is a real readable listing,
  // else the row the user last chose. Never a path the server did not say.
  const chosen = $derived(atListing !== null && atListing.accessible ? picker.at : picker.selected);
  /** Why the standing-on folder cannot be a project, if the listing said so. */
  const standingRestriction = $derived(atListing?.restriction ?? null);
  const chosenRestriction = $derived.by(() => {
    if (chosen === null) return null;
    if (chosen === picker.at) return standingRestriction;
    const row = rows.find((r) => r.kind === "dir" && r.entry.path === chosen);
    return row !== undefined && row.kind === "dir" ? (row.entry.restriction ?? null) : standingRestriction;
  });
  const canChoose = $derived(
    chosen !== null && chosenRestriction === null && !busy && blocked === null,
  );

  /** Ask the server for one directory's children, once (the picker machine
   * decides WHAT is needed; this is the only place that fetches). */
  async function readDir(path: string): Promise<void> {
    if (!needsRead(picker, path)) return;
    picker = markReading(picker, path);
    try {
      const listing = await listDirectories(path);
      picker = applyListing(picker, listing);
    } catch (err) {
      picker = applyRefusal(picker, path, refusalWords(err));
    }
  }

  /** Force a fresh read of a directory (used after a folder is created in
   * it — the row must come from a real answer, not an invented one). */
  async function rereadDir(path: string): Promise<void> {
    const dirs = { ...picker.dirs };
    delete dirs[path];
    picker = { ...picker, dirs };
    await readDir(path);
  }

  function refusalWords(err: unknown): string {
    if (err instanceof ClientError) {
      if (err.code === "path_outside_roots") return "outside the folders this server lets you browse";
      if (err.code === "not_found") return "that folder is gone";
      if (err.code === "not_a_directory") return "that is a file, not a folder";
      return err.message;
    }
    return "the server could not read that folder";
  }

  $effect(() => {
    // Boot: the opening view is the server's allowed roots. The roots route
    // answers `{label, path}`; the listing rows are `{name, path, accessible}`
    // — the root's LABEL is its display name, and a root the server offers is
    // by definition browsable (the list route answers for it).
    void (async () => {
      try {
        const { roots } = await listDirectoryRoots();
        const entries = roots.map((r) => ({
          name: r.label,
          path: r.path,
          accessible: true,
          ...(r.restriction !== undefined ? { restriction: r.restriction } : {}),
        }));
        picker = { ...initialPickerState(entries), focus: entries[0]?.path ?? null };
        boot = "ready";
      } catch (err) {
        bootReason = refusalWords(err);
        boot = "failed";
      }
    })();
  });

  $effect(() => {
    // Reads follow the picker: the anchor and every expanded directory are
    // the directories whose children must be known. `needsRead` makes this
    // exactly-once per directory per picker.
    if (boot !== "ready") return;
    const at = picker.at;
    if (at !== null) void readDir(at);
    for (const path of picker.expanded) void readDir(path);
  });

  $effect(() => {
    // Real focus follows the machine's focus row (roving focus, moved by
    // the keyboard handlers below — never stolen from the pointer, because
    // click handlers set focus through the same picker).
    const f = picker.focus;
    if (f === null) return;
    void tick().then(() => rowEls[f]?.focus());
  });

  function openRow(path: string): void {
    // Stepping into a folder makes it the picker's answer — one gesture,
    // one meaning, whether it arrived by click or by Enter.
    picker = selectPath(enterDirectory(picker, path), path);
  }


  function goUp(): void {
    picker = stepUp(picker);
  }

  function confirm(): void {
    if (!canChoose || chosen === null) return;
    onselect(chosen);
  }

  /** Choose THIS row's folder without stepping into it. */
  function confirmPath(path: string, restriction: string | undefined): void {
    if (busy || blocked !== null || restriction !== undefined) return;
    onselect(path);
  }

  // ── new folder ──

  async function startMakeFolder(): Promise<void> {
    if (picker.at === null || atListing === null || !atListing.accessible) return;
    makingFolder = true;
    newName = "";
    newNameNote = null;
    await tick();
    newNameEl?.focus();
  }

  async function submitMakeFolder(): Promise<void> {
    if (picker.at === null || busy) return;
    const problem = newFolderNameProblem(newName);
    if (problem !== null) {
      newNameNote = problem;
      return;
    }
    busy = true;
    newNameNote = "creating the folder…";
    try {
      assertLiveForWrite();
      const parent = picker.at;
      const made = await createFolder(parent, newName.trim());
      // Re-read the parent so the new folder appears as a REAL row (never
      // an invented one), then step into it — the created folder is the
      // picker's new answer.
      await rereadDir(parent);
      picker = enterDirectory(picker, made.path);
      picker = selectPath(picker, made.path);
      makingFolder = false;
      newNameNote = null;
    } catch (err) {
      newNameNote = refusalWords(err);
    } finally {
      busy = false;
    }
  }

  function cancelMakeFolder(): void {
    makingFolder = false;
    newNameNote = null;
  }

  // ── keyboard (APG tree-view grammar, scoped to this listing) ──

  function onListKeydown(ev: KeyboardEvent): void {
    if (makingFolder) return; // the name field owns the keys while it is open
    const f = picker.focus;
    switch (ev.key) {
      case "ArrowDown":
        ev.preventDefault();
        picker = moveFocus(picker, 1);
        return;
      case "ArrowUp":
        ev.preventDefault();
        picker = moveFocus(picker, -1);
        return;
      case "ArrowRight": {
        if (f === null) return;
        ev.preventDefault();
        if (!picker.expanded.has(f)) {
          picker = toggleExpanded(picker, f);
          void readDir(f);
        } else {
          // Open row: step focus to its first listed child, if one is on
          // screen (APG: on an open node, Right moves to the first child).
          const firstChild = rows.find((r) => r.kind === "dir" && r.parentPath === f);
          if (firstChild !== undefined && firstChild.kind === "dir") {
            picker = focusPath(picker, firstChild.entry.path);
          }
        }
        return;
      }
      case "ArrowLeft": {
        if (f === null) return;
        ev.preventDefault();
        if (picker.expanded.has(f)) {
          // APG: on an open node, Left closes it.
          picker = toggleExpanded(picker, f);
        } else {
          // APG: on a closed/end node, Left moves to the parent row — the
          // row whose expansion listed this one, or up a level when this is
          // a top-level row.
          const row = rows.find((r) => r.kind === "dir" && r.entry.path === f);
          if (row !== undefined && row.kind === "dir" && row.parentPath !== null) {
            picker = focusPath(picker, row.parentPath);
          } else {
            goUp();
          }
        }
        return;
      }
      case "Enter": {
        if (f === null) return;
        ev.preventDefault();
        openRow(f);
        return;
      }
      case "Backspace":
        ev.preventDefault();
        goUp();
        return;
    }
  }
</script>

<div class="picker" data-testid="folder-picker">
  <div class="picker-head">
    <span class="engraved trunc">{subject}</span>
    {#if picker.at !== null}
      <button
        class="verb "
        type="button"
        data-verb-id="picker.new-folder"
        title="make a new folder inside this one"
        disabled={busy || atListing === null || !atListing.accessible}
        onclick={() => void startMakeFolder()}>New folder</button
      >
    {/if}
    <span class="spacer"></span>
    <button
      class="verb ok plain"
      type="button"
      data-verb-id="picker.choose"
      disabled={!canChoose}
      title={blocked !== null
        ? blocked
        : chosen === null
          ? "browse to a folder first"
          : chosenRestriction !== null
            ? chosenRestriction
            : `choose ${chosen}`}
      aria-label={chosen === null ? "choose this folder" : `choose ${chosen}`}
      onclick={confirm}>Choose folder</button
    >
    <button
      class="verb cancel "
      type="button"
      data-verb-id="picker.cancel"
      aria-label={VERB_MARK_WORD.cancel}
      title={VERB_MARK_WORD.cancel}
      onclick={oncancel}>{VERB_MARK_WORD.cancel}</button>
  </div>

  {#if makingFolder && picker.at !== null}
    <form
      class="mkdir"
      aria-label="new folder"
      onsubmit={(ev) => {
        ev.preventDefault();
        void submitMakeFolder();
      }}
    >
      <span class="engraved trunc">new folder in {picker.at}</span>
      <input
        bind:this={newNameEl}
        bind:value={newName}
        class="field"
        type="text"
        name="folder-name"
        placeholder="folder name"
        aria-label="new folder name"
        data-verb-id="picker.new-folder-name"
        disabled={busy}
      />
      <button class="verb add " type="submit" data-verb-id="picker.new-folder-create" aria-label={VERB_MARK_WORD.add} title={VERB_MARK_WORD.add} disabled={busy}>Create folder</button>
      <button
        class="verb cancel "
        type="button"
        data-verb-id="picker.new-folder-cancel"
        aria-label={VERB_MARK_WORD.cancel}
        title={VERB_MARK_WORD.cancel}
        onclick={cancelMakeFolder}
        disabled={busy}>{VERB_MARK_WORD.cancel}</button>
      {#if newNameNote !== null}
        <span class="note" data-picker={busy ? "checking" : "bad"}>{newNameNote}</span>
      {/if}
    </form>
  {/if}

  {#if boot === "reading"}
    <Answer answer={pending("reading the folders you can start from")} />
  {:else if boot === "failed"}
    <Answer answer={failed(`the folder list — ${bootReason}`)} />
  {:else if picker.at === null && picker.roots.length === 0}
    <Answer answer={absent("this server offers no folders to start from")} />
  {:else}
    <!-- Keyboard interaction rides the real button rows (roving focus);
         the tree container only scopes the key handler. tabindex=-1 keeps
         the tree itself out of the Tab order — focus lives on the rows. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
    <div
      class="listing"
      role="tree"
      aria-label={subject}
      tabindex="-1"
      onkeydown={onListKeydown}
    >
      {#if atRefusal !== null}
        <div class="picker-note"><Answer answer={failed(atRefusal)} /></div>
      {:else if atReading}
        <div class="picker-note"><Answer answer={pending(`reading ${picker.at}`)} /></div>
      {:else if picker.at !== null && atListing !== null && atListing.entries.length === 0}
        <div class="picker-note"><Answer answer={absent("no folders inside this one")} /></div>
      {/if}
      {#each rows as row (row.kind === "up" ? "↑" : row.entry.path)}
        {#if row.kind === "up"}
          <button
            class="verb menu row up"
            type="button"
            data-verb-id="picker.up"
            title="go up to {row.path}"
            onclick={goUp}
          >
            <span class="twisty" aria-hidden="true">↑</span>
            <span class="name trunc">up a folder</span>
          </button>
        {:else}
          {@const entry = row.entry}
          <div class="row-line">
            <button
              class="verb menu row"
              bind:this={rowEls[entry.path]}
              type="button"
              role="treeitem"
              data-verb-id="picker.open"
              aria-level={row.depth + 1}
              aria-expanded={row.expanded}
              aria-selected={entry.path === chosen}
              aria-disabled={!entry.accessible}
              class:selected={entry.path === chosen}
              class:focused={entry.path === picker.focus}
              class:inaccessible={!entry.accessible}
              style="--depth: {row.depth}"
              title={entry.accessible
                ? `open ${entry.name} — ${entry.path}`
                : `${entry.name} — this folder exists but is not readable`}
              onclick={() => {
                if (!entry.accessible) return;
                openRow(entry.path);
              }}
            >
              <span class="twisty" aria-hidden="true">{row.expanded ? "▾" : "▸"}</span>
              <span class="name trunc">{entry.name}</span>
              {#if !entry.accessible}
                <span class="row-note">not readable</span>
              {:else if entry.restriction !== undefined}
                <span class="row-note" title={entry.restriction}>not a project</span>
              {:else if row.state !== null && row.state.kind === "refused"}
                <span class="row-note">{row.state.reason}</span>
              {/if}
            </button>
            <button
              class="verb mark ok choose"
              type="button"
              data-verb-id="picker.choose-row"
              disabled={busy || blocked !== null || !entry.accessible || entry.restriction !== undefined}
              title={blocked ?? entry.restriction ?? `choose ${entry.name}`}
              aria-label={`choose ${entry.name}`}
              onclick={() => confirmPath(entry.path, entry.restriction)}
            >{VERB_MARK.ok}</button>
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    min-height: 0;
    gap: var(--sp-2);
  }
  .picker-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex: none;
  }
  .spacer {
    flex: 1;
  }
  .mkdir {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-wrap: wrap;
    padding: var(--sp-2);
    border: var(--hairline-w) solid var(--line-1);
    border-radius: var(--radius-1);
    background: var(--ground-1);
    flex: none;
  }
  /* The input recipe is owned by tokens.css (.cockpit input.field); this
   * picker's field keeps its 16ch floor. */
  .field {
    min-width: 16ch;
  }
  .note {
    font-family: var(--face-mono);
    font-size: var(--f-nano-size);
    color: var(--ink-3);
  }
  .note[data-picker="bad"] {
    color: var(--warn);
  }
  .listing {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow-y: auto;
    max-height: 40vh;
    border: var(--hairline-w) solid var(--line-1);
    border-radius: var(--radius-1);
    background: var(--ground-1);
  }
  .row-line {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
    min-width: 0;
  }
  .row-line .row {
    flex: 1;
    min-width: 0;
  }
  .choose {
    flex: none;
  }
  /* Chrome is `.verb.menu`. Layout: the tree row's twisty + depth. */
  .row {
    gap: var(--sp-1);
    width: 100%;
  }
  .row.selected {
    background: var(--layer-select);
    color: var(--ink-1);
  }
  .row.inaccessible {
    color: var(--ink-4);
    cursor: default;
  }
  .row.up {
    color: var(--ink-3);
  }
  .twisty {
    flex: none;
    width: var(--editor-twisty-w, 2ch);
    color: var(--ink-3);
    text-align: center;
    margin-left: calc(var(--depth) * var(--editor-indent, 2ch));
  }
  .row.up .twisty {
    margin-left: 0;
  }
  .name {
    min-width: 0;
  }
  .row-note {
    margin-left: auto;
    flex: none;
    font-size: var(--f-nano-size);
    color: var(--warn);
  }
  /* The verb recipe is owned by tokens.css (.cockpit .verb). Row
   * checkmarks mark `.verb.mark` (quiet glyph, owned `--hit-min`).
   * `.engraved-ctl` is the quieter type register. */
  .picker-note {
    padding: var(--sp-1) var(--sp-2);
  }
</style>
