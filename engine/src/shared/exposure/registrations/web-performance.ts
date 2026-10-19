/**
 * Shared exposure registrations — `webPerformance` module.
 *
 * The web app's speed contract: the thirteen ceilings the profiled app
 * must stay under, read live from `webUi.performance` in the harness
 * config. The regression gate (`tests/performance/regression.test.ts`,
 * through `getPerformanceBudgetConfig`) compares every measured metric of
 * a Playwright profile against these numbers and reds when one degrades
 * past its ceiling — so each ceiling is the gate's OWN verdict budget,
 * the read-only doctrine's sharpest case: a budget that decides a gate's
 * verdict is that gate's detection contract, and a settings-sheet write
 * that loosened one would silently weaken what the gate's green means
 * (the numbers change through the config file, with the measurement that
 * re-derived them recorded beside the change — the same path the
 * clsMax 0.1 → 0.12 calibration took).
 *
 * Signals only, no customizations: the room shows every ceiling and offers
 * no write for any of them. The census pins both directions — the signals
 * must exist, and their config paths must never appear as writable rows.
 */

import {
  registerExposureModule,
  registerSignal,
} from "../index.ts";
import { readConfigCustomization } from "../config-binding.ts";

const BUDGET_SIGNALS = [
  {
    id: "lcpMaxMs",
    leaf: "lcpMaxMs",
    name: "Largest paint allowed on load",
    unit: "ms",
    description:
      "The profiled app's main page must finish its largest paint within this many milliseconds of starting to load. Shown read-only: this ceiling is the performance gate's own verdict budget — the profile compares the measured load against it, and a settings write that loosened it would silently weaken what the gate's green means.",
  },
  {
    id: "clsMax",
    leaf: "clsMax",
    name: "Layout shift allowed on load",
    unit: "score",
    description:
      "How far the page's layout may visibly shift while it loads, on a scale where zero is no shift at all. Shown read-only: this ceiling is the performance gate's own verdict budget — the profile compares the measured shift against it, and a settings write that loosened it would silently weaken what the gate's green means.",
  },
  {
    id: "longTaskWorstMaxMs",
    leaf: "longTaskWorstMaxMs",
    name: "Worst single main-thread stall allowed",
    unit: "ms",
    description:
      "No single main-thread task may block the page longer than this many milliseconds during load. Shown read-only: this ceiling is the performance gate's own verdict budget — the profile compares the worst measured stall against it, and a settings write that loosened it would silently weaken what the gate's green means.",
  },
  {
    id: "longTaskTotalMaxMs",
    leaf: "longTaskTotalMaxMs",
    name: "Total main-thread stall time allowed on load",
    unit: "ms",
    description:
      "All main-thread stalls on one load, added together, must stay under this many milliseconds. Shown read-only: this ceiling is the performance gate's own verdict budget — the profile compares the measured total against it, and a settings write that loosened it would silently weaken what the gate's green means.",
  },
  {
    id: "tabSwitchMaxMs",
    leaf: "tabSwitchMaxMs",
    name: "Screen switch latency allowed",
    unit: "ms",
    description:
      "Opening any screen of the app must finish within this many milliseconds, and so must every discovered click. Shown read-only: this ceiling is the performance gate's own verdict budget — the profile compares each measured switch and click against it, and a settings write that loosened it would silently weaken what the gate's green means.",
  },
  {
    id: "tabDomNodesMax",
    leaf: "tabDomNodesMax",
    name: "DOM nodes one screen may hold",
    unit: "nodes",
    description:
      "No screen of the app may build more than this many DOM nodes. Shown read-only: this ceiling is the performance gate's own verdict budget — the profile counts each measured screen against it, and a settings write that loosened it would silently weaken what the gate's green means.",
  },
  {
    id: "typingMeanMaxMs",
    leaf: "typingMeanMaxMs",
    name: "Mean typing latency allowed per key",
    unit: "ms",
    description:
      "Averaged over the keystrokes the profile types, one key must settle within this many milliseconds — the settle includes the rendered frame the user waits for. Shown read-only: this ceiling is the performance gate's own verdict budget — the profile compares the measured mean against it, and a settings write that loosened it would silently weaken what the gate's green means.",
  },
  {
    id: "apiResponseMaxMs",
    leaf: "apiResponseMaxMs",
    name: "Slowest API response allowed",
    unit: "ms",
    description:
      "No API call the app makes, and no profiled server route, may take longer than this many milliseconds. Shown read-only: this ceiling is the performance gate's own verdict budget — the profile compares the slowest measured response against it, and a settings write that loosened it would silently weaken what the gate's green means.",
  },
  {
    id: "longSessionHeapGrowthMaxMb",
    leaf: "longSessionHeapGrowthMaxMb",
    name: "Memory a long session may gain",
    unit: "MB",
    description:
      "A long working session may grow the app's heap by at most this many megabytes. Shown read-only: this ceiling is the performance gate's own verdict budget — the profile compares the measured growth against it, and a settings write that loosened it would silently weaken what the gate's green means.",
  },
  {
    id: "longSessionDomGrowthMax",
    leaf: "longSessionDomGrowthMax",
    name: "DOM nodes a long session may add",
    unit: "nodes",
    description:
      "A long working session may add at most this many DOM nodes to the page. Shown read-only: this ceiling is the performance gate's own verdict budget — the profile compares the measured growth against it, and a settings write that loosened it would silently weaken what the gate's green means.",
  },
  {
    id: "longChatRenderMaxMs",
    leaf: "longChatRenderMaxMs",
    name: "Render time allowed for a 1000-message chat",
    unit: "ms",
    description:
      "A conversation of a thousand messages must render within this many milliseconds. Shown read-only: this ceiling is the performance gate's own verdict budget — the profile compares the measured render against it, and a settings write that loosened it would silently weaken what the gate's green means.",
  },
  {
    id: "manyProjectsRenderMaxMs",
    leaf: "manyProjectsRenderMaxMs",
    name: "Render time allowed for a many-projects list",
    unit: "ms",
    description:
      "A project list heavy with many projects must render within this many milliseconds. Shown read-only: this ceiling is the performance gate's own verdict budget — the profile compares the measured render against it, and a settings write that loosened it would silently weaken what the gate's green means.",
  },
  {
    id: "viewportLcpMaxMs",
    leaf: "viewportLcpMaxMs",
    name: "Largest paint allowed at a narrow viewport",
    unit: "ms",
    description:
      "The largest-paint ceiling's deliberately looser sibling for narrow viewports, where a smaller screen must not fail a budget tuned for the full one. Shown read-only: this ceiling is the performance gate's own verdict budget — the profile compares the measured narrow-viewport load against it, and a settings write that loosened it would silently weaken what the gate's green means.",
  },
] as const;

let webPerformanceRegistered = false;
export function registerWebPerformanceExposure(): void {
  if (webPerformanceRegistered) return;
  webPerformanceRegistered = true;

  registerExposureModule({
    id: "webPerformance",
    title: "How fast the web app must stay",
    purpose:
      "The speed ceilings the profiled web app is held to: how fast pages, screens, typing and long sessions must stay before the performance gate calls it a regression.",
  });

  for (const budget of BUDGET_SIGNALS) {
    registerSignal({
      id: `webPerformance.${budget.id}`,
      module: "webPerformance",
      name: budget.name,
      description: budget.description,
      type: "gauge",
      unit: budget.unit,
      // The config document's own value; an undeclared one reads NaN (the gate refuses it by name; no default in code).
      value: () => {
        const declared = readConfigCustomization(`webUi.performance.${budget.leaf}`);
        return typeof declared === "number" && Number.isFinite(declared) ? declared : Number.NaN;
      },
    });
  }
}

/** Reset the per-module registration flag (test-only). */
export function resetWebPerformanceRegistration(): void {
  webPerformanceRegistered = false;
}
