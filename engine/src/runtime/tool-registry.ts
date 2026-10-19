import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";

import { extractErrorMessage, HarnessError, InputError, SecurityError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { FileSliceIndex, type SliceResult, type SkeletonResult, type ViewportResult } from "../intelligence/file-slice.ts";
import { QuickViewIndex, extractNameFromQuery, type QuickViewResult } from "../intelligence/quick-view.ts";
import { relativePathViolationKinds, type RelativePathViolationKind } from "../filesystem/path-boundary.ts";
import type { MetricsCollector, MetricScopeKey } from "../performance/metrics-collector.ts";
import { DEFAULT_PRIVACY_POLICY, type PrivacyPolicy } from "../privacy/privacy-policy.ts";
import { viewFile } from "../privacy/file-viewer.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import type { ToolDefinition } from "./provider-adapter.ts";

/**
 * Minimal tool registry for the interactive runtime.
 *
 * Provides a small set of read-only filesystem tools that the model can
 * call during a chat session. All tools enforce path safety: they reject
 * absolute paths, traversal segments, and symlinks, and confine access
 * to the repository root.
 *
 * Tool handlers are pure functions that accept a JSON-validated arguments
 * object and return a string result. The registry is injectable so tests
 * can supply mock tools.
 */

const MAX_LIST_ENTRIES = 1_000;
const MAX_FILE_PATH_BYTES = 4_096;

export type ToolHandler = (args: Readonly<Record<string, unknown>>, context: ToolContext) => string;

export type ToolAsyncHandler = (
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
  signal?: AbortSignal,
) => Promise<string>;

export type ToolContext = Readonly<{
  repositoryRoot: string;
}>;

export type RegisteredTool = Readonly<{
  definition: ToolDefinition;
  handler: ToolHandler;
  asyncHandler?: ToolAsyncHandler;
}>;

export type ToolResult = Readonly<{
  toolCallId: string;
  name: string;
  content: string;
  isError: boolean;
}>;

export type ToolRegistryOptions = Readonly<{
  metricsCollector?: MetricsCollector;
  privacyPolicy?: PrivacyPolicy;
  toolsLimits?: Readonly<{ maxReadBytes?: number; maxListEntries?: number }>;
  /**
   * Optional allowlist of tool names. When provided and non-empty, only tools
   * whose name is in the list are registered; others are silently skipped
   * (the config document's `tools.enabled`). When undefined/empty, all tools
   * register (backwards compatible).
   */
  enabledTools?: readonly string[];
  /**
   * Hard ceiling on the total number of registered tools. Registering beyond
   * this limit throws a `SecurityError` (`tool_limit_exceeded`). Defaults to
   * `ROOT_POLICY.tools.limits.maximumEnabledTools`.
   */
  maxTools?: number;
  /**
   * When `false`, the registry starts EMPTY — the default read/list/AST seed
   * tools are NOT registered. The registry is injectable precisely so an
   * embedder can supply its own surface; a host (the web server) that wires
   * its OWN tool pipeline into the runtime uses this to avoid the seeds
   * colliding with the host's same-named tools on `register`. Default
   * `true` (the CLI's behavior is unchanged).
   */
  seedDefaults?: boolean;
}>;

export function createToolRegistry(options?: ToolRegistryOptions): ToolRegistry {
  const tools = new Map<string, RegisteredTool>();
  const metrics = options?.metricsCollector;
  const privacyPolicy = options?.privacyPolicy ?? DEFAULT_PRIVACY_POLICY;
  // CONF-2 / privacy SSOT: the read_file tool's filesystem read ceiling
  // defaults to the privacy policy's `maxFileBytes` (set from central config),
  // not a hardcoded local literal. `tools.limits.maxReadBytes` from config
  // still overrides when present so operators can raise the disk-read ceiling
  // above the privacy view limit. The file VIEWER (`viewFile`) always uses
  // `policy.maxFileBytes` as its view limit, so the configured privacy limit
  // can never be bypassed via the tool-registry path.
  const maxReadBytes = options?.toolsLimits?.maxReadBytes ?? privacyPolicy.maxFileBytes;
  const maxListEntries = options?.toolsLimits?.maxListEntries ?? MAX_LIST_ENTRIES;
  const enabledTools = options?.enabledTools !== undefined && options.enabledTools.length > 0
    ? new Set<string>(options.enabledTools)
    : undefined;
  const maxTools = options?.maxTools ?? ROOT_POLICY.tools.limits.maximumEnabledTools;

  /**
   * Shared admission: apply the allowlist (skip silently) and the tool-count
   * ceiling (throw SecurityError). Used by both the default-tool seed loop and
   * `register` so the policy cannot be bypassed by either path.
   */
  function addTool(tool: RegisteredTool): void {
    const name = tool.definition.function.name;
    if (enabledTools !== undefined && !enabledTools.has(name)) return;
    if (tools.size >= maxTools) {
      throw new SecurityError(
        `tool_limit_exceeded: maximum ${maxTools} tools allowed, attempted to register ${name}`,
        "tool_limit_exceeded",
      );
    }
    tools.set(name, tool);
  }

  const indexCache = createIndexCache();

  if (options?.seedDefaults !== false) {
    for (const tool of [
      createReadFileTool(privacyPolicy, maxReadBytes),
      createListFilesTool(maxListEntries),
      createQuickViewTool(indexCache, privacyPolicy),
      createSliceTool(indexCache, privacyPolicy),
      createViewportTool(indexCache, privacyPolicy),
      createSkeletonTool(indexCache),
    ]) {
      addTool(tool);
    }
  }
  function toolMetricsKey(name: string): MetricScopeKey | undefined {
    return metrics ? { module: "tool-registry", function: name, scope: "tool" } : undefined;
  }
  return deepFreeze({
    register(tool: RegisteredTool): void {
      if (tools.has(tool.definition.function.name)) {
        throw new InputError(
          `Tool ${tool.definition.function.name} is already registered`,
          "tool_duplicate",
        );
      }
      addTool(tool);
    },
    get(name: string): RegisteredTool | undefined {
      return tools.get(name);
    },
    definitions(): readonly ToolDefinition[] {
      return Object.freeze([...tools.values()].map((t) => t.definition));
    },
    names(): readonly string[] {
      return [...tools.keys()];
    },
    size(): number {
      return tools.size;
    },
    execute(call: Readonly<{ id: string; name: string; arguments: string }>, context: ToolContext): ToolResult {
      const tool = tools.get(call.name);
      const key = toolMetricsKey(call.name);
      const startMs = metrics ? performance.now() : 0;
      if (tool === undefined) {
        if (metrics && key) metrics.recordCall(key, { toolName: call.name }, 0, "failed", "shared");
        return errorResult(call.id, call.name, `Unknown tool: ${call.name}`, "tool_unknown");
      }
      let args: Readonly<Record<string, unknown>>;
      try {
        args = parseToolArguments(call.arguments);
      } catch (error) {
        if (metrics && key) metrics.recordCall(key, { toolName: call.name }, 0, "failed", "shared");
        return errorResult(call.id, call.name, extractErrorMessage(error), "tool_arguments_invalid");
      }
      try {
        const content = tool.handler(args, context);
        if (metrics && key) metrics.recordCall(key, { toolName: call.name }, performance.now() - startMs, "succeeded", "shared");
        return deepFreeze({ toolCallId: call.id, name: call.name, content, isError: false });
      } catch (error) {
        if (metrics && key) metrics.recordCall(key, { toolName: call.name }, performance.now() - startMs, "failed", "shared");
        return errorResult(call.id, call.name, extractErrorMessage(error), "tool_execution_failed");
      }
    },
    async executeAsync(
      call: Readonly<{ id: string; name: string; arguments: string }>,
      context: ToolContext,
      signal?: AbortSignal,
    ): Promise<ToolResult> {
      const tool = tools.get(call.name);
      const key = toolMetricsKey(call.name);
      const startMs = metrics ? performance.now() : 0;
      if (tool === undefined) {
        if (metrics && key) metrics.recordCall(key, { toolName: call.name }, 0, "failed", "shared");
        return errorResult(call.id, call.name, `Unknown tool: ${call.name}`, "tool_unknown");
      }
      let args: Readonly<Record<string, unknown>>;
      try {
        args = parseToolArguments(call.arguments);
      } catch (error) {
        if (metrics && key) metrics.recordCall(key, { toolName: call.name }, 0, "failed", "shared");
        return errorResult(call.id, call.name, extractErrorMessage(error), "tool_arguments_invalid");
      }
      if (tool.asyncHandler !== undefined) {
        try {
          const content = await tool.asyncHandler(args, context, signal);
          if (metrics && key) metrics.recordCall(key, { toolName: call.name }, performance.now() - startMs, "succeeded", "shared");
          return deepFreeze({ toolCallId: call.id, name: call.name, content, isError: false });
        } catch (error) {
          if (signal?.aborted === true) {
            if (metrics && key) metrics.recordCall(key, { toolName: call.name }, performance.now() - startMs, "cancelled", "shared");
            return deepFreeze({ toolCallId: call.id, name: call.name, content: "Tool execution cancelled", isError: true });
          }
          if (metrics && key) metrics.recordCall(key, { toolName: call.name }, performance.now() - startMs, "failed", "shared");
          return errorResult(call.id, call.name, extractErrorMessage(error), "tool_execution_failed");
        }
      }
      try {
        const content = tool.handler(args, context);
        if (metrics && key) metrics.recordCall(key, { toolName: call.name }, performance.now() - startMs, "succeeded", "shared");
        return deepFreeze({ toolCallId: call.id, name: call.name, content, isError: false });
      } catch (error) {
        if (metrics && key) metrics.recordCall(key, { toolName: call.name }, performance.now() - startMs, "failed", "shared");
        return errorResult(call.id, call.name, extractErrorMessage(error), "tool_execution_failed");
      }
    },
  });
}

export type ToolRegistry = Readonly<{
  register(tool: RegisteredTool): void;
  get(name: string): RegisteredTool | undefined;
  definitions(): readonly ToolDefinition[];
  names(): readonly string[];
  size(): number;
  execute(call: Readonly<{ id: string; name: string; arguments: string }>, context: ToolContext): ToolResult;
  executeAsync(
    call: Readonly<{ id: string; name: string; arguments: string }>,
    context: ToolContext,
    signal?: AbortSignal,
  ): Promise<ToolResult>;
}>;

function errorResult(id: string, name: string, message: string, _code: string): ToolResult {
  return deepFreeze({ toolCallId: id, name, content: message, isError: true });
}

function parseToolArguments(raw: string): Readonly<Record<string, unknown>> {
  if (raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HarnessError("Tool arguments are not valid JSON", "tool_arguments_invalid");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HarnessError("Tool arguments must be a JSON object", "tool_arguments_invalid");
  }
  return parsed as Record<string, unknown>;
}

function resolveSafePath(input: string, repositoryRoot: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new InputError("Path argument is required", "tool_path_missing");
  }
  if (Buffer.byteLength(input, "utf8") > MAX_FILE_PATH_BYTES) {
    throw new InputError("Path exceeds maximum length", "tool_path_oversized");
  }
  const normalized = normalize(input);
  const violations = relativePathViolationKinds(normalized);
  const isRootReference = normalized === ".";
  const effectiveViolations = isRootReference
    ? violations.filter((kind) => kind !== "dot-segment")
    : violations;
  if (effectiveViolations.length > 0) {
    throw pathViolationError(effectiveViolations);
  }
  const resolved = join(repositoryRoot, normalized);
  const rel = relative(repositoryRoot, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new SecurityError("Path escapes repository root", "tool_path_escape");
  }
  let stats;
  try {
    stats = lstatSync(resolved, { bigint: true, throwIfNoEntry: false });
  } catch {
    throw new HarnessError("Path could not be inspected", "tool_path_inspect_failed");
  }
  if (stats === undefined) {
    throw new InputError("Path does not exist", "tool_path_not_found");
  }
  if (stats.isSymbolicLink()) {
    throw new SecurityError("Symlinks are forbidden", "tool_path_symlink");
  }
  return resolved;
}

