/**
 * Safety config section — the safety domain's own declared section (the
 * module-exports-its-section idiom the performance, privacy and debug
 * sections established), moved here from the exposure-module sections file
 * because the section outgrew it: it carries the pre-dispatch tool-call
 * gate and the event-feed detector families, and those gates' shape and
 * their posture floors belong beside the detectors they arm.
 *
 * WHAT THIS MODULE OWNS
 *
 * 1. The section schema (`SAFETY_CONFIG_SCHEMA`) — the write-gate shape of
 *    the whole `safety` section of `bridlewise.config.json`. The VALUE
 *    validators live with the consumers (`resolveToolCallGateConfig`,
 *    `resolveBandaidConfig` — the engine resolvers); this schema bounds the
 *    shape so a document that carries the section is persistable.
 * 2. The posture floors (`safetyConfigViolations` and friends) — the ONE
 *    owner of the declared minimum safety posture. The floors answer two
 *    questions: per leaf, can this leaf's weakening value REMOVE a
 *    protection class (a detector's off state, a gate check disabled, a
 *    narrowing that leaves a detector structurally unable to fire)? If it
 *    can, the weakening value is refused at every sanctioned door — the
 *    write gate (the document splice in `config-contracts.ts` consults
 *    `safetyConfigViolations`), the boot pin (the server resolves the
 *    posture before the socket listens), and the per-run resolution (the
 *    config accessors assert before the resolvers run). A hand-edited file
 *    that never passed the gate is caught by the second and third doors.
 *    And across leaves, can one leaf's value silently override another
 *    protection's configured meaning (the escalation threshold sitting
 *    past the auto-trip it gates)? If it can, the coupled value is refused
 *    at the same three doors, with the sentence naming both values.
 *
 * The floors are DELIBERATELY not detection budgets: a threshold that tunes
 * what a verdict means while the detector stays armed (a similarity floor, a
 * window, a repeat count) is the operator's to choose through the file —
 * the settings room shows it read-only and never offers the write. The
 * off-state floors refuse only the off states and the disguised off states;
 * the coupling floors refuse only a value that would silently override
 * another protection's configured meaning. An absent section is no
 * violation, and an absent leaf is none for the off-state floors — the
 * resolvers' own defaults are all ON. The coupling floors read the
 * EFFECTIVE values (an absent leaf falls to that same declared default),
 * so a fresh config is still indistinguishable from a fully armed one —
 * its defaults satisfy every coupling — while a written value that
 * collides with another leaf's default is caught the same as a collision
 * with a written value.
 */

import { z } from "zod";

import { InputError } from "../kernel/errors.ts";
import {
  BANDAID_FAMILIES,
  BANDAID_PATTERN_CATEGORIES,
  BANDAID_SEVERITIES,
  CONSEQUENTIAL_TOOLS_MODES,
  type BandaidFamily,
} from "./bandaid-config.ts";
import { DEFAULT_TOOL_CALL_GATE_CONFIG } from "./tool-call-gate.ts";

const FINITE = z.number().finite();
const NONNEGATIVE_INT = z.number().int().nonnegative();
const POSITIVE_INT = z.number().int().positive();

/**
 * Pre-dispatch tool-call gate (`safety.toolCallGate`). Field names match
 * `ToolCallGateConfig` — the engine resolver (`resolveToolCallGateConfig`)
 * is the only validation of values; this schema is the write-gate shape so a
 * document that carries the section is persistable.
 */
const SAFETY_TOOL_CALL_GATE_SCHEMA = z.strictObject({
  enableGhostToolDetection: z.boolean().optional(),
  enableSchemaValidation: z.boolean().optional(),
  enableLoopDetection: z.boolean().optional(),
  enablePartialArgumentMemory: z.boolean().optional(),
  partialArgumentsLimit: POSITIVE_INT.optional(),
  maxRepeatCount: POSITIVE_INT.optional(),
  loopWindow: POSITIVE_INT.optional(),
  /** Consecutive identical blocked calls before the refusal escalates
   * (default 3 — the third identical block is the pattern a watching human
   * would intervene on; each further repeat burns a full turn's tokens). */
  blockEscalationAfter: POSITIVE_INT.optional(),
  /** Consecutive identical blocked calls at which the tool is auto-tripped
   * for the rest of the run (default 6 = 2× the escalation default; 0
   * disables the auto-trip — non-negative because 0 is the operator's
   * explicit "never trip"). */
  blockAutoTripAfter: NONNEGATIVE_INT.optional(),
});

