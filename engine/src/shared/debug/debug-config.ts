import { z } from "zod";

import { deepFreeze, type DeepReadonly } from "../../kernel/integrity.ts";
import { schemaId } from "../../kernel/product-identity.ts";
import { InputError } from "../../kernel/errors.ts";

/**
 * Central debug, error, and audit configuration — the single source of truth
 * for the harness-wide debug/error/audit system.
 *
 * One canonical owner (mirrors `performance/performance-config.ts`): every
 * debug parameter is declared here first, composed into the central config
 * contract in `src/config-contracts.ts`, and validated at load time. No
 * second configuration authority is created; no hardcoded `TIMEOUT`,
 * `DEBUG`, or `LOG_LEVEL` literals live outside this schema and the config
 * document.
 *
 * Design (per the central-debug contract):
 * - `enabled` is the master switch. When `false`, `debugLog` is a no-op
 * with near-zero overhead (early return before argument evaluation).
 * - `level` filters by severity; `debug` and `trace` are ignored unless
 * `level` is set to include them.
 * - `categories` is an allow-list of debug categories that are emitted;
 * categories not in the list are no-ops (fine-grained control without a
 * second config source).
 * - `audit` controls audit-event recording (always-on when enabled, never
 * zero-overhead-skipped: audit is the safety floor).
 * - `errorHandling` controls how `handleError` classifies and reports.
 * - `sinks.enabledSinks` is the ALLOW-LIST of destinations, and it is read at
 *   the one door: a sink whose kind is not named there is refused. Every kind
 *   it can name has an implementation (see `DEBUG_SINK_KINDS`).
 * - `redaction` mirrors the performance label redaction policy so no
 * credentials, PII, prompts, or file contents leak into debug output.
 *
 * WITHDRAWN LEAVES (the declared-but-unread class, pruned with the file edit
 * their `strictObject` coupling owed): `errorHandling.maxErrorCauses`,
 * `sinks.flushIntervalMs`, `sinks.maxBufferSize`,
 * `performance.overheadBudgetPercent`, `performance.maxContextBytes` and
 * `redaction.kinds` declared behavior no code ever read — the buffered-sink
 * flush/buffer knobs had no buffered sink, the overhead throttle and context
 * byte cap had no implementation, the error-cause ceiling had no cause chain,
 * and `kinds` selected between two redaction mechanisms that are not
 * per-kind selectable (the §34a withdrawal, completed). The section census
 * (engine/test/prevention/config-consumption-contract.test.ts) walks this
 * schema's shape and reds on any leaf `debug-system.ts` does not read, so a
 * leaf re-added without a reader names itself.
 */

export const DEBUG_CONFIG_SCHEMA_VERSION = schemaId("debug-config", 1);

/**
 * Debug severity levels, ordered. A message at level L is emitted only when
 * the configured `level` is >= L in this ordering. `off` disables everything
 * (equivalent to `enabled: false` but granular per-config).
 */
const DEBUG_LEVELS = deepFreeze([
  "off", "error", "warn", "info", "debug", "trace",
] as const);
export type DebugLevel = typeof DEBUG_LEVELS[number];

/**
 * Numeric ordering for level comparison. `off` is -1 so every real level is
 * greater than it; a message at `error` (0) is emitted when the configured
 * level is `error` or higher.
 */
const LEVEL_ORDER: Readonly<Record<DebugLevel, number>> = deepFreeze({
  off: -1,
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
});

/** @returns the numeric order of a debug level for severity comparison. */
export function debugLevelOrder(level: DebugLevel): number {
  return LEVEL_ORDER[level];
}

/**
 * @returns `true` when `messageLevel` should be emitted given the configured
 * `configuredLevel`. A message at `off` is never emitted.
 */
export function shouldEmitLevel(messageLevel: DebugLevel, configuredLevel: DebugLevel): boolean {
  if (messageLevel === "off" || configuredLevel === "off") return false;
  return LEVEL_ORDER[messageLevel] <= LEVEL_ORDER[configuredLevel];
}

/**
 * Output sinks for debug/error/audit events.
 *
 * ⚠ EVERY MEMBER OF THIS LIST MUST HAVE AN IMPLEMENTATION, AND THE COMPILER
 * ENFORCES IT. `debug-system.ts` holds `SINK_IMPLEMENTATIONS`, typed
 * `Readonly<Record<DebugSinkKind, () => DebugSink>>` — a total record over this
 * union — so adding a kind here without writing the sink is a TYPE ERROR at the
 * one place sinks are built, not a runtime surprise at the one place they are
 * installed.
 *
 * WHY THAT RULE EXISTS, MEASURED: this list used to read
 * `["console", "timeline", "file"]`. `grep -rn "\"timeline\"\|\"file\"" src/`
 * over the sink layer found NO implementation of either (rc 0, unit: matching
 * sink factories: 0). They were names in a security-relevant allow-list with
 * nothing behind them, which is worse than absent — an operator reading the
 * contract could enable `file`, get no file, and no error either. `filePath`
 * went with `file` for the same reason: it documented a requirement of a sink
 * that does not exist.
 *
 * `collecting` is a real implementation (`createCollectingSink`) and is
 * declared here rather than smuggled past the allow-list: a test that wants it
 * must ENABLE it, exactly like production enabling `console`. Deny by default
 * applies to the test estate too, and a sink kind that only the tests can name
 * is a second, undeclared authority (rule 2).
 */
