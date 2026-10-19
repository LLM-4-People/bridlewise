/**
 * Central debug, error, and audit system — the single entry point for ALL
 * debug logging, error handling, and audit events across the harness.
 *
 * Per the central-debug contract: "A proper debug/error system must be
 * implemented and enforced everywhere, like the performance module —
 * everything must go through it. When not in debug mode, simply ignore
 * debug. You must test to try to create unhandled/swallowed errors/audit
 * and mechanically fix so it does not happen. All errors, warnings, and
 * audit events go through one centralized system."
 *
 * Design goals:
 * 1. ONE system — `debugLog`, `auditEvent`, `handleError`, and the fixed
 * `reportBestEffortFailure` diagnostic own emission. No `console.log`/`console.error` in production code
 * except inside this module's sinks.
 * 2. Zero overhead when disabled — `debugLog` returns before evaluating
 * its `context` thunk when debug is off. The thunk pattern (passing a
 * function that builds the context object) ensures no string formatting
 * or object allocation happens when the message is a no-op.
 * 3. Audit is the safety floor — `auditEvent` is ALWAYS recorded (when
 * `audit.enabled` is true, independent of the master `enabled` switch)
 * because audit events are security-relevant and must not be silently
 * dropped.
 * 4. Central error classification — `handleError` extracts the typed code,
 * retryable flag, source location, and emits a structured error event
 * plus increments the error-count signal. It does NOT swallow the
 * error: callers decide whether to rethrow, return, or continue.
 * 5. Redaction — context payloads and error messages go through one
 * redactor before any sink sees them. Read what it actually guarantees
 * on `redactValue` before relying on it: a value under a SENSITIVE KEY
 * NAME is dropped whole, and everything else is a noun-level hint and a
 * bound on volume. "Credentials, PII, prompts and file contents never
 * leak" was the old wording here and it was not true of this layer.
 * 6. Sinks are not an extension point — `configureDebugSystem` refuses any
 * destination this module did not construct, and any kind absent from
 * `config.sinks.enabledSinks`.
 *
 * The system is a process-singleton: `configureDebugSystem` is called once at
 * startup (after config load) with the resolved `DebugConfig`. Before
 * configuration, ordinary events are no-ops. Best-effort failure reports use
 * a content-free terminal fallback until configured.
 */

import { extractErrorMessage, extractErrorSourceLocation, isAbortError, HarnessError, SecurityError } from "../../kernel/errors.ts";
/**
 * ⚠ THE CREDENTIAL VOCABULARY IS NOT OWNED HERE, AND THE IMPORT WAS MEASURED
 * BEFORE IT WAS WRITTEN.
 *
 * The note on `redactValue` records that wiring `privacy/redaction-engine.ts`
 * into this module broke 8 of 514 modules at load with a TDZ
 * `ReferenceError`, and that finding stands — that module pulls the whole
 * detector chain into a cycle this file already sits in.
 *
 * `secret-signals.ts` IS NOT THAT MODULE. Its entire import list is
 * `./integrity.ts`, and it is the declared single owner of "is this key name
 * sensitive?" for BOTH repositories (the harness data classifier, the web
 * server's redactor, and the web server's config-write gate all consume
 * `isSensitiveKeyName`). Re-measured for this step with the same instrument
 * and the same predicate — a marker printed AFTER the dynamic import settles,
 * because every child of the broken run EXITED 0 and an `exit != 0` predicate
 * scores them all healthy:
 *
 *   node --experimental-strip-types -e "import(<abs>).then(…).catch(…)"
 *   over `find src -name '*.ts'`, once per module.
 *   • WITHOUT this import: 515 modules, 0 load-threw, rc 0 (unit: MODULES).
 *   • WITH it, and with a MODULE-SCOPE read of the binding (harsher than the
 *     function-scope read the code below actually does): 515 modules,
 *     0 load-threw, rc 0 (unit: MODULES).
 *
 * The instrument was itself witnessed in the same session against a planted
 * TDZ cycle in a temp dir — `LOADTHREW ReferenceError: Cannot access 'A'
 * before initialization` — with an inert healthy module printing `LOADOK`
 * beside it, so the two zeros above are an observation and not a blind scan.
 */
import {
  isSensitiveKeyName,
  normalizeSecretKey,
  SECRET_TEXT_SIGNAL_CATALOG,
  SENSITIVE_KEY_PARTS,
} from "../../privacy/secret-signals.ts";
import { DEBUG_CONFIG_DEFAULTS, type DebugConfig, type DebugLevel, type DebugSinkKind, shouldEmitLevel } from "./debug-config.ts";

/** A debug context payload builder — a thunk so it is only evaluated when the message is emitted. */
export type DebugContextThunk = () => Readonly<Record<string, unknown>>;

/** The severity of a debug message. */
export type DebugMessageLevel = Exclude<DebugLevel, "off">;

/** A structured debug/error/audit event record. */
export interface DebugEvent {
  readonly kind: "debug" | "warn" | "error" | "audit";
  readonly level: DebugMessageLevel;
  readonly category: string;
  readonly message: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly timestamp: number;
  readonly code: string | null;
  readonly source: { readonly functionName: string | null; readonly file: string | null; readonly line: number | null; readonly column: number | null } | null;
}

/** Context passed to `handleError` to identify where the error originated. */
export interface ErrorContext {
  readonly module: string;
  readonly operation: string;
  readonly [key: string]: unknown;
}

/** Process-local diagnostic observations; not proof of durable sink delivery. */
export interface DebugSignals {
  errorCount: number;
  bestEffortFailures: number;
  sinkWriteAttempts: number;
  sinkWriteFailures: number;
  fallbackAttempts: number;
  fallbackFailures: number;
  fallbackReentries: number;
  reportingFailures: number;
  emissionReentries: number;
  patternCompilationFailures: number;
  warnCount: number;
  debugCount: number;
  auditCount: number;
  suppressedByLevel: number;
  suppressedByCategory: number;
  /**
   * ⚠ UNIT: VALUES. Not events. The name says `values` and it now counts
   * values, because the two used to disagree and the disagreement was a false
   * claim about the event.
   *
   * Each increment is one VALUE that was discarded whole because its KEY NAME
   * was sensitive, with a constant written in its place, so no part of that
   * value can have survived. That is the only removal this layer can point at
   * (see the note on `redactValue`).
   *
   * WHAT IT IS NOT, DRIVEN. It used to be `+1 per EVENT in which at least one
   * value was removed`, described as "a SUCCESS CLAIM" about the event — and
   * `debugLog("…", () => ({ apiKey: "drop-me", creds: <SECRET> }))` scored
   * exactly that `+1` with the secret leaving intact in the same context, as
   * did the nested-object, homoglyph-key (`аpiKey`, Cyrillic а) and
   * secret-in-a-log-line variants. Per VALUE every one of those readings is
   * true; per EVENT every one of them is a lie. A count's unit is part of what
   * it claims, and this counter is a claim about VALUES IT DROPPED — never
   * about what else was in the payload beside them.
   *
   * NO ORACLE RE-OBSERVES ANYTHING HERE. The previous wording said each span
   * was "re-observed absent by the canonical oracle"; this file imports the
   * shared secret-signal vocabulary, but no privacy detector or verifier. See the note on
   * `redactValue` for where the canonical engine actually runs and why it is
   * not wired here.
   */
  redactedValues: number;
  /**
   * ⚠ UNIT: PATTERN HITS. One per configured key-name pattern that changed a
   * string's contents, summed over every string in the payload — the same unit
   * as `redactedValues`, so a reader comparing them is comparing like with
   * like.
   *
   * Explicitly NOT a success claim: after this fires the secret may still be in
   * the text in full. It exists because the two facts used to share one
   * counter, and a partial mask reported as a removal is how a whole live key
   * left this module under a green signal.
   */
  maskedWithoutRemoval: number;
}

/**
 * A phantom property whose key is a symbol NOTHING OUTSIDE THIS MODULE CAN
 * NAME. `declare const` means it has no runtime existence at all, so the field
 * costs nothing and appears in no output — its whole job is to make the object
 * literal `{ kind: "console", write(e) { appendFileSync(…) } }` fail to compile
 * as a `DebugSink`.
 */
declare const SINK_SANCTION: unique symbol;

