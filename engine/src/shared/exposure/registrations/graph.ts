/**
 * Shared exposure registrations — `graph` module.
 *
 * The force-layout map, metrics poll, and self-improving suggestion
 * thresholds already live in `webUi.*` and are read live by
 * `getGraphConfig` / `getMetricsConfig` / `getSelfImprovingConfig`.
 * This file publishes the operator-facing knobs onto the settings
 * surface so they are reachable without editing the config file by hand.
 */

import {
  registerCustomization,
  registerExposureModule,
  readNumberCustomization,
  writeConfigCustomization,
} from "../index.ts";

/** Fallback when the config file omits the key — matches the live
 * `webUi.graph` / `webUi.metrics` / `webUi.selfImproving` floors. */
const DEFAULTS = {
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
  indexingPollMs: 2_000,
  maxCyclesDisplayed: 10,
  pollMs: 8_000,
  historyMax: 60,
  minSampleCount: 5,
  errorRateThreshold: 0.25,
  slowToolMsThreshold: 5_000,
  slowLlmMsThreshold: 30_000,
  maxSuggestions: 10,
} as const;

function registerNum(spec: {
  id: string;
  name: string;
  description: string;
  configPath: string;
  default: number;
  min: number;
  max: number;
  unit?: string;
}): void {
  registerCustomization({
    id: spec.id,
    module: "graph",
    name: spec.name,
    description: spec.description,
    type: "number",
    default: spec.default,
    min: spec.min,
    max: spec.max,
    ...(spec.unit !== undefined ? { unit: spec.unit } : {}),
    current: () => readNumberCustomization(spec.configPath, spec.default),
    set: (v) => writeConfigCustomization(spec.configPath, v),
    contract: { effect: "immediate" },
    configPath: spec.configPath,
  });
}

