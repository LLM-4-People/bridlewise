/**
 * Pre-dispatch hallucination/safety gate — the SINGLE web-UI owner (SPO
 *  "hallucination prevention comes BEFORE tool
 * calls").
 *
 * The safety layer checks for hallucinations (ghost tools, schema mismatches,
 * loops) BEFORE the model's tool call reaches the tool executor. This is a
 * thin adapter over the CANONICAL gate (`integration/src/safety/tool-call-
 * gate.ts`) — reuse the canonical gate, do NOT rebuild. The canonical
 * gate is a pure state machine (no I/O) that performs:
 *
 * 1. GHOST-TOOL detection — a call to a tool name NOT in the registry.
 * 2. SCHEMA validation — call arguments validated against the tool's JSON
 * Schema (required fields, types).
 * 3. LOOP detection — the same tool name + identical arguments repeated
 * beyond a threshold within a sliding window.
 *
 * This bridge owns:
 * `createRunSafetyGate(entries)` — creates a per-run gate instance. The
 * gate's `getDefinitions` callback reads the LIVE enabled manifest
 * (so a tool toggled mid-run is reflected) via `manifestEntriesToToolDefinitions`
 * (the single manifest→LLM-shape owner in tools-bridge — reuse).
 * The config comes from `getSafetyGateConfig` (the config owner).
 * `gateBlockKind(blocked)` — maps a blocked call's TYPED reason into
 * "ghost_tool" | "schema_mismatch" | "loop" | "tool_disabled" for SSE
 * exposure (a total map: a reason the gate adds is a compile error here
 * until it is mapped; the message text is never read).
 * `ghostToolSuggestion(toolName)` — the SINGLE owner of the ghost-tool
 * suggestion map (moved here from tool-executor.ts in was a
 * scattered duplicate). Each entry maps a common CLI hallucination
 * (grep, cat, ls, …) → { realTool, hint }. The canonical gate already
 * detects ghost tools dynamically (reads the live registry); this map
 * ENRICHES the gate's "not registered" message with a helpful "use X
 * instead" hint so the LLM course-corrects faster.
 *
 * The gate INSTANCE is created per-run (in run.ts) and passed to the executor
 * via `ToolExecutionContext.gate`. The executor calls `gate.check` BEFORE
 * dispatching — the gate is the choke point between the LLM's tool call and
 * the actual execution (lowest-level enforcement — no caller can bypass it).
 *
 * Web research (Kagi, ): the "Tool Execution Sandboxing" / defense-in-
 * depth guardrail pattern (NeMo Guardrails, ToolHalla "AI Hallucination
 * Guardrails 2026", arxiv 2412.04141 "Reducing Tool Hallucination via
 * Reliability Alignment") is the industry standard: a single middleware
 * layer that intercepts tool calls BEFORE execution, validating them against
 * the registry + schema, and blocking hallucinated/looping calls. The
 * canonical gate implements exactly this; this bridge is the web-UI adapter.
 */
import {
  createToolCallGate,
  recordHallucinationGateBlock,
  recordSafetyHallucinationGateBlock,
  type BlockedToolCall,
  type GateBlockReason,
  type ToolCallGate,
  type ToolCallGateConfig,
} from "../kernel/canonical.ts";
import {
  gateBlockEventKind,
  type GateBlockKind,
} from "../../shared/event-types.ts";
import { getSafetyGateConfig } from "../kernel/harness-config.ts";
import { manifestEntriesToToolDefinitions, getEnabledToolManifest, getRegisteredToolNames, type WebToolEntry } from "../tools/tools-bridge.ts";

// ── Gate block kinds (exposed as SSE signals) ───────────────────

// The gate-block-kind vocabulary and the kind→label map are owned by
// `shared/event-types.ts` (the single vocabulary both the server classifier
// and the client SSE handler import — neither restates the list). Re-exported
// here so the gate's consumers read it from the gate owner.
export type { GateBlockKind };
export { gateBlockEventKind };

