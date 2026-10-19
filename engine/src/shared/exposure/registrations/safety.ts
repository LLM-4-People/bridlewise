/**
 * Shared exposure registrations — `safety` module.
 *
 * Owns a small per-process state object that mirrors what the real
 * safety subsystem would expose: hallucination trapping, bias
 * detection, error swallowing detection, and grounding enforcement.
 */

import {
  registerAction,
  registerCustomization,
  registerExposureModule,
  registerSignal,
  configBoundSet,
  seedFromConfig,
  syncStateFromConfig,
  readBooleanCustomization,
  readNumberCustomization,
  readStringCustomization,
  writeConfigCustomization,
  readConfigCustomization,
} from "../index.ts";
import { ROOT_POLICY } from "../../../kernel/root-policy.ts";
import { resolveBandaidConfig } from "../../../safety/bandaid-config.ts";
import { resolveToolCallGateConfig } from "../../../safety/tool-call-gate.ts";

/**
 * The keep-out list IN FORCE on this host (the web server installs it at
 * boot: `keepOutInForce` over its own facts). Without a host, the signal
 * shows the floor as written and the operator's additions.
 */
/** One entry of the keep-out list as the signal serves it: the place, and where it comes from. */
export type KeepOutListing = Readonly<{ path: string; source: string }>;

let keepOutSource: (() => readonly KeepOutListing[]) | null = null;

/** Install the live reading of the keep-out list (the web server, at boot). */
export function installKeepOutSource(source: () => readonly KeepOutListing[]): void {
  keepOutSource = source;
}