let graphRegistered = false;
export function registerGraphExposure(): void {
  if (graphRegistered) return;
  graphRegistered = true;

  registerExposureModule({
    id: "graph",
    title: "The code map drawn on screen",
    purpose:
      "How many files the map shows, how far you can zoom, how often readings refresh, and when a slow or failing tool is worth flagging.",
  });

  registerNum({
    id: "graph.maxNodes",
    name: "Most files drawn on the map",
    description:
      "The on-screen code map keeps at most this many files. Raising it shows more of the tree and costs more layout work; lowering it keeps the picture small.",
    configPath: "webUi.graph.maxNodes",
    default: DEFAULTS.maxNodes,
    min: 10,
    max: 5_000,
    unit: "files",
  });
  registerNum({
    id: "graph.repulsion",
    name: "How strongly files push apart",
    description:
      "Raising this spreads clusters farther apart. Lowering it lets related files sit closer, which can crowd a dense tree.",
    configPath: "webUi.graph.repulsion",
    default: DEFAULTS.repulsion,
    min: 100,
    max: 50_000,
    unit: "force"
  });
  registerNum({
    id: "graph.springLength",
    name: "Preferred distance along an import edge",
    description:
      "Files that import each other try to sit this far apart. Raising it stretches the map; lowering it packs connected files tighter.",
    configPath: "webUi.graph.springLength",
    default: DEFAULTS.springLength,
    min: 10,
    max: 400,
    unit: "length"
  });
  registerNum({
    id: "graph.springStrength",
    name: "How tightly import edges pull",
    description:
      "Raising this yanks connected files toward the preferred distance more strongly. Lowering it lets the push-apart force dominate.",
    configPath: "webUi.graph.springStrength",
    default: DEFAULTS.springStrength,
    min: 0.001,
    max: 1,
    unit: "strength"
  });
  registerNum({
    id: "graph.centering",
    name: "How strongly the map is pulled to the middle",
    description:
      "Raising this keeps the whole picture from drifting off the canvas. Lowering it lets clusters sit where the other forces leave them.",
    configPath: "webUi.graph.centering",
    default: DEFAULTS.centering,
    min: 0.0001,
    max: 0.2,
    unit: "share"
  });
  registerNum({
    id: "graph.damping",
    name: "How quickly the layout settles",
    description:
      "Raising this toward one damps motion so the map stops moving sooner. Lowering it lets nodes keep drifting and can look livelier or never rest.",
    configPath: "webUi.graph.damping",
    default: DEFAULTS.damping,
    min: 0.1,
    max: 0.99,
    unit: "share"
  });
  registerNum({
    id: "graph.iterations",
    name: "Layout steps run per refresh",
    description:
      "The drawing runs this many force steps each time it updates. Raising it settles a tangled tree further and costs more work per frame.",
    configPath: "webUi.graph.iterations",
    default: DEFAULTS.iterations,
    min: 1,
    max: 1_000,
    unit: "steps",
  });
  registerNum({
    id: "graph.maxNodeRadius",
    name: "Largest file circle on the map",
    description:
      "A highly connected file is drawn no larger than this. Raising it makes hubs more obvious; lowering it keeps every circle modest.",
    configPath: "webUi.graph.maxNodeRadius",
    default: DEFAULTS.maxNodeRadius,
    min: 2,
    max: 80,
    unit: "pixels"
  });
  registerNum({
    id: "graph.minNodeRadius",
    name: "Smallest file circle on the map",
    description:
      "A barely connected file is drawn no smaller than this. Raising it keeps tiny files clickable; lowering it makes them recede.",
    configPath: "webUi.graph.minNodeRadius",
    default: DEFAULTS.minNodeRadius,
    min: 1,
    max: 40,
    unit: "pixels"
  });
  registerNum({
    id: "graph.nodeSpacing",
    name: "Target gap used to size the layout space",
    description:
      "The map's own coordinate space is sized from this gap times the file count, so density stays even as the tree grows. Raising it gives every file more room.",
    configPath: "webUi.graph.nodeSpacing",
    default: DEFAULTS.nodeSpacing,
    min: 10,
    max: 400,
    unit: "length"
  });
  registerNum({
    id: "graph.minSeparation",
    name: "Closest two files are allowed to sit",
    description:
      "The push-apart force will not treat two files as closer than this, so overlapping circles cannot explode the layout. Raising it keeps a thicker gap.",
    configPath: "webUi.graph.minSeparation",
    default: DEFAULTS.minSeparation,
    min: 1,
    max: 200,
    unit: "length"
  });
  registerNum({
    id: "graph.labelMinNodeScreenPx",
    name: "On-screen size at which a file earns its name",
    description:
      "A file's name is drawn once its circle is at least this many pixels across. Raising it hides names until you zoom closer; lowering it labels smaller circles.",
    configPath: "webUi.graph.labelMinNodeScreenPx",
    default: DEFAULTS.labelMinNodeScreenPx,
    min: 1,
    max: 80,
    unit: "pixels",
  });
  registerNum({
    id: "graph.labelTopDegreeCount",
    name: "Hub files that keep their names at any zoom",
    description:
      "This many most-connected files are always named, even when zoomed out, so a dense map is never anonymous. Raising it labels more hubs and can crowd the view.",
    configPath: "webUi.graph.labelTopDegreeCount",
    default: DEFAULTS.labelTopDegreeCount,
    min: 1,
    max: 200,
    unit: "files",
  });
  registerNum({
    id: "graph.labelGapPx",
    name: "Gap between a file circle and its name",
    description:
      "The name is drawn this many pixels away from the circle's edge. Raising it sits names farther out; lowering it tucks them closer.",
    configPath: "webUi.graph.labelGapPx",
    default: DEFAULTS.labelGapPx,
    min: 0.1,
    max: 40,
    unit: "pixels",
  });
  registerNum({
    id: "graph.labelPaddingPx",
    name: "Minimum gap between two drawn names",
    description:
      "If two names cannot keep this many pixels apart, one is dropped so they do not smear. Raising it hides more overlapping names; lowering it draws a denser forest of text.",
    configPath: "webUi.graph.labelPaddingPx",
    default: DEFAULTS.labelPaddingPx,
    min: 0.1,
    max: 40,
    unit: "pixels",
  });
  registerNum({
    id: "graph.minZoom",
    name: "How far the map can zoom out",
    description:
      "The smallest zoom the code map will accept. Lowering it lets you see more of the tree at once; raising it keeps labels larger.",
    configPath: "webUi.graph.minZoom",
    default: DEFAULTS.minZoom,
    min: 0.05,
    max: 1,
    unit: "factor"
  });
  registerNum({
    id: "graph.maxZoom",
    name: "How far the map can zoom in",
    description:
      "The largest zoom the code map will accept. Raising it lets you inspect a cluster more closely; lowering it stops the view from going past useful detail.",
    configPath: "webUi.graph.maxZoom",
    default: DEFAULTS.maxZoom,
    min: 1,
    max: 20,
    unit: "factor"
  });
  registerNum({
    id: "graph.minCanvasPx",
    name: "Smallest drawing area the map will use",
    description:
      "If the panel is narrower than this many pixels, the map still lays out as if it had this width so the picture does not collapse. Raising it keeps a larger minimum stage.",
    configPath: "webUi.graph.minCanvasPx",
    default: DEFAULTS.minCanvasPx,
    min: 50,
    max: 2_000,
    unit: "pixels",
  });
  registerNum({
    id: "graph.maxFitScale",
    name: "Most the auto-fit may enlarge the picture",
    description:
      "When fitting the whole tree into the panel, the map will not enlarge past this factor. Raising it lets a small tree fill the panel; lowering it leaves more empty margin.",
    configPath: "webUi.graph.maxFitScale",
    default: DEFAULTS.maxFitScale,
    min: 0.1,
    max: 10,
    unit: "factor"
  });
  registerNum({
    id: "graph.fitMarginPx",
    name: "Empty margin left when fitting the whole tree",
    description:
      "Auto-fit keeps this many pixels of empty space around the tree. Raising it frames the picture with more margin; lowering it uses more of the panel.",
    configPath: "webUi.graph.fitMarginPx",
    default: DEFAULTS.fitMarginPx,
    min: 1,
    max: 200,
    unit: "pixels",
  });
  registerNum({
    id: "graph.fallbackWidth",
    name: "Assumed panel width before the real size is known",
    description:
      "Until the panel reports its size, the map lays out as if it were this many pixels wide. Raising it matches a larger window; lowering it matches a narrower one.",
    configPath: "webUi.graph.fallbackWidth",
    default: DEFAULTS.fallbackWidth,
    min: 100,
    max: 4_000,
    unit: "pixels",
  });
  registerNum({
    id: "graph.fallbackHeight",
    name: "Assumed panel height before the real size is known",
    description:
      "Until the panel reports its size, the map lays out as if it were this many pixels tall. Raising it matches a taller window; lowering it matches a shorter one.",
    configPath: "webUi.graph.fallbackHeight",
    default: DEFAULTS.fallbackHeight,
    min: 100,
    max: 4_000,
    unit: "pixels",
  });
  registerNum({
    id: "graph.labelFontPx",
    name: "Size of file names on the map",
    description:
      "File names are drawn at this many pixels. Raising it makes names easier to read and more likely to collide; lowering it fits more names in a dense cluster.",
    configPath: "webUi.graph.labelFontPx",
    default: DEFAULTS.labelFontPx,
    min: 6,
    max: 32,
    unit: "pixels",
  });
  registerNum({
    id: "graph.labelShowAllZoom",
    name: "Zoom at which every file name is drawn",
    description:
      "Once zoomed in this far, every remaining file is named, not only the hubs. Lowering it names everything sooner; raising it waits for a closer view.",
    configPath: "webUi.graph.labelShowAllZoom",
    default: DEFAULTS.labelShowAllZoom,
    min: 0.1,
    max: 10,
    unit: "factor"
  });
  registerNum({
    id: "graph.hitPaddingPx",
    name: "Extra clickable area around each file",
    description:
      "A click this many pixels outside a circle still selects that file. Raising it makes small files easier to hit; lowering it requires a more precise click.",
    configPath: "webUi.graph.hitPaddingPx",
    default: DEFAULTS.hitPaddingPx,
    min: 0.1,
    max: 40,
    unit: "pixels",
  });
  registerNum({
    id: "graph.wheelZoomFactor",
    name: "How much one scroll step changes zoom",
    description:
      "Each wheel step multiplies the current zoom by this factor. Raising it jumps farther per flick; lowering it toward one makes zoom finer.",
    configPath: "webUi.graph.wheelZoomFactor",
    default: DEFAULTS.wheelZoomFactor,
    min: 1.01,
    max: 2,
    unit: "factor"
  });
  registerNum({
    id: "graph.buttonZoomIn",
    name: "How much the zoom-in button enlarges",
    description:
      "The zoom-in control multiplies the current zoom by this factor. Raising it jumps in farther per click; lowering it toward one makes each click a smaller step.",
    configPath: "webUi.graph.buttonZoomIn",
    default: DEFAULTS.buttonZoomIn,
    min: 1.01,
    max: 3,
    unit: "factor"
  });
  registerNum({
    id: "graph.buttonZoomOut",
    name: "How much the zoom-out button shrinks",
    description:
      "The zoom-out control multiplies the current zoom by this factor (below one). Lowering it jumps out farther per click; raising it toward one makes each click a smaller step.",
    configPath: "webUi.graph.buttonZoomOut",
    default: DEFAULTS.buttonZoomOut,
    min: 0.2,
    max: 0.99,
    unit: "factor"
  });
  registerNum({
    id: "graph.indexingPollMs",
    name: "How often the map asks whether indexing finished",
    description:
      "While a project is still being mapped, the drawing asks again this many milliseconds later. Shorter updates sooner; longer is quieter.",
    configPath: "webUi.graph.indexingPollMs",
    default: DEFAULTS.indexingPollMs,
    min: 200,
    max: 30_000,
    unit: "milliseconds",
  });
  registerNum({
    id: "graph.maxCyclesDisplayed",
    name: "Import cycles listed on the map",
    description:
      "The map names this many import cycles and hides the rest. Raising it surfaces more loops; lowering it keeps the list short.",
    configPath: "webUi.graph.maxCyclesDisplayed",
    default: DEFAULTS.maxCyclesDisplayed,
    min: 1,
    max: 100,
    unit: "cycles",
  });
  registerNum({
    id: "graph.metricsPollMs",
    name: "How often live readings refresh",
    description:
      "Instrument readings are asked for again this many milliseconds later. Shorter is more current and costs more requests; longer is quieter.",
    configPath: "webUi.metrics.pollMs",
    default: DEFAULTS.pollMs,
    min: 250,
    max: 60_000,
    unit: "milliseconds",
  });
  registerNum({
    id: "graph.metricsHistoryMax",
    name: "How many past readings to keep",
    description:
      "The instruments keep this many samples of each reading. Raising it lengthens the sparkline; lowering it forgets older points sooner.",
    configPath: "webUi.metrics.historyMax",
    default: DEFAULTS.historyMax,
    min: 5,
    max: 500,
    unit: "samples",
  });
  registerNum({
    id: "graph.minSampleCount",
    name: "Readings needed before a slow-tool flag is raised",
    description:
      "A tool is not called slow or error-prone until this many samples exist, so a single blip cannot become a suggestion. Raising it waits for a thicker record.",
    configPath: "webUi.selfImproving.minSampleCount",
    default: DEFAULTS.minSampleCount,
    min: 1,
    max: 100,
    unit: "samples",
  });
  registerNum({
    id: "graph.errorRateThreshold",
    name: "Error share that makes a tool worth flagging",
    description:
      "When a tool's failures pass this fraction of its calls, a suggestion is raised. Lowering it flags earlier; raising it waits for a clearer pattern.",
    configPath: "webUi.selfImproving.errorRateThreshold",
    default: DEFAULTS.errorRateThreshold,
    min: 0,
    max: 1,
    unit: "share"
  });
  registerNum({
    id: "graph.slowToolMsThreshold",
    name: "Call duration that counts a tool as slow",
    description:
      "A tool call that lasts longer than this many milliseconds is counted as slow. Lowering it flags milder delays; raising it waits for a longer stall.",
    configPath: "webUi.selfImproving.slowToolMsThreshold",
    default: DEFAULTS.slowToolMsThreshold,
    min: 50,
    max: 120_000,
    unit: "milliseconds",
  });
  registerNum({
    id: "graph.slowLlmMsThreshold",
    name: "Call duration that counts a model reply as slow",
    description:
      "A model call that lasts longer than this many milliseconds is counted as slow. Lowering it flags milder delays; raising it waits for a longer stall.",
    configPath: "webUi.selfImproving.slowLlmMsThreshold",
    default: DEFAULTS.slowLlmMsThreshold,
    min: 50,
    max: 300_000,
    unit: "milliseconds",
  });
  registerNum({
    id: "graph.maxSuggestions",
    name: "Most improvement notes shown at once",
    description:
      "The suggestion list keeps at most this many notes. Raising it shows more of the backlog; lowering it keeps the list short.",
    configPath: "webUi.selfImproving.maxSuggestions",
    default: DEFAULTS.maxSuggestions,
    min: 1,
    max: 50,
    unit: "notes",
  });
}

export function resetGraphRegistration(): void {
  graphRegistered = false;
}
