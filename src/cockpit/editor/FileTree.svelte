<script lang="ts">
  /**
   * THE FOLDER STRUCTURE — the left half of the room.
   *
   * One row per entry, folders before files, indented by real nesting depth.
   * Every row is a real `<button>`, so it is reachable by Tab, activated by
   * Enter and Space without this component re-implementing either, and carries
   * the pointer-target floor in both axes.
   *
   * ONE CLICK, ONE OUTCOME — the rule the user asked for by name after a
   * click both expanded a card AND threw a sheet open. Here: clicking a FOLDER
   * opens or closes that folder and does nothing else; clicking a FILE opens
   * that file in the pane and does nothing else. Deleting is never on the row
   * itself — it lives in the pane, behind the armed confirmation, so no click
   * in this list can destroy anything.
   *
   * NOTHING IS INVENTED. A folder that has not been read contributes only
   * itself; a folder that was read and held nothing says so, in words that
   * state the rule (the tree route does not list hidden entries or build
   * folders, so "empty" would be a claim we cannot make); a folder that could
   * not be read says why. There is no spinner that outlives its answer.
   */
  import { untrack } from "svelte";
  import Answer from "../response/Answer.svelte";
  import ContextMenu, { type MenuVerb } from "../shell/ContextMenu.svelte";
  import { absent, failed, pending } from "../response/grammar.ts";
  import { fileSizeText } from "./file-kind.ts";
  import { dirSummary, EMPTY_DIR_SENTENCE, type DirLoad, type TreeEntry, type TreeRow } from "./tree.ts";

  let {
    rows,
    rootLoad,
    selectedPath,
    draftPaths,
    focusRel,
    focusSeq,
    draftKeyOf,
    onopenfile,
    ontogglefolder,
    onfocusrow,
    onreadagain,
  }: {
    rows: readonly TreeRow[];
    /** The root directory's own load — the tree's honest first state. */
    rootLoad: DirLoad;
    /** Absolute path of the file the pane is showing, or null. */
    selectedPath: string | null;
    /** `projectId\0absolutePath` keys that have an unsaved draft waiting. */
    draftPaths: ReadonlySet<string>;
    /** The row the keyboard is on (relative path), or null. */
    focusRel: string | null;
    /** Bumped by the room when the keyboard should MOVE focus here. */
    focusSeq: number;
    /** The room's own draft key for an absolute path — the room owns the
     * project scope, so the tree never has to know what a project is. */
    draftKeyOf: (absolutePath: string) => string;
    onopenfile: (entry: TreeEntry) => void;
    ontogglefolder: (entry: TreeEntry) => void;
    onfocusrow: (rel: string) => void;
    /**
     * READ THIS FOLDER AGAIN — the way out of a failed read.
     *
     * A directory is read once and the room remembers the answer, which is
     * correct for an answer and wrong for a FAILURE: a root read that lost the
     * server left the whole room with no rows, no verb and no way back, because
     * the load was recorded and the room never asks twice. Closing and
     * reopening the room does not help either — rooms are kept alive, so the
     * failed load is still there. An absence with no way to retry it is a dead
     * end, and this is the verb that ends it.
     */
    onreadagain: (dir: string) => void;
  } = $props();

  /** Row elements by relative path, so the keyboard can move real focus (a
   * roving `tabindex` without real focus would leave screen readers behind).
   * A `$state` RECORD, deliberately: `bind:this` must write a REACTIVE
   * property (binding into a plain record is the exact shape Svelte 5 warns
   * about — `binding_property_non_reactive`, one console line per row), but
   * nothing RENDERS from it. It is an imperative handle registry, write-only
   * from `bind:this` and read only by the focus effect below, through an
   * UNTRACKED read. As tracked state it re-fired the focus effect on every
   * row re-bind (the save path re-reads the parent folder, and the transient
   * reading state unmounts and remounts each row), stealing real focus out
   * of wherever the user had put it — observed live: out of the edit-mode
   * textarea right after a save, so the user's next Space activated the tree
   * row and re-opened the file mid-edit. */
  const rowEls: Record<string, HTMLButtonElement | null> = $state({});

  $effect(() => {
    // Depend on the sequence, not on `focusRel`: a click also changes
    // `focusRel`, and stealing focus back on a click would fight the pointer.
    focusSeq;
    const rel = focusRel;
    if (rel === null) return;
    // UNTRACKED read: the effect must stay a dependent of the focus sequence
    // alone. Row re-binds WRITE this registry — a tracked read would re-fire
    // the focus call on them, which is the theft the untracked shape exists
    // to prevent.
    untrack(() => rowEls[rel]?.focus());
  });

  // ── The row context menu ─────────────────────────────────────────────────
  //
  // A row has exactly one verb — a folder toggles, a file opens — and the
  // menu lists exactly that, wired to the SAME handler and the same words
  // the row's own click and title carry. Deleting is deliberately NOT here:
  // it has never been a row verb in this tree (the header records why), and
  // a context menu must not become a second, easier door to a destructive
  // act.
  let menu = $state<Readonly<{ at: { x: number; y: number }; row: TreeRow }> | null>(null);

  function rowMenuVerbs(row: TreeRow): readonly MenuVerb[] {
    const entry = row.entry;
    if (entry.type === "directory") {
      return [
        {
          id: "editor.open-entry",
          label: row.open ? "close folder" : "open folder",
          title: row.open
            ? `Closes ${entry.name}. Nothing on disk changes.`
            : `Opens ${entry.name} and lists what is inside it.`,
          run: () => ontogglefolder(entry),
        },
      ];
    }
    return [
      {
        id: "editor.open-entry",
        label: "open",
        title: `Opens ${entry.name} in the pane on the right. Nothing is written until you save.`,
        run: () => onopenfile(entry),
      },
    ];
  }

  function onRowMenu(ev: MouseEvent, row: TreeRow): void {
    ev.preventDefault();
    menu = { at: { x: ev.clientX, y: ev.clientY }, row };
  }