function pathViolationError(violations: readonly RelativePathViolationKind[]): SecurityError | InputError {
  if (violations.includes("absolute")) {
    return new SecurityError("Absolute paths are forbidden", "tool_path_absolute");
  }
  if (violations.includes("dot-segment")) {
    return new SecurityError("Path traversal is forbidden", "tool_path_traversal");
  }
  if (violations.includes("backslash")) {
    return new SecurityError("Backslash in path is forbidden", "tool_path_backslash");
  }
  if (violations.includes("control-character")) {
    return new SecurityError("Control characters in path are forbidden", "tool_path_control");
  }
  if (violations.includes("empty-segment")) {
    return new SecurityError("Empty path segments are forbidden", "tool_path_empty_segment");
  }
  if (violations.includes("empty")) {
    return new InputError("Path argument is required", "tool_path_missing");
  }
  return new SecurityError("Path is invalid", "tool_path_invalid");
}

function createReadFileTool(policy: PrivacyPolicy, maxReadBytes: number = policy.maxFileBytes): RegisteredTool {
  return deepFreeze({
    definition: {
      type: "function",
      function: {
        name: "read_file",
        description: "FALLBACK read tool: returns the redacted UTF-8 text of a whole file. Prefer `slice` (AST function body, ~187 tokens) or `skeleton` (file structure, ~30 tokens) — read_file is for binary/unknown-language files or exact raw-byte needs the editor preimage check requires. Path must be relative; detected credential/PII spans are redacted.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative path to the file (e.g. 'src/cli.ts')",
            },
          },
          required: ["path"],
        },
      },
    },
    handler(args, context): string {
      const pathArg = args.path;
      if (typeof pathArg !== "string") {
        throw new InputError("path must be a string", "tool_arguments_invalid");
      }
      const resolved = resolveSafePath(pathArg, context.repositoryRoot);
      const stats = lstatSync(resolved, { bigint: true, throwIfNoEntry: false });
      if (!stats || !stats.isFile()) {
        throw new InputError("Path is not a regular file", "tool_path_not_file");
      }
      if (stats.size > BigInt(maxReadBytes)) {
        throw new InputError(
          `File exceeds maximum read size of ${maxReadBytes} bytes`,
          "tool_file_oversized",
        );
      }
      const bytes = readFileSync(resolved);
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      // The view limit is sourced from `policy.maxFileBytes` (the configured
      // privacy limit), NOT `maxReadBytes` (the disk-read ceiling). This keeps
      // the privacy limit authoritative: even if `tools.limits.maxReadBytes`
      // is configured above `privacy.maxFileBytes`, the viewer never emits
      // more than the privacy limit.
      const view = viewFile(pathArg, text, { policy });
      // A REFUSAL IS RAISED, NOT RETURNED AS EMPTINESS. When the viewer cannot
      // certify the redaction it has no content to hand over, and returning
      // its (formerly empty) payload told the model the file was empty — a
      // safety check reading downstream as a successful read of nothing.
      if (view.outcome === "refused") {
        throw new SecurityError(
          `Reading ${pathArg} was refused: ${view.blockReason}`,
          "tool_file_view_refused",
        );
      }
      return view.content;
    },
  });
}

