import { parse, type ParserOptions, type ParserPlugin as PluginConfig } from "@babel/parser";
import {
  type AstNode,
  astNode,
  astNodeArray,
  astChildren,
  babelParserPluginsForSourcePath,
} from "../quality-packs/prevention/ast-helpers.ts";
import { type BandaidPatternCategory, type BandaidSeverity } from "./bandaid-config.ts";
import { commentLengthReducer, isStatementLike, statementTextLength } from "./shared-helpers.ts";
import { bestEffort } from "../shared/best-effort.ts";
import { handleError } from "../shared/debug/debug-system.ts";

/**
 * AST-based STRUCTURAL bandaid detector — keyword-free.
 *
 * Replaces the static-keyword regex list from EXP408 (the user directive
 * 2026-07-21: "the workaround/bandaids part is using static keywords, are we
 * in 1990? static values like that are prohibited app-wide.") with detection
 * of the STRUCTURE of a bandaid via the AST:
 *
 * empty-or-comment-only catch → `CatchClause.body.body.length === 0`
 * (comments are NOT statements, so a comment-only body has 0 statements
 * just like a fully-empty body — one structural rule catches both).
 * `as any` / `<any>x` → `TSAsExpression`/`TSTypeAssertion` whose
 * `typeAnnotation` is a `TSAnyKeyword` (we read the AST node TYPE, not
 * the string "any").
 * null guard at the symptom → `IfStatement` whose `test` is a
 * `BinaryExpression` (`===`/`!==`/`==`/`!=`) with a `NullLiteral` operand.
 * unused catch binding → `CatchClause` whose caught variable is
 * never referenced in the body (an error that's swallowed silently).
 *
 * No keyword list is involved. The detector does NOT match the strings
 * "any", "null", "catch", "try" — it walks AST node types. A refactor that
 * writes `as unknown` instead of `as any` is NOT flagged (correctly: it's
 * not a bandaid). A refactor that writes `as any` IS flagged (the AST
 * contains a TSAnyKeyword type annotation).
 *
 * For comment-shaped bandaids (`@ts-ignore`, `eslint-disable`, TODO) the
 * structure alone is not enough (a comment is just a string); those go
 * through the LEARNED detection in `bandaid-pattern-learner.ts` — the set
 * of suppression/deferred markers is LEARNED from the codebase, not
 * hardcoded. See `bandaid-detector.ts` for the composition.
 *
 * This module is pure (no I/O, no config mutation, no signals). It takes
 * the source text + the learned pragmas and returns structural findings.
 */

/** A structural bandaid finding (one per AST node that matches a shape). */
export type StructuralFinding = Readonly<{
  /** Stable shape id, e.g. `"empty-catch"`, `"any-assertion"`, `"null-guard"`, `"unused-catch-binding"`. */
  shape: string;
  /** Category mirrors `BandaidPatternCategory` so the detector can re-use the existing finding shape. */
  category: BandaidPatternCategory;
  severity: BandaidSeverity;
  /** 1-based line number within the parsed fragment (for evidence). */
  line: number;
  /** The source line (best-effort) for evidence. */
  evidenceLine: string;
  recommendation: string;
}>;

export type StructuralDetectionOptions = Readonly<{
  /** Source path (used to pick the right babel plugins for `.ts`/`.tsx`/`.jsx`). */
  filePath: string;
  /** Learned suppression pragmas (regex strings; the learner owns the list, not this file). */
  learnedSuppressionPragmas: readonly string[];
  /** Learned deferred-fix markers (regex strings). */
  learnedDeferredMarkers: readonly string[];
  /** When true, a comment longer than the code it precedes is a deferred-fix smell (structural, no keywords). */
  longCommentDeferredEnabled: boolean;
  /** Min ratio of comment chars to following-statement chars for the long-comment heuristic. */
  longCommentMinRatio: number;
  /** Min comment length (chars) before the long-comment heuristic applies. */
  longCommentMinCommentLength: number;
}>;

const EMPTY_ARRAY: readonly AstNode[] = [];

/** Collect every node in the tree (pre-order). */
function collectNodes(root: AstNode): readonly AstNode[] {
  const out: AstNode[] = [];
  const stack: AstNode[] = [root];
  while (stack.length > 0) {
    const n = stack.pop();
    if (!n) continue;
    out.push(n);
    for (const c of astChildren(n)) stack.push(c);
  }
  return out;
}