/**
 * Sink interface — a destination for debug events.
 *
 * ⚠ NOT AN EXTENSION POINT, AND IT USED TO BE ONE BY ACCIDENT. This was a bare
 * structural interface (`kind: string` + `write()`), and `configureDebugSystem`
 * accepted `ReadonlyArray<DebugSink>` from any importer with no check at all —
 * so any module in either repository could install a disk-writing destination
 * for every debug, error and audit event in the process, at runtime, by passing
 * an object literal. The allow-list that should have closed that door
 * (`config.sinks.enabledSinks`) was declared in the contract, SET in the
 * shipped `bridlewise.config.json`, and read by nothing.
 *
 * Both halves of the door are now shut, at two different rungs, because each
 * has an escape the other covers:
 *
 *   • RUNG 2 (unrepresentable) — the `SINK_SANCTION` brand. A caller cannot
 *     name the symbol, so a hand-written literal is not assignable and the
 *     compiler refuses it. Its known escape is an object SPREAD, which copies a
 *     brand with no cast (driven in this tree before, and driven again as a
 *     mutation against the tests below).
 *   • RUNG 4 (runtime choke point) — a module-private `WeakSet` of the
 *     instances THIS MODULE constructed. A spread copy is a different object
 *     and is not in it, so the rung-2 escape lands on a refusal.
 *
 * `kind` is `DebugSinkKind`, not `string`: an undeclared destination name is a
 * type error rather than a value the allow-list has to reason about.
 */
export interface DebugSink {
  readonly kind: DebugSinkKind;
  readonly [SINK_SANCTION]: true;
  write(event: DebugEvent): void;
  flush?(): void;
}

/**
 * The instances this module constructed. A `WeakSet` so a sink that goes out of
 * scope is collectable — this must not become a leak of every sink a long
 * process ever built.
 */
const SANCTIONED_SINKS = new WeakSet<object>();

/**
 * Stamp a sink as this module's own. The cast is the ONLY place the brand is
 * applied, and it is three lines from the `WeakSet` that makes it checkable at
 * runtime, so the two cannot drift apart into a brand nobody verifies.
 *
 * FROZEN, because `kind` is `readonly` only to the compiler: a holder of a real
 * sink could otherwise assign `sink.kind = "file"` and carry its `WeakSet`
 * membership past the allow-list on a name it was never admitted under. The
 * engine refuses that assignment instead. The sink's own closed-over state
 * (the collecting sink's event array) is untouched by the freeze.
 */
function sanctionSink<T extends { readonly kind: DebugSinkKind; write(event: DebugEvent): void }>(
  sink: T,
): T & DebugSink {
  const frozen = Object.freeze(sink);
  SANCTIONED_SINKS.add(frozen);
  return frozen as T & DebugSink;
}

// ── Singleton state ──────────────────────────────────────────────────────
// The singleton is module-private. `configureDebugSystem` sets it once at
// startup; all entry points read it through `getSystem`. Before
// configuration, ordinary events are no-ops; optional-operation failure
// reports use the bounded, content-free terminal fallback.

interface DebugSystemInternal {
  config: DebugConfig;
  sinks: ReadonlyArray<DebugSink>;
  signals: DebugSignals;
  auditRingBuffer: DebugEvent[];
  errorDedup: Map<string, number>;
  configured: boolean;
}

function zeroSignals(): DebugSignals {
  return { bestEffortFailures: 0, sinkWriteAttempts: 0, sinkWriteFailures: 0, fallbackAttempts: 0, fallbackFailures: 0, fallbackReentries: 0, reportingFailures: 0, emissionReentries: 0, patternCompilationFailures: 0, errorCount: 0, warnCount: 0, debugCount: 0, auditCount: 0, suppressedByLevel: 0, suppressedByCategory: 0, redactedValues: 0, maskedWithoutRemoval: 0 };
}

/**
 * ⚠ THE UNCONFIGURED SYSTEM IS BUILT ON DEMAND, AND THAT IS A LOAD-ORDER FIX,
 * NOT A STYLE CHOICE.
 *
 * This used to be a module-scope `const NO_OP_SYSTEM = { config:
 * DEBUG_CONFIG_DEFAULTS, … }`, which READ AN IMPORTED BINDING DURING MODULE
 * EVALUATION. `debug-config.ts` imports `deepFreeze` from `integrity.ts`, which
 * reaches `errors.ts`, which imports THIS module — so evaluating
 * `debug-config.ts` first left `DEBUG_CONFIG_DEFAULTS` uninitialised when this
 * line ran.
 *
 * DRIVEN, at the parent commit, with no wiring of any kind:
 *   `node --experimental-strip-types -e "import('src/shared/debug/debug-config.ts')"`
 *   → `ReferenceError: Cannot access 'DEBUG_CONFIG_DEFAULTS' before
 *      initialization`, cycle
 *      `debug-config → integrity → errors → debug-system → debug-config`.
 * Swept over the whole tree — every module under `src/` imported as an ESM
 * entry point in its own process (unit: modules) — that was the ONLY module in
 * 514 whose load threw, and it is this file's doing.
 *
 * It is the SAME DEFECT CLASS `redaction-engine.ts` names in its memoisation
 * note, in the module that note was written from. Reading nothing from an
 * import until a function is actually called takes the cycle's evaluation order
 * out of the critical path: by the time any entry point below is CALLED, every
 * module in the cycle has finished evaluating.
 *
 * A fresh object per reset, not a shared mutable one: the old `NO_OP_SYSTEM`
 * was a single object that `resetDebugSystem` re-pointed at, so any mutation of
 * its signals would have survived every later "reset".
 */
function unconfiguredSystem(): DebugSystemInternal {
  return {
    config: DEBUG_CONFIG_DEFAULTS,
    sinks: [],
    signals: zeroSignals(),
    auditRingBuffer: [],
    errorDedup: new Map(),
    configured: false,
  };
}

let system: DebugSystemInternal | null = null;

function getSystem(): DebugSystemInternal {
  return (system ??= unconfiguredSystem());
}

/**
 * Every sink kind that has an implementation, keyed by the kind it produces.
 *
 * ⚠ THE TYPE IS THE ENFORCEMENT. `Readonly<Record<DebugSinkKind, …>>` is TOTAL
 * over the union `debug-config.ts` declares, so adding a kind to the config
 * contract without writing the sink is a COMPILE ERROR here — which is how
 * `"timeline"` and `"file"` sat in a security-relevant allow-list for as long
 * as they did with no implementation anywhere in either repository.
 */
const SINK_IMPLEMENTATIONS: Readonly<Record<DebugSinkKind, () => DebugSink>> = Object.freeze({
  console: createConsoleSink,
  collecting: createCollectingSink,
});

/**
 * THE ONE DOOR, AND THE REFUSALS THAT MAKE IT ONE.
 *
 * A sink is installed only when all three hold; each rejects a different way of
 * getting a destination into this process, and the message names which:
 *
 *   1. THIS MODULE CONSTRUCTED IT (`SANCTIONED_SINKS`). Defeats the object
 *      literal AND the spread copy of a real sink — the documented escape from
 *      a `unique symbol` brand, which is why the brand alone is not the answer.
 *   2. ITS KIND HAS AN IMPLEMENTATION (`SINK_IMPLEMENTATIONS`). A kind declared
 *      in the contract with nothing behind it is refused rather than silently
 *      producing no output.
 *   3. THE OPERATOR DECLARED IT (`config.sinks.enabledSinks`). Deny by default:
 *      an empty allow-list installs nothing, and a destination nobody wrote
 *      into the config cannot be attached by an importer.
 *
 * A refusal THROWS. It does not drop the sink and carry on: a debug system that
 * quietly discards a destination is the same failure as one that quietly adds
 * one, and both are decided here, once, at startup.
 */
function admitSinks(config: DebugConfig, sinks: ReadonlyArray<DebugSink>): ReadonlyArray<DebugSink> {
  const allowed = config.sinks.enabledSinks;
  for (const sink of sinks) {
    if (!SANCTIONED_SINKS.has(sink)) {
      throw new SecurityError(
        `debug sink of kind "${String((sink as { kind?: unknown }).kind)}" was not constructed by the debug system and cannot be installed`,
        "debug_sink_unsanctioned",
      );
    }
    // THE BACKSTOP THAT SHOULD NEVER FIRE, AND THAT IS THE POINT. While the
    // compiler holds, `SINK_IMPLEMENTATIONS` is total over `DebugSinkKind` and
    // every sanctioned instance is frozen, so no admitted sink can carry a kind
    // with nothing behind it. It stays because "unreachable" is a statement
    // about the code as it is type-checked today, and this is the one place a
    // cast or a future non-total record would surface. It is NOT claimed to be
    // a live guard: the guarantee is the total record above it.
    if (!Object.hasOwn(SINK_IMPLEMENTATIONS, sink.kind)) {
      throw new SecurityError(
        `debug sink kind "${sink.kind}" has no implementation`,
        "debug_sink_unimplemented",
      );
    }
    if (!allowed.includes(sink.kind)) {
      throw new SecurityError(
        `debug sink kind "${sink.kind}" is not in config.sinks.enabledSinks (${allowed.length === 0 ? "empty" : allowed.join(", ")})`,
        "debug_sink_not_enabled",
      );
    }
  }
  return Object.freeze([...sinks]);
}

/**
 * Configure the debug system. Called once at startup after the config is
 * loaded. Replaces the singleton; resets signals and the ring buffer.
 *
 * @throws SecurityError when a sink is not one this module built, has no
 * implementation, or is not named in `config.sinks.enabledSinks`.
 */
