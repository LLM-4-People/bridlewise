import { z } from "zod";

import { canonicalHash, deepFreeze, type DeepReadonly } from "../kernel/integrity.ts";
import {
  hasSecretTextSignal,
  isSensitiveKeyName,
  normalizeSecretKey,
} from "../privacy/secret-signals.ts";
import { schemaId } from "../kernel/product-identity.ts";

/**
 * Central performance and resource observability configuration.
 *
 * One canonical owner for scope, sampling, histograms, budgets, retention,
 * exporters, label schemas, cardinality/privacy, backpressure, and failure
 * behavior. Every performance parameter is declared here first; adding a
 * parameter requires adding it to this schema before any consumer reads it.
 *
 * This module defines the typed schema fragment; the central config contract
 * in `src/config-contracts.ts` composes it into the single validated document.
 * No second configuration authority is created.
 */

export const PERFORMANCE_CONFIG_SCHEMA_VERSION = schemaId("performance-config", 1);

export const DIAGNOSTIC_MODE_IDS = deepFreeze([
  "cpu", "memory", "io", "event-loop", "process", "cgroup",
] as const);
export type DiagnosticModeId = typeof DIAGNOSTIC_MODE_IDS[number];

export const EXPORTER_KINDS = deepFreeze([
  "timeline", "json-file", "otlp-http", "prometheus",
] as const);
export type ExporterKind = typeof EXPORTER_KINDS[number];

export const BACKPRESSURE_POLICIES = deepFreeze([
  "drop-oldest", "block", "sample",
] as const);
export type BackpressurePolicy = typeof BACKPRESSURE_POLICIES[number];

export const COLLECTOR_FAILURE_BEHAVIORS = deepFreeze([
  "fail-closed", "continue-with-error-event", "disable-collector",
] as const);
export type CollectorFailureBehavior = typeof COLLECTOR_FAILURE_BEHAVIORS[number];

/**
 * Whether per-effect resource deltas (CPU time + heap growth, measured across
 * each wrapped effect) are recorded, when the config file does not say. On:
 * the deltas are the difference between "how long did this take" (a duration
 * already answers that) and "what did it cost" — and they are cheap. The
 * `process.cpuUsage()` + `process.memoryUsage()` pair costs on the order of a
 * microsecond per effect (measured: see the overhead note in the config
 * file's `performance.resourceDeltas` description), orders of magnitude
 * inside `budgets.overheadBudgetPercent` for any effect that does real work.
 */
export const DEFAULT_RESOURCE_DELTAS_ENABLED = true;

/**
 * Whether the process resource sampler runs, when the config file does not
 * say. On: a time series of the process's own footprint (RSS, heap, event-loop
 * utilization, CPU) is the lane that answers "what was the harness doing to
 * the machine" between effects, which no per-effect measurement can.
 */
export const DEFAULT_RESOURCE_SAMPLER_ENABLED = true;

/**
 * The resource sampler's period, in milliseconds, when the config file does
 * not say. 5 000 keeps the ledger cost at roughly one resource event per
 * second (five metrics per tick) while still resolving minute-scale trends;
 * the sampler's timer is unref'd, so the interval never keeps the process
 * alive.
 */
export const DEFAULT_RESOURCE_SAMPLER_INTERVAL_MS = 5_000;

export const ATTRIBUTION_LEVELS = deepFreeze([
  "exact", "shared", "estimated",
] as const);
export type AttributionLevel = typeof ATTRIBUTION_LEVELS[number];

const POSITIVE_INT = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const NON_NEGATIVE_INT = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const NON_NEGATIVE_NUMBER = z.number().nonnegative().max(Number.MAX_SAFE_INTEGER);
const FRACTION = z.number().min(0).max(1);

