/**
 * Pre-dispatch hallucination gate for LLM tool calls (EXP485, ).
 *
 * Validates every tool call BEFORE it reaches the tool registry. Blocked
 * calls are returned to the model as structured error tool results so the
 * model can course-correct instead of repeating the hallucination. This is
 * the industry-standard "Tool Execution Sandboxing" defence-in-depth layer
 * (see web research: Inventiple "Agentic AI Guardrails" 2026-04-15, Google
 * Cloud "Defence in Depth" 2025-12-12, arxiv 2412.04141 + 2509.18970):
 *
 * 1. GHOST-TOOL detection — a call to a tool name that is NOT in the
 * registry. The model invented a tool. Blocked with a typed error so
 * the model learns the call is unavailable (rather than the registry
 * silently returning "Unknown tool" after the fact).
 * 2. SCHEMA validation — the call's JSON arguments are validated against
 * the tool's declared `parameters` JSON Schema (required fields present,
 * provided field types match, declared enum values honored, declared
 * minLength honored). A malformed call is blocked BEFORE execution so a
 * tool handler never receives garbage that could trigger a confusing
 * runtime error or a security-relevant misuse — and the block message asks
 * for only the failing DELTA, because the valid fields the model already
 * sent are retained and merged (partial-argument memory).
 * 3. LOOP detection — two halves over one concern (repeated identical
 *    calls): (a) ADMITTED calls — the same tool name + identical arguments
 *    repeated beyond a threshold within a sliding window; (b) BLOCKED calls —
 *    a call refused by the ghost/schema checks never reaches that window (the
 *    refusing check runs first), so a repeated-REFUSAL streak is tracked in
 *    its own block-sequence bookkeeping and ESCALATES after
 *    `blockEscalationAfter` consecutive identical blocks: the message names
 *    the pattern honestly (which consecutive block this is, that repeating
 *    the same arguments cannot succeed) instead of restating the same refusal.
 *    At `blockAutoTripAfter` (2× the escalation default) the tool is
 *    AUTO-TRIPPED for the rest of the run: further calls get the terminal
 *    honest refusal, and the trip fact rides the block structurally so the
 *    consumer can flip the breaker owner's row (the panel shows it, the user
 *    can re-arm).
 *
 * The gate is a pure state machine: it performs no I/O. It reads the
 * registry's definitions LAZILY via the injected `getDefinitions` callback
 * on every `check` so it always sees the current tool set (tools can be
 * registered/unregistered between turns). Loop state is per-gate (per
 * session) — the sliding window persists across `check` calls so a loop
 * spanning multiple turns is still caught.
 *
 * Config mirrors the safety-module pattern (`hallucination-config.ts`):
 * defaults live here (safety invariants, overridable), resolved via
 * `resolveToolCallGateConfig`. No new runtime deps; the JSON
 * Schema subset validator is a focused local implementation (the OpenAI
 * tool `parameters` shape is a small, stable subset).
 */
import { canonicalHash, deepFreeze } from "../kernel/integrity.ts";
import { isPlainObject, refuseUnknownKeys } from "../shared/type-guards.ts";
import type { ToolCall, ToolDefinition } from "../runtime/provider-adapter.ts";

// Re-export the tool-call shape the gate consumes so consumers import the
// gate's full public API from one place (single import point) instead of
// reaching into the runtime provider adapter. Type-only re-exports are safe
// for the pure state-machine gate (no value-form bypass, unlike the
// intelligence/awareness bridges — see R33).
export type { ToolCall, ToolDefinition };

// ── Config ─────────────────────────────────────────────────────────────────

export type ToolCallGateConfig = Readonly<{
  /** Block calls to tool names not in the registry. */
  enableGhostToolDetection: boolean;
  /** Validate call arguments against the tool's `parameters` JSON Schema. */
  enableSchemaValidation: boolean;
  /** Block repeated identical (name + arguments) calls beyond a threshold. */
  enableLoopDetection: boolean;
  /**
   * Retain the individually-VALID fields of a schema-failing call, ask the
   * model for only the missing/incorrect delta, and merge the delta onto the
   * retained partial on the next attempt for the same tool. Tool-agnostic:
   * reads each tool's own `parameters` schema generically, so every current
   * and future tool is covered with no per-tool wiring. In-memory, per-gate
   * (per-run), bounded by `partialArgumentsLimit`, cleared when the call
   * succeeds or a new attempt for the same tool replaces it.
   */
  enablePartialArgumentMemory: boolean;
  /**
   * Maximum number of retained per-tool partials held at once. Bounded so the
   * in-memory store cannot grow without limit. At most one partial is retained
   * per tool name (a new attempt for that tool replaces the previous one), so
   * the effective footprint is min(distinct failing tools, this limit).
   */
  partialArgumentsLimit: number;
  /**
   * Maximum number of identical (name + arguments) calls within `loopWindow`
   * before the next identical call is blocked as a loop. Conservative so a
   * legitimate repeated read (e.g. re-reading a file after an edit) is NOT a
   * false positive; a genuinely stuck model exceeds it.
   */
  maxRepeatCount: number;
  /**
   * Sliding-window size (number of recent accepted calls) the loop detector
   * inspects. Larger windows catch slower loops; smaller windows forget
   * faster. The window stores (name + arguments-hash) keys only (no args
   * content), so memory is bounded by `loopWindow` short strings.
   */
  loopWindow: number;
  /**
   * Consecutive identical BLOCKED calls (same tool + same block verdict —
   * reason and failed fields, derived from the gate's own verdict data)
   * after which the block message escalates to name the repetition honestly:
   * which call it is, that the previous ones were blocked identically, and
   * that repeating the same arguments cannot succeed. A blocked call never
   * reaches the admitted-call loop window (the schema/ghost check refuses it
   * first), so without this counter a model repeating a REFUSED call is
   * invisible to every repetition detector — measured as six identical
   * gate-blocked `write_file` calls in one run with nothing escalating.
   * Default 3: the first block teaches, the second warns, the third is the
   * pattern a watching human would intervene on (each further repeat burned
   * ~2,700 completion tokens in the measured incident).
   */
  blockEscalationAfter: number;
  /**
   * Consecutive identical BLOCKED calls (same verdict shape as the
   * escalation counter) at which the tool is AUTO-TRIPPED for the rest of
   * the run: every further call to it is refused with the terminal honest
   * message (the tool is off, answer in text or ask the user) and the
   * consumer routes the trip through the breaker owner so the panel shows
   * it. Rationale: the escalation message gives the model an honest out;
   * a model that ignores it this many more times is burning the user's
   * tokens in a loop (the measured incident burned ~2,700 completion tokens
   * per repeated turn). Default 6 = 2× the escalation default of 3 — the
   * escalation teaches at 3, the trip concludes the model will not
   * course-correct by 6. 0 disables the auto-trip (escalation still
   * fires). Per-run lifetime: the tripped set dies with the gate instance,
   * the same lifetime as the block-sequence bookkeeping; the row flip the
   * consumer performs is reverted at run end unless the user re-arms
   * first (the breaker owner's reset).
   */
  blockAutoTripAfter: number;
}>;

