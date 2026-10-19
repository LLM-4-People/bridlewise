import { InputError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import type { ToolManifestEntry } from "./tool-manifest.ts";
import { DEFAULT_TOOL_RESOURCE_BOUNDS } from "./tool-manifest.ts";

/**
 * THE BUILT-IN TOOLS AS DATA — their names, their schemas, their bounds, and
 * the adapter each one is answered by. No behaviour, and in particular NO
 * SUBPROCESS.
 *
 * ── WHY THIS IS A SEPARATE MODULE FROM THE ADAPTERS ───────────────────────
 *
 * `execute_command`'s adapter spawns a program whose NAME the model supplies.
 * That is the most dangerous capability in the system, and it belongs to
 * whichever process is prepared to confine it. The manifest is the opposite
 * kind of thing: a description, consumed by anything that wants to show or
 * validate the tool list.
 *
 * They used to live in one file, and the consequence was measured on the
 * import graph rather than guessed at: the web server imports the manifest
 * only — it has its own executor and its own sandbox — and importing it
 * dragged the unconfined spawner into the server's reachable set, one import
 * away from any future call site. That is the exact shape of a violation that
 * walked past a source-scan guard which only ever read the text of `server/`.
 *
 * Splitting them means the capability travels with the code that needs it. A
 * consumer that wants to LIST the tools cannot accidentally acquire the
 * ability to RUN one, because there is no edge from here to a spawn.
 */

/**
 * Adapter identifiers — the join between a manifest entry and the adapter that
 * answers it. Declared here, with the entries that reference them, and
 * imported by the adapter module; the reverse direction would put the manifest
 * back on the far side of the subprocess import.
 */
export const ADAPTER_ID_COMMAND = "builtin-execute-command";
export const ADAPTER_ID_SEARCH = "builtin-search-web";
export const ADAPTER_ID_FETCH = "builtin-fetch-page";
export const ADAPTER_ID_DOCS = "builtin-read-docs";
export const ADAPTER_ID_REPO = "builtin-repo-question";

/**
 * Hard timeout fallback for `execute_command` when no config is supplied.
 * The single owner of the runtime timeout is the value passed in via
 * `ExecuteCommandOptions.timeoutMs` (sourced from the central config
 * document's `tools.defaultBounds.timeoutMs`); this constant is only the floor
 * default when no config is provided, matching
 * {@link DEFAULT_TOOL_RESOURCE_BOUNDS.timeoutMs}.
 */
const DEFAULT_EXECUTE_COMMAND_TIMEOUT_MS = DEFAULT_TOOL_RESOURCE_BOUNDS.timeoutMs;

/**
 * Validate and resolve the `execute_command` timeout. Shared by the manifest
 * entry and the adapter so the bound a caller is SHOWN is the bound the
 * adapter will actually enforce — two copies of this arithmetic would be two
 * numbers that can disagree.
 */
export function resolveExecuteCommandTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_EXECUTE_COMMAND_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new InputError("execute_command timeoutMs must be a positive finite number", "tool_timeout_invalid");
  }
  if (timeoutMs > ROOT_POLICY.tools.limits.maximumToolTimeoutMs) {
    throw new InputError("execute_command timeoutMs exceeds root policy maximum", "tool_timeout_oversized");
  }
  return timeoutMs;
}

export type BuiltInToolManifestOptions = Readonly<{
  executeCommandTimeoutMs?: number;
}>;