function createListFilesTool(maxListEntries: number = MAX_LIST_ENTRIES): RegisteredTool {
  return deepFreeze({
    definition: {
      type: "function",
      function: {
        name: "list_files",
        description: "List files and directories within a directory of the repository root. The path must be relative and must not contain traversal segments.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative path to the directory (e.g. 'src'). Defaults to repository root.",
            },
          },
          required: [],
        },
      },
    },
    handler(args, context): string {
      const dirArg = typeof args.path === "string" && args.path.length > 0 ? args.path : ".";
      const resolved = resolveSafePath(dirArg, context.repositoryRoot);
      const stats = lstatSync(resolved, { bigint: true, throwIfNoEntry: false });
      if (!stats || !stats.isDirectory()) {
        throw new InputError("Path is not a directory", "tool_path_not_directory");
      }
      const entries = readdirSync(resolved, { withFileTypes: true })
        .filter((e) => !e.name.startsWith(".git"))
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .slice(0, maxListEntries);
      const lines = entries.map((e) => `${e.isDirectory() ? "dir" : e.isFile() ? "file" : "other"}\t${e.name}`);
      return lines.join("\n");
    },
  });
}

// ---------------------------------------------------------------------------
// quick_view / slice / viewport / skeleton — the AST-based replacements for
// grep + read_file (EXP398 / EXP334 / EXP355 / EXP365). quick_view is 137×
// faster than ripgrep at 3.8× fewer tokens (99.8% completeness); slice
// returns the AST function body (~187 tokens vs full file 2000-20000+).
//
// These tools build their AST index lazily on first call (per
// repositoryRoot) so a session that never uses them pays nothing. The
// index is cached for the session on a closure Map keyed by root. The
// slice/viewport outputs route through the privacy file-viewer so a
// slice containing a secret never egresses raw (same redaction path as
// read_file).
//
// read_file remains registered as a FALLBACK for binary files, unknown
// languages (no AST parser), and exact-byte needs (editor preimage). It
// is no longer the DEFAULT read tool.
// ---------------------------------------------------------------------------