export const DEFAULT_TOOL_CALL_GATE_CONFIG: ToolCallGateConfig = deepFreeze({
  enableGhostToolDetection: true,
  enableSchemaValidation: true,
  enableLoopDetection: true,
  enablePartialArgumentMemory: true,
  partialArgumentsLimit: 64,
  maxRepeatCount: 5,
  loopWindow: 16,
  blockEscalationAfter: 3,
  blockAutoTripAfter: 6,
});

/**
 * Resolve a caller's partial config against the defaults.
 *
 * The spread merge here is worse than a fixed key list: a misspelled name
 * does not overwrite the real field (so the default silently wins) AND it
 * survives into the returned object, where it looks like a setting that took
 * effect. Refusing first makes both halves unreachable.
 */
export function resolveToolCallGateConfig(
  override: Readonly<Partial<ToolCallGateConfig>> = {},
): ToolCallGateConfig {
  refuseUnknownKeys(override, DEFAULT_TOOL_CALL_GATE_CONFIG, "tool call gate", "tool_call_gate_config_unknown_key");
  return deepFreeze({ ...DEFAULT_TOOL_CALL_GATE_CONFIG, ...override }) as ToolCallGateConfig;
}

// ── Result types ───────────────────────────────────────────────────────────

/**
 * WHY a call was blocked, as data: the four verdicts about this call
 * (a ghost name, a payload that is no JSON object, a schema failure, a loop)
 * and the two standing facts about the tool (auto-tripped for the run,
 * switched off at the breaker). Consumers classify by THIS, never by
 * `errorMessage` (prompt-registry F-PR-12: a reworded notice silently
 * misclassified the block and the hallucination counts).
 */
export type GateBlockReason = BlockSequenceReason | "auto-tripped" | "breaker-off";

export type BlockedToolCall = Readonly<{
  toolCallId: string;
  toolName: string;
  errorMessage: string;
  /** The typed reason (see {@link GateBlockReason}); `errorMessage` is prose for the model. */
  reason: GateBlockReason;
  /**
   * The FIELDS that failed schema validation, when the block is a schema
   * block — the structured detail behind `errorMessage`'s prose, so a
   * ledger reader answers "WHICH fields failed" without parsing the
   * message. Absent for the other block kinds (a ghost tool has no fields
   * to fail; a loop names nothing new) and for a payload that was not a
   * JSON object at all (the payload failed, not a field).
   */
  failedFields?: readonly string[];
  /**
   * Present (true) when this block ESCALATED — it is at least the
   * `blockEscalationAfter`-th consecutive blocked call of this tool with
   * the identical block verdict (same reason, same failed fields). The
   * message names the repetition; this flag carries the fact structurally
   * so the ledger's gate-block document answers "did the harness notice
   * the loop of refusals" without parsing prose. Absent on every
   * non-escalated block.
   */
  escalated?: true;
  /**
   * Present (true) when this block TRIPPED the tool — the block-sequence
   * streak reached `blockAutoTripAfter` consecutive identical blocks, so
   * the tool is disabled for the rest of this run. The message states the
   * trip in the terminal honest form; the flag carries the fact
   * structurally so the consumer (the executor's ledger document + the
   * breaker owner's row flip) acts on the trip without parsing prose.
   * Absent on every block that did not trip — including the terminal
   * refusals a tripped tool keeps returning, which carry `autoTripped`
   * because the tool IS tripped but did not just NOW trip.
   */
  autoTripped?: true;
  /**
   * The streak count the trip fired at (or that the standing trip was
   * recorded at). Present only when `autoTripped` is present, so the
   * ledger's structured fact answers "after how many identical blocked
   * calls" without parsing the message.
   */
  autoTrippedAfter?: number;
}>;

export type GateResult = Readonly<{
  blocked: readonly BlockedToolCall[];
  clean: readonly ToolCall[];
}>;

export type ToolCallGate = Readonly<{
  /** Validate a batch of tool calls. Blocked calls are returned as error
   * results; clean calls pass through to the registry. Idempotent + pure
   * except for the per-gate loop-detection window (mutable state). */
  check(toolCalls: readonly ToolCall[], admittedDefinitions?: readonly ToolDefinition[]): GateResult;
}>;

