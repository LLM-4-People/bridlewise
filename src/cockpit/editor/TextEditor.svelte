<script lang="ts">
  /**
   * THE TEXT AREA — where an edit actually happens.
   *
   * A plain `<textarea>` on purpose. The alternative is a code-editor widget,
   * which brings its own key handling, its own focus model, its own accessible
   * name and about half a megabyte of it — for a room whose job is to let you
   * fix a line and save it. What a textarea gives for free is exactly what
   * this room must not get wrong: the platform's own undo stack, the
   * platform's own selection, IME, spellcheck off, and a caret that behaves
   * the way every other text field on the machine behaves.
   *
   * THE LINE RAIL beside it is drawn from the SAME text, scrolled by the same
   * `scrollTop`, in the same font at the same line height. It is a mirror, not
   * a second layout: if it ever disagreed with the text it would be worse than
   * absent, so it is derived from the text on every change rather than kept.
   *
   * NO LAYOUT SHIFT: the rail's width is a token (`--editor-gutter-w`, in
   * `ch`), so it does not resize as the line count grows past a power of ten.
   *
   * EVERY KEYSTROKE IS PUBLISHED IMMEDIATELY (`oninput`), because the buffer —
   * not this component — owns the draft, and the buffer's write-through is
   * what makes a reload survivable. A component that batched keystrokes would
   * be holding the user's text somewhere the durability does not reach.
   */
  let {
    value,
    readOnly = false,
    onchange,
    label,
  }: {
    value: string;
    readOnly?: boolean;
    onchange: (next: string) => void;
    /** The accessible name — the file being edited, in plain words. */
    label: string;
  } = $props();

  let area = $state<HTMLTextAreaElement | null>(null);
  let rail = $state<HTMLDivElement | null>(null);

  const lines = $derived(value.split("\n").length);
  const numbers = $derived(Array.from({ length: lines }, (_, i) => i + 1));

  /** The rail follows the text's scroll exactly — one scroller, one offset. */
  function onScroll(): void {
    if (rail !== null && area !== null) rail.scrollTop = area.scrollTop;
  }

  /**
   * TAB INSERTS A TAB, and does not leave the field.
   *
   * In a text editor, Tab is indentation; the platform default (move focus)
   * makes the field impossible to indent in. The way OUT is still there and is
   * stated on the control: Escape then Tab, and every verb in this room has
   * its own focusable control — so this does not create a keyboard trap.
   */
  function onKeydown(ev: KeyboardEvent): void {
    if (ev.key !== "Tab" || ev.shiftKey || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const el = ev.currentTarget as HTMLTextAreaElement;
    ev.preventDefault();
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const next = `${value.slice(0, start)}\t${value.slice(end)}`;
    onchange(next);
    // Put the caret back after the character we inserted, on the next frame,
    // because the value round-trips through the buffer before it lands here.
    queueMicrotask(() => {
      el.selectionStart = start + 1;
      el.selectionEnd = start + 1;
    });
  }
  /** See the note on the <textarea> below: non-standard, deliberately untyped. */
  const AUTOCORRECT_OFF = { autocorrect: "off" };

</script>

<div class="text-editor">
  <div class="rail" bind:this={rail} aria-hidden="true">
    {#each numbers as n (n)}<span class="num">{n}</span>{/each}
  </div>
  <!-- `autocorrect` is a non-standard Safari/WebKit attribute: real behaviour
       on that engine, no DOM typing anywhere, so it cannot be written as a
       typed attribute. It is spread in from the constant above, which keeps
       every standard attribute beside it CHECKED rather than turning the whole
       element into an untyped bag. -->
  <textarea
    class="area"
    name="editor-text"
    bind:this={area}
    aria-label={label}
    readonly={readOnly}
    spellcheck="false"
    autocomplete="off"
    autocapitalize="off"
    {...AUTOCORRECT_OFF}
    wrap="off"
    value={value}
    oninput={(e) => onchange((e.currentTarget as HTMLTextAreaElement).value)}
    onkeydown={onKeydown}
    onscroll={onScroll}
  ></textarea>
</div>

<style>
  .text-editor {
    display: flex;
    align-items: stretch;
    min-height: 0;
    min-width: 0;
    flex: 1;
    border: var(--hairline-w) solid var(--line-1);
    border-radius: var(--radius-1);
    background: var(--ground-2);
    overflow: hidden;
  }
  /* The rail scrolls with the text and never scrolls itself: it is a mirror
   * of the same lines, so a scrollbar of its own would be a second opinion. */
  .rail {
    flex: none;
    width: var(--editor-gutter-w);
    overflow: hidden;
    padding: var(--code-pad-y) var(--sp-1) var(--code-pad-y) 0;
    text-align: right;
    border-right: var(--hairline-w) solid var(--line-1);
    background: var(--ground-1);
    font-family: var(--face-mono);
    font-size: var(--f-code-size);
    line-height: var(--f-code-lh);
    color: var(--ink-4);
    font-variant-numeric: tabular-nums;
    user-select: none;
  }
  .num {
    display: block;
  }
  .area {
    flex: 1;
    min-width: 0;
    resize: none;
    border: none;
    outline-offset: calc(-1 * var(--focus-ring-offset));
    background: none;
    color: var(--ink-1);
    padding: var(--code-pad-y) var(--code-pad-x);
    font-family: var(--face-mono);
    font-size: var(--f-code-size);
    line-height: var(--f-code-lh);
    tab-size: 2;
    white-space: pre;
    overflow: auto;
  }
</style>
