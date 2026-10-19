<script lang="ts">
  /**
   * INSTRUMENTS — the spark (DESIGN-COCKPIT-V2 §8.3, the no-broken-chart
   * law). A time series renders ONLY from its measured ring buffer:
   *
   *   - fed <2 measured points this component THROWS in dev — the CELL is
   *     the one that renders the absence state instead; a spark that would
   *     draw an empty axis cannot exist by construction;
   *   - x is proportional to MEASURED time and adjacent points further
   *     apart than the sampling cadence × gap factor are never connected —
   *     gaps render as gaps, no interpolation ever;
   *   - no axes, no placeholder states, quiet ink only (the dark-cockpit
   *     law: a spark is data, not decoration).
   *
   * The `dot` variant is the HORIZON monitor's micro-spark (§8.2
   * "spark-dot"): same painter, same law, --spark-dot-w wide.
   *
   * jsdom cannot paint a canvas; the sr-only sentence naming the measured
   * point count and time range is the always-present access.
   */
  import {
    SIGNALS_POLL_MS,
    SPARK_GAP_FACTOR,
    SPARK_MIN_POINTS,
  } from "./instruments-config.ts";
  import {
    InstrumentHonestyViolation,
    sparkSegments,
    asOfTime,
    type SignalPoint,
  } from "./instruments-data.ts";
  import {
    designConditions,
    watchDesignConditions,
    withPaintTokens,
  } from "../paint/design-tokens.ts";
  import { whileRoomVisible } from "../shell/room-visibility.ts";

  let {
    points,
    variant = "cell",
  }: {
    points: readonly SignalPoint[];
    variant?: "cell" | "dot";
  } = $props();

  /** §8.3 guard — throws in dev (and under vitest) the moment a caller
   * feeds a buffer no honest chart can come from. */
  function assertFeed(pts: readonly SignalPoint[]): readonly SignalPoint[] {
    if (pts.length < SPARK_MIN_POINTS && import.meta.env.DEV) {
      throw new InstrumentHonestyViolation(
        `Spark fed ${pts.length} measured point(s) — <${SPARK_MIN_POINTS} cannot chart; ` +
          "render the absence state instead (§8.3 no-broken-chart law)",
      );
    }
    return pts;
  }

  const pts = $derived(assertFeed(points));

  let canvas: HTMLCanvasElement | undefined = $state();

  function paint(el: HTMLCanvasElement, series: readonly SignalPoint[]): void {
    if (series.length < SPARK_MIN_POINTS) return; // prod: nothing, never a broken axis
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = el.getContext("2d");
    } catch {
      ctx = null; // jsdom — the sr sentence below is the access
    }
    if (ctx === null) return;
    const dpr = typeof devicePixelRatio === "number" ? Math.max(1, devicePixelRatio) : 1;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w === 0 || h === 0) return;
    el.width = Math.round(w * dpr);
    el.height = Math.round(h * dpr);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const t0 = series[0]!.t;
    const tN = series[series.length - 1]!.t;
    const span = Math.max(1, tN - t0);
    let min = Infinity;
    let max = -Infinity;
    for (const p of series) {
      if (p.v < min) min = p.v;
      if (p.v > max) max = p.v;
    }
    const range = max - min;
    const pad = 2; // device px inside a fixed-token canvas — position math, not layout
    const x = (t: number): number => pad + ((t - t0) / span) * (w - pad * 2);
    const y = (v: number): number =>
      range === 0 ? h / 2 : h - pad - ((v - min) / range) * (h - pad * 2);

    // Through the paint owner, inside the paint: a reader obtained here
    // cannot survive into the next frame, and this chart is covered by the
    // same theme signal as every other canvas. Stylesheet-less fallback
    // comes from TOKEN_FALLBACKS at the paint door, not a hex here.
    const ink = withPaintTokens(el, (read) => read("--ink-3"));
    ctx.strokeStyle = ink;
    ctx.fillStyle = ink;
    ctx.lineWidth = 1;

    for (const seg of sparkSegments(series, SIGNALS_POLL_MS, SPARK_GAP_FACTOR)) {
      if (seg.length === 1) {
        // A lone measurement between gaps is a dot — never a line to a
        // neighbor nothing was measured between.
        ctx.fillRect(x(seg[0]!.t) - 1, y(seg[0]!.v) - 1, 2, 2);
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(x(seg[0]!.t), y(seg[0]!.v));
      for (let i = 1; i < seg.length; i += 1) ctx.lineTo(x(seg[i]!.t), y(seg[i]!.v));
      ctx.stroke();
    }
  }

  $effect(() => watchDesignConditions());

  /** Same bitmap release as MicroSweep, for the same reason: the kept-alive
   * Instruments room holds one spark canvas per cell (112 of them), and a
   * hidden room's painted bitmaps are memory spent on pixels nobody can
   * see. The series stays; the show repaints from it in the same frame. */
  let onScreen = $state(true);
  $effect(() => {
    return whileRoomVisible("instruments", () => {
      onScreen = true;
      return () => {
        onScreen = false;
        const el = canvas;
        if (el !== undefined) {
          el.width = 0;
          el.height = 0;
        }
      };
    });
  });

  $effect(() => {
    const el = canvas;
    const series = pts;
    // NAMED SIGNAL — see MicroSweep: a theme switch changes neither the canvas
    // nor the series, so a chart that does not read this keeps the ink of the
    // theme it was drawn under.
    void $designConditions;
    if (!onScreen) return;
    if (el === undefined) return;
    paint(el, series);
  });
</script>

<span class="spark" data-variant={variant} data-points={pts.length}>
  <canvas bind:this={canvas} class="strip" aria-hidden="true"></canvas>
  <span class="sr">
    {pts.length} measured points, {asOfTime(pts[0]?.t ?? 0)} to {asOfTime(pts[pts.length - 1]?.t ?? 0)}
  </span>
</span>

<style>
  .spark {
    display: inline-flex;
    width: var(--spark-w);
    height: var(--spark-h);
    position: relative;
  }
  .spark[data-variant="dot"] {
    width: var(--spark-dot-w);
    height: calc(var(--monitor-h) - var(--sp-2));
  }
  .strip {
    width: 100%;
    height: 100%;
    display: block;
  }
  .sr {
    position: absolute;
    width: var(--hairline-w);
    height: var(--hairline-w);
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
