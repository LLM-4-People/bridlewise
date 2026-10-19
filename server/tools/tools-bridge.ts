/**
 * Unified tool manifest — the ONE canonical registry of every tool the
 * web UI exposes to the LLM.
 *
 * The manifest is aggregated from a single source per tool family:
 * Editor tools (5): from the backend `editor/edit-tools.ts`
 * `createEditorToolDefinitions` — no duplication, the backend owns
 * the JSON schemas.
 * Built-in tools (5): from the backend `tools/built-in-tools.ts`
 * `createBuiltInToolManifestEntries` — already manifest entries.
 * Filesystem + intelligence + memory + quality + git tools:
 * web-UI-owned entries defined here (they bridge to web-UI modules).
 *
 * Every entry's `name` MUST match a handler key in `tool-executor.ts`.
 * The `tool-manifest-executor-match` prevention test enforces this 1:1.
 *
 * Tools whose backend adapter is not configured (search_web, fetch_page,
 * read_docs, repo_question) are still exposed: the executor returns a
 * typed `adapter_not_configured` blocker (honest, not a silent fallback),
 * matching the backend's own pattern. Mutating git (git_commit) returns
 * a typed governance blocker — auto-committing from an LLM tool call is
 * unsafe without write-set authorization.
 */

import {
  DEFAULT_TOOL_RESOURCE_BOUNDS,
  type ToolManifestEntry,
} from "../kernel/canonical.ts";
import { serverConfig } from "../kernel/config.ts";
import { createBuiltInToolManifestEntries } from "../kernel/canonical.ts";
import { createEditorToolDefinitions, EDIT_TOOL_LABEL } from "../../engine/src/editor/edit-tools.ts";
import { editorState } from "../../engine/src/shared/exposure/registrations/editor.ts";
import type { ToolDefinition } from "../kernel/canonical.ts";
import { WebError } from "../kernel/errors.ts";
import { webWarn } from "../observability/debug-bridge.ts";
import { UI_CONTROL_ACTION_NAMES, UI_CONTROL_TAB_NAMES, UI_CONTROL_PANEL_NAMES, UI_CONTROL_THEME_NAMES, UI_CONTROL_INSPECTOR_GROUP_NAMES, UI_CONTROL_INSPECTOR_SECTION_NAMES, UI_CONTROL_INSPECTOR_MODES } from "./ui-control.ts";
// The MEASURED sandbox contract, from the artifact-check owner. The tool
// description the model reads and the warnings it is judged against are
// generated from the SAME table, so they cannot drift apart.
import { sandboxContractSentence } from "../safety/artifact-check.ts";
import { getEnabledTools, getToolKind, type ToolKind, getIntelligenceSearchMaxLimit, getIntelligenceSearchDefaultLimit, getIntelligenceRetrieveMaxLimit, getIntelligenceRetrieveDefaultLimit, getMemorySearchMaxLimit, getMemorySearchDefaultLimit, getSearchLimits, getToolBounds, getQualityConfig } from "../kernel/harness-config.ts";
import { buildAgentToolManifestEntries } from "../agent/agent-runtime-bridge.ts";
import { ensureMcpRuntimeStarted, getDiscoveredMcpTools, isMcpRuntimeShutDownError, isMcpStartSupersededError, mcpRuntimeStarted, mcpWarnErrorPayload } from "../integrations/mcp-runtime-bridge.ts";

/**
 * Web-UI-local tool entry: a `ToolManifestEntry` tagged with a `category`
 * ("built-in" or "mcp") and a granular `kind` (filesystem, editor,
 * intelligence, memory, quality, git, system, network, mcp, extension) so
 * the Tools panel shows ONE merged list with a category badge AND supports
 * filtering/sorting by kind. The `kind` is
 * resolved from `adapterId` via the configurable `getToolKind` mapping
 * (harness-config.ts) — never hardcoded here. Defined here (the server's
 * manifest owner) rather than shared/types.ts so the server typecheck
 * doesn't need the `@harness/*` path aliases. The client has a
 * structurally identical type in shared/types.ts.
 */
export type WebToolEntry = ToolManifestEntry & Readonly<{
  category: "built-in" | "mcp";
  kind: ToolKind;
  /**
   * The plain-words imperative label the UI shows for one call ("edit
   * file"). Declared at the tool's registration, served on the wire. The
   * field is declared on the shared `ToolManifestEntry` (the canonical
   * type); it is restated here only so the server's structural mirror of
   * the wire entry declares every field the client reads — the
   * `tool-registry-owner` contract test pins the two mirrors equal.
   */
  label?: string;
  /**
   * The shape the tool's recorded output takes (file / command / search),
   * declared at registration and read by the renderer. Declared on the shared
   * `ToolManifestEntry`; restated here so the server's structural mirror of
   * the wire entry declares every field the client reads (the
   * `tool-registry-owner` contract test pins the two mirrors equal).
   */
  outputShape?: "file" | "command" | "search";
  /** exp519: opt-in memory save flag (see SAVE_TO_MEMORY_TOOLS below). */
  saveToMemory?: boolean;
}>;

/**
 * The tools whose results are stored in harness memory (exp519: memory
 * opt-in via tool schema — the user: "we should only ever save specific
 * tool calls in memory, so it's opt-in inside tool schema"). These are
 * the high-value knowledge-gathering tools whose results are worth
 * recalling across runs: symbol search, the repository map, reuse
 * candidates, the dependency graph, quick-view, and quality/awareness
 * summaries. Ephemeral content tools (read_file, list_files, slice,
 * viewport, skeleton, git_*, editor tools) are NOT here — saving their
 * results would pollute memory with file contents, mutations, and
 * transient state (the user saw error results being saved). Error
 * results are never saved regardless of this flag (enforced in run.ts).
 */
const SAVE_TO_MEMORY_TOOLS = new Set<string>([
  "search_code",
  "get_repository_map",
  "search_symbols",
  "find_reuse",
  "get_dependency_graph",
  "retrieve_relevant_files",
  "quick_view",
  "score_quality",
  // `get_awareness_summary` used to sit here. It is the only occurrence of that
  // string in either repository: no manifest entry, no handler, nothing. A name
  // in an opt-in set that matches no tool is not a no-op waiting for a feature,
  // it is a claim that a capability is covered when nothing covers it — and the
  // set is a `Set.has`, so it could never say so. The awareness summary is a
  // route, not a tool; when it becomes one, the name goes back.
]);