export function createBuiltInToolManifestEntries(
  options: BuiltInToolManifestOptions = {},
): readonly ToolManifestEntry[] {
  const executeCommandTimeoutMs = resolveExecuteCommandTimeoutMs(options.executeCommandTimeoutMs);
  return deepFreeze([
    {
      id: "execute_command",
      name: "execute_command",
      description: "Run a shell command asynchronously with timeout, cancellation, and output capture. Only commands in the allowed list may be used. command: the executable name ONLY (no arguments, no spaces — e.g. \"git\", not \"git status\"). args: array of argument strings (e.g. [\"status\", \"--short\"]). File-mutating commands (touch, mkdir, cp, mv, sed -i, awk -i inplace) are governed: every target path must be inside the session write set (granted via the chat --write-set flag); otherwise the command is denied.",
      label: "run command",
      inputSchema: deepFreeze({
        type: "object",
        properties: {
          command: { type: "string", description: "The executable name ONLY (no arguments, no spaces; must be in the allowed list)" },
          args: { type: "array", items: { type: "string" }, description: "Arguments as an array of strings (one element per argument)" },
          cwd: { type: "string", description: "Working directory (defaults to repository root)" },
        },
        required: ["command"],
        additionalProperties: false,
      }),
      outputSchema: deepFreeze({
        type: "object",
        properties: {
          exitCode: { type: ["integer", "null"] },
          stdout: { type: "string" },
          stderr: { type: "string" },
          cancelled: { type: "boolean" },
        },
      }),
      capabilities: ["read", "execute"],
      outputShape: "command",
      bounds: deepFreeze({ ...DEFAULT_TOOL_RESOURCE_BOUNDS, timeoutMs: executeCommandTimeoutMs }),
      adapterId: ADAPTER_ID_COMMAND,
    },
    {
      id: "search_web",
      name: "search_web",
      description: "Search the web via a pluggable search adapter (Kagi-ready). Returns titles, URLs, and snippets.",
      label: "search the web",
      inputSchema: deepFreeze({
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum results (default 10)" },
        },
        required: ["query"],
        additionalProperties: false,
      }),
      outputSchema: deepFreeze({
        type: "object",
        properties: {
          results: { type: "array", items: { type: "object" } },
        },
      }),
      capabilities: ["read", "network"],
      bounds: DEFAULT_TOOL_RESOURCE_BOUNDS,
      adapterId: ADAPTER_ID_SEARCH,
    },
    {
      id: "fetch_page",
      name: "fetch_page",
      description: "Fetch a web page via a pluggable page fetch adapter (Scrapling-ready). Returns page content in markdown, text, or html format.",
      label: "fetch a page",
      inputSchema: deepFreeze({
        type: "object",
        properties: {
          url: { type: "string", description: "The http or https URL to fetch" },
          format: { type: "string", enum: ["markdown", "text", "html"], description: "Output format (default markdown)" },
        },
        required: ["url"],
        additionalProperties: false,
      }),
      outputSchema: deepFreeze({
        type: "object",
        properties: {
          url: { type: "string" },
          contentType: { type: "string" },
          statusCode: { type: "integer" },
        },
      }),
      capabilities: ["read", "network"],
      bounds: DEFAULT_TOOL_RESOURCE_BOUNDS,
      adapterId: ADAPTER_ID_FETCH,
    },
    {
      id: "read_docs",
      name: "read_docs",
      description: "Query library documentation via a pluggable docs adapter (Context7-ready). Returns documentation content for the given library and query.",
      label: "read docs",
      inputSchema: deepFreeze({
        type: "object",
        properties: {
          libraryId: { type: "string", description: "The library identifier (e.g. '/org/project')" },
          query: { type: "string", description: "The documentation query" },
        },
        required: ["libraryId", "query"],
        additionalProperties: false,
      }),
      outputSchema: deepFreeze({
        type: "object",
        properties: {
          libraryId: { type: "string" },
          sources: { type: "array", items: { type: "string" } },
        },
      }),
      capabilities: ["read", "network"],
      bounds: DEFAULT_TOOL_RESOURCE_BOUNDS,
      adapterId: ADAPTER_ID_DOCS,
    },
    {
      id: "repo_question",
      name: "repo_question",
      description: "Ask a question about a GitHub repository via a pluggable repo question adapter (DeepWiki-ready). Returns an answer with sources.",
      label: "ask about a repo",
      inputSchema: deepFreeze({
        type: "object",
        properties: {
          repo: { type: "string", description: "The GitHub repository in 'owner/repo' format" },
          question: { type: "string", description: "The question to ask about the repository" },
        },
        required: ["repo", "question"],
        additionalProperties: false,
      }),
      outputSchema: deepFreeze({
        type: "object",
        properties: {
          repo: { type: "string" },
          sources: { type: "array", items: { type: "string" } },
        },
      }),
      capabilities: ["read", "network"],
      bounds: deepFreeze({ ...DEFAULT_TOOL_RESOURCE_BOUNDS, timeoutMs: 60_000 }),
      adapterId: ADAPTER_ID_REPO,
    },
  ]);
}