</script>

<div class="tree" role="tree" aria-label="files and folders in this project">
  {#if rootLoad.kind === "unread" || rootLoad.kind === "reading"}
    <div class="tree-note"><Answer answer={pending("reading this project's folders")} /></div>
  {:else if rootLoad.kind === "absent"}
    <!-- A load-level "absent" carries a caught error's reason — a read that
         broke, so in the grammar it is failed, and the way out stays beside
         it. -->
    <div class="tree-note"><Answer answer={failed(`the folder list — ${rootLoad.reason}`)} /></div>
    <button
      class="again "
      data-verb-id="editor.read-again"
      type="button"
      title="Reads this project's folders from the server again. Nothing on disk changes."
      onclick={() => onreadagain("")}>Try again</button>
  {:else if rows.length === 0}
    <div class="tree-note"><Answer answer={absent(EMPTY_DIR_SENTENCE)} /></div>
  {:else}
    {#each rows as row (row.entry.path)}
      {@const entry = row.entry}
      {@const isFolder = entry.type === "directory"}
      {@const hasDraft = draftPaths.has(draftKeyOf(entry.path))}
      <button
        class="row"
        bind:this={rowEls[entry.relativePath]}
        data-verb-id="editor.open-entry"
        type="button"
        role="treeitem"
        aria-level={row.depth + 1}
        aria-expanded={isFolder ? row.open : undefined}
        aria-selected={entry.path === selectedPath}
        class:selected={entry.path === selectedPath}
        class:focused={entry.relativePath === focusRel}
        style="--depth: {row.depth}"
        title={isFolder
          ? row.open
            ? `Closes ${entry.name}. Nothing on disk changes.`
            : `Opens ${entry.name} and lists what is inside it.`
          : `Opens ${entry.name} in the pane on the right. Nothing is written until you save.`}
        onclick={() => (isFolder ? ontogglefolder(entry) : onopenfile(entry))}
        oncontextmenu={(ev) => onRowMenu(ev, row)}
        onfocus={() => onfocusrow(entry.relativePath)}
      >
        <span class="indent" aria-hidden="true"></span>
        <span class="twisty" aria-hidden="true">{isFolder ? (row.open ? "▾" : "▸") : ""}</span>
        <span class="name trunc">{entry.name}</span>
        {#if hasDraft}
          <span class="draft engraved-ctl" title="this file has an unsaved edit waiting">unsaved</span>
        {/if}
        {#if !isFolder}
          <span class="size">{fileSizeText(entry.size)}</span>
        {/if}
      </button>
      {#if isFolder && row.open}
        {#if row.load.kind === "reading" || row.load.kind === "unread"}
          <div class="tree-note nested" style="--depth: {row.depth + 1}">
            <Answer answer={pending(`reading ${entry.name}`)} />
          </div>
        {:else if row.load.kind === "absent"}
          <div class="tree-note nested" style="--depth: {row.depth + 1}">
            <Answer answer={failed(`${entry.name} — ${row.load.reason}`)} />
          </div>
          <button
            class="again nested"
            style="--depth: {row.depth + 1}"
            data-verb-id="editor.read-folder-again"
            type="button"
            title={`Reads ${entry.name} from the server again. Nothing on disk changes.`}
            onclick={() => onreadagain(entry.relativePath)}>Try again</button>
        {:else if row.load.entries.length === 0}
          <div class="tree-note nested" style="--depth: {row.depth + 1}">
            <Answer answer={absent(EMPTY_DIR_SENTENCE)} />
          </div>
        {:else if row.load.truncated}
          <div class="tree-note nested" style="--depth: {row.depth + 1}">
            <Answer
              answer={absent(
                `${dirSummary(row.load.entries)} shown — this folder holds more than this room lists at once`,
              )}
            />
          </div>
        {/if}
      {/if}
    {/each}
  {/if}
</div>

{#if menu !== null}
  <ContextMenu
    title={menu.row.entry.name}
    verbs={rowMenuVerbs(menu.row)}
    at={menu.at}
    onclose={() => (menu = null)}
  />
{/if}

<style>
  .tree {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
    width: 100%;
    min-height: var(--hit-min);
    min-width: var(--hit-min);
    padding: 0 var(--sp-2);
    background: none;
    border: none;
    border-radius: var(--radius-1);
    color: var(--ink-2);
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    text-align: left;
    cursor: pointer;
  }
  .row:hover {
    background: var(--layer-hover);
    color: var(--ink-1);
  }
  .row.selected {
    background: var(--layer-select);
    color: var(--ink-1);
  }
  /* The indent is DRAWN, not padded, so the row's hit area still spans the
   * whole column at every depth — a nested file must not be a smaller target
   * than a top-level one. */
  .indent {
    flex: none;
    width: calc(var(--depth) * var(--editor-indent));
  }
  .twisty {
    flex: none;
    width: var(--editor-twisty-w);
    color: var(--ink-3);
    text-align: center;
  }
  .name {
    min-width: 0;
  }
  /* The draft marker spends the warn ink over the owned quiet engraved
   * register (tokens.css `.engraved-ctl`, carried as a marker class). */
  .draft {
    flex: none;
    color: var(--warn);
  }
  .size {
    margin-left: auto;
    flex: none;
    font-size: var(--f-nano-size);
    color: var(--ink-4);
    font-variant-numeric: tabular-nums;
  }
  /* Position only — the words inside are the grammar's, which owns their
   * ink, face and slant. */
  .tree-note {
    margin: 0;
    padding: var(--sp-1) var(--sp-2);
  }
  .nested {
    padding-left: calc(var(--sp-2) + var(--depth) * var(--editor-indent));
  }
  /* The way out of a failed read, sized to the pointer-target floor like every
   * other verb in this room. */
  .again {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: var(--hit-min);
    min-width: var(--hit-min);
    margin-left: var(--sp-2);
    padding: 0 var(--sp-2);
    background: none;
    border: var(--hairline-w) solid var(--line-1);
    border-radius: var(--radius-1);
    color: var(--ink-3);
    font-family: var(--face-mono);
    white-space: nowrap;
    cursor: pointer;
  }
  .again:hover {
    background: var(--layer-hover);
    color: var(--ink-1);
  }
</style>