const EVENT_FEED_FAMILY_SCHEMA = z.strictObject({
  enabled: z.boolean().optional(),
  minEvents: NONNEGATIVE_INT.optional(),
});

/**
 * Event-feed detector overrides (`safety.eventFeed`). The field vocabulary is
 * `BandaidConfigOverrides` — families come from `BANDAID_FAMILIES` so a new
 * family is declared here automatically. The engine resolver
 * (`resolveBandaidConfig`) is the only value validator; this schema is the
 * write-gate shape so a document that carries the section is persistable.
 */
const SAFETY_EVENT_FEED_SCHEMA = z.strictObject({
  families: z.strictObject(
    Object.fromEntries(BANDAID_FAMILIES.map((family) => [family, EVENT_FEED_FAMILY_SCHEMA.optional()])),
  ).optional(),
  bandaidPatterns: z.array(z.strictObject({
    label: z.string().optional(),
    regex: z.string().min(1).optional(),
    severity: z.enum(BANDAID_SEVERITIES).optional(),
    category: z.enum(BANDAID_PATTERN_CATEGORIES).optional(),
  })).optional(),
  learnedSuppressionPragmas: z.array(z.string().min(1)).optional(),
  learnedDeferredMarkers: z.array(z.string().min(1)).optional(),
  longCommentDeferredEnabled: z.boolean().optional(),
  longCommentMinRatio: FINITE.positive().optional(),
  longCommentMinCommentLength: POSITIVE_INT.optional(),
  bandaidMinRootCauseOverlap: FINITE.min(0).max(1).optional(),
  bandaidMinEditLines: POSITIVE_INT.optional(),
  workaroundSwitchWindow: POSITIVE_INT.optional(),
  workaroundConsequentialToolsMode: z.enum(CONSEQUENTIAL_TOOLS_MODES).optional(),
  workaroundConsequentialTools: z.array(z.string().min(1)).optional(),
  workaroundManualApproachPatterns: z.array(z.string().min(1)).optional(),
  deviationMinTaskSimilarity: FINITE.min(0).max(1).optional(),
  deviationMinTurnsBeforeDeviation: NONNEGATIVE_INT.optional(),
  deviationWindowSize: POSITIVE_INT.optional(),
  deviationPersistentThreshold: POSITIVE_INT.optional(),
  deviationStopwords: z.array(z.string().min(1)).optional(),
  stepSkipExpectations: z.record(z.string(), z.array(z.string().min(1))).optional(),
  stepSkipEditBeforeReadWindow: POSITIVE_INT.optional(),
  investigationRootCauseOverlapFloor: FINITE.min(0).max(1).optional(),
  pauseAskEnabled: z.boolean().optional(),
  pauseAskMaxMessageLength: POSITIVE_INT.optional(),
  /** Non-negative: 0 is the operator's explicit "never time out". */
  pauseAskWaitTimeoutMs: NONNEGATIVE_INT.optional(),
  learnOptions: z.strictObject({
    minSupport: POSITIVE_INT.optional(),
    maxPragmaLength: POSITIVE_INT.optional(),
    maxDeferredLength: POSITIVE_INT.optional(),
    includeLongCommentHeuristic: z.boolean().optional(),
  }).optional(),
});