const DEBUG_SINK_KINDS = deepFreeze([
  "console", "collecting",
] as const);
export type DebugSinkKind = typeof DEBUG_SINK_KINDS[number];

/** Error-classification policies for `handleError`. */
const ERROR_REPORTING_POLICIES = deepFreeze([
  "always", "deduplicated", "sampled",
] as const);
export type ErrorReportingPolicy = typeof ERROR_REPORTING_POLICIES[number];

const POSITIVE_INT = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const NON_NEGATIVE_INT = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const FRACTION = z.number().min(0).max(1);

export const DEBUG_CONFIG_SCHEMA = z.strictObject({
  schemaVersion: z.literal(DEBUG_CONFIG_SCHEMA_VERSION),
  /** Master switch. When `false`, debug logging is a no-op (zero overhead). */
  enabled: z.boolean(),
  /** Severity floor. Messages below this level are no-ops. */
  level: z.enum(DEBUG_LEVELS),
  /**
   * Fine-grained category allow-list. A `debugLog(category,...)` call is a
   * no-op unless `category` is in this list (when `enabled` is true and the
   * level passes). Empty array = no categories emitted.
   */
  categories: z.array(z.string().min(1).max(128)).max(1024),
  audit: z.strictObject({
    /** Audit events are the safety floor — always recorded when this is true. */
    enabled: z.boolean(),
    /** Maximum audit events retained in the in-memory ring buffer. */
    maxRetainedEvents: POSITIVE_INT.max(1_000_000),
    /** Categories of audit events to record. Empty = all. */
    categories: z.array(z.string().min(1).max(128)).max(1024),
  }),
  errorHandling: z.strictObject({
    /** Policy for reporting errors through `handleError`. */
    reportingPolicy: z.enum(ERROR_REPORTING_POLICIES),
    /** When `reportingPolicy` is `sampled`, the fraction of errors reported. */
    samplingRate: FRACTION,
    /** Dedup window for `deduplicated` policy: same code within N ms is suppressed. */
    dedupWindowMs: NON_NEGATIVE_INT.max(3_600_000),
  }),
  sinks: z.strictObject({
    /**
     * THE SINK ALLOW-LIST, AND IT IS READ. `configureDebugSystem` refuses any
     * sink whose `kind` is not named here, so a destination that nobody
     * declared cannot be installed — including by an importer calling the
     * exported door directly. Empty array = no sink may be installed at all.
     */
    enabledSinks: z.array(z.enum(DEBUG_SINK_KINDS)).max(16),
  }),
  redaction: z.strictObject({
    /**
     * ⚠ THE MASTER REDACTION SWITCH, AND `false` IS REFUSED AT THE SECTION'S
     * OWN DOORS. Debug output carries context payloads and error messages —
     * the likeliest credential carriers in the process — so a config that
     * switches this redactor off is refused, not honored: the section's
     * `debugConfigViolations` fires at the config write gate (the document
     * splice runs it) and at `resolveDebugConfigSection` (the bootstrap's
     * fail-closed door for bytes that never passed the gate), and the web
     * bridge refuses it a third time on its own merged value. The refusal is
     * the design, not a brick to work around: `false` is representable in the
     * engine's typed door (`configureDebugSystem`) because a library caller
     * owns its own policy, but the SHARED document is every process's policy
     * at once and may not weaken what the debug output hides.
     */
    enabled: z.boolean(),
    /**
     * ⚠ `kinds` IS WITHDRAWN (the §34a filing, completed). The field used to
     * declare per-kind redaction selection, but the redactor in
     * `debug-system.ts` implements exactly TWO mechanisms — a key-NAME gate
     * and a value-FORMAT content hint, both sourced from `secret-signals.ts`
     * — and neither is selected per-kind, so no behavior for a list to
     * choose ever existed. It survived for rounds only because the shipped
     * config file SET it and this is a `strictObject` (deleting the schema
     * field without pruning the file would fail every document parse); the
     * file edit was outside the earlier steps' write scope. Both halves are
     * now pruned in the same change, and a `redaction.kinds` key in any
     * config document is an UNKNOWN key the strictObject refuses — the leaf
     * is unrepresentable, which is the honest terminal state for a leaf that
     * declared a selection nothing could ever make.
     */
    maxContextValueLength: POSITIVE_INT.max(8192),
    /**
     * ⚠ DEPTH BOUND, AND IT IS AN AVAILABILITY CONTROL, NOT A PRIVACY ONE.
     *
     * The redactor walks the context payload. Unbounded recursion over a
     * circular or very deep object threw `RangeError` OUT OF THE REDACTOR —
     * and `handleError` is installed as the `uncaughtException` handler, so a
     * throw there is PROCESS-FATAL. A security control that kills the process
     * on a malformed input is a denial-of-service surface inside the thing
     * that exists to make failures observable.
     *
     * Beyond this depth the walk stops and writes `[DEPTH-LIMIT]`. That is a
     * VISIBLE stop, not a silent drop: a reader can tell the difference
     * between "nothing was there" and "the redactor refused to go deeper".
     */
    maxContextDepth: POSITIVE_INT.max(256),
    /**
     * ⚠ NAMES, NOT PATTERNS — AND THE `min`/`regex` BELOW IS THE WHOLE POINT.
     *
     * This field used to be `forbiddenPatterns`: a list of REGEX SOURCES that
     * `debug-system.ts` compiled with `new RegExp(p, "gu")` — no `i` flag. The
     * shipped list was written `[Ss]ecret`, `[Tt]oken`, `[Aa]pi[-_]?[Kk]ey` …,
     * a hand-rolled case fold on the FIRST LETTER ONLY. DRIVEN, one
     * `debugLog` per key, deltas from `getDebugSignals()`:
     *
     *   AWS_SECRET_ACCESS_KEY · GITHUB_TOKEN · DATABASE_URL · API_KEY ·
     *   STRIPE_SECRET_KEY · OPENAI_API_KEY · APIKEY · TOKEN · PASSWORD ·
     *   SECRET · AUTHORIZATION · CREDENTIAL · BEARER · SK_
     *
     * — 14 of 14 reached the sink VERBATIM with `redactedValues=+0` and
     * `maskedWithoutRemoval=+0`, reading exactly like a payload containing
     * nothing. `[Ss]ecret` cannot match `SECRET`. A `process.env` snapshot is
     * the single most common debug payload there is, and the entire
     * SCREAMING_SNAKE convention was invisible.
     *
     * THE REPAIR IS NOT A LONGER LIST. A config field typed "regex source"
     * can always express a pattern that only matches one casing, so the
     * defect stays REPRESENTABLE however many entries are added. So the field
     * no longer carries patterns at all:
     *
     *   • the `.regex` below REFUSES regex syntax. `[Ss]ecret` fails
     *     validation at config load with a message naming the field. There is
     *     no way to write a cased pattern here, because there is no way to
     *     write a pattern here.
     *   • the CODE owns the matching, and it is case-insensitive by
     *     construction: `isSensitiveKeyName` (`src/secret-signals.ts`)
     *     compares NFKC-normalised, lower-cased, separator-stripped forms.
     *     Casing is normalised away before the comparison happens, so
     *     "matches one casing" is not a state the matcher can be in.
     *
     * ADDITIONAL, NOT AUTHORITATIVE. The vocabulary this layer actually uses
     * is `SENSITIVE_KEY_PARTS` in `src/secret-signals.ts` — the SAME owner the
     * data classifier and the web server's redactor and config-write gate
     * consume. Entries here are ADDED to it for deployment-specific names;
     * emptying this array cannot disable the control, which is why the
     * cross-repo "caller passes an empty list" attack no longer lands.
     * A name that belongs everywhere belongs in `SENSITIVE_KEY_PARTS`, where
     * one addition serves all four consumers.
     */
    additionalSensitiveKeyNames: z.array(
      z.string().min(1).max(128).regex(
        /^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u,
        "must be a NAME (letters, digits, space, _ . -), not a regex — the code owns the matching and applies it case-insensitively",
      ),
    ).max(256),
  }),
});