export function configureDebugSystem(config: DebugConfig, sinks: ReadonlyArray<DebugSink> = []): void {
  // Admitted BEFORE the singleton moves: a refused sink must leave the previous
  // system exactly as it was, rather than half-installing a new one.
  const admitted = admitSinks(config, sinks);
  system = {
    config: Object.freeze({ ...config }),
    sinks: admitted,
    signals: zeroSignals(),
    auditRingBuffer: [],
    errorDedup: new Map(),
    configured: true,
  };
}

/** Whether a host has configured the system (the web server's bridge, a CLI entry point). */
export function isDebugSystemConfigured(): boolean {
  return system !== null && system.configured;
}

/** Reset the debug system to the unconfigured no-op state (for tests). */
export function resetDebugSystem(): void {
  system = null;
}

/** @returns the live signal counters (a snapshot copy). */
export function getDebugSignals(): DebugSignals {
  return { ...getSystem().signals };
}

/** @returns a snapshot of the audit ring buffer (newest first). */
export function getAuditEvents(): ReadonlyArray<DebugEvent> {
  return [...getSystem().auditRingBuffer];
}

// ── Redaction ────────────────────────────────────────────────────────────

/**
 * ⚠ A REDACTION THAT DID NOT REMOVE THE VALUE MUST NOT BE ABLE TO REPORT SUCCESS.
 *
 * ── WHAT THIS REPLACED, DRIVEN ────────────────────────────────────────────
 *
 * This function used to run the configured KEY-NAME patterns
 * (`[Aa]pi[-_]?[Kk]ey`, `[Tt]oken`, `[Ss]k[-_]`) against string CONTENT, mask
 * whatever they hit, and set `redacted: true` — which the three emitters then
 * counted in `signals.redactedValues`. Three shapes were driven against that
 * arrangement, every one of them with the same key
 * `sk-LIVEKEY-8f31c05a9e27b46d1a08f3c65b92d740` — which is **43 characters**,
 * not the "forty-eight" the note here used to claim:
 *
 *   1. `Incorrect API key provided: <KEY>.`
 *      → `Incorrect API key provided: [REDACTED]LIVEKEY-…`, delta 1.
 *      The words `API key` are NOT matched: `[Aa]pi[-_]?[Kk]ey` cannot match an
 *      uppercase `API` separated by a SPACE. So the only thing that fired was
 *      `[Ss]k[-_]` against the key's own prefix, and 40 of 43 characters
 *      survived. The worked example that used to sit in this comment claimed
 *      `Incorrect [REDACTED] provided:` and DID NOT REPRODUCE — a false
 *      transcript inside the note that exists to state the limit honestly.
 *
 *      ⚠ AND THIS OBSERVATION WAS NEVER CARRIED ACROSS TO THE LIVE MECHANISM,
 *      WHICH IS THE MORE IMPORTANT HALF. "`[Aa]pi[-_]?[Kk]ey` cannot match an
 *      uppercase `API`" is a fact about the PATTERNS, not about the CONTENT
 *      channel this line is describing — and the patterns were also the
 *      KEY-NAME gate, where the same blindness meant `API_KEY`, `TOKEN`,
 *      `PASSWORD`, `SECRET` and every other SCREAMING_SNAKE name passed
 *      through with BOTH COUNTERS AT ZERO. A note that spots a defect in one
 *      channel and does not ask whether the same list is used elsewhere has
 *      found the bug and filed it against the wrong mechanism. Both are fixed
 *      now — the gate by `isSensitiveKeyName`, this channel by the format
 *      catalogue — and the transcript below is re-driven against that code.
 *   2. `retrying <KEY> then <KEY>`
 *      → the SECOND copy came out COMPLETE AND UNMODIFIED, delta 1.
 *      `String.replace` with a non-global regex replaces only the first match,
 *      so a whole live key left this module carrying a success signal.
 *   3. `credential rejected: <shapeless key>`
 *      → `[REDACTED] rejected: <shapeless key>`, delta 1. The NOUN was masked
 *      and the entire key survived.
 *
 * A confidently wrong redaction is harder to distrust than none.
 *
 * ── THE SAME THREE, RE-DRIVEN AGAINST THIS CODE ───────────────────────────
 *
 * A true transcript this time, and the tests below reproduce every line of it:
 *
 *   1. `Incorrect API key provided: <KEY>.`
 *      → `Incorrect API key provided: [REDACTED]LIVEKEY-…`
 *        redactedValues +0, maskedWithoutRemoval +1.
 *   2. `retrying <KEY> then <KEY>`
 *      → `retrying [REDACTED]LIVEKEY-… then [REDACTED]LIVEKEY-…`
 *        BOTH copies are now touched, and redactedValues is still +0.
 *   3. `credential rejected: <shapeless key>`
 *      → `[REDACTED] rejected: <shapeless key>`
 *        redactedValues +0, maskedWithoutRemoval +1.
 *   4. `nothing here matches anything at all 12345`
 *      → unchanged, both counters +0.
 *
 * READ THAT AGAIN: the key is STILL THERE in 1, 2 and 3. What changed is that
 * the run no longer says it removed it. That is the whole fix, and it is
 * deliberately not more than that — see the blocker section below.
 *
 * ── THE INVARIANT, AND WHY IT IS INSTALLED HERE ───────────────────────────
 *
 * `redactValue` is the trunk: `redactContext` and `redactMessageText` are its
 * only callers, and `debugLog`, `auditEvent` and `handleError` reach a sink only
 * through those two. So the rule is installed once, at the single door, instead
 * of at the 80 `handleError` call sites in 41 integration files and the 5 in the
 * web server's router and process-error handlers.
 *
 * THE RULE: `signals.redactedValues` may only count a removal this code can
 * point at. There is exactly one such removal available here — a value dropped
 * whole because its KEY NAME was sensitive, where a constant is written in its
 * place and no part of the value can survive by construction. Everything else
 * this function does is explicitly not a success claim:
 *
 *   • the configured `forbiddenPatterns` run against string CONTENT as a
 *     noun-level HINT and land in `signals.maskedWithoutRemoval` — a different
 *     question with a different name. They are compiled with `g`, so shape 2
 *     (only the first occurrence replaced) cannot recur.
 *   • the length cap is a BOUND ON VOLUME and counts as neither. It used to set
 *     `redacted: true`, so a long innocuous string reported a redaction.
 *
 * ── THE PROPERTY THAT MUST SURVIVE EVERY LATER EDIT ───────────────────────
 *
 * When nothing matches at all, every delta is 0. This redactor does not
 * fabricate success out of nothing and never did; the defect was the opposite
 * one, a partial change reported as a whole one. Both directions are pinned in
 * `test/shared/debug/debug-system.test.ts`, including an INERT control whose
 * whole job is to leave the counters at zero.
 *
 * ── THE BLOCKER WAS RE-JUDGED, AND IS REAL — BUT NOT FOR THE STATED REASON ─
 *
 * The previous note said this module "cannot simply call" the canonical engine
 * (`src/privacy/redaction-engine.ts`) because that file imports `src/errors.ts`,
 * which imports THIS FILE, "so the dependency is a cycle". That reason is wrong:
 * `errors.ts` ↔ `debug-system.ts` is ALREADY a live mutual cycle at the
 * identical edge (`errors.ts:2` imports this module; line 37 imports it back),
 * so "it would be a cycle" describes a shape this codebase already tolerates.
 *
 * The wiring was therefore attempted. Driven under three entry modules — this
 * module's test file, `errors.ts` first, `redaction-engine.ts` first — all three
 * exited 0 with `redactText` live at module evaluation, and the three shapes
 * above came out with the key GONE and the counters honest. That looked like a
 * refutation. It was a probe with the wrong universe.
 *
 * WIDENED TO THE REAL POPULATION — every module under `src/` imported as an ESM
 * entry point in its own process — the static import broke eight of them at
 * module load with `ReferenceError: Cannot access '…' before initialization`: a
 * TDZ break, in the detector every egress path depends on.
 *
 * RE-MEASURED FOR THIS STEP, because the numbers in this note had drifted and
 * one of them was false. Instrument: a walk of `src/**"/"*.ts` driving
 * `node --experimental-strip-types -e "import(<abs path>).then(…).catch(…)"`
 * once per module, rc 0, unit: MODULES. Population **514**, not the 515 this
 * note used to claim.
 *
 *   • WITH THE WIRING (a static `import … from "../../privacy/redaction-engine.ts"`
 *     added here, temporarily): **8 of 514 modules' loads threw** —
 *     `classification-catalog`, `config-contracts`, `evaluation/matrix-generator`,
 *     `filesystem/link-containment`, `privacy/identity-grammars`, `root-policy`,
 *     `shared/debug/debug-config`, `shared/source-scan`.
 *   • WITHOUT IT, at the parent commit: **1 of 514** — `shared/debug/debug-config`,
 *     and that one was THIS FILE'S FAULT (see `unconfiguredSystem`). It is
 *     now 0.
 *
 * ⚠ THE PREDICATE MATTERS AND THE OLD ONE WOULD HAVE REPORTED ZERO. The figure
 * above is "the module's LOAD THREW", read from a marker the child prints after
 * the dynamic import settles. Every one of those eight children EXITED 0 — an
 * `exit != 0` predicate scores all eight as healthy. That is not a hypothetical
 * hole: deferring work off module scope (this file's `unconfiguredSystem`,
 * `redaction-engine.ts`'s memo) is exactly the repair that moves a failure from
 * load time to first call, so the sweep that judges the repair must not be the
 * one that cannot see it.
 *
 * The cause is not this edge. It is a CLASS: modules do work at MODULE SCOPE
 * that reads an imported binding, which makes their evaluation order
 * load-bearing inside a cycle. Two instances are now fixed —
 * `redaction-engine.ts`'s `COMPILED_SIGNALS` memo, and this file's own
 * `NO_OP_SYSTEM`, which was the sole remaining break at the parent commit.
 * `DATA_CLASSIFICATION`'s eager consumers (5 of the 8) and `pii-registry.ts`'s
 * module-scope loop over `IDENTITY_DETECTOR_IDS` (1 of the 8) remain, and every
 * one of those files is outside this step's write scope.
 *
 * So the wiring stays REVERTED and recorded as a task, and this layer stays what
 * its predecessor honestly said it was: a BOUND ON VOLUME and a HINT, never the
 * credential guarantee. The guarantees that are real live at the response egress
 * and at the ledger append, both of which consult the canonical engine — and
 * `benchmark-runner.ts` consults it too, which costs nothing on the same
 * measurement precisely because it is outside the cycle.
 *
 * ── THERE IS NO ORACLE IN THIS FILE, AND THE CONTRACT SAID THERE WAS ──────
 *
 * Both counters used to promise each span was "re-observed absent by the
 * CANONICAL ORACLE". WITNESS, and it is three lines long: this module's entire
 * import list is `errors.ts`, `best-effort.ts`, `debug-config.ts`. No privacy
 * import, no detector, no verifier — residue of the wiring above, left behind in
 * a security control's contract when the wiring was reverted.
 * `verifyRedaction` lives at `src/privacy/redaction-engine.ts` and is called
 * from `src/privacy/file-viewer.ts` and nowhere else. The claim is deleted
 * rather than softened, and `test/shared/debug/debug-contract-honesty.test.ts`
 * fails if it comes back without the import that would make it true.
 *
 * WHAT THIS MEANS FOR A READER OF THE SIGNAL: `redactedValues` is sound but
 * WEAK — it counts values dropped for a sensitive KEY NAME and nothing else. A
 * zero does not mean the payload was clean, and a POSITIVE number does not mean
 * it is clean either; it is a count of what was dropped, not a verdict on what
 * remains. `maskedWithoutRemoval` above zero means a credential word was seen
 * and the value beside it was NOT handled.
 */