export type ToolCallGateOptions = Readonly<{
  /** Lazy accessor for the current tool definitions. Called on every
   * `check` so the gate always reflects the live registry. */
  getDefinitions: () => readonly ToolDefinition[];
  /**
   * Lazy accessor for the names of every REGISTERED tool — the full
   * registry, including tools the served definitions omit because they are
   * switched off. Called on every `check` (live, like
   * {@link getDefinitions}). When a called tool is registered but absent
   * from the served definitions, the gate refuses it as the standing
   * breaker-off fact ("switched off at the breaker"), never as a ghost —
   * "not registered" would be a lie about a tool the install does have.
   * Optional and honestly degrading: without it the served set is the
   * gate's whole truth and the distinction cannot be made.
   */
  getRegisteredNames?: () => readonly string[];
  /**
   * Partial config override; merged over {@link DEFAULT_TOOL_CALL_GATE_CONFIG}
   * via {@link resolveToolCallGateConfig}. Callers may pass only the fields
   * they want to override (e.g. `{ enableLoopDetection: false }`); unspecified
   * fields inherit the safety-invariant defaults. Accepting a partial here
   * (not the full `ToolCallGateConfig`) matches the resolution logic and the
   * intended override API.
   */
  config?: Partial<ToolCallGateConfig>;
}>;

// ── Gate factory ───────────────────────────────────────────────────────────