/**
 * The SINGLE query function for the saveToMemory opt-in list (SPO).
 * The memory owner (memory-bridge.ts `storeToolResultMemory`) calls this to
 * enforce the saveToMemory gate at the choke point — NOT in the run route.
 * A tool opts in iff its name is in `SAVE_TO_MEMORY_TOOLS` (which also
 * populates the manifest entry's `saveToMemory` flag). This is the only
 * public accessor over the set; the set itself stays private (no scattered
 * queries). The manifest entry's `saveToMemory` field is a DERIVED view of
 * this same set (single source of truth).
 */
export function isSaveToMemoryTool(toolName: string): boolean {
  return SAVE_TO_MEMORY_TOOLS.has(toolName);
}

/**
 * The artifact kinds the `create_artifact` tool accepts. This is the SINGLE owner of the artifact-type
 * list — the manifest entry's `inputSchema` enum references it, and the
 * executor imports it to validate the LLM-supplied `type`. Adding a kind here
 * updates BOTH the manifest (what the LLM is offered) AND the executor
 * (what is accepted) in one edit — they cannot drift.
 */
export const ARTIFACT_TYPES: readonly string[] = Object.freeze([
  "html",
  "game",
  "sheet",
  "presentation",
]);

/**
 * Convert an LLM `ToolDefinition` (the OpenAI function-tool shape) into a
 * `WebToolEntry` (the governed manifest shape + category). The `inputSchema`
 * is the function's `parameters` JSON Schema verbatim. This is the sole
 * owner of the ToolDefinition→WebToolEntry mapping so the two shapes cannot
 * drift.
 */
function toolDefinitionToWebToolEntry(
  def: ToolDefinition,
  capabilities: readonly ToolManifestEntry["capabilities"][number][],
  adapterId: string,
  category: "built-in" | "mcp",
  label: string,
): WebToolEntry {
  return Object.freeze({
    id: def.function.name,
    name: def.function.name,
    description: def.function.description,
    inputSchema: def.function.parameters as Readonly<Record<string, unknown>>,
    capabilities: Object.freeze([...capabilities]),
    bounds: DEFAULT_TOOL_RESOURCE_BOUNDS,
    adapterId,
    category,
    kind: getToolKind(adapterId),
    label,
  });
}

// ── Web-UI-owned manifest entries (filesystem, intelligence, memory, quality, git) ──

/**
 * Build the `control_interface` tool description dynamically from the
 * canonical tab list (UI_CONTROL_TAB_NAMES — the single owner). The
 * description enumerates the tabs so the LLM knows where it can navigate,
 * but the list is not hardcoded here — a tab added to the Zod schema
 * reaches the description automatically (no parallel hardcoded copy that
 * silently drifts, per the Single-Party-Owner principle).
 */
function buildControlInterfaceDescription(): string {
  const tabList = UI_CONTROL_TAB_NAMES.join(", ");
  return `Control the web UI on the user's behalf so you can navigate while you work. Actions: 'set_tab' (switch to a tab — ${tabList}), 'inspect' (mode open/close/toggle, optional group or section address), 'list_inspector' (discover every section and supported action keyword without opening it), 'toggle_panel' (right opens/closes the inspector; left is unavailable), 'set_theme' (dark or light), 'open_settings' (open the settings tab). Use this to help the user follow along, e.g. open an inspector section to show its current workspace facts. Inspector groups: ${UI_CONTROL_INSPECTOR_GROUP_NAMES.join(", ")}. Section addresses: ${UI_CONTROL_INSPECTOR_SECTION_NAMES.join(", ")}. Navigation requests are asynchronous; report the requested change honestly.`;
}

/**
 * The `create_artifact` description, built rather than written out, because
 * half of it is a MEASURED fact that lives somewhere else.
 *
 * WHAT THE MODEL USED TO BE TOLD: "It runs in a sandboxed iframe (scripts
 * only, no network/same-origin access)." True, and useless — it names the
 * mechanism, not the consequences. Driven end-to-end, a real model read that
 * sentence and then wrote `localStorage.getItem('best')` at the top of a
 * game's script. In the sandbox that throws SecurityError, the throw killed
 * the rest of the script, and the user got a beautiful title screen attached
 * to a dead engine, with nothing anywhere saying why.
 *
 * So the sandbox half of this description is GENERATED from
 * `server/artifact-check.ts`'s capability table — the same table the
 * post-hoc warnings are generated from. The model cannot now be told one
 * thing and measured against another, and adding a capability to the table
 * updates both halves in one edit.
 *
 * The "when to reach for this" half is stated in the user's language rather
 * than ours, because the other measured failure was one of RECOGNITION: the
 * same model, asked to "put a button in the chat that switches the app to
 * light theme", spent nineteen tool calls reading the harness's own source
 * instead of building the button — it never recognised the request as an
 * artifact at all.
 */
function buildCreateArtifactDescription(): string {
  return (
    "Build something the user can SEE AND USE immediately, rendered live inside the conversation — " +
    "an app, a game, a calculator, a chart or diagram from numbers they gave you, a sortable/editable table, " +
    "a slide deck, a simulation, a form, an animation, a toy. " +
    "Reach for this whenever the answer would be better USED than read: if you are about to write a code block " +
    "the user would have to copy out and run somewhere else, send it as an artifact instead. " +
    "It renders in the conversation itself, so 'in the chat', 'here', 'right now' and 'so I can play with it' all mean this tool. " +
    "It does NOT change this application or any file in the project — it is a self-contained page shown to the user. " +
    "`content` is one complete HTML document with its CSS in a <style> tag and its JavaScript in a <script> tag, inline. " +
    "The document is PARSED before it is accepted: a JavaScript syntax error is rejected with the parser's message and the line, " +
    "and the artifact is not shown until you send a corrected one. " +
    sandboxContractSentence()
  );
}