export const PERFORMANCE_CONFIG_SCHEMA = z.strictObject({
  schemaVersion: z.literal(PERFORMANCE_CONFIG_SCHEMA_VERSION),
  enabled: z.boolean(),
  /**
   * Scope is DENY-NOTHING-BY-DEFAULT: every module the architecture manifest
   * declares is in scope, and the config can only EXCLUDE. There is no
   * includedModules field — an allowlist would make "forgot to add the new
   * module" a silent coverage hole, which is the exact defect the generated
   * manifest exists to make impossible. A module may leave scope only by a
   * reviewed exclusion: an `excludedModules` entry here, or a per-function
   * exclusion in the manifest itself (which requires owner, rationale,
   * evidence and scope).
   */
  scope: z.strictObject({
    excludedModules: z.array(z.string().min(1).max(512)).max(1024),
  }),
  sampling: z.strictObject({
    traceSamplingRate: FRACTION,
    maxTracesPerScope: POSITIVE_INT.max(1_000_000),
    maxTraceDepth: NON_NEGATIVE_INT.max(256),
  }),
  histograms: z.strictObject({
    bucketCount: POSITIVE_INT.min(2).max(1024),
    maxDurationMs: POSITIVE_INT.max(3_600_000),
    bucketStrategy: z.enum(["linear", "log-linear", "explicit"]),
    explicitBounds: z.array(NON_NEGATIVE_NUMBER).max(1024).optional(),
  }),
  budgets: z.strictObject({
    regressionBudgetPercent: NON_NEGATIVE_NUMBER.max(100),
    overheadBudgetPercent: NON_NEGATIVE_NUMBER.max(100),
    maxBenchmarkDurationMs: POSITIVE_INT.max(3_600_000),
    maxBenchmarkRepetitions: POSITIVE_INT.max(10_000),
    minBenchmarkRepetitions: POSITIVE_INT.min(1).max(100),
  }),
  retention: z.strictObject({
    maxSnapshots: POSITIVE_INT.max(1_000_000),
    maxSnapshotAgeMs: POSITIVE_INT.max(31_536_000_000),
    maxRawSamples: POSITIVE_INT.max(10_000_000),
  }),
  exporters: z.strictObject({
    enabledExporters: z.array(z.enum(EXPORTER_KINDS)).max(16),
    exportIntervalMs: POSITIVE_INT.max(3_600_000),
    maxExportBatchSize: POSITIVE_INT.max(100_000),
  }),
  /**
   * Label keys are ADMITTED BY DEFAULT and excluded only. There is no
   * `allowedLabelKeys` field: an allowlist would silently drop every label a
   * future producer names, which is a coverage hole with no error anywhere.
   * The ONE canonical exclusion path is `forbiddenLabelNames` below — applied
   * to the label KEY as well as its value through `isForbiddenLabelText`, so a
   * credential-named key (`apiKey`, `password`) is excluded even with an
   * innocent value, and it sits ON TOP of the always-on credential vocabulary
   * (`isSensitiveKeyName` / `hasSecretTextSignal` in `src/secret-signals.ts`),
   * which no config list can switch off. Length is bounded by `maxLabelLength`
   * and `privacy.maxLabelValueLength`; cardinality is bounded by
   * `maxLabelCount` and the cardinality ceilings, not by naming keys in
   * advance.
   */
  labelSchema: z.strictObject({
    maxLabelCount: POSITIVE_INT.max(256),
    maxLabelLength: POSITIVE_INT.max(1024),
    /**
     * Label NAMES that are forbidden in metric label keys and values, matched
     * case-insensitively as normalized substrings — ADDITIONAL to the always-on
     * credential vocabulary (`isSensitiveKeyName` / `hasSecretTextSignal` in
     * `src/secret-signals.ts`), which applies regardless of this list, so
     * emptying it cannot re-admit credential material.
     *
     * This field used to be `forbiddenLabelPatterns` and carried REGEX SOURCE
     * (`[Ss]ecret`, `[Ss]k[-_]`, …), validated as bare strings and compiled at
     * TWO sites with DIFFERENT flags — `"u"` in the admission gate, `"giu"` in
     * the redactor — so the two gates disagreed about `SECRET=…`: allowed by
     * one, dropped by the other. The rung taken is UNREPRESENTABLE, the same
     * one `debug.redaction.additionalSensitiveKeyNames` sits on:
     *
     *   • the `.regex` below REFUSES regex syntax, so a single-casing pattern
     *     cannot be WRITTEN here — the config carries names, never matchers;
     *   • the CODE owns the matching (`isForbiddenLabelText`), normalises
     *     casing and separators away before comparing, and is the ONLY reader
     *     of this list — there is no pattern left to compile, so a second
     *     compilation site has nothing to fork.
     *
     * A name that is credential vocabulary belongs in `SENSITIVE_KEY_PARTS`
     * (one addition serves every consumer in both repositories); a shape that
     * needs a separator to decide it (like the `sk-` prefix) belongs in
     * `SENSITIVE_KEY_PATTERNS` beside it. This list is for performance-label
     * payload categories only.
     */
    forbiddenLabelNames: z.array(
      z.string().min(1).max(128).regex(
        /^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u,
        "must be a NAME (letters, digits, space, _ . -), not a regex — the code owns the matching and applies it case-insensitively",
      ),
    ).max(128),
  }),
  cardinality: z.strictObject({
    maxSeriesPerScope: POSITIVE_INT.max(100_000),
    maxTotalSeries: POSITIVE_INT.max(1_000_000),
  }),
  privacy: z.strictObject({
    redactCredentials: z.boolean(),
    redactPii: z.boolean(),
    redactPrompts: z.boolean(),
    redactFileContents: z.boolean(),
    maxLabelValueLength: POSITIVE_INT.max(4096),
  }),
  backpressure: z.strictObject({
    maxQueueDepth: POSITIVE_INT.max(1_000_000),
    policy: z.enum(BACKPRESSURE_POLICIES),
  }),
  failureBehavior: z.strictObject({
    onCollectorError: z.enum(COLLECTOR_FAILURE_BEHAVIORS),
    onExporterError: z.enum(COLLECTOR_FAILURE_BEHAVIORS),
  }),
  /**
   * Diagnostic modes are ON BY DEFAULT — all six declared modes — and the
   * config can only EXCLUDE. There is no `enabledModes` field: an enable-list
   * would make "forgot to enable the new mode" a silent capability hole. A
   * mode leaves the runner only by naming it in `excludedModes`.
   */
  diagnosticModes: z.strictObject({
    excludedModes: z.array(z.enum(DIAGNOSTIC_MODE_IDS)).max(6),
    modeTimeoutMs: POSITIVE_INT.max(3_600_000),
    modeBudgetMs: POSITIVE_INT.max(3_600_000),
  }),
  /**
   * Per-effect resource deltas. When enabled, every wrapped effect also
   * measures the CPU time (user + system) it consumed and the heap growth it
   * caused, beside its wall-clock duration — in the ledger's timing document
   * and in the metrics collector's per-scope aggregates. The measured cost of
   * one capture pair is ~1–3 µs per effect (a `process.cpuUsage()` +
   * `process.memoryUsage()` round trip), which for any effect that does real
   * work is orders of magnitude inside `budgets.overheadBudgetPercent`; the
   * off switch exists for an operator who wants the ledger and metrics to
   * stay timing-only, not because the capture is expensive.
   */
  resourceDeltas: z.strictObject({
    enabled: z.boolean().default(DEFAULT_RESOURCE_DELTAS_ENABLED),
  }).default({ enabled: DEFAULT_RESOURCE_DELTAS_ENABLED }),
  /**
   * The process resource sampler: a periodic, best-effort tick that writes
   * the process's own footprint (RSS, heap used, event-loop utilization,
   * CPU user/system deltas since the previous tick) into the ledger's
   * existing `resource` lane. Runs on the main thread on an unref'd timer,
   * so it never keeps the process alive and stops with shutdown. A tick
   * costs five small ledger appends per interval — at the default 5 000 ms
   * that is roughly one append per second, bounded by the ledger's own
   * retention limits.
   */
  resourceSampler: z.strictObject({
    enabled: z.boolean().default(DEFAULT_RESOURCE_SAMPLER_ENABLED),
    intervalMs: POSITIVE_INT.max(3_600_000).default(DEFAULT_RESOURCE_SAMPLER_INTERVAL_MS),
  }).default({
    enabled: DEFAULT_RESOURCE_SAMPLER_ENABLED,
    intervalMs: DEFAULT_RESOURCE_SAMPLER_INTERVAL_MS,
  }),
});