/** Is `node` a `TSAnyKeyword` type annotation? */
function isAnyKeyword(node: AstNode | undefined): boolean {
  return node !== undefined && node.type === "TSAnyKeyword";
}

/** Is `node` a `NullLiteral` or the `undefined` global Identifier? Both are
 * "absence" sentinels; guarding against them at the symptom is a bandaid.
 * Detecting `undefined` by its Identifier name is STRUCTURAL (AST node
 * type + name), not a regex on source text — analogous to detecting
 * `NaN`/`Infinity` globals. */
function isAbsenceLiteral(node: AstNode | undefined): boolean {
  if (!node) return false;
  if (node.type === "NullLiteral") return true;
  if (node.type === "Identifier" && (node as unknown as { name?: string }).name === "undefined") return true;
  return false;
}

/** Does `test` (an IfStatement.test) contain a BinaryExpression comparing
 * to null/undefined? Recurses into LogicalExpression operands so
 * `if (x === null || x === undefined)` is caught (both sides checked). */
function testHasAbsenceGuard(test: AstNode | undefined): boolean {
  if (!test) return false;
  if (test.type === "BinaryExpression") {
    const op = test.operator;
    if (op === "===" || op === "!==" || op === "==" || op === "!=") {
      const left = astNode(test.left);
      const right = astNode(test.right);
      if (isAbsenceLiteral(left) || isAbsenceLiteral(right)) return true;
    }
    return false;
  }
  if (test.type === "LogicalExpression") {
    return testHasAbsenceGuard(astNode(test.left)) || testHasAbsenceGuard(astNode(test.right));
  }
  return false;
}

/**
 * Collect all Identifier names bound/referenced inside a subtree. Used to
 * check whether a catch binding is referenced in its body (error swallowing).
 */
function identifierNames(root: AstNode): Set<string> {
  const names = new Set<string>();
  for (const n of collectNodes(root)) {
    if (n.type === "Identifier" && typeof n.name === "string") names.add(n.name);
  }
  return names;
}

/** Read a 1-based line number from a babel node (fallback to 0). */
function nodeLine(node: AstNode | undefined): number {
  if (!node) return 0;
  const loc = node.loc as { start?: { line?: number } } | undefined;
  return (loc?.start?.line ?? 0) || 0;
}

/**
 * Try to parse `source` as a standalone module. Returns the AST root, or
 * `undefined` if the fragment does not parse (the edit was a partial line,
 * a fragment of a function body, etc.). The caller falls back to other
 * detection mechanisms (root-cause containment, learned pragmas) when the
 * AST is unavailable.
 *
 * We try three strategies (all structural — no keyword matching):
 * 1. parse as a module (the edit is a complete statement/program).
 * 2. wrap in `function _b{... }` so expression-statement fragments
 * and `return`-bearing fragments parse as a function body.
 * 3. brace-balance retry: if the fragment has unbalanced braces (a common
 * LLM mistake — e.g. a `// comment }` that swallows a closing brace),
 * append the missing closing braces and re-parse. This is brace
 * COUNTING, not keyword matching — it lets malformed fragments parse
 * so the structural detectors can run.
 */