function buildWebUiOwnedManifestEntries(): readonly ToolManifestEntry[] {
  return Object.freeze([
    // Filesystem tools (run in the project directory).
    Object.freeze({
      id: "read_file",
      name: "read_file",
      outputShape: "file" as const,
      label: "read file",
      description: `Read the contents of a file within the project. The path is relative to the project root (or absolute within it). Returns the file content as text. Files larger than ${Math.round(getToolBounds().maxFileBytes / 1024)}KB are rejected.`,
      inputSchema: Object.freeze({
        type: "object",
        properties: Object.freeze({
          path: { type: "string", minLength: 1, description: "The file path relative to the project root (e.g. 'src/main.ts') or an absolute path within the project." },
        }),
        required: ["path"],
        additionalProperties: false,
      }),
      capabilities: Object.freeze(["read"] as const),
      bounds: DEFAULT_TOOL_RESOURCE_BOUNDS,
      adapterId: "web-ui-filesystem",
    }),
    Object.freeze({
      id: "list_files",
      name: "list_files",
      outputShape: "search" as const,
      label: "list files",
      description: "List files and directories in a given directory within the project. The path defaults to '.' (project root). Directories are suffixed with '/'. Hidden files (starting with '.') are excluded.",
      inputSchema: Object.freeze({
        type: "object",
        properties: Object.freeze({
          path: { type: "string", description: "The directory path relative to the project root (default: '.')." },
        }),
        required: [],
        additionalProperties: false,
      }),
      capabilities: Object.freeze(["read"] as const),
      bounds: DEFAULT_TOOL_RESOURCE_BOUNDS,
      adapterId: "web-ui-filesystem",
    }),
    Object.freeze({
      id: "search_code",
      name: "search_code",
      outputShape: "search" as const,
      label: "search code",
      description: `Search file CONTENT for a regex pattern — every line of every file, including comments, string literals, config and text files. Returns matching lines with file paths and line numbers, plus how many matches exist in total so you can tell a complete answer from a truncated one. Searches up to ${getSearchLimits().maxDepth} levels deep, skipping hidden files and node_modules, and shows at most ${getSearchLimits().maxResults} matches. Use search_symbols instead when you are looking for where a function, class or type is DECLARED — it ranks by relevance and understands a description; this tool only matches the literal pattern you supply.`,
      inputSchema: Object.freeze({
        type: "object",
        properties: Object.freeze({
          pattern: { type: "string", minLength: 1, description: "The regex pattern to search for (case-insensitive)." },
        }),
        required: ["pattern"],
        additionalProperties: false,
      }),
      capabilities: Object.freeze(["read"] as const),
      bounds: DEFAULT_TOOL_RESOURCE_BOUNDS,
      adapterId: "web-ui-filesystem",
    }),
    // Intelligence tools (bridge to the canonical intelligence module).
    Object.freeze({
      id: "get_repository_map",
      name: "get_repository_map",
      label: "map the repository",
      description: "Return a structured map of the project: modules, files, symbols, and a summary (file/module/symbol counts, total lines, languages). Useful to understand the project structure before editing.",
      inputSchema: Object.freeze({ type: "object", properties: Object.freeze({}), required: [], additionalProperties: false }),
      capabilities: Object.freeze(["read"] as const),
      bounds: DEFAULT_TOOL_RESOURCE_BOUNDS,
      adapterId: "web-ui-intelligence",
    }),
    Object.freeze({
      id: "search_symbols",
      name: "search_symbols",
      outputShape: "search" as const,
      label: "search symbols",
      description: "Search for symbols (functions, classes, types) by name across the project. Returns symbol name, kind, visibility, and location (file:line:column). Use this to find where a symbol is defined.",
      inputSchema: Object.freeze({
        type: "object",
        properties: Object.freeze({
          query: { type: "string", minLength: 1, description: "Symbol name (or substring) to search for." },
          limit: { type: "integer", minimum: 1, maximum: getIntelligenceSearchMaxLimit(), description: `Maximum results (default ${getIntelligenceSearchDefaultLimit()}).` },
        }),
        required: ["query"],
        additionalProperties: false,
      }),
      capabilities: Object.freeze(["read"] as const),
      bounds: DEFAULT_TOOL_RESOURCE_BOUNDS,
      adapterId: "web-ui-intelligence",
    }),
    Object.freeze({
      id: "find_reuse",
      name: "find_reuse",
      outputShape: "search" as const,
      label: "find reusable code",
      description: "Find reusable code candidates matching a query (by name/signature). Returns matching symbols with a reuse score and reasons. Use this before writing new code to avoid duplication.",
      inputSchema: Object.freeze({
        type: "object",
        properties: Object.freeze({
          query: { type: "string", minLength: 1, description: "Symbol name or signature hint to find reuse candidates for." },
          limit: { type: "integer", minimum: 1, maximum: getIntelligenceSearchMaxLimit(), description: `Maximum results (default ${getIntelligenceSearchDefaultLimit()}).` },
        }),
        required: ["query"],
        additionalProperties: false,
      }),
      capabilities: Object.freeze(["read"] as const),
      bounds: DEFAULT_TOOL_RESOURCE_BOUNDS,
      adapterId: "web-ui-intelligence",
    }),
    Object.freeze({
      id: "get_dependency_graph",
      name: "get_dependency_graph",
      label: "read the dependency graph",
      description: "Return the project's dependency graph: stats (node/edge counts), cycles, and the graph structure. Use this to understand module coupling and find circular dependencies.",
      inputSchema: Object.freeze({ type: "object", properties: Object.freeze({}), required: [], additionalProperties: false }),
      capabilities: Object.freeze(["read"] as const),
      bounds: DEFAULT_TOOL_RESOURCE_BOUNDS,
      adapterId: "web-ui-intelligence",
    }),
    // EXP474 codebase-file retrieval: phrase n-gram + slot allocation +
    // package/directory co-occurrence. Ranks relevant source files for a
    // natural-language query — call this BEFORE read_file/slice to find
    // which files matter for a task, instead of grepping blindly. The ranking
    // guarantees representation for import-connected files a pure keyword
    // search would bury.
    Object.freeze({
      id: "retrieve_relevant_files",
      name: "retrieve_relevant_files",
      outputShape: "file" as const,
      label: "retrieve relevant files",
      description: "Rank the most relevant source files for a natural-language task/query using EXP474 ranking (phrase n-gram + slot allocation + package/directory co-occurrence). Returns ranked file paths with the ranking stage + reasons. Use this before read_file/slice to find which files matter for a task.",
      inputSchema: Object.freeze({
        type: "object",
        properties: Object.freeze({
          query: { type: "string", minLength: 1, description: "A natural-language description of the task or symbol to find relevant files for (e.g. 'how does the context manager trim history')." },
          limit: { type: "integer", minimum: 1, maximum: getIntelligenceRetrieveMaxLimit(), description: `Maximum files to return (default ${getIntelligenceRetrieveDefaultLimit()}).` },
        }),
        required: ["query"],
        additionalProperties: false,
      }),
      capabilities: Object.freeze(["read"] as const),
      bounds: DEFAULT_TOOL_RESOURCE_BOUNDS,
      adapterId: "web-ui-intelligence",
    }),
    // Quick-view (EXP398): AST-based replacement for grep. 137× faster,
    // 3.8× fewer tokens, 0 false positives. Returns definition + callers
    // + clones + type refs + tests + docs for a symbol in one structured
    // payload.
    Object.freeze({
      id: "quick_view",
      name: "quick_view",
      outputShape: "file" as const,
      label: "quick view",
      description: "Quick-view ALL edit locations for a symbol (AST-based, not grep): definition, callers, clones, type refs, tests, and docs. Pass the symbol name (or a natural-language phrase containing it). Use this instead of search_code/read_file to find everywhere a symbol is used.",
      inputSchema: Object.freeze({
        type: "object",
        properties: Object.freeze({
          name: { type: "string", minLength: 1, description: "The symbol name (function/class/type) to quick-view. A natural-language phrase is also accepted (e.g. 'show me edit locations for parseConfig')." },
        }),
        required: ["name"],
        additionalProperties: false,
      }),
      capabilities: Object.freeze(["read"] as const),
      bounds: DEFAULT_TOOL_RESOURCE_BOUNDS,
      adapterId: "web-ui-intelligence",
    }),
    // File-slice (EXP334): AST slice of a function/class body. 187 tokens
    // vs reading the full file. The LLM edits by copying from the slice.
    Object.freeze({
      id: "slice",
      name: "slice",
      outputShape: "file" as const,
      label: "read a code slice",
      description: "Return the AST slice of a single function/class: its body + signature + callers, capped at a line limit. Use this instead of read_file to get just the function you need to edit. Pass the function name; optionally pass a file hint if the name is ambiguous.",
      inputSchema: Object.freeze({
        type: "object",
        properties: Object.freeze({
          name: { type: "string", minLength: 1, description: "The function/class name to slice." },
          file: { type: "string", description: "Optional file hint (relative path) to disambiguate when the name matches multiple definitions." },
        }),
        required: ["name"],
        additionalProperties: false,
      }),
      capabilities: Object.freeze(["read"] as const),
      bounds: DEFAULT_TOOL_RESOURCE_BOUNDS,
      adapterId: "web-ui-intelligence",
    }),
    // Viewport: a bounded line window of a file (for exact-byte editor
    // needs the preimage check requires).
    Object.freeze({
      id: "viewport",
      name: "viewport",
      outputShape: "file" as const,
      label: "read a viewport",
      description: "Return a bounded line window of a file (exact text, for the editor's preimage check). Use this when you need exact line content for an edit, not the whole file.",
      inputSchema: Object.freeze({
        type: "object",
        properties: Object.freeze({
          file: { type: "string", minLength: 1, description: "The file path (relative to the project root)." },
          startLine: { type: "integer", minimum: 1, description: "The first line to include (1-based)." },
          endLine: { type: "integer", minimum: 1, description: "The last line to include (1-based)." },
        }),
        required: ["file", "startLine", "endLine"],
        additionalProperties: false,
      }),
      capabilities: Object.freeze(["read"] as const),
      bounds: DEFAULT_TOOL_RESOURCE_BOUNDS,
      adapterId: "web-ui-intelligence",
    }),
    // Skeleton: one line per top-level declaration — file-wide structure
    // in ~30-50 tokens regardless of file size.
    Object.freeze({
      id: "skeleton",
      name: "skeleton",
      outputShape: "file" as const,
      label: "read a file skeleton",
      description: "Return the AST skeleton of a file: one line per top-level declaration (name, kind, line range, signature). Use this to understand a file's structure in ~30-50 tokens before slicing specific functions.",
      inputSchema: Object.freeze({
        type: "object",
        properties: Object.freeze({
          file: { type: "string", minLength: 1, description: "The file path (relative to the project root)." },
        }),
        required: ["file"],
        additionalProperties: false,
      }),
      capabilities: Object.freeze(["read"] as const),
      bounds: DEFAULT_TOOL_RESOURCE_BOUNDS,
      adapterId: "web-ui-intelligence",
    }),
    // Memory tool (bridge to the canonical memory store).
    Object.freeze({
      id: "fetch_memory",
      name: "fetch_memory",
      label: "fetch memory",
      description: "Search the harness memory store for past entries by text, tier (present/short-term/long-term), topic, tags, or time range. Returns matching memory entries with their tier and timestamp. Use this to recall prior context across runs/chats.",
      inputSchema: Object.freeze({
        type: "object",
        properties: Object.freeze({
          text: { type: "string", description: "Full-text search query." },
          tier: { type: "string", enum: ["present", "short-term", "long-term"], description: "Filter by memory tier." },
          topic: { type: "string", description: "Filter by topic." },
          tags: { type: "array", items: { type: "string" }, description: "Filter by tags." },
          limit: { type: "integer", minimum: 1, maximum: getMemorySearchMaxLimit(), description: `Maximum results (default ${getMemorySearchDefaultLimit()}).` },
        }),
        required: [],
        additionalProperties: false,
      }),
      capabilities: Object.freeze(["read"] as const),
      bounds: DEFAULT_TOOL_RESOURCE_BOUNDS,
      adapterId: "web-ui-memory",
    }),
    // THE WAY BACK from an abridged tool-call payload.
    //
    // A large payload — an artifact document above all — is re-serialised into
    // every request for as long as its turn survives, which is the dominant
    // token cost in any conversation that made one. The context assembler
    // therefore sends a REFERENCE for those, and the reference names this
    // tool. Without it the abridgement would be a deletion that reports
    // success: the model would see a fragment that begins exactly like the
    // document, and revise the fragment.
    //
    // Read-only, and it can only ever return something the model itself
    // produced earlier in THIS conversation — the store is per-run, so an id
    // from another conversation resolves to nothing rather than to somebody
    // else's document.
    Object.freeze({
      id: "retrieve_tool_result",
      name: "retrieve_tool_result",
      label: "retrieve a tool result",
      description:
        "Return the complete, unabridged text of an earlier tool call's payload in this conversation. When a payload was too large to keep in full in the conversation, you are shown its opening plus an id — call this with that id to read the whole thing. Always call this before revising a document you can only see the opening of; the opening is not the document.",
      inputSchema: Object.freeze({
        type: "object",
        properties: Object.freeze({
          // The shape is DESCRIBED rather than shown. A literal example id is
          // sixteen hexadecimal characters, which is exactly what a credential
          // looks like — the repository's own secret detector flags it, and it
          // would have been carried as an allowlisted exception forever.
          id: { type: "string", minLength: 1, description: "The id given in the abridgement notice — 'tr-' followed by sixteen hexadecimal characters. Copy it from the notice exactly." },
        }),
        required: ["id"],
        additionalProperties: false,
      }),
      capabilities: Object.freeze(["read"] as const),
      bounds: DEFAULT_TOOL_RESOURCE_BOUNDS,
      adapterId: "web-ui-memory",
    }),
    // Quality tool (bridge to the awareness-based quality indicator).
    Object.freeze({
      id: "score_quality",
      name: "score_quality",
      label: "score quality",
      description: `Compute a codebase quality indicator: overall score (0-${getQualityConfig().scoreMax}), grade, issue density, complexity, type coverage, clone stats, and recommendations. No arguments — analyzes the current project.`,
      inputSchema: Object.freeze({ type: "object", properties: Object.freeze({}), required: [], additionalProperties: false }),
      capabilities: Object.freeze(["read"] as const),
      bounds: DEFAULT_TOOL_RESOURCE_BOUNDS,
      adapterId: "web-ui-quality",
    }),
    // Git tools (read-only; bridge to the git-ops bridge). git_commit is
    // intentionally NOT exposed as an executable tool — auto-committing
    // from an LLM tool call is unsafe without write-set governance.
    Object.freeze({
      id: "git_status",
      name: "git_status",
      label: "check working tree",
      description: "Return the git status of the project: branch, head, and a list of changed files with their status (modified/added/deleted/untracked).",
      inputSchema: Object.freeze({ type: "object", properties: Object.freeze({}), required: [], additionalProperties: false }),
      capabilities: Object.freeze(["read"] as const),
      bounds: DEFAULT_TOOL_RESOURCE_BOUNDS,
      adapterId: "web-ui-git",
    }),
    Object.freeze({
      id: "git_diff",
      name: "git_diff",
      label: "read the diff",
      description: "Return a diff summary of the project against a ref (default: working tree vs HEAD). Lists changed files with insertions/deletions.",
      inputSchema: Object.freeze({
        type: "object",
        properties: Object.freeze({
          ref: { type: "string", description: "Git ref to diff against (default: HEAD)." },
        }),
        required: [],
        additionalProperties: false,
      }),
      capabilities: Object.freeze(["read"] as const),
      bounds: DEFAULT_TOOL_RESOURCE_BOUNDS,
      adapterId: "web-ui-git",
    }),
    Object.freeze({
      id: "git_branch",
      name: "git_branch",
      label: "read branches",
      description: "List local git branches of the project with the current branch marked.",
      inputSchema: Object.freeze({ type: "object", properties: Object.freeze({}), required: [], additionalProperties: false }),
      capabilities: Object.freeze(["read"] as const),
      bounds: DEFAULT_TOOL_RESOURCE_BOUNDS,
      adapterId: "web-ui-git",
    }),
    Object.freeze({
      id: "git_log",
      name: "git_log",
      label: "read history",
      description: "Return the recent git commit log of the project (hash, author, date, message).",
      inputSchema: Object.freeze({
        type: "object",
        properties: Object.freeze({
          // `maximum` + the documented default derive from the
          // single config owner (`serverConfig.gitMaxLogEntries` /
          // `gitLogDefaultEntries`) — previously the `100` cap was a 4th
          // scattered copy of the literal hardcoded here (drift risk).
          max: { type: "integer", minimum: 1, maximum: serverConfig.gitMaxLogEntries, description: `Maximum number of commits (default ${serverConfig.gitLogDefaultEntries}).` },
        }),
        required: [],
        additionalProperties: false,
      }),
      capabilities: Object.freeze(["read"] as const),
      bounds: DEFAULT_TOOL_RESOURCE_BOUNDS,
      adapterId: "web-ui-git",
    }),
    // git_commit is exposed (so the model knows the surface) but the
    // executor returns a typed governance blocker — auto-committing from
    // a chat tool call is unsafe without write-set authorization.
    Object.freeze({
      id: "git_commit",
      name: "git_commit",
      // Not the bare word "commit" — a bare SQL keyword as a string literal is
      // what the raw-transaction-SQL guard scans for, and a UI label is not a
      // transaction statement. "commit changes" reads better anyway.
      label: "commit changes",
      description: "Commit staged changes. Not executable from a chat tool call — committing requires write-set governance and explicit user approval. Stage with editor/git tools; the user commits via the Git panel.",
      inputSchema: Object.freeze({
        type: "object",
        properties: Object.freeze({
          message: { type: "string", minLength: 1, description: "Commit message (governance blocker — the user commits, not the model)." },
        }),
        required: ["message"],
        additionalProperties: false,
      }),
      capabilities: Object.freeze(["write"] as const),
      bounds: DEFAULT_TOOL_RESOURCE_BOUNDS,
      adapterId: "web-ui-git-governance",
    }),
    // Interactive artifact. The LLM calls this to build a
    // live, interactive app/game/sheet/presentation that renders in a
    // SANDBOXED iframe inside the chat (not as a code block). The content
    // is self-contained HTML/CSS/JS. The frontend's ArtifactView renders
    // it with sandbox="allow-scripts" (no same-origin — the artifact
    // cannot touch the parent page; security: ). The artifact
    // content is persisted in the tool-call's input column so it survives
    // a page refresh. This is the "sky is the limit" capability: any
    // HTML/JS the LLM produces runs live in the chat.
    Object.freeze({
      id: "create_artifact",
      name: "create_artifact",
      label: "create an artifact",
      description: buildCreateArtifactDescription(),
      inputSchema: Object.freeze({
        type: "object",
        properties: Object.freeze({
          // The kind is NOT decoration: the cockpit's renderer sizes the
          // frame from it (a game gets a tall, roughly square stage; a sheet
          // gets a wide short one; a deck gets 16:9), so choosing the wrong
          // kind gives the user the wrong shape of window to use it through.
          // `enum` + `minLength` are enforced by the pre-dispatch safety gate
          // (the schema is the ONE declaration site): a wrong value or an
          // empty string is blocked with a field-level delta-repair message
          // BEFORE the executor sees the call, so the model is asked for
          // only the corrected field instead of re-sending the artifact.
          type: { type: "string", enum: ARTIFACT_TYPES, description: "What kind of thing this is — it decides the SHAPE of the frame the user gets. 'game' for anything played or animated on a stage (tall, near-square). 'sheet' for tables and grids (wide and short). 'presentation' for slides (16:9). 'html' for everything else (a calculator, a chart, a form, a widget)." },
          title: { type: "string", minLength: 1, description: "A short human-readable title, shown above the artifact. Name the thing, not the act: 'Monthly Signups' rather than 'Here is your chart'." },
          content: { type: "string", minLength: 1, description: "ONE complete, self-contained HTML document: markup, a <style> tag, and a <script> tag, all inline. It is parsed before it is accepted — a JavaScript syntax error is rejected and returned to you with the line. Nothing may be loaded from a URL (no CDN, no remote fonts or images): inline it or use a data: URI." },
        }),
        required: ["type", "title", "content"],
        additionalProperties: false,
      }),
      capabilities: Object.freeze(["write"] as const),
      bounds: DEFAULT_TOOL_RESOURCE_BOUNDS,
      adapterId: "web-ui-artifact",
    }),
    // LLM control of the interface. The LLM calls this to change
    // the web UI on the user's behalf — switch tabs, toggle side panels,
    // set the theme, or open Settings. The executor validates the action
    // through the single owner (server/ui-control.ts) and the run route
    // emits a `ui_control` SSE event the frontend applies. `read` capability — it
    // changes presentation state, never project files. The inputSchema
    // enums are imported from the single owner (UI_CONTROL_*_NAMES) so a
    // value added to the Zod schema reaches the manifest automatically — no
    // parallel hardcoded enum that can silently drift.
    Object.freeze({
      id: "control_interface",
      name: "control_interface",
      label: "control the interface",
      description: buildControlInterfaceDescription(),
      inputSchema: Object.freeze({
        type: "object",
        properties: Object.freeze({
          action: { type: "string", enum: UI_CONTROL_ACTION_NAMES, description: "The UI action to perform." },
          tab: { type: "string", enum: UI_CONTROL_TAB_NAMES, description: "For action 'set_tab': the tab to navigate to." },
          panel: { type: "string", enum: UI_CONTROL_PANEL_NAMES, description: "For action 'toggle_panel': which side panel to toggle." },
          theme: { type: "string", enum: UI_CONTROL_THEME_NAMES, description: "For action 'set_theme': the theme to apply." },
          mode: { type: "string", enum: UI_CONTROL_INSPECTOR_MODES, description: "For inspect: open, close or toggle the single workspace inspector." },
          group: { type: "string", enum: UI_CONTROL_INSPECTOR_GROUP_NAMES, description: "For inspect: optional inspector group. list_inspector discovers all sections without opening them." },
          section: { type: "string", enum: UI_CONTROL_INSPECTOR_SECTION_NAMES, description: "For inspect: optional section address; its group opens automatically." },
        }),
        required: ["action"],
        additionalProperties: false,
      }),
      capabilities: Object.freeze(["read"] as const),
      bounds: DEFAULT_TOOL_RESOURCE_BOUNDS,
      adapterId: "web-ui-control",
    }),
    // Extensions.
    // The backend defines a `list_extensions` model-callable tool; the web
    // UI owns its OWN manifest entry (adapterId `web-ui-extension`) that
    // delegates to extensions-bridge (the single web-UI owner of extension
    // metadata). This keeps the tool pipeline UNIFIED — ONE registry, ONE
    // executor — instead of a parallel extensions-only API the LLM cannot
    // call. Extension install/remove are governed by the approval workflow
    // and are intentionally NOT exposed as model-callable tools (the backend
    // `createExtensionTools` enforces the same invariant). Read-only.
    Object.freeze({
      id: "list_extensions",
      name: "list_extensions",
      label: "list extensions",
      description: "List registered extension manifest entries (id, type, version, status, description). Read-only. Optional filters: 'type' (extension type) and 'status' (e.g. active/disabled). Extension installation and removal are governed by the approval workflow and are not exposed as model-callable tools.",
      inputSchema: Object.freeze({
        type: "object",
        properties: Object.freeze({
          type: { type: "string", description: "Optional extension type filter." },
          status: { type: "string", description: "Optional status filter (e.g. 'active', 'disabled')." },
        }),
        required: [],
        additionalProperties: false,
      }),
      capabilities: Object.freeze(["read"] as const),
      bounds: DEFAULT_TOOL_RESOURCE_BOUNDS,
      adapterId: "web-ui-extension",
    }),
  ]);
}

