/**
 * Unified tool executor — the ONE executor for every tool in the
 * manifest.
 *
 * Every tool registered in `tools-bridge.ts` has a handler here. The
 * handler map (`TOOL_HANDLERS`) is the single dispatch table; the
 * `tool-manifest-executor-match` prevention test enforces that every
 * manifest name has a handler (and vice-versa).
 *
 * Tools run in the PROJECT directory (`ctx.projectRoot`), never the
 * server directory — this was a bug (the old executor used the server's
 * cwd for some operations). Path safety is enforced for every
 * filesystem-touching tool via `safeResolve` (no traversal above the
 * project root).
 *
 * Tools whose backend adapter is not configured (search_web, fetch_page,
 * read_docs, repo_question) return a typed `adapter_not_configured`
 * blocker — honest, never a silent fallback. Mutating git (git_commit)
 * is not exposed (governance blocker would go here if added).
 */

import { readdirSync, existsSync } from "node:fs";
import { recordEffectAsync, startResourceDeltaProbe, guarded } from "../kernel/canonical.ts";
// Type only: the process itself is created by the confinement owner's single
// door (`spawnPlanned`), which is why `spawn` is no longer imported here.
import type { ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";

import { recordToolCall } from "../observability/metrics-recorder.ts";
import { serverConfig, DEFAULT_TOOL_KILL_GRACE_MS } from "../kernel/config.ts";
import { getAllowedCommands, getPrivacyPolicy, performanceResourceDeltasEnabled } from "../kernel/harness-config.ts";
// The ONE owner of "does this child get the server's filesystem authority".
// It is imported here and nowhere else in the tool path, because this file
// holds the only spawn the model can direct.
import { prepareConfinedSpawn, readGuardianOutcome, spawnPlanned } from "../safety/landlock-runner.ts";
import { MapNotReadyError } from "../kernel/errors.ts";
import { resolveWithinProject } from "../filesystem/fs-gate.ts";
import { readFileRaw, writeFileRaw } from "../filesystem/editor-bridge.ts";
// The edit tools execute through the engine's governed transactional editor
// (preimage verify → syntax validation → atomic write → post-write verify →
// rollback) — never inline. The bridge remains the single owner of the bytes:
// the editor is handed the bridge's raw primitives as its reader/writer, so an
// edit and a plain save enforce the identical fs-gate + effect recording.
import { createEditorTools, type EditorToolArgs } from "../../engine/src/editor/edit-tools.ts";
import { type ResolveOptions } from "../../engine/src/editor/edit-resolve.ts";
import { type EditorLimits } from "../../engine/src/editor/edit-operations.ts";
// The editor exposure state is the live projection of the `editor` config
// section (seeded from bridlewise.config.json, written back through the config
// gate). The Settings toggles gate the edit tool's behavior HERE — the knobs
// are read from this one owner, never re-read from the file or hardcoded.
import { editorState } from "../../engine/src/shared/exposure/registrations/editor.ts";
import { isMcpToolName, mcpUnavailableReason, type McpUnavailabilityKey } from "../kernel/canonical.ts";
// Content search has ONE owner. The handler below states the question; the
// door resolves the bounds, runs the scan off the event loop, and renders it.
import { redactSecretFileText } from "../../engine/src/privacy/secret-files.ts";
import { searchProjectContent, formatContentSearchResult } from "../intelligence/content-search.ts";
// SPO: the content digest has ONE owner (`digest.ts`). The editor tools
// compare preimage hashes against files hashed elsewhere in the server, so a
// second local copy of the hash expression is a place for the encoding to
// drift into a preimage mismatch on a file nobody touched.
import { sha256 } from "../kernel/digest.ts";
import { webWarn } from "../observability/debug-bridge.ts";
import { TIMELINE_GATE_BLOCK_DOCUMENT } from "../../shared/constants.ts";
import type { ToolResultStore } from "../../engine/src/memory/unified/unified-tool-result-store.ts";
import { validateUiControlAction, describeUiControlAction, describeActionRequirements } from "./ui-control.ts";
// ARTIFACT_TYPES is the SINGLE owner of the artifact-kind list.
// It is lazy-loaded (like the bridges above) — a top-level import of
// `tools-bridge.ts` would transitively load the canonical chain at executor
// init and hit the pre-existing `createHash` TDZ (integrity.ts:24) in tests
// that import `executeToolCall` without first loading `tools-bridge.ts`.

// The intelligence / memory / quality / git bridges transitively load the
// canonical exposure + debug chain, which has a pre-existing circular
// import that calls `canonicalHash` (→ `createHash`) during module init.
// Importing them at the top of THIS module would trigger that TDZ in tests
// that import `executeToolCall`/`isToolExecutable` without first loading
// `run.ts`/`tools-bridge.ts`. They are lazy-loaded on first use instead:
// in the running server the chain is already loaded at startup (via
// tools-bridge → canonical), so the lazy require is a cheap cache hit.
import { createRequire } from "node:module";
const moduleRequire = createRequire(import.meta.url);
type IntelligenceBridge = typeof import("../intelligence/intelligence-bridge.ts");
type MemoryBridge = typeof import("../context/memory-bridge.ts");
type QualityBridge = typeof import("../awareness/quality-bridge.ts");
type GitOpsBridge = typeof import("../intelligence/git-ops-bridge.ts");
type ExtensionsBridge = typeof import("../integrations/extensions-bridge.ts");
type ToolsBridge = typeof import("./tools-bridge.ts");
type SafetyBridge = typeof import("../safety/safety-bridge.ts");
let _intel: IntelligenceBridge | undefined;
let _mem: MemoryBridge | undefined;
let _qual: QualityBridge | undefined;
let _git: GitOpsBridge | undefined;
let _ext: ExtensionsBridge | undefined;
let _tools: ToolsBridge | undefined;
let _redact: typeof import("../llm/redaction.ts") | undefined;
let _artifactCheck: typeof import("../safety/artifact-check.ts") | undefined;
let _safety: SafetyBridge | undefined;
function intel(): IntelligenceBridge {
  if (_intel === undefined) _intel = moduleRequire("../intelligence/intelligence-bridge.ts") as IntelligenceBridge;
  return _intel;
}
function mem(): MemoryBridge {
  if (_mem === undefined) _mem = moduleRequire("../context/memory-bridge.ts") as MemoryBridge;
  return _mem;
}
function qual(): QualityBridge {
  if (_qual === undefined) _qual = moduleRequire("../awareness/quality-bridge.ts") as QualityBridge;
  return _qual;
}
function git(): GitOpsBridge {
  if (_git === undefined) _git = moduleRequire("../intelligence/git-ops-bridge.ts") as GitOpsBridge;
  return _git;
}
function ext(): ExtensionsBridge {
  if (_ext === undefined) _ext = moduleRequire("../integrations/extensions-bridge.ts") as ExtensionsBridge;
  return _ext;
}
/**
 * Lazy-load the manifest owner (tools-bridge.ts) to read the SINGLE owner of
 * the artifact-kind list (`ARTIFACT_TYPES`). Lazy (not a top-level import) so
 * the canonical chain `tools-bridge → canonical → built-in-tools → integrity`
 * (which calls `createHash` during init — the pre-existing TDZ) is only
 * triggered at first use, after the server has booted and the chain is
 * cached. In the running server `tools-bridge.ts` is already loaded at boot
 * (run.ts + routes/tools.ts import it), so this is a cheap cache hit.
 */
function toolsBridge(): ToolsBridge {
  if (_tools === undefined) _tools = moduleRequire("./tools-bridge.ts") as ToolsBridge;
  return _tools;
}
/**
 * Lazy-load the PII redaction owner (redaction.ts — SPO/10). The
 * `fetch_memory` tool returns memory entries to the LLM; their content +
 * provenance must be redacted so a pasted secret in memory does not leak
 * to the model. Lazy for the same TDZ reason as the other bridges.
 */
function redact(): typeof import("../llm/redaction.ts") {
  if (_redact === undefined) _redact = moduleRequire("../llm/redaction.ts") as typeof import("../llm/redaction.ts");
  return _redact;
}
/**
 * Lazy-load the artifact runnability owner (artifact-check.ts). It parses an
 * artifact's script blocks with the same engine the browser will use, and
 * owns the measured sandbox-capability table. Lazy for consistency with the
 * other bridges (it has no canonical-chain dependency of its own).
 */
function artifactCheck(): typeof import("../safety/artifact-check.ts") {
  if (_artifactCheck === undefined) {
    _artifactCheck = moduleRequire("../safety/artifact-check.ts") as typeof import("../safety/artifact-check.ts");
  }
  return _artifactCheck;
}
/**
 * Lazy-load the safety-bridge owner (SPO). The safety bridge
 * imports the canonical `createToolCallGate` (via canonical.ts) which
 * transitively loads the canonical chain — the same TDZ concern as the
 * other bridges. Lazy-loaded so tests that import `executeToolCall` without
 * first loading the canonical chain don't trigger the TDZ. The bridge owns
 * `gateBlockKind` (typed reason → kind for SSE) + `ghostToolSuggestion` (the
 * ghost-tool hint map — moved here from tool-executor.ts).
 */
function safety(): SafetyBridge {
  if (_safety === undefined) _safety = moduleRequire("../safety/safety-bridge.ts") as SafetyBridge;
  return _safety;
}
// SPO: the per-run safety gate type (type-only import — erased at
// runtime, no TDZ). The gate instance is created per-run in the run route
// and passed via `ToolExecutionContext.gate`; the executor calls
// `gate.check` BEFORE dispatching.
import type { ToolCallGate, ToolCall, ResourceDelta } from "../kernel/canonical.ts";

// ── Types ──

/**
 * SPO: when the safety gate blocks a tool call BEFORE dispatch, the
 * result carries a `gateBlock` describing the block so the run route can
 * emit a "hallucination" SSE event + persist it.
 * The `kind` is classified by the safety-bridge owner (`gateBlockKind`, from the gate's typed reason).
 * The `suggestion` is the real tool name for ghost tools (null for schema/
 * loop blocks). Present ONLY when the gate blocked the call; absent for
 * normal tool results (backward-compatible — allows a refactor,
 * but the optional field keeps existing callers working without changes).
 */
export type GateBlock = Readonly<{
  kind: import("../safety/safety-bridge.ts").GateBlockKind;
  toolName: string;
  callId: string;
  suggestion: string | null;
  /**
   * The argument FIELDS that failed schema validation — the gate's own
   * structured detail, carried through to the tool effect's ledger event
   * (the gate-block document) so the ledger answers "WHICH fields failed"
   * without parsing the refusal message's prose. Absent for the other block
   * kinds and for a payload that was not a JSON object at all.
   */
  failedFields?: readonly string[];
  /**
   * Present (true) when this block ESCALATED — the gate's block-sequence
   * bookkeeping counted at least `blockEscalationAfter` consecutive
   * identical blocks of this tool (same reason, same failed fields). The
   * refusal message names the repetition; this flag carries the fact onto
   * the ledger's gate-block document so the dig answers "did the harness
   * notice the refusal loop" without parsing prose.
   */
  escalated?: true;
  /**
   * Present (true) when the tool was AUTO-TRIPPED by this block or is
   * already tripped for the rest of the run — the gate's streak of
   * consecutive identical blocks reached `blockAutoTripAfter`, so the tool
   * is off and every further call is refused with the terminal honest
   * message. The run loop reads this flag to route the trip through the
   * breaker owner (the row flip + the permission event), and the ledger's
   * gate-block document carries it so the dig answers "was the tool
   * tripped" from the row.
   */
  autoTripped?: true;
  /**
   * The streak count the trip fired at (or the standing trip was recorded
   * at). Present only with `autoTripped`.
   */
  autoTrippedAfter?: number;
}>;

export type ToolCallResult = Readonly<{
  readonly success: boolean;
  readonly output: string;
  readonly gateBlock?: GateBlock;
  /**
   * The LEDGER event id of the tool event this call recorded — present
   * exactly when the effect wrapper's record landed (a ledger is attached
   * and the sink returned its result).
   *
   * Exists so a PAIRED event can name this call's row as its parent: a
   * gate-blocked call is recorded twice by design (the tool event here,
   * plus the gate's inline account persisted by the run loop), and the
   * inline account is a DEPENDENT view of the same incident only when it
   * carries this id as `parentEventId`. The ledger's own foreign key
   * (`event_log.parent_event_id`) is the pairing vocabulary — no parallel
   * correlation is invented here.
   */
  readonly toolEventId?: string;
  /**
   * True when the tool did not run because it is missing or unconfigured
   * (adapter not installed, MCP server not connected). The event-feed
   * investigation uses this typed flag to pause-and-ask rather than
   * treating the failure as a silent workaround.
   */
  readonly unavailable?: boolean;
  /**
   * WHY the tool was unavailable, when a typed MCP refusal carried the
   * cause (decode once, in the executor's catch). The investigation turns
   * this key into the correct user-facing sentence — a transient restart
   * never reads as "missing or unconfigured".
   */
  readonly unavailableReason?: McpUnavailabilityKey;
  /**
   * The arguments the executor ACTUALLY DISPATCHED, present exactly when
   * the safety gate REWROTE the call — partial-argument memory merging a
   * retained partial into the model's new delta. The run's record (the
   * tool_result frame and the persisted row) must show what RAN, not the
   * delta the model sent: a merged artifact call that records only its
   * delta renders an unreachable frame (UIE-035) — the content the tool
   * received lives nowhere the surface can read. Absent when nothing was
   * rewritten: the caller's own `arguments` are already the dispatched
   * whole, and a second copy of them would be a lie about which path
   * carried them.
   */
  readonly dispatchedArguments?: Readonly<Record<string, unknown>>;
}>;

export type ToolExecutionContext = Readonly<{
  readonly projectRoot: string;
  /**
   * The SERVER-RESOLVED authenticated user id (SPO). MANDATORY for
   * tools that touch user-scoped resources (e.g. `fetch_memory` queries the
   * memory store, which is per-user). The run route threads `active.userId`
   * here; a tool that needs it denies the call when it is missing (deny-by-
   * default — the tool returns a typed error instead of leaking another
   * user's data). Optional because most tools (read_file, edit_*, git_*)
   * are project-scoped, not user-scoped — they ignore this field.
   */
  readonly userId?: string;
  /**
   * SPO: the per-run safety gate. When present, the executor calls `gate.check`
   * BEFORE dispatching to the tool handler. Blocked calls return a typed
   * error result with `gateBlock` (so the run route emits a "hallucination"
   * SSE event + persists it). The gate is the CHOKE POINT: no caller of
   * `executeToolCall` can bypass it — the check is inside the executor
   * (lowest-level enforcement). Optional because non-LLM callers (tests)
   * may omit it; the production caller (run.ts) ALWAYS passes it.
   */
  readonly gate?: ToolCallGate;
  /**
   * SPO: the LLM tool-call id (for the gate check + the `gateBlock`).
   * The route threads `event.callId` here so the gate's blocked result can
   * carry the original call id. Defaults to "unknown" when absent (tests).
   */
  readonly callId?: string;
  /**
   * The run's tool-result store — the full text behind any payload the
   * context assembler sent as a reference instead of in full.
   *
   * It is the SAME store instance the run's context manager holds, threaded
   * rather than rebuilt: a second store would be a second answer to "what is
   * the full text behind this id", and the model was handed exactly one id.
   * Per-run, so an id from another conversation resolves to nothing rather
   * than to another user's document.
   */
  readonly toolResults?: ToolResultStore;
  /**
   * Agent-delegation context, threaded by the run route for every tool call.
   * Only the agent tools read these (a delegation needs the run's identity,
   * abort signal, credential and the run's enabled manifest); every other
   * tool ignores them. Optional at the executor level so non-run callers
   * (tests) can omit them — the agent bridge refuses with a guided error
   * when they are absent (deny-by-default), so a tool call that needs a run
   * and has none is told, never silently handed a wrong context.
   */
  readonly runId?: string;
  readonly runSignal?: AbortSignal;
  readonly credential?: import("../llm/providers.ts").ProviderCredential;
  readonly parentManifest?: readonly import("./tools-bridge.ts").WebToolEntry[];
  /**
   * The run's event-feed safety runtime. Optional so non-run callers (tests)
   * omit it. When present, every completed call — parent or delegated — is
   * recorded on THIS instance. The executor is the single choke point; the
   * wrapper that re-enters it must not record again.
   */
  readonly safetyRuntime?: Pick<import("../safety/safety-runtime-bridge.ts").SafetyRuntime, "recordToolCall">;
  /** The parent run's current 1-based turn, used when a delegated call records. */
  readonly safetyTurn?: number;
}>;

/**
 * A tool handler may answer synchronously or with a promise.
 *
 * MOST TOOLS STAY SYNCHRONOUS ON PURPOSE. Only work that genuinely blocks
 * needs to move off the loop, and a blanket conversion would have cost every
 * in-memory tool a microtask for nothing while widening the surface where an
 * un-awaited promise could hide. The dispatcher awaits the result either way,
 * so a handler can become async later without touching a call site.
 */
type ToolHandler = (
  ctx: ToolExecutionContext,
  args: Readonly<Record<string, unknown>>,
) => ToolCallResult | Promise<ToolCallResult>;

// ── Configurables (allowed commands + bounds for execute_command) ──
// ALL configurables live in the harness config file
// (`tools.allowedCommands`), never a hardcoded Set in source. The web UI
// reads them through the centralized `harness-config.ts` reader so the config
// is the sole source of truth. `getAllowedCommands` answers from the resolved
// settings snapshot, which is refreshed at each request, at each run's start
// and by the store watch when the file changes, so editing the config takes
// effect without a server restart — within a running run too.
//
// Shell commands that CHANGE FILES. The backend gates file mutation on a
// session write set; this server has no such governance over a subprocess, so
// a command that writes through the shell escapes both the write set and the
// editor's recording and rollback. The model must use the editor tools.
//
// This used to be prose alone, and the config listed all six anyway — the
// invariant had been false for as long as nobody re-read the paragraph. It is
// the SINGLE owner of the answer now: the executor refuses on it and the
// `execute-command-mutation-gate` test asserts the refusal by driving the
// door, so the comment and the behaviour cannot disagree again.

export const SHELL_FILE_MUTATION_COMMANDS: ReadonlySet<string> = Object.freeze(
  new Set(["touch", "mkdir", "rmdir", "cp", "mv", "rm", "sed", "awk", "tee", "dd", "chmod", "chown", "ln", "truncate", "install"]),
) as ReadonlySet<string>;

// Execute-command bounds. Now sourced from the global config's
// `tools.defaultBounds` section.
// The harness-config reader supplies the authoritative values; these
// helpers resolve them at call time so a config edit takes effect without
// a restart. Safe floors are used only when the config section is absent.
import { getToolBounds, getArtifactMaxBytes, getIntelligenceSearchDefaultLimit, getIntelligenceSearchMaxLimit, getIntelligenceRetrieveDefaultLimit, getIntelligenceRetrieveMaxLimit, getToolDependencyGraphMaxCycles, getRepositoryMapSampleCount, getArtifactIdLength } from "../kernel/harness-config.ts";

function toolTimeoutMs(): number {
  return getToolBounds().timeoutMs;
}
function toolMaxCaptureBytes(): number {
  return getToolBounds().maxOutputBytes;
}
function toolMaxFileBytes(): number {
  return getToolBounds().maxFileBytes;
}

// ── Security: path resolution ──
//
// (filesystem access owner): the path-traversal logic is owned by
// `server/fs-gate.ts` (`resolveWithinProject` — the SINGLE owner of the
// "resolve + within-root" check). `safeResolve` is now a thin adapter that
// delegates to `resolveWithinProject` + maps the throw to a null (the
// tool-executor's error API returns { ok: false, error }, not a throw).
// This removes the duplicate resolve+startsWith logic (No Scattered
// Helpers). `resolveWithinProject` also rejects null bytes +
// empty paths (defense-in-depth — the LLM's tool args are untrusted).

function safeResolve(projectRoot: string, inputPath: string): { ok: true; path: string } | { ok: false; error: string } {
  try {
    return { ok: true, path: resolveWithinProject(inputPath, projectRoot) };
  } catch (err) {
    // Surface the typed error message (PathTraversalError / BadRequestError
    // from fs-gate) instead of discarding it — a null-byte path produces
    // "Path contains invalid characters", an escaping path produces the
    // traversal message, both more accurate than a generic "outside the
    // project root" that hides the real reason.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function requireStringArg(args: Readonly<Record<string, unknown>>, name: string): string | null {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0) return null;
  return value;
}

function resolveToolPath(ctx: ToolExecutionContext, inputPath: string): { ok: true; path: string } | { ok: false; error: string } {
  const resolved = safeResolve(ctx.projectRoot, inputPath);
  if (!resolved.ok) {
    return { ok: false, error: `Error: '${inputPath}': ${resolved.error}` };
  }
  return { ok: true, path: resolved.path };
}

// ── Filesystem tools ──

/**
 * `read_file` tool — reads a project file's content. Routes through the
 * editor bridge's `readFileRaw` (SPO: the bridge is the single owner
 * of file read/write/edit/delete). The `maxBytes` bound is the tool's own
 * configurable limit (toolMaxFileBytes from harness-config); the bridge
 * checks stat.size BEFORE reading content into memory (prevents OOM on
 * huge files). The bridge enforces fs-gate (path-traversal via
 * resolveWithinProject) at the choke point. The old `safeResolve` +
 * `existsSync` + `statSync` + `readFileSync` dance is removed — the
 * bridge owns all of that.
 */
function toolReadFile(ctx: ToolExecutionContext, args: Readonly<Record<string, unknown>>): ToolCallResult {
  const filePath = requireStringArg(args, "path");
  if (filePath === null) return { success: false, output: "Error: 'path' parameter is required and must be a non-empty string." };
  try {
    const { content } = readFileRaw(filePath, ctx.projectRoot, undefined, toolMaxFileBytes());
    // A secret file (by name) reaches the model with its values redacted and its keys visible.
    return { success: true, output: redactSecretFileText(filePath, content, getPrivacyPolicy()) };
  } catch (err) {
    return { success: false, output: err instanceof Error ? `Error: ${err.message}` : `Error reading file: ${String(err)}` };
  }
}

function toolListFiles(ctx: ToolExecutionContext, args: Readonly<Record<string, unknown>>): ToolCallResult {
  const dirPath = requireStringArg(args, "path") ?? ".";
  const resolved = resolveToolPath(ctx, dirPath);
  if (!resolved.ok) return { success: false, output: resolved.error };
  if (!existsSync(resolved.path)) return { success: false, output: `Error: directory not found: ${resolved.path}` };
  try {
    const entries = readdirSync(resolved.path, { withFileTypes: true })
      .filter((d) => !d.name.startsWith("."))
      .map((d) => ({ name: d.name, isDir: d.isDirectory() }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    const lines = entries.map((e) => `${e.name}${e.isDir ? "/" : ""}`);
    return { success: true, output: lines.join("\n") || "(empty directory)" };
  } catch (err) {
    return { success: false, output: `Error listing directory: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * `search_code` — regex over the project's file CONTENT.
 *
 * The walk itself used to live here, inline and synchronous. Two things were
 * wrong with that beyond its placement:
 *
 * - It ran the model's own regular expression on the server's event loop, so a
 *   pattern that backtracks catastrophically stopped the whole server for as
 *   long as it took. It is now executed on a worker thread the pool can kill.
 *
 * - It stopped at its display quota and returned the prefix with no indication
 *   there was more, so a partial answer and a complete one were the same text.
 *   The engine now counts past the quota and the result states its own
 *   completeness.
 *
 * The handler keeps only what a handler should: argument validation, and
 * turning a typed refusal into the sentence the model reads.
 */
async function toolSearchCode(ctx: ToolExecutionContext, args: Readonly<Record<string, unknown>>): Promise<ToolCallResult> {
  const pattern = requireStringArg(args, "pattern");
  if (pattern === null) return { success: false, output: "Error: 'pattern' parameter is required." };
  try {
    const result = await searchProjectContent(ctx.projectRoot, pattern);
    return { success: true, output: formatContentSearchResult(result) };
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "content_search_invalid_pattern") {
      webWarn("tool-executor", "invalid regex pattern from tool call", () => ({ pattern, error: err instanceof Error ? err.message : String(err) }));
      return { success: false, output: `Error: invalid regex pattern: ${pattern}` };
    }
    if (code === "content-search_worker_timeout") {
      // Named as a deadline rather than a generic failure, because the action
      // the model should take is specific: the pattern was too expensive, and
      // a narrower one will succeed where a retry of the same one will not.
      return {
        success: false,
        output: `Error: the search for '${pattern}' exceeded its time limit and was stopped. This usually means the pattern backtracks heavily; make it more specific (anchor it, or replace nested quantifiers) and try again.`,
      };
    }
    return { success: false, output: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── execute_command (runs in the project directory) ──

async function toolExecuteCommand(ctx: ToolExecutionContext, args: Readonly<Record<string, unknown>>): Promise<ToolCallResult> {
  const command = requireStringArg(args, "command");
  if (command === null) return { success: false, output: "Error: 'command' parameter is required." };
  if (/\s/.test(command)) {
    return { success: false, output: `Error: 'command' must be the executable name only (no arguments/spaces). Got: ${command}` };
  }
  // the allowed list comes from the harness config (dynamic, not a
  // hardcoded Set). Re-read when the config file changes.
  const allowedCommands = getAllowedCommands();
  // The exclusion above was written as a comment and contradicted by the
  // config, which listed all six. A security invariant that only a comment
  // states is not enforced, and this one had already stopped being true. The
  // door now decides, so an operator adding one back gets a refusal that says
  // what to use instead rather than a shell that quietly bypasses the write
  // set. Checked BEFORE the allowlist so the message names the real reason.
  if (SHELL_FILE_MUTATION_COMMANDS.has(command)) {
    return {
      success: false,
      output:
        `Error: '${command}' changes files through the shell, which is not governed by the write set here. ` +
        `Use the edit tool instead — so the change is recorded and reversible.`,
    };
  }
  if (!allowedCommands.has(command)) {
    return { success: false, output: `Error: command '${command}' is not in the allowed list. Allowed: ${[...allowedCommands].join(", ")}` };
  }
  const cmdArgs = Array.isArray(args.args) ? (args.args as unknown[]).filter((a): a is string => typeof a === "string") : [];
  // PROACTIVE #5: a caller-supplied cwd that escapes the project root is a
  // typed error, NOT a silent fallback to projectRoot (silent fallbacks are
  // prohibited — rule: no silent workarounds). This also prevents a model
  // from running commands in an unintended directory.
  const cwdRaw = typeof args.cwd === "string" && args.cwd.length > 0 ? args.cwd : null;
  const cwdResolved = cwdRaw === null
    ? ({ ok: true as const, path: ctx.projectRoot })
    : safeResolve(ctx.projectRoot, cwdRaw);
  if (!cwdResolved.ok) {
    return { success: false, output: `Error: cwd '${cwdRaw}': ${cwdResolved.error}` };
  }
  const cwd = cwdResolved.path;
  try {
    // `cwd` may be a subdirectory the model chose; the confinement boundary
    // is the PROJECT root, which is the thing the user selected and the only
    // boundary they consented to.
    return await spawnAsyncSafe(command, cmdArgs, cwd, ctx.projectRoot, ctx.runSignal);
  } catch (err) {
    return { success: false, output: `Error spawning command: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** How long a killed child gets to die politely before it is SIGKILLed.
 *  Owned by `server/config.ts`, like every other operational tunable. */
const KILL_GRACE_MS = DEFAULT_TOOL_KILL_GRACE_MS;

/** Why a spawn stopped. `abandoned` is the state task #45 asked for. */
type SpawnEnding = "exited" | "abandoned_timeout" | "abandoned_output_limit" | "spawn_failed";

/**
 * Run a child process WITHOUT blocking the event loop, and give it a
 * terminal state whatever happens to it.
 *
 * ── WHY ASYNC `spawn` AND NOT THE WORKER POOL ───────────────────────────
 *
 * `server/worker-pool.ts` exists and tools never used it, and that remains
 * the right call. The database needed threads because `node:sqlite`'s driver
 * is synchronous BY DESIGN and has no async form — there was no other way to
 * get it off the loop. `child_process.spawn` already has one.
 *
 * The difference is not merely convenience. Staying on this thread is what
 * keeps `AsyncLocalStorage` intact, and therefore what keeps CAUSALITY
 * RECORDED. A ledger append on a worker does not fail — it records with no
 * causality at all, silently, which is the worst possible failure for a
 * product whose claim is that an empty cell is provably empty. That hazard
 * was the highest-risk part of the database migration and it is not worth
 * re-introducing where an async API already exists. `recordEffectAsync`
 * below runs inside `withSpan`, so the span survives every `await` here.
 *
 * ── WHY THE TIMEOUT IS THE POINT, NOT A DETAIL ──────────────────────────
 *
 * `spawnSync`'s timeout was real but it was paid by the WHOLE PROCESS: with a
 * 30,000ms default, one `execute_command` froze every other user's stream,
 * every request and every keepalive for thirty seconds. Nothing else could
 * run — not the SSE heartbeat that tells a client the run is alive, not the
 * timer that would have reported it.
 *
 * Asynchronously, the timeout costs nobody anything, so it can finally be
 * ENFORCED rather than endured. Every path below ends in exactly one
 * `finish(...)`, so there is no route by which a tool call stays "running"
 * for ever: it exits, or it is abandoned and SAYS SO.
 *
 * ── WHAT AN ABANDONED CALL SAYS ─────────────────────────────────────────
 *
 * Not "still working", and not a bare failure either. The output JSON carries
 * `abandoned: true`, the reason, the limit that was hit, and the partial
 * stdout/stderr captured before the kill — because a command killed at 30s
 * usually printed something first, and throwing that away turns a diagnosable
 * hang into a mystery. This is DESIGN-PERFORMANCE L3 for a subprocess: a
 * thing that did not finish must say so, in plain words, naming what it could
 * not reach.
 */
function spawnAsyncSafe(
  command: string,
  cmdArgs: readonly string[],
  cwd: string,
  projectRoot: string,
  runSignal?: AbortSignal,
): Promise<ToolCallResult> {
  const timeoutMs = toolTimeoutMs();
  const maxCapture = toolMaxCaptureBytes();
  // RECORDING CHOKE POINT for the `process` effect kind: every
  // execute_command subprocess spawns through this function, so the spawn →
  // exit is recorded here as one `process` effect with the REAL exit code
  // (carried in the output JSON) and the real blocking duration. The event
  // nests under the enclosing `tool:execute_command` span via the ambient
  // span stack — no argument is threaded.
  //
  // THE SAME PROPERTY MAKES IT THE CONFINEMENT CHOKE POINT. This is the one
  // place in the server where a model-chosen program acquires the server's
  // filesystem authority, so it is the one place the authority can be taken
  // away — see `server/landlock-runner.ts`. Deciding here rather than in
  // `toolExecuteCommand` is deliberate: a second tool that ever needs to
  // spawn something must come through this function to be recorded at all,
  // and therefore cannot acquire an unconfined child by accident.
  //
  // KNOWN, DELIBERATE GAP — the subprocess FILE-WRITE bypass: a spawned
  // command may write files, and those writes never cross the editor
  // bridge's file-effect choke point. Nothing real captures which paths a
  // child process touched (no syscall tracing here), so NO file list is
  // recorded — fabricating one from guesses would be worse than the gap.
  // What IS recorded, honestly: that this process ran, as what command,
  // with what exit code and duration. Per-file attribution for subprocess
  // writes is impossible today and is reported as such, not papered over.
  // Confinement narrows the DAMAGE that gap can carry — a write it cannot
  // see is at least a write inside the project — but it does not close it,
  // and it is not reported as closing it.
  const plan = prepareConfinedSpawn({ command, args: cmdArgs, projectRoot });
  if (plan.kind === "refused") {
    // The command DID NOT RUN. Reported as a failure carrying the refusal's
    // own code, so neither the model nor the reader can mistake it for a
    // command that ran and produced nothing.
    return Promise.resolve({
      success: false,
      output: JSON.stringify({
        confinement: "refused",
        confinementCode: plan.code,
        ran: false,
        ending: "refused_unconfined",
        message: plan.message,
      }),
    });
  }
  /** What the reader is told about this specific child, measured here. */
  const confinement = plan.kind === "confined" ? "confined" : "unconfined";
  const confinementReason = plan.kind === "confined"
    ? `Restricted to ${plan.projectRoot} by the self-protection guardian.`
    : plan.reason;
  const releaseSpec = plan.kind === "confined" ? plan.release : (): void => {};
  return recordEffectAsync(
    "process",
    command,
    async (): Promise<ToolCallResult> =>
      new Promise<ToolCallResult>((resolve) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        let ending: SpawnEnding = "exited";
        let killTimer: NodeJS.Timeout | undefined;

        const finish = (result: ToolCallResult): void => {
          // EXACTLY ONE terminal state. `close` can arrive after a timeout
          // kill, `error` can arrive after `close`, and an output-limit kill
          // produces both — without this latch the promise's first settle
          // wins silently and the later paths leak timers.
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (killTimer !== undefined) clearTimeout(killTimer);
          // The spec file outlives nothing: the guardian read it before it
          // restricted itself, so the moment this child has a terminal state
          // the file is gone. Idempotent, so the `error`-then-`close` order
          // cannot double-remove it.
          releaseSpec();
          resolve(result);
        };

        /** Report what actually happened, with whatever output we captured. */
        const report = (
          exitCode: number | null,
          signal: string | null,
          why: SpawnEnding,
        ): void => {
          const abandoned = why !== "exited";
          // Under confinement the process that exited is the GUARDIAN, and it
          // has two quite different endings: it restricted itself and became
          // the command, or it refused and the command never existed. Asking
          // it which — instead of assuming the first — is what keeps a refusal
          // from being reported as a command that ran and failed.
          const outcome = plan.kind === "confined"
            ? readGuardianOutcome(exitCode, stderr)
            : ({ kind: "payload_ran", stderr } as const);
          if (outcome.kind === "refused_before_exec") {
            finish({
              success: false,
              output: JSON.stringify({
                confinement: "refused",
                confinementCode: String(outcome.code),
                ran: false,
                ending: "refused_unconfined",
                message:
                  `Confinement is turned on and the rules for this project could not be enforced, so '${command}' was not run: ${outcome.message}`,
                // Whatever the command would have said is not available,
                // because there was no command. Stating that beats an empty
                // string that reads like silence from a program that ran.
                stdout: "",
                stderr: "",
              }),
            });
            return;
          }
          finish({
            success: exitCode === 0 && !abandoned,
            output: JSON.stringify({
              exitCode,
              signal,
              // Kept for wire compatibility with every existing consumer.
              timedOut: why === "abandoned_timeout",
              abandoned,
              // The terminal state, in words, for task #45. A reader must
              // never have to infer "this died" from an absence.
              ending: why,
              ...(why === "abandoned_timeout" ? { timeoutMs } : {}),
              ...(why === "abandoned_output_limit" ? { maxOutputBytes: maxCapture } : {}),
              // WHAT AUTHORITY THIS CHILD ACTUALLY HAD. Stated on every
              // result, including the successful ones, because "confined"
              // and "not confined" are equally load-bearing facts and only
              // printing one of them turns silence into an implication.
              confinement,
              confinementReason,
              ran: true,
              // Partial output is EVIDENCE, not noise: a command killed at
              // its timeout has usually already said where it got stuck.
              stdout,
              // The guardian's own confirmation line is removed: it is not
              // something the command said, and handing it over as if it were
              // teaches the model to explain a clean run as an error.
              stderr: outcome.stderr,
            }),
          });
        };

        /** SIGTERM, then SIGKILL — a child that ignores TERM cannot win. */
        const endChild = (child: ChildProcess): void => {
          try {
            child.kill("SIGTERM");
          } catch (err) {
            // Already gone — the `close` handler still reports the terminal
            // state, so this is not a failure. It IS worth saying, because a
            // kill that silently never lands is how a bound stops being one.
            webWarn("tool-executor", "SIGTERM to tool subprocess did not land", () => ({
              command,
              error: err instanceof Error ? err.message : String(err),
            }));
          }
          killTimer = setTimeout(guarded("tools.process.kill-escalation", () => {
            try {
              child.kill("SIGKILL");
            } catch (err) {
              // Reaped between the two signals — the ordinary case, and the
              // desired end state either way. Reported rather than swallowed
              // so a SIGKILL that never lands is visible.
              webWarn("tool-executor", "SIGKILL to tool subprocess did not land", () => ({
                command,
                error: err instanceof Error ? err.message : String(err),
              }));
            }
          }), KILL_GRACE_MS);
          killTimer.unref();
        };

        let child: ChildProcess;
        try {
          child = spawnPlanned(plan, {
            cwd,
            env: serverConfig.subprocessEnv,
            stdio: ["ignore", "pipe", "pipe"],
            // A cancelled run must stop the child. The timeout below is a
            // resource bound for a command that hangs; it is not the run abort.
            ...(runSignal !== undefined ? { signal: runSignal } : {}),
          });
        } catch (err) {
          releaseSpec();
          resolve({
            success: false,
            output: `Error: ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }

        const timer = setTimeout(guarded("tools.process.timeout", () => {
          ending = "abandoned_timeout";
          endChild(child);
          // Reported NOW, not when the child finally dies. The caller's
          // question is "is this still working?", and the answer is already
          // known — waiting for the corpse would re-create the stuck beat.
          report(null, "SIGTERM", "abandoned_timeout");
        }), timeoutMs);
        // The run must not be held open by this timer alone.
        timer.unref();

        /** Capture up to the cap; past it, the child is stopped. `spawnSync`
         *  enforced this via `maxBuffer` — done by hand here, because an
         *  unbounded child would otherwise grow the heap without limit. */
        const capture = (which: "out" | "err") => (chunk: Buffer | string): void => {
          const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
          if (which === "out") {
            if (stdout.length < maxCapture) stdout = (stdout + text).slice(0, maxCapture);
          } else if (stderr.length < maxCapture) {
            stderr = (stderr + text).slice(0, maxCapture);
          }
          if (stdout.length >= maxCapture && stderr.length >= maxCapture && !settled) {
            ending = "abandoned_output_limit";
            endChild(child);
            report(null, "SIGTERM", "abandoned_output_limit");
          }
        };
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        const captureOut = guarded("tools.process.stdout", capture("out"));
        const captureErr = guarded("tools.process.stderr", capture("err"));
        child.stdout?.on("data", captureOut);
        child.stderr?.on("data", captureErr);

        child.on("error", guarded("tools.process.error", (err: Error) => {
          finish({ success: false, output: `Error spawning command: ${err.message}` });
        }));
        child.on("close", guarded("tools.process.close", (code: number | null, signal: string | null) => {
          report(code, signal, ending === "exited" ? "exited" : ending);
        }));
      }),
    {
      // Failure is result-signalled (`{ success: false }`), never thrown —
      // without `failedWhen` every non-zero exit would record "succeeded".
      failedWhen: (r) => !r.success,
      // The output JSON already carries exitCode/signal/timedOut/stderr —
      // the real observed failure detail, not a summary invented here.
      errorOf: (r) => ({ message: r.output, code: "process_failed" }),
    },
  );
}

// ── Editor tools (governed — preimage + write-set + atomic write + rollback) ──
//
// The edit tools execute through the engine's governed transactional editor
// (`createTransactionalEditor` — the SINGLE owner of edit governance), never
// inline. The inline handlers they replaced computed the new content and
// called `writeAtomic` themselves, which meant every governance the engine
// built was skipped: no syntax validation (a broken file was written and
// kept), no post-write verification (a torn/incorrect write was reported as
// success), and no rollback (a post-write mismatch left the wrong bytes on
// disk permanently). All of that now runs, because the editor is the only
// path an edit can take.
//
// The web server keeps its own gates, enforced at the SAME choke point as
// every other filesystem operation: the editor does not touch the filesystem
// itself. It is handed the editor bridge's raw primitives as its file reader
// + atomic writer, so an edit passes through `readFileRaw`/`writeFileRaw`
// exactly the way a save from the editor room does — identical fs-gate
// (project-root containment, symlink + hardlink refusal), identical effect
// recording in the timeline ledger. There is one gate model, owned by the
// bridge; the editor's own path-shape validation (no absolute/traversal/
// backslash paths) and write-set authorization run ON TOP of it, never
// instead of it.
//
// The write set is derived per call from the one path the model named, so an
// edit can touch exactly the file it declared and nothing else — a governed
// refusal (`write_set_denied`) rather than a silent write.

/** The editor's file-size ceiling follows the web server's edit cap. */
function governedEditorLimits(): Partial<EditorLimits> {
  return { maxFileBytes: serverConfig.maxFileEditBytes };
}

/**
 * The ONE editor-tools factory for the executor. It builds the single `edit`
 * tool's handler on the engine's governed editor, wiring the editor's reads
 * and atomic writes through the filesystem bridge (the bytes owner) so an edit
 * and a plain save enforce the identical fs-gate + effect recording. The
 * resolver knobs (heal cascade, fuzzy threshold) come from the `editor`
 * config section via the exposure projection, so the Settings toggles gate the
 * behavior — never a hardcoded literal.
 *
 * Built per call: the write set is exactly the one path being edited, so an
 * edit can touch exactly the file it declared and nothing else.
 */
function editToolsForPath(ctx: ToolExecutionContext, path: string): ReturnType<typeof createEditorTools> {
  const resolveOptions: ResolveOptions = {
    healCascadeEnabled: editorState.healCascadeEnabled,
    fuzzyThreshold: editorState.fuzzyThreshold,
  };
  return createEditorTools(
    {
      repositoryRoot: ctx.projectRoot,
      writeSet: new Set([path]),
      reader: (resolvedPath: string) => readFileRaw(resolvedPath, ctx.projectRoot).content,
      atomicWriter: (resolvedPath: string, content: string) => {
        writeFileRaw(resolvedPath, content, ctx.projectRoot);
        return { success: true as const };
      },
      editorConfig: governedEditorLimits(),
      // A file in a language the editor has no parser for (.txt, .md, …) is not
      // a syntax error — refuse only when a registered validator actually fails.
      skipUnknownExtensions: true,
    },
    resolveOptions,
  );
}

/**
 * The ONE model-facing edit tool: `edit(path, oldString, newString)`.
 *
 * The model supplies a STRING preimage, never a hash or byte offsets. The
 * resolver (`edit-resolve.ts`) turns it into a byte range and computes the
 * preimage hash itself; the governed editor then applies the change with full
 * governance (syntax → atomic write → post-write verify → rollback). The whole
 * safety contract (sentinel-only whole-file, refused empty-oldString on an
 * existing file, refused ambiguity, verified delete) lives in the engine's
 * `createEditorTools` handler — this handler is a thin bridge that maps the
 * engine's structured result onto the executor's `{ success, output }` shape
 * so the model gets an actionable retry message on every failure.
 */
function toolEdit(ctx: ToolExecutionContext, args: Readonly<Record<string, unknown>>): ToolCallResult {
  const path = requireStringArg(args, "path");
  if (path === null) {
    return { success: false, output: "Error: 'path' is required." };
  }
  const oldString = typeof args.oldString === "string" ? args.oldString : (args.oldString === undefined ? undefined : null);
  const newString = typeof args.newString === "string" ? args.newString : (args.newString === undefined ? "" : null);
  if (oldString === null || newString === null) {
    return { success: false, output: "Error: 'oldString' and 'newString' must be strings (newString may be \"\" to delete)." };
  }
  const editArgs: EditorToolArgs = oldString === undefined
    ? { path, newString }
    : { path, oldString, newString };
  const result = editToolsForPath(ctx, path).handlers.edit!(editArgs);
  if (!result.success) {
    const message = typeof result.feedback?.["message"] === "string" ? result.feedback["message"] : "edit failed";
    return { success: false, output: `Error: ${message}` };
  }
  return {
    success: true,
    output: JSON.stringify({
      ok: true,
      path: result.path,
      operation: result.operation,
      strategy: result.strategy,
      postimageHash: result.postimageHash,
    }),
  };
}

// ── Intelligence tools ──

function toolGetRepositoryMap(ctx: ToolExecutionContext): ToolCallResult {
  try {
    const map = intel().getRepositoryMap(ctx.projectRoot);
    const summary = {
      files: map.files.length,
      modules: map.modules.length,
      symbols: map.modules.reduce((n, m) => n + m.symbols.length, 0),
      moduleSample: map.modules.slice(0, getRepositoryMapSampleCount()).map((m) => ({ path: m.path, symbols: m.symbols.length, lines: m.lineCount })),
    };
    return { success: true, output: JSON.stringify(summary) };
  } catch (err) {
    // a typed ProjectPathError (stale enc:, missing, not a dir)
    // now surfaces a clear, actionable message to the LLM instead of
    // silent zeros. The LLM can tell the user to re-create the project.
    return { success: false, output: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function toolSearchSymbols(ctx: ToolExecutionContext, args: Readonly<Record<string, unknown>>): ToolCallResult {
  const query = requireStringArg(args, "query");
  if (query === null) return { success: false, output: "Error: 'query' is required." };
  const limit = Math.min(typeof args.limit === "number" && Number.isInteger(args.limit) && args.limit > 0 ? args.limit : getIntelligenceSearchDefaultLimit(), getIntelligenceSearchMaxLimit());
  try {
    const results = intel().searchCodeSymbols(ctx.projectRoot, query, limit);
    // The symbol index does not read every language it indexes files from —
    // measured, it returns declarations for TypeScript and nothing for
    // Python, Go, Rust, Java, Ruby, PHP or C#. Without saying so, an empty
    // result from an unread language is indistinguishable from "this symbol
    // does not exist", and the model would stop looking for something that
    // is there. The coverage travels with the answer so the difference is
    // legible, and it is measured per project rather than declared, so a
    // language gained or lost needs no edit here.
    const coverage = intel().getSymbolCoverage(ctx.projectRoot);
    const unreadNote = coverage.unreadModules === 0
      ? undefined
      : {
        unreadFiles: coverage.unreadModules,
        unreadFileTypes: coverage.unreadExtensions,
        note: "No declarations could be read from these files, so this search did not cover them. Use search_code to match their content directly.",
      };
    return { success: true, output: JSON.stringify({ ...results, ...(unreadNote === undefined ? {} : { coverage: unreadNote }) }) };
  } catch (err) {
    return { success: false, output: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function toolFindReuse(ctx: ToolExecutionContext, args: Readonly<Record<string, unknown>>): ToolCallResult {
  const query = requireStringArg(args, "query");
  if (query === null) return { success: false, output: "Error: 'query' is required." };
  const limit = Math.min(typeof args.limit === "number" && Number.isInteger(args.limit) && args.limit > 0 ? args.limit : getIntelligenceSearchDefaultLimit(), getIntelligenceSearchMaxLimit());
  try {
    const results = intel().findReuse(ctx.projectRoot, query, limit);
    return { success: true, output: JSON.stringify(results) };
  } catch (err) {
    return { success: false, output: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function toolGetDependencyGraph(ctx: ToolExecutionContext): ToolCallResult {
  try {
    const { graph, stats, cycles } = intel().getDependencyGraph(ctx.projectRoot);
    const maxCycles = getToolDependencyGraphMaxCycles();
    return { success: true, output: JSON.stringify({ stats, cycleCount: cycles.cycles.length, cycles: cycles.cycles.slice(0, maxCycles), nodeCount: graph.nodeCount, edgeCount: graph.edgeCount }) };
  } catch (err) {
    return { success: false, output: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// EXP474 codebase-file retrieval: phrase n-gram + slot allocation +
// package/directory co-occurrence. Ranks relevant source files for a
// natural-language query — use this to find which files to read/slice before
// editing, instead of grepping blindly. Returns ranked file paths with the
// ranking stage + reasons.
function toolRetrieveRelevantFiles(ctx: ToolExecutionContext, args: Readonly<Record<string, unknown>>): ToolCallResult {
  const query = requireStringArg(args, "query");
  if (query === null) return { success: false, output: "Error: 'query' is required." };
  const limit = Math.min(typeof args.limit === "number" && Number.isInteger(args.limit) && args.limit > 0 ? args.limit : getIntelligenceRetrieveDefaultLimit(), getIntelligenceRetrieveMaxLimit());
  try {
    const result = intel().retrieveRelevantFiles(ctx.projectRoot, query, limit);
    const compact = result.files.map((f) => ({ path: f.path, score: Number(f.score.toFixed(3)), stage: f.stage, reasons: f.reasons }));
    return { success: true, output: JSON.stringify({ query: result.query, count: compact.length, files: compact, debug: result.debug }) };
  } catch (err) {
    return { success: false, output: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── Quick-view + file-slice tools (EXP398 / EXP334) ──

function toolQuickView(ctx: ToolExecutionContext, args: Readonly<Record<string, unknown>>): ToolCallResult {
  const name = requireStringArg(args, "name");
  if (name === null) return { success: false, output: "Error: 'name' is required." };
  try {
    const result = intel().quickView(ctx.projectRoot, name);
    return { success: true, output: JSON.stringify(result) };
  } catch (err) {
    // ── AN OPERATION THAT NEVER RAN IS NOT A SUCCESS ─────────────────────
    //
    // The quick-view index builds off the event loop in a worker, so on a
    // cache miss the bridge throws `MapNotReadyError` instead of blocking.
    // That was reported as `success: true` carrying a `{"status":"indexing"}`
    // envelope, and the stated motive was to keep the attempt-counter from
    // recording a retry — i.e. the failure-tracking mechanism was deliberately
    // suppressed by lying to it. It is the same defect the guardian classifier
    // was fixed for one round earlier, one file away: "the thing refused" and
    // "the thing ran" are different facts and reporting the first as the
    // second is a false statement about the world in the direction that
    // matters, because nothing downstream ever looks again at a call that
    // succeeded.
    //
    // NOT-YET-READY IS ITS OWN ANSWER, and it is `success: false` with a
    // machine-readable `status` and a plainly worded retry instruction. The
    // model gets strictly more information than before: it is told the view is
    // absent, why, and that retrying is the right move.
    if (err instanceof MapNotReadyError) {
      return {
        success: false,
        output: JSON.stringify({
          status: "indexing",
          ran: false,
          message: "The quick-view index is still being built in the background, so no view was produced. Retry this call shortly for the full edit-location view.",
          name,
        }),
      };
    }
    return { success: false, output: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function toolSlice(ctx: ToolExecutionContext, args: Readonly<Record<string, unknown>>): ToolCallResult {
  const name = requireStringArg(args, "name");
  if (name === null) return { success: false, output: "Error: 'name' is required." };
  const file = requireStringArg(args, "file");
  try {
    const result = intel().fileSlice(ctx.projectRoot, name, file);
    return { success: true, output: JSON.stringify(result) };
  } catch (err) {
    return { success: false, output: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function toolViewport(ctx: ToolExecutionContext, args: Readonly<Record<string, unknown>>): ToolCallResult {
  const file = requireStringArg(args, "file");
  if (file === null) return { success: false, output: "Error: 'file' is required." };
  const startLine = typeof args.startLine === "number" && Number.isInteger(args.startLine) && args.startLine > 0 ? args.startLine : null;
  const endLine = typeof args.endLine === "number" && Number.isInteger(args.endLine) && args.endLine > 0 ? args.endLine : null;
  if (startLine === null || endLine === null) return { success: false, output: "Error: 'startLine' and 'endLine' must be positive integers." };
  if (startLine > endLine) return { success: false, output: `Error: 'startLine' (${startLine}) must not exceed 'endLine' (${endLine}).` };
  try {
    const result = intel().fileViewport(ctx.projectRoot, file, startLine, endLine);
    return { success: true, output: JSON.stringify(result) };
  } catch (err) {
    return { success: false, output: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function toolSkeleton(ctx: ToolExecutionContext, args: Readonly<Record<string, unknown>>): ToolCallResult {
  const file = requireStringArg(args, "file");
  if (file === null) return { success: false, output: "Error: 'file' is required." };
  try {
    const result = intel().fileSkeleton(ctx.projectRoot, file);
    return { success: true, output: JSON.stringify(result) };
  } catch (err) {
    return { success: false, output: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── Memory tool ──

/**
 * `fetch_memory` — the LLM-facing memory search tool (SPO).
 *
 * Three SPO gates enforced here (defense-in-depth on top of the memory
 * owner's own gates):
 * 1. userId gate (deny-by-default): if `ctx.userId` is missing, the
 * tool returns a typed error — it NEVER calls searchMemory without
 * a user. Previously this tool called `searchMemory(query)` with NO
 * userId, which returned EVERY user's memories to the LLM (a
 * critical cross-user leak — the LLM, running for User B, could
 * fetch User A's memories).
 * 2. user scoping: passes `ctx.userId` to `searchMemory`, which the
 * memory owner enforces (it throws ForbiddenError on missing/empty
 * userId and filters EXCLUSIVELY to the caller's own entries).
 * 3. PII redaction: the memory owner returns raw
 * decrypted content (the user's own panel needs raw data); the
 * LLM-facing path redacts via the PII owner (`redactContent`) so a
 * pasted secret in a memory entry never reaches the model. Both
 * `content` and `originalRequest` (which carries raw tool args that
 * may contain secrets) are redacted. The `userId` field is stripped
 * from the LLM view (metadata leak — the LLM does not need to see
 * the owning user id).
 */
function toolFetchMemory(ctx: ToolExecutionContext, args: Readonly<Record<string, unknown>>): ToolCallResult {
  if (ctx.userId === undefined || ctx.userId.length === 0) {
    return { success: false, output: "Error: fetch_memory requires an authenticated user context (no user bound to this run)." };
  }
  try {
    const query: Record<string, unknown> = {};
    if (typeof args.text === "string") query.text = args.text;
    if (typeof args.tier === "string") query.tier = args.tier;
    if (typeof args.topic === "string") query.topic = args.topic;
    if (Array.isArray(args.tags)) query.tags = args.tags;
    if (typeof args.limit === "number") query.limit = args.limit;
    const results = mem().searchMemory(query, ctx.userId);
    // PII redaction (owner): redact content + originalRequest before
    // the LLM sees them. The memory owner returns raw decrypted content
    // (the user's own panel needs it); the LLM-facing path redacts. Strip
    // the userId field (the LLM does not need to see the owning user id).
    // `originalRequest` for tool memories is a JSON tool-args string —
    // `redactToolCallArguments` parses the JSON + redacts each string
    // value (so a secret inside `{"content":"sk-..."}` is caught), falling
    // back to text redaction for non-JSON topics (conversation memories).
    const { redactContent, redactToolCallArguments } = redact();
    const safe = results.map((e) => ({
      id: e.id,
      content: redactContent(e.content),
      tier: e.tier,
      topic: e.topic,
      tags: e.tags,
      timestamp: e.timestamp,
      source: e.source,
      toolName: e.toolName,
      originalRequest: e.originalRequest === null ? null : redactToolCallArguments(e.originalRequest),
      chatId: e.chatId,
      how: e.how,
    }));
    return { success: true, output: JSON.stringify(safe) };
  } catch (err) {
    return { success: false, output: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Return the full text behind an abridged tool-call payload.
 *
 * Every failure here is a GUIDED STATE, never an empty success: a model told
 * "" would conclude the document is empty and act on that. The three ways
 * this can fail are distinguishable and each says what happened and what to
 * do — the store not being wired at all, the id not being one this
 * conversation minted, and the entry having aged out of the store.
 */
function toolRetrieveToolResult(ctx: ToolExecutionContext, args: Readonly<Record<string, unknown>>): ToolCallResult {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (id.length === 0) {
    return { success: false, output: "Error: retrieve_tool_result needs the id printed in the abridgement notice — 'tr-' followed by sixteen hexadecimal characters — passed as {\"id\": \"…\"}." };
  }
  const store = ctx.toolResults;
  if (store === undefined) {
    return {
      success: false,
      output: "Error: nothing was abridged in this conversation, so there is no stored text to retrieve. Whatever you were shown is already complete.",
    };
  }
  const full = store.getFullResult(id);
  if (full === null) {
    return {
      success: false,
      output: `Error: no stored text is held under id "${id}" in this conversation. Ids are only valid inside the conversation that produced them, and a very old one may no longer be held. Use the id printed in the most recent abridgement notice.`,
    };
  }
  // Redacted on the way to the model, exactly as the conversation history is.
  // Retrieval is not a side door around the privacy boundary.
  return { success: true, output: redact().redactToolCallArguments(full) };
}

// ── Quality tool ──

function toolScoreQuality(ctx: ToolExecutionContext): ToolCallResult {
  try {
    const indicator = qual().getQualityIndicator(ctx.projectRoot);
    return { success: true, output: JSON.stringify(indicator) };
  } catch (err) {
    return { success: false, output: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── Git tools (read-only) ──

function toolGitStatus(ctx: ToolExecutionContext): ToolCallResult {
  try {
    const status = git().getGitStatus(ctx.projectRoot);
    return { success: true, output: JSON.stringify(status) };
  } catch (err) {
    return { success: false, output: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function toolGitDiff(ctx: ToolExecutionContext, args: Readonly<Record<string, unknown>>): ToolCallResult {
  try {
    const ref = typeof args.ref === "string" ? args.ref : undefined;
    const diff = git().getDiffSummary(ctx.projectRoot, ref);
    return { success: true, output: JSON.stringify(diff) };
  } catch (err) {
    return { success: false, output: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function toolGitBranch(ctx: ToolExecutionContext): ToolCallResult {
  try {
    const branches = git().getBranches(ctx.projectRoot);
    return { success: true, output: JSON.stringify({ count: branches.length, branches }) };
  } catch (err) {
    return { success: false, output: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function toolGitLog(ctx: ToolExecutionContext, args: Readonly<Record<string, unknown>>): ToolCallResult {
  try {
    // the default is the single config owner
    // `gitLogDefaultEntries`; the cap is enforced by the bridge
    // (`gitMaxLogEntries`). The tool no longer re-caps with a scattered
    // `100` literal — the bridge is the ONLY capper (SPO: one owner),
    // so the route + the LLM tool share the same default + cap.
    const max = typeof args.max === "number" && Number.isInteger(args.max) && args.max > 0
      ? args.max
      : serverConfig.gitLogDefaultEntries;
    const log = git().getLog(ctx.projectRoot, max);
    return { success: true, output: JSON.stringify({ count: log.length, log }) };
  } catch (err) {
    return { success: false, output: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * PROACTIVE #4: git_commit is exposed as a typed governance blocker, not
 * silently omitted. Auto-committing from an LLM tool call is unsafe
 * without write-set authorization (the governed Git lifecycle owns
 * commits). The honest result tells the model WHY and what to do instead
 * (stage + the user commits), matching the backend's adapter-blocker pattern.
 */
function toolGitCommit(): ToolCallResult {
  return {
    success: false,
    output: JSON.stringify({
      error: "governance_required",
      tool: "git_commit",
      message: "git_commit is not executable from a chat tool call — committing requires write-set governance and explicit user approval. Stage changes with the editor/git tools and let the user commit via the Git panel.",
    }),
  };
}

// ── UI control (LLM control of the interface) ──

/**
 * Validate + describe a `control_interface` action through the SINGLE
 * owner (server/ui-control.ts). The validated action is embedded in the
 * JSON output so the run route can forward it as a `ui_control` SSE event
 * without re-validating (one validation owner — no drift). The
 * description is the human-readable result returned to the LLM. Invalid
 * input is a typed failure.
 */
function toolControlInterface(_ctx: ToolExecutionContext, args: Readonly<Record<string, unknown>>): ToolCallResult {
  const validated = validateUiControlAction(args);
  if (validated === null) {
    return {
      success: false,
      output: `Error: invalid control_interface arguments. ${describeActionRequirements()}`,
    };
  }
  return {
    success: true,
    output: JSON.stringify({ ok: true, action: validated, description: describeUiControlAction(validated) }),
  };
}

// ── Extensions ──

/**
 * List registered extension manifest entries through the SINGLE web-UI
 * owner (extensions-bridge.ts). The LLM calls this to discover what
 * extensions are available; install/remove are governed by the approval
 * workflow and are NOT exposed as model-callable tools (the backend
 * `createExtensionTools` enforces the same invariant). Filtering by
 * type/status is optional. This handler is the executor-side half of the
 * `list_extensions` manifest entry (tools-bridge.ts) — together they route
 * extension discovery through the unified pipeline (registry → executor),
 * not a parallel extensions-only API.
 */
function toolListExtensions(_ctx: ToolExecutionContext, args: Readonly<Record<string, unknown>>): ToolCallResult {
  try {
    const all = ext().listExtensions();
    const typeFilter = typeof args.type === "string" ? args.type : null;
    const statusFilter = typeof args.status === "string" ? args.status : null;
    const filtered = all
      .filter((e) => typeFilter === null || e.type === typeFilter)
      .filter((e) => statusFilter === null || e.status === statusFilter);
    return { success: true, output: JSON.stringify({ extensions: filtered, total: filtered.length }) };
  } catch (err) {
    return { success: false, output: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── Interactive artifact ──

/**
 * Create a live, interactive artifact (HTML/JS app/game/sheet/presentation)
 * that the frontend renders in a sandboxed iframe inside the chat. The
 * artifact content (the LLM's HTML) is carried in the tool's INPUT
 * arguments (persisted in the tool-call row's `input` column → survives a
 * page refresh); the OUTPUT is just metadata the frontend uses to label
 * the artifact card. Validation:
 * `type` must be one of the known kinds (html/game/sheet/presentation).
 * `title` must be a non-empty string.
 * `content` must be a non-empty string bounded by the config's
 * `artifacts.maxBytes` (rejects runaway/abusive artifacts before they
 * bloat the DB or the chat).
 * The artifact renders client-side in a sandboxed iframe (sandbox=
 * "allow-scripts", NO allow-same-origin) so untrusted artifact JS cannot
 * touch the parent page, its cookies, or its storage (security: ).
 *
 * ── AND IT MUST BE ABLE TO RUN ────────────────────────────────────────────
 *
 * The four checks above are all the tool used to do, and they were not
 * enough. Driven end-to-end against a real model, three of twelve artifacts
 * — including the largest — were dead on arrival with a JavaScript syntax
 * error, and every one of them was answered `{"ok":true … "It renders live
 * in the chat below."}`. The user saw a blank or frozen rectangle; the model
 * saw a success and never retried, because a tool result IS the retry
 * protocol and this one said everything had gone well.
 *
 * So the content is now PARSED before it is accepted, by the same V8 the
 * browser will use (`server/artifact-check.ts`, the single owner). A
 * document that provably cannot run is REJECTED with the real parser
 * message and the offending line, which puts the model one turn away from a
 * fix instead of zero turns away from knowing.
 *
 * Reaching for something the sandbox denies (localStorage, fetch, the parent
 * frame …) is reported as a WARNING on an otherwise successful result: it
 * may be deliberate and guarded, so it is named rather than refused. The
 * warnings travel in the tool output, which means the model reads them on
 * its next turn and the UI can show the artifact as warned rather than
 * clean.
 */
// The artifact kinds the executor accepts, derived from the SINGLE owner
// (ARTIFACT_TYPES in tools-bridge.ts — the manifest's inputSchema enum
// references the same array, so the LLM-offered set and the executor-accepted
// set cannot drift). The Set is built once (lazy) from the lazy-loaded owner
// so the canonical-chain TDZ is not triggered at executor init.
let _artifactTypeSet: ReadonlySet<string> | undefined;
function artifactTypeSet(): ReadonlySet<string> {
  if (_artifactTypeSet === undefined) {
    _artifactTypeSet = new Set(toolsBridge().ARTIFACT_TYPES);
  }
  return _artifactTypeSet;
}

function toolCreateArtifact(_ctx: ToolExecutionContext, args: Readonly<Record<string, unknown>>): ToolCallResult {
  const types = artifactTypeSet();
  const type = requireStringArg(args, "type");
  const title = requireStringArg(args, "title");
  const content = typeof args.content === "string" ? args.content : null;
  if (type === null || !types.has(type)) {
    return { success: false, output: `Error: 'type' is required and must be one of: ${[...types].join(", ")}.` };
  }
  if (title === null) {
    return { success: false, output: "Error: 'title' is required and must be a non-empty string." };
  }
  if (content === null || content.length === 0) {
    return { success: false, output: "Error: 'content' is required and must be a non-empty HTML document." };
  }
  const maxBytes = getArtifactMaxBytes();
  if (content.length > maxBytes) {
    // An artifact is ONE document — there is no second call it can be
    // continued in — so the old advice to "split" it was not a thing the
    // model could do. Say the only two things that are true.
    return {
      success: false,
      output:
        `Error: the artifact is ${content.length} bytes, which exceeds the ${maxBytes} byte limit. ` +
        `An artifact is a single self-contained document and cannot be continued across calls — ` +
        `build a smaller version (fewer features, shorter styles) and call create_artifact again.`,
    };
  }
  // THE RUNNABILITY GATE. `checkArtifactHtml` parses; it never executes.
  // Lazy-required through the same bridge pattern the rest of this module
  // uses so the canonical chain is not pulled in at executor init.
  const check = artifactCheck().checkArtifactHtml(content);
  if (check.faults.length > 0) {
    return { success: false, output: artifactCheck().faultMessage(title, check) };
  }
  const artifactId = sha256(content).slice(0, getArtifactIdLength());
  // The success message no longer promises more than was measured. What was
  // measured is that every classic script in the document parses; the count
  // is stated, including how many blocks were NOT checked, so "clean" never
  // covers something that was skipped.
  return {
    success: true,
    output: JSON.stringify({
      ok: true,
      artifactId,
      type,
      title,
      contentLength: content.length,
      scriptsChecked: check.scriptsChecked,
      scriptsSkipped: check.scriptsSkipped,
      ...(check.warnings.length > 0
        ? { warnings: check.warnings.map((w) => w.message) }
        : {}),
      message:
        `Artifact '${title}' (${type}) is rendering live in the chat. ` +
        `${check.scriptsChecked} script block${check.scriptsChecked === 1 ? "" : "s"} parsed cleanly` +
        `${check.scriptsSkipped > 0 ? `, ${check.scriptsSkipped} not checked` : ""}.` +
        (check.warnings.length > 0
          ? ` ${check.warnings.length} sandbox warning${check.warnings.length === 1 ? "" : "s"} — read them and send a corrected artifact if the feature matters.`
          : ""),
    }),
  };
}

// ── Agent delegation (engine agent runtime via the agent-runtime bridge) ──

/**
 * The agent delegation handlers delegate to `server/agent-runtime-bridge.ts`
 * — the SINGLE owner of web-run agent delegation. The bridge is lazy-loaded
 * (like the other bridges above) for the same canonical-chain TDZ reason.
 * `delegate_to_agent` and `delegate_to_orchestrator` are genuinely async
 * (they run the sub-agents' bounded turn loops against the provider), so
 * their handlers return a promise the dispatcher awaits — no separate
 * executor path, the async-first dispatch already handles it.
 */
// The agent bridge is lazy-loaded via a DYNAMIC ESM import — deliberately NOT
// `moduleRequire`. The bridge drives the engine's agent runtime, whose LLM
// adapter reaches `llm-bridge.ts` and the engine's `SharedLLMClient`; loading
// the bridge through `createRequire` would give it a SECOND copy of those
// modules (the require instance and the ESM instance are distinct under the
// test runner), so a stub applied to the shared class would never fire and —
// in production — metrics/redaction state would split across two module
// objects. A dynamic `import()` stays in the ESM graph: one instance. It is
// still lazy (deferred to the first agent tool call), so the canonical chain
// is not pulled in at executor init. The dispatchers are async so they can
// await the import; the executor's dispatch already awaits handler results.
type AgentRuntimeBridge = typeof import("../agent/agent-runtime-bridge.ts");
let _agentRuntime: Promise<AgentRuntimeBridge> | undefined;
function agentRuntime(): Promise<AgentRuntimeBridge> {
  if (_agentRuntime === undefined) _agentRuntime = import("../agent/agent-runtime-bridge.ts");
  return _agentRuntime;
}

async function toolListAgentsDispatch(ctx: ToolExecutionContext): Promise<ToolCallResult> {
  return (await agentRuntime()).toolListAgents(ctx);
}
async function toolDelegateToAgentDispatch(ctx: ToolExecutionContext, args: Readonly<Record<string, unknown>>): Promise<ToolCallResult> {
  return (await agentRuntime()).toolDelegateToAgent(ctx, args);
}
async function toolGetAgentStateDispatch(ctx: ToolExecutionContext, args: Readonly<Record<string, unknown>>): Promise<ToolCallResult> {
  return (await agentRuntime()).toolGetAgentState(ctx, args);
}
async function toolDelegateToOrchestratorDispatch(ctx: ToolExecutionContext, args: Readonly<Record<string, unknown>>): Promise<ToolCallResult> {
  return (await agentRuntime()).toolDelegateToOrchestrator(ctx, args);
}

// ── Adapter-not-configured blockers (honest typed result) ──

function adapterNotConfigured(toolName: string, adapter: string): ToolCallResult {
  return {
    success: false,
    unavailable: true,
    output: JSON.stringify({
      error: "adapter_not_configured",
      tool: toolName,
      adapter,
      message: `${toolName} is not configured — no ${adapter} adapter is available in the web UI runtime. Configure the adapter to enable this tool.`,
    }),
  };
}

function toolSearchWeb(): ToolCallResult { return adapterNotConfigured("search_web", "SearchAdapter"); }
function toolFetchPage(): ToolCallResult { return adapterNotConfigured("fetch_page", "PageFetchAdapter"); }
function toolReadDocs(): ToolCallResult { return adapterNotConfigured("read_docs", "DocsAdapter"); }
function toolRepoQuestion(): ToolCallResult { return adapterNotConfigured("repo_question", "RepoQuestionAdapter"); }

// ── The ONE dispatch table ──

const TOOL_HANDLERS: Readonly<Record<string, ToolHandler>> = Object.freeze({
  // Filesystem
  read_file: toolReadFile,
  list_files: toolListFiles,
  search_code: toolSearchCode,
  // Built-in (execute_command is real; the 4 research tools are typed blockers)
  execute_command: toolExecuteCommand,
  search_web: toolSearchWeb,
  fetch_page: toolFetchPage,
  read_docs: toolReadDocs,
  repo_question: toolRepoQuestion,
  // Editor — the ONE edit tool.
  edit: toolEdit,
    // Intelligence
    get_repository_map: toolGetRepositoryMap,
    search_symbols: toolSearchSymbols,
    find_reuse: toolFindReuse,
    get_dependency_graph: toolGetDependencyGraph,
    retrieve_relevant_files: toolRetrieveRelevantFiles,
    quick_view: toolQuickView,
    slice: toolSlice,
    viewport: toolViewport,
    skeleton: toolSkeleton,
  // Memory
  fetch_memory: toolFetchMemory,
  // The way back from an abridged payload — see `outboundArguments` in
  // context-bridge.ts, which is what hands the model the id.
  retrieve_tool_result: toolRetrieveToolResult,
  // Quality
  score_quality: toolScoreQuality,
  // Git
  git_status: toolGitStatus,
  git_diff: toolGitDiff,
  git_branch: toolGitBranch,
  git_log: toolGitLog,
  git_commit: toolGitCommit,
  // Interactive artifact: LLM-created apps/games/sheets/
  // presentations rendered live in a sandboxed iframe in the chat.
  create_artifact: toolCreateArtifact,
  // LLM control of the interface — validated through the single
  // owner (server/ui-control.ts); the run route forwards the action as a
  // `ui_control` SSE event.
  control_interface: toolControlInterface,
  // Extensions: the backend `list_extensions` tool routed through
  // the ONE executor (delegates to extensions-bridge).
  list_extensions: toolListExtensions,
  // Agent delegation (list_agents / delegate_to_agent / get_agent_state /
  // delegate_to_orchestrator) — the engine's agent runtime, wired through
  // the agent-runtime bridge (the single owner). `delegate_to_agent` and
  // `delegate_to_orchestrator` are async (they run the sub-agents' bounded
  // turn loops); the dispatcher awaits them like any async handler.
  list_agents: toolListAgentsDispatch,
  delegate_to_agent: toolDelegateToAgentDispatch,
  get_agent_state: toolGetAgentStateDispatch,
  delegate_to_orchestrator: toolDelegateToOrchestratorDispatch,
});

// ── Public API ──

/**
 * Execute a tool call by name. Returns the result (success or typed error).
 *
 * SPO: the
 * per-run safety gate runs FIRST, at the CHOKE POINT (inside the executor —
 * no caller can bypass it). The gate checks ghost tools (calls to names not
 * in the registry), schema mismatches (arguments that fail JSON-schema
 * validation), and loops (identical name + arguments repeated beyond a
 * threshold). Blocked calls return a typed error result with `gateBlock`
 * so the run route emits a "hallucination" SSE event + persists it. The
 * gate is the CANONICAL `tool-call-gate.ts` (reused via safety-bridge —
 * ), NOT a parallel inline implementation.
 *
 * Tools not in the registry (when no gate is present — e.g. tests) return a
 * typed "unknown tool" error. The gate's ghost-tool message is enriched
 * with a helpful "use X instead" hint from the safety-bridge's suggestion
 * map (the single owner — moved here from the inline map).
 */
export function executeToolCall(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  ctx: ToolExecutionContext,
): Promise<ToolCallResult> {
  // RECORDING CHOKE POINT — every tool call crosses this function, so
  // wrapping it here means a tool call cannot execute unrecorded. This closes
  // the "Tool call" timeline lane, which has been structurally empty because
  // nothing ever wrote a tool event: the ledger only ever held the six event
  // types someone remembered to add a `recorder.recordX(...)` call for.
  //
  // The wrapper derives `outcome` from return-vs-throw and opens a span, so
  // anything the tool records nests underneath it. No argument is threaded and
  // no call site changes.
  // `failedWhen` is required here: the executor signals failure by RETURN
  // VALUE (`{ success: false }` for an unknown tool, a denied gate, a tool
  // error), not by throwing. Without it every such call recorded "succeeded"
  // — verified: `tool:nonexistent_tool | succeeded` appeared in the ledger.
  // `errorOf` answers WHY. `failedWhen` alone recorded `outcome: "failed"`
  // with NULL error detail, so the timeline could say a tool call failed and
  // nothing about what went wrong — the failure text was sitting in `output`
  // and was never carried across. A gate block is distinguished from a tool
  // error because they are different problems: one is the safety gate
  // refusing the call, the other is the tool itself failing.
  // `recordEffectAsync` records when the effect SETTLES, never when it
  // starts — the sync form would have marked every tool call "succeeded" the
  // moment it was issued, which is confidently wrong rather than merely
  // missing. It runs the body inside `withSpan`, and because this stays on
  // the main thread that span (and the whole AsyncLocalStorage context that
  // carries causality) survives every `await` underneath it.
  /** The ledger event id of THIS call's tool event, set by `onRecorded`. */
  let toolEventId: string | undefined;
  return recordEffectAsync(
    "tool",
    toolName,
    async () => {
      const result = await executeToolCallInner(toolName, args, ctx);
      // SPO: every completed call (parent or delegated) feeds the run's
      // event-feed runtime when the caller threaded one. The run loop used
      // to record only its own completions, so a sub-agent's tool-switch
      // never reached the detectors. Recording here — the function every
      // tool call already crosses — closes that hole without a second
      // composition point. Callers that omit the runtime (tests, non-run
      // paths) are unchanged.
      if (ctx.safetyRuntime !== undefined) {
        ctx.safetyRuntime.recordToolCall({
          turn: ctx.safetyTurn ?? 1,
          toolName,
          success: result.success,
          ...(result.success ? {} : { error: result.output }),
          args,
          capabilities: ctx.parentManifest?.find((entry) => entry.name === toolName)?.capabilities,
          ...(result.unavailable === true ? { unavailable: true } : {}),
          // The typed cause rides with the unavailability — dropping it here
          // would make the investigation reach for the generic
          // install/configure text on a deliberate disable or a transient
          // restart.
          ...(result.unavailableReason !== undefined ? { unavailableReason: result.unavailableReason } : {}),
        });
      }
      return result;
    },
    {
      failedWhen: (r) => !r.success,
      errorOf: (r) => ({
        message: r.output,
        code: r.gateBlock !== undefined ? `tool_gate_${r.gateBlock.kind}` : "tool_error",
      }),
      // THE GATE-BLOCK DOCUMENT — the structured half of a safety refusal.
      // The refusal message already names the failed fields as prose (the
      // model needs the guidance); this document carries the gate's own
      // computed NAMES on the same ledger event, so "which fields failed"
      // is answerable from the ledger without parsing prose and without
      // reading the client. Written only when the gate blocked the call;
      // a tool error or a clean call attaches nothing here.
      documentsOf: (r) => {
        if (r.gateBlock === undefined) return undefined;
        const content = JSON.stringify({
          kind: r.gateBlock.kind,
          toolName: r.gateBlock.toolName,
          ...(r.gateBlock.failedFields !== undefined ? { failedFields: r.gateBlock.failedFields } : {}),
          // The escalation fact: this block was the Nth consecutive identical
          // refusal of the same call. Surfaced by the ledger dig verbatim
          // (documents print as stored), so `trace run <id> --failed` answers
          // "which fields failed AND did the harness escalate" from one row.
          ...(r.gateBlock.escalated === true ? { escalated: true } : {}),
          // The auto-trip fact: this block tripped the tool (or the tool is
          // already tripped). Surfaced verbatim by the ledger dig, so
          // `trace run <id> --failed` answers "which fields failed, did the
          // harness escalate, and was the tool tripped" from one row.
          ...(r.gateBlock.autoTripped === true
            ? { autoTripped: true, autoTrippedAfter: r.gateBlock.autoTrippedAfter }
            : {}),
        });
        return [{
          name: TIMELINE_GATE_BLOCK_DOCUMENT,
          contentJson: content,
          contentDigest: sha256(content),
        }];
      },
      // THE INVOCATION, REDACTED BEFORE IT EXISTS AS A DOCUMENT. The args
      // object is walked through the single redaction owner (the same
      // `redactContent` engine the LLM documents use, in its object-walking
      // form) at emit time — so a credential inside a tool's arguments is
      // masked before the args document is ever built, and the ledger's
      // bytes never hold it. A broken redaction pass costs the args document,
      // never the call (the wrapper's own contract).
      argsOf: () => redact().redactStringValues(args),
      // THE LEDGER IDENTITY of the tool event, captured at emit time and
      // attached to the returned result below. `onRecorded` fires between
      // the inner call settling and the wrapper's promise resolving, so the
      // `.then` continuation sees it; a run with no ledger attached records
      // nothing and the field is honestly absent.
      onRecorded: (recorded) => {
        toolEventId = recorded.eventId;
      },
    },
  ).then((result) =>
    toolEventId === undefined ? result : Object.freeze({ ...result, toolEventId }),
  );
}

/**
 * THE SYNCHRONOUS PROLOGUE IS LOAD-BEARING, AND IT IS WHY THIS IS AN `async
 * function` RATHER THAN A PROMISE CHAIN.
 *
 * The run route refreshes `toolSettingsSnapshot` immediately before calling
 * in, and the canonical safety gate reads that snapshot. An `async function`
 * runs everything up to its FIRST `await` synchronously, in the caller's own
 * frame — so `gate.check` below still executes with nothing interleaved
 * between the refresh and the check. The adjacency the design requires is
 * preserved, and `tests/prevention/tool-execution-async-owner.test.ts`
 * asserts it as an adjacency rather than trusting this comment.
 *
 * Move an `await` above `gate.check` and the gate starts reading a snapshot
 * another request may have replaced. That is the whole hazard, and it is
 * mechanically guarded.
 */
async function executeToolCallInner(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  ctx: ToolExecutionContext,
): Promise<ToolCallResult> {
  // SPO: the safety gate runs BEFORE dispatch. The gate is
  // the choke point between the LLM's tool call and the actual execution.
  // No caller can bypass it — the check is inside the executor. The gate
  // instance is per-run (created in run.ts, passed via ctx.gate). When
  // absent (tests), the executor falls back to the inline ghost check
  // below (the gate's ghost detection without schema/loop validation).
  // The arguments actually dispatched. The safety gate may rewrite them: when
  // partial-argument memory completes a retained partial, the gate's clean
  // call carries the MERGED arguments (the retained valid fields plus the
  // newly-sent delta), and the executor must dispatch those — not the delta
  // the model sent. The gate is the choke point, so the merged value is read
  // back from the gated clean call rather than reconstructed here.
  let effectiveArgs = args;
  if (ctx.gate !== undefined) {
    const toolCall: ToolCall = {
      id: ctx.callId ?? "unknown",
      type: "function",
      function: { name: toolName, arguments: JSON.stringify(args) },
    };
    const gateResult = ctx.gate.check([toolCall]);
    if (gateResult.blocked.length > 0) {
      const blocked = gateResult.blocked[0]!;
      const sb = safety();
      const kind = sb.gateBlockKind(blocked);
      // A gate block IS a caught hallucination. Record it through the gate
      // owner so the exposure signals (`hallucination.catchCount`,
      // `safety.hallucinationCount`) measure real blocks instead of reading a
      // permanent zero. This is the single choke point — every gated block
      // crosses it.
      sb.recordGateBlock();
      const suggestion = kind === "ghost_tool" ? sb.ghostToolSuggestion(toolName) : null;
      // Enrich the gate's "not registered" message with the suggestion hint
      // so the LLM knows which real tool to use (faster course-correction).
      const output = suggestion !== null
        ? `${blocked.errorMessage} ${suggestion.hint}`
        : blocked.errorMessage;
      return {
        success: false,
        output,
        gateBlock: {
          kind,
          toolName: blocked.toolName,
          callId: blocked.toolCallId,
          suggestion: suggestion?.realTool ?? null,
          ...(blocked.failedFields !== undefined && blocked.failedFields.length > 0
            ? { failedFields: blocked.failedFields }
            : {}),
          ...(blocked.escalated === true ? { escalated: true as const } : {}),
          ...(blocked.autoTripped === true
            ? { autoTripped: true as const, ...(blocked.autoTrippedAfter !== undefined ? { autoTrippedAfter: blocked.autoTrippedAfter } : {}) }
            : {}),
        },
      };
    }
    // The gate passed the call. When it merged a retained partial into the
    // delta, the clean call's arguments are the merged whole — parse them back
    // so the handler receives the complete object. The gate produced this JSON
    // by serializing a plain object, so it always parses to a plain object.
    const gated = gateResult.clean[0];
    if (gated !== undefined && gated.function.arguments !== toolCall.function.arguments) {
      const parsed: unknown = JSON.parse(gated.function.arguments);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        effectiveArgs = parsed as Readonly<Record<string, unknown>>;
      }
    }
  }
  // The merge stamp (UIE-035): carried on every result the DISPATCHED call
  // produced — the handler's answer and its thrown failure both ran with
  // the rewritten arguments, so both must be able to say so. Absent when
  // the gate did not rewrite (the caller's own arguments are the truth
  // then) and on the never-dispatched refusals above (a gate block never
  // dispatched anything).
  const mergedArgs = effectiveArgs === args
    ? {}
    : { dispatchedArguments: effectiveArgs };
  // MCP dynamic dispatch: MCP tool names (`mcp__<server>__<tool>`, minted by
  // the one naming owner) are not known until the MCP runtime connects +
  // discovers them, so the static table cannot hold them. The single
  // fallthrough hands the NAME to the runtime owner, which resolves it by
  // looking up the registry's own registration (nothing parses it) and
  // refuses an undiscovered one with a typed error — deny-by-default, and
  // the refusal is surfaced, never a phantom. The safety gate has ALREADY
  // run on the call above, so an MCP call the manifest does not advertise
  // is blocked as a ghost tool before it ever gets here.
  if (isMcpToolName(toolName)) {
    const start = performance.now();
    const probe = startResourceDeltaProbe();
    let result: ToolCallResult;
    const { callMcpTool } = await import("../integrations/mcp-runtime-bridge.ts");
    try {
      const output = await callMcpTool(toolName, effectiveArgs, ctx.runSignal);
      result = { success: true, output, ...mergedArgs };
    } catch (err) {
      // The single decode of the typed refusal: the boolean the safety
      // runtime consumes and the reason key the pause sentence consumes both
      // come from the same answer, so they can never disagree.
      const reason = mcpUnavailableReason(err);
      result = {
        success: false,
        ...(reason !== null ? { unavailable: true, unavailableReason: reason.key } : {}),
        ...mergedArgs,
        output: `MCP tool '${toolName}' failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    recordToolCall(toolName, performance.now() - start, result.success, {}, gatedResource(probe));
    return result;
  }
  const impl = TOOL_HANDLERS[toolName];
  if (impl === undefined) {
    // Fallback (no gate present, e.g. tests): return a typed "unknown tool"
    // error. When the gate IS present, it already blocked the call above
    // with a richer message (available-tools list + suggestion hint).
    const sb = safety();
    const suggestion = sb.ghostToolSuggestion(toolName);
    if (suggestion !== null) {
      return {
        success: false,
        output: `Tool '${toolName}' does not exist in this harness. ${suggestion.hint} Available tools: ${Object.keys(TOOL_HANDLERS).join(", ")}.`,
      };
    }
    return {
      success: false,
      output: `Tool '${toolName}' is not available in the web UI runtime. Available tools: ${Object.keys(TOOL_HANDLERS).join(", ")}.`,
    };
  }
  const start = performance.now();
  const probe = startResourceDeltaProbe();
  let result: ToolCallResult;
  try {
    // `await` accepts a plain value unchanged, so a synchronous handler is
    // not slowed into a different shape here — it simply resolves.
    result = await impl(ctx, effectiveArgs);
  } catch (err) {
    result = {
      success: false,
      ...mergedArgs,
      output: `Tool '${toolName}' threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (effectiveArgs !== args) {
    // The dispatch ran with the rewritten arguments — say so on the result
    // whatever the handler answered (see `mergedArgs` above).
    result = { ...result, ...mergedArgs };
  }
  recordToolCall(toolName, performance.now() - start, result.success, {}, gatedResource(probe));
  return result;
}

/**
 * The call's measured resource delta for the metrics lane — or undefined
 * when the resource-deltas gate is off, in which case the reading is dropped
 * rather than recorded. The probe is stopped either way: the window is over,
 * and leaving it running would measure the wrong span later.
 */
function gatedResource(probe: ReturnType<typeof startResourceDeltaProbe>): ResourceDelta | undefined {
  const delta = probe.stop();
  return performanceResourceDeltasEnabled() ? delta : undefined;
}

/** Check if a tool name is implemented (can be executed server-side).
 * MCP names are dynamically dispatched through the MCP runtime owner — they
 * are executable by namespace, and the runtime refuses an undiscovered one
 * honestly. */
export function isToolExecutable(toolName: string): boolean {
  return toolName in TOOL_HANDLERS || isMcpToolName(toolName);
}

/** The list of executable tool names (for diagnostics + tests). */
export function listExecutableTools(): readonly string[] {
  return Object.keys(TOOL_HANDLERS);
}