export type PerformanceConfig = DeepReadonly<z.infer<typeof PERFORMANCE_CONFIG_SCHEMA>>;

export const DEFAULT_PERFORMANCE_CONFIG: PerformanceConfig = deepFreeze({
  schemaVersion: PERFORMANCE_CONFIG_SCHEMA_VERSION,
  enabled: true,
  scope: {
    excludedModules: [],
  },
  sampling: {
    traceSamplingRate: 0,
    maxTracesPerScope: 1000,
    maxTraceDepth: 32,
  },
  histograms: {
    bucketCount: 64,
    maxDurationMs: 60_000,
    bucketStrategy: "log-linear",
  },
  budgets: {
    regressionBudgetPercent: 10,
    overheadBudgetPercent: 5,
    maxBenchmarkDurationMs: 300_000,
    maxBenchmarkRepetitions: 100,
    minBenchmarkRepetitions: 3,
  },
  retention: {
    maxSnapshots: 10_000,
    maxSnapshotAgeMs: 2_592_000_000,
    maxRawSamples: 1_000_000,
  },
  exporters: {
    enabledExporters: ["timeline"],
    exportIntervalMs: 60_000,
    maxExportBatchSize: 10_000,
  },
  labelSchema: {
    maxLabelCount: 32,
    maxLabelLength: 256,
    // Payload categories only. The credential half of the old regex list
    // (authorization, bearer, api-key, secret, password, token, credential,
    // sk-) is now the code-owned vocabulary in `src/secret-signals.ts` and is
    // applied unconditionally — it does not appear here because a config list
    // must not be able to switch it off.
    forbiddenLabelNames: [
      "prompt", "content", "payload", "diff", "source-code",
    ],
  },
  cardinality: {
    maxSeriesPerScope: 10_000,
    maxTotalSeries: 100_000,
  },
  privacy: {
    redactCredentials: true,
    redactPii: true,
    redactPrompts: true,
    redactFileContents: true,
    maxLabelValueLength: 256,
  },
  backpressure: {
    maxQueueDepth: 10_000,
    policy: "drop-oldest",
  },
  failureBehavior: {
    onCollectorError: "continue-with-error-event",
    onExporterError: "continue-with-error-event",
  },
  diagnosticModes: {
    excludedModes: [],
    modeTimeoutMs: 30_000,
    modeBudgetMs: 60_000,
  },
  resourceDeltas: {
    enabled: DEFAULT_RESOURCE_DELTAS_ENABLED,
  },
  resourceSampler: {
    enabled: DEFAULT_RESOURCE_SAMPLER_ENABLED,
    intervalMs: DEFAULT_RESOURCE_SAMPLER_INTERVAL_MS,
  },
});

