<script lang="ts">
  /**
   * A FILE PATH IS A DOOR, NOT DEAD TEXT — the one chip every
   * beat header renders where it names a file.
   *
   * Clicking (or Enter/Space on focus — it is a real button) asks the editor
   * to open this path through its one-shot open seam
   * (editor/open-request.ts) and opens the editor room through the SAME
   * ShellApi door a chord uses. The tooltip teaches the room's chord, per
   * the mouse-path law: a click path that does not teach its chord leaves
   * the grammar undiscoverable.
   *
   * With no shell above (a standalone harness) there is no room to open, so
   * the path renders as the plain text it always was — a control that could
   * only ever refuse would be a promise the surface cannot keep.
   */
  import { getContext } from "svelte";
  import { SHELL_CONTEXT_KEY, type ShellApi } from "../shell/contract.ts";
  import { chordFor } from "../shell/keyboard.ts";
  import { requestEditorOpen } from "../editor/open-request.ts";

  let { path }: { path: string } = $props();

  const shell = getContext<ShellApi | undefined>(SHELL_CONTEXT_KEY);

  function open(ev: Event): void {
    // The beat's body treats clicks as fold-toggles; opening a file is this
    // chip's own act and must not also fold the card under the pointer.
    ev.stopPropagation();
    if (shell === undefined) return;
    requestEditorOpen(path);
    shell.openRoom("editor");
  }
</script>

{#if shell !== undefined}
  <button
    class="path-chip trunc"
    type="button"
    data-verb-id="flow.open-path"
    title={`open ${path} in the editor · ${chordFor("editor")}`}
    onclick={open}
  >{path}</button>
{:else}
  <span class="path-static trunc">{path}</span>
{/if}

<style>
  .path-chip {
    appearance: none;
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    /* The chip wears its container's register — a path in a tool head reads
     * like the head; only the affordance is its own. */
    font: inherit;
    letter-spacing: inherit;
    color: inherit;
    cursor: pointer;
    /* Visible AT REST (the §9 floor): a text-shaped control carries the
     * dotted underline a reader already knows means "this opens". */
    text-decoration: underline dotted;
    max-width: 100%;
    vertical-align: bottom;
  }
  .path-chip:hover {
    color: var(--ink-1);
    text-decoration-style: solid;
  }
  .path-static {
    max-width: 100%;
  }
</style>