// ── Aggregation (the ONE registry) ──

/**
 * Tag a canonical `ToolManifestEntry` with a web-UI `category` ("built-in" or
 * "mcp") without modifying the backend type. The category is a presentation
 * concern layered on top at manifest-build time (user directive: "mcp and
 * tools should be merged, mcp inside tools as we just separate things
 * between built-in and mcp").
 */
function tagWithCategory(entry: ToolManifestEntry, category: "built-in" | "mcp"): WebToolEntry {
  return Object.freeze({
    ...entry,
    category,
    kind: getToolKind(entry.adapterId),
    saveToMemory: SAVE_TO_MEMORY_TOOLS.has(entry.name),
    // The plain-words label travels with the entry it was declared on
    // (spread above); nothing here re-derives it.
  });
}

/**
 * The MCP half of the manifest: the REAL tools the live MCP runtime has
 * discovered, one entry per tool, named by the one MCP naming owner
 * (`mcp__<server>__<tool>`, a legal Responses function name), each with the
 * server's own `inputSchema` so the LLM sees the real contract, and each
 * classified by the one classifier (`mcpToolCapabilities`: `read` only when
 * the server declares the tool read-only, `write` otherwise — so an MCP write
 * is visible to the event feed like a native write). The entry IS the
 * engine's manifest entry the registry handed over with the registration;
 * this owner only tags its category. A server that is disabled, or that
 * failed to connect, contributes NO tools — there is no placeholder stand-in
 * (deny-by-default: a tool that is not discovered is not advertised, and an
 * advertised tool is genuinely callable).
 *
 * The manifest is built lazily at first read; the runtime owner is started
 * asynchronously and the manifest cache is invalidated when the discovery
 * lands (see `getToolManifest`/`refreshToolManifestFromMcp`), so the first
 * build after boot may precede discovery and simply carry no MCP entries —
 * the rebuild swaps them in without a restart.
 */