interface RedactionOutcome {
  readonly value: unknown;
  /**
   * Whole values discarded because their KEY NAME was sensitive, where nothing
   * of the value can survive because a constant is written in its place. THE
   * ONLY FIELD THAT IS A CLAIM ABOUT A SECRET, and the claim is exactly "this
   * many values were dropped" — never "the payload is now clean".
   *
   * Unit: VALUES DROPPED. One key, one increment, whatever the value was: an
   * array of forty cookies dropped under one sensitive key is 1, not 40,
   * because 1 is the number of things this code decided about.
   *
   * NO ORACLE. This field used to say the spans were "re-observed absent by the
   * oracle". Nothing re-observes them; there is no detector in this module's
   * import list.
   */
  readonly removedSpans: number;
  /**
   * A key-NAME word masked INSIDE a larger string. Not a claim that any secret
   * left the text — after this fires the value may still be there in full, which
   * is exactly the defect above. Unit: patterns that changed the string.
   */
  readonly maskedWithoutRemoval: number;
}

const NOTHING_HAPPENED = { removedSpans: 0, maskedWithoutRemoval: 0 } as const;

/**
 * `matchesAnywhere` USED TO LIVE HERE, and its disappearance is the shape of
 * the fix rather than a tidy-up. It existed because the key-name gate ran
 * shared `g`-flagged regexes against key names, and a `g` regex carries
 * `lastIndex` between calls — so the second key asked of one pattern answered
 * from the first key's cursor. The gate no longer uses regexes at all: it
 * asks `isSensitiveKeyName`, which compares normalised strings and has no
 * cursor to desynchronise. The only surviving regex use is `redactString`,
 * which resets `lastIndex` at its single call site.
 */

/**
 * ⚠ THE SENSITIVE-KEY DECISION TAKES THE KEY AND NOTHING ELSE, AND THAT
 * SIGNATURE IS THE FIX.
 *
 * The drop used to be written inline as
 * `if (typeof v === "string" && patterns.some(p => matchesAnywhere(p, k)))`,
 * under a comment promising the value was discarded "whatever it looks like
 * (defence in depth)". The `typeof` half made that false for every shape Node
 * actually produces. DRIVEN at the parent commit, one `debugLog` each, deltas
 * read from `getDebugSignals()`:
 *
 *   {headers:{authorization:["Bearer <SECRET>"]}}  → the ARRAY was recursed
 *       into and content-masked to `["[REDACTED] <SECRET>"]`; SECRET INTACT,
 *       redactedValues +0, maskedWithoutRemoval +1.
 *   {apiKey:{v:"<SECRET>"}}                        → SECRET INTACT, +0 / +0.
 *   {password: 12345678901234}                     → SECRET INTACT, +0 / +0.
 *   {token:"<SECRET>"} (the string control)        → gone, +1 / +0.
 *
 * These are not contrived shapes: Node's `IncomingHttpHeaders` types a repeated
 * header as `string[]`, and `set-cookie` is ALWAYS `string[]`.
 *
 * A value-shape gate cannot be written in this function, because the value is
 * not in scope here — reintroducing one means widening this signature, which is
 * a deliberate edit to a function whose whole documented purpose is that it
 * cannot see the value. That is as far up the ladder as this goes: the caller
 * still has to honour the answer (rung 4, one door), but the class of defect —
 * "the removal was conditioned on what the value looked like" — is no longer
 * expressible at the point the decision is made.
 *
 * ── AND THE LIST ITSELF WAS THE LARGER DEFECT. IT IS GONE. ────────────────
 *
 * The note that stood here said `{headers:{"set-cookie":[…]}}` survived
 * because `set-cookie` matched none of the eight configured
 * `forbiddenPatterns`, called that "the LIST, not the gate", and pinned it as
 * a stated limit. The diagnosis was right and the remedy was too small: a
 * hand-maintained list IS the defect (§31b), and the same list had a second
 * hole nobody had characterised.
 *
 * DRIVEN AT THE PARENT COMMIT, one `debugLog` per key, an INERT canary
 * (a value matching no pattern, proved unchanged under a neutral key first —
 * the obvious canary `sk-LIVEKEY-…` matches `[Ss]k[-_]` ITSELF and a scan for
 * it reads "absent" when only its prefix was masked), deltas from
 * `getDebugSignals()`, presence by DEEP REACHABILITY SCAN and never
 * `JSON.stringify`:
 *
 *   • 72 key names driven → 50 SURVIVED, 22 dropped (unit: KEYS).
 *   • Every one of `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, `DATABASE_URL`,
 *     `API_KEY`, `STRIPE_SECRET_KEY`, `OPENAI_API_KEY`, `APIKEY`, `TOKEN`,
 *     `PASSWORD`, `SECRET`, `AUTHORIZATION`, `CREDENTIAL`, `BEARER`, `SK_`
 *     reached the sink verbatim at +0 / +0 — 14 of 14. `[Ss]ecret` cannot
 *     match `SECRET`; the case fold was on the first letter only, so the
 *     whole SCREAMING_SNAKE convention was invisible and a `process.env`
 *     snapshot is the commonest debug payload there is.
 *
 * THE GATE NOW ASKS THE DECLARED OWNER. `isSensitiveKeyName` lives in
 * `src/secret-signals.ts` and already answers this exact question for the
 * harness data classifier, the web server's redactor, and the web server's
 * config-write gate. It compares NFKC-normalised, lower-cased,
 * separator-stripped forms, so `SECRET`, `secret`, `Secret`, `secret_key` and
 * `SECRET-KEY` are one input to it — CASING IS NORMALISED AWAY BEFORE THE
 * COMPARISON, which is why "a matcher that only sees one casing" is no longer
 * a state this code can be in. `set-cookie` normalises to `setcookie`, which
 * contains `cookie`, which is in `SENSITIVE_KEY_PARTS`: the pinned limit is
 * now a pinned FIX, and the test that recorded it asserts the drop.
 *
 * ONE ADDITION SERVES FOUR CONSUMERS. A name added to `SENSITIVE_KEY_PARTS`
 * covers this redactor, the classifier and both web-server gates at once;
 * a name added to `bridlewise.config.json` covers only this deployment.
 * That is the whole reason the vocabulary is not owned here.
 *
 * @param key the property name as written; normalisation is the owner's job.
 * @param extraNames deployment-specific additions, already normalised.
 */
