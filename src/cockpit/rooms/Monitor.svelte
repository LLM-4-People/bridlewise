<script lang="ts">
  /**
   * INSTRUMENTS — the pinned-monitor REFERENCE (DESIGN-COCKPIT-V2 §8.2 /
   * §1.4). Uniform --monitor-w × --monitor-h: name · value · spark-dot.
   * A monitor is a reference to its single source, never a second
   * rendering — activating it opens the source.
   *
   * The HORIZON's own strip renders from the shell's `setMonitors` data
   * (fed by instruments-feed's projection — the shell owns its chrome);
   * THIS component is the same uniform monitor wherever the room needs to
   * show the pinned set as objects — the inline displace ask ("pinning a
   * 5th asks which to displace", §8.2) renders each candidate with it.
   *
   * The spark-dot obeys the §8.3 law like every chart: it exists only from
   * ≥2 measured points; below that the dot region is simply empty (the
   * value + asOf are the honest content).
   */
  import { sparkRenderable, asOfTime, type SignalPoint } from "./instruments-data.ts";
  import Spark from "./Spark.svelte";

  let {
    label,
    value,
    asOf,
    points,
    verbId,
    onOpen,
  }: {
    label: string;
    value: string;
    /** Epoch-ms of the measurement (§1.1 — asOf required). */
    asOf: number;
    points: readonly SignalPoint[];
    /** The verb this reference performs when activated (§1.2). */
    verbId: string;
    onOpen: () => void;
  } = $props();
</script>

<button class="monitor" data-verb-id={verbId} title={`asOf ${asOfTime(asOf)}`} onclick={onOpen}>
  <span class="label engraved trunc">{label}</span>
  {#if sparkRenderable(points)}
    <Spark {points} variant="dot" />
  {/if}
  <span class="value">{value}</span>
</button>

<style>
  .monitor {
    width: var(--monitor-w);
    height: var(--monitor-h);
    box-sizing: border-box;
    border: var(--hairline-w) solid var(--line-1);
    border-radius: var(--radius-0);
    background: var(--ground-1);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-1);
    padding: 0 var(--sp-2);
    font: inherit;
    color: inherit;
    cursor: pointer;
    min-width: 0;
  }
  .monitor:hover {
    background: var(--layer-hover);
  }
  /* The label's engraved recipe is owned by tokens.css (.cockpit .engraved),
   * carried here as the marker class — the monitor's name is THE engraved
   * label, the same instrument word as every other room's. */
  .value {
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--ink-1);
    white-space: nowrap;
  }
</style>
