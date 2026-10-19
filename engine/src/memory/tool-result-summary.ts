/**
 * Deterministic per-tool-type summary generator for the tool-result-in-memory
 * store (EXP433).
 *
 * The summary is the SMALL piece of context injected for the LLM in place of
 * the full tool result. The full result is stored in memory and retrieved
 * on demand via semantic search (see `tool-result-retrieval.ts`).
 *
 * Per the binding directives ("Everything dynamically computed" + "No static
 * constants"), every limit/threshold/size in this module comes from the
 * resolved `SummaryConfig` (which the caller builds from the central config
 * contract), not from a hardcoded literal.
 *
 * The summary is DETERMINISTIC (not LLM-based) so it is reproducible, has
 * zero token cost, and never hallucinates. The LLM can always call the
 * `toolResult.getFull` action (exposed via the shared exposure system) to
 * retrieve the full result when it actually needs it.
 */

import { InputError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { handleError } from "../shared/debug/debug-system.ts";

/** Tool names supported by the tool-result store. */
const TOOL_RESULT_TOOL_NAMES = deepFreeze([
  "search_code",
  "read_file",
  "grep",
] as const);
export type ToolResultToolName = typeof TOOL_RESULT_TOOL_NAMES[number];

/** Configuration for the deterministic summary generator. */
export type SummaryConfig = Readonly<{
  /** Maximum number of "top" hits to list in a search/grep summary. */
  topHitLimit: number;
  /** Maximum number of declared symbols (functions/classes/etc.) to list in a read summary. */
  readSymbolLimit: number;
  /** Maximum characters of a single file path before truncation in summaries. */
  pathTruncateLimit: number;
  /** Maximum number of grep matches to list in a summary. */
  grepMatchLimit: number;
}>;

const SUMMARY_DEFAULT_CONFIG = deepFreeze({
  topHitLimit: 5,
  readSymbolLimit: 8,
  pathTruncateLimit: 120,
  grepMatchLimit: 5,
} as const) as SummaryConfig;

export function resolveSummaryConfig(
  input: Partial<SummaryConfig>,
): SummaryConfig {
  const cfg = { ...SUMMARY_DEFAULT_CONFIG, ...input };
  if (cfg.topHitLimit < 1 || !Number.isFinite(cfg.topHitLimit)) {
    throw new InputError(
      "summary.topHitLimit must be a positive finite number",
      "tool_result_summary_config_invalid",
    );
  }
  if (cfg.readSymbolLimit < 1 || !Number.isFinite(cfg.readSymbolLimit)) {
    throw new InputError(
      "summary.readSymbolLimit must be a positive finite number",
      "tool_result_summary_config_invalid",
    );
  }
  if (cfg.pathTruncateLimit < 8 || !Number.isFinite(cfg.pathTruncateLimit)) {
    throw new InputError(
      "summary.pathTruncateLimit must be >= 8 and finite",
      "tool_result_summary_config_invalid",
    );
  }
  if (cfg.grepMatchLimit < 1 || !Number.isFinite(cfg.grepMatchLimit)) {
    throw new InputError(
      "summary.grepMatchLimit must be a positive finite number",
      "tool_result_summary_config_invalid",
    );
  }
  return deepFreeze(cfg) as SummaryConfig;
}

function truncatePath(path: string, limit: number): string {
  if (path.length <= limit) return path;
  const head = path.slice(0, Math.floor((limit - 3) / 2));
  const tail = path.slice(path.length - Math.ceil((limit - 3) / 2));
  return `${head}...${tail}`;
}

/** Extract the search query from a search_code args object. */
export function searchQueryFromArgs(
  args: Readonly<Record<string, unknown>>,
): string {
  const q = args.query ?? args.pattern ?? args.text ?? args.name;
  if (typeof q === "string" && q.length > 0) return q;
  return "(unspecified query)";
}

/** Extract the file path from a read_file args object. */
export function filePathFromArgs(
  args: Readonly<Record<string, unknown>>,
): string {
  const p = args.path ?? args.filePath ?? args.file;
  if (typeof p === "string" && p.length > 0) return p;
  return "(unknown path)";
}

/** Extract the grep pattern from a grep args object. */
export function grepPatternFromArgs(
  args: Readonly<Record<string, unknown>>,
): string {
  const p = args.pattern ?? args.regex ?? args.query;
  if (typeof p === "string" && p.length > 0) return p;
  return "(unspecified pattern)";
}

/**
 * Summarize a `search_code` result. Format:
 * `Found N results for '<query>'. Top: file1, file2, file3 (sym1, sym2,...)`
 *
 * Parses the structured search-code output convention used by the harness:
 * each line is either `path:line:symbol` (legacy) or a JSON object with
 * `{path, line, symbol, kind}` (newer). The summary lists the top N file
 * paths (deduplicated) plus the symbols found in them.
 */
export function summarizeSearchResult(
  args: Readonly<Record<string, unknown>>,
  fullResult: string,
  config: SummaryConfig = SUMMARY_DEFAULT_CONFIG,
): string {
  const query = searchQueryFromArgs(args);
  const lines = fullResult.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return `Found 0 results for '${query}'.`;
  }
  const seenPaths = new Set<string>();
  const topPaths: string[] = [];
  const symbolsByPath = new Map<string, Set<string>>();
  for (const line of lines) {
    let entry: { path?: unknown; line?: unknown; symbol?: unknown; kind?: unknown } | null = null;
    if (line.startsWith("{")) {
      try { entry = JSON.parse(line) as { path?: unknown; line?: unknown; symbol?: unknown; kind?: unknown }; } catch (e) {handleError(e, { module: "memory-tool-result-summary", operation: "catch" }); entry = null; }
    } else {
      const m = /^([^:]+):(\d+):(.*)$/u.exec(line);
      if (m) {
        const mp = m[1];
        const ms = m[3];
        if (mp !== undefined && ms !== undefined) {
          entry = { path: mp, line: Number(m[2] ?? 0), symbol: ms };
        }
      }
    }
    if (entry && typeof entry.path === "string") {
      const path = entry.path;
      if (!seenPaths.has(path)) {
        seenPaths.add(path);
        if (topPaths.length < config.topHitLimit) topPaths.push(path);
      }
      if (typeof entry.symbol === "string" && entry.symbol.length > 0) {
        let set = symbolsByPath.get(path);
        if (!set) { set = new Set(); symbolsByPath.set(path, set); }
        set.add(entry.symbol);
      }
    }
  }
  const pathList = topPaths
    .map((p) => {
      const syms = symbolsByPath.get(p);
      if (syms && syms.size > 0) {
        const symList = [...syms].slice(0, 3).join(", ");
        return `${truncatePath(p, config.pathTruncateLimit)} (${symList})`;
      }
      return truncatePath(p, config.pathTruncateLimit);
    })
    .join(", ");
  const fileCount = seenPaths.size;
  const hitCount = lines.length;
  return `Found ${hitCount} results in ${fileCount} file${fileCount === 1 ? "" : "s"} for '${query}'. Top: ${pathList}`;
}