/** Safety (`safety` module). */
export const SAFETY_CONFIG_SCHEMA = z.strictObject({
  /** Score an observation must reach to be flagged. */
  threshold: FINITE.min(0).max(1).optional(),
  /** Whether the allowlist is enforced. */
  whitelistEnabled: z.boolean().optional(),
  /** Whether grounding is enforced. */
  groundingEnabled: z.boolean().optional(),
  /** Whether an uncertain input fails closed. */
  failClosed: z.boolean().optional(),
  /** How grounding is enforced. */
  groundingMode: z.enum(["off", "warn", "strict", "block"]).optional(),
  /** Pre-dispatch tool-call gate (ghost tool / schema / loop). */
  toolCallGate: SAFETY_TOOL_CALL_GATE_SCHEMA.optional(),
  /** Event-feed detectors (workaround, bandaid, step-skip, deviation). */
  eventFeed: SAFETY_EVENT_FEED_SCHEMA.optional(),
});

// ── The posture floors ──────────────────────────────────────────────────────

/**
 * One refused weakening: the machine code, the leaf whose value refuses, and
 * — for a cross-field coupling only — the rule's own sentence, because the
 * coupling's refusal must name BOTH conflicting values and those values are
 * known where the finding is made, never in the code-keyed message table.
 */
export type SafetyPostureFinding = Readonly<{
  code: string;
  leaf: string;
  sentence?: string;
}>;

/**
 * The pre-dispatch gate's three checks, each named for its floor. A check
 * turned off is a stage of the guardrail pipeline removed before any tool
 * runs — not a preference.
 */
const GATE_CHECK_FLOORS: ReadonlyArray<
  Readonly<{
    field: "enableGhostToolDetection" | "enableSchemaValidation" | "enableLoopDetection";
    code: string;
    checkName: string;
    sentence: string;
  }>
> = Object.freeze([
  {
    field: "enableGhostToolDetection",
    code: "safety_gate_ghost_tools_required",
    checkName: "the ghost-tool check",
    sentence:
      "the pre-dispatch gate refuses calls to tools that are not registered before any tool runs",
  },
  {
    field: "enableSchemaValidation",
    code: "safety_gate_schema_validation_required",
    checkName: "the argument check",
    sentence:
      "the pre-dispatch gate refuses tool calls whose arguments fail the tool's own schema",
  },
  {
    field: "enableLoopDetection",
    code: "safety_gate_loop_detection_required",
    checkName: "the loop check",
    sentence:
      "the pre-dispatch gate refuses identical repeated calls past the loop threshold",
  },
]);

