import { spawn } from "node:child_process";
import { COMMAND_ENVIRONMENT, projectEnvironment } from "../process/environment-projection.ts";
import { isAbsolute, normalize, resolve, sep } from "node:path";

import { extractErrorMessage, InputError, SecurityError } from "../kernel/errors.ts";
import { deepFreeze, generateId } from "../kernel/integrity.ts";
import { bestEffort } from "../shared/best-effort.ts";
import { guarded } from "../process/fault-policy.ts";
import type { ToolAdapter, ToolAdapterContext, ToolAdapterInput, ToolAdapterResult } from "./tool-adapter.ts";
// THE ADAPTER IDENTIFIERS AND THE TIMEOUT RULE LIVE WITH THE MANIFEST, and
// this module consumes them. The direction is deliberate: the manifest is
// data and must stay reachable without dragging a subprocess along with it,
// so the dependency points this way and never back.
import {
  ADAPTER_ID_COMMAND,
  ADAPTER_ID_DOCS,
  ADAPTER_ID_FETCH,
  ADAPTER_ID_REPO,
  ADAPTER_ID_SEARCH,
  resolveExecuteCommandTimeoutMs,
} from "./built-in-tool-manifest.ts";
import { assertString } from "../runtime/tool-args.ts";

/**
 * Built-in tool adapters and their manifest entries.
 *
 * Five governed tools are provided:
 * - execute_command: run a shell command asynchronously with timeout,
 * cancellation, and output capture. File-mutating commands (touch,
 * mkdir, cp, mv, sed -i, awk -i) are governed by the session write
 * set: every target path must resolve inside an authorized write-set
 * entry, the same authorization the transactional editor enforces,
 * so a model cannot bypass preimage/write-set/rollback governance by
 * shelling out (X-1).
 * - search_web: web search via a pluggable SearchAdapter (Kagi-ready)
 * - fetch_page: fetch a web page via a pluggable PageFetchAdapter
 * (Scrapling-ready)
 * - read_docs: query library documentation via a pluggable DocsAdapter
 * (Context7-ready)
 * - repo_question: ask about a GitHub repo via a pluggable
 * RepoQuestionAdapter (DeepWiki-ready)
 *
 * Each backend interface is injectable so tests can supply mocks and
 * production can supply real adapters. A missing adapter produces a
 * typed, structured blocker, never a silent fallback.
 */