type IndexCache = Readonly<{ quick: Map<string, QuickViewIndex>; slice: Map<string, FileSliceIndex> }>;

function createIndexCache(): IndexCache {
  return { quick: new Map(), slice: new Map() };
}

function getQuickIndex(cache: IndexCache, root: string): QuickViewIndex {
  let idx = cache.quick.get(root);
  if (idx === undefined) {
    idx = new QuickViewIndex(root);
    cache.quick.set(root, idx);
  }
  return idx;
}

function getSliceIndex(cache: IndexCache, root: string): FileSliceIndex {
  let idx = cache.slice.get(root);
  if (idx === undefined) {
    idx = new FileSliceIndex(root);
    cache.slice.set(root, idx);
  }
  return idx;
}

function redactSlice(policy: PrivacyPolicy, file: string, slice: string): string {
  const view = viewFile(file, slice, { policy, mode: "full" });
  // Same refusal discipline as `read_file`: a slice whose redaction could not
  // be certified is refused out loud, never returned as an empty slice.
  if (view.outcome === "refused") {
    throw new SecurityError(
      `Showing a slice of ${file} was refused: ${view.blockReason}`,
      "tool_file_view_refused",
    );
  }
  return view.content;
}

function createQuickViewTool(cache: IndexCache, policy: PrivacyPolicy): RegisteredTool {
  return deepFreeze({
    definition: {
      type: "function",
      function: {
        name: "quick_view",
        description: "AST-based replacement for grep (EXP398, 137× faster, 3.8× fewer tokens, 99.8% completeness). Given a function/class/type name (or a natural-language description containing one), return EVERY edit location: definition, callers, near-duplicate clones, type references, test calls, and doc mentions. Use this BEFORE modifying a symbol so you see the full blast radius. Falls back to execute_command(grep) only for binary files or unknown languages.",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Symbol name (e.g. 'createToolRegistry') or a natural-language description containing one (e.g. 'where is the registry created').",
            },
          },
          required: ["name"],
        },
      },
    },
    handler(args, context): string {
      const raw = typeof args.name === "string" ? args.name : "";
      if (raw.length === 0) {
        throw new InputError("name is required", "tool_arguments_invalid");
      }
      const name = extractNameFromQuery(raw) ?? raw.trim().split(/\s+/)[0];
      if (!name) {
        throw new InputError("could not extract a symbol name from the query", "tool_arguments_invalid");
      }
      const idx = getQuickIndex(cache, context.repositoryRoot);
      const result: QuickViewResult = idx.query(name);
      const summary = idx.getSummary();
      const redactedView = deepFreeze({
        definition: result.view.definition,
        callers: result.view.callers.map((c) => ({
          ...c,
          ...(c.context !== undefined ? { context: redactSlice(policy, c.file, c.context) } : {}),
        })),
        clones: result.view.clones,
        typeRefs: result.view.typeRefs,
        tests: result.view.tests.map((t) => ({
          ...t,
          ...(t.context !== undefined ? { context: redactSlice(policy, t.file, t.context) } : {}),
        })),
        docs: result.view.docs.map((d) => ({
          ...d,
          ...(d.text !== undefined ? { text: redactSlice(policy, d.file, d.text) } : {}),
        })),
      });
      return JSON.stringify(deepFreeze({
        name: result.name,
        totals: result.totals,
        tokenEstimate: result.tokenEstimate,
        view: redactedView,
        indexSummary: summary,
        fallback: "Use execute_command with grep/rg for binary files or languages without an AST parser.",
      }));
    },
  });
}