function buildMcpToolEntries(): readonly WebToolEntry[] {
  return getDiscoveredMcpTools().map((t) => tagWithCategory(t.manifest, "mcp"));
}

function buildUnifiedManifest(): readonly WebToolEntry[] {
  const byName = new Map<string, WebToolEntry>();
  const entries: WebToolEntry[] = [];

  /**
   * Enforce the canonical manifest schema shape. Backend-sourced tools (editor, built-in) may omit
   * `additionalProperties` or `required`; the manifest owner normalizes them
   * at this choke point so the LLM always sees a tight, consistent schema
   * regardless of the source. Idempotent + non-mutating: a schema already in
   * canonical form passes through as the same entry (no copy); a loose schema
   * is rebuilt as a new frozen object with `type:"object"`, `required:[]`,
   * `additionalProperties:false` (preventing the LLM from smuggling extra
   * properties the executor would silently ignore — the prior editor-tool
   * schema-inconsistency bug). This is the SPO "lowest-level enforcement":
   * the registry's `add` is the ONE point every entry (editor, built-in,
   * web-UI-owned, MCP) passes through, so a loose backend schema cannot leak.
   */
  function normalizeEntry(entry: WebToolEntry): WebToolEntry {
    const s = entry.inputSchema as Record<string, unknown>;
    if (
      s["type"] === "object" &&
      Array.isArray(s["required"]) &&
      s["additionalProperties"] === false
    ) {
      return entry; // already canonical — no copy
    }
    return Object.freeze({
      ...entry,
      inputSchema: Object.freeze({
        ...s,
        type: "object",
        required: Array.isArray(s["required"]) ? s["required"] : [],
        additionalProperties: false,
      }),
    });
  }

  function add(entry: WebToolEntry): void {
    const normalized = normalizeEntry(entry);
    if (byName.has(normalized.name)) {
      // Defensive: a duplicate name across sources is a wiring bug. Keep
      // the first registration and surface the conflict loudly (the
      // prevention test also catches manifest/executor drift).
      throw new WebError(`Duplicate tool name in unified manifest: ${normalized.name}`, "tool_manifest_duplicate_name");
    }
    byName.set(normalized.name, normalized);
    entries.push(normalized);
  }

  // 1. The ONE editor edit tool — from the backend, converted + tagged
  //    built-in. The `editor.unifiedEditEnabled` Settings toggle gates whether
  //    the edit tool is exposed to the model at all (deny-by-default: off =
  //    no file-editing surface). Read from the live projection (the single
  //    owner of the `editor` knobs).
  if (editorState.unifiedEditEnabled) {
    for (const def of createEditorToolDefinitions()) {
      add(toolDefinitionToWebToolEntry(def, ["write"], "web-ui-editor", "built-in", EDIT_TOOL_LABEL));
    }
  }
  // 2. Built-in tools (5) — already manifest entries from the backend, tagged.
  for (const entry of createBuiltInToolManifestEntries()) {
    add(tagWithCategory(entry, "built-in"));
  }
  // 3. Web-UI-owned tools (filesystem, intelligence, memory, quality, git).
  for (const entry of buildWebUiOwnedManifestEntries()) {
    add(tagWithCategory(entry, "built-in"));
  }
  // 4. Agent delegation tools (list_agents, delegate_to_agent,
  // get_agent_state) — built by the agent-runtime bridge (the single owner
  // of web-run delegation) so their schemas + restriction enums derive from
  // the vocabulary owners, never a literal mirrored here. They ride the
  // same enabled/override filter as every other built-in tool: a user can
  // switch delegation off per session like any other tool. They are tagged
  // through the same `tagWithCategory` choke point as every other entry so
  // the category/kind/saveToMemory derivation stays singular.
  for (const entry of buildAgentToolManifestEntries(DEFAULT_TOOL_RESOURCE_BOUNDS)) {
    add(tagWithCategory(entry, "built-in"));
  }
  // 5. MCP server tools — from the harness config, tagged "mcp".
  for (const entry of buildMcpToolEntries()) {
    add(entry);
  }
  return Object.freeze(entries);
}

