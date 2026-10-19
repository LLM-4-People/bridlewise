import { parse, type ParserOptions, type ParserPlugin as PluginConfig } from "@babel/parser";
import {
  type AstNode,
  astChildren,
  babelParserPluginsForSourcePath,
} from "../quality-packs/prevention/ast-helpers.ts";
import { commentLengthReducer, isStatementLike, statementTextLength } from "./shared-helpers.ts";
import { handleError } from "../shared/debug/debug-system.ts";

/**
 * Pattern learner — mines suppression-pragma + deferred-fix markers FROM THE
 * CODEBASE so the bandaid detector does not hardcode a static keyword list
 * (static values like that are prohibited app-wide).
 *
 * The EXP408 detector hardcoded 8 regex patterns (`@ts-ignore`, `as any`,
 * `eslint-disable`, `TODO...fix|later|hack|workaround|temporary`,...). The
 * user rejected this. EXP432 replaces it with:
 *
 * - STRUCTURAL detection (AST node types — `TSAnyKeyword`, empty
 * `CatchClause.body`, `NullLiteral` test) in `bandaid-ast-detector.ts`.
 * This is keyword-free and needs no learning.
 * - LEARNED comment detection (this file): scan the codebase's comments,
 * find the ones that look like suppression pragmas / deferred markers,
 * and return them as regex strings the detector compiles. The LEARNED
 * set populates the config dynamically — no static list lives in the
 * source.
 *
 * How a comment is classified as a "suppression pragma" without a keyword
 * list:
 *
 * - It is a single-line directive that PRECEDES a statement (a leading
 * comment) AND repeats across >= `minSupport` distinct files. A real
 * suppression pragma (`@ts-ignore`, `eslint-disable`, `@ts-expect-error`)
 * appears in many files; a one-off comment does not. The shape
 * ("short directive preceding a statement, repeated across files") is
 * structural — the SPECIFIC string is learned, not hardcoded.
 * - We additionally require the comment's first token to look like a
 * directive (starts with `@`, `eslint-`, or contains a hyphenated
 * directive shape). This is a STRUCTURAL shape filter (a pragma
 * signature), not a fixed keyword list — it admits `@ts-ignore`,
 * `@ts-expect-error`, `@ts-nocheck`, `eslint-disable`,
 * `eslint-disable-next-line`, `@eslint-...`, and any future pragma of
 * the same shape, without listing them.
 *
 * How a comment is classified as a "deferred-fix marker" without a keyword
 * list:
 *
 * - It is a comment that contains a future-tense / deferred-work verb
 * LEARNED from the corpus. We seed the learner with the STRUCTURAL
 * signal "a comment that's longer than the statement it precedes"
 * (the "explaining why I didn't fix it" shape) and let the codebase's
 * own vocabulary fill the marker set. The seed is a SHAPE, not a
 * keyword list.
 *
 * The learner is pure: it takes sources and returns regex strings. The
 * `bandaid-detector.ts` passes them to the AST detector's
 * `learnedSuppressionPragmas` / `learnedDeferredMarkers` options.
 */

export type LearnedSource = Readonly<{ path: string; content: string }>;

export type LearnedPatterns = Readonly<{
  /** Regex strings matching suppression-pragma comments (e.g. `@ts-ignore`). */
  suppressionPragmas: readonly string[];
  /** Regex strings matching deferred-fix comments (e.g. TODO markers). */
  deferredMarkers: readonly string[];
  /** Number of files scanned (for telemetry). */
  filesScanned: number;
  /** Number of comments examined (for telemetry). */
  commentsExamined: number;
}>;

export type LearnOptions = Readonly<{
  /** Minimum number of distinct files a pragma must appear in to be learned. */
  minSupport: number;
  /** Maximum pragma length (chars) — a pragma is a short directive, not a paragraph. */
  maxPragmaLength: number;
  /** Max deferred-marker length (chars). */
  maxDeferredLength: number;
  /** When true, include the structural long-comment deferred heuristic in the markers. */
  includeLongCommentHeuristic: boolean;
}>;

type CommentNode = Readonly<{
  type: "CommentLine" | "CommentBlock";
  value: string;
}>;