/** A list-valued config path, or empty when unset. */
function readConfigList(configPath: string): readonly string[] {
  const value = readConfigCustomization(configPath) as unknown;
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Per-process safety state. */
export const safetyState = {
  hallucinationCount: 0,
  hallucinationCatchCount: 0,
  biasDetectionCount: 0,
  biasPreventionCount: 0,
  catchRate: 0,
  resetCount: 0,
  clearCount: 0,
  swallowDetectedCount: 0,
  groundingEnforcedCount: 0,
  whitelistHitCount: 0,
  // The enforcement knobs are a LIVE PROJECTION of the `safety` config
  // section: seeded from `bridlewise.config.json` and written back through
  // the config gate on every `set`.
  whitelistEnabled: seedFromConfig("safety.whitelistEnabled", true) as boolean,
  groundingEnabled: seedFromConfig("safety.groundingEnabled", true) as boolean,
  threshold: seedFromConfig("safety.threshold", 0.5) as number,
  failClosed: seedFromConfig("safety.failClosed", true) as boolean,
  groundingMode: seedFromConfig("safety.groundingMode", "strict") as "off" | "warn" | "strict" | "block",
  // The pause-ask wait bound — the module's OWN store for the knob, seeded
  // from the `safety.eventFeed` config section. The run executor reads the
  // config value at each run's setup (next-run effect), so this field is the
  // registration's live projection of that persisted value.
  pauseAskWaitTimeoutMs: seedFromConfig("safety.eventFeed.pauseAskWaitTimeoutMs", resolveBandaidConfig().pauseAskWaitTimeoutMs) as number,
};

/**
 * Decide whether a reported observation counts as caught/prevented when the
 * caller did not state it explicitly: a supplied suspicion `score` is judged
 * against `threshold`; with no score at all, `failClosed` decides (fail
 * closed = treat the uncertain input as caught).
 */
function resolveOutcome(explicit: unknown, score: unknown): boolean {
  if (explicit !== undefined) return Boolean(explicit);
  if (typeof score === "number") return score >= safetyState.threshold;
  return safetyState.failClosed;
}

/** State-field → config-path map for the enforcement knobs (single source for
 * the import-time seeds and the registration-time re-sync). */
const SAFETY_CONFIG_BINDINGS = {
  whitelistEnabled: "safety.whitelistEnabled",
  groundingEnabled: "safety.groundingEnabled",
  threshold: "safety.threshold",
  failClosed: "safety.failClosed",
  groundingMode: "safety.groundingMode",
  pauseAskWaitTimeoutMs: "safety.eventFeed.pauseAskWaitTimeoutMs",
} as const;

let safetyRegistered = false;

/**
 * THE OWNER'S WRITE PATH for the hallucination counters — the ONLY place
 * outside the self-test action (`reportHallucination`) that may move
 * `hallucinationCount` / `hallucinationCatchCount`.
 *
 * A pre-dispatch tool-call-gate block IS a detected-and-caught suspected
 * hallucination: the model called a tool that does not exist or repeated an
 * identical call past the loop threshold, and the gate stopped it before it
 * reached the user. The gate does not write these counters directly — it
 * calls this owner, so the signals' values and their only real source stay in
 * one module. Without it both read a permanent 0 while the gate blocked calls
 * (the wired-but-inert class).
 */
export function recordSafetyHallucinationGateBlock(): void {
  safetyState.hallucinationCount += 1;
  safetyState.hallucinationCatchCount += 1;
}

/**
 * The LIVE event-feed detector state for the current run, as reported by the
 * web run's safety-runtime owner. Installed once at server boot by the
 * owner (`server/safety-runtime-bridge.ts`); the signal closures below read
 * THROUGH it so the instruments show real detector verdicts instead of the
 * per-process stub counters. Nothing here fabricates a verdict: with no
 * source installed (engine tests, a server that has not booted its run
 * runtime) the honest answer is "inactive, zero findings" — absence, never
 * an invented number.
 */
export type SafetyEventFeedState = Readonly<{
  /** Whether any run currently has an armed event-feed runtime. */
  active: boolean;
  workaroundFindings: number;
  bandaidFindings: number;
  stepSkipFindings: number;
  deviationFindings: number;
}>;

export type SafetyEventFeedStateSource = () => SafetyEventFeedState;

let eventFeedStateSource: SafetyEventFeedStateSource | null = null;

/** Install the live state source (the web safety-runtime owner installs this
 * once at boot). Replaces any previous source — the owner is singular. */
export function installSafetyEventFeedStateSource(source: SafetyEventFeedStateSource): void {
  eventFeedStateSource = source;
}

/** Remove the live state source (test/reset hook). */
export function clearSafetyEventFeedStateSource(): void {
  eventFeedStateSource = null;
}

function eventFeedState(): SafetyEventFeedState {
  return eventFeedStateSource?.() ?? {
    active: false,
    workaroundFindings: 0,
    bandaidFindings: 0,
    stepSkipFindings: 0,
    deviationFindings: 0,
  };
}

export function registerSafetyExposure(): void {
  if (safetyRegistered) return;
  safetyRegistered = true;
  // Re-seed the knob projection from the config file now that the config store
  // is installed (`registerAllExposure` installs it before this runs).
  syncStateFromConfig(safetyState, SAFETY_CONFIG_BINDINGS);

  // The CATEGORY this module's settings live under, in the product's own
  // words — declared here, beside the entries it names, so every surface
  // derives the same grouping instead of authoring a namespace→name table.
  registerExposureModule({
    id: "safety",
    title: "Answers that must be backed up",
    purpose:
      "How much evidence an answer needs before it is allowed through, and what happens when the system is not sure enough to answer at all.",
  });

  // --- Signals (10) ---
  registerSignal({
    id: "safety.hallucinationCount",
    module: "safety",
    name: "Hallucination Count",
    description: "Total number of suspected hallucinations detected.",
    type: "counter",
    unit: "count",
    value: () => safetyState.hallucinationCount,
  });
  registerSignal({
    id: "safety.catchRate",
    module: "safety",
    name: "Catch Rate",
    description: "Fraction of suspected hallucinations that were caught (0..1).",
    type: "gauge",
    unit: "ratio",
    value: () =>
      safetyState.hallucinationCount === 0
        ? 0
        : safetyState.hallucinationCatchCount / safetyState.hallucinationCount,
  });
  registerSignal({
    id: "safety.biasDetectionCount",
    module: "safety",
    name: "Bias Detection Count",
    description: "Total number of bias issues detected.",
    type: "counter",
    unit: "count",
    value: () => safetyState.biasDetectionCount,
  });
  registerSignal({
    id: "safety.biasPreventionCount",
    module: "safety",
    name: "Bias Prevention Count",
    description: "Total number of bias issues prevented from propagating.",
    type: "counter",
    unit: "count",
    value: () => safetyState.biasPreventionCount,
  });
  registerSignal({
    id: "safety.swallowDetectedCount",
    module: "safety",
    name: "Swallow Detected Count",
    description: "Number of swallowed-catch blocks detected by prevention.",
    type: "counter",
    unit: "count",
    // A swallowed catch is a defect by definition — the prevention layer
    // exists to keep this at zero, so any count above it is abnormal.
    abnormal: { warnAbove: 0 },
    value: () => safetyState.swallowDetectedCount,
  });
  registerSignal({
    id: "safety.groundingEnforcedCount",
    module: "safety",
    name: "Grounding Enforced Count",
    description: "Number of times grounding was enforced on an unverified claim.",
    type: "counter",
    unit: "count",
    value: () => safetyState.groundingEnforcedCount,
  });
  registerSignal({
    id: "safety.whitelistHitCount",
    module: "safety",
    name: "Whitelist Hit Count",
    description: "Number of items that passed through the safety whitelist.",
    type: "counter",
    unit: "count",
    value: () => safetyState.whitelistHitCount,
  });
  registerSignal({
    id: "safety.resetCount",
    module: "safety",
    name: "Reset Count",
    description: "Number of times the safety subsystem has been reset.",
    type: "counter",
    unit: "count",
    value: () => safetyState.resetCount,
  });
  registerSignal({
    id: "safety.whitelistEnabled",
    module: "safety",
    name: "Whitelist Enabled",
    description: "Whether the safety whitelist is currently enabled.",
    type: "boolean",
    value: () => safetyState.whitelistEnabled,
  });
  registerSignal({
    id: "safety.groundingEnabled",
    module: "safety",
    name: "Grounding Enabled",
    description: "Whether grounding enforcement is currently enabled.",
    type: "boolean",
    value: () => safetyState.groundingEnabled,
  });

  // --- Signals: live event-feed detectors (the web run's real verdicts) ---
  // These read the installed live state source — the safety-runtime owner
  // aggregates its per-run detectors into it. With no run active the honest
  // reading is inactive/zero; the values are never synthesized.
  registerSignal({
    id: "safety.eventFeedActive",
    module: "safety",
    name: "Event-feed detectors active",
    description: "Whether a running task has its workaround, bandaid-fix, skipped-step and off-task detectors armed.",
    type: "boolean",
    value: () => eventFeedState().active,
  });
  registerSignal({
    id: "safety.workaroundFindings",
    module: "safety",
    name: "Workaround findings",
    description: "Detected silent tool switches or hand-rolled reimplementations after a tool failed, across active runs.",
    type: "counter",
    unit: "count",
    value: () => eventFeedState().workaroundFindings,
  });
  registerSignal({
    id: "safety.bandaidFindings",
    module: "safety",
    name: "Bandaid fix findings",
    description: "Detected fixes that leave the root cause unaddressed, across active runs.",
    type: "counter",
    unit: "count",
    value: () => eventFeedState().bandaidFindings,
  });
  registerSignal({
    id: "safety.stepSkipFindings",
    module: "safety",
    name: "Skipped step findings",
    description: "Detected edits to files never read, and completed tasks missing expected steps, across active runs.",
    type: "counter",
    unit: "count",
    value: () => eventFeedState().stepSkipFindings,
  });
  registerSignal({
    id: "safety.keepOut",
    module: "safety",
    name: "Places no confined process and no project may reach",
    description:
      "No command the model runs and no local tool server is ever granted a folder or file that equals, contains or sits inside one of these, and no project folder or project file may either (compared by identity, so another name for the same folder counts). The list is the harness's own code, the credential, key, browser and shell-history stores of every home on this computer (Windows profiles included), the key home and every harness database registered there, the server's own files, and selfProtection.additionalProtectedSubtrees from the config file. The built-in part cannot be shortened.",
    type: "string",
    value: () => (keepOutSource?.().map((entry) => entry.path) ?? [
      ...ROOT_POLICY.selfProtection.minimumProtectedSubtrees,
      ...ROOT_POLICY.selfProtection.minimumRefusedPaths,
      ...readConfigList("selfProtection.additionalProtectedSubtrees"),
    ]).join(", "),
    // The list names this host's layout — other installs' databases and keys,
    // the key home, the Windows account names (secd-security SECD-C5): an
    // admin reads it; anyone else reads how many entries each source holds.
    visibility: {
      viewer: "admin",
      publicValue: () => {
        const counts = new Map<string, number>();
        for (const entry of keepOutSource?.() ?? []) counts.set(entry.source, (counts.get(entry.source) ?? 0) + 1);
        return [...counts].map(([source, count]) => `${source}: ${count}`).join(", ");
      },
    },
  });
  registerSignal({
    id: "safety.deviationFindings",
    module: "safety",
    name: "Off-task work findings",
    description: "Detected turns whose work no longer matches the original task, across active runs.",
    type: "counter",
    unit: "count",
    value: () => eventFeedState().deviationFindings,
  });

  // --- Signals: the section's posture and detection budgets (read-only) ---
  // The safety section's remaining leaves govern GATES — the pre-dispatch
  // tool-call gate and the event-feed detectors. The rounds-39/40 doctrine
  // applies per leaf: a check's armed state and a verdict's threshold are
  // shown read-only (the instruments room renders the fact; the settings
  // room never offers the write), and the posture floors refuse the
  // weakening values at the write gate, the boot pin, and the per-run
  // resolution. Defaults resolve from the engine owners — never restated.
  registerSignal({
    id: "safety.gateGhostToolDetection",
    module: "safety",
    name: "Ghost-tool check armed",
    description:
      "Whether the pre-dispatch gate refuses calls to tools that are not registered before any tool runs. Shown read-only: turning a hallucination check off is refused at every sanctioned door — the file is the machine administrator's, and even it must keep the check on.",
    type: "boolean",
    value: () =>
      readBooleanCustomization(
        "safety.toolCallGate.enableGhostToolDetection",
        resolveToolCallGateConfig().enableGhostToolDetection,
      ),
  });
  registerSignal({
    id: "safety.gateSchemaValidation",
    module: "safety",
    name: "Argument check armed",
    description:
      "Whether the pre-dispatch gate refuses tool calls whose arguments fail the tool's own schema. Shown read-only: the check is part of the product's safety layer, and a settings cookie may not disarm it.",
    type: "boolean",
    value: () =>
      readBooleanCustomization(
        "safety.toolCallGate.enableSchemaValidation",
        resolveToolCallGateConfig().enableSchemaValidation,
      ),
  });
  registerSignal({
    id: "safety.gateLoopDetection",
    module: "safety",
    name: "Loop check armed",
    description:
      "Whether the pre-dispatch gate refuses identical repeated tool calls past the loop threshold. Shown read-only: the check is part of the product's safety layer, and a settings cookie may not disarm it.",
    type: "boolean",
    value: () =>
      readBooleanCustomization(
        "safety.toolCallGate.enableLoopDetection",
        resolveToolCallGateConfig().enableLoopDetection,
      ),
  });
  registerSignal({
    id: "safety.familyBandaidArmed",
    module: "safety",
    name: "Bandaid-fix detector armed",
    description:
      "Whether the run's bandaid detector — fixes that leave the root cause unaddressed — is armed. Shown read-only: disarming a detector is refused at every sanctioned door.",
    type: "boolean",
    value: () =>
      readBooleanCustomization(
        "safety.eventFeed.families.bandaid.enabled",
        resolveBandaidConfig().families.bandaid.enabled,
      ),
  });
  registerSignal({
    id: "safety.familyWorkaroundArmed",
    module: "safety",
    name: "Workaround detector armed",
    description:
      "Whether the run's workaround detector — silent tool switches and hand-rolled reimplementations after a tool failed — is armed. Shown read-only: disarming a detector is refused at every sanctioned door.",
    type: "boolean",
    value: () =>
      readBooleanCustomization(
        "safety.eventFeed.families.workaround.enabled",
        resolveBandaidConfig().families.workaround.enabled,
      ),
  });
  registerSignal({
    id: "safety.familyDeviationArmed",
    module: "safety",
    name: "Off-task detector armed",
    description:
      "Whether the run's off-task detector — work that no longer matches the original task — is armed. Shown read-only: disarming a detector is refused at every sanctioned door.",
    type: "boolean",
    value: () =>
      readBooleanCustomization(
        "safety.eventFeed.families.deviation.enabled",
        resolveBandaidConfig().families.deviation.enabled,
      ),
  });
  registerSignal({
    id: "safety.familyStepSkipArmed",
    module: "safety",
    name: "Skipped-step detector armed",
    description:
      "Whether the run's skipped-step detector — edits to files never read, completed tasks missing expected steps — is armed. Shown read-only: disarming a detector is refused at every sanctioned door.",
    type: "boolean",
    value: () =>
      readBooleanCustomization(
        "safety.eventFeed.families.stepSkip.enabled",
        resolveBandaidConfig().families.stepSkip.enabled,
      ),
  });
  registerSignal({
    id: "safety.longCommentCheckArmed",
    module: "safety",
    name: "Long-comment check armed",
    description:
      "Whether the bandaid detector's long-comment check is armed — a comment much longer than the code it precedes is a deferred-fix smell. Shown read-only: it is one of the bandaid detector's finding paths, and turning it off is refused at every sanctioned door.",
    type: "boolean",
    value: () =>
      readBooleanCustomization(
        "safety.eventFeed.longCommentDeferredEnabled",
        resolveBandaidConfig().longCommentDeferredEnabled,
      ),
  });
  registerSignal({
    id: "safety.workaroundToolsMode",
    module: "safety",
    name: "Which tools count as consequential",
    description:
      "How the workaround detector decides which tools matter enough that switching away from a failed one counts as a workaround: 'all' counts every tool, 'list' counts only the named ones. Shown read-only: narrowing to 'list' without naming a tool is refused, because it would leave the detector unable to fire.",
    type: "string",
    value: () =>
      readStringCustomization(
        "safety.eventFeed.workaroundConsequentialToolsMode",
        resolveBandaidConfig().workaroundConsequentialToolsMode,
      ),
  });
  registerSignal({
    id: "safety.gateMaxRepeatCount",
    module: "safety",
    name: "Identical calls that mean a loop",
    description:
      "How many identical tool calls within the loop window the gate accepts before the next identical call is refused as a loop. Shown read-only: this threshold decides what the loop verdict means, and loosening it from a settings cookie would quietly weaken the gate.",
    type: "gauge",
    unit: "count",
    value: () =>
      readNumberCustomization(
        "safety.toolCallGate.maxRepeatCount",
        resolveToolCallGateConfig().maxRepeatCount,
      ),
  });
  registerSignal({
    id: "safety.gateLoopWindow",
    module: "safety",
    name: "How many recent calls the loop check remembers",
    description:
      "The sliding window of recent accepted calls the loop detector inspects. Larger windows catch slower loops; smaller ones forget faster. Shown read-only: the window is part of what the loop verdict means.",
    type: "gauge",
    unit: "count",
    value: () =>
      readNumberCustomization(
        "safety.toolCallGate.loopWindow",
        resolveToolCallGateConfig().loopWindow,
      ),
  });
  registerSignal({
    id: "safety.gateBlockAutoTripAfter",
    module: "safety",
    name: "Refused repeats before a tool is switched off",
    description:
      "After this many identical refused calls in a row, the tool is switched off for the rest of the run so it cannot keep burning tokens. Shown read-only: the count decides when the trip fires, and raising it from a settings cookie would let a stuck loop run longer.",
    type: "gauge",
    unit: "count",
    value: () =>
      readNumberCustomization(
        "safety.toolCallGate.blockAutoTripAfter",
        resolveToolCallGateConfig().blockAutoTripAfter,
      ),
  });
  registerSignal({
    id: "safety.bandaidMinEvents",
    module: "safety",
    name: "Events before the bandaid check runs",
    description:
      "The run must record at least this many events before the bandaid detector evaluates them. Shown read-only: the floor is part of what the bandaid verdict means.",
    type: "gauge",
    unit: "count",
    value: () =>
      readNumberCustomization(
        "safety.eventFeed.families.bandaid.minEvents",
        resolveBandaidConfig().families.bandaid.minEvents,
      ),
  });
  registerSignal({
    id: "safety.workaroundMinEvents",
    module: "safety",
    name: "Events before the workaround check runs",
    description:
      "The run must record at least this many events before the workaround detector evaluates them. Shown read-only: the floor is part of what the workaround verdict means.",
    type: "gauge",
    unit: "count",
    value: () =>
      readNumberCustomization(
        "safety.eventFeed.families.workaround.minEvents",
        resolveBandaidConfig().families.workaround.minEvents,
      ),
  });
  registerSignal({
    id: "safety.deviationMinEvents",
    module: "safety",
    name: "Events before the off-task check runs",
    description:
      "The run must record at least this many events before the off-task detector evaluates them. Shown read-only: the floor is part of what the off-task verdict means.",
    type: "gauge",
    unit: "count",
    value: () =>
      readNumberCustomization(
        "safety.eventFeed.families.deviation.minEvents",
        resolveBandaidConfig().families.deviation.minEvents,
      ),
  });
  registerSignal({
    id: "safety.stepSkipMinEvents",
    module: "safety",
    name: "Events before the skipped-step check runs",
    description:
      "The run must record at least this many events before the skipped-step detector evaluates them. Shown read-only: the floor is part of what the skipped-step verdict means.",
    type: "gauge",
    unit: "count",
    value: () =>
      readNumberCustomization(
        "safety.eventFeed.families.stepSkip.minEvents",
        resolveBandaidConfig().families.stepSkip.minEvents,
      ),
  });
  registerSignal({
    id: "safety.longCommentMinRatio",
    module: "safety",
    name: "Comment size that flags a deferred fix",
    description:
      "A comment at least this many times longer than the code it precedes is flagged as a deferred-fix smell. Shown read-only: the ratio decides what the long-comment check means.",
    type: "gauge",
    unit: "times",
    value: () =>
      readNumberCustomization(
        "safety.eventFeed.longCommentMinRatio",
        resolveBandaidConfig().longCommentMinRatio,
      ),
  });
  registerSignal({
    id: "safety.longCommentMinCommentLength",
    module: "safety",
    name: "Shortest comment the long-comment check judges",
    description:
      "Comments shorter than this are never flagged, no matter the ratio. Shown read-only: the bound is part of what the long-comment check means.",
    type: "gauge",
    unit: "characters",
    value: () =>
      readNumberCustomization(
        "safety.eventFeed.longCommentMinCommentLength",
        resolveBandaidConfig().longCommentMinCommentLength,
      ),
  });
  registerSignal({
    id: "safety.bandaidMinRootCauseOverlap",
    module: "safety",
    name: "Root-cause overlap a real fix must show",
    description:
      "When the root cause of a failure is known, an edit must reflect at least this fraction of the root-cause fix to clear bandaid suspicion — the primary keyword-free bandaid signal. Shown read-only: the overlap floor decides what the bandaid verdict means.",
    type: "gauge",
    unit: "fraction",
    value: () =>
      readNumberCustomization(
        "safety.eventFeed.bandaidMinRootCauseOverlap",
        resolveBandaidConfig().bandaidMinRootCauseOverlap,
      ),
  });
  registerSignal({
    id: "safety.bandaidMinEditLines",
    module: "safety",
    name: "Smallest edit the bandaid check scans",
    description:
      "Edits smaller than this many lines are not worth scanning for bandaid patterns. Shown read-only: the scan floor decides which edits the bandaid verdict can even see.",
    type: "gauge",
    unit: "count",
    value: () =>
      readNumberCustomization(
        "safety.eventFeed.bandaidMinEditLines",
        resolveBandaidConfig().bandaidMinEditLines,
      ),
  });
  registerSignal({
    id: "safety.workaroundSwitchWindow",
    module: "safety",
    name: "Turns within which a tool switch counts",
    description:
      "A different tool succeeding within this many turns of a failed one counts as a workaround. Shown read-only: the window decides what the workaround verdict means.",
    type: "gauge",
    unit: "turns",
    value: () =>
      readNumberCustomization(
        "safety.eventFeed.workaroundSwitchWindow",
        resolveBandaidConfig().workaroundSwitchWindow,
      ),
  });
  registerSignal({
    id: "safety.deviationMinTaskSimilarity",
    module: "safety",
    name: "Task similarity below which work counts as off-task",
    description:
      "Work whose similarity to the original task falls below this fraction is judged off-task. Shown read-only: the similarity floor decides what the off-task verdict means.",
    type: "gauge",
    unit: "fraction",
    value: () =>
      readNumberCustomization(
        "safety.eventFeed.deviationMinTaskSimilarity",
        resolveBandaidConfig().deviationMinTaskSimilarity,
      ),
  });
  registerSignal({
    id: "safety.deviationMinTurnsBeforeDeviation",
    module: "safety",
    name: "Turns before off-task work is judged",
    description:
      "The first turns of a run are warm-up: off-task comparisons start only after this many turns. Shown read-only: the warm-up is part of what the off-task verdict means.",
    type: "gauge",
    unit: "turns",
    value: () =>
      readNumberCustomization(
        "safety.eventFeed.deviationMinTurnsBeforeDeviation",
        resolveBandaidConfig().deviationMinTurnsBeforeDeviation,
      ),
  });
  registerSignal({
    id: "safety.deviationWindowSize",
    module: "safety",
    name: "Turns the off-task check compares",
    description:
      "The rolling window of turns the off-task detector compares against the original task. Shown read-only: the window decides what the off-task verdict means.",
    type: "gauge",
    unit: "turns",
    value: () =>
      readNumberCustomization(
        "safety.eventFeed.deviationWindowSize",
        resolveBandaidConfig().deviationWindowSize,
      ),
  });
  registerSignal({
    id: "safety.deviationPersistentThreshold",
    module: "safety",
    name: "Off-task turns before the run is called out",
    description:
      "This many off-task turns in a row escalate the finding as persistent. Shown read-only: the threshold decides when the off-task verdict escalates.",
    type: "gauge",
    unit: "turns",
    value: () =>
      readNumberCustomization(
        "safety.eventFeed.deviationPersistentThreshold",
        resolveBandaidConfig().deviationPersistentThreshold,
      ),
  });
  registerSignal({
    id: "safety.stepSkipEditBeforeReadWindow",
    module: "safety",
    name: "Turns within which edit-before-read counts",
    description:
      "Editing a file within this many turns before any read of it counts as a skipped step. Shown read-only: the window decides what the skipped-step verdict means.",
    type: "gauge",
    unit: "turns",
    value: () =>
      readNumberCustomization(
        "safety.eventFeed.stepSkipEditBeforeReadWindow",
        resolveBandaidConfig().stepSkipEditBeforeReadWindow,
      ),
  });
  registerSignal({
    id: "safety.investigationRootCauseOverlapFloor",
    module: "safety",
    name: "Overlap a fix needs to count as legitimate",
    description:
      "When a finding is investigated, a fix reflecting at least this fraction of the known root cause is classified as legitimate rather than a bandaid. Shown read-only: the floor decides what the investigation's verdict means.",
    type: "gauge",
    unit: "fraction",
    value: () =>
      readNumberCustomization(
        "safety.eventFeed.investigationRootCauseOverlapFloor",
        resolveBandaidConfig().investigationRootCauseOverlapFloor,
      ),
  });

  // --- Actions (5) ---
  registerAction({
    id: "safety.reset",
    module: "safety",
    name: "Reset",
    description: "Reset the safety subsystem to its default configuration.",
    execute: async () => {
      safetyState.resetCount += 1;
      safetyState.whitelistEnabled = true;
      safetyState.groundingEnabled = true;
      safetyState.threshold = 0.5;
      safetyState.failClosed = true;
      safetyState.groundingMode = "strict";
      // The pause-ask wait bound resets with the rest of the safety knobs;
      // leaving it would be the one control a reset silently skips.
      safetyState.pauseAskWaitTimeoutMs = resolveBandaidConfig().pauseAskWaitTimeoutMs;
      return { reset: true, resetCount: safetyState.resetCount };
    },
  });
  registerAction({
    id: "safety.clear",
    module: "safety",
    name: "Clear",
    description: "Clear all safety counters.",
    execute: async () => {
      safetyState.hallucinationCount = 0;
      safetyState.hallucinationCatchCount = 0;
      safetyState.biasDetectionCount = 0;
      safetyState.biasPreventionCount = 0;
      safetyState.swallowDetectedCount = 0;
      safetyState.groundingEnforcedCount = 0;
      safetyState.whitelistHitCount = 0;
      safetyState.clearCount += 1;
      return { cleared: true, clearCount: safetyState.clearCount };
    },
  });
  registerAction({
    id: "safety.reportHallucination",
    module: "safety",
    name: "Report Hallucination",
    description: "Record a synthetic hallucination observation (for testing).",
    args: {
      caught: { type: "boolean", required: false, description: "Whether it was caught (overrides score/failClosed)" },
      score: { type: "number", required: false, description: "Suspicion score (0..1), judged against `safety.threshold`" },
      whitelisted: { type: "boolean", required: false, description: "Whether the item is on the safety whitelist" },
    },
    execute: async (args) => {
      // Whitelisted items pass through untouched while the whitelist is on.
      if (safetyState.whitelistEnabled && args?.whitelisted === true) {
        safetyState.whitelistHitCount += 1;
        return { whitelisted: true, whitelistHitCount: safetyState.whitelistHitCount };
      }
      safetyState.hallucinationCount += 1;
      const caught = resolveOutcome(args?.caught, args?.score);
      if (caught) safetyState.hallucinationCatchCount += 1;
      return {
        hallucinationCount: safetyState.hallucinationCount,
        caught,
      };
    },
  });
  registerAction({
    id: "safety.reportBias",
    module: "safety",
    name: "Report Bias",
    description: "Record a synthetic bias observation (for testing).",
    args: {
      prevented: { type: "boolean", required: false, description: "Whether it was prevented (overrides score/failClosed)" },
      score: { type: "number", required: false, description: "Bias score (0..1), judged against `safety.threshold`" },
      whitelisted: { type: "boolean", required: false, description: "Whether the item is on the safety whitelist" },
    },
    execute: async (args) => {
      if (safetyState.whitelistEnabled && args?.whitelisted === true) {
        safetyState.whitelistHitCount += 1;
        return { whitelisted: true, whitelistHitCount: safetyState.whitelistHitCount };
      }
      safetyState.biasDetectionCount += 1;
      const prevented = resolveOutcome(args?.prevented, args?.score);
      if (prevented) safetyState.biasPreventionCount += 1;
      return {
        biasDetectionCount: safetyState.biasDetectionCount,
        prevented,
      };
    },
  });
  registerAction({
    id: "safety.enforceGrounding",
    module: "safety",
    name: "Enforce Grounding",
    description: "Record one grounding enforcement action.",
    args: {
      grounded: { type: "boolean", required: false, description: "Whether the claim was verified as grounded (default false)" },
    },
    execute: async (args) => {
      // Enforcement is gated by BOTH the coarse enable flag and the mode.
      if (!safetyState.groundingEnabled || safetyState.groundingMode === "off") {
        return { enforced: false, mode: safetyState.groundingMode, groundingEnabled: safetyState.groundingEnabled };
      }
      safetyState.groundingEnforcedCount += 1;
      const grounded = args?.grounded === true;
      // warn: never blocks; strict: blocks unverified claims; block: blocks all.
      const blocked =
        safetyState.groundingMode === "block" ||
        (safetyState.groundingMode === "strict" && !grounded);
      return {
        enforced: true,
        mode: safetyState.groundingMode,
        grounded,
        blocked,
        count: safetyState.groundingEnforcedCount,
      };
    },
  });

  // --- Customizations (5) ---
  // All five are read live by the module's report/enforce actions (verified
  // by the customization-liveness suite), so changes are immediate.
  registerCustomization({
    id: "safety.whitelistEnabled",
    module: "safety",
    name: "Allow-list filtering",
    description:
      "On: items on the pre-approved allow-list pass the safety layer untouched. Off: the allow-list is not consulted and everything is checked.",
    type: "boolean",
    default: true,
    current: () => safetyState.whitelistEnabled,
    set: configBoundSet("safety.whitelistEnabled", (v) => { safetyState.whitelistEnabled = Boolean(v); }),
    contract: { effect: "immediate" },
    measuredBy: "safety.whitelistEnabled",
    configPath: "safety.whitelistEnabled",
  });
  registerCustomization({
    id: "safety.groundingEnabled",
    module: "safety",
    name: "Require evidence for claims",
    description:
      "On: claims must be backed by evidence, per the evidence enforcement level. Off: grounding is not enforced at all.",
    type: "boolean",
    default: true,
    current: () => safetyState.groundingEnabled,
    set: configBoundSet("safety.groundingEnabled", (v) => { safetyState.groundingEnabled = Boolean(v); }),
    contract: { effect: "immediate" },
    measuredBy: "safety.groundingEnabled",
    configPath: "safety.groundingEnabled",
  });
  registerCustomization({
    id: "safety.threshold",
    module: "safety",
    name: "Safety check cutoff score",
    description:
      "The score safety checks compare against when deciding whether to act on something they found. Lower = more findings acted on.",
    type: "number",
    default: 0.5,
    min: 0,
    max: 1,
    unit: "score",
    current: () => safetyState.threshold,
    set: configBoundSet("safety.threshold", (v) => { safetyState.threshold = Number(v); }),
    contract: { effect: "immediate" },
    configPath: "safety.threshold",
  });
  // `safety.maxRetries` and `safety.redactSecrets` were REMOVED (not wired
  // to a dead store): this stub has no retry loop and emits no logs or
  // errors, so neither value could ever influence behaviour. Re-add them
  // when the real safety subsystem (which retries and logs) backs this
  // registration.
  registerCustomization({
    id: "safety.failClosed",
    module: "safety",
    name: "Block when unsure",
    description:
      "On: if a safety check cannot reach a clear answer, the item is treated as caught. Off: it is allowed through.",
    type: "boolean",
    default: true,
    current: () => safetyState.failClosed,
    set: configBoundSet("safety.failClosed", (v) => { safetyState.failClosed = Boolean(v); }),
    contract: { effect: "immediate" },
    configPath: "safety.failClosed",
  });
  // `safety.biasTypes` was REMOVED: the surveillance list is owned by the
  // bias module, whose `bias.biasTypes` customization is live (it reads and
  // writes `biasState.biasTypes`, which gates `bias.reportDetection`).
  // Registering a second knob here with its own dead store would create two
  // sources of truth for the same list.
  registerCustomization({
    id: "safety.groundingMode",
    module: "safety",
    name: "Evidence enforcement level",
    description:
      "How strictly claims must be evidence-backed: 'off' (not checked), 'warn' (noted only), 'strict' (unverified claims are stopped), or 'block' (every claim is stopped).",
    type: "enum",
    default: "strict",
    enum: ["off", "warn", "strict", "block"],
    current: () => safetyState.groundingMode,
    set: configBoundSet("safety.groundingMode", (v) => { safetyState.groundingMode = String(v) as typeof safetyState.groundingMode; }),
    contract: { effect: "immediate" },
    configPath: "safety.groundingMode",
  });
  // The event-feed safety family's pause-ask tunable. Not a separate module:
  // it binds the `safety.eventFeed` config section the event-feed detectors
  // already read, and the engine resolver owns its default (the registration
  // never restates the number — it resolves the section live).
  registerCustomization({
    id: "safety.pauseAskWaitTimeoutMs",
    module: "safety",
    name: "How long a safety question waits for your answer",
    description:
      "When the assistant pauses to ask you something (for example because a tool it needs is not set up), the run waits this many milliseconds for your answer before it stops. Set to 0 to wait forever. Takes effect for the next run.",
    type: "number",
    default: resolveBandaidConfig().pauseAskWaitTimeoutMs,
    min: 0,
    max: 3_600_000,
    unit: "milliseconds",
    current: () => safetyState.pauseAskWaitTimeoutMs,
    set: configBoundSet("safety.eventFeed.pauseAskWaitTimeoutMs", (v) => { safetyState.pauseAskWaitTimeoutMs = Number(v); }),
    contract: { effect: "next-run" },
    configPath: "safety.eventFeed.pauseAskWaitTimeoutMs",
  });

  // --- Customizations: the administrative leaves (the run-bound class) ---
  // The gate's recovery memory and message escalation, and the pause-ask
  // interaction's own bounds — knobs that shape HOW a refusal or a pause
  // behaves, not WHETHER a check happens (the check leaves are read-only
  // signals above, refused at the doors when weakened). Every consumer is
  // the per-run gate or safety-runtime creation, so the honest timing is
  // next-run: a write lands in the file and the NEXT run resolves it.
  registerCustomization({
    id: "safety.gatePartialArgumentMemory",
    module: "safety",
    name: "Remember a refused call's valid fields",
    description:
      "On: when the gate refuses a tool call for its arguments, the individually valid fields are kept and the model is asked for just the missing or wrong part, which is merged onto what was kept on the next try for that tool. Off: every refused call starts over from nothing. The call is refused either way — this only shapes the recovery. Takes effect for the next run.",
    type: "boolean",
    default: resolveToolCallGateConfig().enablePartialArgumentMemory,
    current: () => readBooleanCustomization(
      "safety.toolCallGate.enablePartialArgumentMemory",
      resolveToolCallGateConfig().enablePartialArgumentMemory,
    ),
    set: (v) => writeConfigCustomization("safety.toolCallGate.enablePartialArgumentMemory", v),
    contract: { effect: "next-run" },
    configPath: "safety.toolCallGate.enablePartialArgumentMemory",
  });
  registerCustomization({
    id: "safety.gatePartialArgumentsLimit",
    module: "safety",
    name: "How many tools keep their partial arguments",
    description:
      "At most this many tools hold the valid fields of their last refused call at once — a memory bound, not a detection threshold. One partial per tool; a new refused attempt replaces the old one. Takes effect for the next run.",
    type: "number",
    default: resolveToolCallGateConfig().partialArgumentsLimit,
    min: 1,
    unit: "count",
    current: () => readNumberCustomization(
      "safety.toolCallGate.partialArgumentsLimit",
      resolveToolCallGateConfig().partialArgumentsLimit,
    ),
    set: (v) => writeConfigCustomization("safety.toolCallGate.partialArgumentsLimit", v),
    contract: { effect: "next-run" },
    configPath: "safety.toolCallGate.partialArgumentsLimit",
  });
  registerCustomization({
    id: "safety.gateBlockEscalationAfter",
    module: "safety",
    name: "When a refused call's message names the pattern",
    description:
      "After this many identical refused calls in a row, the refusal message says so honestly — which call this is, and that repeating the same arguments cannot succeed. The call is refused either way; raising this only delays that honesty. It may not be raised past the count that switches the tool off for the rest of the run (\"Refused repeats before a tool is switched off\"): the switch-off cannot happen before the message escalates, so a value past it would silently delay the switch-off — and the write is refused. Takes effect for the next run.",
    type: "number",
    default: resolveToolCallGateConfig().blockEscalationAfter,
    min: 1,
    unit: "count",
    current: () => readNumberCustomization(
      "safety.toolCallGate.blockEscalationAfter",
      resolveToolCallGateConfig().blockEscalationAfter,
    ),
    set: (v) => writeConfigCustomization("safety.toolCallGate.blockEscalationAfter", v),
    contract: { effect: "next-run" },
    configPath: "safety.toolCallGate.blockEscalationAfter",
  });
  registerCustomization({
    id: "safety.pauseAskEnabled",
    module: "safety",
    name: "Pause the run to ask you for help",
    description:
      "On: when the safety checks conclude a finding needs something only you can do (install a missing tool, confirm the task is possible), the run pauses and asks. Off: the finding is still recorded and the run continues without asking — the mode for unattended runs. Takes effect for the next run.",
    type: "boolean",
    default: resolveBandaidConfig().pauseAskEnabled,
    current: () => readBooleanCustomization(
      "safety.eventFeed.pauseAskEnabled",
      resolveBandaidConfig().pauseAskEnabled,
    ),
    set: (v) => writeConfigCustomization("safety.eventFeed.pauseAskEnabled", v),
    contract: { effect: "next-run" },
    configPath: "safety.eventFeed.pauseAskEnabled",
  });
  registerCustomization({
    id: "safety.pauseAskMaxMessageLength",
    module: "safety",
    name: "Longest pause question the run may show",
    description:
      "The pause question is trimmed to at most this many characters so one long finding cannot fill the chat with a single message. Takes effect for the next run.",
    type: "number",
    default: resolveBandaidConfig().pauseAskMaxMessageLength,
    min: 1,
    unit: "characters",
    current: () => readNumberCustomization(
      "safety.eventFeed.pauseAskMaxMessageLength",
      resolveBandaidConfig().pauseAskMaxMessageLength,
    ),
    set: (v) => writeConfigCustomization("safety.eventFeed.pauseAskMaxMessageLength", v),
    contract: { effect: "next-run" },
    configPath: "safety.eventFeed.pauseAskMaxMessageLength",
  });
}

/** Reset the per-module registration flag (test-only). */
export function resetSafetyRegistration(): void {
  safetyRegistered = false;
}