let cachedManifest: readonly WebToolEntry[] | undefined;
/** The manifest's own coherence counter for the runtime start it kicked (so a
 * manifest build never double-starts and never awaits). NOT the same
 * generation as the runtime owner's start-lifecycle fence
 * (mcp-runtime-bridge): this one counts manifest KICKS — an invalidation
 * that lands while a kick's start is in flight is followed by ONE
 * re-invalidation when that start resolves, so the discovered tools always
 * reach the NEXT read. */
let mcpManifestKickGeneration = 0;
/** The kick generation of the last start whose invalidation has been consumed. */
let mcpManifestKickConsumed = 0;

/**
 * The unified tool manifest — every tool the LLM can call (built-in + MCP),
 * each tagged with a category. ONE registry. The cache is
 * invalidated when the harness config changes (mtime) so toggling a tool or
 * editing MCP servers takes effect without a restart.
 *
 * MCP entries are LIVE: they come from the runtime owner's discovered tools.
 * The manifest is read synchronously by callers that cannot await (the run
 * route builds tool definitions per-run), so the manifest build does NOT
 * await the MCP start — it kicks the owner's start in the background on the
 * first build, and the owner invalidates the cache when discovery lands so
 * the NEXT read carries the real MCP tools. A chat run whose very first
 * action is an MCP tool call still works: the executor dispatches an MCP name
 * through the runtime owner directly, which awaits the (already in-flight)
 * start rather than relying on the manifest snapshot.
 */