export function parsePerformanceConfig(value: unknown): PerformanceConfig {
  return deepFreeze(PERFORMANCE_CONFIG_SCHEMA.parse(value));
}

/**
 * One cross-field invariant the leaf schemas cannot express. The `code` is the
 * rule's stable machine identity — tests key on it, and the config write gate
 * carries it in the refusal so tooling can match the refusal to the rule. The
 * `sentence` is the same refusal in the words of the person who pressed save:
 * the rule, and the values that conflict, read from the section itself — the
 * single-field bounds checker sets this grammar ("allows values up to 100 —
 * 200 is above its maximum"), and a cross-field refusal owes the surface the
 * same words. The row type demands all three, so a rule added without its
 * sentence is a compile error, never a bare code rendered to a person.
 */
type PerformanceCrossFieldRule = Readonly<{
  code: string;
  broken: (config: PerformanceConfig) => boolean;
  sentence: (config: PerformanceConfig) => string;
}>;

const PERFORMANCE_CROSS_FIELD_RULES = deepFreeze([
  {
    code: "performance_config_sampling_rate_without_quota",
    broken: (config) =>
      config.sampling.traceSamplingRate > 0 && config.sampling.maxTracesPerScope === 0,
    sentence: (config) =>
      `trace sampling is on at rate ${config.sampling.traceSamplingRate}, but "performance.sampling.maxTracesPerScope" is 0 — the sampled traces would have nowhere to land; raise the quota above 0 or set the sampling rate to 0`,
  },
  {
    code: "performance_config_histogram_explicit_bounds_missing",
    broken: (config) =>
      config.histograms.bucketStrategy === "explicit" &&
      config.histograms.explicitBounds === undefined,
    sentence: () =>
      `the histogram bucket strategy is "explicit", but "performance.histograms.explicitBounds" is not set — an explicit strategy needs its bounds list`,
  },
  {
    code: "performance_config_histogram_bounds_not_monotonic",
    broken: (config) => {
      if (config.histograms.bucketStrategy !== "explicit") return false;
      const bounds = config.histograms.explicitBounds;
      if (bounds === undefined) return false;
      for (let i = 1; i < bounds.length; i++) {
        if (bounds[i]! <= bounds[i - 1]!) return true;
      }
      return false;
    },
    sentence: (config) => {
      const bounds = config.histograms.explicitBounds ?? [];
      for (let i = 1; i < bounds.length; i++) {
        if (bounds[i]! <= bounds[i - 1]!) {
          return `"performance.histograms.explicitBounds" must rise strictly — ${bounds[i]!} at position ${i} does not exceed ${bounds[i - 1]!}`;
        }
      }
      return `"performance.histograms.explicitBounds" must rise strictly from one bound to the next`;
    },
  },
  {
    code: "performance_config_histogram_bounds_exceed_bucket_count",
    broken: (config) =>
      config.histograms.bucketStrategy === "explicit" &&
      config.histograms.explicitBounds !== undefined &&
      config.histograms.explicitBounds.length > config.histograms.bucketCount,
    sentence: (config) =>
      `"performance.histograms.explicitBounds" holds ${config.histograms.explicitBounds?.length ?? 0} bounds, but "performance.histograms.bucketCount" allows only ${config.histograms.bucketCount} — the bounds list cannot outgrow the bucket count`,
  },
  {
    code: "performance_config_benchmark_repetition_range_invalid",
    broken: (config) =>
      config.budgets.minBenchmarkRepetitions > config.budgets.maxBenchmarkRepetitions,
    sentence: (config) =>
      `the fewest benchmark repetitions ("performance.budgets.minBenchmarkRepetitions" = ${config.budgets.minBenchmarkRepetitions}) sits above the most ("performance.budgets.maxBenchmarkRepetitions" = ${config.budgets.maxBenchmarkRepetitions}) — the floor must stay at or below the ceiling`,
  },
  {
    code: "performance_config_label_length_exceeds_privacy_cap",
    broken: (config) =>
      config.labelSchema.maxLabelLength > config.privacy.maxLabelValueLength,
    sentence: (config) =>
      `"performance.labelSchema.maxLabelLength" (${config.labelSchema.maxLabelLength}) exceeds the privacy cap "performance.privacy.maxLabelValueLength" (${config.privacy.maxLabelValueLength}) — the declared label maximum must stay within the cap`,
  },
  {
    code: "performance_config_exporters_not_unique",
    broken: (config) =>
      new Set(config.exporters.enabledExporters).size !== config.exporters.enabledExporters.length,
    sentence: (config) =>
      `"performance.exporters.enabledExporters" names the same exporter more than once (${duplicateValues(config.exporters.enabledExporters)}) — each exporter may be enabled only once`,
  },
  {
    code: "performance_config_diagnostic_modes_not_unique",
    broken: (config) =>
      new Set(config.diagnosticModes.excludedModes).size !== config.diagnosticModes.excludedModes.length,
    sentence: (config) =>
      `"performance.diagnosticModes.excludedModes" names the same mode more than once (${duplicateValues(config.diagnosticModes.excludedModes)}) — each mode may be excluded only once`,
  },
] as const satisfies readonly PerformanceCrossFieldRule[]);