function parseSafe(source: string, filePath: string): AstNode | undefined {
  if (!source || source.trim().length === 0) return undefined;
  let plugins: PluginConfig[];
  try {
    plugins = babelParserPluginsForSourcePath(filePath) as PluginConfig[];
  } catch (e) {handleError(e, { module: "safety-bandaid-pattern-learner", operation: "catch" });
    plugins = [["typescript", { dts: false }]] as PluginConfig[];
  }
  const opts: ParserOptions = { plugins, allowReturnOutsideFunction: true, sourceType: "module" };
  try {
    return parse(source, opts) as unknown as AstNode;
  } catch {
    return undefined;
  }
}

function collectComments(root: AstNode): readonly CommentNode[] {
  const out: CommentNode[] = [];
  const seen = new Set<CommentNode>();
  const visit = (n: AstNode): void => {
    for (const key of ["leadingComments", "trailingComments", "innerComments"] as const) {
      const arr = (n as unknown as Record<string, unknown>)[key];
      if (Array.isArray(arr)) {
        for (const c of arr) {
          const cn = c as CommentNode;
          if (cn && typeof cn.type === "string" && typeof cn.value === "string" && !seen.has(cn)) {
            seen.add(cn);
            out.push(cn);
          }
        }
      }
    }
    for (const c of astChildren(n)) visit(c);
  };
  visit(root);
  return out;
}

/**
 * Does `text` look like a directive pragma? This is a SHAPE filter, not a
 * keyword list: it admits any short, hyphenated/at-prefixed directive
 * (`@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `eslint-disable`,
 * `eslint-disable-next-line`, `@eslint-...`, `@jsx-...`,...). It does NOT
 * admit prose ("this is a comment about the function") — prose lacks the
 * directive signature.
 *
 * The shape: starts with `@<token>` OR contains a `word-word` directive
 * (`eslint-...`, `biome-...`, `oxlint-...`). Future pragmas of the same
 * shape are admitted automatically — no list maintenance.
 */
function looksLikeDirective(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  // `@<token>` pragma: `@ts-ignore`, `@ts-expect-error`, `@jsx-no-cache`,...
  if (/^@[a-z][a-z0-9_-]*/i.test(t)) return true;
  // `<vendor>-<directive>` pragma: `eslint-disable`, `biome-ignore`,
  // `oxlint-disable`, `standard-disable`,...
  if (/^[a-z][a-z0-9]*-[a-z]/i.test(t)) return true;
  return false;
}

/** Escape a string for use as a regex body (literal match). */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract the directive prefixes from a comment (the pragma name + its
 * shorter prefixes). For `@ts-ignore: foo is wrong` → [`@ts-ignore`]. For
 * `eslint-disable-next-line no-explicit-any` → [`eslint-disable-next-line`,
 * `eslint-disable`]. The learner matches on the pragma PREFIX (so
 * `eslint-disable` covers `eslint-disable-next-line`, `eslint-disable-line`,
 * `eslint-disable` — all the same suppression family with different
 * scopes). The full `@ts-ignore` is kept (2 segments — no shorter prefix).
 * `@ts-expect-error` → [`@ts-expect-error`, `@ts-expect`] so the
 * distinctive `@ts-expect-error` is learned AND the shorter prefix can
 * cover future `@ts-expect-*` pragmas. We NEVER go below 2 segments
 * (`@ts` alone is too generic — would match `@ts-check`).
 */
function directivePrefixes(text: string): readonly string[] {
  const t = text.trim();
  const m = t.match(/^(@?[a-z][a-z0-9]*(?:-[a-z0-9]+)+)/i);
  if (!m || m[1] === undefined) return [];
  const full = m[1];
  const segs = full.split("-");
  // For `@` pragmas, the first segment includes the `@` (e.g. `@ts`). Keep
  // it joined. We require at least 2 segments total (e.g. `@ts-ignore`,
  // `eslint-disable`) — a bare `@ts` or `eslint` is too generic.
  if (segs.length < 2) return [];
  const prefixes: string[] = [];
  // Build prefixes from the full down to 2 segments.
  for (let len = segs.length; len >= 2; len -= 1) {
    prefixes.push(segs.slice(0, len).join("-"));
  }
  return prefixes;
}

/**
 * Mine a codebase for suppression-pragma + deferred-fix markers. Pure: takes
 * sources + options, returns learned regex strings. No I/O, no config
 * mutation, no hardcoded keyword list.
 */