export function getToolManifest(): readonly WebToolEntry[] {
  if (cachedManifest === undefined) {
    // Kick the runtime start only when the owner has not already started
    // (started or in-flight). A repeat read while a start is in flight joins
    // it rather than double-connecting; the generation guard ensures the
    // invalidation the start produces is not lost between this build's own
    // invalidation and the start resolving.
    if (!mcpRuntimeStarted()) {
      const kick = ++mcpManifestKickGeneration;
      void ensureMcpRuntimeStarted()
        .then(() => {
          // Discovery landed: rebuild so the real MCP tools enter the manifest
          // the next time anyone asks — but only if no NEWER kick has been
          // stamped since (a config edit would re-kick and re-invalidate).
          if (kick === mcpManifestKickGeneration && mcpManifestKickConsumed < kick) {
            mcpManifestKickConsumed = kick;
            cachedManifest = undefined;
          }
        })
        .catch((err: unknown) => {
          // A superseded start is the owner's fence working (a newer config
          // build or a teardown replaced it) — never a failure to report. A
          // shut-down refusal is the final seal working — the process is
          // exiting; the manifest needs no MCP entries for it.
          if (isMcpStartSupersededError(err) || isMcpRuntimeShutDownError(err)) return;
          // A failed start is surfaced through the status route; the manifest
          // honestly carries no MCP entries. Logged (not swallowed) so the
          // failure is visible when debug is on.
          webWarn("tools-bridge", "background MCP runtime start failed", () => mcpWarnErrorPayload(err));
        });
    }
    cachedManifest = buildUnifiedManifest();
  }
  return cachedManifest;
}

/** Invalidate the manifest cache (call after a config edit that changes
 * the tool surface — enabled list or MCP servers). */