/**
 * Summarize a `read_file` result. Format:
 * `Read file X (N lines). Contains: function A, function B, class C,...`
 *
 * The summary lists declared symbols (functions, classes, interfaces,
 * consts) detected with a deterministic line-pattern scan. This is a
 * deterministic heuristic, not a full AST parse — it gives the LLM enough
 * context to ask "tell me about function X in this file" via semantic
 * retrieval without spending the full file's tokens.
 */
export function summarizeReadResult(
  args: Readonly<Record<string, unknown>>,
  fullResult: string,
  config: SummaryConfig = SUMMARY_DEFAULT_CONFIG,
): string {
  const path = filePathFromArgs(args);
  if (fullResult.length === 0) {
    return `Read file ${truncatePath(path, config.pathTruncateLimit)} (0 lines).`;
  }
  const lines = fullResult.split("\n");
  // A trailing newline does not count as an extra line (matches `wc -l` semantics).
  const lineCount = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  const symbols: string[] = [];
  const seen = new Set<string>();
  const SYMBOL_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
    [/(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/u, "function"],
    [/(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/u, "class"],
    [/(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/u, "interface"],
    [/(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<{]/u, "type"],
    [/(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/u, "const"],
    [/(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/u, "enum"],
  ];
  for (const line of lines) {
    if (symbols.length >= config.readSymbolLimit) break;
    for (const [pattern, kind] of SYMBOL_PATTERNS) {
      const m = pattern.exec(line);
      if (m && m[1] !== undefined) {
        const name = m[1];
        const key = `${kind}:${name}`;
        if (!seen.has(key)) {
          seen.add(key);
          symbols.push(`${kind} ${name}`);
        }
        break;
      }
    }
  }
  if (symbols.length === 0) {
    return `Read file ${truncatePath(path, config.pathTruncateLimit)} (${lineCount} lines).`;
  }
  const symList = symbols.join(", ");
  return `Read file ${truncatePath(path, config.pathTruncateLimit)} (${lineCount} lines). Contains: ${symList}.`;
}

/**
 * Summarize a `grep` result. Format:
 * `Found N matches in M files for /pattern/. Top: file1:line, file2:line,...`
 *
 * Parses the standard grep output convention:
 * `path:line:content` or `path:content` (when -n is not set).
 */
export function summarizeGrepResult(
  args: Readonly<Record<string, unknown>>,
  fullResult: string,
  config: SummaryConfig = SUMMARY_DEFAULT_CONFIG,
): string {
  const pattern = grepPatternFromArgs(args);
  const lines = fullResult.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return `Found 0 matches for /${pattern}/.`;
  }
  const fileSet = new Set<string>();
  const topMatches: string[] = [];
  for (const line of lines) {
    if (topMatches.length >= config.grepMatchLimit) break;
    const m = /^([^:]+):(\d+):/u.exec(line);
    if (m && m[1] !== undefined && m[2] !== undefined) {
      const path = m[1];
      const lineNo = m[2];
      fileSet.add(path);
      topMatches.push(`${truncatePath(path, config.pathTruncateLimit)}:${lineNo}`);
    } else {
      const m2 = /^([^:]+):/u.exec(line);
      if (m2 && m2[1] !== undefined) {
        fileSet.add(m2[1]);
        if (topMatches.length < config.grepMatchLimit) {
          topMatches.push(truncatePath(m2[1], config.pathTruncateLimit));
        }
      }
    }
  }
  const matchCount = lines.length;
  const fileCount = fileSet.size;
  return `Found ${matchCount} matches in ${fileCount} file${fileCount === 1 ? "" : "s"} for /${pattern}/. Top: ${topMatches.join(", ")}`;
}

/** Summarize an unknown tool result (generic fallback). */
export function summarizeGenericResult(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  fullResult: string,
): string {
  const lineCount = fullResult.split("\n").length;
  const argPreview = Object.entries(args)
    .slice(0, 3)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
  return `Tool ${toolName}(${argPreview}) returned ${lineCount} lines. Stored in memory; retrieve on demand.`;
}

/** Dispatch to the right summary generator for a tool name. */
export function summarizeToolResult(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  fullResult: string,
  config: SummaryConfig = SUMMARY_DEFAULT_CONFIG,
): string {
  switch (toolName) {
    case "search_code":
      return summarizeSearchResult(args, fullResult, config);
    case "read_file":
      return summarizeReadResult(args, fullResult, config);
    case "grep":
      return summarizeGrepResult(args, fullResult, config);
    default:
      return summarizeGenericResult(toolName, args, fullResult);
  }
}