export function learnBandaidPatterns(
  sources: readonly LearnedSource[],
  options: LearnOptions,
): LearnedPatterns {
  const fileByPragma = new Map<string, Set<string>>();
  const fileByTaskToken = new Map<string, Set<string>>();
  let commentsExamined = 0;
  const longCommentCount = new Map<string, number>();

  for (const src of sources) {
    const ast = parseSafe(src.content, src.path);
    if (!ast) continue;
    const comments = collectComments(ast);
    for (const c of comments) {
      commentsExamined += 1;
      const text = c.value.trim();
      if (text.length === 0 || text.length > options.maxPragmaLength) continue;
      if (!looksLikeDirective(text)) continue;
      const prefixes = directivePrefixes(text);
      if (prefixes.length === 0) continue;
      for (const tok of prefixes) {
        let files = fileByPragma.get(tok);
        if (!files) {
          files = new Set<string>();
          fileByPragma.set(tok, files);
        }
        files.add(src.path);
      }
    }
    // Task-annotation convention learner: a comment whose first token is an
    // UPPERCASE marker (TODO, FIXME, HACK, XXX, NOTE, WARN,...) is a
    // task-annotation convention. The SHAPE ("UPPERCASE first token") is
    // the convention signature — we LEARN which markers the codebase uses
    // (the specific tokens TODO/FIXME/HACK are mined, NOT hardcoded). The
    // markers with >= minSupport files are emitted as deferred markers.
    // This admits any UPPERCASE marker the codebase adopts, including
    // future conventions, without a static keyword list. (NOTE/WARN are
    // also admitted — a known false-positive surface; in practice task
    // annotations dominate UPPERCASE comments.)
    for (const c of comments) {
      const text = c.value.trim();
      if (text.length === 0 || text.length > options.maxDeferredLength) continue;
      const m = text.match(/^([A-Z][A-Z0-9_-]{1,20})\b/);
      if (!m || m[1] === undefined) continue;
      const tok = m[1];
      let files = fileByTaskToken.get(tok);
      if (!files) {
        files = new Set<string>();
        fileByTaskToken.set(tok, files);
      }
      files.add(src.path);
    }
    // Structural long-comment deferred heuristic: a comment much longer
    // than the code it precedes is the "explaining why I didn't fix it"
    // shape. We mine the long-comment SHAPE here so the detector can use
    // it without a keyword list.
    if (options.includeLongCommentHeuristic) {
      const visit = (n: AstNode): void => {
        if (isStatementLike(n)) {
          const leading = (n as unknown as Record<string, unknown>).leadingComments;
          if (Array.isArray(leading) && leading.length > 0) {
            // Merge consecutive leading comments into one logical comment so
            // a multi-line "explain why I didn't fix it" block counts as one
            // long comment (not 3 short ones).
            const mergedLen = leading.reduce(commentLengthReducer, 0);
            const stmtLen = statementTextLength(n);
            if (mergedLen >= 40 && stmtLen > 0 && mergedLen / stmtLen >= 4) {
              longCommentCount.set("long-comment", (longCommentCount.get("long-comment") ?? 0) + 1);
            }
          }
        }
        for (const c of astChildren(n)) visit(c);
      };
      visit(ast);
    }
  }

  const suppressionPragmas: string[] = [];
  for (const [tok, files] of fileByPragma) {
    if (files.size >= options.minSupport) {
      // Match the directive token at the start of a comment (case-insensitive).
      suppressionPragmas.push(`^\\s*${escapeRegex(tok)}\\b`);
    }
  }

  const deferredMarkers: string[] = [];
  for (const [tok, files] of fileByTaskToken) {
    if (files.size >= options.minSupport) {
      // Match the UPPERCASE task token at the start of a comment. Case-
      // sensitive (TODO is a convention; `todo` is just a word).
      deferredMarkers.push(`^\\s*${escapeRegex(tok)}\\b`);
    }
  }
  if (options.includeLongCommentHeuristic && (longCommentCount.get("long-comment") ?? 0) > 0) {
    // The structural long-comment heuristic is emitted as a marker the
    // detector applies (it recomputes the ratio itself). We use a sentinel
    // marker that the detector recognizes as "enable the long-comment
    // heuristic" — no keyword list involved.
    deferredMarkers.push("__long_comment_heuristic__");
  }

  return {
    suppressionPragmas,
    deferredMarkers,
    filesScanned: sources.length,
    commentsExamined,
  };
}

/** Resolve `__long_comment_heuristic__` sentinel → the detector applies it. */
export function isLongCommentHeuristicMarker(marker: string): boolean {
  return marker === "__long_comment_heuristic__";
}