function createSliceTool(cache: IndexCache, policy: PrivacyPolicy): RegisteredTool {
  return deepFreeze({
    definition: {
      type: "function",
      function: {
        name: "slice",
        description: "AST-based replacement for read_file (EXP334/355, ~187 tokens vs full file 2000-20000+). Return the function/class body + signature (capped at 150 lines) for a named symbol, plus its callers. Output is redacted (secrets removed). Use this instead of read_file to understand or edit a function. Falls back to read_file for binary files or unsupported extensions.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Function/class/method name to slice" },
            file: { type: "string", description: "Optional file hint to disambiguate when multiple matches exist (relative path, e.g. 'src/runtime/tool-registry.ts')" },
          },
          required: ["name"],
        },
      },
    },
    handler(args, context): string {
      const name = typeof args.name === "string" ? args.name : "";
      if (name.length === 0) {
        throw new InputError("name is required", "tool_arguments_invalid");
      }
      const fileHint = typeof args.file === "string" && args.file.length > 0 ? args.file : null;
      const idx = getSliceIndex(cache, context.repositoryRoot);
      const result: SliceResult = idx.slice(name, fileHint);
      const redacted = redactSlice(policy, result.file, result.slice);
      return JSON.stringify(deepFreeze({ ...result, slice: redacted }));
    },
  });
}