export function parseEditFragment(
  source: string,
  filePath: string,
): AstNode | undefined {
  if (!source || source.trim().length === 0) return undefined;
  let plugins: PluginConfig[];
  try {
    plugins = babelParserPluginsForSourcePath(filePath) as PluginConfig[];
  } catch (e) {handleError(e, { module: "safety-bandaid-ast-detector", operation: "catch" });
    plugins = [["typescript", { dts: false }]] as PluginConfig[];
  }
  const opts: ParserOptions = { plugins, allowReturnOutsideFunction: true, sourceType: "module" };
  const direct = bestEffort(() => parse(source, opts) as unknown as AstNode);
  if (direct !== undefined) return direct;
  const wrapped = bestEffort(() =>
    parse(`function __bandaid_probe__(){\n${source}\n}`, opts) as unknown as AstNode,
  );
  if (wrapped !== undefined) return wrapped;
  const balanced = balanceBraces(source);
  if (balanced !== source) {
    try {
      return parse(balanced, opts) as unknown as AstNode;
    } catch {
      try {
        const wrappedBalanced = `function __bandaid_probe__(){\n${balanced}\n}`;
        return parse(wrappedBalanced, opts) as unknown as AstNode;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Count unmatched opening braces/parens/brackets in `source` IGNORING
 * characters inside strings, template literals, and comments (so a
 * `// comment }` does NOT count as a closing brace). Append the missing
 * closers. Pure string processing — no keyword list.
 */
function balanceBraces(source: string): string {
  const stack: string[] = [];
  let i = 0;
  const n = source.length;
  let inString: string | null = null;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1] ?? "";
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") { inBlockComment = false; i += 2; continue; }
      i += 1;
      continue;
    }
    if (inString !== null) {
      if (ch === "\\") { i += 2; continue; }
      if (ch === inString) { inString = null; i += 1; continue; }
      i += 1;
      continue;
    }
    if (inTemplate) {
      if (ch === "\\") { i += 2; continue; }
      if (ch === "`") { inTemplate = false; i += 1; continue; }
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") { inLineComment = true; i += 2; continue; }
    if (ch === "/" && next === "*") { inBlockComment = true; i += 2; continue; }
    if (ch === '"' || ch === "'") { inString = ch; i += 1; continue; }
    if (ch === "`") { inTemplate = true; i += 1; continue; }
    if (ch === "{" || ch === "(" || ch === "[") { stack.push(ch); i += 1; continue; }
    if (ch === "}" || ch === ")" || ch === "]") {
      const open = stack.pop();
      if (open === undefined) {
        // unmatched closer — leave it; the parser will report it.
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  if (stack.length === 0) return source;
  // Prepend a newline so the appended closers are NOT swallowed by a
  // trailing line comment (`// foo }` would otherwise eat the `}` we add).
  let closer = "\n";
  for (let k = stack.length - 1; k >= 0; k -= 1) {
    const open = stack[k];
    if (open === "{") closer += "}";
    else if (open === "(") closer += ")";
    else if (open === "[") closer += "]";
  }
  return source + closer;
}

/** Extract the source lines from a fragment for evidence reporting. */
function splitLines(source: string): readonly string[] {
  return source.length > 0 ? source.split("\n") : EMPTY_ARRAY as unknown as readonly string[];
}

function evidenceForLine(source: string, line: number): string {
  if (line <= 0) return source.split("\n")[0] ?? "";
  return splitLines(source)[line - 1] ?? "";
}

const SUPPRESSION_CATEGORY: BandaidPatternCategory = "type-suppression";
const DEFERRED_CATEGORY: BandaidPatternCategory = "deferred-fix";
const SWALLOW_CATEGORY: BandaidPatternCategory = "error-swallow";
const NULL_GUARD_CATEGORY: BandaidPatternCategory = "null-guard";

/**
 * Detect structural bandaids in `source`. Pure function; no I/O.
 *
 * When the fragment does not parse (e.g. JSX content in a `.ts` file, or a
 * partial line), the AST-based structural detectors cannot run. We fall
 * back to a RAW-TEXT scan for the LEARNED pragmas/markers (the learned
 * regexes are DYNAMIC — mined from the codebase, NOT static keywords — so
 * this fallback does not violate the "no static keywords" directive).
 * The structural AST shapes (empty catch, `as any`, null guard) require a
 * parse; if the fragment doesn't parse, they are not reported via the
 * fallback (the root-cause containment layer in `bandaid-detector.ts`
 * still runs independently).
 */
export function detectStructuralBandaids(
  source: string,
  options: StructuralDetectionOptions,
): readonly StructuralFinding[] {
  const ast = parseEditFragment(source, options.filePath);
  if (!ast) {
    return scanRawTextLearned(source, options);
  }
  const nodes = collectNodes(ast);
  const findings: StructuralFinding[] = [];
  const lines = splitLines(source);

  for (const node of nodes) {
    // 1. empty-or-comment-only catch (CatchClause with 0 body statements).
    if (node.type === "CatchClause") {
      const body = astNode(node.body);
      const bodyStmts = body && body.type === "BlockStatement" ? astNodeArray(body.body) : EMPTY_ARRAY;
      if (bodyStmts.length === 0) {
        const line = nodeLine(node);
        findings.push({
          shape: "empty-or-comment-only-catch",
          category: SWALLOW_CATEGORY,
          severity: "high",
          line,
          evidenceLine: lines[line - 1] ?? evidenceForLine(source, line),
          recommendation:
            "Empty (or comment-only) catch clause: the error is swallowed. Fix the root cause or re-throw/report the error.",
        });
        continue; // don't double-flag unused-binding on the same empty catch.
      }
    }

    // 2. `as any` (TSAsExpression with TSAnyKeyword type annotation).
    if (node.type === "TSAsExpression") {
      const typeAnn = astNode(node.typeAnnotation);
      if (isAnyKeyword(typeAnn)) {
        const line = nodeLine(node);
        findings.push({
          shape: "any-assertion",
          category: SUPPRESSION_CATEGORY,
          severity: "medium",
          line,
          evidenceLine: lines[line - 1] ?? evidenceForLine(source, line),
          recommendation:
            "Type assertion to `any` suppresses the type system. Fix the type at the source instead of casting to `any`.",
        });
      }
    }

    // 3. `<any>x` (TSTypeAssertion with TSAnyKeyword type annotation).
    if (node.type === "TSTypeAssertion") {
      const typeAnn = astNode(node.typeAnnotation);
      if (isAnyKeyword(typeAnn)) {
        const line = nodeLine(node);
        findings.push({
          shape: "any-assertion",
          category: SUPPRESSION_CATEGORY,
          severity: "medium",
          line,
          evidenceLine: lines[line - 1] ?? evidenceForLine(source, line),
          recommendation:
            "Type assertion to `any` suppresses the type system. Fix the type at the source instead of casting to `any`.",
        });
      }
    }

    // 3b. explicit `: any` type annotation on a declaration
    // (`const x: any =...`, `let x: any`, function params). Reads the
    // AST shape (TSAnyKeyword inside a TSTypeAnnotation), not the string
    // "any" — `: unknown` is NOT flagged (correctly: it is not a bandaid).
    if (node.type === "VariableDeclarator") {
      const id = astNode(node.id);
      const typeAnn = id ? astNode(id.typeAnnotation) : undefined;
      const inner = typeAnn ? astNode(typeAnn.typeAnnotation) : undefined;
      if (isAnyKeyword(inner)) {
        const line = nodeLine(node);
        findings.push({
          shape: "any-annotation",
          category: SUPPRESSION_CATEGORY,
          severity: "medium",
          line,
          evidenceLine: lines[line - 1] ?? evidenceForLine(source, line),
          recommendation:
            "Explicit `: any` annotation suppresses the type system. Fix the type at the source instead of declaring `any`.",
        });
      }
    }

    // 4. null/undefined guard at the symptom (IfStatement testing
    // === /!== / == /!= null|undefined, including LogicalExpression
    // like `x === null || x === undefined`). Structural: detects the
    // NullLiteral AST node or the `undefined` global Identifier — no
    // string matching on source text.
    if (node.type === "IfStatement") {
      const test = astNode(node.test);
      if (testHasAbsenceGuard(test)) {
        const line = nodeLine(node);
        findings.push({
          shape: "null-guard",
          category: NULL_GUARD_CATEGORY,
          severity: "low",
          line,
          evidenceLine: lines[line - 1] ?? evidenceForLine(source, line),
          recommendation:
            "Null/undefined guard at the symptom: the code guards against null/undefined where it surfaces, not where it originates. Fix the root cause that produces the null/undefined.",
        });
      }
    }

    // 5. unused catch binding (the caught variable is never referenced in
    // the body — the error is silently dropped). Only fires when the
    // body is non-empty (the empty-body case is handled by ).
    if (node.type === "CatchClause") {
      const param = astNode(node.param);
      const body = astNode(node.body);
      if (param && param.type === "Identifier" && body) {
        const bodyStmts = body.type === "BlockStatement" ? astNodeArray(body.body) : EMPTY_ARRAY;
        if (bodyStmts.length > 0) {
          const boundName = String(param.name);
          // Collect identifiers in the body EXCLUDING the param itself.
          const bodyIds = new Set<string>();
          for (const stmt of bodyStmts) {
            for (const id of identifierNames(stmt)) bodyIds.add(id);
          }
          if (!bodyIds.has(boundName)) {
            const line = nodeLine(node);
            findings.push({
              shape: "unused-catch-binding",
              category: SWALLOW_CATEGORY,
              severity: "medium",
              line,
              evidenceLine: lines[line - 1] ?? evidenceForLine(source, line),
              recommendation:
                "Caught error binding is never used: the error is silently dropped. Handle the error or re-throw it.",
            });
          }
        }
      }
    }
  }

  // 6. Learned suppression pragmas (e.g. `@ts-ignore`, `eslint-disable`) +
  // learned deferred markers (e.g. `TODO`, `FIXME` — mined from the
  // codebase, NOT hardcoded) + the structural long-comment heuristic.
  // The lists are LEARNED by `bandaid-pattern-learner.ts` from the
  // codebase — NOT hardcoded here. Empty learned set → no comment
  // findings (the structural detectors above still run).
  if (options.learnedSuppressionPragmas.length > 0 || options.learnedDeferredMarkers.length > 0) {
    const commentFindings = scanComments(ast, source, options);
    findings.push(...commentFindings);
  }

  return findings;
}

type CommentNode = Readonly<{
  type: "CommentLine" | "CommentBlock";
  value: string;
  loc: Readonly<{ start: Readonly<{ line: number; column: number }> }>;
}>;

/**
 * Scan comments for learned suppression pragmas + learned deferred markers +
 * the structural long-comment heuristic. No keyword list is hardcoded: the
 * pragmas/markers come from the learner (which mines them from the codebase).
 *
 * The long-comment heuristic (sentinel marker `__long_comment_heuristic__`)
 * flags a LEADING comment whose length is >= `longCommentMinCommentLength`
 * AND >= `longCommentMinRatio` × the following statement's length — the
 * "explaining why I didn't fix it" shape. This is keyword-free.
 */
function scanComments(
  ast: AstNode,
  source: string,
  options: StructuralDetectionOptions,
): readonly StructuralFinding[] {
  const findings: StructuralFinding[] = [];
  const lines = splitLines(source);
  const suppressionRes: readonly RegExp[] = options.learnedSuppressionPragmas.map((p) => new RegExp(p));
  const deferredMarkers = options.learnedDeferredMarkers.filter((m) => m !== "__long_comment_heuristic__");
  const deferredRes: readonly RegExp[] = deferredMarkers.map((p) => new RegExp(p));
  const hasLongCommentHeuristic = options.learnedDeferredMarkers.includes("__long_comment_heuristic__") && options.longCommentDeferredEnabled;

  // Walk the tree; for each statement, inspect its leading + trailing
  // comments (so inline `code; // @ts-ignore` is caught, not just
  // `// @ts-ignore\ncode;`). Also inspect the root node's own comments
  // (a lone `// @ts-ignore` with no following statement lands on the
  // Program's `innerComments` — without this, comment-only fragments are
  // missed).
  const inspectComment = (cn: CommentNode): void => {
    if (!cn || typeof cn.value !== "string") return;
    const text = cn.value;
    const cLoc = (cn as unknown as { loc?: { start?: { line: number } } }).loc;
    const line = cLoc?.start?.line ?? 0;
    for (const re of suppressionRes) {
      if (re.test(text)) {
        findings.push({
          shape: "suppression-comment",
          category: SUPPRESSION_CATEGORY,
          severity: "medium",
          line,
          evidenceLine: lines[line - 1] ?? "",
          recommendation:
            "Comment suppresses a diagnostic. Fix the underlying issue or, if the suppression is necessary, document why the root cause cannot be fixed.",
        });
        return;
      }
    }
    for (const re of deferredRes) {
      if (re.test(text)) {
        findings.push({
          shape: "deferred-fix-comment",
          category: DEFERRED_CATEGORY,
          severity: "low",
          line,
          evidenceLine: lines[line - 1] ?? "",
          recommendation:
            "Comment indicates deferred work. Track it as a task; do not leave the fix as a comment in the code.",
        });
        return;
      }
    }
  };
  // Root node comments (lone-comment fragments land on the Program's
  // `innerComments`). Check both the File (ast) and its Program child.
  const rootNodes: AstNode[] = [ast];
  const programNode = astNode((ast as unknown as { program?: unknown }).program);
  if (programNode) rootNodes.push(programNode);
  for (const root of rootNodes) {
    for (const key of ["leadingComments", "trailingComments", "innerComments"] as const) {
      const arr = (root as unknown as Record<string, unknown>)[key];
      if (Array.isArray(arr)) for (const c of arr) inspectComment(c as CommentNode);
    }
  }
  const visit = (n: AstNode): void => {
    for (const c of astChildren(n)) visit(c);
    if (!isStatementLike(n)) return;
    const stmtLen = statementTextLength(n);
    const leading = (n as unknown as Record<string, unknown>).leadingComments;
    if (Array.isArray(leading)) {
      // Check each individual leading comment against the learned pragmas.
      for (const c of leading) inspectComment(c as CommentNode);
      // Long-comment heuristic: merge consecutive leading comments into one
      // logical block (a multi-line "explain why I didn't fix it" block).
      if (hasLongCommentHeuristic && stmtLen > 0) {
        const mergedLen = leading.reduce(commentLengthReducer, 0);
        if (mergedLen >= options.longCommentMinCommentLength && mergedLen / stmtLen >= options.longCommentMinRatio) {
          const firstLoc = ((leading[0] as CommentNode) as unknown as { loc?: { start?: { line: number } } }).loc;
          const line = firstLoc?.start?.line ?? 0;
          // Only fire if none of the individual leading comments already
          // matched a learned marker (avoid double-flagging).
          const alreadyMatched = findings.some((f) => f.line === line && (f.shape === "suppression-comment" || f.shape === "deferred-fix-comment"));
          if (!alreadyMatched) {
            findings.push({
              shape: "long-comment-deferred",
              category: DEFERRED_CATEGORY,
              severity: "low",
              line,
              evidenceLine: lines[line - 1] ?? "",
              recommendation:
                "Comment is much longer than the code it precedes — the 'explaining why I didn't fix it' shape. Track the deferred work as a task; do not leave the explanation as a comment.",
            });
          }
        }
      }
    }
    const trailing = (n as unknown as Record<string, unknown>).trailingComments;
    if (Array.isArray(trailing)) {
      for (const c of trailing) inspectComment(c as CommentNode);
    }
  };
  visit(ast);
  return findings;
}

/**
 * Raw-text fallback for LEARNED pragmas/markers when the fragment does not
 * parse. Scans each line for the learned suppression pragmas + deferred
 * markers (DYNAMIC regexes mined from the codebase — NOT static keywords).
 * The structural AST shapes (empty catch, `as any`, null guard) are NOT
 * detected here — they require a parse. The root-cause containment layer
 * in `bandaid-detector.ts` runs independently of this fallback.
 */
function scanRawTextLearned(
  source: string,
  options: StructuralDetectionOptions,
): readonly StructuralFinding[] {
  const findings: StructuralFinding[] = [];
  const lines = splitLines(source);
  const suppressionRes: readonly RegExp[] = options.learnedSuppressionPragmas.map((p) => new RegExp(p));
  const deferredMarkers = options.learnedDeferredMarkers.filter((m) => m !== "__long_comment_heuristic__");
  const deferredRes: readonly RegExp[] = deferredMarkers.map((p) => new RegExp(p));
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    for (const re of suppressionRes) {
      if (re.test(line)) {
        findings.push({
          shape: "suppression-comment",
          category: SUPPRESSION_CATEGORY,
          severity: "medium",
          line: i + 1,
          evidenceLine: line,
          recommendation:
            "Comment suppresses a diagnostic. Fix the underlying issue or, if the suppression is necessary, document why the root cause cannot be fixed.",
        });
        break;
      }
    }
    for (const re of deferredRes) {
      if (re.test(line)) {
        findings.push({
          shape: "deferred-fix-comment",
          category: DEFERRED_CATEGORY,
          severity: "low",
          line: i + 1,
          evidenceLine: line,
          recommendation:
            "Comment indicates deferred work. Track it as a task; do not leave the fix as a comment in the code.",
        });
        break;
      }
    }
  }
  return findings;
}