function isSensitiveKey(key: string, extraNames: ReadonlyArray<string>): boolean {
  if (isSensitiveKeyName(key)) return true;
  if (extraNames.length === 0) return false;
  const normalized = normalizeSecretKey(key);
  return extraNames.some((name) => normalized.includes(name));
}

/**
 * ⚠ THE CONTENT HINT NOW MATCHES CREDENTIAL FORMATS, NOT CREDENTIAL NOUNS.
 *
 * This used to run the configured KEY-NAME patterns against string CONTENT.
 * That is a category error with a measured cost: the patterns describe what a
 * secret is CALLED, so on `Incorrect API key provided: sk-LIVEKEY-<40 more>`
 * the only thing that fired was `[Ss]k[-_]` against the key's own prefix and
 * 40 of 43 characters of a live credential survived — under a counter that
 * had, before the previous step, called that a successful redaction.
 *
 * It now uses `SECRET_TEXT_SIGNAL_CATALOG` from `src/secret-signals.ts` — the
 * same value-FORMAT vocabulary the canonical detector uses (`AKIA…`,
 * `sk-`/`ghp_`/`github_pat_` prefixes with a 20+ character tail, `Bearer …`,
 * PEM `-----BEGIN … PRIVATE KEY-----`, `secret = <value>` assignments). When
 * one of those fires it has matched the CREDENTIAL MATERIAL, not the noun
 * beside it, so the whole matched span is what gets replaced.
 *
 * IT IS STILL NOT A REMOVAL CLAIM, and the counter still says so. A format
 * catalogue is a recogniser, not a proof of absence: a credential in a shape
 * no signal describes passes through untouched and this function cannot know
 * it did. `maskedWithoutRemoval` remains the only counter reachable from
 * here — see the note on `redactValue` for why `redactedValues` may only ever
 * count a whole value dropped for its key name.
 */
function redactString(value: string, maxLen: number, patterns: ReadonlyArray<RegExp>): RedactionOutcome {
  let result = value;
  let maskedWithoutRemoval = 0;

  // Global, so every occurrence is masked rather than only the first: a second
  // copy of the same key in one string used to come out whole while the run
  // reported a redaction. `compileContentSignals` owns the flags.
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const next = result.replace(pattern, "[REDACTED]");
    if (next !== result) {
      result = next;
      maskedWithoutRemoval++;
    }
  }

  // A bound on VOLUME. Neither a removal nor a mask, and counted as neither —
  // it used to set `redacted: true`, which meant a long innocuous string
  // reported a successful redaction.
  if (result.length > maxLen) result = result.slice(0, maxLen) + "...[truncated]";

  return { value: result, removedSpans: 0, maskedWithoutRemoval };
}

/**
 * ⚠ THIS FUNCTION MUST BE TOTAL OVER ITS INPUT, AND IT WAS NOT.
 *
 * A SECURITY CONTROL THAT THROWS IS AN AVAILABILITY DEFECT. `handleError` is
 * installed as the `uncaughtException` handler, so a throw raised here — from
 * inside the redactor, while handling the error that was already going
 * wrong — is PROCESS-FATAL. DRIVEN at the parent commit, one `debugLog` each:
 *
 *   {note, self: <itself>}            → RangeError: Maximum call stack size exceeded
 *   {note, get boom(){throw}}         → Error: getter exploded (escaped verbatim)
 *   60,000-deep nesting               → RangeError: Maximum call stack size exceeded
 *
 * All three now return a value. Three mechanisms, each VISIBLE in the output
 * rather than silent, because "the redactor refused" and "there was nothing
 * there" must not look the same to a reader:
 *
 *   • a cycle       → `[CIRCULAR]`      (an `ancestors` set, not a global
 *                                        `seen` — a DAG that legitimately
 *                                        repeats a node is not a cycle, and a
 *                                        global set would silently blank the
 *                                        second reference)
 *   • past depth    → `[DEPTH-LIMIT]`   (`redaction.maxContextDepth`)
 *   • a throwing read → `[UNREADABLE]`  (per PROPERTY, so one hostile getter
 *                                        cannot cost the whole payload)
 *
 * ── WHAT WAS SILENTLY DESTROYED, AND WHAT NOW SURVIVES REDACTED ───────────
 *
 * Everything that was not a string, array, or plain object fell through to a
 * bare `return { value }`, and every sink that serialises then dropped it:
 * DRIVEN, `Map`/`Set`/`Error` values reached the sink as `{}`. That is SAFE
 * and it is TOTAL DATA LOSS — an `Error` in a debug payload became an empty
 * object, which is the single least useful thing a debugger can be handed.
 *
 * DECIDED, and the criterion is whether the shape can CARRY a secret in a
 * place the walk can reach:
 *
 *   PRESERVED-BUT-REDACTED — they carry payload, and the walk reaches all of
 *   it, so the key gate and the content hint apply as they would anywhere:
 *     `Map`   → entries walked; a sensitive KEY drops its value, exactly as
 *               in an object. Non-string keys are `String(k)`-named.
 *     `Set`   → members walked as an array.
 *     `Error` → `{name, message, stack}`, all three string-redacted. The
 *               message is where a foreign endpoint's wording arrives and is
 *               the likeliest credential carrier in the whole payload.
 *     `Date`  → ISO string. Cannot carry a secret; total loss was pure cost.
 *     `bigint`/`symbol` → stringified, then string-redacted. A `Symbol` value
 *               was reaching the sink UNREDACTED with its description intact
 *               (driven: `$.context.sym` still held its text), which is a
 *               real if narrow channel.
 *
 *   STILL DROPPED, DELIBERATELY:
 *     functions            → `[FUNCTION]`. A closure can hold a credential in
 *                            a scope no walk can enter, so there is nothing
 *                            honest to redact; the reference itself used to
 *                            pass through to non-serialising sinks.
 *     NON-ENUMERABLE and symbol-KEYED properties → still not enumerated.
 *                            `Object.keys` semantics are unchanged here. They
 *                            are not debug payload in practice, and widening
 *                            the walk widens the surface this function has to
 *                            stay total over. RESIDUAL, STATED: a secret
 *                            stored under a non-enumerable property is not
 *                            redacted and not emitted — it is dropped, which
 *                            is the safe direction but is still a silent one.
 */
function redactValue(
  value: unknown,
  maxLen: number,
  patterns: ReadonlyArray<RegExp>,
  redaction: DebugConfig["redaction"],
  extraNames: ReadonlyArray<string>,
  depth: number,
  ancestors: ReadonlySet<object>,
): RedactionOutcome {
  if (!redaction.enabled) return { value, ...NOTHING_HAPPENED };
  if (typeof value === "string") return redactString(value, maxLen, patterns);
  if (typeof value === "function") return { value: "[FUNCTION]", ...NOTHING_HAPPENED };
  if (typeof value === "bigint" || typeof value === "symbol") {
    return redactString(String(value), maxLen, patterns);
  }
  if (value === null || typeof value !== "object") return { value, ...NOTHING_HAPPENED };

  const object = value as object;
  if (ancestors.has(object)) return { value: "[CIRCULAR]", ...NOTHING_HAPPENED };
  if (depth >= redaction.maxContextDepth) return { value: "[DEPTH-LIMIT]", ...NOTHING_HAPPENED };
  const nextAncestors = new Set(ancestors).add(object);

  let removedSpans = 0;
  let maskedWithoutRemoval = 0;
  /** Walk a child, accumulating both counters. Never throws: see `readable`. */
  const walk = (v: unknown): unknown => {
    const r = redactValue(v, maxLen, patterns, redaction, extraNames, depth + 1, nextAncestors);
    removedSpans += r.removedSpans;
    maskedWithoutRemoval += r.maskedWithoutRemoval;
    return r.value;
  };
  /**
   * A property read can execute arbitrary user code (a getter, a Proxy trap).
   * Bounded to ONE property so a single hostile accessor costs one field and
   * not the event. `bestEffort` is deliberately NOT used: it writes to
   * `console.warn`, and a payload with many throwing getters would turn one
   * debug call into unbounded console output.
   */
  const readable = (read: () => unknown): unknown => {
    try { return read(); } catch { return "[UNREADABLE]"; }
  };

  if (value instanceof Date) {
    const iso = readable(() => value.toISOString());
    return { value: iso, removedSpans, maskedWithoutRemoval };
  }
  if (value instanceof Error) {
    const out = {
      name: walk(readable(() => value.name)),
      message: walk(readable(() => value.message)),
      stack: walk(readable(() => value.stack)),
    };
    return { value: out, removedSpans, maskedWithoutRemoval };
  }
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    const entries = readable(() => [...value.entries()]);
    if (!Array.isArray(entries)) return { value: entries, removedSpans, maskedWithoutRemoval };
    for (const entry of entries as ReadonlyArray<readonly [unknown, unknown]>) {
      const k = String(readable(() => String(entry[0])));
      if (isSensitiveKey(k, extraNames)) { out[k] = "[REDACTED]"; removedSpans++; continue; }
      out[k] = walk(entry[1]);
    }
    return { value: out, removedSpans, maskedWithoutRemoval };
  }
  if (value instanceof Set) {
    const members = readable(() => [...value.values()]);
    if (!Array.isArray(members)) return { value: members, removedSpans, maskedWithoutRemoval };
    return { value: members.map(walk), removedSpans, maskedWithoutRemoval };
  }
  if (Array.isArray(value)) {
    const mapped = value.map((_unused, index) => walk(readable(() => value[index])));
    return { value: mapped, removedSpans, maskedWithoutRemoval };
  }

  const out: Record<string, unknown> = {};
  const keys = readable(() => Object.keys(object));
  if (!Array.isArray(keys)) return { value: "[UNREADABLE]", removedSpans, maskedWithoutRemoval };
  for (const k of keys as readonly string[]) {
    // Key-based redaction: a sensitive KEY NAME discards the whole value
    // whatever it looks like — string, array, object, number, anything. This
    // one IS a removal and is derivable without a detector: the value is not
    // inspected, not read at all, not recursed into and not partially
    // rewritten; a constant is written in its place, so no part of it can
    // reach the output. Note the value is not even READ here — a sensitive
    // key whose getter throws costs nothing, because the decision never needed
    // the value. See `isSensitiveKey` for the shapes that leaked while it did.
    if (isSensitiveKey(k, extraNames)) {
      out[k] = "[REDACTED]";
      removedSpans++;
      continue;
    }
    out[k] = walk(readable(() => (object as Record<string, unknown>)[k]));
  }
  return { value: out, removedSpans, maskedWithoutRemoval };
}