/** The values a list holds more than once, in first-seen order. */
function duplicateValues(values: readonly string[]): string {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].join(", ");
}

/** Every machine code the cross-field checker can push — derived from the rules, never restated. */
export type PerformanceConfigViolationCode =
  (typeof PERFORMANCE_CROSS_FIELD_RULES)[number]["code"];

export function performanceConfigViolations(
  config: PerformanceConfig,
): readonly PerformanceConfigViolationCode[] {
  if (!config.enabled) return [];
  const codes = PERFORMANCE_CROSS_FIELD_RULES
    .filter((rule) => rule.broken(config))
    .map((rule) => rule.code);
  return [...new Set(codes)].toSorted();
}

/**
 * The refusal message for one cross-field violation: the machine identity and
 * the rule's own sentence in one string, so every door that renders a zod
 * issue message — the settings write gate the sheet reads — answers with both,
 * and no second code→sentence map can drift from this owner. The sentence names
 * the conflicting values, which the code alone never did.
 *
 * An out-of-table code falls back to the bare code: unreachable from typed
 * callers (the codes derive from the table), and an honest floor for a runtime
 * caller — a rule this owner does not know is named by its identity, never
 * given a fabricated sentence.
 */
export function performanceConfigRefusalMessage(
  code: PerformanceConfigViolationCode,
  config: PerformanceConfig,
): string {
  const rule = PERFORMANCE_CROSS_FIELD_RULES.find((candidate) => candidate.code === code);
  return rule === undefined ? code : `${code} — ${rule.sentence(config)}`;
}

