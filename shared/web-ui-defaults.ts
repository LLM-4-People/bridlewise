/**
 * Web-UI tunable DEFAULTS + readers — the single declaration, shared
 * server↔client.
 *
 * The `webUi.graph`, `webUi.metrics` and `artifacts.iframeSandbox` sections
 * of the harness config are read on BOTH sides: the server reads the config
 * file directly (`server/harness-config.ts`), the client reads the redacted
 * snapshot served by `GET /api/config` (`src/state/web-ui-config.ts`). Both
 * need the same fallback values for a missing/partial section.
 *
 * Until now each side carried its OWN copy of the 30-key
 * `DEFAULT_GRAPH_CONFIG` table, its own `DEFAULT_METRICS_CONFIG`, its own
 * `allow-scripts` literal and its own `asPositiveInt`/`asPositiveNumber`
 * coercers — byte-identical duplicates kept in step by a drift test rather
 * than by construction. `tsconfig.server.json` excludes `src/`, so the
 * server cannot import the client copy; `shared/` is the seam that BOTH
 * sides compile against, which is why the declaration belongs here.
 *
 * The values were MOVED here verbatim from the two former copies; the
 * readers are the same pure functions, taking a raw config object so either
 * side (and a test) can call them without a live config store.
 */

import type { GraphConfig, MetricsConfig } from "./wire-types.ts";

/** Coerce to a positive integer, else the fallback. */
export function asPositiveInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}
/** Coerce to a positive number, else the fallback. */
export function asPositiveNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * Default sandbox token for artifact iframes. Scripts run; NO same-origin
 * access (an artifact cannot touch the parent page, cookies, or storage).
 * MUST NOT include `allow-same-origin`.
 */
export const DEFAULT_ARTIFACT_SANDBOX = "allow-scripts";

export const DEFAULT_GRAPH_CONFIG: GraphConfig = {
  maxNodes: 500,
  repulsion: 8000,
  springLength: 80,
  springStrength: 0.04,
  centering: 0.008,
  damping: 0.85,
  iterations: 120,
  maxNodeRadius: 14,
  minNodeRadius: 4,
  nodeSpacing: 90,
  minSeparation: 24,
  labelMinNodeScreenPx: 9,
  labelTopDegreeCount: 12,
  labelGapPx: 4,
  labelPaddingPx: 3,
  minZoom: 0.3,
  maxZoom: 5,
  minCanvasPx: 200,
  maxFitScale: 2,
  fitMarginPx: 40,
  fallbackWidth: 800,
  fallbackHeight: 600,
  labelFontPx: 11,
  labelShowAllZoom: 1.5,
  hitPaddingPx: 4,
  wheelZoomFactor: 1.1,
  buttonZoomIn: 1.2,
  buttonZoomOut: 0.8,
  indexingPollMs: 2000,
  maxCyclesDisplayed: 10,
};
Object.freeze(DEFAULT_GRAPH_CONFIG);

export const DEFAULT_METRICS_CONFIG: MetricsConfig = { pollMs: 8000, historyMax: 60 };
Object.freeze(DEFAULT_METRICS_CONFIG);

type GraphSection = Readonly<Record<string, unknown>>;
type MetricsSection = Readonly<Record<string, unknown>>;