/**
 * The gate's typed reason → the SSE kind. TOTAL over the gate's reasons (a
 * new reason is a compile error until mapped). The two standing facts about
 * the tool — auto-tripped for the run, switched off at the breaker — are one
 * kind, never a "hallucination".
 */
const GATE_BLOCK_KIND_OF: Readonly<Record<GateBlockReason, GateBlockKind>> = Object.freeze({
  ghost: "ghost_tool",
  payload: "schema_mismatch",
  schema: "schema_mismatch",
  loop: "loop",
  "auto-tripped": "tool_disabled",
  "breaker-off": "tool_disabled",
});

/**
 * THE classifier for gate-blocked calls: the block's TYPED reason, never its
 * message (prompt-registry F-PR-12: `errorMessage.includes(...)` misclassified
 * any reworded notice — the hallucination counts and the breaker's exits
 * depended on prose). A block that just TRIPPED the tool is `tool_disabled`
 * whatever verdict tripped it: the tool is off from here on.
 */
export function gateBlockKind(blocked: Pick<BlockedToolCall, "reason" | "autoTripped">): GateBlockKind {
  return blocked.autoTripped === true ? "tool_disabled" : GATE_BLOCK_KIND_OF[blocked.reason];
}

// ── Ghost-tool suggestions (single owner — moved from tool-executor.ts) ──

/**
 * Common CLI tools an LLM might hallucinate as available harness tools. Each
 * entry maps the ghost name → { realTool, hint } so the gate's "not
 * registered" error can be enriched with a helpful "use X instead" pointer.
 * The canonical gate detects ghost tools DYNAMICALLY (reads the live
 * registry); this curated map only ENRICHES the message — adding a new
 * hallucination pattern is an explicit enhancement, not a silently-rotting
 * list (the gate's detection itself needs no maintenance).
 */
const GHOST_TOOL_SUGGESTIONS: Readonly<Record<string, { realTool: string; purpose: string }>> = Object.freeze({
  grep: { realTool: "search_code", purpose: "search file contents for a pattern" },
  rg: { realTool: "search_code", purpose: "search file contents for a pattern" },
  cat: { realTool: "read_file", purpose: "view a file's contents" },
  head: { realTool: "read_file", purpose: "read a file from the top" },
  tail: { realTool: "viewport", purpose: "read an exact range of lines from a file" },
  ls: { realTool: "list_files", purpose: "list a directory's contents" },
  find: { realTool: "list_files", purpose: "browse a directory to locate a file by name" },
  sed: { realTool: "edit", purpose: "replace text in a file" },
  awk: { realTool: "read_file", purpose: "read a file so you can process it in your reply" },
  vim: { realTool: "edit", purpose: "edit text in a file" },
  nano: { realTool: "edit", purpose: "edit text in a file" },
  rm: { realTool: "edit", purpose: "remove text from a file (files are never deleted)" },
  touch: { realTool: "edit", purpose: "create a file or add content to one" },
  mkdir: { realTool: "execute_command", purpose: "create a directory" },
  git: { realTool: "git_status", purpose: "inspect the repository's state" },
  python: { realTool: "execute_command", purpose: "run a shell command" },
  node: { realTool: "execute_command", purpose: "run a shell command" },
  npm: { realTool: "execute_command", purpose: "run a shell command" },
});

/**
 * Describe a real tool's parameters from its OWN input schema.
 *
 * The hints used to spell the parameters out in prose beside the map, and they
 * had drifted into instructions that could not be followed: the model calling
 * `grep` was told to use `search_code` with a `path`, and calling `find` was
 * told to pass a `file_pattern` glob — neither parameter has ever existed on
 * that tool, whose schema sets `additionalProperties: false` and rejects them.
 * A layer that exists to stop the model inventing things was handing it
 * inventions of its own.
 *
 * Reading the schema removes the possibility: a renamed parameter renames
 * itself here, and a removed one stops being mentioned, because there is no
 * second copy to forget.
 */