export function createToolCallGate(options: ToolCallGateOptions): ToolCallGate {
  const config = options.config !== undefined
    ? resolveToolCallGateConfig(options.config)
    : DEFAULT_TOOL_CALL_GATE_CONFIG;
  // Per-gate sliding window of (toolName + arguments-hash) keys for loop
  // detection. Closed-over (not a property) so freezing the gate object
  // does not freeze this mutable state. Bounded by `loopWindow`.
  const recentCalls: string[] = [];
  // Per-gate partial-argument memory. Keyed by tool name → the individually
  // VALID fields retained from that tool's most recent schema-failing call.
  // At most one partial per tool (a new attempt replaces the previous one),
  // and the whole map is bounded by `partialArgumentsLimit`. This is
  // closed-over per-gate state: a fresh gate (a fresh run/conversation) starts
  // empty, so nothing leaks across runs or users. Cleared for a tool when its
  // merged call succeeds.
  const partialArgumentsByTool = new Map<string, Record<string, unknown>>();
  // Per-gate block-sequence bookkeeping. Keyed by tool name → the verdict
  // shape of its most recent block (reason + failed fields, both derived from
  // the gate's own verdict data — never a hand-listed tool or field set) and
  // how many CONSECUTIVE blocks of that identical shape have now happened.
  // A different shape replaces the entry (the count restarts); a call that
  // PASSES deletes it. This is the loop detection for BLOCKED calls: a
  // refused call never reaches the admitted-call window (the refusing check
  // runs first), so the repeated-refusal loop is visible only here. Bounded
  // by the distinct failing tool names (a tool can hold at most one entry).
  const blockSequenceByTool = new Map<string, BlockSequenceEntry>();
  // Per-gate auto-trip state. Keyed by tool name → the streak count the trip
  // fired at. A tripped tool is refused at the TOP of `check` (before the
  // ghost/schema/loop verdicts are even computed — the trip is a standing
  // fact about the tool, and after the consumer flips the breaker row the
  // tool vanishes from the definitions, which would otherwise turn the
  // honest refusal into a ghost-tool message). The streak counter is NOT
  // re-armed by post-trip calls: nothing about a refused call can change the
  // verdict shape that produced the trip, so a flailing model cannot un-trip
  // itself by varying its mistakes — and in fact no new shape can occur,
  // because the tripped check refuses before any validation runs. Lifetime is
  // the gate instance (the run): a fresh gate starts with nothing tripped.
  const autoTrippedTools = new Map<string, number>();

  /**
   * Store (or clear) the retained partial for a tool, replacing any previous
   * one and bounding the map to `partialArgumentsLimit`. An empty subset
   * clears the entry (there is nothing useful to merge later). Bounded
   * growth: when the limit is reached, the oldest entry is evicted (Map
   * insertion order).
   */
  function retainPartial(name: string, subset: Record<string, unknown>): void {
    partialArgumentsByTool.delete(name);
    if (Object.keys(subset).length > 0) {
      partialArgumentsByTool.set(name, subset);
    }
    while (partialArgumentsByTool.size > config.partialArgumentsLimit) {
      const oldest = partialArgumentsByTool.keys().next();
      if (oldest.done) break;
      partialArgumentsByTool.delete(oldest.value);
    }
  }

  /**
   * Record one blocked call against the tool's block-sequence entry and
   * return the updated entry. The verdict shape (reason + sorted failed
   * fields) is derived entirely from the gate's own verdict data — a
   * different shape REPLACES the entry (count restarts at 1), an identical
   * one increments it. No hand-listed tool names or field sets: whatever a
   * schema or registry produces tomorrow joins the sequence automatically.
   */
  function noteBlocked(
    name: string,
    reason: BlockSequenceReason,
    failedFields?: readonly string[],
  ): BlockSequenceEntry {
    const fields = failedFields === undefined ? [] : [...failedFields].sort();
    const prior = blockSequenceByTool.get(name);
    const count = prior !== undefined && prior.reason === reason && prior.fieldKey === fields.join(",")
      ? prior.count + 1
      : 1;
    const entry: BlockSequenceEntry = { reason, fieldKey: fields.join(","), fields, count };
    blockSequenceByTool.set(name, entry);
    return entry;
  }

  function check(toolCalls: readonly ToolCall[], admittedDefinitions?: readonly ToolDefinition[]): GateResult {
    const liveDefinitions = options.getDefinitions();
    const liveNames = new Set(liveDefinitions.map(tool => tool.function.name));
    // A request's frozen schema cannot be widened while the provider is running.
    // Current removals still narrow authority; new tools cannot enter this batch.
    const definitions = admittedDefinitions === undefined ? liveDefinitions
      : admittedDefinitions.filter(tool => liveNames.has(tool.function.name));
    const knownNames = new Set<string>();
    const schemaByName = new Map<string, Readonly<Record<string, unknown>> | undefined>();
    for (const def of definitions) {
      const name = def.function.name;
      knownNames.add(name);
      schemaByName.set(name, def.function.parameters);
    }
    // The FULL registry, when the caller can name it: the served definitions
    // alone cannot tell "never existed" from "switched off at the breaker".
    const registeredNames =
      options.getRegisteredNames === undefined ? null : new Set(options.getRegisteredNames());
    const blocked: BlockedToolCall[] = [];
    const clean: ToolCall[] = [];

    /**
     * Record one blocked call in the block-sequence bookkeeping and push the
     * frozen BlockedToolCall. When this is at least the
     * `blockEscalationAfter`-th consecutive block of this tool with the
     * identical verdict shape, the message gains the escalation clause and
     * the block carries `escalated: true` (the ledger's structured fact).
     * When the streak additionally reaches `blockAutoTripAfter` (and the
     * auto-trip is armed), the tool is tripped for the rest of the run: the
     * message gains the terminal clause naming the trip and the block
     * carries `autoTripped: true` + the count, so the consumer routes the
     * trip through the breaker owner. One push site for every block kind so
     * no kind can forget the bookkeeping.
     */
    function pushBlocked(
      name: string,
      callId: string,
      baseMessage: string,
      reason: BlockSequenceReason,
      failedFields?: readonly string[],
    ): void {
      const entry = noteBlocked(name, reason, failedFields);
      const escalated = entry.count >= config.blockEscalationAfter;
      const shouldTrip = config.blockAutoTripAfter > 0
        && escalated
        && entry.count >= config.blockAutoTripAfter
        && !autoTrippedTools.has(name);
      let message = escalated
        ? `${baseMessage.endsWith(".") ? baseMessage : `${baseMessage}.`} ${escalationClause(name, entry)}`
        : baseMessage;
      if (shouldTrip) {
        autoTrippedTools.set(name, entry.count);
        message = `${baseMessage.endsWith(".") ? baseMessage : `${baseMessage}.`} ${autoTripClause(name, entry.count)}`;
      }
      blocked.push(deepFreeze({
        toolCallId: callId,
        toolName: name,
        errorMessage: message,
        reason,
        ...(failedFields !== undefined && failedFields.length > 0 ? { failedFields } : {}),
        ...(escalated ? { escalated: true as const } : {}),
        ...(shouldTrip ? { autoTripped: true as const, autoTrippedAfter: entry.count } : {}),
      }));
    }

    for (const original of toolCalls) {
      let tc = original;
      const name = tc.function.name;
      const callId = tc.id;
      // 0. AUTO-TRIPPED refusal — the standing fact, checked BEFORE every
      //    verdict. A tripped tool is off for the rest of the run; the call
      //    is refused plainly, the streak counter is not re-armed (nothing
      //    about a refused call can change the verdict shape that produced
      //    the trip), and the ghost/schema/loop checks never run — which is
      //    also why the order matters: after the consumer flips the
      //    breaker row the tool vanishes from the definitions, and a call
      //    to it would otherwise be classified as a ghost tool.
      const trippedAt = autoTrippedTools.get(name);
      if (trippedAt !== undefined) {
        blocked.push(deepFreeze({
          toolCallId: callId,
          toolName: name,
          errorMessage: trippedRefusal(name, trippedAt),
          reason: "auto-tripped",
          autoTripped: true,
          autoTrippedAfter: trippedAt,
        }));
        continue;
      }
      // 1. GHOST-TOOL detection — with the breaker-off distinction first.
      //    A tool can be absent from the served definitions for TWO opposite
      //    reasons: it does not exist (a genuine hallucination), or it EXISTS
      //    and the user switched it off at the breaker. Calling the second
      //    "not registered" is a lie about the install, and it teaches the
      //    model the wrong repair (stop calling it) instead of the real one
      //    (the breaker panel). The refusal below states the standing fact,
      //    in the same register as the auto-trip refusal — and, like the
      //    tripped branch, it does NOT arm the block-sequence streak: the
      //    breaker's state is not a verdict about THIS call's arguments.
      if (config.enableGhostToolDetection && !knownNames.has(name)) {
        if (registeredNames !== null && registeredNames.has(name)) {
          blocked.push(deepFreeze({
            toolCallId: callId,
            toolName: name,
            errorMessage: breakerOffRefusal(name),
            reason: "breaker-off",
          }));
          continue;
        }
        pushBlocked(
          name,
          callId,
          `Tool '${name}' is not registered. Available tools: ${
            knownNames.size > 0 ? [...knownNames].sort().join(", ") : "(none)"
          }. Stop calling '${name}' and use a registered tool.`,
          "ghost",
        );
        continue;
      }
      // 2. SCHEMA validation (only for known tools with a parameters schema).
      //    Partial-argument memory is merge-first: the newly-sent fields are
      //    merged onto the retained partial for this tool (new fields win) and
      //    the MERGED whole is validated, so a delta that completes the call
      //    passes with the complete arguments — the executor receives the
      //    merged object, not just the delta.
      if (config.enableSchemaValidation) {
        const parameters = schemaByName.get(name);
        if (parameters !== undefined) {
          const memoryActive = config.enablePartialArgumentMemory;
          const sent = parseObjectArguments(tc.function.arguments);
          const retained = memoryActive ? partialArgumentsByTool.get(name) : undefined;
          // The candidate under validation: the merge when a retained partial
          // exists (and the args parsed), else the sent arguments alone.
          const merged = retained !== undefined && sent !== null ? { ...retained, ...sent } : null;
          const candidate = merged ?? sent;
          if (candidate === null) {
            // Not a JSON object at all — nothing to retain or merge.
            const shapeVerdict = validateArgumentsAgainstSchema(tc.function.arguments, parameters, memoryActive);
            pushBlocked(
              name,
              callId,
              `Tool '${name}' arguments failed schema validation: ${shapeVerdict.message}`,
              "payload",
            );
            continue;
          }
          const candidateJson = JSON.stringify(candidate);
          const schemaVerdict = validateArgumentsAgainstSchema(candidateJson, parameters, memoryActive);
          if (schemaVerdict.message === null) {
            // The candidate is valid. Clear any retained partial for this
            // tool (the call succeeded) and pass the call through — with the
            // merged arguments when a merge actually added fields.
            if (retained !== undefined) partialArgumentsByTool.delete(name);
            if (merged !== null && Object.keys(merged).length > Object.keys(sent!).length) {
              // Preserve native caller/namespace and check the effective merged
              // arguments against the same loop window as every other call.
              tc = deepFreeze({ ...tc, function: { ...tc.function, arguments: candidateJson } });
            }
            // No merge (or the merge added nothing): the original call passes.
          } else {
            // Still invalid: retain the valid subset of the candidate (which
            // already reflects the merge) and block with delta guidance.
            if (memoryActive) {
              const subset = extractValidSubset(candidateJson, parameters);
              if (subset !== null) retainPartial(name, subset);
            }
            pushBlocked(
              name,
              callId,
              `Tool '${name}' arguments failed schema validation: ${schemaVerdict.message}`,
              "schema",
              schemaVerdict.failedFields,
            );
            continue;
          }
        }
      }
      // 3. LOOP detection (identical name + arguments repeated beyond threshold).
      if (config.enableLoopDetection) {
        const loopKey = name + "\0" + canonicalHashOfArgs(tc.function.arguments);
        const priorCount = countKeyInWindow(recentCalls, loopKey);
        if (priorCount >= config.maxRepeatCount) {
          pushBlocked(
            name,
            callId,
            `Tool '${name}' called ${priorCount + 1} times with identical arguments — this looks like a loop. Change the arguments or stop calling this tool.`,
            "loop",
          );
          continue;
        }
        // Accept the call + record it in the sliding window.
        recentCalls.push(loopKey);
        if (recentCalls.length > config.loopWindow) recentCalls.shift();
      }
      // A passing call resets the tool's block sequence: the model changed
      // what it sends, so a later block is a new first block, not a
      // continuation of the refused streak.
      blockSequenceByTool.delete(name);
      clean.push(tc);
    }
    return deepFreeze({
      blocked: deepFreeze(blocked) as readonly BlockedToolCall[],
      clean: deepFreeze(clean) as readonly ToolCall[],
    }) as GateResult;
  }

  return Object.freeze({ check });
}