/** The event-feed families, in the runtime owner's own words. */
const FAMILY_LABELS: Readonly<Record<BandaidFamily, string>> = Object.freeze({
  bandaid: "bandaid fix",
  workaround: "workaround",
  stepSkip: "skipped step",
  deviation: "off-task work",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * One cross-field coupling the leaf schemas cannot express. The gate's own
 * mechanism ties the two block-sequence thresholds together: the auto-trip
 * only fires once the refusal message has escalated, so an escalation
 * threshold sitting PAST the trip threshold would silently push the trip
 * back onto the escalation count, overriding the configured switch-off
 * point. The `code` is the rule's stable machine identity; the `sentence`
 * is the same refusal in the words of the person who pressed save — the
 * rule, and the values that conflict, read from the section itself. The
 * row type demands all four, so a rule added without its sentence is a
 * compile error, never a bare code rendered to a person.
 */
type SafetyGateCrossFieldRule = Readonly<{
  code: string;
  leaf: string;
  broken: (gate: Record<string, unknown>) => boolean;
  sentence: (gate: Record<string, unknown>) => string;
}>;

/**
 * A gate leaf's EFFECTIVE value: the section's own number when it carries
 * one, else the resolver's declared default (the one owner of the
 * defaults). The coupling binds the effective values, not the written
 * ones: the settings sheet writes one leaf at a time, so a written
 * escalation past the DEFAULT trip count is the same silent override, and
 * a non-number the write gate would refuse falls to the default here so
 * the posture assert never crashes on a hand-edited file — the resolvers
 * own malformed values.
 */
function effectiveGateThreshold(
  gate: Record<string, unknown>,
  field: "blockEscalationAfter" | "blockAutoTripAfter",
): Readonly<{ value: number; fromDefault: boolean }> {
  const raw = gate[field];
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return { value: raw, fromDefault: false };
  }
  return { value: DEFAULT_TOOL_CALL_GATE_CONFIG[field], fromDefault: true };
}

const SAFETY_GATE_CROSS_FIELD_RULES: readonly SafetyGateCrossFieldRule[] = Object.freeze([
  {
    code: "safety_gate_escalation_exceeds_auto_trip",
    leaf: "safety.toolCallGate.blockEscalationAfter",
    broken: (gate) => {
      const trip = effectiveGateThreshold(gate, "blockAutoTripAfter");
      if (trip.value <= 0) return false; // 0 is the operator's explicit never-trip: nothing to push back
      return effectiveGateThreshold(gate, "blockEscalationAfter").value > trip.value;
    },
    sentence: (gate) => {
      const escalation = effectiveGateThreshold(gate, "blockEscalationAfter");
      const trip = effectiveGateThreshold(gate, "blockAutoTripAfter");
      const shown = (entry: Readonly<{ value: number; fromDefault: boolean }>): string =>
        `${entry.value}${entry.fromDefault ? ", its default" : ""}`;
      return `"safety.toolCallGate.blockEscalationAfter" (${shown(escalation)}) may not exceed "safety.toolCallGate.blockAutoTripAfter" (${shown(trip)}) — the tool's switch-off cannot happen before the refusal message escalates, so a value past it would silently delay the switch-off; keep it at or below ${trip.value}, or raise the switch-off count`;
    },
  },
]);

/**
 * The gate half of the floors: the three pre-dispatch checks may not be
 * turned off, and the escalation/trip coupling may not be crossed. Accepts
 * the RAW section value (an absent section is no violation; an absent leaf
 * is none for the off-state floors and falls to the declared default for
 * the coupling floors), so the same owner serves the write gate, the boot
 * pin, and the per-run accessor.
 */
function safetyGatePostureViolations(section: unknown): readonly SafetyPostureFinding[] {
  if (!isRecord(section)) return [];
  const findings: SafetyPostureFinding[] = [];
  for (const floor of GATE_CHECK_FLOORS) {
    if (section[floor.field] === false) {
      findings.push({ code: floor.code, leaf: `safety.toolCallGate.${floor.field}` });
    }
  }
  for (const rule of SAFETY_GATE_CROSS_FIELD_RULES) {
    if (rule.broken(section)) {
      findings.push({ code: rule.code, leaf: rule.leaf, sentence: rule.sentence(section) });
    }
  }
  return findings;
}

/**
 * The event-feed half of the floors: a detector family may not be disarmed,
 * the bandaid detector's long-comment finding path may not be turned off,
 * and the workaround consequential-tools mode may not narrow to 'list' while
 * the list names no tools — with nothing consequential, the workaround
 * detector could never fire, which is a disarm in disguise.
 */
function safetyEventFeedPostureViolations(section: unknown): readonly SafetyPostureFinding[] {
  if (!isRecord(section)) return [];
  const findings: SafetyPostureFinding[] = [];
  const families = section.families;
  if (isRecord(families)) {
    for (const family of BANDAID_FAMILIES) {
      const entry = families[family];
      if (isRecord(entry) && entry.enabled === false) {
        findings.push({
          code: "safety_event_feed_family_required",
          leaf: `safety.eventFeed.families.${family}.enabled`,
        });
      }
    }
  }
  if (section.longCommentDeferredEnabled === false) {
    findings.push({
      code: "safety_event_feed_heuristic_required",
      leaf: "safety.eventFeed.longCommentDeferredEnabled",
    });
  }
  if (section.workaroundConsequentialToolsMode === "list") {
    const named = section.workaroundConsequentialTools;
    const namesAtLeastOneTool = Array.isArray(named) && named.some((tool) => typeof tool === "string" && tool.length > 0);
    if (!namesAtLeastOneTool) {
      findings.push({
        code: "safety_workaround_consequential_tools_required",
        leaf: "safety.eventFeed.workaroundConsequentialToolsMode",
      });
    }
  }
  return findings;
}

/** The whole section's posture findings (both halves), for the write gate. */
export function safetyConfigViolations(section: unknown): readonly SafetyPostureFinding[] {
  if (!isRecord(section)) return [];
  return [
    ...safetyGatePostureViolations(section.toolCallGate),
    ...safetyEventFeedPostureViolations(section.eventFeed),
  ];
}

/**
 * The plain-words refusal for one finding — the machine code AND the rule's
 * sentence, because this message is what a refused settings save renders in
 * the sheet (the write door passes it through verbatim) and what a refused
 * boot or run prints. Sentence case, no values beyond the leaf's own name.
 */
export function safetyConfigRefusalMessage(finding: SafetyPostureFinding): string {
  if (finding.sentence !== undefined) {
    return `${finding.code} — ${finding.sentence}`;
  }
  if (finding.code === "safety_event_feed_family_required") {
    const family = finding.leaf.split(".")[3] as BandaidFamily;
    return `${finding.code} — ${finding.leaf} may not disarm the ${FAMILY_LABELS[family]} detector: all four event-feed detectors are armed for every run, and turning one off is the machine administrator's decision, made in the file with the machine in hand (set it to true or delete the key)`;
  }
  if (finding.code === "safety_event_feed_heuristic_required") {
    return `${finding.code} — ${finding.leaf} may not turn off the long-comment check: it is one of the bandaid detector's finding paths, and a settings cookie may not disarm it (set it to true or delete the key)`;
  }
  if (finding.code === "safety_workaround_consequential_tools_required") {
    return `${finding.code} — ${finding.leaf} may not narrow to 'list' while workaroundConsequentialTools names no tools: with nothing named as consequential, the workaround detector could never fire, so the narrowing is a disarm in disguise (name at least one tool in the file, or keep the mode 'all')`;
  }
  const gateFloor = GATE_CHECK_FLOORS.find((floor) => floor.code === finding.code);
  if (gateFloor !== undefined) {
    return `${finding.code} — ${finding.leaf} may not turn off ${gateFloor.checkName}: ${gateFloor.sentence}, and a settings cookie may not disarm it (set it to true or delete the key)`;
  }
  return `${finding.code} — ${finding.leaf} may not weaken the safety posture (set the leaf to its armed value or delete the key)`;
}

/** Every posture code the floors can produce — the re-throw membership test. */
export const SAFETY_POSTURE_VIOLATION_CODES: ReadonlySet<string> = Object.freeze(
  new Set<string>([
    ...GATE_CHECK_FLOORS.map((floor) => floor.code),
    ...SAFETY_GATE_CROSS_FIELD_RULES.map((rule) => rule.code),
    "safety_event_feed_family_required",
    "safety_event_feed_heuristic_required",
    "safety_workaround_consequential_tools_required",
  ]),
);

/** Whether a thrown error is a refused posture (never a value-shape problem). */
export function isSafetyPostureViolation(err: unknown): boolean {
  return err instanceof InputError && SAFETY_POSTURE_VIOLATION_CODES.has(err.code);
}

/**
 * The boot and per-run doors: resolve the RAW section value through the one
 * floor owner and throw the typed refusal when the posture is weakened.
 * Absent sections and absent leaves pass untouched (default-preserving).
 */
export function assertSafetyGatePosture(section: unknown): void {
  const [finding] = safetyGatePostureViolations(section);
  if (finding !== undefined) {
    throw new InputError(safetyConfigRefusalMessage(finding), finding.code);
  }
}

export function assertSafetyEventFeedPosture(section: unknown): void {
  const [finding] = safetyEventFeedPostureViolations(section);
  if (finding !== undefined) {
    throw new InputError(safetyConfigRefusalMessage(finding), finding.code);
  }
}