const SHELL_METACHAR_PATTERN = /[;|&$<>`\n\r!#~(){}[\]]/u;
const MAX_CWD_BYTES = 4_096;
const MAX_QUERY_LENGTH = 2_048;
const MAX_URL_LENGTH = 4_096;
const MAX_REPO_LENGTH = 256;
const MAX_QUESTION_LENGTH = 4_096;
const MAX_LIBRARY_ID_LENGTH = 512;
const MAX_ARGS = 64;
const MAX_ARG_LENGTH = 4_096;

const DEFAULT_ALLOWED_COMMANDS = deepFreeze([
  "node", "npm", "npx", "git", "ls", "cat", "echo", "pwd", "wc",
  "head", "tail", "grep", "find", "rg", "fd", "sort", "uniq", "diff",
  "tsc", "eslint", "prettier", "python3", "python", "pip", "pip3",
  "cargo", "go", "rustc", "gcc", "make", "cmake", "jq", "sha256sum",
  "md5sum", "stat", "file", "basename", "dirname", "tr", "cut", "awk",
  "sed", "mkdir", "cp", "mv", "touch", "test",
] as const);

export type ExecuteCommandOptions = Readonly<{
  allowedCommands?: readonly string[];
  timeoutMs?: number;
  /**
   * Session write set (X-1). File-mutating commands ({@link
   * ALWAYS_MUTATING_COMMANDS}, plus sed/awk with an in-place flag) require
   * every target path to resolve inside one of these entries — an exact
   * match or a directory prefix — so shell commands cannot bypass the
   * transactional editor's preimage/write-set/rollback governance. Entries
   * may be absolute paths or repository-root-relative paths. When absent or
   * empty, all file-mutating commands are denied.
   */
  writeSet?: ReadonlySet<string>;
}>;

function resolveAllowedCommandSet(commands: readonly string[] | undefined): ReadonlySet<string> {
  return new Set<string>(commands ?? DEFAULT_ALLOWED_COMMANDS);
}

/**
 * Commands whose primary effect is a filesystem mutation. These are gated
 * unconditionally; sed/awk are gated only when an in-place flag is present
 * ({@link extractMutatingTargets}).
 */
const ALWAYS_MUTATING_COMMANDS = deepFreeze(new Set(["touch", "mkdir", "cp", "mv"]));
const CONDITIONALLY_MUTATING_COMMANDS = deepFreeze(new Set(["sed", "awk"]));

/**
 * Per-command option-arity tables used to separate target paths from option
 * values. GNU getopt semantics: a value-taking short option consumes the
 * rest of its token (e.g. `-m755`) or, when nothing follows, the next token
 * (e.g. `-m 755`); a value-taking long option consumes `--opt=value` inline
 * or `--opt value` as the next token. Everything after `--` is positional.
 */
type CommandOptionSpec = Readonly<{
  shortValueOptions: ReadonlySet<string>;
  longValueOptions: ReadonlySet<string>;
}>;

const COMMAND_OPTION_SPECS: Readonly<Record<string, CommandOptionSpec>> = deepFreeze({
  touch: deepFreeze({
    shortValueOptions: deepFreeze(new Set(["d", "t", "r"])),
    longValueOptions: deepFreeze(new Set(["date", "reference"])),
  }),
  mkdir: deepFreeze({
    shortValueOptions: deepFreeze(new Set(["m"])),
    longValueOptions: deepFreeze(new Set(["mode"])),
  }),
  cp: deepFreeze({
    shortValueOptions: deepFreeze(new Set(["t", "S"])),
    longValueOptions: deepFreeze(new Set(["target-directory", "suffix", "backup", "reflink", "sparse"])),
  }),
  mv: deepFreeze({
    shortValueOptions: deepFreeze(new Set(["t", "S"])),
    longValueOptions: deepFreeze(new Set(["target-directory", "suffix", "backup"])),
  }),
  sed: deepFreeze({
    shortValueOptions: deepFreeze(new Set(["e", "f"])),
    longValueOptions: deepFreeze(new Set(["expression", "file"])),
  }),
  awk: deepFreeze({
    shortValueOptions: deepFreeze(new Set(["F", "f", "v", "i", "W", "m"])),
    longValueOptions: deepFreeze(new Set(["field-separator", "file", "assign", "include", "exec", "source"])),
  }),
});

type ParsedCommandArgs = Readonly<{
  positionals: readonly string[];
  shortFlags: ReadonlySet<string>;
  shortValues: ReadonlyMap<string, readonly string[]>;
  longFlags: ReadonlySet<string>;
  longValues: ReadonlyMap<string, readonly string[]>;
}>;

function pushValue(map: Map<string, string[]>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, [value]);
  } else {
    existing.push(value);
  }
}

/**
 * Split command arguments into positional operands and option flags/values
 * using the command's option-arity spec. Unknown options are treated as
 * boolean flags; this is a conservative over-approximation for target
 * extraction (a misclassified value becomes a positional target, which the
 * write-set gate then checks — failing closed, never open).
 */
function parseCommandArgs(command: string, args: readonly string[]): ParsedCommandArgs {
  const spec = COMMAND_OPTION_SPECS[command] ?? deepFreeze({ shortValueOptions: new Set<string>(), longValueOptions: new Set<string>() });
  const positionals: string[] = [];
  const shortFlags = new Set<string>();
  const shortValues = new Map<string, string[]>();
  const longFlags = new Set<string>();
  const longValues = new Map<string, string[]>();
  let optionsEnded = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (optionsEnded) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      optionsEnded = true;
      continue;
    }
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        const name = body.slice(0, eq);
        if (spec.longValueOptions.has(name)) {
          pushValue(longValues, name, body.slice(eq + 1));
        } else {
          longFlags.add(name);
        }
        continue;
      }
      if (spec.longValueOptions.has(body)) {
        const next = args[i + 1];
        if (next !== undefined) {
          pushValue(longValues, body, next);
          i += 1;
        }
      } else {
        longFlags.add(body);
      }
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      const chars = token.slice(1);
      for (let c = 0; c < chars.length; c += 1) {
        const ch = chars[c]!;
        if (spec.shortValueOptions.has(ch)) {
          const attached = chars.slice(c + 1);
          if (attached.length > 0) {
            pushValue(shortValues, ch, attached);
          } else {
            const next = args[i + 1];
            if (next !== undefined) {
              pushValue(shortValues, ch, next);
              i += 1;
            }
          }
          break;
        }
        shortFlags.add(ch);
      }
      continue;
    }
    positionals.push(token);
  }
  return deepFreeze({ positionals, shortFlags, shortValues, longFlags, longValues });
}

/**
 * Determine whether an invocation mutates the filesystem and, if so, which
 * paths it targets. Returns null for non-mutating invocations. Target
 * extraction is conservative: when a path's role is ambiguous (e.g. `mv`
 * operands are both renamed-away and written), every candidate is returned
 * so the write-set gate checks all of them.
 */
function extractMutatingTargets(command: string, args: readonly string[]): readonly string[] | null {
  const parsed = parseCommandArgs(command, args);
  if (ALWAYS_MUTATING_COMMANDS.has(command)) {
    if (command === "touch" || command === "mkdir") {
      return parsed.positionals;
    }
    // cp/mv: -t/--target-directory names the destination explicitly; the
    // last positional is the destination otherwise. mv also destroys its
    // sources (rename), so every operand is a mutation target. cp only
    // writes its destination (sources are reads).
    const targetDir = parsed.shortValues.get("t")?.at(-1) ?? parsed.longValues.get("target-directory")?.at(-1);
    if (command === "mv") {
      return targetDir !== undefined ? [...parsed.positionals, targetDir] : parsed.positionals;
    }
    if (targetDir !== undefined) return [targetDir];
    return parsed.positionals.length >= 2 ? [parsed.positionals[parsed.positionals.length - 1]!] : [];
  }
  if (CONDITIONALLY_MUTATING_COMMANDS.has(command)) {
    if (command === "sed") {
      // GNU sed in-place: -i[SUFFIX] (short, optionally attached) or
      // --in-place[=SUFFIX]. `i` is not a value option in the spec, so any
      // bundled form (-i, -ni, -i.bak) records the `i` short flag.
      const inPlace = parsed.shortFlags.has("i") || parsed.longFlags.has("in-place") || parsed.longValues.has("in-place");
      if (!inPlace) return null;
      // Without -e/-f the first positional is the script; the rest are files.
      const hasScriptOption = parsed.shortValues.has("e") || parsed.shortValues.has("f")
        || parsed.longValues.has("expression") || parsed.longValues.has("file");
      return hasScriptOption ? parsed.positionals : parsed.positionals.slice(1);
    }
    // gawk in-place: -i inplace (attached or separate) / --include inplace.
    const includes = [...(parsed.shortValues.get("i") ?? []), ...(parsed.longValues.get("include") ?? [])];
    const inPlace = includes.some((v) => v === "inplace" || v.startsWith("inplace::") || v.startsWith("inplace/"));
    if (!inPlace) return null;
    const hasProgramFile = parsed.shortValues.has("f") || parsed.longValues.has("file") || parsed.longValues.has("exec") || parsed.longValues.has("source");
    return hasProgramFile ? parsed.positionals : parsed.positionals.slice(1);
  }
  return null;
}

/**
 * A target path is authorized when it resolves (against the command's cwd)
 * to an exact write-set entry or to a location under an entry that names a
 * directory. Relative write-set entries resolve against the repository
 * root, matching the editor's repo-relative path form.
 */
function isTargetInWriteSet(target: string, cwd: string, repositoryRoot: string, writeSet: ReadonlySet<string>): boolean {
  const resolvedTarget = resolve(cwd, target);
  for (const entry of writeSet) {
    const resolvedEntry = isAbsolute(entry) ? normalize(entry) : resolve(repositoryRoot, entry);
    if (resolvedTarget === resolvedEntry) return true;
    const withSep = resolvedEntry.endsWith(sep) ? resolvedEntry : `${resolvedEntry}${sep}`;
    if (resolvedTarget.startsWith(withSep)) return true;
  }
  return false;
}

function assertMutatingTargetsAuthorized(
  command: string,
  targets: readonly string[],
  cwd: string,
  repositoryRoot: string,
  writeSet: ReadonlySet<string>,
): void {
  for (const target of targets) {
    if (!isTargetInWriteSet(target, cwd, repositoryRoot, writeSet)) {
      throw new SecurityError(
        `Mutating command '${command}' targets '${target}', which is outside the session write set (${writeSet.size} authorized path(s)). Grant write access with the chat --write-set flag or use the governed editor tools.`,
        "tool_command_write_denied",
      );
    }
  }
}

function assertNoShellMetachars(value: string, field: string): void {
  if (SHELL_METACHAR_PATTERN.test(value)) {
    throw new SecurityError(
      `${field} contains forbidden shell metacharacters`,
      "tool_command_injection",
    );
  }
}

// ============================================================================
// execute_command
// ============================================================================

export type ExecuteCommandArgs = Readonly<{
  command: string;
  args?: readonly string[];
  cwd?: string;
}>;

export type ExecuteCommandAdapter = ToolAdapter;

export function createExecuteCommandTool(options: ExecuteCommandOptions = {}): ExecuteCommandAdapter {
  const allowedCommandSet = resolveAllowedCommandSet(options.allowedCommands);
  const timeoutMs = resolveExecuteCommandTimeoutMs(options.timeoutMs);
  const writeSet: ReadonlySet<string> = options.writeSet ?? new Set<string>();
  return deepFreeze({
    adapterId: ADAPTER_ID_COMMAND,
    async execute(input: ToolAdapterInput, context: ToolAdapterContext): Promise<ToolAdapterResult> {
      const args = input.arguments as Partial<ExecuteCommandArgs>;
      const command = assertString(args, "command", { maxLength: 256 });
      if (!allowedCommandSet.has(command)) {
        throw new SecurityError(
          `Command '${command}' is not in the allowed list`,
          "tool_command_not_allowed",
        );
      }
      assertNoShellMetachars(command, "command");
      const cmdArgs = Array.isArray(args.args) ? args.args : [];
      if (cmdArgs.length > MAX_ARGS) {
        throw new InputError("Too many arguments", "tool_arguments_oversized");
      }
      for (const a of cmdArgs) {
        if (typeof a !== "string" || a.length > MAX_ARG_LENGTH) {
          throw new InputError("Each argument must be a string within length limits", "tool_argument_invalid");
        }
      }
      const cwd = typeof args.cwd === "string" && args.cwd.length > 0 ? args.cwd : context.repositoryRoot;
      if (Buffer.byteLength(cwd, "utf8") > MAX_CWD_BYTES) {
        throw new InputError("cwd exceeds maximum length", "tool_argument_oversized");
      }
      // X-1: gate file-mutating commands on the session write set so a model
      // cannot bypass the transactional editor's preimage/write-set/rollback
      // governance by shelling out (e.g. `touch`, `mkdir`, `cp`, `mv`,
      // `sed -i`). Read-only invocations pass through unchanged.
      const mutatingTargets = extractMutatingTargets(command, cmdArgs);
      if (mutatingTargets !== null) {
        assertMutatingTargetsAuthorized(command, mutatingTargets, cwd, context.repositoryRoot, writeSet);
      }
      return runCommand(command, cmdArgs, cwd, context, input.toolId, timeoutMs);
    },
  });
}

function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  context: ToolAdapterContext,
  toolId: string,
  timeoutMs: number,
): Promise<ToolAdapterResult> {
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let resolved = false;
    let timedOut = false;
    const maxCapture = 2_097_152;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawn> | undefined;

    const cleanupTimeout = (): void => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
    };

    const onExternalAbort = guarded("tools.command.abort", (): void => {
      bestEffort(() => { child?.kill("SIGTERM"); });
    });

    const detachExternalSignal = (): void => {
      if (context.signal !== undefined) {
        context.signal.removeEventListener("abort", onExternalAbort);
      }
    };

    const finish = (exitCode: number | null, signal: string | null, cancelled: boolean): void => {
      if (resolved) return;
      resolved = true;
      cleanupTimeout();
      detachExternalSignal();
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      const content = JSON.stringify(deepFreeze({
        exitCode,
        signal,
        cancelled,
        timedOut,
        timeoutMs,
        stdout,
        stderr,
      }));
      resolve(deepFreeze({
        toolId,
        content,
        isError: cancelled || (exitCode !== null && exitCode !== 0),
        durationMs: 0,
        truncated: stdoutBytes >= maxCapture || stderrBytes >= maxCapture,
        cancelled,
      }));
    };

    try {
      child = spawn(command, [...args], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        // A PROJECTION, never this process's whole environment: the model
        // picks the command, and `{ ...process.env }` handed it every key and
        // token the harness holds (cfg-audit P13, cred-audit F21).
        env: { ...projectEnvironment(process.env, COMMAND_ENVIRONMENT) },
      });
    } catch (error) {
      resolved = true;
      resolve(deepFreeze({
        toolId,
        content: `Failed to spawn command: ${extractErrorMessage(error)}`,
        isError: true,
        durationMs: 0,
        truncated: false,
        cancelled: false,
      }));
      return;
    }

    // Enforce the manifest's timeout: a hung command must not block forever
    // (RES-2). The timeout merges with the external cancellation signal so
    // either one kills the child and surfaces a typed, non-success result.
    timeoutId = setTimeout(guarded("tools.command.timeout", () => {
      timedOut = true;
      bestEffort(() => { child?.kill("SIGTERM"); });
    }), timeoutMs);

    if (context.signal !== undefined) {
      if (context.signal.aborted) {
        onExternalAbort();
      } else {
        context.signal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }

    child.stdout?.on("data", guarded("tools.command.stdout", (chunk: Buffer) => {
      if (stdoutBytes + chunk.length > maxCapture) {
        const remaining = maxCapture - stdoutBytes;
        if (remaining > 0) {
          stdoutChunks.push(chunk.slice(0, remaining));
          stdoutBytes = maxCapture;
        }
        return;
      }
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
    }));
    child.stderr?.on("data", guarded("tools.command.stderr", (chunk: Buffer) => {
      if (stderrBytes + chunk.length > maxCapture) {
        const remaining = maxCapture - stderrBytes;
        if (remaining > 0) {
          stderrChunks.push(chunk.slice(0, remaining));
          stderrBytes = maxCapture;
        }
        return;
      }
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
    }));
    child.on("error", guarded("tools.command.error", (err: Error) => {
      if (resolved) return;
      resolved = true;
      cleanupTimeout();
      detachExternalSignal();
      resolve(deepFreeze({
        toolId,
        content: `Command error: ${err.message}`,
        isError: true,
        durationMs: 0,
        truncated: false,
        cancelled: false,
      }));
    }));
    child.on("close", guarded("tools.command.close", (code: number | null, sig: NodeJS.Signals | null) => {
      const cancelled = context.signal?.aborted === true || timedOut;
      finish(code, sig, cancelled);
    }));
  });
}

/**
 * Structured blocker for a tool whose backend adapter is not configured.
 * The content is machine-actionable JSON so a model can parse the failure
 * kind (`adapter_not_configured`) and the affected adapter/tool instead of
 * pattern-matching a prose string.
 */
function adapterNotConfiguredBlocker(toolId: string, adapterName: string, adapterId: string, message: string): ToolAdapterResult {
  return deepFreeze({
    toolId,
    content: JSON.stringify(deepFreeze({
      error: "adapter_not_configured",
      adapter: adapterName,
      tool: toolId,
      message,
    })),
    isError: true,
    durationMs: 0,
    truncated: false,
    cancelled: false,
    metadata: deepFreeze({ reason: "adapter_missing", adapterId }),
  });
}

// ============================================================================
// search_web (Kagi-ready)
// ============================================================================

export type SearchResult = Readonly<{
  title: string;
  url: string;
  snippet: string;
}>;

export type SearchOptions = Readonly<{
  limit?: number;
}>;

export type SearchAdapter = Readonly<{
  search(query: string, options: SearchOptions, signal?: AbortSignal): Promise<readonly SearchResult[]>;
}>;

export type SearchWebArgs = Readonly<{
  query: string;
  limit?: number;
}>;

export function createSearchWebTool(adapter?: SearchAdapter): ToolAdapter {
  return deepFreeze({
    adapterId: ADAPTER_ID_SEARCH,
    async execute(input: ToolAdapterInput, _context: ToolAdapterContext): Promise<ToolAdapterResult> {
      const args = input.arguments as Partial<SearchWebArgs>;
      const query = assertString(args, "query", { maxLength: MAX_QUERY_LENGTH });
      const limit = typeof args.limit === "number" && Number.isInteger(args.limit) && args.limit > 0 && args.limit <= 50
        ? args.limit
        : 10;
      if (adapter === undefined) {
        return adapterNotConfiguredBlocker(input.toolId, "search", ADAPTER_ID_SEARCH, "search_web is not configured — no SearchAdapter is available");
      }
      try {
        const results = await adapter.search(query, deepFreeze({ limit }), _context.signal);
        return deepFreeze({
          toolId: input.toolId,
          content: JSON.stringify(results),
          isError: false,
          structured: deepFreeze({ results: [...results] }),
          durationMs: 0,
          truncated: false,
          cancelled: false,
        });
      } catch (error) {
        return deepFreeze({
          toolId: input.toolId,
          content: extractErrorMessage(error),
          isError: true,
          durationMs: 0,
          truncated: false,
          cancelled: false,
        });
      }
    },
  });
}

// ============================================================================
// fetch_page (Scrapling-ready)
// ============================================================================

export type PageContent = Readonly<{
  url: string;
  content: string;
  contentType: string;
  statusCode: number;
}>;

export type FetchOptions = Readonly<{
  format?: "markdown" | "text" | "html";
}>;

export type PageFetchAdapter = Readonly<{
  fetch(url: string, options: FetchOptions, signal?: AbortSignal): Promise<PageContent>;
}>;

export type FetchPageArgs = Readonly<{
  url: string;
  format?: "markdown" | "text" | "html";
}>;

export function createFetchPageTool(adapter?: PageFetchAdapter): ToolAdapter {
  return deepFreeze({
    adapterId: ADAPTER_ID_FETCH,
    async execute(input: ToolAdapterInput, _context: ToolAdapterContext): Promise<ToolAdapterResult> {
      const args = input.arguments as Partial<FetchPageArgs>;
      const url = assertString(args, "url", { maxLength: MAX_URL_LENGTH });
      if (!/^https?:\/\/[^\s]+$/u.test(url)) {
        throw new InputError("url must be an http or https URL", "tool_argument_invalid");
      }
      const format = args.format === "text" || args.format === "html" ? args.format : "markdown";
      if (adapter === undefined) {
        return adapterNotConfiguredBlocker(input.toolId, "pageFetch", ADAPTER_ID_FETCH, "fetch_page is not configured — no PageFetchAdapter is available");
      }
      try {
        const page = await adapter.fetch(url, deepFreeze({ format }), _context.signal);
        return deepFreeze({
          toolId: input.toolId,
          content: page.content,
          isError: false,
          structured: deepFreeze({ url: page.url, contentType: page.contentType, statusCode: page.statusCode }),
          durationMs: 0,
          truncated: false,
          cancelled: false,
        });
      } catch (error) {
        return deepFreeze({
          toolId: input.toolId,
          content: extractErrorMessage(error),
          isError: true,
          durationMs: 0,
          truncated: false,
          cancelled: false,
        });
      }
    },
  });
}

// ============================================================================
// read_docs (Context7-ready)
// ============================================================================

export type DocsResult = Readonly<{
  libraryId: string;
  query: string;
  content: string;
  sources: readonly string[];
}>;

export type DocsAdapter = Readonly<{
  query(libraryId: string, query: string, signal?: AbortSignal): Promise<DocsResult>;
}>;

export type ReadDocsArgs = Readonly<{
  libraryId: string;
  query: string;
}>;

export function createReadDocsTool(adapter?: DocsAdapter): ToolAdapter {
  return deepFreeze({
    adapterId: ADAPTER_ID_DOCS,
    async execute(input: ToolAdapterInput, _context: ToolAdapterContext): Promise<ToolAdapterResult> {
      const args = input.arguments as Partial<ReadDocsArgs>;
      const libraryId = assertString(args, "libraryId", { maxLength: MAX_LIBRARY_ID_LENGTH });
      const query = assertString(args, "query", { maxLength: MAX_QUESTION_LENGTH });
      if (adapter === undefined) {
        return adapterNotConfiguredBlocker(input.toolId, "docs", ADAPTER_ID_DOCS, "read_docs is not configured — no DocsAdapter is available");
      }
      try {
        const result = await adapter.query(libraryId, query, _context.signal);
        return deepFreeze({
          toolId: input.toolId,
          content: result.content,
          isError: false,
          structured: deepFreeze({
            libraryId: result.libraryId,
            query: result.query,
            sources: [...result.sources],
          }),
          durationMs: 0,
          truncated: false,
          cancelled: false,
        });
      } catch (error) {
        return deepFreeze({
          toolId: input.toolId,
          content: extractErrorMessage(error),
          isError: true,
          durationMs: 0,
          truncated: false,
          cancelled: false,
        });
      }
    },
  });
}

// ============================================================================
// repo_question (DeepWiki-ready)
// ============================================================================

export type RepoAnswer = Readonly<{
  repo: string;
  question: string;
  answer: string;
  sources: readonly string[];
}>;

export type RepoQuestionAdapter = Readonly<{
  ask(repo: string, question: string, signal?: AbortSignal): Promise<RepoAnswer>;
}>;

export type RepoQuestionArgs = Readonly<{
  repo: string;
  question: string;
}>;

export function createRepoQuestionTool(adapter?: RepoQuestionAdapter): ToolAdapter {
  return deepFreeze({
    adapterId: ADAPTER_ID_REPO,
    async execute(input: ToolAdapterInput, _context: ToolAdapterContext): Promise<ToolAdapterResult> {
      const args = input.arguments as Partial<RepoQuestionArgs>;
      const repo = assertString(args, "repo", { maxLength: MAX_REPO_LENGTH });
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(repo)) {
        throw new InputError("repo must be in 'owner/repo' format", "tool_argument_invalid");
      }
      const question = assertString(args, "question", { maxLength: MAX_QUESTION_LENGTH });
      if (adapter === undefined) {
        return adapterNotConfiguredBlocker(input.toolId, "repoQuestion", ADAPTER_ID_REPO, "repo_question is not configured — no RepoQuestionAdapter is available");
      }
      try {
        const result = await adapter.ask(repo, question, _context.signal);
        return deepFreeze({
          toolId: input.toolId,
          content: result.answer,
          isError: false,
          structured: deepFreeze({
            repo: result.repo,
            question: result.question,
            sources: [...result.sources],
          }),
          durationMs: 0,
          truncated: false,
          cancelled: false,
        });
      } catch (error) {
        return deepFreeze({
          toolId: input.toolId,
          content: extractErrorMessage(error),
          isError: true,
          durationMs: 0,
          truncated: false,
          cancelled: false,
        });
      }
    },
  });
}

export type BuiltInAdapters = Readonly<{
  executeCommand: ToolAdapter;
  searchWeb: ToolAdapter;
  fetchPage: ToolAdapter;
  readDocs: ToolAdapter;
  repoQuestion: ToolAdapter;
}>;

export function createBuiltInToolAdapters(options?: Readonly<{
  searchAdapter?: SearchAdapter;
  fetchAdapter?: PageFetchAdapter;
  docsAdapter?: DocsAdapter;
  repoAdapter?: RepoQuestionAdapter;
  allowedCommands?: readonly string[];
  executeCommandTimeoutMs?: number;
  /**
   * Session write set for execute_command's mutating-command governance
   * (X-1). Forwarded to {@link createExecuteCommandTool}; when absent or
   * empty, all file-mutating commands are denied.
   */
  writeSet?: ReadonlySet<string>;
}>): BuiltInAdapters {
  return deepFreeze({
    executeCommand: createExecuteCommandTool(
      options?.allowedCommands !== undefined || options?.executeCommandTimeoutMs !== undefined || options?.writeSet !== undefined
        ? {
            ...(options?.allowedCommands !== undefined ? { allowedCommands: options.allowedCommands } : {}),
            ...(options?.executeCommandTimeoutMs !== undefined ? { timeoutMs: options.executeCommandTimeoutMs } : {}),
            ...(options?.writeSet !== undefined ? { writeSet: options.writeSet } : {}),
          }
        : {},
    ),
    searchWeb: createSearchWebTool(options?.searchAdapter),
    fetchPage: createFetchPageTool(options?.fetchAdapter),
    readDocs: createReadDocsTool(options?.docsAdapter),
    repoQuestion: createRepoQuestionTool(options?.repoAdapter),
  });
}

export function generateToolCallId(): string {
  return generateId("tool-call");
}