/**
 * ⚠ THE FLAGS ARE OWNED HERE, AND THAT IS THE POINT OF COMPILING AT ALL.
 *
 * These are derived from `SECRET_TEXT_SIGNAL_CATALOG`, not written here and
 * not read from config. The catalogue's own regexes are single-match
 * (`String.replace` with a non-global regex rewrites only the FIRST
 * occurrence — a second copy of the same credential in one string came out
 * whole while the run reported a redaction), so each is recompiled from its
 * `source` with flags this code chooses: `g` always, `u` always, and `i`
 * always.
 *
 * `i` IS THE FIX FOR THE FATAL, MADE STRUCTURAL. The defect was a config
 * field of regex sources compiled WITHOUT `i` and hand-case-folded on the
 * first letter (`[Ss]ecret`), so `SECRET` matched nothing. Config no longer
 * carries patterns, and the only place a pattern is now built adds `i`
 * unconditionally — there is no code path that produces a case-sensitive
 * matcher, and no config value that could ask for one.
 *
 * A pattern that fails to recompile is dropped once, loudly, rather than
 * throwing from inside the redactor: turning a bad pattern into a failure of
 * the thing protecting the log is the defect this guards against.
 */
let contentSignalPatterns: readonly RegExp[] | undefined;

/**
 * ⚠ LAZY, AND THE FIRST DRAFT OF THIS WAS A MODULE-SCOPE IIFE THAT BROKE THE
 * TREE. THE DEFERRAL IS THE FIX, NOT A STYLE CHOICE.
 *
 * Written as `const CONTENT_SIGNAL_PATTERNS = (() => { … })()`, this read
 * `SECRET_TEXT_SIGNAL_CATALOG` AT MODULE SCOPE — which is precisely the defect
 * class the note on `redactValue` describes: "modules do work at MODULE SCOPE
 * that reads an imported binding, which makes their evaluation order
 * load-bearing inside a cycle."
 *
 * The cycle is real and unavoidable:
 *   secret-signals.ts → integrity.ts → errors.ts → debug-system.ts → secret-signals.ts
 *
 * When an entry point reaches `secret-signals.ts` FIRST, its exports are still
 * in TDZ by the time this module evaluates, and the IIFE threw
 * `ReferenceError: Cannot access 'SECRET_TEXT_SIGNAL_CATALOG' before
 * initialization`. Every consumer of `secret-signals.ts` died with it —
 * measured: all 14 tests in `test/secret-signals.test.ts` silently stopped
 * being ENQUEUED, so the suite reported `failCount: 0` over a denominator that
 * had quietly shrunk by 14.
 *
 * ⚠ AND THE SWEEP THAT CLEARED THE IMPORT DID NOT SEE IT, BECAUSE ITS
 * POPULATION WAS THE WRONG UNIVERSE. That sweep imported every module under
 * `src/` as an entry point and reported 515 of 515 loading. It never used a
 * module OUTSIDE `src/` as the entry, and the breaking order is exactly the one
 * a `test/secret-signals.test.ts` produces: reach `secret-signals.ts` before
 * `debug-system.ts`. A 100% green sweep over the wrong entry set is not
 * evidence about the entry set that matters.
 *
 * Computed once on first use and memoised. Nothing here reads an imported
 * binding until a redaction actually runs, by which point every module in the
 * cycle has finished evaluating.
 */
function compileContentSignal(source: string): RegExp | undefined {
  try {
    return new RegExp(source, "giu");
  } catch {
    getSystem().signals.patternCompilationFailures++;
    return undefined;
  }
}