function describeToolParameters(entry: WebToolEntry): string {
  const schema = entry.inputSchema as { properties?: Record<string, unknown>; required?: unknown } | undefined;
  const properties = schema?.properties;
  if (properties === undefined || properties === null) return "";
  const names = Object.keys(properties);
  if (names.length === 0) return "";
  const required = new Set(Array.isArray(schema?.required) ? (schema.required as unknown[]).filter((r): r is string => typeof r === "string") : []);
  const requiredNames = names.filter((n) => required.has(n));
  const optionalNames = names.filter((n) => !required.has(n));
  const quoted = (list: readonly string[]): string => list.map((n) => `'${n}'`).join(", ");
  if (requiredNames.length === 0) return ` with the optional ${quoted(optionalNames)}`;
  if (optionalNames.length === 0) return ` with ${quoted(requiredNames)}`;
  return ` with ${quoted(requiredNames)}, and optionally ${quoted(optionalNames)}`;
}

/**
 * Check whether a tool name is a known ghost tool (a hallucinated CLI tool
 * that has a real harness equivalent). Returns the suggestion or null.
 *
 * A suggestion is only produced when the tool it names is one the model can
 * ACTUALLY call right now — present in the live enabled manifest. Pointing at
 * a tool that is unregistered, or registered but switched off, replaces one
 * unusable name with another and teaches the model a second wrong answer, so
 * the honest response in that case is no suggestion at all.
 */
export function ghostToolSuggestion(toolName: string): { realTool: string; hint: string } | null {
  const entry = GHOST_TOOL_SUGGESTIONS[toolName];
  if (entry === undefined) return null;
  const live = getEnabledToolManifest().find((t) => t.name === entry.realTool);
  if (live === undefined) return null;
  return {
    realTool: entry.realTool,
    hint: `Use '${entry.realTool}'${describeToolParameters(live)} to ${entry.purpose}.`,
  };
}

// ── Per-run gate factory ──────────────────────────────────────────────────

/**
 * Create a per-run safety gate. The gate's `getDefinitions` callback reads
 * the LIVE enabled manifest on every `check` (so a tool toggled mid-run is
 * reflected immediately — the canonical gate is designed for this). The
 * config comes from the config owner (`getSafetyGateConfig` — no
 * configurables outside the global config file). The gate's loop-detection
 * window persists across `check` calls within the run (per-gate state).
 *
 * `getEnabledEntries` is a lazy callback (not a snapshot) so the gate always
 * sees the current tool set — mirroring the canonical gate's design intent.
 * `getRegisteredNames` names the FULL manifest (enabled AND disabled), so a
 * call to a registered-but-switched-off tool is refused as the standing
 * breaker-off fact instead of being lied about as "not registered".
 */
export function createRunSafetyGate(
  getEnabledEntries: () => readonly WebToolEntry[],
): ToolCallGate {
  const config: ToolCallGateConfig = getSafetyGateConfig();
  return createToolCallGate({
    getDefinitions: () => manifestEntriesToToolDefinitions(getEnabledEntries()),
    getRegisteredNames: () => getRegisteredToolNames(),
    config,
  });
}

/**
 * Record a gate block on the exposure counters. The tool executor calls this
 * at the gate's choke point (a blocked call) so the `hallucination.catchCount`
 * and `safety.hallucinationCount`/`hallucinationCatchCount` signals reflect a
 * REAL caught hallucination instead of a permanent zero. The write goes through
 * the exposure modules' own APIs (this bridge never mutates their state
 * directly) — the single web-UI owner of the gate is also the single web-UI
 * caller of the gate-block counters.
 */
export function recordGateBlock(): void {
  recordHallucinationGateBlock();
  recordSafetyHallucinationGateBlock();
}