export type DebugConfig = z.infer<typeof DEBUG_CONFIG_SCHEMA>;

/**
 * The default debug configuration — the single source of truth for debug
 * defaults. The config document (`bridlewise.config.json`) overrides these;
 * when a field is absent, the config schema's `.optional` lets the loader
 * fall through, and consumers read the resolved config (not this default).
 *
 * Per the binding directive "No default values outside config file", this
 * default object is the fallback ONLY for the schema-level `.default` that
 * the config contract applies — it is NOT a scattered inline literal.
 */
export const DEBUG_CONFIG_DEFAULTS: Readonly<DebugConfig> = deepFreeze({
  schemaVersion: DEBUG_CONFIG_SCHEMA_VERSION,
  enabled: false,
  level: "warn",
  categories: [],
  audit: {
    enabled: true,
    maxRetainedEvents: 10000,
    categories: [],
  },
  errorHandling: {
    reportingPolicy: "always",
    samplingRate: 1,
    dedupWindowMs: 5000,
  },
  sinks: {
    enabledSinks: ["console"],
  },
  redaction: {
    enabled: true,
    maxContextValueLength: 256,
    maxContextDepth: 32,
    // EMPTY IS THE CORRECT DEFAULT, and it is not "no policy". The key-name
    // vocabulary is `SENSITIVE_KEY_PARTS` in `src/secret-signals.ts` and the
    // value-format vocabulary is `SECRET_TEXT_SIGNAL_CATALOG` beside it; both
    // are code-owned and neither is suppressible from here. This array is the
    // deployment-specific EXTENSION point, and nothing shipped needs one.
    additionalSensitiveKeyNames: [],
  },
});