export function invalidateToolManifestCache(): void {
  cachedManifest = undefined;
}

/**
 * The names of every REGISTERED tool — the full registry, enabled AND
 * disabled alike, reduced to bare names. This is the read the safety gate
 * needs to tell a tool the user switched off at the breaker from a genuine
 * ghost (a hallucinated tool no manifest entry carries): the enabled
 * definitions alone cannot make that distinction, and calling a real tool
 * "not registered" is a lie about the install. Names only — this is a
 * registry INTERNAL, not a manifest endpoint: no definitions, no schemas,
 * no client surface (the full-manifest endpoint rule is untouched).
 */
export function getRegisteredToolNames(): readonly string[] {
  return getToolManifest().map((entry) => entry.name);
}

/**
 * The tools actually sent to the LLM: the full manifest filtered by the
 * config's `tools.enabled` list. When the enabled list is empty/unset, ALL
 * tools are sent — built-in AND live MCP tools (both are genuinely callable;
 * an MCP tool only enters the manifest when its server is connected and has
 * advertised it, so there is no phantom).
 *
 * When the enabled list IS set it governs the BUILT-IN surface as the
 * explicit add-list (an operator's "only these tools" decision). A LIVE MCP
 * tool is never silently dropped by that list: the MCP server's own
 * `enabled` flag in `tools.mcpServers` is the operator's switch for it, and
 * a connected server's tools are already a deliberate, opted-in addition
 * (the server would not be configured otherwise). An operator who wants a
 * connected MCP server's tools withheld from the model disables the SERVER
 * — which also stops paying its connection — rather than naming every tool
 * it might ever advertise in the global list (a list that cannot know the
 * names until discovery). Per-session overrides still win per tool.
 */
export function getEnabledToolManifest(): readonly WebToolEntry[] {
  return getEnabledToolManifestForSession(new Map());
}

/**
 * THE MERGE RULE, the one owner (CFG-0 B1: it was restated in four places on
 * the server and recomputed WRONGLY in the browser, which ignored the global
 * list): a per-account override wins for any category; with no override a
 * live MCP tool is enabled (a connected server is already an opt-in) and a
 * built-in tool follows the global `tools.enabled` list (empty = all).
 */
function toolEnabled(tool: WebToolEntry, overrides: ReadonlyMap<string, boolean>, globalEnabledSet: ReadonlySet<string> | null): boolean {
  const override = overrides.get(tool.name);
  if (override !== undefined) return override;
  if (tool.category === "mcp") return true;
  return globalEnabledSet === null || globalEnabledSet.has(tool.name);
}

/** The global `tools.enabled` list as a set, or null when it is empty (all enabled). */
function globalEnabledToolSet(): ReadonlySet<string> | null {
  const globalEnabled = getEnabledTools();
  return globalEnabled.length > 0 ? new Set(globalEnabled) : null;
}

/**
 * (tools per user): the tools actually sent to the LLM for a given
 * session. The global config's `tools.enabled` list is the DEFAULT; the
 * per-session overrides (a Map<toolName, enabled>) take precedence. When the
 * global list is empty (all enabled by default), a per-session override can
 * still disable a specific tool. MCP entries are never sent as callable.
 *
 * This is the single merge point — the run route calls this with the
 * session's overrides loaded from the DB. The global `getEnabledToolManifest`
 * (no session) remains for callers without a session (tests, CLI).
 */
export function getEnabledToolManifestForSession(
  sessionOverrides: ReadonlyMap<string, boolean>,
): readonly WebToolEntry[] {
  const globalEnabledSet = globalEnabledToolSet();
  return getToolManifest().filter((t) => toolEnabled(t, sessionOverrides, globalEnabledSet));
}

/** The names of the tools effectively enabled for one account (its overrides over the global default). */
export function effectiveEnabledToolNames(overrides: ReadonlyMap<string, boolean>): readonly string[] {
  return getEnabledToolManifestForSession(overrides).map((t) => t.name);
}

/** One built-in tool's effective state for one account. */
export type ToolAccountState = Readonly<{
  name: string;
  description: string;
  enabled: boolean;
  /** `"you"` when a per-user override row decides, `"default"` when the
   *  shared config's enabled list does. */
  source: "you" | "default";
}>;

/**
 * The per-account view of the ENTIRE gated tool surface: every manifest
 * tool — built-in AND live MCP — with its EFFECTIVE enabled state, resolved
 * by the same merge rule `getEnabledToolManifestForSession` applies
 * (override wins; a live MCP tool defaults to enabled because a connected
 * server is already an operator's opt-in; the global enabled list governs
 * the built-in surface) — plus WHERE each answer came from, so a surface
 * can say "you turned this off" versus "off by default".
 *
 * The MCP half is not optional furniture: the run's tool decisions are
 * gated per tool for ANY category (a user can switch a live MCP tool off
 * for their own run; the gate's auto-trip flips MCP tools too), so the
 * surfaces that READ per-tool state — the breaker panel first among them,
 * whose rows derive from here — must list MCP tools or the gate's own
 * promised exits ("re-enable it from the breaker panel") are dead doors.
 *
 * Lives HERE because the bridge is the single owner of manifest access
 * (`tool-registry-owner` guard): callers pass the user's override rows and
 * never touch `getToolManifest` themselves.
 */
export function getToolAccountStates(
  overrides: ReadonlyMap<string, boolean>,
): readonly ToolAccountState[] {
  const globalEnabledSet = globalEnabledToolSet();
  return getToolManifest()
    .map((t) => {
      const override = overrides.get(t.name);
      const enabled = toolEnabled(t, overrides, globalEnabledSet);
      return {
        name: t.name,
        description: t.description,
        enabled,
        source: (override !== undefined ? "you" : "default") as "you" | "default",
      };
    });
}

/** Look up one manifest entry by name — bridge-owned manifest access. */
export function findManifestTool(name: string): WebToolEntry | undefined {
  return getToolManifest().find((t) => t.name === name);
}

/**
 * Convert tool manifest entries to OpenAI-compatible ToolDefinition[] for
 * the LLM stream request. The manifest entry's `inputSchema` is the JSON
 * Schema `parameters` object; the LLM client sends it verbatim. This is
 * the sole owner of the manifest→LLM tool-shape mapping.
 */
export function manifestEntriesToToolDefinitions(
  entries: readonly ToolManifestEntry[],
): readonly ToolDefinition[] {
  return entries.map((entry) => ({
    type: "function" as const,
    function: {
      name: entry.name,
      description: entry.description,
      parameters: entry.inputSchema,
    },
  }));
}