export function performanceConfigHash(config: PerformanceConfig): string {
  return canonicalHash(config);
}

/**
 * THE one decision about forbidden text in a metric label — key or value.
 *
 * Both label gates (`isLabelAllowed`, which refuses, and `redactLabelValue`,
 * which drops) consume THIS predicate and nothing else. They used to compile
 * `labelSchema.forbiddenLabelPatterns` independently — `"u"` here, `"giu"`
 * there — so the admission gate admitted `SECRET=…` while the redactor
 * dropped it: one list, two compilations, two verdicts. There is no pattern
 * list left to compile; a consumer cannot reproduce the fork because it never
 * receives patterns, only this answer.
 *
 * Three layers, all casing-invariant by construction:
 *   1. `isSensitiveKeyName` — the shared credential-name vocabulary
 *      (`SENSITIVE_KEY_PARTS` + separator-decided `SENSITIVE_KEY_PATTERNS`,
 *      including the `sk-`/`SK_` prefix), compared over NFKC-lower-cased,
 *      separator-stripped text, so "matches one casing" is not a state the
 *      matcher can be in.
 *   2. `hasSecretTextSignal` (classification profile) — value-format signals
 *      (AKIA…, `Bearer …`, PEM blocks, credential assignments) that have no
 *      name to match.
 *   3. The config's `forbiddenLabelNames` — payload categories, normalized on
 *      BOTH sides before the substring test, so neither the operator's casing
 *      nor the label's can matter.
 */
export function isForbiddenLabelText(
  config: PerformanceConfig,
  text: string,
): boolean {
  if (isSensitiveKeyName(text)) return true;
  if (hasSecretTextSignal(text, "classification")) return true;
  const normalized = normalizeSecretKey(text);
  return config.labelSchema.forbiddenLabelNames.some(
    (name) => normalized.includes(normalizeSecretKey(name)),
  );
}

export function isLabelAllowed(
  config: PerformanceConfig,
  key: string,
  value: string,
): boolean {
  if (key.length > config.labelSchema.maxLabelLength) return false;
  if (value.length > config.privacy.maxLabelValueLength) return false;
  // No allowlist: keys are admitted by default and excluded only by the
  // forbidden-text denylist below (credential vocabulary + forbiddenLabelNames).
  return !isForbiddenLabelText(config, key) && !isForbiddenLabelText(config, value);
}

export function redactLabelValue(
  config: PerformanceConfig,
  value: string,
): string {
  if (!config.privacy.redactCredentials) return value;
  return isForbiddenLabelText(config, value) ? "[redacted]" : value;
}