// ── The section's safety floor ────────────────────────────────────────────
//
// The section is the SHARED document's declaration of how every process's
// debug system behaves, and one leaf can weaken what debug output hides:
// `redaction.enabled: false` switches off the key-name gate and the content
// hints for the payloads and messages the sinks emit — the likeliest
// credential carriers in the process (a `process.env` snapshot is the
// commonest debug payload there is). The floor is refused, not honored, at
// every door that can put a section in front of a debug system, and the
// refusal code is the SAME code the web bridge already threw
// (`debug_redaction_required`) so the vocabulary does not fork.

export type DebugConfigViolationCode = "debug_redaction_required";

/**
 * THE ONE OWNER of the section's safety floor. Pure: the same function feeds
 * the document schema's refinement at the config splice (so the deny-by-default
 * write gate refuses a weakening section before a byte reaches disk) and
 * `resolveDebugConfigSection` (so a hand-edited file that never passed the
 * gate is refused, fail-closed, at the section's resolution) — the two doors
 * can never disagree about what weakening means.
 */
export function debugConfigViolations(section: DeepReadonly<DebugConfig>): readonly DebugConfigViolationCode[] {
  const codes: DebugConfigViolationCode[] = [];
  if (!section.redaction.enabled) codes.push("debug_redaction_required");
  return codes;
}

/**
 * The refusal message for one violation: the machine identity and the rule's
 * own sentence in one string (the grammar the privacy and performance
 * sections established) — the settings sheet renders validation messages
 * verbatim, so this is the sentence a refused save shows.
 */
export function debugConfigRefusalMessage(code: DebugConfigViolationCode): string {
  switch (code) {
    case "debug_redaction_required":
      return "debug_redaction_required — debug.redaction.enabled may not disable the debug redactor: debug output carries context payloads and error messages, so a policy that stops hiding their sensitive values is refused (set it to true)";
  }
}

/**
 * THE CONFIG DOOR TO A DEBUG BOOTSTRAP — the one function a process that
 * resolves the document calls to turn the `debug` section into the base
 * config the debug system is configured from.
 *
 * Enforces the section's safety floor because the file can reach this door
 * without ever passing the write gate: an operator's hand edit is parsed by
 * whatever process reads it, and a debug system must refuse to run weakened
 * rather than emit unredacted — fail closed, the same stance the web bridge
 * takes for the same leaf on its own merged value.
 *
 * DEFAULT-PRESERVING: an absent section resolves to `undefined`, which is the
 * caller's signal to fall back to its own defaults — byte-identical to the
 * bootstrap every process ran before the section was wired. A present section
 * flows through by its own keys: the section's type IS `DebugConfig`, so
 * there is no per-leaf mapping to maintain and a leaf added to the schema
 * flows with no edit here (the section census reds if no reader exists).
 */
export function resolveDebugConfigSection(
  section: DeepReadonly<DebugConfig> | undefined,
): DebugConfig | undefined {
  if (section === undefined) return undefined;
  const violation = debugConfigViolations(section)[0];
  if (violation !== undefined) {
    throw new InputError(debugConfigRefusalMessage(violation), violation);
  }
  // A fresh MUTABLE config from the document's frozen projection: the boot
  // composes overrides over it and the bridge merges it over the defaults,
  // so the caller must be free to build on it without touching the shared
  // cached document. The copy is explicit over every ARRAY leaf — the
  // section's own shape, never a hand-enumerated field map: a leaf added to
  // the schema flows through the spreads below, and a leaf whose readonly
  // array is not copied is a COMPILE error at this return, so the copy
  // cannot drift from the schema quietly.
  return {
    ...section,
    categories: [...section.categories],
    audit: { ...section.audit, categories: [...section.audit.categories] },
    errorHandling: { ...section.errorHandling },
    sinks: { ...section.sinks, enabledSinks: [...section.sinks.enabledSinks] },
    redaction: {
      ...section.redaction,
      additionalSensitiveKeyNames: [...section.redaction.additionalSensitiveKeyNames],
    },
  };
}