// ── Focused JSON Schema subset validator ───────────────────────────────────
// Validates the OpenAI tool `parameters` shape: { type: "object", properties:
// { name: { type: "string"|"number"|"integer"|"boolean"|"array"|"object",
// enum?: string[], minLength?: number } }, required: string[] }. Returns the
// first error message or null when valid. This is the "strict schema
// validation before execution" pattern. It is intentionally a SUBSET (no
// $ref, no allOf, no format) — those are not used by the harness tool
// definitions, and a full validator would be a new dependency. The subset
// covers exactly the constraints the tool schemas DECLARE — enum and
// minLength arrived because the manifest and MCP provider schemas already
// declare them (create_artifact's `type`, control_interface's enums,
// fetch_memory's `tier`), and a schema-declared constraint the gate ignores
// falls through to an executor-level flat error with no field-level repair.
// Unknown schema fields are ignored (forward-compatible). Numeric
// minimum/maximum are deliberately NOT enforced here: the schemas that
// declare them (e.g. search `limit`) are CLAMPED by their handlers rather
// than refused, and refusing at the gate would change that behavior.

/**
 * What a schema check found: the human-facing `message` (null when the
 * candidate is valid) and the STRUCTURED field names behind it. The names are
 * the machine-queryable half — a ledger reader asks "WHICH fields failed"
 * without parsing prose, and the model-facing message keeps its guidance
 * role. Both halves come from ONE pass over the candidate; a second parse of
 * the message text would be a parser of this module's own output.
 */
type SchemaVerdict = Readonly<{
  message: string | null;
  /** Every field that failed (missing or wrongly typed), in check order. */
  failedFields: readonly string[];
}>;

function validateArgumentsAgainstSchema(
  rawArguments: string,
  parameters: Readonly<Record<string, unknown>>,
  memoryActive = false,
): SchemaVerdict {
  const args = parseObjectArguments(rawArguments);
  if (args === null) {
    // Empty arguments parse to {} (handled above), so a null here is a
    // malformed-or-non-object payload. Distinguish a JSON parse failure
    // ("not valid JSON") from valid JSON that is not an object ("must be a
    // JSON object"); either way nothing well-formed is retained or merged.
    // No FIELD failed — the payload did — so `failedFields` is empty and the
    // message carries the shape of what was wrong.
    return {
      message: isJsonParseable(rawArguments)
        ? "the arguments must be a JSON object — re-send the tool call with the arguments as one JSON object"
        : "the arguments are not valid JSON — re-send the tool call with the arguments as one JSON object",
      failedFields: [],
    };
  }
  // Collect EVERY problem, not just the first. A small model recovers from a
  // message that names exactly what is missing or wrong; it cannot recover
  // from "missing required field 'type'" and re-guesses the whole call. The
  // guidance targets only what needs to change, so the model fixes the gap
  // instead of re-sending the same call.
  const problems: string[] = [];
  const failedFields: string[] = [];
  const properties = isPlainObject(parameters.properties) ? parameters.properties : undefined;
  const required = requiredFields(parameters);
  const missing = required.filter((field) => !(field in args));
  for (const field of missing) {
    problems.push(`missing required field '${field}'${describeFieldShape(field, properties)}`);
    failedFields.push(field);
  }
  // Present fields that fail their declared constraint — a wrong TYPE or a
  // wrong VALUE (outside a declared enum, shorter than a declared minLength).
  // The two categories produce different problem text and different repair
  // phrasing ("correct type" vs "corrected value"), but both make the field
  // part of the delta: its value must be re-sent, and it is NOT retained.
  const invalidFields = nonconformingFieldNames(args, properties);
  const valueFailedFields: string[] = [];
  for (const field of invalidFields) {
    const spec = properties![field] as Readonly<Record<string, unknown>>;
    const typeProblem = checkType(args[field], spec, field);
    if (typeProblem !== null) {
      problems.push(typeProblem);
    } else {
      // The type matched; the failure is the VALUE constraint.
      problems.push(checkValueConstraint(args[field], spec, field)!);
      valueFailedFields.push(field);
    }
    failedFields.push(field);
  }
  if (problems.length === 0) return { message: null, failedFields: [] };
  return {
    message: `${problems.join("; ")}. ${buildRepairGuidance(required, missing, invalidFields, valueFailedFields, args, properties, memoryActive)}`,
    failedFields,
  };
}

