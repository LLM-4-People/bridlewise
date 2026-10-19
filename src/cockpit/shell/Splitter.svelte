<script lang="ts">
  /**
   * SPLITTER — the ONE draggable hairline between two regions.
   *
   * A splitter is a control over a NUMBER the settings surface also owns
   * (the local-prefs splitter pair), so this component decides nothing about
   * where the number lives: the host passes the current value and its
   * declared bounds, receives previews while the pointer moves and ONE
   * commit when it settles, and owns both the application (the CSS token
   * override) and the persistence (the one local write path). Two hosts,
   * one gesture, zero copies of the arithmetic.
   *
   * The gesture is POINTER EVENTS with capture — never the HTML5 drag API,
   * which paints a translucent ghost of the dragged node and drops the
   * gesture at the first missed dragover. Capture keeps every move event
   * coming to this element however far the pointer strays, and there is
   * nothing to ghost because nothing is "dragged" — a number changes.
   *
   * Keyboard: a `role="separator"` with a tabindex is the ARIA pattern for
   * exactly this control; the arrow keys along the splitter's axis step the
   * value, and the current number is spoken through `aria-valuenow`.
   * Double-click (and its keyboard twin, Home via the host's reset) returns
   * to the built-in value — the tooltip says all three, so the hairline
   * teaches its own gestures (mouse-first law: no chord-only capability,
   * and no gesture-only one either).
   */
  let {
    label,
    orientation,
    value,
    min,
    max,
    step,
    defaultWords,
    unitPerPx = 1,
    invert = false,
    onadjust,
    onreset,
  }: {
    /** What this hairline resizes, in plain words (aria-label). */
    label: string;
    /** "vertical" = a column divider (adjusts a width, ← →);
     *  "horizontal" = a row divider (adjusts a height, ↑ ↓). */
    orientation: "vertical" | "horizontal";
    /** The current value, in the HOST's unit (px, %, …). */
    value: number;
    min: number;
    max: number;
    /** One arrow-key press moves this much. */
    step: number;
    /** What double-click returns to, in words ("the built-in 280 px"). */
    defaultWords: string;
    /** Host-unit change per pointer pixel (a %-valued host passes 100/room). */
    unitPerPx?: number;
    /** True when a positive pointer move should SHRINK the value (a bottom
     *  panel grows as the pointer travels up). */
    invert?: boolean;
    /** A new value. `commit` is false while the pointer is still down —
     *  preview only; true exactly once per settled gesture or key press. */
    onadjust: (next: number, commit: boolean) => void;
    /** Double-click — return to the built-in value. */
    onreset: () => void;
  } = $props();

  let drag = $state<{ pointerId: number; startPos: number; startValue: number } | null>(null);

  const clamp = (v: number): number => Math.min(max, Math.max(min, Math.round(v)));

  function pos(ev: PointerEvent): number {
    return orientation === "vertical" ? ev.clientX : ev.clientY;
  }

  function valueAt(ev: PointerEvent): number {
    if (drag === null) return value;
    const delta = (pos(ev) - drag.startPos) * (invert ? -1 : 1) * unitPerPx;
    return clamp(drag.startValue + delta);
  }

  function down(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    drag = { pointerId: ev.pointerId, startPos: pos(ev), startValue: value };
  }

  function move(ev: PointerEvent): void {
    if (drag === null || ev.pointerId !== drag.pointerId) return;
    onadjust(valueAt(ev), false);
  }

  function up(ev: PointerEvent): void {
    if (drag === null || ev.pointerId !== drag.pointerId) return;
    const settled = valueAt(ev);
    drag = null;
    onadjust(settled, true);
  }

  function key(ev: KeyboardEvent): void {
    const [dec, inc] =
      orientation === "vertical" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
    if (ev.key !== dec && ev.key !== inc) return;
    ev.preventDefault();
    const dir = (ev.key === inc ? 1 : -1) * (invert ? -1 : 1);
    const next = clamp(value + dir * step);
    if (next !== value) onadjust(next, true);
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<!-- ARIA defines TWO separators: the static divider (non-interactive) and
     the FOCUSABLE window splitter, which is this one — tabbable, valued
     (aria-valuenow) and arrow-operated per the authoring practices. The
     checker models only the first, so the warning is about a pattern this
     element is deliberately not. -->
<div
  class="splitter"
  class:vertical={orientation === "vertical"}
  role="separator"
  tabindex="0"
  aria-orientation={orientation}
  aria-label={label}
  aria-valuenow={value}
  aria-valuemin={min}
  aria-valuemax={max}
  title={`drag to resize · arrow keys when focused · double-click returns to ${defaultWords}`}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
  ondblclick={onreset}
  onkeydown={key}
></div>

<style>
  /* A hairline to the eye, a real target to the pointer: the box is wider
   * than the line it draws, and the line is painted centred inside it so
   * the neighbours' own borders are not doubled. */
  .splitter {
    flex: none;
    touch-action: none;
    background: transparent;
    position: relative;
    z-index: 1;
  }
  .splitter::before {
    content: "";
    position: absolute;
    background: var(--line-2);
  }
  /* Row divider (default): full width, thin, resizes vertically. */
  .splitter {
    cursor: row-resize;
    height: var(--sp-2);
    width: 100%;
  }
  .splitter::before {
    left: 0;
    right: 0;
    top: 50%;
    height: var(--hairline-w);
  }
  .splitter.vertical {
    cursor: col-resize;
    width: var(--sp-2);
    height: auto;
    align-self: stretch;
  }
  .splitter.vertical::before {
    top: 0;
    bottom: 0;
    left: 50%;
    right: auto;
    width: var(--hairline-w);
    height: auto;
  }
  .splitter:hover::before,
  .splitter:focus-visible::before {
    background: var(--beam);
  }
  .splitter:focus-visible {
    outline: none;
  }
</style>