/** Read the `webUi.graph` section from a raw config object with defaults. */
export function readGraphConfig(config: Readonly<Record<string, unknown>> | null | undefined): GraphConfig {
  const webUi = config?.webUi as Readonly<Record<string, unknown>> | undefined;
  const g = webUi?.graph as GraphSection | undefined;
  if (g === undefined) return DEFAULT_GRAPH_CONFIG;
  return {
    maxNodes: asPositiveInt(g.maxNodes, DEFAULT_GRAPH_CONFIG.maxNodes),
    repulsion: asPositiveNumber(g.repulsion, DEFAULT_GRAPH_CONFIG.repulsion),
    springLength: asPositiveNumber(g.springLength, DEFAULT_GRAPH_CONFIG.springLength),
    springStrength: asPositiveNumber(g.springStrength, DEFAULT_GRAPH_CONFIG.springStrength),
    centering: asPositiveNumber(g.centering, DEFAULT_GRAPH_CONFIG.centering),
    damping: asPositiveNumber(g.damping, DEFAULT_GRAPH_CONFIG.damping),
    iterations: asPositiveInt(g.iterations, DEFAULT_GRAPH_CONFIG.iterations),
    maxNodeRadius: asPositiveNumber(g.maxNodeRadius, DEFAULT_GRAPH_CONFIG.maxNodeRadius),
    minNodeRadius: asPositiveNumber(g.minNodeRadius, DEFAULT_GRAPH_CONFIG.minNodeRadius),
    nodeSpacing: asPositiveNumber(g.nodeSpacing, DEFAULT_GRAPH_CONFIG.nodeSpacing),
    minSeparation: asPositiveNumber(g.minSeparation, DEFAULT_GRAPH_CONFIG.minSeparation),
    labelMinNodeScreenPx: asPositiveNumber(g.labelMinNodeScreenPx, DEFAULT_GRAPH_CONFIG.labelMinNodeScreenPx),
    labelTopDegreeCount: asPositiveInt(g.labelTopDegreeCount, DEFAULT_GRAPH_CONFIG.labelTopDegreeCount),
    labelGapPx: asPositiveNumber(g.labelGapPx, DEFAULT_GRAPH_CONFIG.labelGapPx),
    labelPaddingPx: asPositiveNumber(g.labelPaddingPx, DEFAULT_GRAPH_CONFIG.labelPaddingPx),
    minZoom: asPositiveNumber(g.minZoom, DEFAULT_GRAPH_CONFIG.minZoom),
    maxZoom: asPositiveNumber(g.maxZoom, DEFAULT_GRAPH_CONFIG.maxZoom),
    minCanvasPx: asPositiveInt(g.minCanvasPx, DEFAULT_GRAPH_CONFIG.minCanvasPx),
    maxFitScale: asPositiveNumber(g.maxFitScale, DEFAULT_GRAPH_CONFIG.maxFitScale),
    fitMarginPx: asPositiveInt(g.fitMarginPx, DEFAULT_GRAPH_CONFIG.fitMarginPx),
    fallbackWidth: asPositiveInt(g.fallbackWidth, DEFAULT_GRAPH_CONFIG.fallbackWidth),
    fallbackHeight: asPositiveInt(g.fallbackHeight, DEFAULT_GRAPH_CONFIG.fallbackHeight),
    labelFontPx: asPositiveNumber(g.labelFontPx, DEFAULT_GRAPH_CONFIG.labelFontPx),
    labelShowAllZoom: asPositiveNumber(g.labelShowAllZoom, DEFAULT_GRAPH_CONFIG.labelShowAllZoom),
    hitPaddingPx: asPositiveNumber(g.hitPaddingPx, DEFAULT_GRAPH_CONFIG.hitPaddingPx),
    wheelZoomFactor: asPositiveNumber(g.wheelZoomFactor, DEFAULT_GRAPH_CONFIG.wheelZoomFactor),
    buttonZoomIn: asPositiveNumber(g.buttonZoomIn, DEFAULT_GRAPH_CONFIG.buttonZoomIn),
    buttonZoomOut: asPositiveNumber(g.buttonZoomOut, DEFAULT_GRAPH_CONFIG.buttonZoomOut),
    indexingPollMs: asPositiveInt(g.indexingPollMs, DEFAULT_GRAPH_CONFIG.indexingPollMs),
    maxCyclesDisplayed: asPositiveInt(g.maxCyclesDisplayed, DEFAULT_GRAPH_CONFIG.maxCyclesDisplayed),
  };
}

/** Read the `webUi.metrics` section from a raw config object with defaults. */
export function readMetricsConfig(config: Readonly<Record<string, unknown>> | null | undefined): MetricsConfig {
  const webUi = config?.webUi as Readonly<Record<string, unknown>> | undefined;
  const m = webUi?.metrics as MetricsSection | undefined;
  if (m === undefined) return DEFAULT_METRICS_CONFIG;
  return {
    pollMs: asPositiveInt(m.pollMs, DEFAULT_METRICS_CONFIG.pollMs),
    historyMax: asPositiveInt(m.historyMax, DEFAULT_METRICS_CONFIG.historyMax),
  };
}