/**
 * Parse the raw arguments into a plain object, or null when they are not a
 * JSON object (invalid JSON, a JSON array, or a scalar). The single parse
 * point for the schema path so retention, merge, and validation all read the
 * same shape. Empty arguments parse to `{}` (the OpenAI "no args" shape).
 */
function parseObjectArguments(rawArguments: string): Record<string, unknown> | null {
  if (rawArguments.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    return null;
  }
  return isPlainObject(parsed) ? parsed : null;
}

/**
 * `true` when the raw arguments parse as JSON at all (regardless of the
 * resulting shape). Used to distinguish a parse failure ("not valid JSON")
 * from valid JSON of the wrong shape ("must be a JSON object") so the
 * shape-error message matches the actual failure.
 */
function isJsonParseable(rawArguments: string): boolean {
  try {
    JSON.parse(rawArguments);
    return true;
  } catch {
    return false;
  }
}

/** The schema's declared required field names (a string array, or none). */
function requiredFields(parameters: Readonly<Record<string, unknown>>): readonly string[] {
  return Array.isArray(parameters.required)
    ? parameters.required.filter((f): f is string => typeof f === "string")
    : [];
}

/**
 * The NAMES of every present, schema-declared field whose value fails its
 * declared constraint — the declared TYPE, or (when the type matches) a
 * declared VALUE constraint (enum membership, minLength). Fields the schema
 * does not declare are skipped here — their handling on retention and merge
 * follows the schema's `additionalProperties` semantics separately. Returned
 * as names (not messages) so the validator can build the problem text AND the
 * repair guidance can name the delta from the same pass.
 */
function nonconformingFieldNames(
  args: Readonly<Record<string, unknown>>,
  properties: Readonly<Record<string, unknown>> | undefined,
): string[] {
  if (properties === undefined) return [];
  const names: string[] = [];
  for (const [field, value] of Object.entries(args)) {
    const spec = properties[field];
    if (spec === undefined || !isPlainObject(spec)) continue;
    if (checkField(value, spec, field) !== null) names.push(field);
  }
  return names;
}

/**
 * The individually-VALID fields of a schema-failing call: present AND
 * conforming to their declared constraints (type AND value — a field whose
 * value is outside a declared enum or shorter than a declared minLength is
 * NOT valid, so it is not retained; only its value needs re-sending). This is
 * the retained partial the model is asked to build on. A field is retained
 * only when the schema declares it and the value conforms — fields the schema
 * does not declare are retained only when the schema allows additional
 * properties (an undeclared field on a closed object is not a known-valid
 * value). Returns null when the arguments are not a JSON object (nothing
 * well-formed to retain). Derived from the tool's own schema, never
 * hardcoded, so it covers every tool generically.
 */
function extractValidSubset(
  rawArguments: string,
  parameters: Readonly<Record<string, unknown>>,
): Record<string, unknown> | null {
  const args = parseObjectArguments(rawArguments);
  if (args === null) return null;
  const properties = isPlainObject(parameters.properties) ? parameters.properties : undefined;
  const allowsAdditional = parameters.additionalProperties !== false;
  const subset: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(args)) {
    const spec = properties !== undefined ? properties[field] : undefined;
    if (spec !== undefined && isPlainObject(spec)) {
      // Declared field: retain only when the value conforms to the declared
      // constraints (type AND value — an out-of-enum or too-short value is
      // not a known-valid value to keep).
      if (checkField(value, spec, field) === null) subset[field] = value;
      continue;
    }
    // Undeclared field: a known-valid value only when the schema is open.
    if (allowsAdditional) subset[field] = value;
  }
  return subset;
}

/**
 * The per-field shape hint: the field's declared shape — type, allowed values
 * (enum), minimum length, and its own description when the schema carries
 * one. A small model pattern-matches a concrete shape far more reliably than
 * a bare name, and the hint is derived from the same spec the validator
 * reads, so it cannot drift from what is enforced.
 */
function describeFieldShape(field: string, properties: Readonly<Record<string, unknown>> | undefined): string {
  if (properties === undefined) return "";
  const spec = properties[field];
  if (spec === undefined || !isPlainObject(spec)) return "";
  const parts: string[] = [];
  if (typeof spec.type === "string" && spec.type.length > 0) {
    // A minLength of 1 on a string field is the "non-empty" fact — say it in
    // the words the model reads, not the raw number.
    const nonEmpty = spec.type === "string" && spec.minLength === 1;
    parts.push(nonEmpty ? "a non-empty string" : `a ${spec.type}`);
  }
  const allowed = allowedEnumValues(spec);
  if (allowed !== null) parts.push(`one of: ${allowed.join(", ")}`);
  const minLength = declaredMinLength(spec);
  if (minLength !== null && minLength > 1) parts.push(`at least ${minLength} characters`);
  if (typeof spec.description === "string" && spec.description.length > 0) parts.push(spec.description);
  return parts.length > 0 ? ` (${parts.join(" — ")})` : "";
}

/**
 * The repair guidance: what to send next, targeted at the DELTA — the missing
 * or incorrectly-typed fields — because the harness retains the valid fields
 * the model already sent and merges the next attempt onto them. The model is
 * told to send ONLY the fields that still need fixing, not the whole object
 * again. When nothing usable was sent yet, say so plainly and show the
 * minimal complete call. Derived from the schema's required fields, never
 * hardcoded, so it cannot drift from the schema.
 */
