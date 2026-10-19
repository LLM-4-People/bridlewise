<script lang="ts">
  /**
   * THE GRIP — the one mouse-path primitive (MOUSE-FIRST law, v2.1).
   *
   * The cockpit's grammar is keyboard-complete (§2.7). On the web that is
   * only half a cockpit: a capability reachable ONLY by chord is a defect,
   * the exact inverse of the older rule that a keyboard-only interaction
   * with no visible counterpart is a defect. So every actionable grammar
   * target renders at least one GRIP: a small, quiet, always-present
   * control whose tooltip is GENERATED FROM the grammar table
   * (mouseTitleFor) — the mouse path teaches the keyboard path, and cannot
   * teach a key the router does not fire.
   *
   * `data-chord-target` is the machine-readable claim that this control IS
   * the click path for that target; the guard
   * (tests/cockpit/cockpit-mouse-path-owner.test.ts) reads exactly this
   * attribute and fails CI on any actionable target with no grip.
   *
   * Controls consume the shared verb recipe. Room tabs consume its shared
   * tab treatment; this component owns the action and keyboard hint.
   */
  import type { GrammarTarget } from "./contract.ts";
  import { mouseTitleFor } from "./keyboard.ts";
  // WARM ON INTENT. A grip is a hover target with a room behind it, so
  // dwelling on it is an honest prediction of the click. The plan is derived
  // from the SAME `target` string the grip fires, so a grip can never warm one
  // room and open another (shell/room-warm.ts).
  import { planForTarget, warmOnIntent } from "./room-warm.ts";

  let {
    target,
    label,
    disabled = false,
    /** Engraved word (rail rooms) vs. mono glyph (steppers, chevrons). */
    tone = "word",
    /**
     * When the target is a show/hide toggle (the run pane, the desk), the
     * toggle's CURRENT state so the grip announces it (`aria-pressed`). A
     * docked pane is a layout column with no focus steal — without this a
     * screen reader is told nothing when the surface appears. Absent for a
     * target that summons rather than toggles (a room); the grip then
     * carries no pressed state at all, which is the honest shape for a
     * control that is not a toggle.
     */
    pressed,
    selected,
    tab = false,
    onclick,
  }: {
    target: GrammarTarget;
    label: string;
    disabled?: boolean;
    tone?: "word" | "glyph";
    pressed?: boolean;
    /** Exclusive tab selection (Chat vs rooms). Distinct from `pressed`
     * (a mode that can sit on top of Chat, e.g. the run pane). */
    selected?: boolean;
    /** When true this grip is a tab face (role=tab, aria-selected). */
    tab?: boolean;
    onclick: (ev: MouseEvent) => void;
  } = $props();

  const title = $derived(mouseTitleFor(target));
  // Null for a target with nothing to warm (a mode, a stepper, a room whose
  // data the boot batch already holds) — the action then costs one no-op
  // listener pair and never opens a request.
  const warm = $derived(disabled ? null : planForTarget(target));
</script>

<button
  class="verb chord-grip {tone}"
  data-chord-target={target}
  data-verb-id={`chord.${target}`}
  {title}
  {disabled}
  {onclick}
  role={tab ? "tab" : undefined}
  aria-selected={tab ? selected === true : undefined}
  aria-pressed={pressed}
  use:warmOnIntent={warm}
>{label}</button>

<style>
  .chord-grip { white-space: nowrap; }
  .chord-grip.glyph {
    font-family: var(--face-mono);
  }
</style>