function createViewportTool(cache: IndexCache, policy: PrivacyPolicy): RegisteredTool {
  return deepFreeze({
    definition: {
      type: "function",
      function: {
        name: "viewport",
        description: "Return a bounded line window (default max 200 lines) of a file, redacted. Use this when you need exact raw lines (e.g. to copy a preimage for the editor) but the file is too large for read_file. For understanding a function, prefer `slice`.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path to the file (e.g. 'src/cli.ts')" },
            startLine: { type: "integer", minimum: 1, description: "First line to include (1-indexed)" },
            endLine: { type: "integer", minimum: 1, description: "Last line to include (1-indexed)" },
          },
          required: ["path", "startLine", "endLine"],
        },
      },
    },
    handler(args, context): string {
      const path = typeof args.path === "string" ? args.path : "";
      const startLine = typeof args.startLine === "number" ? args.startLine : 0;
      const endLine = typeof args.endLine === "number" ? args.endLine : 0;
      if (path.length === 0) {
        throw new InputError("path is required", "tool_arguments_invalid");
      }
      if (startLine < 1 || endLine < 1) {
        throw new InputError("startLine and endLine must be >= 1", "tool_arguments_invalid");
      }
      const idx = getSliceIndex(cache, context.repositoryRoot);
      const result: ViewportResult = idx.viewport(path, startLine, endLine);
      const redacted = redactSlice(policy, result.file, result.viewport);
      return JSON.stringify(deepFreeze({ ...result, viewport: redacted }));
    },
  });
}

function createSkeletonTool(cache: IndexCache): RegisteredTool {
  return deepFreeze({
    definition: {
      type: "function",
      function: {
        name: "skeleton",
        description: "Return the AST skeleton of a file: one line per top-level declaration (signature + callees), ~30-50 tokens regardless of file size. Use this to understand file structure in one turn (EXP365), then call `slice` for the functions you need.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path to the file (e.g. 'src/runtime/tool-registry.ts')" },
          },
          required: ["path"],
        },
      },
    },
    handler(args, context): string {
      const path = typeof args.path === "string" ? args.path : "";
      if (path.length === 0) {
        throw new InputError("path is required", "tool_arguments_invalid");
      }
      const idx = getSliceIndex(cache, context.repositoryRoot);
      const result: SkeletonResult = idx.skeleton(path);
      return JSON.stringify(result);
    },
  });
}