function buildRepairGuidance(
  required: readonly string[],
  missing: readonly string[],
  invalidFields: readonly string[],
  valueFailedFields: readonly string[],
  args: Readonly<Record<string, unknown>>,
  properties: Readonly<Record<string, unknown>> | undefined,
  memoryActive: boolean,
): string {
  // The KEPT fields are those present AND conforming (neither missing nor
  // invalid) — exactly what the retention holds. The DELTA is the fields
  // still to fix: the missing ones plus the present-but-invalid ones.
  const kept = required.filter((field) => field in args && !missing.includes(field) && !invalidFields.includes(field));
  const deltaFields = [...missing, ...invalidFields.filter((f) => !missing.includes(f))];
  const delta = deltaFields.map((f) => `'${f}'`).join(", ");
  const minimalCall = `send the tool call again with ${required.map((f) => `'${f}'`).join(", ")} all present and correctly typed`;
  // With no retained memory, the only honest instruction is the whole call.
  if (!memoryActive) {
    if (required.length === 0) return "Fix the argument problems above and re-send the tool call.";
    if (missing.length === 0) return `Fix the argument problems above and ${minimalCall}.`;
    if (missing.length === required.length) {
      const example = buildMinimalExample(required, properties);
      return `You sent no usable arguments. ${minimalCall}${example !== "" ? ` — for example ${example}` : ""}.`;
    }
    return `You already sent ${kept.map((f) => `'${f}'`).join(", ")} — keep those and add the missing ${missing.map((f) => `'${f}'`).join(", ")}; ${minimalCall}.`;
  }
  // With retained memory, ask only for the delta; the harness merges it in.
  const keptClause = kept.length > 0
    ? ` — the harness kept the valid fields you already sent (${kept.map((f) => `'${f}'`).join(", ")}) and merges your next attempt in, so do not re-send those`
    : " — the harness merges the fields you send into the ones it kept, so send only what still needs fixing";
  if (missing.length === required.length) {
    const example = buildMinimalExample(required, properties);
    return `Send the tool call again with ${required.map((f) => `'${f}'`).join(", ")} all present and correctly typed${example !== "" ? ` — for example ${example}` : ""}.`;
  }
  if (invalidFields.length > 0 && missing.length === 0) {
    // A pure VALUE failure (the field's type matched but the value is outside
    // a declared enum or too short) is asking for a corrected VALUE, not a
    // corrected type — the words matter: "correct type" on a typed-right
    // field teaches the model nothing it can act on.
    if (valueFailedFields.length === invalidFields.length) {
      return `Send only ${delta} with a corrected value${deltaFields.length > 1 ? "s" : ""}${keptClause}.`;
    }
    return `Send only ${delta} with the correct type${deltaFields.length > 1 ? "s" : ""}${keptClause}.`;
  }
  if (missing.length > 0 && invalidFields.length > 0) {
    return `Send only the missing/incorrect ${delta}${keptClause}.`;
  }
  return `Send only the missing ${delta}${keptClause}.`;
}

/**
 * A minimal complete-call example, derived from the schema's required fields
 * (each required field's type, or its description when it has one). Derived,
 * never hand-written, so it cannot drift from the schema.
 */
function buildMinimalExample(required: readonly string[], properties: Readonly<Record<string, unknown>> | undefined): string {
  const parts: string[] = [];
  for (const field of required) {
    const spec = properties?.[field];
    const placeholder = spec !== undefined && isPlainObject(spec) && typeof spec.type === "string" && spec.type.length > 0
      ? `<${spec.type}>`
      : `<${field}>`;
    parts.push(`"${field}": ${placeholder}`);
  }
  return parts.length > 0 ? `{${parts.join(", ")}}` : "";
}

function checkType(
  value: unknown,
  spec: Readonly<Record<string, unknown>>,
  field: string,
): string | null {
  const type = spec.type;
  if (typeof type !== "string" || type.length === 0) return null;
  // Allow multiple types via "type": ["string","null"].
  const types = type.includes("|") ? type.split("|") : [type];
  for (const t of types) {
    if (matchesType(value, t.trim())) return null;
  }
  return `field '${field}' must be of type ${type}, got ${describeType(value)}`;
}

/**
 * The schema's declared enum values when the spec carries a well-formed
 * `enum` (a non-empty array of strings — the shape every manifest and MCP
 * provider schema in this harness declares), else null. A malformed enum
 * (non-array, empty, non-string members) is IGNORED, matching the
 * forward-compatible treatment of unknown schema shapes.
 */
function allowedEnumValues(spec: Readonly<Record<string, unknown>>): readonly string[] | null {
  if (!Array.isArray(spec.enum) || spec.enum.length === 0) return null;
  const values = spec.enum.filter((v): v is string => typeof v === "string");
  return values.length === spec.enum.length ? values : null;
}

/**
 * The schema's declared `minLength` when it is a non-negative integer,
 * else null. Applied only to string values (a minLength on a non-string
 * field is a schema-authoring mistake the type check already reports).
 */
function declaredMinLength(spec: Readonly<Record<string, unknown>>): number | null {
  return typeof spec.minLength === "number" && Number.isInteger(spec.minLength) && spec.minLength >= 0
    ? spec.minLength
    : null;
}

/**
 * The VALUE constraints a field's spec may declare BEYOND its type: enum
 * membership and minLength. Checked only when the declared type MATCHED (a
 * wrong-typed value is reported by the type check with the type message —
 * one failure, one problem line). Returns the problem message or null.
 */
function checkValueConstraint(
  value: unknown,
  spec: Readonly<Record<string, unknown>>,
  field: string,
): string | null {
  const allowed = allowedEnumValues(spec);
  if (allowed !== null && !allowed.includes(value as string)) {
    return `field '${field}' must be one of: ${allowed.join(", ")}, got ${describeValueForMessage(value)}`;
  }
  const minLength = declaredMinLength(spec);
  if (minLength !== null && typeof value === "string" && value.length < minLength) {
    return `field '${field}' must be at least ${minLength} character${minLength === 1 ? "" : "s"} long, got ${value.length}`;
  }
  return null;
}