function compileContentSignalPatterns(): readonly RegExp[] {
  if (contentSignalPatterns !== undefined) return contentSignalPatterns;
  const patterns: RegExp[] = [];
  let failed = false;

  // (a) VALUE FORMATS — these match the credential MATERIAL, so replacing the
  // matched span removes the credential from the string. This is what fixes
  // "40 of 43 characters of a live key survived".
  for (const signal of SECRET_TEXT_SIGNAL_CATALOG) {
    const pattern = compileContentSignal(signal.classification.source);
    if (pattern === undefined) failed = true;
    else patterns.push(pattern);
  }

  // (b) CREDENTIAL NOUNS — the same `SENSITIVE_KEY_PARTS` the key gate uses,
  // as literal words in prose. KEPT DELIBERATELY when (a) was added, because
  // the two answer different questions and the second is the only one that
  // speaks about a SHAPELESS secret: `credential rejected: Zq7Kd2Mn…` matches
  // no format on earth, and without this the payload would reach an operator
  // reading exactly like an inert one. A noun hit means "a credential word was
  // here and the value beside it was NOT handled" — which is why it can only
  // ever reach `maskedWithoutRemoval`, never `redactedValues`.
  //
  // Escaped, because `additionalSensitiveKeyNames` may contain `.` and `-`;
  // and `giu` because THE CODE OWNS THE FLAGS. The old list was config-supplied
  // regex sources compiled without `i`, which is the FATAL this file exists to
  // have fixed — `[Ss]ecret` could not match `SECRET`.
  for (const part of SENSITIVE_KEY_PARTS) {
    patterns.push(new RegExp(part.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&"), "giu"));
  }

  if (failed) terminalFallback();
  contentSignalPatterns = Object.freeze(patterns);
  return contentSignalPatterns;
}

/**
 * The deployment-specific key names, normalised once and cached against the
 * array they came from. Normalising per event on a hot path would repeat a
 * pure computation over a value that only changes when the config does.
 *
 * Empty entries are dropped after normalisation: `normalizeSecretKey("--")`
 * is `""`, and `"".includes("")` is TRUE FOR EVERY KEY — a single punctuation
 * name would have made every key in every payload sensitive. The schema's
 * `.regex` already requires a leading letter or digit, so this is the second
 * of two independent guards, not the only one.
 */
let normalizedExtras: { source: readonly string[]; names: readonly string[] } | undefined;

function extraSensitiveNames(sources: readonly string[]): readonly string[] {
  if (normalizedExtras !== undefined && normalizedExtras.source === sources) {
    return normalizedExtras.names;
  }
  const names = Object.freeze(sources.map(normalizeSecretKey).filter((n) => n.length > 0));
  normalizedExtras = { source: sources, names };
  return names;
}

/**
 * A shallow copy that cannot throw, for the one place a payload is
 * materialised BEFORE the redactor's own guarded walk begins: an object spread
 * eagerly invokes every getter, and `handleError` runs on the
 * `uncaughtException` path where a throw is process-fatal.
 *
 * Marked `[UNREADABLE]` per property, the same marker the walk uses, so the
 * two guards do not disagree about what a hostile accessor looks like.
 */
function safeShallowCopy(source: Readonly<Record<string, unknown>>): Record<string, unknown> {
  // The read is a FUNCTION returning a sentinel rather than a `catch` that
  // assigns one, and that is the no-swallowed-errors rule being satisfied
  // rather than worked around: the failure becomes this function's return
  // value, which the caller then writes into the payload where a reader sees
  // it. `console.warn` is the wrong destination here — a payload with many
  // hostile accessors would turn one debug call into unbounded console output —
  // and `handleError` is worse, because it would re-enter the system from
  // inside its own redaction step. Identical in shape to `readable` in
  // `redactValue`, deliberately, so the two guards cannot disagree.
  const readOne = (key: string): unknown => {
    try { return source[key]; } catch { return "[UNREADABLE]"; }
  };
  const out: Record<string, unknown> = {};
  let keys: readonly string[];
  try { keys = Object.keys(source); } catch { return out; }
  for (const key of keys) out[key] = readOne(key);
  return out;
}

function redactContext(context: Readonly<Record<string, unknown>>): { context: Readonly<Record<string, unknown>>; removedSpans: number; maskedWithoutRemoval: number } {
  const cfg = getSystem().config.redaction;
  if (!cfg.enabled) return { context, ...NOTHING_HAPPENED };
  const result = redactValue(
    context,
    cfg.maxContextValueLength,
    compileContentSignalPatterns(),
    cfg,
    extraSensitiveNames(cfg.additionalSensitiveKeyNames),
    0,
    new Set(),
  );
  return {
    context: result.value as Readonly<Record<string, unknown>>,
    removedSpans: result.removedSpans,
    maskedWithoutRemoval: result.maskedWithoutRemoval,
  };
}

/**
 * THE MESSAGE IS PART OF THE EVENT, AND IT WAS THE ONE PART NOTHING TOUCHED.
 *
 * `handleError` redacted `context` and then wrote `extractErrorMessage(error)`
 * into `event.message` verbatim. Driven with a credential this process holds:
 * the same provider error reached the sink MASKED through the `context` of a
 * `debugLog` call and BYTE-IDENTICAL through the `message` of a `handleError`
 * call, in the same run, from the same string. The errors most likely to carry a
 * credential are exactly the ones a FOREIGN endpoint worded, and `handleError`
 * is where those arrive.
 *
 * Redacted through the SAME `redactValue` the context uses, not a second rule:
 * one mechanism, so the message and the context cannot come to disagree about
 * what a secret is. What that mechanism can and cannot do is a separate and
 * larger question — see the note on `redactValue`.
 */
function redactMessageText(message: string): { message: string; removedSpans: number; maskedWithoutRemoval: number } {
  const cfg = getSystem().config.redaction;
  if (!cfg.enabled) return { message, ...NOTHING_HAPPENED };
  const result = redactValue(
    message,
    cfg.maxContextValueLength,
    compileContentSignalPatterns(),
    cfg,
    extraSensitiveNames(cfg.additionalSensitiveKeyNames),
    0,
    new Set(),
  );
  return {
    message: typeof result.value === "string" ? result.value : message,
    removedSpans: result.removedSpans,
    maskedWithoutRemoval: result.maskedWithoutRemoval,
  };
}

/**
 * ⚠ THE ONE PLACE THE REDACTION COUNTERS MOVE.
 *
 * `debugLog`, `auditEvent` and `handleError` each used to write this arithmetic
 * out by hand, which is three copies of a rule about UNITS — and the defect
 * being repaired here was exactly a unit: `if (n > 0) counter++` per EVENT,
 * under a docstring calling itself a success claim, while the thing counted is
 * per VALUE. Three hand-written copies is three chances to reintroduce it, and a
 * fourth emitter would be a fourth. The signals are only ever moved through
 * here, so the unit is decided once.
 *
 * VARIADIC because `handleError` redacts TWO channels — the context and the
 * message — and their outcomes must sum rather than each decide independently.
 */
function recordRedactionOutcomes(
  signals: DebugSignals,
  ...outcomes: ReadonlyArray<{ readonly removedSpans: number; readonly maskedWithoutRemoval: number }>
): void {
  for (const outcome of outcomes) {
    signals.redactedValues += outcome.removedSpans;
    signals.maskedWithoutRemoval += outcome.maskedWithoutRemoval;
  }
}

// ── Event emission ───────────────────────────────────────────────────────

// No caller data, thrown value, stack formatter, or sink name reaches this
// final destination. Node console can swallow write errors: these counters
// describe attempts and synchronously observed failures, never durability.
let fallbackActive = false;
function terminalFallback(): void {
  const signals = getSystem().signals;
  if (fallbackActive) {
    signals.fallbackReentries++;
    return;
  }
  fallbackActive = true;
  signals.fallbackAttempts++;
  try {
    console.warn("[debug] diagnostic unavailable");
  } catch {
    signals.fallbackFailures++;
    return;
  } finally {
    fallbackActive = false;
  }
}

function writeSink(sink: DebugSink, event: DebugEvent): boolean {
  const signals = getSystem().signals;
  signals.sinkWriteAttempts++;
  try {
    sink.write(event);
    return true;
  } catch {
    signals.sinkWriteFailures++;
    return false;
  }
}

let emitting = false;
let reentrantEmission = false;
function emit(event: DebugEvent): void {
  if (emitting) {
    getSystem().signals.emissionReentries++;
    reentrantEmission = true;
    return;
  }
  emitting = true;
  reentrantEmission = false;
  let failed = false;
  try {
    for (const sink of getSystem().sinks) {
      if (!writeSink(sink, event)) failed = true;
    }
  } finally {
    emitting = false;
  }
  if (failed || reentrantEmission) terminalFallback();
}

function pushAuditRing(event: DebugEvent): void {
  const sys = getSystem();
  const buf = sys.auditRingBuffer;
  buf.unshift(event);
  const max = sys.config.audit.maxRetainedEvents;
  if (buf.length > max) {
    buf.length = max;
  }
}

// ── debugLog: zero-overhead when disabled ────────────────────────────────

/**
 * Emit a debug message. The `context` argument is a THUNK (zero-argument
 * function) so it is only evaluated when the message is actually emitted.
 * When debug is disabled, the level is below the configured floor, or the
 * category is not in the allow-list, this function returns immediately
 * WITHOUT calling `context` — zero overhead.
 *
 * @param category Debug category (must be in `config.categories` to emit).
 * @param level Message severity (`error`/`warn`/`info`/`debug`/`trace`).
 * @param message Human-readable message.
 * @param context Optional thunk building the context payload. Only called when emitting.
 */
export function debugLog(
  category: string,
  level: DebugMessageLevel,
  message: string,
  context?: DebugContextThunk,
): void {
  const s = getSystem();
  if (!s.configured || !s.config.enabled) return;
  if (!shouldEmitLevel(level, s.config.level)) {
    s.signals.suppressedByLevel++;
    return;
  }
  if (!s.config.categories.includes(category)) {
    s.signals.suppressedByCategory++;
    return;
  }
  const rawContext = context ? context() : {};
  const { context: redactedContext, removedSpans, maskedWithoutRemoval } = redactContext(rawContext);
  recordRedactionOutcomes(s.signals, { removedSpans, maskedWithoutRemoval });
  const event: DebugEvent = {
    kind: level === "error" ? "error" : level === "warn" ? "warn" : "debug",
    level,
    category,
    message,
    context: redactedContext,
    timestamp: Date.now(),
    code: null,
    source: null,
  };
  s.signals.debugCount++;
  if (level === "warn") s.signals.warnCount++;
  emit(event);
}

// ── auditEvent: always recorded (safety floor) ────────────────────────────

/**
 * Record an audit event. Audit events are the safety floor: they are
 * recorded when `config.audit.enabled` is true, INDEPENDENT of the master
 * `enabled` switch. This ensures security-relevant events are never
 * silently dropped just because debug logging is off.
 *
 * @param type Audit event type (e.g. "config.loaded", "auth.login", "tool.dispatch").
 * @param data Structured audit payload (redacted through the redaction policy).
 */
export function auditEvent(type: string, data: Readonly<Record<string, unknown>> = {}): void {
  const s = getSystem();
  if (!s.configured || !s.config.audit.enabled) return;
  if (s.config.audit.categories.length > 0 && !s.config.audit.categories.includes(type)) return;
  const { context: redactedData, removedSpans, maskedWithoutRemoval } = redactContext(data);
  recordRedactionOutcomes(s.signals, { removedSpans, maskedWithoutRemoval });
  const event: DebugEvent = {
    kind: "audit",
    level: "info",
    category: type,
    message: `audit:${type}`,
    context: redactedData,
    timestamp: Date.now(),
    code: null,
    source: null,
  };
  s.signals.auditCount++;
  pushAuditRing(event);
  emit(event);
}

// ── handleError: central error handler ───────────────────────────────────

function admitErrorReport(code: string): boolean {
  const s = getSystem();
  // Deduplication
  if (s.config.errorHandling.reportingPolicy === "deduplicated") {
    const now = Date.now();
    const last = s.errorDedup.get(code);
    if (last !== undefined && now - last < s.config.errorHandling.dedupWindowMs) {
      s.signals.errorCount++;
      s.signals.suppressedByLevel++;
      return false;
    }
    s.errorDedup.set(code, now);
  }

  // Sampling
  if (s.config.errorHandling.reportingPolicy === "sampled" && s.config.errorHandling.samplingRate < 1) {
    if (Math.random() >= s.config.errorHandling.samplingRate) {
      s.signals.errorCount++;
      return false;
    }
  }

  return true;
}

function emitErrorReport(event: DebugEvent): void {
  getSystem().signals.errorCount++;
  emit(event);
}

/**
 * A content-free report for a failed optional operation. Deliberately takes
 * no error, label, or callback and promises no caller-level attribution.
 * Configured reports share the central error reporting policy; before
 * configuration the terminal fallback remains observable. Empty configured
 * sinks intentionally retain counters only. No stack is captured, even on
 * failure, so Error.prepareStackTrace cannot become another data channel.
 */
export function reportBestEffortFailure(): void {
  const s = getSystem();
  s.signals.bestEffortFailures++;
  if (!s.configured || fallbackActive) {
    terminalFallback();
    return;
  }
  try {
    if (!admitErrorReport("best_effort_failed")) return;
    emitErrorReport({
      kind: "error", level: "error", category: "best-effort",
      message: "An optional operation failed", context: { retryable: false },
      timestamp: Date.now(), code: "best_effort_failed", source: null,
    });
  } catch {
    s.signals.reportingFailures++;
    terminalFallback();
    return;
  }
}

/**
 * Central error handler. Extracts the typed error code, retryable flag,
 * source location, and emits a structured error event. Increments the
 * error-count signal. Does NOT swallow the error: the caller decides
 * whether to rethrow, return, or continue.
 *
 * Per the central-debug contract: every catch block must call `handleError` (or
 * `bestEffort`/`bestEffortAsync`) or rethrow as a typed error. Catch blocks
 * that silently ignore errors are prohibited and mechanically detected by
 * the `no-unhandled-errors` prevention test.
 *
 * Deduplication: when `errorHandling.reportingPolicy` is `deduplicated`,
 * the same error code within `dedupWindowMs` is suppressed (counted but
 * not re-emitted) to prevent log flooding.
 *
 * @param error The caught error (typed `HarnessError` or unknown).
 * @param context Where the error occurred (module + operation + extra fields).
 */
export function handleError(error: unknown, context: ErrorContext): void {
  const s = getSystem();
  if (!s.configured) return;
  const code = error instanceof HarnessError ? error.code : "internal_error";
  const retryable = error instanceof HarnessError ? error.retryable : false;
  // Abort errors are expected (cancellation), not real failures: classify
  // and count them but never emit at `error` level (they are `info`).
  const isAbort = isAbortError(error);
  const level: DebugMessageLevel = isAbort ? "info" : "error";

  if (!admitErrorReport(code)) return;

  const source = extractErrorSourceLocation(error);
  // ⚠ THE SPREAD IS AN EAGER READ OF EVERY PROPERTY, AND IT HAPPENS BEFORE
  // THE REDACTOR EVER SEES THE OBJECT.
  //
  // This read `{ ...context, retryable }`. Making `redactValue` total over its
  // input did NOT make `handleError` total, because a throwing getter on
  // `context` detonates HERE — one line before the guarded walk begins, on the
  // path installed as the `uncaughtException` handler. Caught by the totality
  // test for this function, which failed on exactly this line while the
  // redactor's own totality tests all passed: a guard placed one step too far
  // downstream looks complete from inside the thing it guards.
  const rawContext: Record<string, unknown> = { ...safeShallowCopy(context), retryable };
  if (error instanceof HarnessError) {
    rawContext.safeDetails = safeShallowCopy(error.safeDetails);
  }
  const ctxOutcome = redactContext(rawContext);
  const msgOutcome = redactMessageText(extractErrorMessage(error));
  const redactedContext = ctxOutcome.context;
  const redactedMessage = msgOutcome.message;
  recordRedactionOutcomes(s.signals, ctxOutcome, msgOutcome);

  const event: DebugEvent = {
    kind: "error",
    level,
    category: context.module,
    message: redactedMessage,
    context: redactedContext,
    timestamp: Date.now(),
    code,
    source,
  };
  emitErrorReport(event);
}

// ── Built-in sinks ────────────────────────────────────────────────────────

/** Console sink — writes formatted debug events to stderr (no console.log in prod). */
export function createConsoleSink(): DebugSink {
  return sanctionSink({
    kind: "console",
    write(event: DebugEvent): void {
      const ts = new Date(event.timestamp).toISOString();
      const codeStr = event.code ? ` [${event.code}]` : "";
      const ctxStr = Object.keys(event.context).length > 0 ? ` ${JSON.stringify(event.context)}` : "";
      const line = `[${ts}] ${event.level}${codeStr} (${event.category}): ${event.message}${ctxStr}`;
      if (event.kind === "error") {
        process.stderr.write(line + "\n");
      } else if (event.kind === "warn") {
        process.stderr.write(line + "\n");
      } else {
        process.stderr.write(line + "\n");
      }
    },
  });
}

/**
 * Collecting sink — exposes collected events (for tests).
 *
 * It is a DECLARED kind (`collecting`) and not a back door: a test that wants
 * it must put `"collecting"` in `config.sinks.enabledSinks`, exactly as
 * production puts `"console"` there. The shipped config does not enable it, so
 * nothing in production can attach it by accident.
 */
export function createCollectingSink(): DebugSink & { events: DebugEvent[]; clear(): void } {
  const events: DebugEvent[] = [];
  return sanctionSink({
    kind: "collecting",
    write(event: DebugEvent): void {
      events.push(event);
    },
    flush(): void {
      events.length = 0;
    },
    get events(): DebugEvent[] {
      return events;
    },
    clear(): void {
      events.length = 0;
    },
  });
}

// ── Always-on reports ────────────────────────────────────────────────────
//
// The process-level handlers are NOT installed here: the one owner is the
// fault policy (`src/process/fault-policy.ts`), installed by every process's
// bootstrap. What it (and every other owner of an event an operator must see
// whatever the debug switch says) reports goes through `reportAlwaysOn`.

/**
 * THE ALWAYS-ON REPORT: the one destination for an event an operator must
 * see whatever the debug switch says — a fault the process policy handled, a
 * supervised thread lost or restarted, a restart circuit opening. Never gated
 * by `enabled`, the level floor or the category list, and EXACTLY ONE record
 * either way: configured with at least one sink, one redacted error event
 * through the sinks (counted like every error, deduplicated by nothing — the
 * caller owns its own throttle); otherwise (unconfigured, or no sink) one
 * redacted line on stderr, this module's own terminal output. Total: a report
 * that cannot be made is counted (`reportingFailures`) and falls back to the
 * content-free terminal line.
 */
export function reportAlwaysOn(category: string, message: string, context: Readonly<Record<string, unknown>> = {}): void {
  const s = getSystem();
  try {
    const contextOutcome = redactContext(safeShallowCopy(context));
    const messageOutcome = redactMessageText(message);
    recordRedactionOutcomes(s.signals, contextOutcome, messageOutcome);
    if (s.configured && s.sinks.length > 0) {
      emitErrorReport({
        kind: "error", level: "error", category, message: messageOutcome.message,
        context: contextOutcome.context, timestamp: Date.now(), code: null, source: null,
      });
      return;
    }
    const detail = Object.keys(contextOutcome.context).length > 0 ? ` ${JSON.stringify(contextOutcome.context)}` : "";
    process.stderr.write(`[bridlewise ${category}] ${messageOutcome.message}${detail}\n`);
  } catch {
    // The fixed, content-free report of a report that could not be made.
    reportBestEffortFailure();
  }
}

/**
 * The debug system's message redactor over free text, total: what the fault
 * policy prints when no debug sink is configured. A text the redactor cannot
 * process is withheld whole (`[UNREDACTABLE]`), never printed raw.
 */
export function redactDiagnosticText(text: string): string {
  try {
    return redactMessageText(text).message;
  } catch {
    getSystem().signals.reportingFailures++;
    return "[UNREDACTABLE]";
  }
}

// ── Convenience: check if a category/level would emit ────────────────────

/** @returns `true` when `debugLog(category, level,...)` would actually emit (for conditional expensive context). */
export function wouldEmit(category: string, level: DebugMessageLevel): boolean {
  const s = getSystem();
  if (!s.configured || !s.config.enabled) return false;
  if (!shouldEmitLevel(level, s.config.level)) return false;
  if (!s.config.categories.includes(category)) return false;
  return true;
}

export { debugLevelOrder, shouldEmitLevel } from "./debug-config.ts";
export type { DebugConfig, DebugLevel, DebugSinkKind, ErrorReportingPolicy } from "./debug-config.ts";