/**
 * The combined declared-constraint check for one field: the type shape, and
 * (when the type matched) the value constraints. Retention and the
 * invalid-field collection both use this single pass so "valid" means the
 * same thing everywhere — a field the validator accepts is exactly a field
 * the retention keeps.
 */
function checkField(
  value: unknown,
  spec: Readonly<Record<string, unknown>>,
  field: string,
): string | null {
  return checkType(value, spec, field) ?? checkValueConstraint(value, spec, field);
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return isPlainObject(value);
    case "null": return value === null;
    default: return true; // unknown type names are accepted (forward-compat).
  }
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// ── Loop-detection helpers ──────────────────────────────────────────────────

function canonicalHashOfArgs(rawArguments: string): string {
  // Hash the arguments so the loop key is short + content-addressed. Empty
  // arguments and "{}" hash identically (both represent "no args").
  const normalized = rawArguments.length === 0 ? "{}" : rawArguments;
  return canonicalHash({ args: normalized });
}

function countKeyInWindow(window: readonly string[], key: string): number {
  let count = 0;
  for (const k of window) if (k === key) count++;
  return count;
}

// ── Block-sequence escalation helpers ────────────────────────────────────────

/** Why a call was blocked — the first half of a block's verdict-shape identity. */
type BlockSequenceReason = "ghost" | "payload" | "schema" | "loop";

/**
 * One tool's block sequence: the verdict shape of its most recent block and
 * how many consecutive blocks of that identical shape have happened. The
 * `fieldKey` (sorted failed-field names, comma-joined) plus `reason` IS the
 * identity — two schema blocks of the same tool count as the same streak only
 * when the same fields failed, so a model that changes WHICH mistake it makes
 * restarts the count honestly.
 */
type BlockSequenceEntry = Readonly<{
  reason: BlockSequenceReason;
  fieldKey: string;
  fields: readonly string[];
  count: number;
}>;

/** The ordinal word for the small counts a streak actually reaches. */
function ordinalOf(n: number): string {
  const words: Record<number, string> = { 2: "second", 3: "third", 4: "fourth", 5: "fifth", 6: "sixth", 7: "seventh", 8: "eighth", 9: "ninth", 10: "tenth" };
  return words[n] ?? `${n}th`;
}

/**
 * How much of a bad value an error message quotes before capping with an
 * ellipsis — enough for the model to recognise what it sent, short enough
 * that a huge value cannot flood the context with its own garbage. A named
 * bound, never an inline slice literal.
 */
const MAX_QUOTED_VALUE_LENGTH = 60;

/** A value quoted for an error message, capped so a huge value cannot flood the context. */
function describeValueForMessage(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > MAX_QUOTED_VALUE_LENGTH ? `${text.slice(0, MAX_QUOTED_VALUE_LENGTH)}…` : text;
}

/**
 * The escalation clause appended to a block message once the tool's block
 * sequence reaches the configured threshold. It names the pattern honestly —
 * which consecutive block this is, that the previous ones were blocked
 * identically, and that repeating the same arguments cannot succeed — plus
 * the per-reason exit. The clause is derived from the entry's own verdict
 * data, so it can never name a field or reason the block did not produce.
 */
function escalationClause(name: string, entry: BlockSequenceEntry): string {
  const previous = entry.count - 1;
  const shapeClause =
    entry.reason === "schema"
      ? `for the same failed field${entry.fields.length === 1 ? "" : "s"} (${entry.fields.map((f) => `'${f}'`).join(", ")})`
      : entry.reason === "ghost" ? "for the same unregistered tool name"
      : entry.reason === "payload" ? "for the same malformed arguments"
      : "for the same looping call";
  const remedy =
    entry.reason === "schema" ? "Either send the corrected fields named above or answer in text."
    : entry.reason === "ghost" ? "Use a registered tool or answer in text."
    : entry.reason === "payload" ? "Either send the arguments as one JSON object or answer in text."
    : "Change the arguments or stop calling this tool.";
  return (
    `This is the ${ordinalOf(entry.count)} consecutive time this call of '${name}' was blocked ${shapeClause}; ` +
    `the previous ${previous} ${previous === 1 ? "call was" : "calls were"} blocked identically — ` +
    `repeating the same arguments cannot succeed. ${remedy}`
  );
}

// ── Auto-trip terminal message helpers ──────────────────────────────────────

/**
 * The terminal clause appended to the block that TRIPS the tool. It states
 * the consequence honestly (the tool is disabled for the rest of the run),
 * names the count, and gives the two exits: the user's breaker panel (the
 * manual re-arm) or answering in text. Derived from the trip's own count,
 * never restated by a caller.
 */
function autoTripClause(name: string, count: number): string {
  return (
    `The '${name}' tool has been disabled for the rest of this run after ${count} consecutive ` +
    `identical blocked calls — the user can re-enable it from the breaker panel. ` +
    `Answer in text or ask the user.`
  );
}

/**
 * The refusal a TRIPPED tool returns for every further call. Plain and
 * stable across repeats (the count is the standing trip's count, never
 * re-armed), so a model reading it twice learns nothing new — which is the
 * point: the only exits are the user's re-arm or answering in text.
 */
function trippedRefusal(name: string, count: number): string {
  return (
    `Tool '${name}' is disabled for the rest of this run (auto-tripped after ${count} consecutive ` +
    `identical blocked calls). The user can re-enable it from the breaker panel. ` +
    `Answer in text or ask the user.`
  );
}

/**
 * The standing refusal for a REGISTERED tool the user switched off at the
 * breaker panel — the sibling of {@link trippedRefusal} for the breaker's
 * own off state (not the auto-trip's). Same register: the fact, the repair
 * door, and the honest instruction; never "not registered", which would be
 * a lie about a tool the install does have.
 */
function breakerOffRefusal(name: string): string {
  return (
    `Tool '${name}' is switched off at the breaker — the user turned it off; it can be ` +
    `switched back on from the breaker panel, and the change lands at the next tool ` +
    `decision. Answer in text or ask the user.`
  );
}
