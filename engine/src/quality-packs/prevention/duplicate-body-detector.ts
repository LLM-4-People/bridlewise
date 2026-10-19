import { parse } from "@babel/parser";

import { sha256 } from "../../kernel/integrity.ts";
import { bestEffort } from "../../shared/best-effort.ts";
import { jaccard, shingles } from "../../shared/similarity.ts";
import {
  astChildren,
  astNode,
  astNodeArray,
  babelParserPluginsForSourcePath,
  type AstNode,
} from "./ast-helpers.ts";
import {
  extractAsyncForm,
  compareAsyncForms,
  type AsyncForm,
} from "./async-effect-normalizer.ts";
import {
  getEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderOptions,
} from "./embedding-provider.ts";
import type {
  BodyHashEntry,
  CollectedFunction,
  DuplicateBodyAllowlistCross,
  DuplicateBodyAllowlistSameFile,
  DuplicateBodyEmbeddingPass3Options,
  DuplicateBodyFinding,
  DuplicateBodyOptions,
  DuplicateBodyResult,
  Pass1Cluster,
} from "./duplicate-body-types.ts";
import {
  DEFAULT_JACCARD_THRESHOLD,
  DEFAULT_MIN_BODY_SIZE,
  DEFAULT_MIN_TOKEN_COUNT,
  DEFAULT_SHINGLE_K,
} from "./duplicate-body-types.ts";

// Re-export the public types so existing consumers don't need to change
// their import path (the detector is the canonical public API surface).
export type {
  BodyHashEntry,
  DuplicateBodyAllowlistCross,
  DuplicateBodyAllowlistSameFile,
  DuplicateBodyEmbeddingPass3Options,
  DuplicateBodyFinding,
  DuplicateBodyOptions,
  DuplicateBodyResult,
} from "./duplicate-body-types.ts";

// Round 3 A5 fix: type-aware operand-reorder for commutative operators.
// `+` is overloaded in JS (numeric addition + string concat), so reordering
// `a + b` ↔ `b + a` is ONLY safe when both operands are known numeric (the paper
// arXiv 2606.25272 §III-D confirms: "string concatenations are skipped because
// it may change the generated string value"). Other commutative operators (`*`,
// `==`, `===`, `!=`, `!==`, `&`, `|`, `^`) don't have the string-concat issue →
// always safe to reorder. `-`, `/`, `%`, `<`, `>`, `<=`, `>=`, `&&`, `||` are
// NOT commutative → never reorder.
//
// `KNOWN_NUMERIC` is a module-level set of identifier names known to be numeric
// for the current function being normalized. It's set in `normalizeTokensV2` +
// `computeIterationBodyTokens` (synchronous — no concurrency issue). This avoids
// threading a 6th parameter through 17+ `walkV2` call sites.
let KNOWN_NUMERIC: Set<string> = new Set();

// EXP126: `elemNameStack` is a module-level stack of element-identifier names
// for the enclosing loop-form normalization (`ITERATE_ARR <body with __ELEM__>`
// canonical form). When non-empty, any Identifier whose name is on the stack
// emits the canonical `__ELEM__` token instead of `ID`/`ID_NUM`, so the loop
// element is distinguishable from other variables in the body. Pushed/popped
// around the body walk in the four loop-form detection sites (for-i, for-of,
// forEach, map). Synchronous — no concurrency issue (same pattern as
// `KNOWN_NUMERIC`). Supports nesting: nested loops push both elem names; both
// map to `__ELEM__` (consistent with the existing all-idents-→-`ID` behavior —
// `__ELEM__` is just a more specific token, never less precise than `ID`).
// Sources: research/n1-deterministic/README.md (EXP126).
let elemNameStack: string[] = [];

// EXP390 Fix 2 (EXP178): `errNameStack` / `valNameStack` / `tryCatchAwaitDepth`
// are module-level state for the TRY_CATCH canonical normalization
// (try-catch ↔ promise+.catch). When `errNameStack` is non-empty, any
// Identifier whose name is on the stack emits `__ERR__` (the error variable of
// an enclosing catch /.catch handler — analogous to `__ELEM__`). When
// `valNameStack` is non-empty, any Identifier whose name is on the stack emits
// `__VAL__` (the.then-callback param of an enclosing TRY_CATCH promise.then
// form). `tryCatchAwaitDepth` is a separate counter for the try-catch form:
// when > 0, any AwaitExpression emits `__VAL__` (the awaited value). Pushed/
// popped around the handler-body + success-body walks in `emitTryCatchEnvelope`.
// Synchronous — no concurrency issue (same pattern as `KNOWN_NUMERIC` +
// `elemNameStack`).
let errNameStack: string[] = [];
let valNameStack: string[] = [];
let tryCatchAwaitDepth = 0;

// EXP390 Fix 3 (EXP179): `MAP_BINDINGS` is a module-level set of identifier
// names declared as "map-like" for the current function (Map ↔ plain object).
// A binding is map-like when it's `const/let X = new Map(...)` (always) OR
// `const/let X = {}` AND later accessed via computed member access
// (`X[k] = v` or `X[k]`). Set in `normalizeTokensV2` (synchronous). The MAP
// normalization canonicalizes `X.set(k,v)`/`X.get(k)` (CallExpression) and
// `X[k]=v`/`X[k]` (MemberExpression computed) to `MAP_SET <k> <v>` /
// `MAP_GET <k>` so `new Map` + `.set/.get` ↔ `{}` + `[k]=/[k]` produce the
// same token stream.
let MAP_BINDINGS: Set<string> = new Set();

/** Collect identifiers known to be numeric for a function (Round 3 A5 fix,
 * extended in Round 5.1 for recursive-helper params).
 * - For-loop counters: the variable updated in the for-update (`i++`, `i += 1`,
 * `i = i + 1`) is known numeric (UpdateExpression/AssignmentExpression → number).
 * - For-init + let/const declarations with NumericLiteral init: `let i = 0` → `i` numeric.
 * - Iterate to fixed-point: `const x = <known-numeric-expr>` → `x` numeric (transitive).
 * - Round 5.1 — recursive-helper params: a function param is inferred numeric if
 * it's a DIRECT operand of a strictly-numeric BinaryExpression (`<=`, `>=`, `<`,
 * `>`, `-`, `*`, `/`, `%`) or the argument of a strictly-numeric UpdateExpression
 * (`++`, `--`). NOT `+` (overloaded — string concat: arXiv 2606.25272 §III-D
 * "string concatenations are skipped because it may change the generated string
 * value"). "Direct" means the param's Identifier is the operand itself, NOT
 * inside a MemberExpression (e.g., `i >= tokens.length` infers `i` but NOT
 * `tokens`, since `tokens.length` is a MemberExpression and `tokens` is an
 * array). Skips nested function bodies (a param shadowed by a nested function's
 * local is NOT inferred from the nested function's usage).
 * Conservative: does NOT infer from TypeScript types (the detector uses @babel/parser
 * AST only, no type checker). Does NOT infer from `typeof x === "number"` (complex
 * refinement). Does NOT infer from `+` (overloaded — string concat).
 *
 * Sources:
 * - Round 3 A5: arXiv 2606.25272 §III-D (CC-BY-4.0) — "string concatenations
 * are skipped" → `+` is NOT strictly-numeric.
 * - Round 5.1: FAST paper (Kang et al. 2023, http://yinzhicao.org/FAST/ODGen-FAST.pdf)
 * — usage-based type inference principle ("if `b = a + "str"` and "str" is
 * string, infer both `a` and `b` are string"). The DUAL: if `i` is used in
 * `i >= tokens.length` (strictly-numeric `>=`), infer `i` is numeric.
 * - Round 5.1: Effective TypeScript "Flow Nodes" (https://effectivetypescript.com/2024/03/24/flownodes/)
 * — `narrowTypeByBinaryExpression` confirms usage-based type refinement. */
function collectKnownNumeric(fnNode: AstNode): Set<string> {
  const known = new Set<string>();
  const body = astNode(fnNode.body);
  if (body === undefined) return known;
  // For-loop counters: the variable updated in the for-update.
  walk(body, (n) => {
    if (n.type === "ForStatement") {
      const update = astNode((n as { update?: unknown }).update);
      if (update !== undefined) {
        const name = updatedName(update);
        if (name !== undefined) known.add(name);
      }
      const init = astNode((n as { init?: unknown }).init);
      if (init !== undefined && init.type === "VariableDeclaration") {
        for (const d of astNodeArray(init.declarations)) {
          const id = astNode(d.id);
          const initExpr = astNode(d.init);
          if (id?.type === "Identifier" && initExpr?.type === "NumericLiteral") {
            known.add(String(id.name));
          }
        }
      }
    }
  });
  // let/const declarations with NumericLiteral init.
  walk(body, (n) => {
    if (n.type === "VariableDeclaration" && (n.kind === "let" || n.kind === "const")) {
      for (const d of astNodeArray(n.declarations)) {
        const id = astNode(d.id);
        const init = astNode(d.init);
        if (id?.type === "Identifier" && init?.type === "NumericLiteral") {
          known.add(String(id.name));
        }
      }
    }
  });
  // Round 5.1: infer recursive-helper params from STRICTLY-NUMERIC DIRECT usage.
  // A param is inferred numeric if it's a DIRECT operand of a strictly-numeric
  // BinaryExpression (`<=`, `>=`, `<`, `>`, `-`, `*`, `/`, `%`) or the argument
  // of a strictly-numeric UpdateExpression (`++`, `--`). NOT `+` (overloaded —
  // string concat). "Direct" = the param's Identifier is the operand itself, NOT
  // inside a MemberExpression. Skips nested function bodies (a shadowed param
  // is NOT inferred from the nested function's usage).
  const paramNames = new Set<string>();
  for (const p of astNodeArray(fnNode.params)) {
    if (p.type === "Identifier") paramNames.add(String(p.name));
  }
  if (paramNames.size > 0) {
    const STRICT_NUMERIC_OPS = new Set(["<=", ">=", "<", ">", "-", "*", "/", "%"]);
    walkSkippingNestedFunctionBodies(body, (n) => {
      if (n.type === "BinaryExpression" && STRICT_NUMERIC_OPS.has(String(n.operator))) {
        const left = astNode(n.left);
        const right = astNode(n.right);
        if (left?.type === "Identifier" && paramNames.has(String(left.name))) {
          known.add(String(left.name));
        }
        if (right?.type === "Identifier" && paramNames.has(String(right.name))) {
          known.add(String(right.name));
        }
      }
      if (n.type === "UpdateExpression") {
        const arg = astNode(n.argument);
        if (arg?.type === "Identifier" && paramNames.has(String(arg.name))) {
          known.add(String(arg.name));
        }
      }
    });
  }
  // EXP403: infer params from TypeScript type annotations. A param with a
  // `TSTypeAnnotation` of `TSNumberKeyword` (or `number`) is known-numeric
  // regardless of usage. This fixes the N5 find+nullish case where the
  // predicate uses a numeric param inside a lambda: `values.find((v) => v > min)`
  // — `min` is typed `number` but its usage is inside the lambda, which
  // `walkSkippingNestedFunctionBodies` skips. Without this inference, `min`
  // emits `ID` in the mutant but `ID_NUM` in the original (where `min` is used
  // directly in the function body, outside any lambda). The type annotation is
  // a STRONGER signal than usage (it's the declared type, not inferred usage),
  // so this is safe: a param typed `number` IS numeric by declaration.
  {
    for (const p of astNodeArray(fnNode.params)) {
      if (p.type !== "Identifier") continue;
      const typeAnn = (p as { typeAnnotation?: unknown }).typeAnnotation;
      if (typeAnn === undefined) continue;
      const ta = astNode(typeAnn);
      if (ta === undefined || ta.type !== "TSTypeAnnotation") continue;
      const inner = astNode(ta.typeAnnotation);
      if (inner === undefined) continue;
      // `number` (TSNumberKeyword) or `readonly number[]` etc. — only the
      // direct `number` type is known-numeric (arrays, unions, etc. are not).
      if (inner.type === "TSNumberKeyword") {
        known.add(String(p.name));
      }
    }
  }
  // Fixed-point: propagate through const bindings with known-numeric init
  // (`const x = <known-numeric-expr>` → `x` numeric). Bounded by the const
  // bindings count (each iteration adds at least one new name or terminates).
  const constBindings = collectConstBindings(fnNode);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, init] of constBindings) {
      if (known.has(name)) continue;
      if (isKnownNumeric(init, known)) {
        known.add(name);
        changed = true;
      }
    }
  }
  return known;
}

/** Walk an AST subtree, visiting each node BUT NOT recursing into nested
 * function bodies (FunctionDeclaration/FunctionExpression/ArrowFunctionExpression).
 * Used by `collectKnownNumeric`'s param-usage inference so a param shadowed by
 * a nested function's local is NOT inferred from the nested function's usage.
 * The nested function node itself IS visited (e.g., for tail-call detection
 * in other passes), but its body is skipped. */
function walkSkippingNestedFunctionBodies(node: AstNode, visit: (n: AstNode) => void): void {
  visit(node);
  if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
    return; // skip nested function body (and params, which are children)
  }
  for (const child of astChildren(node)) walkSkippingNestedFunctionBodies(child, visit);
}

/** Check if an AST node is known to be numeric (Round 3 A5 fix).
 * - NumericLiteral, BigIntLiteral → true.
 * - Identifier in the known-numeric set → true.
 * - UnaryExpression `-x`, `+x`, `~x` on known-numeric → true.
 * - UpdateExpression `i++`, `i--` → true (result is a number).
 * - BinaryExpression `-`, `*`, `/`, `%` → true (always return numbers in JS).
 * - BinaryExpression `+` with both operands known-numeric → true.
 * - CallExpression `Number(x)`, `parseInt(x)`, `parseFloat(x)` → true.
 * - Else → false (conservative — could be a string). */
function isKnownNumeric(node: AstNode | undefined, known: Set<string>): boolean {
  if (node === undefined) return false;
  if (node.type === "NumericLiteral" || node.type === "BigIntLiteral") return true;
  if (node.type === "Identifier" && known.has(String(node.name))) return true;
  if (node.type === "UnaryExpression" && (node.operator === "-" || node.operator === "+" || node.operator === "~")) {
    return isKnownNumeric(astNode(node.argument), known);
  }
  if (node.type === "UpdateExpression") return true;
  if (node.type === "BinaryExpression") {
    const op = node.operator;
    if (op === "-" || op === "*" || op === "/" || op === "%") return true;
    if (op === "+") return isKnownNumeric(astNode(node.left), known) && isKnownNumeric(astNode(node.right), known);
  }
  if (node.type === "CallExpression") {
    const callee = astNode(node.callee);
    if (callee?.type === "Identifier") {
      const name = String(callee.name);
      if (name === "Number" || name === "parseInt" || name === "parseFloat") return true;
    }
  }
  return false;
}

/** Compare two token arrays lexicographically (for commutative-operand reorder).
 * Returns < 0 if a < b, 0 if equal, > 0 if a > b. */
function compareTokenArrays(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  if (a.length < b.length) return -1;
  if (a.length > b.length) return 1;
  return 0;
}

/** Emit a commutative BinaryExpression with operands in sorted order (Round 3 A5 fix).
 * For `+`: only reorder if both operands are known numeric (avoids string concat).
 * For `*`, `==`, `===`, `!=`, `!==`, `&`, `|`, `^`: always reorder (safe in JS).
 * For non-commutative/unsafe: emit in original order.
 * Returns true if the BinaryExpression was handled (reordered or not), false if
 * the caller should fall through to the default case. */
function emitCommutativeBinary(
  node: AstNode,
  tokens: string[],
  constBindings: Map<string, AstNode>,
  currentLoopVars: Set<string>,
  inliningStack: Set<string>,
  walkFn: (n: AstNode, t: string[], cb: Map<string, AstNode>, lv: Set<string>, is: Set<string>) => void,
): boolean {
  if (node.type !== "BinaryExpression") return false;
  const op = node.operator;
  const alwaysSafe = op === "*" || op === "==" || op === "===" || op === "!=" || op === "!==" || op === "&" || op === "|" || op === "^";
  const plusSafe = op === "+" && isKnownNumeric(astNode(node.left), KNOWN_NUMERIC) && isKnownNumeric(astNode(node.right), KNOWN_NUMERIC);
  if (!alwaysSafe && !plusSafe) return false;
  const left = astNode(node.left);
  const right = astNode(node.right);
  const leftTokens: string[] = [];
  const rightTokens: string[] = [];
  if (left !== undefined) walkFn(left, leftTokens, constBindings, currentLoopVars, inliningStack);
  if (right !== undefined) walkFn(right, rightTokens, constBindings, currentLoopVars, inliningStack);
  // Round 4 Fix 1 (FINDING 1 from Round 3 Verifier 1): emit the operator in the token
  // (`BinaryExpression_+` / `BinaryExpression_*`) so `+` vs `*` produce different tokens
  // (eliminates the operator-dropping FP). The operator is a parameter to the
  // BinaryExpression functor; preserving it makes the functor faithful (category theory —
  // same principle as the split-idiom delimiter fix, Round 2 fix-up #1).
  tokens.push(`BinaryExpression_${node.operator}`);
  if (compareTokenArrays(leftTokens, rightTokens) <= 0) {
    for (const t of leftTokens) tokens.push(t);
    for (const t of rightTokens) tokens.push(t);
  } else {
    for (const t of rightTokens) tokens.push(t);
    for (const t of leftTokens) tokens.push(t);
  }
  return true;
}

function functionParentName(parent: AstNode | undefined): string | undefined {
  if (parent === undefined) return undefined;
  if (parent.type === "VariableDeclarator") {
    const id = astNode(parent.id);
    if (id?.type === "Identifier") return String(id.name);
  }
  if (parent.type === "AssignmentExpression") {
    const left = astNode(parent.left);
    if (left?.type === "Identifier") return String(left.name);
    if (left?.type === "MemberExpression") {
      const prop = astNode(left.property);
      if (prop?.type === "Identifier" && !left.computed) return String(prop.name);
    }
  }
  if (parent.type === "ObjectProperty" || parent.type === "ObjectMethod") {
    const key = astNode(parent.key);
    if (key?.type === "Identifier" && !parent.computed) return String(key.name);
    if (key?.type === "StringLiteral") return String(key.value);
  }
  if (parent.type === "ExportDefaultDeclaration" || parent.type === "ExportNamedDeclaration") {
    return functionParentName(astNode(parent.declaration));
  }
  return undefined;
}

function collectFunctionsFromNode(
  node: AstNode,
  parent: AstNode | undefined,
  file: string,
  content: string,
  acc: CollectedFunction[],
): void {
  if (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  ) {
    const id = astNode(node.id);
    const name = id?.type === "Identifier" ? String(id.name) : (functionParentName(parent) ?? "<anonymous>");
    const start = typeof node.start === "number" ? node.start : 0;
    const end = typeof node.end === "number" ? node.end : start;
    const text = content.slice(start, end);
    const bodySize = text.length;
    // `normalizedHash` uses the OLD normalizeTokens (stability for the allowlist
    // drift check in pass2NormalizedClusters). `normalizedTokens` uses the V2
    // CFG + data-flow normalization (used by pass2NormalizedJaccard for shingling).
    const normalized = normalizeTokens(node);
    const normalizedV2 = normalizeTokensV2(node);
    const exactHash = sha256(text.replace(/\s+/g, " ").trim());
    const normalizedHash = sha256(normalized.join("|"));
    acc.push({ path: file, line: lineOf(content, start), name, text, bodySize, exactHash, normalizedHash, normalizedTokens: normalizedV2, node });
    // Recurse into params + body to catch nested functions.
    for (const child of astChildren(node)) collectFunctionsFromNode(child, node, file, content, acc);
    return;
  }
  for (const child of astChildren(node)) collectFunctionsFromNode(child, node, file, content, acc);
}

function lineOf(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function normalizeTokens(node: AstNode): string[] {
  const tokens: string[] = [];
  walk(node, (child) => {
    switch (child.type) {
      case "Identifier": tokens.push("ID"); break;
      case "StringLiteral": tokens.push("STR"); break;
      case "NumericLiteral": tokens.push("NUM"); break;
      case "RegExpLiteral": tokens.push("REGEX"); break;
      case "BigIntLiteral": tokens.push("BIGINT"); break;
      case "TemplateLiteral": tokens.push("TPL"); break;
      case "PrivateName": tokens.push("ID"); break;
      default: tokens.push(child.type); break;
    }
  });
  return tokens;
}

function walk(node: AstNode, visit: (n: AstNode) => void): void {
  visit(node);
  for (const child of astChildren(node)) walk(child, visit);
}

// ============================================================================
// V2 normalization: CFG + data-flow normalization for the Pass-2 Jaccard stream.
//
// Produces a token stream where semantically-equivalent code forms converge:
// - Data-flow: `const x = <simpleExpr>` is inlined at use sites (simpleExpr =
// no BinaryExpression/AssignmentExpression, to avoid spreading operand-reorder
// mutations like O4 to use sites). Cyclic references are guarded by an
// inlining-stack set. `let`/`var` reassignments are NOT inlined.
// - CFG loops: ForStatement/WhileStatement/DoWhileStatement → canonical `LOOP`
// token. The for-init (if VariableDeclaration) is hoisted before `LOOP` so it
// aligns with the while-form's pre-loop init. The for-update is DROPPED (loop
// mechanic). Inside the body, loop-variable updates (ExpressionStatement of
// UpdateExpression/AssignmentExpression on a loop variable) are stripped when
// they are the last statement OR immediately precede a ContinueStatement — at
// all nesting levels. This aligns the for-form (update in header) with the
// while-form (update replicated before each continue + at body end).
// - CFG decisions: IfStatement → `DECIDE`. SwitchStatement is UNWRAPPED: each
// non-default case → `DECIDE [test] [consequent]`; the default case's
// consequent is emitted as SIBLINGS (no DECIDE wrapper), so the switch
// `default: { if(...) {...} rest }` aligns with the if-chain
// `if(...) {...} rest`. Fallthrough cases (empty consequent) merge their
// tests into the next non-empty case. Equality tests (`ID === literal` /
// `ID!== literal`) emit just the literal (drop the discriminant + operator).
// `LogicalExpression(||, eq1, eq2,...)` of same-discriminant equality tests
// emits all literals — so `a === "}" || a === "]"` aligns with two fallthrough
// `case "}": case "]":` cases.
// - BlockStatement: the BlockStatement wrapper is ALWAYS dropped (after
// loop-update stripping), so `if (x) { continue; }` aligns with
// `if (x) continue;`, AND `withConst { const x = 5; return x; }` aligns
// with `inlined { return 5; }` after const inlining. A block is a pure
// grouping construct; the `{ }` wrapper carries no semantic info beyond
// its statements (the `directives` field holds legacy directives like
// "use strict", which are implicit in ES modules and are NOT walked).
// The previous logic dropped the wrapper only for single-statement
// bodies, which created an asymmetry: a 2-statement body (const-decl +
// switch) emitted a `BlockStatement` wrapper but a 1-statement body
// didn't — mismatching the if-chain form. Symmetric dropping fixes
// FINDING 2 (const-only + single-statement mutant pairs) and improves
// O6 (0.9329 → 1.0000) without regressing any pair. The prior art is
// more conservative (jsinspect, cargo-dupes keep the Block wrapper;
// neither normalizes if↔switch), but our detector already normalizes
// if↔switch (Round 1) and already dropped single-statement wrappers —
// `symdrop` extends the existing behavior symmetrically.
//
// Sources (MIT/Apache):
// - CloneOperator paper (arXiv 2606.25272, CC-BY-4.0): for O5 loop replacement,
// "extract initialization expressions, loop conditions, update statements,
// loop bodies, and labels" — confirms the extract-canonicalize approach.
// - CASCADE (arXiv 2507.17691) / SAFE-DEOBS (arXiv 2009.09170): constant
// propagation + inlining to fixpoint for JS deobfuscation.
// - Babel AST spec (github.com/babel/babel, MIT): ForStatement{init,test,
// update,body}, WhileStatement{test,body}, DoWhileStatement{body,test},
// SwitchStatement{discriminant,cases}, SwitchCase{test,consequent},
// IfStatement{test,consequent,alternate}, VariableDeclaration{declarations,
// kind}.
//
// The `normalizedHash` (used for allowlist drift detection in pass2NormalizedClusters)
// still uses the OLD `normalizeTokens` so existing allowlist entries in
// `test/prevention/duplicate-bodies-allowlist.json` remain stable.
// ============================================================================

/** True if `init` is "simple": contains no BinaryExpression, AssignmentExpression,
 * TSAsExpression, or TSTypeAssertion. The arithmetic exclusions avoid spreading
 * operand-reorder mutations (O4) from declarations to use sites. The type-cast
 * exclusions avoid inflating the inlined token count (TSAsExpression type
 * annotations are duplicated at each use site, pushing small functions above the
 * minTokenCount threshold and creating false positives on real code). The
 * ConditionalExpression exclusion (Round 4 N3 fix) prevents `const x = cond? a: b`
 * from being inlined to use sites — the ternary must stay in place so the
 * `emitTernaryDecision` distribution normalization can fire (the ternary↔if-else
 * equivalence requires the ternary to be at the declaration site, not spread to
 * use sites). */
function isSimpleInitializer(init: AstNode | undefined): boolean {
  if (init === undefined) return false;
  let simple = true;
  function rec(n: AstNode | undefined): void {
    if (n === undefined || !simple) return;
    if (n.type === "BinaryExpression" || n.type === "AssignmentExpression" ||
        n.type === "TSAsExpression" || n.type === "TSTypeAssertion" ||
        n.type === "ConditionalExpression") {
      simple = false;
      return;
    }
    for (const c of astChildren(n)) rec(c);
  }
  rec(init);
  return simple;
}

/** Collect `const` bindings (name → init node) at function scope.
 * Only `kind === "const"` with a simple Identifier declarator and a simple
 * initializer (no BinaryExpression/AssignmentExpression). Excludes bindings
 * that are part of a split-idiom (Round 2) so the split operation stays in place
 * (not inlined to use sites) — both forms normalize to `SPLIT ID STR_<delim-value>`
 * at the
 * same position. */
function collectConstBindings(fnNode: AstNode): Map<string, AstNode> {
  const bindings = new Map<string, AstNode>();
  const excluded = splitIdiomExcludedBindings(fnNode);
  const body = astNode(fnNode.body);
  if (body === undefined) return bindings;
  walk(body, (n) => {
    if (n.type === "VariableDeclaration" && n.kind === "const") {
      for (const decl of astNodeArray(n.declarations)) {
        const id = astNode(decl.id);
        const init = astNode(decl.init);
        if (id?.type === "Identifier" && init !== undefined && isSimpleInitializer(init) && !excluded.has(String(id.name))) {
          bindings.set(String(id.name), init);
        }
      }
    }
  });
  return bindings;
}

/** Extract loop-variable names from a loop test expression.
 * `i < N` → {"i"}. `a < N && b > 0` → {"a","b"}. Recurses into LogicalExpression
 * and UnaryExpression; for MemberExpression only the object is followed (not the
 * property), so `tokens[i]` does NOT make `tokens` a loop variable. */
function loopVarsOf(test: AstNode | undefined): Set<string> {
  const out = new Set<string>();
  if (test === undefined) return out;
  function rec(n: AstNode | undefined): void {
    if (n === undefined) return;
    if (n.type === "LogicalExpression") {
      rec(astNode(n.left));
      rec(astNode(n.right));
      return;
    }
    if (n.type === "BinaryExpression") {
      const l = astNode(n.left);
      const r = astNode(n.right);
      if (l?.type === "Identifier") out.add(String(l.name));
      if (r?.type === "Identifier") out.add(String(r.name));
      return;
    }
    if (n.type === "UnaryExpression" || n.type === "ParenthesizedExpression") {
      rec(astNode(n.argument));
      return;
    }
    if (n.type === "CallExpression") {
      rec(astNode(n.callee));
      for (const a of astNodeArray(n.arguments)) rec(a);
      return;
    }
    if (n.type === "MemberExpression") {
      rec(astNode(n.object));
      return;
    }
  }
  rec(test);
  return out;
}

/** True if `n` is a literal AST node (leaf value). Acts as a type guard so
 * callers can narrow `AstNode | undefined` to `AstNode`. */
function isLiteralNode(n: AstNode | undefined): n is AstNode {
  if (n === undefined) return false;
  return n.type === "StringLiteral" || n.type === "NumericLiteral" ||
    n.type === "BooleanLiteral" || n.type === "NullLiteral" ||
    n.type === "RegExpLiteral" || n.type === "BigIntLiteral";
}

/** If `test` is `ID === literal` or `ID!== literal` (or the mirror), return
 * `{ discriminant, literalNode }`. Otherwise undefined. */
function equalityTest(test: AstNode | undefined): { discriminant: string; literalNode: AstNode } | undefined {
  const t = astNode(test);
  if (t === undefined || t.type !== "BinaryExpression") return undefined;
  if (t.operator !== "===" && t.operator !== "!==") return undefined;
  const l = astNode(t.left);
  const r = astNode(t.right);
  if (l?.type === "Identifier" && isLiteralNode(r)) return { discriminant: String(l.name), literalNode: r };
  if (r?.type === "Identifier" && isLiteralNode(l)) return { discriminant: String(r.name), literalNode: l };
  return undefined;
}

/** Extract literal nodes from `LogicalExpression(||, eq, eq,...)` where each eq
 * is `BinaryExpression(===, ID, lit)` / `BinaryExpression(!==, ID, lit)` with the
 * SAME discriminant. Returns the literal nodes, or undefined if the pattern
 * doesn't match. */
function extractEqualityLiterals(test: AstNode | undefined): readonly AstNode[] | undefined {
  const t = astNode(test);
  if (t === undefined || t.type !== "LogicalExpression" || t.operator !== "||") return undefined;
  const lits: AstNode[] = [];
  let discriminant: string | undefined = undefined;
  let consistent = true;
  function rec(n: AstNode | undefined): void {
    if (!consistent || n === undefined) return;
    if (n.type === "LogicalExpression" && n.operator === "||") {
      rec(astNode(n.left));
      rec(astNode(n.right));
      return;
    }
    const et = equalityTest(n);
    if (et === undefined) { consistent = false; return; }
    if (discriminant === undefined) discriminant = et.discriminant;
    else if (discriminant !== et.discriminant) { consistent = false; return; }
    lits.push(et.literalNode);
  }
  rec(t);
  return consistent && lits.length > 0 ? lits : undefined;
}

/** If `expr` is an UpdateExpression or AssignmentExpression on a simple
 * Identifier, return the identifier name. Otherwise undefined. */
function updatedName(expr: AstNode | undefined): string | undefined {
  if (expr === undefined) return undefined;
  if (expr.type === "UpdateExpression") {
    const arg = astNode(expr.argument);
    if (arg?.type === "Identifier") return String(arg.name);
  }
  if (expr.type === "AssignmentExpression") {
    const lhs = astNode(expr.left);
    if (lhs?.type === "Identifier") return String(lhs.name);
  }
  return undefined;
}

/** True if `stmt` is an ExpressionStatement that updates a loop variable and
 * should be stripped (it is the last statement OR immediately precedes a
 * ContinueStatement in its containing block). */
function shouldStripLoopUpdate(
  stmt: AstNode | undefined,
  nextStmt: AstNode | undefined,
  loopVars: Set<string>,
): boolean {
  if (stmt === undefined || loopVars.size === 0) return false;
  if (stmt.type !== "ExpressionStatement") return false;
  const expr = astNode(stmt.expression);
  const name = updatedName(expr);
  if (name === undefined || !loopVars.has(name)) return false;
  if (nextStmt === undefined) return true;
  if (nextStmt.type === "ContinueStatement") return true;
  return false;
}

// ============================================================================
// T4b split-idiom normalization (Round 2).
// Detects the hand-rolled `str.split(delim)` loop pattern (8 elements) and
// normalizes both forms (`str.split(delim)` and the hand-rolled loop) to a
// canonical `SPLIT ID STR_<delim-value>` token sequence (Round 2 fix-up:
// different delimiters emit different `STR_<value>` tokens to avoid the
// delimiter-mismatch FP — FINDING 1). This catches T4b (library↔hand-rolled)
// at Jaccard 1.0000 with no false positives on control pairs.
//
// The hand-rolled split loop pattern:
// (A) `const/let arr = []` — array decl
// (B) `let cur = ""` — string accumulator decl
// (C) `for (let i = 0; i < str.length; i++) {... }` — loop over str
// (D) `const ch = str[i]` (or `str[i]!` with TSNonNullExpression) — char access
// (E) `if (ch === delim) {... } else {... }` — delimiter check
// (F) `arr.push(cur); cur = ""` — push + reset (in if-branch)
// (G) `cur += ch` or `cur = cur + ch` — else append (in else-branch)
// (H) `arr.push(cur)` — push last line (after loop)
//
// Sources: no code extracted — implementation is original (only the algorithmic
// approach confirmed via research/round2-t4a-t4b/idiom-detection-search.md).
// ============================================================================

/** Unwrap TSNonNullExpression/TSAsExpression/TSTypeAssertion to get the inner expression. */
function unwrapTsNode(n: AstNode | undefined): AstNode | undefined {
  let out = n;
  while (out !== undefined && (out.type === "TSNonNullExpression" || out.type === "TSAsExpression" || out.type === "TSTypeAssertion")) {
    const inner = astNode((out as Record<string, unknown>).expression) ?? astNode((out as Record<string, unknown>).argument);
    out = inner;
  }
  return out;
}

/** Detect `str.split(delim)` — a CallExpression with callee `str.split` and a single
 * StringLiteral argument. Returns `{ strName, delimNode }` or undefined. */
function detectSplitCall(node: AstNode | undefined): { strName: string; delimNode: AstNode } | undefined {
  if (node === undefined || node.type !== "CallExpression") return undefined;
  const callee = astNode(node.callee);
  if (callee === undefined || callee.type !== "MemberExpression") return undefined;
  const calleeObj = astNode(callee.object);
  const calleeProp = astNode(callee.property);
  if (calleeObj === undefined || calleeObj.type !== "Identifier") return undefined;
  if (calleeProp === undefined || calleeProp.type !== "Identifier" || String(calleeProp.name) !== "split") return undefined;
  const args = astNodeArray(node.arguments);
  if (args.length !== 1) return undefined;
  const arg = astNode(args[0]);
  if (arg === undefined || arg.type !== "StringLiteral") return undefined;
  return { strName: String(calleeObj.name), delimNode: arg };
}

/** Emit a canonical `STR_<delim-value>` token for a split-idiom delimiter
 * (Round 2 fix-up: FINDING 1 — different delimiters must produce different
 * tokens to avoid false positives). The delimiter is a StringLiteral
 * (guaranteed by `detectSplitCall` / `detectSplitIdiom`); its `value` field
 * carries the actual string. For short delimiters (<= 32 chars, no `|`), emit
 * the value directly — readable in debug output + matches the verifier's
 * tested fix (`STR_${value}`). For long delimiters (> 32 chars) or values
 * containing `|` (the shingle join separator), emit `STR_<sha16>` (first 16
 * hex chars of sha256 — 64 bits) to avoid token-stream inflation +
 * shingle-string collisions. The empty-string delimiter (`str.split("")`)
 * emits `STR_` — both forms (split + hand-rolled char-by-char) emit the same
 * token → caught (semantically equivalent, per the spec: `str.split("")`
 * splits into chars). A defensive typeof check guards against a malformed
 * StringLiteral node (shouldn't happen per the Babel AST spec —
 * github.com/babel/babel, MIT — but defensive).
 *
 * Hash-length choice (Round 2 fix-up #2 — Verifier 3 FINDING 1, LOW): the
 * earlier `STR_<sha8>` (32 bits) had a confirmed collision FP surface — a
 * brute-force search found long/pipe delimiter pairs colliding at sha8
 * within seconds (birthday ~65k for 50% at 2^32 space), producing a FP at
 * production-relaxed. `STR_<sha16>` (64 bits, 2^64 space, birthday ~4.3e9
 * for 50%) reduces the collision risk by 2^32×; the residual sha16 surface
 * is effectively impossible to hit by accident (a deliberate ~4B-string
 * search is required for a 50% collision, far beyond any realistic
 * delimiter-value pool of 1-10 distinct delimiters per codebase).
 *
 * Round 4 "keep on improving" (A4 generalization): the same value-preserving
 * logic is now applied to ALL StringLiteral nodes via `emitStringLiteralValueToken`
 * (not just split-idiom delimiters). This fixes the A4 pre-existing FP surface
 * (general `StringLiteral → STR` loses the value for non-split-idiom functions →
 * two functions identical except a string literal → Jaccard 1.0 → FP at relaxed).
 * Sources: same as `emitSplitDelimToken` (Babel AST spec, MIT; sha16 birthday math).
 * Category theory: the string value is a parameter to the StringLiteral functor;
 * preserving it makes the functor faithful (same principle as the split-idiom
 * delimiter fix + the operator-dropping fix). */
function emitStringLiteralValueToken(value: string, tokens: string[]): void {
  if (value.length > 32 || value.includes("|")) {
    tokens.push(`STR_${sha256(value).slice(0, 16)}`);
  } else {
    tokens.push(`STR_${value}`);
  }
}

function emitSplitDelimToken(delimNode: AstNode, tokens: string[]): void {
  const raw = (delimNode as { value?: unknown }).value;
  const value = typeof raw === "string" ? raw : "";
  emitStringLiteralValueToken(value, tokens);
}

/** Detect the hand-rolled split loop pattern in a function body. Returns the span
 * (startStmtIdx, endStmtIdx inclusive) + the str/delim info, or undefined. */
function detectSplitIdiom(fnNode: AstNode): { arrName: string; strName: string; delimNode: AstNode; startStmtIdx: number; endStmtIdx: number } | undefined {
  const body = astNode(fnNode.body);
  if (body === undefined || body.type !== "BlockStatement") return undefined;
  const stmts = astNodeArray(body.body);
  for (let iA = 0; iA < stmts.length; iA += 1) {
    const a = stmts[iA]!;
    if (a.type !== "VariableDeclaration") continue;
    if (a.kind !== "const" && a.kind !== "let") continue;
    const aDecls = astNodeArray(a.declarations);
    if (aDecls.length !== 1) continue;
    const aId = astNode(aDecls[0]!.id);
    const aInit = astNode(aDecls[0]!.init);
    if (aId === undefined || aId.type !== "Identifier") continue;
    if (aInit === undefined || aInit.type !== "ArrayExpression") continue;
    const arrName = String(aId.name);
    const iB = iA + 1;
    if (iB >= stmts.length) continue;
    const b = stmts[iB]!;
    if (b.type !== "VariableDeclaration" || b.kind !== "let") continue;
    const bDecls = astNodeArray(b.declarations);
    if (bDecls.length !== 1) continue;
    const bId = astNode(bDecls[0]!.id);
    const bInit = astNode(bDecls[0]!.init);
    if (bId === undefined || bId.type !== "Identifier") continue;
    if (bInit === undefined || bInit.type !== "StringLiteral" || bInit.value !== "") continue;
    const curName = String(bId.name);
    const iC = iB + 1;
    if (iC >= stmts.length) continue;
    const c = stmts[iC]!;
    if (c.type !== "ForStatement") continue;
    const cTest = astNode(c.test);
    if (cTest === undefined || cTest.type !== "BinaryExpression" || cTest.operator !== "<") continue;
    const cTestLeft = astNode(cTest.left);
    const cTestRight = astNode(cTest.right);
    if (cTestLeft === undefined || cTestLeft.type !== "Identifier") continue;
    const iVar = String(cTestLeft.name);
    if (cTestRight === undefined || cTestRight.type !== "MemberExpression") continue;
    const cTestRightObj = astNode(cTestRight.object);
    const cTestRightProp = astNode(cTestRight.property);
    if (cTestRightObj === undefined || cTestRightObj.type !== "Identifier") continue;
    if (cTestRightProp === undefined || cTestRightProp.type !== "Identifier" || String(cTestRightProp.name) !== "length") continue;
    const strName = String(cTestRightObj.name);
    const cBody = astNode(c.body);
    if (cBody === undefined || cBody.type !== "BlockStatement") continue;
    const cStmts = astNodeArray(cBody.body);
    if (cStmts.length < 2) continue;
    const d = cStmts[0]!;
    if (d.type !== "VariableDeclaration") continue;
    const dDecls = astNodeArray(d.declarations);
    if (dDecls.length !== 1) continue;
    const dId = astNode(dDecls[0]!.id);
    let dInit = astNode(dDecls[0]!.init);
    if (dId === undefined || dId.type !== "Identifier") continue;
    const chName = String(dId.name);
    dInit = unwrapTsNode(dInit);
    if (dInit === undefined || dInit.type !== "MemberExpression") continue;
    const dInitObj = astNode(dInit.object);
    const dInitProp = astNode(dInit.property);
    if (dInitObj === undefined || dInitObj.type !== "Identifier" || String(dInitObj.name) !== strName) continue;
    if (dInitProp === undefined || dInitProp.type !== "Identifier" || String(dInitProp.name) !== iVar) continue;
    const e = cStmts[1]!;
    if (e.type !== "IfStatement") continue;
    const eTest = astNode(e.test);
    if (eTest === undefined || eTest.type !== "BinaryExpression" || eTest.operator !== "===") continue;
    const eTestLeft = astNode(eTest.left);
    const eTestRight = astNode(eTest.right);
    if (eTestLeft === undefined || eTestLeft.type !== "Identifier" || String(eTestLeft.name) !== chName) continue;
    if (eTestRight === undefined || eTestRight.type !== "StringLiteral") continue;
    const delimNode = eTestRight;
    const eCons = astNode(e.consequent);
    if (eCons === undefined || eCons.type !== "BlockStatement") continue;
    const eConsStmts = astNodeArray(eCons.body);
    if (eConsStmts.length < 2) continue;
    const f1 = eConsStmts[0]!;
    const f2 = eConsStmts[1]!;
    if (f1.type !== "ExpressionStatement") continue;
    const f1Expr = astNode(f1.expression);
    if (f1Expr === undefined || f1Expr.type !== "CallExpression") continue;
    const f1Callee = astNode(f1Expr.callee);
    if (f1Callee === undefined || f1Callee.type !== "MemberExpression") continue;
    const f1CalleeObj = astNode(f1Callee.object);
    const f1CalleeProp = astNode(f1Callee.property);
    if (f1CalleeObj === undefined || f1CalleeObj.type !== "Identifier" || String(f1CalleeObj.name) !== arrName) continue;
    if (f1CalleeProp === undefined || f1CalleeProp.type !== "Identifier" || String(f1CalleeProp.name) !== "push") continue;
    const f1Args = astNodeArray(f1Expr.arguments);
    if (f1Args.length !== 1) continue;
    const f1Arg = astNode(f1Args[0]!);
    if (f1Arg === undefined || f1Arg.type !== "Identifier" || String(f1Arg.name) !== curName) continue;
    if (f2.type !== "ExpressionStatement") continue;
    const f2Expr = astNode(f2.expression);
    if (f2Expr === undefined || f2Expr.type !== "AssignmentExpression" || f2Expr.operator !== "=") continue;
    const f2Left = astNode(f2Expr.left);
    const f2Right = astNode(f2Expr.right);
    if (f2Left === undefined || f2Left.type !== "Identifier" || String(f2Left.name) !== curName) continue;
    if (f2Right === undefined || f2Right.type !== "StringLiteral" || f2Right.value !== "") continue;
    const eAlt = astNode(e.alternate);
    if (eAlt === undefined || eAlt.type !== "BlockStatement") continue;
    const eAltStmts = astNodeArray(eAlt.body);
    if (eAltStmts.length !== 1) continue;
    const g = eAltStmts[0]!;
    if (g.type !== "ExpressionStatement") continue;
    const gExpr = astNode(g.expression);
    if (gExpr === undefined || gExpr.type !== "AssignmentExpression") continue;
    const gLeft = astNode(gExpr.left);
    if (gLeft === undefined || gLeft.type !== "Identifier" || String(gLeft.name) !== curName) continue;
    if (gExpr.operator === "+=") {
      const gRight = astNode(gExpr.right);
      if (gRight === undefined || gRight.type !== "Identifier" || String(gRight.name) !== chName) continue;
    } else if (gExpr.operator === "=") {
      const gRight = astNode(gExpr.right);
      if (gRight === undefined || gRight.type !== "BinaryExpression" || gRight.operator !== "+") continue;
      const gRightLeft = astNode(gRight.left);
      const gRightRight = astNode(gRight.right);
      if (gRightLeft === undefined || gRightLeft.type !== "Identifier" || String(gRightLeft.name) !== curName) continue;
      if (gRightRight === undefined || gRightRight.type !== "Identifier" || String(gRightRight.name) !== chName) continue;
    } else {
      continue;
    }
    const iH = iC + 1;
    if (iH >= stmts.length) continue;
    const h = stmts[iH]!;
    if (h.type !== "ExpressionStatement") continue;
    const hExpr = astNode(h.expression);
    if (hExpr === undefined || hExpr.type !== "CallExpression") continue;
    const hCallee = astNode(hExpr.callee);
    if (hCallee === undefined || hCallee.type !== "MemberExpression") continue;
    const hCalleeObj = astNode(hCallee.object);
    const hCalleeProp = astNode(hCallee.property);
    if (hCalleeObj === undefined || hCalleeObj.type !== "Identifier" || String(hCalleeObj.name) !== arrName) continue;
    if (hCalleeProp === undefined || hCalleeProp.type !== "Identifier" || String(hCalleeProp.name) !== "push") continue;
    const hArgs = astNodeArray(hExpr.arguments);
    if (hArgs.length !== 1) continue;
    const hArg = astNode(hArgs[0]!);
    if (hArg === undefined || hArg.type !== "Identifier" || String(hArg.name) !== curName) continue;
    return { arrName, strName, delimNode, startStmtIdx: iA, endStmtIdx: iH };
  }
  return undefined;
}

/** Returns the set of const-binding names that should be EXCLUDED from inlining
 * because they're part of a split-idiom (either the hand-rolled loop's arr/cur or
 * a `const X = str.split(delim)` declaration). Excluding them keeps the split
 * operation in place (not inlined to use sites) so both forms normalize to
 * `SPLIT ID STR_<delim-value>` at the same position. */
function splitIdiomExcludedBindings(fnNode: AstNode): Set<string> {
  const excluded = new Set<string>();
  const splitSpan = detectSplitIdiom(fnNode);
  if (splitSpan !== undefined) {
    excluded.add(splitSpan.arrName);
    // Also find the curName (the let-binding) — it's the (B) statement.
    const body = astNode(fnNode.body);
    if (body !== undefined && body.type === "BlockStatement") {
      const stmts = astNodeArray(body.body);
      const b = stmts[splitSpan.startStmtIdx + 1];
      if (b !== undefined && b.type === "VariableDeclaration") {
        const bDecls = astNodeArray(b.declarations);
        if (bDecls.length === 1) {
          const bId = astNode(bDecls[0]!.id);
          if (bId !== undefined && bId.type === "Identifier") excluded.add(String(bId.name));
        }
      }
    }
  }
  // Exclude `const X = str.split(delim)` declarations (the library form).
  const body = astNode(fnNode.body);
  if (body !== undefined && body.type === "BlockStatement") {
    for (const s of astNodeArray(body.body)) {
      if (s.type === "VariableDeclaration" && (s.kind === "const" || s.kind === "let")) {
        for (const d of astNodeArray(s.declarations)) {
          const id = astNode(d.id);
          const init = astNode(d.init);
          if (id !== undefined && id.type === "Identifier" && init !== undefined && init.type === "CallExpression") {
            if (detectSplitCall(init) !== undefined) excluded.add(String(id.name));
          }
        }
      }
    }
  }
  return excluded;
}

/** Walker function signature (higher-order parameter). Both `walkV2` (Pass 2)
 * and `walkIterationBody` (Pass 2.5) conform to this signature; the Pass 2.5
 * caller wraps `walkIterationBody` in a thunk that closes over `letDrop`. This
 * is the strategy pattern for AST traversal (Round 5.2 DRY refactor): shared
 * helpers take `walkFn` and recurse via it, so the shared normalization logic
 * (Identifier, StringLiteral, BinaryExpression, Loop, IfStatement,
 * SwitchStatement, stmt-list, decision-test, body) has ONE owner per
 * normalization. See `research/round5-2-dry-refactor/` for the design rationale
 * (the gh-aw #37979 linter-helper consolidation confirms this is the recognized
 * pattern; the `walkFn` higher-order pattern is already established via
 * `emitCommutativeBinary`). */
type WalkFn = (
  node: AstNode,
  tokens: string[],
  constBindings: Map<string, AstNode>,
  currentLoopVars: Set<string>,
  inliningStack: Set<string>,
) => void;

/** Emit a decision test (IfStatement test / SwitchCase test) with equality-test
 * normalization: `ID === literal` → just `literal`; `LogicalExpression(||, eq,
 * eq,...)` → all literals. Otherwise emit normally.
 *
 * Round 5.2: takes `walkFn` (higher-order) so both `walkV2` (Pass 2) and
 * `walkIterationBody` (Pass 2.5) share this helper. The old `walkIterationBody`
 * inlined this logic (because it couldn't call `walkV2`); the shared helper
 * eliminates the duplication + the drift risk.
 *
 * Round 5.3 O3 fix: strip redundant boolean literals in LogicalExpression BEFORE
 * the equality-test checks. `X || false` → `X` and `X && true` → `X` (and the
 * mirror orders `false || X` → `X`, `true && X` → `X`). This is safe in a
 * DECISION-TEST context (boolean context): `if (x || false) === if (x)` because
 * `if` coerces to boolean, and `Boolean(x || false) === Boolean(x)` (since
 * `x || false` is `x` when truthy, `false` when falsy — both have the same
 * truthiness as `x`). Similarly `Boolean(x && true) === Boolean(x)`. The O3
 * mutant inserts `|| false` to a boolean condition (`ancestors.has(value) || false`);
 * stripping it makes the mutant's token stream match the original's. This is
 * an extension of the existing equality-test simplification (both are "remove
 * redundant parts of a test expression"). Sources: the "Normalizer" thesis
 * (2018) confirms "removing useless code" is a recognized normalization. FP
 * risk: NONE in the decision-test context (the strip is sound because `if`
 * coerces to boolean). The strip does NOT apply to value-context `X || false`
 * (e.g., `const y = x || false` — where `y` is `x` when truthy, `false` when
 * falsy; for falsy non-boolean `x` like `0`, `y = false` ≠ `x = 0`). The strip
 * is ONLY in `emitDecisionTest` (IfStatement/SwitchCase tests), NOT in the
 * general walkV2. */
function emitDecisionTest(
  test: AstNode | undefined,
  tokens: string[],
  constBindings: Map<string, AstNode>,
  loopVars: Set<string>,
  inliningStack: Set<string>,
  walkFn: WalkFn,
): void {
  if (test === undefined) return;
  // Round 5.3 O3 fix: strip `X || false` / `X && true` / `false || X` /
  // `true && X` (redundant boolean literal in LogicalExpression). Safe in a
  // boolean context (decision test). Recurse: `(a || false) && true` →
  // `a || false` → `a`. The strip is BEFORE the equality-test checks so that
  // `a === "x" || false` strips to `a === "x"` (then equalityTest fires →
  // `STR_x`), matching the mutant's `a === "x"` directly.
  const stripped = stripRedundantBooleanLiteral(test);
  if (stripped !== test) {
    emitDecisionTest(stripped, tokens, constBindings, loopVars, inliningStack, walkFn);
    return;
  }
  const lits = extractEqualityLiterals(test);
  if (lits !== undefined && lits.length > 0) {
    for (const lit of lits) walkFn(lit, tokens, constBindings, loopVars, inliningStack);
    return;
  }
  const et = equalityTest(test);
  if (et !== undefined) {
    walkFn(et.literalNode, tokens, constBindings, loopVars, inliningStack);
    return;
  }
  walkFn(test, tokens, constBindings, loopVars, inliningStack);
}

/** Round 5.3 O3 fix: strip a redundant BooleanLiteral from a LogicalExpression.
 * - `X || false` → `X` (in a boolean context, `if (x || false) === if (x)`).
 * - `false || X` → `X` (short-circuit: `false` is falsy → `||` evaluates to X).
 * - `X && true` → `X` (in a boolean context, `if (x && true) === if (x)`).
 * - `true && X` → `X` (short-circuit: `true` is truthy → `&&` evaluates to X).
 * Does NOT strip `X || true` (→ `true` short-circuit, not `X`) or
 * `X && false` (→ `false` short-circuit, not `X`) — those change the value.
 * Returns the stripped node (or the original if no strip applies). The caller
 * (`emitDecisionTest`) recurses on the stripped node to handle nested strips. */
function stripRedundantBooleanLiteral(test: AstNode): AstNode | undefined {
  if (test.type !== "LogicalExpression") return test;
  const left = astNode(test.left);
  const right = astNode(test.right);
  if (test.operator === "||") {
    if (right?.type === "BooleanLiteral" && right.value === false) return left;
    if (left?.type === "BooleanLiteral" && left.value === false) return right;
  }
  if (test.operator === "&&") {
    if (right?.type === "BooleanLiteral" && right.value === true) return left;
    if (left?.type === "BooleanLiteral" && left.value === true) return right;
  }
  return test;
}

/** Emit a statement body (IfStatement consequent/alternate). For a BlockStatement,
 * strip loop-var updates and emit the remaining statements WITHOUT a wrapper
 * token (symmetric BlockStatement drop — see `walkV2`'s BlockStatement case).
 * For a non-block statement, strip if it's a trailing loop-var update.
 *
 * Round 5.2: takes `walkFn` (higher-order) + optional `letDrop` (Pass 2.5's
 * let-binding drop set). When `letDrop` is provided, the BlockStatement path
 * delegates to `emitStmtList` with `letDrop` (which applies the let-binding
 * drop per statement). When `letDrop` is undefined (Pass 2), no let-binding
 * drop. Behavior-identical to the pre-refactor `walkV2`'s emitBody + the
 * inlined emitBody logic in `walkIterationBody`'s IfStatement case. */
function emitBody(
  node: AstNode | undefined,
  tokens: string[],
  constBindings: Map<string, AstNode>,
  loopVars: Set<string>,
  inliningStack: Set<string>,
  walkFn: WalkFn,
  letDrop?: Set<string>,
): void {
  if (node === undefined) return;
  if (node.type === "BlockStatement") {
    emitStmtList(astNodeArray(node.body), tokens, constBindings, loopVars, inliningStack, walkFn, letDrop);
    return;
  }
  if (!shouldStripLoopUpdate(node, undefined, loopVars)) {
    walkFn(node, tokens, constBindings, loopVars, inliningStack);
  }
}

/** Emit a list of statements (SwitchCase consequent or block body) with loop-var
 * update stripping. Round 5.2: merged the Pass-2 `emitStmtList` + the Pass-2.5
 * `emitIterationBodyStmtList` into ONE helper parameterized by `walkFn` +
 * optional `letDrop`. When `letDrop` is provided (Pass 2.5), a `let nextX = X`
 * declaration in the letDrop set is dropped (the let-binding drop
 * normalization, Pass 2.5 only). When `letDrop` is undefined (Pass 2), no
 * let-binding drop. Behavior-identical to both pre-refactor emitters.
 *
 * EXP362: switch-like statement sort. A run of ≥2 consecutive IfStatements
 * whose tests are all `discriminant === literal` (or `||` chains thereof) on the
 * SAME discriminant expression are SORTED by their literal values before
 * emission. This normalizes statement reordering of mutually-exclusive switch-
 * like if-blocks (the O8 mutant) — the conditions are disjoint (different
 * literals on the same expression), so the order does not affect semantics.
 * Guards (if-blocks with continue/break/return/throw) and non-switch-like tests
 * (e.g. `x > 0`, `x!== "id"`) are NOT sorted — they stay in their original
 * position. The sort is restricted to switch-like groups to avoid FPs on
 * order-dependent if-blocks with data dependencies. */

/** EXP362: serialize an AST node to a canonical structural key (for equality
 * comparison of discriminant expressions). Only serializes fields that affect
 * structural identity (type, name, value, operator, children) — skips source
 * positions (start/end/loc/extra). Used to check that two if-blocks test the
 * SAME discriminant expression (e.g. both test `token.value`). */
function serializeAstKey(node: AstNode | undefined): string {
  if (node === undefined) return "_";
  if (node.type === "Identifier") return `ID:${String(node.name)}`;
  if (node.type === "StringLiteral") return `STR:${String(node.value)}`;
  if (node.type === "NumericLiteral") return `NUM:${String(node.value)}`;
  if (node.type === "BooleanLiteral") return `BOOL:${String(node.value)}`;
  if (node.type === "NullLiteral") return "NULL";
  if (node.type === "ThisExpression") return "THIS";
  if (node.type === "MemberExpression") {
    const obj = serializeAstKey(astNode(node.object));
    const prop = serializeAstKey(astNode(node.property));
    return `ME:${node.computed ? "[]" : "."}${obj}:${prop}`;
  }
  if (node.type === "BinaryExpression") {
    return `BE:${String(node.operator)}:${serializeAstKey(astNode(node.left))}:${serializeAstKey(astNode(node.right))}`;
  }
  if (node.type === "CallExpression") {
    const args = astNodeArray(node.arguments).map(serializeAstKey).join(",");
    return `CALL:${serializeAstKey(astNode(node.callee))}(${args})`;
  }
  // Fallback: type + serialized children (structural)
  const children = astChildren(node).map(serializeAstKey).join(",");
  return `${node.type}(${children})`;
}

/** EXP362: extract the switch-like sort key from an IfStatement test. Returns
 * { discriminantKey, literalKeys } if the test is `discriminant === literal`
 * (or a `||` chain of such tests on the SAME discriminant), where the literals
 * are StringLiteral or NumericLiteral. Returns undefined for non-switch-like
 * tests (`x > 0`, `x!== "id"`, mixed discriminants, non-literal operands).
 * The literalKeys are sorted for a canonical group sort key. */
function extractSwitchLikeSortKey(testNode: AstNode | undefined): { sortKey: string } | undefined {
  const t = astNode(testNode);
  if (t === undefined) return undefined;
  const literalKeys: string[] = [];
  let discriminantKey: string | undefined = undefined;
  function rec(n: AstNode): boolean {
    if (n.type === "LogicalExpression" && n.operator === "||") {
      const l = astNode(n.left);
      const r = astNode(n.right);
      if (l === undefined || r === undefined) return false;
      return rec(l) && rec(r);
    }
    if (n.type === "BinaryExpression" && n.operator === "===") {
      const left = astNode(n.left);
      const right = astNode(n.right);
      let discNode: AstNode | undefined;
      let litNode: AstNode | undefined;
      if (right !== undefined && isLiteralNode(right)) { discNode = left; litNode = right; }
      else if (left !== undefined && isLiteralNode(left)) { discNode = right; litNode = left; }
      else return false;
      if (discNode === undefined || litNode === undefined) return false;
      const key = serializeAstKey(discNode);
      if (discriminantKey === undefined) discriminantKey = key;
      else if (discriminantKey !== key) return false;
      literalKeys.push(serializeAstKey(litNode));
      return true;
    }
    return false;
  }
  if (!rec(t) || discriminantKey === undefined || literalKeys.length === 0) return undefined;
  literalKeys.sort();
  return { sortKey: `${discriminantKey}|${literalKeys.join(",")}` };
}

/** EXP362: true if an IfStatement is a "guard" — its consequent is a single
 * early-exit statement (continue/break/return/throw). Guards must NOT be sorted
 * (their position is semantically significant — they protect subsequent code). */
function isGuardIf(node: AstNode): boolean {
  if (node.type !== "IfStatement") return false;
  const cons = astNode(node.consequent);
  if (cons === undefined) return false;
  let body: AstNode;
  if (cons.type === "BlockStatement") {
    const stmts = astNodeArray(cons.body);
    if (stmts.length !== 1) return false;
    body = stmts[0]!;
  } else {
    body = cons;
  }
  return body.type === "ContinueStatement" || body.type === "BreakStatement" ||
    body.type === "ReturnStatement" || body.type === "ThrowStatement";
}

function emitStmtList(
  stmts: readonly AstNode[],
  tokens: string[],
  constBindings: Map<string, AstNode>,
  loopVars: Set<string>,
  inliningStack: Set<string>,
  walkFn: WalkFn,
  letDrop?: Set<string>,
): void {
  let i = 0;
  while (i < stmts.length) {
    const s = stmts[i]!;
    const next = stmts[i + 1];
    if (shouldStripLoopUpdate(s, next, loopVars)) { i += 1; continue; }
    if (letDrop !== undefined && letDrop.size > 0 && s.type === "VariableDeclaration" && s.kind === "let") {
      const decls = astNodeArray(s.declarations);
      if (decls.length === 1) {
        const id = astNode(decls[0]!.id);
        const init = astNode(decls[0]!.init);
        if (id?.type === "Identifier" && init?.type === "Identifier" && letDrop.has(String(id.name))) {
          i += 1; continue; // dropped — let-binding drop (Pass 2.5 only)
        }
      }
    }
    // EXP362: switch-like statement sort. If this IfStatement starts a run of
    // ≥2 consecutive non-guard IfStatements that are all switch-like (=== tests
    // on the same discriminant), sort the run by each block's literal sort key
    // before emitting. This normalizes O8 (statement reordering of mutually-
    // exclusive switch-like if-blocks). Guards (continue/break/return/throw
    // bodies) and non-switch-like tests stay in their original position.
    if (s.type === "IfStatement" && !isGuardIf(s)) {
      const group = collectSwitchLikeGroup(stmts, i, loopVars, letDrop);
      if (group !== undefined) {
        for (const stmt of group.sortedStmts) walkFn(stmt, tokens, constBindings, loopVars, inliningStack);
        i = group.endIdx;
        continue;
      }
    }
    // EXP390 Fix 4 (EXP180): EXTRACT normalization — scan ahead for a run of
    // ≥2 consecutive `let/var X = obj.prop` declarations (same obj) → canonical
    // `EXTRACT <obj> <key1> <value1>...`. Pass 2 only (letDrop === undefined);
    // Pass 2.5 iteration bodies are unlikely to have destructuring runs and the
    // letDrop interaction is untested. See `propertyAccessRunAt` docs.
    if (letDrop === undefined) {
      const run = propertyAccessRunAt(stmts, i);
      if (run !== undefined) {
        emitExtractTokens(run.objNode, run.props, tokens, constBindings, loopVars, inliningStack, walkFn);
        i = run.endIdx + 1; // skip PAST the last declaration in the run (endIdx is inclusive)
        continue;
      }
    }
    walkFn(s, tokens, constBindings, loopVars, inliningStack);
    i += 1;
  }
}

/** EXP362: collect a run of ≥2 consecutive non-guard IfStatements (after
 * strip/letDrop filtering) that are all switch-like (=== tests on the same
 * discriminant). Returns the SORTED statements + the end index, or undefined
 * if no switch-like group of ≥2 is found. Guards (continue/break/return/throw
 * bodies) break the group — they stay in position. Non-IfStatements also break
 * the group. */
function collectSwitchLikeGroup(
  stmts: readonly AstNode[],
  startIdx: number,
  loopVars: Set<string>,
  letDrop: Set<string> | undefined,
): { sortedStmts: AstNode[]; endIdx: number } | undefined {
  // Collect consecutive non-guard IfStatements (after strip/letDrop filtering).
  const ifStmts: AstNode[] = [];
  let idx = startIdx;
  while (idx < stmts.length) {
    const s = stmts[idx]!;
    // Skip stripped loop updates + dropped let-bindings (they don't break the
    // group — they're invisible to the token stream).
    const next = stmts[idx + 1];
    if (shouldStripLoopUpdate(s, next, loopVars)) { idx += 1; continue; }
    if (letDrop !== undefined && letDrop.size > 0 && s.type === "VariableDeclaration" && s.kind === "let") {
      const decls = astNodeArray(s.declarations);
      if (decls.length === 1) {
        const id = astNode(decls[0]!.id);
        const init = astNode(decls[0]!.init);
        if (id?.type === "Identifier" && init?.type === "Identifier" && letDrop.has(String(id.name))) {
          idx += 1; continue;
        }
      }
    }
    if (s.type !== "IfStatement" || isGuardIf(s)) break;
    ifStmts.push(s);
    idx += 1;
  }
  if (ifStmts.length < 2) return undefined;
  // Check ALL are switch-like on the SAME discriminant.
  const keys = ifStmts.map((s) => extractSwitchLikeSortKey(astNode(s.test)));
  if (keys.some((k) => k === undefined)) return undefined;
  // All must share the same discriminant (compare discriminant portion only).
  const firstDisc = keys[0]!.sortKey.split("|")[0];
  if (!keys.every((k) => k!.sortKey.split("|")[0] === firstDisc)) return undefined;
  // Sort by the literal sort key (the full sortKey includes discriminant|literals).
  const sorted = [...ifStmts].sort((a, b) => {
    const ka = extractSwitchLikeSortKey(astNode(a.test))!.sortKey;
    const kb = extractSwitchLikeSortKey(astNode(b.test))!.sortKey;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return { sortedStmts: sorted, endIdx: idx };
}

/** Round 4 N3 fix: emit a ConditionalExpression as a DECIDE token sequence with
 * branch distribution. Normalizes `x? a: b` to the same token stream as the
 * equivalent if-else, by distributing the outer context (return, assignment,
 * variable declaration) into each branch via the `branchEmitter` callback.
 *
 * Distribution cases (the `branchEmitter` wraps each branch value with the outer context):
 * - `return x? a: b` → `DECIDE <test> ReturnStatement <a> ReturnStatement <b>`
 * (matches `if (x) return a; else return b;` → `DECIDE <test> ReturnStatement <a> ReturnStatement <b>`).
 * - `grade = x? a: b` → `DECIDE <test> ExpressionStatement AssignmentExpression <grade> <a> ExpressionStatement AssignmentExpression <grade> <b>`
 * (matches `if (x) grade = a; else grade = b;`).
 * - `const x = cond? a: b` → `VariableDeclaration <x> DECIDE <test> ExpressionStatement AssignmentExpression <x> <a>... ExpressionStatement AssignmentExpression <x> <b>`
 * (matches `let x; if (cond) x = a; else x = b;`).
 * - standalone `x? a: b` → `DECIDE <test> <a> <b>` (no equivalent if-else in expression
 * position — you can't write `foo(if (x) a; else b;)` — so no FP risk).
 *
 * Recursively handles NESTED ternaries in the cons/alt position: when the cons (or alt)
 * is itself a ConditionalExpression, recurse (distribute the `branchEmitter` into the
 * nested ternary's branches). This matches the if-else chain form:
 * `x? a: y? b: c` → `DECIDE <x> <wrap(a)> DECIDE <y> <wrap(b)> <wrap(c)>`
 * (matches `if (x)...a...; else if (y)...b...; else...c...;`).
 *
 * Sources: babel-plugin-transform-ternary-to-if-else (OpenGG, MIT, commit 1441ca53,
 * https://github.com/OpenGG/babel-plugin-transform-ternary-to-if-else) — confirmed the
 * ternary↔if-else equivalence via IIFE wrapping. Adapted at the token level (no
 * @babel/traverse — the detector uses a hand-rolled walker). No code extracted — only
 * the algorithmic approach confirmed. The token-level distribution is original.
 *
 * Automata theory: the ternary + if-else both reduce to the same DECIDE state in the
 * CFG (control-flow graph). The distribution is a CFG normalization that makes both
 * forms produce the same token stream. */
function emitTernaryDecision(
  node: AstNode,
  tokens: string[],
  constBindings: Map<string, AstNode>,
  currentLoopVars: Set<string>,
  inliningStack: Set<string>,
  branchEmitter: (branch: AstNode, tokens: string[], cb: Map<string, AstNode>, lv: Set<string>, is: Set<string>) => void,
): void {
  if (node.type !== "ConditionalExpression") return;
  const test = astNode(node.test);
  const cons = astNode(node.consequent);
  const alt = astNode(node.alternate);
  if (test === undefined || cons === undefined || alt === undefined) return;
  tokens.push("DECIDE");
  // Round 5.2: emitDecisionTest now takes walkFn. The ternary→DECIDE
  // normalization is Pass 2 only (walkV2); walkIterationBody has NO ternary case
  // (intentional — avoids T4a/A1 regression). So walkFn = walkV2 here.
  emitDecisionTest(test, tokens, constBindings, currentLoopVars, inliningStack, walkV2);
  // Emit the consequent: if it's a nested ConditionalExpression, recurse (distribute
  // the branchEmitter into the nested branches). Otherwise, wrap the branch value.
  if (cons.type === "ConditionalExpression") {
    emitTernaryDecision(cons, tokens, constBindings, currentLoopVars, inliningStack, branchEmitter);
  } else {
    branchEmitter(cons, tokens, constBindings, currentLoopVars, inliningStack);
  }
  // Emit the alternate: same recursion as the consequent.
  if (alt.type === "ConditionalExpression") {
    emitTernaryDecision(alt, tokens, constBindings, currentLoopVars, inliningStack, branchEmitter);
  } else {
    branchEmitter(alt, tokens, constBindings, currentLoopVars, inliningStack);
  }
}

// ============================================================================
// Round 5.2 — shared walker helpers (DRY refactor).
// These helpers parameterize the shared normalization logic by `walkFn` (the
// higher-order strategy parameter). `walkV2` (Pass 2) calls them with
// `walkFn = walkV2`; `walkIterationBody` (Pass 2.5) calls them with a thunk
// that closes over `letDrop`. Each normalization has ONE owner (the helper),
// eliminating the drift risk where a change to one walker silently diverges
// the other (the maintenance risk documented in the gh-aw #37979 linter-helper
// consolidation — see research/round5-2-dry-refactor/gh-aw-issue-37979.md).
//
// Behavior-neutrality: each helper is byte-for-byte equivalent to the original
// walker case (modulo the walkFn substitution). Verified via the 15-config
// git prefix-dance FP stress test (probes/round5-2-fp-stress.mjs).
// ============================================================================

/** True if `node` is a `const` VariableDeclaration whose every declarator is a
 * bound Identifier (in `constBindings`) — these are skipped (inlined at use
 * sites). Shared by `walkV2`'s + `walkIterationBody`'s VariableDeclaration
 * cases (Round 5.2: was duplicated in both walkers). */
function shouldSkipConstDecl(node: AstNode, constBindings: Map<string, AstNode>): boolean {
  if (node.kind !== "const") return false;
  const decls = astNodeArray(node.declarations);
  return decls.length > 0 && decls.every((d) => {
    const id = astNode(d.id);
    const init = astNode(d.init);
    return id?.type === "Identifier" && init !== undefined && constBindings.has(String(id.name));
  });
}

// ============================================================================
// EXP390 Fix 4 (EXP180): EXTRACT normalization — destructuring ↔ property-access.
// `let { a, b } = obj` (ObjectPattern) and `let a = obj.a; let b = obj.b`
// (MemberExpression access) both extract properties a, b from obj. Normalize
// both to `EXTRACT <obj> <key1> <value1> [<default1>] <key2> <value2>...` so
// they produce the same shingles. Constraints: `let`/`var` only (NOT `const` —
// const is inlined at use sites); ≥2 properties/declarations (single keeps
// current tokens); simple ObjectProperty with Identifier key (not computed,
// not StringLiteral key) + Identifier value OR AssignmentPattern value
// (default); NOT RestElement/ObjectMethod/nested patterns; defaults via `??`
// only (NOT `||`, NOT ternary); Pass 2 only. Sources: EXP180 (experiments/
// v6-destructuring-access, commit 161f1e5). Math: homomorphism (destructuring
// is a homomorphism from object to variables — the EXTRACT token captures the
// homomorphism's structure).
// ============================================================================

interface ExtractProperty {
  readonly keyNode: AstNode;
  readonly valueNode: AstNode;
  readonly defaultNode: AstNode | undefined;
}

function emitExtractTokens(
  objNode: AstNode,
  props: readonly ExtractProperty[],
  tokens: string[],
  constBindings: Map<string, AstNode>,
  loopVars: Set<string>,
  inliningStack: Set<string>,
  walkFn: WalkFn,
): void {
  // EXP390 Fix 4b: remove the destructured bindings from constBindings BEFORE
  // walking the props so the property keys (which may have the same NAME as
  // the local var, e.g. `const a = p.a` — key `a` and local `a` are both "a")
  // are NOT inlined. The EXTRACT token captures the extraction; use sites emit
  // plain `ID`. This makes `const { a, b } = p; return a + b` ↔
  // `const a = p.a; const b = p.b; return a + b` produce the same token stream.
  for (const p of props) {
    if (p.valueNode.type === "Identifier") {
      constBindings.delete(String(p.valueNode.name));
    }
  }
  tokens.push("EXTRACT");
  walkFn(objNode, tokens, constBindings, loopVars, inliningStack);
  for (const p of props) {
    walkFn(p.keyNode, tokens, constBindings, loopVars, inliningStack);
    walkFn(p.valueNode, tokens, constBindings, loopVars, inliningStack);
    if (p.defaultNode !== undefined) {
      walkFn(p.defaultNode, tokens, constBindings, loopVars, inliningStack);
    }
  }
}

function emitDestructuringExtract(
  node: AstNode,
  tokens: string[],
  constBindings: Map<string, AstNode>,
  loopVars: Set<string>,
  inliningStack: Set<string>,
  walkFn: WalkFn,
): boolean {
  if (node.type !== "VariableDeclaration") return false;
  // EXP390 Fix 4b: extend EXTRACT to fire for `const` too (not just let/var).
  // `const { a, b } = p` ↔ `const a = p.a; const b = p.b` — both extract
  // properties a, b from p. For `const`, the destructured bindings are removed
  // from `constBindings` (by the caller, `normalizeTokensV2`) so they're NOT
  // inlined at use sites — the EXTRACT token captures the extraction, and use
  // sites emit plain `ID`. This makes `const { a, b } = p; return a + b` ↔
  // `const a = p.a; const b = p.b; return a + b` produce the same token stream
  // (`EXTRACT p a a b b ReturnStatement BinaryExpression_+ ID ID`).
  if (node.kind !== "let" && node.kind !== "var" && node.kind !== "const") return false;
  const decls = astNodeArray(node.declarations);
  if (decls.length !== 1) return false;
  const id = astNode(decls[0]!.id);
  const init = astNode(decls[0]!.init);
  if (id === undefined || id.type !== "ObjectPattern") return false;
  if (init === undefined || init.type !== "Identifier") return false;
  const propNodes = astNodeArray(id.properties);
  if (propNodes.length < 2) return false;
  const props: ExtractProperty[] = [];
  for (const pn of propNodes) {
    if (pn.type !== "ObjectProperty") return false;
    if (pn.computed === true) return false;
    const keyNode = astNode(pn.key);
    if (keyNode === undefined || keyNode.type !== "Identifier") return false;
    const valueNode = astNode(pn.value);
    if (valueNode === undefined) return false;
    if (valueNode.type === "Identifier") {
      props.push({ keyNode, valueNode, defaultNode: undefined });
    } else if (valueNode.type === "AssignmentPattern") {
      const left = astNode(valueNode.left);
      const right = astNode(valueNode.right);
      if (left === undefined || left.type !== "Identifier") return false;
      if (right === undefined) return false;
      props.push({ keyNode, valueNode: left, defaultNode: right });
    } else {
      return false;
    }
  }
  emitExtractTokens(init, props, tokens, constBindings, loopVars, inliningStack, walkFn);
  return true;
}

function matchPropertyAccessInit(init: AstNode): { objNode: AstNode; propNode: AstNode; defaultNode?: AstNode } | undefined {
  if (init.type === "MemberExpression") {
    if (init.computed === true) return undefined;
    const obj = astNode(init.object);
    const prop = astNode(init.property);
    if (obj === undefined || obj.type !== "Identifier") return undefined;
    if (prop === undefined || prop.type !== "Identifier") return undefined;
    return { objNode: obj, propNode: prop };
  }
  if ((init.type === "BinaryExpression" || init.type === "LogicalExpression") && init.operator === "??") {
    const left = astNode(init.left);
    if (left === undefined || left.type !== "MemberExpression") return undefined;
    if (left.computed === true) return undefined;
    const obj = astNode(left.object);
    const prop = astNode(left.property);
    if (obj === undefined || obj.type !== "Identifier") return undefined;
    if (prop === undefined || prop.type !== "Identifier") return undefined;
    const right = astNode(init.right);
    if (right === undefined) return undefined;
    return { objNode: obj, propNode: prop, defaultNode: right };
  }
  return undefined;
}

function propertyAccessRunAt(stmts: readonly AstNode[], startIdx: number): { endIdx: number; objNode: AstNode; props: ExtractProperty[] } | undefined {
  const start = stmts[startIdx];
  if (start === undefined || start.type !== "VariableDeclaration") return undefined;
  // EXP390 Fix 4b: allow `const` runs too (not just let/var) — `const a = p.a; const b = p.b`
  // is the property-access form that should match `const { a, b } = p`.
  if (start.kind !== "let" && start.kind !== "var" && start.kind !== "const") return undefined;
  const startDecls = astNodeArray(start.declarations);
  if (startDecls.length !== 1) return undefined;
  const startId = astNode(startDecls[0]!.id);
  const startInit = astNode(startDecls[0]!.init);
  if (startId === undefined || startId.type !== "Identifier") return undefined;
  if (startInit === undefined) return undefined;
  const startMatch = matchPropertyAccessInit(startInit);
  if (startMatch === undefined) return undefined;
  const props: ExtractProperty[] = [
    { keyNode: startMatch.propNode, valueNode: startId, defaultNode: startMatch.defaultNode },
  ];
  let endIdx = startIdx;
  for (let i = startIdx + 1; i < stmts.length; i += 1) {
    const s = stmts[i]!;
    if (s.type !== "VariableDeclaration") break;
    if (s.kind !== start.kind) break;
    const decls = astNodeArray(s.declarations);
    if (decls.length !== 1) break;
    const id = astNode(decls[0]!.id);
    const init = astNode(decls[0]!.init);
    if (id === undefined || id.type !== "Identifier") break;
    if (init === undefined) break;
    const m = matchPropertyAccessInit(init);
    if (m === undefined) break;
    if (String(m.objNode.name) !== String(startMatch.objNode.name)) break;
    props.push({ keyNode: m.propNode, valueNode: id, defaultNode: m.defaultNode });
    endIdx = i;
  }
  if (endIdx === startIdx) return undefined;
  return { endIdx, objNode: startMatch.objNode, props };
}

// ============================================================================
// EXP390 Fix 2 (EXP178): TRY_CATCH canonical normalization — try-catch ↔
// promise+.catch. Three forms canonicalize to
// `TRY_CATCH <success-body with __VAL__> <handler-body with __ERR__> END_TRY_CATCH`
// 1. `try { <body> } catch (e) { <handler> }` — TryStatement + CatchClause
// (no `finally`); AwaitExpressions in the try block emit `__VAL__`.
// 2. `<expr>.then(cb).catch(handlerCb)` — chained.then.catch; the.then cb
// param emits `__VAL__`, the.catch cb param emits `__ERR__`.
// 3. `<expr>.catch(handlerCb)` — single.catch; success body is a single
// `__VAL__` placeholder (the whole call is the "awaited value").
// Constraints: form 1 requires Identifier catch param (no destructuring); forms
// 2/3 require single-param ArrowFunction/FunctionExpression with Identifier
// param; form 2 requires single-param.then cb. Sources: EXP178 (experiments/
// v6-try-catch-promise, commit 9dd9ecd); babel-plugin-transform-async-to-promises
// (rpetrich, MIT) — `try { await f } catch (e) { h(e) }` ↔
// `f.then(undefined, e => h(e))`. Math: algebraic effects (Plotkin-Pretnar 2009)
// — the error handler is an effect, the success body is the continuation.
// ============================================================================

function detectTryCatchTryStatement(node: AstNode): {
  successBody: AstNode;
  handlerBody: AstNode;
  errName: string;
} | undefined {
  if (node.type !== "TryStatement") return undefined;
  const finalizer = astNode((node as { finalizer?: unknown }).finalizer);
  if (finalizer !== undefined) return undefined;
  const handler = astNode((node as { handler?: unknown }).handler);
  if (handler === undefined || handler.type !== "CatchClause") return undefined;
  const handlerParam = astNode((handler as { param?: unknown }).param);
  if (handlerParam === undefined || handlerParam.type !== "Identifier") return undefined;
  const handlerBody = astNode((handler as { body?: unknown }).body);
  if (handlerBody === undefined || handlerBody.type !== "BlockStatement") return undefined;
  const tryBlock = astNode((node as { block?: unknown }).block);
  if (tryBlock === undefined || tryBlock.type !== "BlockStatement") return undefined;
  return {
    successBody: tryBlock,
    handlerBody,
    errName: String(handlerParam.name),
  };
}

function unwrapAwaitCall(node: AstNode | undefined): AstNode | undefined {
  if (node === undefined) return undefined;
  if (node.type === "AwaitExpression") {
    return astNode((node as { argument?: unknown }).argument);
  }
  return node;
}

function detectPromiseCatchCall(node: AstNode): {
  successBody: AstNode | undefined;
  handlerBody: AstNode;
  errName: string;
  valName: string | undefined;
} | undefined {
  if (node.type !== "CallExpression") return undefined;
  const callee = astNode(node.callee);
  if (callee === undefined || callee.type !== "MemberExpression") return undefined;
  const calleeProp = astNode(callee.property);
  if (calleeProp === undefined || calleeProp.type !== "Identifier" || String(calleeProp.name) !== "catch") return undefined;
  const catchArgs = astNodeArray(node.arguments);
  if (catchArgs.length !== 1) return undefined;
  const handlerCb = catchArgs[0];
  if (handlerCb === undefined) return undefined;
  if (handlerCb.type !== "ArrowFunctionExpression" && handlerCb.type !== "FunctionExpression") return undefined;
  const handlerCbParams = astNodeArray(handlerCb.params);
  // EXP390 Fix 2b: allow 0-param handlers (`.catch(() => fallback)`) — the
  // error is ignored. Use a synthetic errName that can't match any real
  // identifier (so the handler body's identifier references are unaffected).
  // Also allow 1-param handlers (`.catch(e =>...)`) where `e` is the error.
  let errName = "__IGNORED_ERR__";
  if (handlerCbParams.length === 1) {
    const handlerParam = astNode(handlerCbParams[0]);
    if (handlerParam === undefined || handlerParam.type !== "Identifier") return undefined;
    errName = String(handlerParam.name);
  } else if (handlerCbParams.length !== 0) {
    return undefined;
  }
  const handlerBody = astNode(handlerCb.body);
  if (handlerBody === undefined) return undefined;
  const innerNode = astNode(callee.object);
  if (innerNode === undefined) return undefined;
  // EXP390 Fix 2d: form 2 (.then(cb).catch(h)) — only fire if the inner is a
  // `.then` call. If the inner is ANY other expression (regular call like
  // `fetch(url)`, a member access, an identifier, etc.), fall through to form 3
  // (single.catch, no.then). The previous code rejected form 3 when the inner
  // was a non-.then CallExpression, which broke `fetch(url).catch(h)`.
  if (innerNode.type === "CallExpression") {
    const innerCallee = astNode(innerNode.callee);
    if (innerCallee?.type === "MemberExpression") {
      const innerCalleeProp = astNode(innerCallee.property);
      if (innerCalleeProp?.type === "Identifier" && String(innerCalleeProp.name) === "then") {
        const thenArgs = astNodeArray(innerNode.arguments);
        if (thenArgs.length === 1) {
          const thenCb = thenArgs[0];
          if (thenCb !== undefined && (thenCb.type === "ArrowFunctionExpression" || thenCb.type === "FunctionExpression")) {
            const thenCbParams = astNodeArray(thenCb.params);
            // EXP390 Fix 2b: allow 0-param.then cb too (`.then(() =>...)`).
            let valName: string | undefined;
            if (thenCbParams.length === 1) {
              const valParam = astNode(thenCbParams[0]);
              if (valParam !== undefined && valParam.type === "Identifier") {
                valName = String(valParam.name);
              }
            } else if (thenCbParams.length !== 0) {
              valName = undefined; // fall through to form 3
            }
            const thenBody = astNode(thenCb.body);
            if (thenBody !== undefined && valName !== undefined) {
              return {
                successBody: thenBody,
                handlerBody,
                errName,
                valName: valName ?? undefined,
              };
            }
            if (thenBody !== undefined && thenCbParams.length === 0) {
              return {
                successBody: thenBody,
                handlerBody,
                errName,
                valName: undefined,
              };
            }
          }
        }
      }
    }
    // inner is a CallExpression but NOT a `.then(cb)` call → form 3.
  }
  return {
    successBody: undefined,
    handlerBody,
    errName,
    valName: undefined,
  };
}

function emitTryCatchEnvelope(
  successBody: AstNode | undefined,
  handlerBody: AstNode,
  errName: string,
  valName: string | undefined,
  tokens: string[],
  constBindings: Map<string, AstNode>,
  currentLoopVars: Set<string>,
  inliningStack: Set<string>,
): void {
  tokens.push("TRY_CATCH");
  const newCb = new Map(constBindings);
  newCb.delete(errName);
  if (valName !== undefined) newCb.delete(valName);
  if (valName !== undefined) valNameStack.push(valName);
  const isTryCatchForm = valName === undefined;
  if (isTryCatchForm) tryCatchAwaitDepth += 1;
  try {
    if (successBody === undefined) {
      // EXP390 Fix 2c: form 3 (single.catch, no.then) — the success body
      // is the whole awaited value. Push `ReturnStatement __VAL__` to match the
      // try-catch form's `return await <expr>` → `ReturnStatement __VAL__`
      // (the AwaitExpression inside the try block emits `__VAL__`).
      tokens.push("ReturnStatement");
      tokens.push("__VAL__");
    } else if (successBody.type === "BlockStatement") {
      emitStmtList(astNodeArray(successBody.body), tokens, newCb, currentLoopVars, inliningStack, walkV2);
    } else {
      // EXP390 Fix 2c:.then cb expression body (e.g. `r => r` or `r => f(r)`)
      // — push `ReturnStatement` to match the try-catch block-body form's
      // `return <expr>` (η-expansion, same as Fix 5b for arrow bodies).
      tokens.push("ReturnStatement");
      walkV2(successBody, tokens, newCb, currentLoopVars, inliningStack);
    }
  } finally {
    if (valName !== undefined) valNameStack.pop();
    if (isTryCatchForm) tryCatchAwaitDepth -= 1;
  }
  errNameStack.push(errName);
  try {
    if (handlerBody.type === "BlockStatement") {
      emitStmtList(astNodeArray(handlerBody.body), tokens, newCb, currentLoopVars, inliningStack, walkV2);
    } else {
      walkV2(handlerBody, tokens, newCb, currentLoopVars, inliningStack);
    }
  } finally {
    errNameStack.pop();
  }
  tokens.push("END_TRY_CATCH");
}

// ============================================================================
// EXP390 Fix 3 (EXP179): MAP normalization — Map ↔ plain object. Canonicalizes
// - `X.set(k, v)` (CallExpression) → `MAP_SET <k> <v>`
// - `X.get(k)` (CallExpression) → `MAP_GET <k>`
// - `X[k] = v` (AssignmentExpression computed) → `MAP_SET <k> <v>`
// - `X[k]` (MemberExpression computed, read) → `MAP_GET <k>`
// for map-like bindings X (`new Map` or `{}` used with computed access).
// The decl `const/let X = new Map` / `const/let X = {}` is skipped (the MAP
// normalization intercepts at use sites). Sources: EXP179 (experiments/
// v6-map-object, commit a3eb036). Math: isomorphism (Map and object are
// isomorphic for string keys — the MAP token captures the isomorphism).
// ============================================================================

function collectMapBindings(fnNode: AstNode): Set<string> {
  const bindings = new Set<string>();
  const body = astNode(fnNode.body);
  if (body === undefined) return bindings;
  // EXP390 Fix 3b: include NON-EMPTY object literals as candidates too (not
  // just `{}`). `const m = { a: 1, b: 2, c: 3 }` followed by `m[key]` is the
  // object-literal-build form ↔ `new Map` + `.set` — both are map-like.
  // Renamed `emptyObjectCandidates` → `objectCandidates` (now includes both).
  const objectCandidates = new Set<string>();
  walk(body, (n) => {
    if (n.type === "VariableDeclaration" && (n.kind === "const" || n.kind === "let")) {
      const decls = astNodeArray(n.declarations);
      if (decls.length === 1) {
        const id = astNode(decls[0]!.id);
        const init = astNode(decls[0]!.init);
        if (id?.type === "Identifier") {
          if (init?.type === "NewExpression") {
            const callee = astNode(init.callee);
            if (callee?.type === "Identifier" && String(callee.name) === "Map") {
              bindings.add(String(id.name));
            }
          }
          if (init?.type === "ObjectExpression") {
            // Both empty `{}` and non-empty `{ k: v,... }` are candidates.
            // Only require all properties to be simple `key: value` (no
            // computed/method/spread) — complex properties mean it's a
            // regular object, not a map.
            const props = astNodeArray(init.properties);
            let simple = true;
            for (const p of props) {
              if (p.type !== "ObjectProperty" || p.computed === true) { simple = false; break; }
            }
            if (simple) objectCandidates.add(String(id.name));
          }
        }
      }
    }
  });
  if (objectCandidates.size > 0) {
    walk(body, (n) => {
      if (n.type === "AssignmentExpression" && n.operator === "=") {
        const left = astNode(n.left);
        if (left?.type === "MemberExpression" && left.computed) {
          const obj = astNode(left.object);
          if (obj?.type === "Identifier" && objectCandidates.has(String(obj.name))) {
            bindings.add(String(obj.name));
          }
        }
      }
      if (n.type === "MemberExpression" && n.computed) {
        const obj = astNode(n.object);
        if (obj?.type === "Identifier" && objectCandidates.has(String(obj.name))) {
          bindings.add(String(obj.name));
        }
      }
    });
  }
  return bindings;
}

function detectMapCall(node: AstNode): { op: "set"; key: AstNode; value: AstNode } | { op: "get"; key: AstNode } | undefined {
  if (node.type !== "CallExpression") return undefined;
  const callee = astNode(node.callee);
  if (callee === undefined || callee.type !== "MemberExpression") return undefined;
  if (callee.computed) return undefined;
  const obj = astNode(callee.object);
  const prop = astNode(callee.property);
  if (obj === undefined || obj.type !== "Identifier") return undefined;
  if (prop === undefined || prop.type !== "Identifier") return undefined;
  if (!MAP_BINDINGS.has(String(obj.name))) return undefined;
  const args = astNodeArray(node.arguments);
  const methodName = String(prop.name);
  if (methodName === "set" && args.length === 2) {
    return { op: "set", key: args[0]!, value: args[1]! };
  }
  if (methodName === "get" && args.length === 1) {
    return { op: "get", key: args[0]! };
  }
  return undefined;
}

function detectMapMemberAssign(node: AstNode): { key: AstNode; value: AstNode } | undefined {
  if (node.type !== "AssignmentExpression" || node.operator !== "=") return undefined;
  const left = astNode(node.left);
  if (left === undefined || left.type !== "MemberExpression" || !left.computed) return undefined;
  const obj = astNode(left.object);
  if (obj === undefined || obj.type !== "Identifier") return undefined;
  if (!MAP_BINDINGS.has(String(obj.name))) return undefined;
  const key = astNode(left.property);
  const value = astNode(node.right);
  if (key === undefined || value === undefined) return undefined;
  return { key, value };
}

function detectMapMemberRead(node: AstNode): { key: AstNode } | undefined {
  if (node.type !== "MemberExpression" || !node.computed) return undefined;
  const obj = astNode(node.object);
  if (obj === undefined || obj.type !== "Identifier") return undefined;
  if (!MAP_BINDINGS.has(String(obj.name))) return undefined;
  const key = astNode(node.property);
  if (key === undefined) return undefined;
  return { key };
}

/** EXP390 Fix 3c: emit a MAP key token, normalizing non-computed Identifier
 * keys (object literal property names like `{ a: 1 }`) to `STR_<name>` so they
 * match the StringLiteral key form (`m.set("a", 1)` → `STR_a`). Variable-
 * reference keys (computed `[k]` or `m.set(k,...)`) are walked normally
 * (emit `ID`). Math: isomorphism — the object property name `a` and the string
 * literal `"a"` are isomorphic as map keys (ECMAScript: non-computed property
 * names ARE string keys). */
function emitMapKey(
  keyNode: AstNode,
  tokens: string[],
  constBindings: Map<string, AstNode>,
  currentLoopVars: Set<string>,
  inliningStack: Set<string>,
): void {
  if (keyNode.type === "Identifier") {
    // Non-computed property name → STR_<name> (matches StringLiteral "a" → STR_a).
    emitStringLiteralValueToken(String(keyNode.name), tokens);
    return;
  }
  // StringLiteral, computed keys, etc. — walk normally.
  walkV2(keyNode, tokens, constBindings, currentLoopVars, inliningStack);
}

// ============================================================================
// EXP390 Fix 1 (EXP177): SEQUENCE canonical normalization — generator ↔ array.
// Three forms canonicalize to `SEQUENCE walk(v1) walk(v2)...`:
// 1. Generator: `function* g { yield v1; yield v2;... [return R]; }`
// 2. Array literal: `function f { return [v1, v2,...]; }`
// 3. Array push: `function f { let a = []; a.push(v1);...; return a; }`
// Only fires when the body has NO control flow (no if/while/for/try) and no
// opaque sub-sequences (yield*,...spread). Function-header tokens are dropped
// when SEQUENCE fires. Sources: EXP177 (experiments/v6-generator-array,
// commit d79aada). Math: fixed-point theory (the generator's fixed point is
// the yielded sequence; consuming the generator via spread produces the same
// array as the literal/push-build form).
// ============================================================================

function tryEmitSequenceCanonical(
  fnNode: AstNode,
  tokens: string[],
  constBindings: Map<string, AstNode>,
  currentLoopVars: Set<string>,
  inliningStack: Set<string>,
): boolean {
  const body = astNode(fnNode.body);
  if (body === undefined || body.type !== "BlockStatement") return false;
  const stmts = astNodeArray(body.body);

  // Form 1: generator with pure-yield body (optionally one trailing return).
  if ((fnNode as { generator?: unknown }).generator === true) {
    let trailingReturnIdx = -1;
    for (let i = 0; i < stmts.length; i += 1) {
      const s = stmts[i]!;
      if (s.type === "ExpressionStatement") {
        const expr = astNode(s.expression);
        if (expr === undefined || expr.type !== "YieldExpression") return false;
        if ((expr as { delegate?: unknown }).delegate === true) return false; // `yield*` — opaque sub-sequence
      } else if (s.type === "ReturnStatement") {
        if (trailingReturnIdx !== -1) return false;
        trailingReturnIdx = i;
        if (i !== stmts.length - 1) return false;
      } else {
        return false;
      }
    }
    tokens.push("SEQUENCE");
    for (const s of stmts) {
      if (s.type !== "ExpressionStatement") continue;
      const expr = astNode(s.expression)!;
      const arg = astNode((expr as { argument?: unknown }).argument);
      if (arg !== undefined) walkV2(arg, tokens, constBindings, currentLoopVars, inliningStack);
      else tokens.push("UNDEFINED"); // bare `yield;` ≡ `yield undefined`
    }
    return true;
  }

  // Form 2: array literal return — `function f { return [v1, v2,...]; }`.
  if (stmts.length === 1 && stmts[0]!.type === "ReturnStatement") {
    const retArg = astNode((stmts[0]! as { argument?: unknown }).argument);
    if (retArg !== undefined && retArg.type === "ArrayExpression") {
      const rawElements = (retArg as { elements?: unknown }).elements;
      if (!Array.isArray(rawElements)) return false;
      for (const el of rawElements) {
        if (el === null || el === undefined) return false; // hole
        if (typeof el === "object" && (el as { type?: string }).type === "SpreadElement") return false;
      }
      tokens.push("SEQUENCE");
      for (const el of astNodeArray(rawElements)) {
        walkV2(el, tokens, constBindings, currentLoopVars, inliningStack);
      }
      return true;
    }
  }

  // Form 3: array push-build — `let a = []; a.push(v1);...; return a;`.
  if (stmts.length >= 2) {
    const first = stmts[0]!;
    const last = stmts[stmts.length - 1]!;
    if (first.type === "VariableDeclaration" && last.type === "ReturnStatement") {
      const decls = astNodeArray(first.declarations);
      if (decls.length === 1) {
        const id = astNode(decls[0]!.id);
        const init = astNode(decls[0]!.init);
        if (id?.type === "Identifier" && init?.type === "ArrayExpression" && astNodeArray(init.elements).length === 0) {
          const arrName = String(id.name);
          const retArg = astNode((last as { argument?: unknown }).argument);
          if (retArg?.type === "Identifier" && String(retArg.name) === arrName) {
            const values: AstNode[] = [];
            let allPush = true;
            for (let i = 1; i < stmts.length - 1; i += 1) {
              const s = stmts[i]!;
              if (s.type !== "ExpressionStatement") { allPush = false; break; }
              const expr = astNode((s as { expression?: unknown }).expression);
              if (expr?.type !== "CallExpression") { allPush = false; break; }
              const callee = astNode((expr as { callee?: unknown }).callee);
              if (callee?.type !== "MemberExpression") { allPush = false; break; }
              const obj = astNode((callee as { object?: unknown }).object);
              const prop = astNode((callee as { property?: unknown }).property);
              if (obj?.type !== "Identifier" || String(obj.name) !== arrName) { allPush = false; break; }
              if (prop?.type !== "Identifier" || String(prop.name) !== "push") { allPush = false; break; }
              const args = astNodeArray((expr as { arguments?: unknown }).arguments);
              if (args.length !== 1) { allPush = false; break; }
              values.push(args[0]!);
            }
            if (allPush) {
              tokens.push("SEQUENCE");
              for (const v of values) {
                walkV2(v, tokens, constBindings, currentLoopVars, inliningStack);
              }
              return true;
            }
          }
        }
      }
    }
  }

  return false;
}

/** Emit an Identifier / PrivateName token. Shared by `walkV2`'s +
 * `walkIterationBody`'s Identifier cases (Round 5.2: was duplicated, ~15 lines
 * each, IDENTICAL modulo walkFn). Handles const inlining (with cycle guard via
 * `inliningStack`) + `ID_NUM` for known-numeric Identifiers (Round 4 Fix 2 /
 * Round 5.1 — `KNOWN_NUMERIC` is the module-level set populated by
 * `collectKnownNumeric`). */
function emitIdentifierToken(
  name: string,
  tokens: string[],
  constBindings: Map<string, AstNode>,
  currentLoopVars: Set<string>,
  inliningStack: Set<string>,
  walkFn: WalkFn,
): void {
  // EXP126: if this identifier is the loop element of an enclosing ITERATE_ARR
  // normalization, emit the canonical `__ELEM__` placeholder BEFORE const-inlining
  // or ID_NUM. The element is the loop variable, not a const binding (even if it
  // shares a name with one — the loop body's `v` refers to the element, not the
  // outer const). This distinguishes the element from other `ID` tokens in the
  // body, making the canonical form more precise than EXP28's all-`ID` emission.
  if (elemNameStack.length > 0 && elemNameStack.includes(name)) {
    tokens.push("__ELEM__");
    return;
  }
  // EXP390 Fix 2 (EXP178): TRY_CATCH canonical normalization. If this identifier
  // is the error variable of an enclosing try-catch /.catch handler, emit
  // `__ERR__`. If it is the awaited-value /.then-cb param, emit `__VAL__`.
  // Takes precedence over const-inlining (handler-scope binding, not const).
  if (errNameStack.length > 0 && errNameStack.includes(name)) {
    tokens.push("__ERR__");
    return;
  }
  if (valNameStack.length > 0 && valNameStack.includes(name)) {
    tokens.push("__VAL__");
    return;
  }
  if (constBindings.has(name) && !inliningStack.has(name)) {
    const init = constBindings.get(name)!;
    const newStack = new Set(inliningStack);
    newStack.add(name);
    walkFn(init, tokens, constBindings, new Set(currentLoopVars), newStack);
    return;
  }
  tokens.push(KNOWN_NUMERIC.has(name) ? "ID_NUM" : "ID");
}

/** Emit a StringLiteral token with value preservation (Round 4 A4 generalization:
 * `STR_<value>` for short values, `STR_<sha16>` for long/pipe values). Shared
 * by `walkV2`'s + `walkIterationBody`'s StringLiteral cases (Round 5.2: was
 * duplicated, IDENTICAL). */
function emitStringLiteralToken(node: AstNode, tokens: string[]): void {
  const raw = (node as { value?: unknown }).value;
  const value = typeof raw === "string" ? raw : "";
  emitStringLiteralValueToken(value, tokens);
}

/** Emit a BinaryExpression token. Shared by `walkV2`'s + `walkIterationBody`'s
 * BinaryExpression cases (Round 5.2: was duplicated, IDENTICAL modulo walkFn).
 * Round 3 A5: type-aware commutative-operand reorder (via `emitCommutativeBinary`,
 * which itself takes `walkFn`). Round 4 Fix 1: emit the operator in the token
 * (`BinaryExpression_<op>`) so different operators produce different tokens.
 * Round 5.3 O2 fix: literal-arithmetic folding — `BinaryExpression(<arith-op>,
 * NumericLiteral, NumericLiteral)` → `NUM` (e.g., `2 * 2` → `NUM`, matching
 * `4` → `NUM`). The CloneOperator paper (arXiv 2606.25272 §III-D, CC-BY-4.0)
 * confirms this: "For numeric constants, it parses the literal value and
 * searches for equivalent arithmetic expressions using basic operators such
 * as addition, subtraction, multiplication, and division." The D3 detector
 * already treats `NumericLiteral → NUM` (loses the value), so folding
 * `2 * 2` → `NUM` is consistent: both `4` and `2 * 2` produce `NUM`. FP risk:
 * NONE — the existing `NumericLiteral → NUM` already loses the value, so
 * `4` and `6` both produce `NUM`; folding `2 * 3` → `NUM` is the same as
 * `6` → `NUM`. Only folds when BOTH operands are NumericLiteral (not
 * Identifier, not StringLiteral) — so `i + 1` (Identifier) is NOT folded
 * (preserves the A5 operand-reorder). Only arithmetic operators (`+`, `-`,
 * `*`, `/`, `%`) — not comparison operators (`===`, `<`, etc.) which produce
 * booleans. For `+`: both operands are NumericLiteral → numeric `+` (not
 * string concat, which requires a StringLiteral). Safe. */
function emitBinaryExpressionToken(
  node: AstNode,
  tokens: string[],
  constBindings: Map<string, AstNode>,
  currentLoopVars: Set<string>,
  inliningStack: Set<string>,
  walkFn: WalkFn,
): void {
  // Round 5.3 O2 fix: literal-arithmetic folding. Both operands are
  // NumericLiteral + arithmetic operator → fold to `NUM` (the D3 detector
  // already loses the value via `NumericLiteral → NUM`, so this is consistent).
  // This closes the O2 gap: `bytes += 4` (NUM) vs `bytes += (2 * 2)`
  // (BinaryExpression_* NUM NUM) → both produce `... ID_NUM NUM...` after
  // folding. Jaccard 1.0.
  if (isLiteralArithmetic(node)) {
    tokens.push("NUM");
    return;
  }
  if (emitCommutativeBinary(node, tokens, constBindings, currentLoopVars, inliningStack, walkFn)) return;
  tokens.push(`BinaryExpression_${node.operator}`);
  for (const c of astChildren(node)) walkFn(c, tokens, constBindings, currentLoopVars, inliningStack);
}

/** Round 5.3 O2 fix: true if `node` is a `BinaryExpression` with an arithmetic
 * operator (`+`, `-`, `*`, `/`, `%`) and BOTH operands are `NumericLiteral`.
 * Used by `emitBinaryExpressionToken` to fold literal-arithmetic to a single
 * `NUM` token (matching the existing `NumericLiteral → NUM` normalization).
 * Excludes BigIntLiteral (rare; can be added later if needed). Excludes
 * comparison/logical operators (they produce booleans, not numbers). For `+`,
 * both operands being NumericLiteral guarantees numeric `+` (not string concat,
 * which requires a StringLiteral). */
function isLiteralArithmetic(node: AstNode): boolean {
  if (node.type !== "BinaryExpression") return false;
  const op = node.operator;
  if (op !== "+" && op !== "-" && op !== "*" && op !== "/" && op !== "%") return false;
  const left = astNode(node.left);
  const right = astNode(node.right);
  return left?.type === "NumericLiteral" && right?.type === "NumericLiteral";
}

/** Emit a ForStatement / WhileStatement / DoWhileStatement token (canonical
 * `LOOP`). Shared by `walkV2`'s + `walkIterationBody`'s Loop cases (Round 5.2:
 * was duplicated, IDENTICAL modulo walkFn). The for-init (if
 * VariableDeclaration) is hoisted before `LOOP`; the for-update is DROPPED
 * (loop mechanic). The test + body are walked with the new `loopVars`. */
function emitLoopToken(
  node: AstNode,
  tokens: string[],
  constBindings: Map<string, AstNode>,
  currentLoopVars: Set<string>,
  inliningStack: Set<string>,
  walkFn: WalkFn,
): void {
  const isFor = node.type === "ForStatement";
  const init = isFor ? astNode(node.init) : undefined;
  const test = astNode(node.test);
  const body = astNode(node.body);
  const loopVars = loopVarsOf(test);
  if (isFor && init?.type === "VariableDeclaration") {
    walkFn(init, tokens, constBindings, currentLoopVars, inliningStack);
  }
  tokens.push("LOOP");
  if (test !== undefined) walkFn(test, tokens, constBindings, loopVars, inliningStack);
  if (body !== undefined) walkFn(body, tokens, constBindings, loopVars, inliningStack);
}

/** Emit an IfStatement as a canonical `DECIDE` token sequence. Shared by
 * `walkV2`'s + `walkIterationBody`'s IfStatement cases (Round 5.2: was
 * duplicated, ~40 lines each, modulo the trailing-else-if-continue drop).
 * The `trailingElseIfContinueDrop` flag (Pass 2.5 only) drops the alternate
 * when it's an `else if (...) { continue; }` (continue is a no-op when the if
 * is the last statement of the loop body — safe case, A2). The test uses
 * equality-test normalization (via `emitDecisionTest`); the consequent +
 * alternate use `emitBody` (symmetric BlockStatement drop + loop-update strip). */
function emitIfStatementTokens(
  node: AstNode,
  tokens: string[],
  constBindings: Map<string, AstNode>,
  currentLoopVars: Set<string>,
  inliningStack: Set<string>,
  walkFn: WalkFn,
  letDrop?: Set<string>,
  trailingElseIfContinueDrop: boolean = false,
): void {
  tokens.push("DECIDE");
  emitDecisionTest(astNode(node.test), tokens, constBindings, currentLoopVars, inliningStack, walkFn);
  emitBody(astNode(node.consequent), tokens, constBindings, currentLoopVars, inliningStack, walkFn, letDrop);
  const alt = astNode(node.alternate);
  if (alt !== undefined) {
    if (trailingElseIfContinueDrop && alt.type === "IfStatement") {
      const altCons = astNode(alt.consequent);
      if (isSoleContinue(altCons)) {
        return; // trailing-else-if-continue drop (Pass 2.5 only)
      }
    }
    emitBody(alt, tokens, constBindings, currentLoopVars, inliningStack, walkFn, letDrop);
  }
}

/** Emit a SwitchStatement by UNWRAPPING it: each non-default case →
 * `DECIDE [tests] [consequent]`; default case → emit consequent as SIBLINGS
 * (no DECIDE wrapper). Fallthrough cases (empty consequent) accumulate tests
 * into the next non-empty case. Shared by `walkV2`'s + `walkIterationBody`'s
 * SwitchStatement cases (Round 5.2: was duplicated, ~30 lines each; the
 * walkIterationBody version inlined the equality-test logic, which is now
 * delegated to `emitDecisionTest` with `walkFn`). */
function emitSwitchStatementTokens(
  node: AstNode,
  tokens: string[],
  constBindings: Map<string, AstNode>,
  currentLoopVars: Set<string>,
  inliningStack: Set<string>,
  walkFn: WalkFn,
  letDrop?: Set<string>,
): void {
  const cases = astNodeArray(node.cases);
  let accTests: AstNode[] = [];
  for (let i = 0; i < cases.length; i += 1) {
    const c = cases[i]!;
    const caseTest = astNode(c.test);
    const caseCons = astNodeArray(c.consequent);
    if (caseTest !== undefined) {
      accTests.push(caseTest);
    }
    if (caseCons.length === 0) {
      continue; // fallthrough — accumulate test for next case
    }
    if (caseTest !== undefined) {
      tokens.push("DECIDE");
      for (const t of accTests) emitDecisionTest(t, tokens, constBindings, currentLoopVars, inliningStack, walkFn);
      accTests = [];
      emitStmtList(caseCons, tokens, constBindings, currentLoopVars, inliningStack, walkFn, letDrop);
    } else {
      // Default case: emit consequent as SIBLINGS (unwrap, no DECIDE wrapper).
      accTests = [];
      emitStmtList(caseCons, tokens, constBindings, currentLoopVars, inliningStack, walkFn, letDrop);
    }
  }
}

// ============================================================================
// EXP108: N5 early-return↔single-return (accumulator-return) normalization.
// Detects the "accumulator-return" pattern (Fowler's "Replace Nested Conditional
// with Guard Clauses" refactoring, inverse direction):
// `let x; <if-else chain where every leaf assigns to x>; return x;`
// and normalizes it to the early-return form:
// `<if-else chain where every leaf returns the assigned value>`
// by (1) dropping the `let x;` declaration, (2) replacing each `x = expr;`
// inside a branch with `ReturnStatement expr;` (token-wise), and (3) dropping
// the trailing `return x;`. This makes the single-return-with-accumulator
// form produce the SAME token stream as the equivalent early-return form,
// closing the V4 N5 gap (Jaccard 0.0323 → 1.0).
//
// Detection is CONSTRAINED to avoid FPs:
// - First stmt: `let x;` (kind="let", single declarator, Identifier id, NO
// init — the `let x = init` case is deferred; it would require emitting
// `ReturnStatement <init>` as the fallthrough).
// - Middle stmts: ALL are IfStatements whose branches (consequent + alternate,
// recursively) assign ONLY to x. The if-else chain must have a catch-all
// `else` (so the final `return x;` is unreachable and safe to drop).
// - Last stmt: `return x;` (ReturnStatement with argument being Identifier x).
//
// FP risk: NONE on real src/ (the pattern requires a very specific shape —
// `let x;` with no init + if-else-with-only-x-assignments + catch-all else +
// `return x;` — that 0/2559 real src/ functions match; see
// research/n5-early-return/). The normalization only fires when the pattern
// matches, so unrelated functions are unaffected. Two functions (one
// accumulator-return, one early-return) that have the same if-else structure
// + branch values ARE semantic clones — catching them is a TP.
//
// Sources:
// - Fowler's "Refactoring" (1999, 2nd ed 2018), "Replace Nested Conditional
// with Guard Clauses" — the canonical refactoring pattern.
// - research/n5-early-return/README.md (Kagi discovery + synthesis).
// ============================================================================

/** Detect the accumulator-return pattern in a function body. Returns the
 * accumulator name (or undefined if the pattern doesn't match). */
function detectAccumulatorReturn(fnNode: AstNode): string | undefined {
  const body = astNode(fnNode.body);
  if (body === undefined || body.type !== "BlockStatement") return undefined;
  const stmts = astNodeArray(body.body);
  if (stmts.length < 3) return undefined;
  // First: `let x;` (kind="let", single declarator, Identifier id, NO init).
  const first = stmts[0]!;
  if (first.type !== "VariableDeclaration" || first.kind !== "let") return undefined;
  const decls = astNodeArray(first.declarations);
  if (decls.length !== 1) return undefined;
  const id = astNode(decls[0]!.id);
  if (id === undefined || id.type !== "Identifier") return undefined;
  const init = astNode(decls[0]!.init);
  if (init !== undefined) return undefined; // defer `let x = init` case
  const accName = String(id.name);
  // Last: `return x;` (ReturnStatement, argument is Identifier x).
  const last = stmts[stmts.length - 1]!;
  if (last.type !== "ReturnStatement") return undefined;
  const lastArg = astNode(last.argument);
  if (lastArg === undefined || lastArg.type !== "Identifier" || String(lastArg.name) !== accName) return undefined;
  // Middle: ALL IfStatements, every leaf branch assigns ONLY to x, AND the
  // if-else chain has a catch-all `else` (so the final `return x;` is unreachable).
  for (let i = 1; i < stmts.length - 1; i += 1) {
    const s = stmts[i]!;
    if (s.type !== "IfStatement") return undefined;
    if (!accumulatorBranchAssignsOnlyTo(s, accName)) return undefined;
  }
  return accName;
}

/** Check: every leaf branch of the if-statement (consequent + alternate,
 * recursively) assigns ONLY to `accName`. The if-else chain must have a
 * catch-all `else` (a non-IfStatement alternate that's a BlockStatement or
 * single statement) so the final `return x;` is unreachable. */
function accumulatorBranchAssignsOnlyTo(ifNode: AstNode, accName: string): boolean {
  const cons = astNode(ifNode.consequent);
  if (cons === undefined) return false;
  if (!leafBranchAssignsOnlyTo(cons, accName)) return false;
  const alt = astNode(ifNode.alternate);
  if (alt === undefined) return false; // no else — final `return x;` would be reachable
  if (alt.type === "IfStatement") {
    // `else if` — recurse.
    return accumulatorBranchAssignsOnlyTo(alt, accName);
  }
  // Catch-all `else` (BlockStatement or single statement) — must assign only to accName.
  return leafBranchAssignsOnlyTo(alt, accName);
}

/** Check: a leaf branch (BlockStatement or single statement) contains ONLY
 * `accName = expr;` ExpressionStatements. */
function leafBranchAssignsOnlyTo(branch: AstNode, accName: string): boolean {
  const stmts: readonly AstNode[] =
    branch.type === "BlockStatement" ? astNodeArray(branch.body) : [branch];
  if (stmts.length === 0) return false; // empty branch — acc not assigned
  for (const s of stmts) {
    if (s.type !== "ExpressionStatement") return false;
    const e = astNode(s.expression);
    if (e === undefined || e.type !== "AssignmentExpression" || e.operator !== "=") return false;
    const left = astNode(e.left);
    if (left === undefined || left.type !== "Identifier" || String(left.name) !== accName) return false;
  }
  return true;
}

/** Walk a branch body of the accumulator pattern: for each `accName = expr;`
 * ExpressionStatement, emit `ReturnStatement` + walk the RHS expression. Other
 * statements (none expected per the detection, but defensive) fall back to walkV2. */
function walkAccumulatorBranch(
  branch: AstNode,
  accName: string,
  tokens: string[],
  constBindings: Map<string, AstNode>,
  currentLoopVars: Set<string>,
  inliningStack: Set<string>,
): void {
  const stmts: readonly AstNode[] =
    branch.type === "BlockStatement" ? astNodeArray(branch.body) : [branch];
  for (const s of stmts) {
    if (s.type === "ExpressionStatement") {
      const e = astNode(s.expression);
      if (e !== undefined && e.type === "AssignmentExpression" && e.operator === "=") {
        const left = astNode(e.left);
        if (left !== undefined && left.type === "Identifier" && String(left.name) === accName) {
          // `x = expr;` → `ReturnStatement expr`
          tokens.push("ReturnStatement");
          const right = astNode(e.right);
          if (right !== undefined) {
            walkV2(right, tokens, constBindings, currentLoopVars, inliningStack);
          }
          continue;
        }
      }
    }
    // Defensive fallback (detection guarantees this path is unreachable).
    walkV2(s, tokens, constBindings, currentLoopVars, inliningStack);
  }
}

/** Emit the accumulator-return body: walk each middle IfStatement, but with
 * the branch emitter replacing `x = expr;` with `ReturnStatement expr;`.
 * Skips the first (`let x;`) + last (`return x;`) statements. */
function emitAccumulatorBody(
  fnNode: AstNode,
  accName: string,
  tokens: string[],
  constBindings: Map<string, AstNode>,
  inliningStack: Set<string>,
): void {
  const body = astNode(fnNode.body);
  if (body === undefined || body.type !== "BlockStatement") return;
  const stmts = astNodeArray(body.body);
  // Walk the function's non-body children (id, params, returnType, typeParameters)
  // normally — the caller (walkV2's FunctionDeclaration case) handles the header.
  // Here we emit only the middle IfStatements with the accumulator branch walker.
  for (let i = 1; i < stmts.length - 1; i += 1) {
    const s = stmts[i]!;
    // s is an IfStatement (per detection). Emit it with the accumulator branch walker.
    // The IfStatement's DECIDE emission is the SAME as the normal walkV2 (via
    // emitIfStatementTokens), but the branch bodies use walkAccumulatorBranch.
    emitAccumulatorIfStatement(s, accName, tokens, constBindings, new Set(), inliningStack);
  }
}

/** Emit an IfStatement with accumulator-aware branch emission (recurses on
 * else-if). Mirrors `emitIfStatementTokens` but uses `walkAccumulatorBranch` for
 * the consequent + alternate (instead of `emitBody`). */
function emitAccumulatorIfStatement(
  node: AstNode,
  accName: string,
  tokens: string[],
  constBindings: Map<string, AstNode>,
  currentLoopVars: Set<string>,
  inliningStack: Set<string>,
): void {
  tokens.push("DECIDE");
  emitDecisionTest(astNode(node.test), tokens, constBindings, currentLoopVars, inliningStack, walkV2);
  const cons = astNode(node.consequent);
  if (cons !== undefined) {
    walkAccumulatorBranch(cons, accName, tokens, constBindings, currentLoopVars, inliningStack);
  }
  const alt = astNode(node.alternate);
  if (alt !== undefined) {
    if (alt.type === "IfStatement") {
      // `else if` — recurse with the accumulator branch walker.
      emitAccumulatorIfStatement(alt, accName, tokens, constBindings, currentLoopVars, inliningStack);
    } else {
      // Catch-all `else` — emit with the accumulator branch walker.
      walkAccumulatorBranch(alt, accName, tokens, constBindings, currentLoopVars, inliningStack);
    }
  }
}

// ============================================================================
// EXP126: N1 loop↔iterator deterministic normalization.
// Canonicalizes the four iteration forms over an array —
// 1. `for (let i = 0; i < arr.length; i++) { const v = arr[i]!; <body> }`
// 2. `for (const v of arr) { <body> }`
// 3. `arr.forEach(v => { <body> })` (and `arr.forEach(function(v){ <body> })`)
// 4. `arr.map(v => { <body> })` — ONLY when the result is discarded (i.e. the
// call is the expression of an ExpressionStatement; `const r = arr.map(...)`
// is NOT normalized because `map` returns a new array — a different functor).
// — to a single canonical token envelope:
// `<arr> ITERATE_ARR <body with __ELEM__> END_ITERATE_ARR`
// where `<arr>` is the walked array expression (data source — walked BEFORE the
// envelope to avoid the chained-call FP, e.g. `arr.filter(cb1).map(cb2)` where
// skipping the `.filter(cb1)` data source would conflate two different functors)
// and `<body with __ELEM__>` is the body with the element identifier replaced by
// the canonical `__ELEM__` token (see `emitIdentifierToken`). The four forms
// produce IDENTICAL token streams when the bodies are element-for-element
// equivalent, so Jaccard = 1.0.
//
// Sources: research/n1-deterministic/README.md (EXP126 — 3 sources + synthesis).
// Prior art: EXP28 (`category-functor`, `bc4f2c6`) used `<arr> ITERATE [body]
// END_ITERATE` with the element as `ID` (same as all other idents). EXP126's
// distinction: the element becomes a DISTINCT `__ELEM__` token, separating the
// loop element from other `ID` tokens in the body — more precise (fewer FPs).
// ============================================================================

/** EXP126: detect `for (let i = 0; i < arr.length; i++) { const v = arr[i];
 * <body> }` — the indexed iteration form. Returns the body statements (after
 * the `const v = arr[i]` declaration), the element name, and the array node
 * (the data source). The element name is removed from `constBindings` by the
 * caller (via the elemNameStack check in `emitIdentifierToken`, which takes
 * precedence over const-inlining) so `v` is NOT inlined — matches for-of's `v`
 * which is a loop variable, not a const binding. Accepts an optional
 * `TSNonNullExpression` wrapper on `arr[i]` (the V4 N1 fixture uses `values[i]!`). */
function detectForIndexOverArray(node: AstNode): { bodyStmts: AstNode[]; elemName: string; arrNode: AstNode } | undefined {
  if (node.type !== "ForStatement") return undefined;
  const init = astNode(node.init);
  const test = astNode(node.test);
  const update = astNode(node.update);
  const body = astNode(node.body);
  if (body === undefined || body.type !== "BlockStatement") return undefined;
  // init: `let i = 0` (forward iteration only — reverse `i = arr.length - 1` is
  // a different functor F^op and is NOT normalized; this is "accidental
  // faithfulness" the same as EXP28, deliberately conservative).
  if (init === undefined || init.type !== "VariableDeclaration" || init.kind !== "let") return undefined;
  const initDecls = astNodeArray(init.declarations);
  if (initDecls.length !== 1) return undefined;
  const initId = astNode(initDecls[0]!.id);
  const initInit = astNode(initDecls[0]!.init);
  if (initId === undefined || initId.type !== "Identifier") return undefined;
  if (initInit === undefined || initInit.type !== "NumericLiteral" || initInit.value !== 0) return undefined;
  const indexName = String(initId.name);
  // test: `i < arr.length`
  if (test === undefined || test.type !== "BinaryExpression" || test.operator !== "<") return undefined;
  const testLeft = astNode(test.left);
  const testRight = astNode(test.right);
  if (testLeft === undefined || testLeft.type !== "Identifier" || String(testLeft.name) !== indexName) return undefined;
  if (testRight === undefined || testRight.type !== "MemberExpression") return undefined;
  const testRightProp = astNode(testRight.property);
  if (testRightProp === undefined || testRightProp.type !== "Identifier" || String(testRightProp.name) !== "length") return undefined;
  // update: `i++`
  if (update === undefined || update.type !== "UpdateExpression" || update.operator !== "++") return undefined;
  const updateArg = astNode(update.argument);
  if (updateArg === undefined || updateArg.type !== "Identifier" || String(updateArg.name) !== indexName) return undefined;
  // body: first statement `const v = arr[i]` (possibly with TSNonNullExpression `!`)
  const stmts = astNodeArray(body.body);
  if (stmts.length < 2) return undefined;
  const first = stmts[0];
  if (first === undefined || first.type !== "VariableDeclaration" || first.kind !== "const") return undefined;
  const firstDecls = astNodeArray(first.declarations);
  if (firstDecls.length !== 1) return undefined;
  const elemId = astNode(firstDecls[0]!.id);
  const elemInit = astNode(firstDecls[0]!.init);
  if (elemId === undefined || elemId.type !== "Identifier") return undefined;
  let elemInitInner = elemInit;
  if (elemInitInner !== undefined && elemInitInner.type === "TSNonNullExpression") {
    elemInitInner = astNode((elemInitInner as { expression?: unknown }).expression);
  }
  if (elemInitInner === undefined || elemInitInner.type !== "MemberExpression") return undefined;
  const elemObj = astNode(elemInitInner.object);
  const elemProp = astNode(elemInitInner.property);
  // EXP403: allow `elemObj` to be a MemberExpression (member access array like
  // `bag.items[i]`), not just a plain Identifier. This is consistent with
  // `detectForOfArrayLoop` (for-of) which accepts any `right` node. The arrNode
  // is walked by `emitIterateArrEnvelope`, which preserves the member access
  // tokens (`MemberExpression ID ID` for `bag.items`) so two functions iterating
  // DIFFERENT member arrays still emit different array tokens at the use site
  // (the FP risk is the same as for-of, which already handles member access
  // arrays with 0 production FPs). The property must still be the index name.
  if (elemObj === undefined) return undefined;
  if (elemProp === undefined || elemProp.type !== "Identifier" || String(elemProp.name) !== indexName) return undefined;
  const elemName = String(elemId.name);
  return { bodyStmts: stmts.slice(1), elemName, arrNode: elemObj };
}

/** EXP126: detect `arr.forEach(cb)` / `arr.map(cb)` — the callback iteration
 * forms. Returns the callback body, element name, the array (callee object),
 * and the kind. The callback must have exactly ONE param (the element); index
 * and array params are NOT accepted (bodies using the index won't match for-i/
 * for-of forms — a deliberate limitation, same as EXP28). The body may be a
 * BlockStatement or a single expression (arrow with expression body). */
function detectArrayCallbackCall(node: AstNode): { body: AstNode; elemName: string; arrNode: AstNode; kind: "forEach" | "map" } | undefined {
  if (node.type !== "CallExpression") return undefined;
  const callee = astNode(node.callee);
  if (callee === undefined || callee.type !== "MemberExpression") return undefined;
  const calleeProp = astNode(callee.property);
  if (calleeProp === undefined || calleeProp.type !== "Identifier") return undefined;
  const methodName = String(calleeProp.name);
  if (methodName !== "forEach" && methodName !== "map") return undefined;
  const calleeObj = astNode(callee.object);
  if (calleeObj === undefined) return undefined;
  const args = astNodeArray(node.arguments);
  if (args.length !== 1) return undefined;
  const cb = args[0];
  if (cb === undefined || (cb.type !== "ArrowFunctionExpression" && cb.type !== "FunctionExpression")) return undefined;
  const cbParams = astNodeArray(cb.params);
  if (cbParams.length !== 1) return undefined;
  const elemParam = astNode(cbParams[0]);
  if (elemParam === undefined || elemParam.type !== "Identifier") return undefined;
  const elemName = String(elemParam.name);
  const cbBody = astNode(cb.body);
  if (cbBody === undefined) return undefined;
  return { body: cbBody, elemName, arrNode: calleeObj, kind: methodName as "forEach" | "map" };
}

/** EXP403: detect `arr.find(arrow_fn)` — the array `.find` iteration form (the
 * core of the N5 find+nullish normalization). Returns the array node, the
 * predicate body (the expression tested by `find`), and the element name (the
 * callback's param). Handles both expression-body arrows (`(v) => v > 0`) and
 * block-body arrows/functions (`(v) => { return v > 0; }`) with a SINGLE
 * return statement. Rejects multi-statement bodies (the predicate must be a
 * pure boolean expression — `find`'s contract is "return truthy to stop"),
 * named-function-reference callbacks (no body to extract — T4b library↔hand-
 * rolled, out of scope), and non-Identifier params.
 *
 * This is the method-idiom normalization (consistent with forEach/map above):
 * `arr.find(pred)` is semantically `for (const x of arr) { if (pred(x)) return x; }`.
 * The CPS (continuation-passing style) insight: `find` is a higher-order
 * function that calls the predicate with each element; the predicate's
 * continuation is "return the element if true, continue if false." Both forms
 * reduce to the same continuation chain: iterate + test + return-element-or-
 * continue. The `?? <fallback>` (handled by the caller) is the after-loop
 * continuation (`return <fallback>`).
 *
 * Sources: continuation monad (CPS transform, Plotkin); the `find` is the
 * list-comprehension filter (same as the early-return form's `if (pred(x))
 * return x`). See `emitFindNullishEnvelope` for the emission. */
function detectFindCall(node: AstNode): {
  arrNode: AstNode;
  predBody: AstNode;
  elemName: string;
} | undefined {
  if (node.type !== "CallExpression") return undefined;
  const callee = astNode(node.callee);
  if (callee === undefined || callee.type !== "MemberExpression") return undefined;
  const calleeProp = astNode(callee.property);
  if (calleeProp === undefined || calleeProp.type !== "Identifier" || String(calleeProp.name) !== "find") return undefined;
  const calleeObj = astNode(callee.object);
  if (calleeObj === undefined) return undefined;
  const args = astNodeArray(node.arguments);
  if (args.length !== 1) return undefined;
  const cb = args[0];
  if (cb === undefined || (cb.type !== "ArrowFunctionExpression" && cb.type !== "FunctionExpression")) return undefined;
  const cbParams = astNodeArray(cb.params);
  if (cbParams.length !== 1) return undefined;
  const elemParam = astNode(cbParams[0]);
  if (elemParam === undefined || elemParam.type !== "Identifier") return undefined;
  const elemName = String(elemParam.name);
  const cbBody = astNode(cb.body);
  if (cbBody === undefined) return undefined;
  let predBody: AstNode | undefined;
  if (cbBody.type === "BlockStatement") {
    // Block body: must be a single `return <expr>` statement (the predicate is
    // a pure boolean expression — `find`'s contract). Multi-statement bodies
    // are left to the default walk (they may have side effects, not pure).
    const ss = astNodeArray(cbBody.body);
    if (ss.length !== 1) return undefined;
    const s = ss[0];
    if (s === undefined || s.type !== "ReturnStatement") return undefined;
    predBody = astNode(s.argument);
  } else {
    // Expression body — the predicate is the expression itself.
    predBody = cbBody;
  }
  if (predBody === undefined) return undefined;
  return { arrNode: calleeObj, predBody, elemName };
}

/** EXP403: emit the canonical `ITERATE_ARR DECIDE <pred-body> ReturnStatement
 * __ELEM__ END_ITERATE_ARR` envelope for `arr.find(pred)`, followed by the
 * fallback `ReturnStatement <fallback>` (if `fallbackNode` is provided). This
 * matches the early-return form's token stream exactly:
 * `for (const x of arr) { if (pred(x)) return x; } return <fallback>;`
 * → `<arr> ITERATE_ARR DECIDE <pred-body> ReturnStatement __ELEM__ END_ITERATE_ARR
 * ReturnStatement <fallback>`
 * The `?? <fallback>` is the after-loop continuation; bare `arr.find(pred)` (no
 * `??`) has `fallbackNode = undefined` → no trailing ReturnStatement (matches
 * the early-return form with no trailing return — implicit `undefined`).
 *
 * CPS / monad law: `arr.find(pred)?? fallback` = `bind(find(arr, pred), k)`
 * where `k(x) = return x` and the after-loop continuation is `return fallback`.
 * The early-return form is the unrolled version of the same monad. */
function emitFindNullishEnvelope(
  arrNode: AstNode,
  predBody: AstNode,
  elemName: string,
  fallbackNode: AstNode | undefined,
  tokens: string[],
  constBindings: Map<string, AstNode>,
  currentLoopVars: Set<string>,
  inliningStack: Set<string>,
): void {
  // Walk the array (data source) BEFORE the envelope (same as
  // emitIterateArrEnvelope — preserves the data source).
  walkV2(arrNode, tokens, constBindings, currentLoopVars, inliningStack);
  tokens.push("ITERATE_ARR");
  // Push elem name + copy constBindings without the elem (prevent inlining).
  // The elem name is pushed to elemNameStack so Identifier references to the
  // element emit `__ELEM__` (matching the early-return form's loop variable).
  elemNameStack.push(elemName);
  const newCb = new Map(constBindings);
  newCb.delete(elemName);
  try {
    // `DECIDE <pred-body>` — the `if (pred(x))` test (matches IfStatement's
    // DECIDE). The predBody is walked with the elem name on the stack so the
    // callback's param references emit `__ELEM__`.
    tokens.push("DECIDE");
    walkV2(predBody, tokens, newCb, currentLoopVars, inliningStack);
    // `ReturnStatement __ELEM__` — the implicit `return x` of `find` (when the
    // predicate is true, `find` returns the element). Matches the early-return
    // form's `return v` inside the loop.
    tokens.push("ReturnStatement");
    // The element reference — emit `__ELEM__` directly (the elem name is on
    // the stack, but we want to be explicit since the predBody may not
    // reference the element at all, e.g. `arr.find(() => true)`).
    tokens.push("__ELEM__");
  } finally {
    elemNameStack.pop();
  }
  tokens.push("END_ITERATE_ARR");
  // The after-loop fallback: `ReturnStatement <fallback>`. For `?? null` this
  // is `ReturnStatement NULL` (matches the early-return form's `return null`
  // after the loop). For bare `arr.find(pred)` (no `??`), fallbackNode is
  // undefined → no trailing ReturnStatement (matches the early-return form
  // with no trailing return — implicit `undefined`).
  if (fallbackNode !== undefined) {
    tokens.push("ReturnStatement");
    walkV2(fallbackNode, tokens, constBindings, currentLoopVars, inliningStack);
  }
}

/** EXP126: detect `for (const v of arr) { <body> }` — the for-of iteration form.
 * Returns the body, element name, and the array (right side). Requires a single
 * const declarator with an Identifier id and NO init (for-of declarators have
 * `init: null` — `for (const v of arr)` not `for (const v = expr of arr)`).
 * `ForInStatement` is NOT normalized (for-in iterates keys, not values — a
 * different functor; N6 is out of scope for this experiment). */
function detectForOfArrayLoop(node: AstNode): { body: AstNode; elemName: string; arrNode: AstNode } | undefined {
  if (node.type !== "ForOfStatement") return undefined;
  const left = astNode(node.left);
  const right = astNode(node.right);
  const body = astNode(node.body);
  if (left === undefined || left.type !== "VariableDeclaration" || left.kind !== "const") return undefined;
  const leftDecls = astNodeArray(left.declarations);
  if (leftDecls.length !== 1) return undefined;
  const elemId = astNode(leftDecls[0]!.id);
  const elemInit = astNode(leftDecls[0]!.init);
  if (elemId === undefined || elemId.type !== "Identifier") return undefined;
  if (elemInit !== undefined) return undefined; // for-of declarators have init: null
  if (right === undefined) return undefined;
  if (body === undefined) return undefined;
  return { body, elemName: String(elemId.name), arrNode: right };
}

/** EXP362: detect `for (const key of Object.keys(obj))` — the for-of-Object.keys
 * key-iteration form. Returns the body, the key name (elemName), and the object
 * node (arrNode = the argument to Object.keys, NOT the full call — so for-in and
 * for-of-Object.keys both walk `<obj>` as the data source → identical envelope).
 * Rejects non-canonical forms (multiple args, non-Object.keys callee, non-const
 * left, non-Identifier key). This is the N6 (for-in↔Object.keys+for-of) fix. */
function detectForOfObjectKeysLoop(node: AstNode): { body: AstNode; elemName: string; arrNode: AstNode } | undefined {
  if (node.type !== "ForOfStatement") return undefined;
  const left = astNode(node.left);
  const right = astNode(node.right);
  const body = astNode(node.body);
  if (left === undefined || left.type !== "VariableDeclaration" || left.kind !== "const") return undefined;
  const leftDecls = astNodeArray(left.declarations);
  if (leftDecls.length !== 1) return undefined;
  const elemId = astNode(leftDecls[0]!.id);
  const elemInit = astNode(leftDecls[0]!.init);
  if (elemId === undefined || elemId.type !== "Identifier") return undefined;
  if (elemInit !== undefined) return undefined;
  if (right === undefined || right.type !== "CallExpression") return undefined;
  const callee = astNode(right.callee);
  if (callee === undefined || callee.type !== "MemberExpression") return undefined;
  const calleeObj = astNode(callee.object);
  const calleeProp = astNode(callee.property);
  if (calleeObj === undefined || calleeObj.type !== "Identifier" || String(calleeObj.name) !== "Object") return undefined;
  if (calleeProp === undefined || calleeProp.type !== "Identifier" || String(calleeProp.name) !== "keys") return undefined;
  const args = astNodeArray(right.arguments);
  if (args.length !== 1) return undefined;
  const objArg = args[0]!;
  if (body === undefined) return undefined;
  return { body, elemName: String(elemId.name), arrNode: objArg };
}

/** EXP362: detect `for (const key in obj)` — the for-in key-iteration form.
 * Returns the body, the key name (elemName), and the object node (arrNode = obj).
 * Rejects non-canonical forms (non-const left, non-Identifier key, non-Identifier
 * right). For-in iterates enumerable keys (including prototype keys, but for
 * plain objects this equals Object.keys). This is the N6 fix — for-in and
 * for-of-Object.keys both produce `<obj> ITERATE_KEYS <body> END_ITERATE_KEYS`. */
function detectForInOverObject(node: AstNode): { body: AstNode; elemName: string; arrNode: AstNode } | undefined {
  if (node.type !== "ForInStatement") return undefined;
  const left = astNode(node.left);
  const right = astNode(node.right);
  const body = astNode(node.body);
  if (left === undefined || left.type !== "VariableDeclaration" || left.kind !== "const") return undefined;
  const leftDecls = astNodeArray(left.declarations);
  if (leftDecls.length !== 1) return undefined;
  const elemId = astNode(leftDecls[0]!.id);
  const elemInit = astNode(leftDecls[0]!.init);
  if (elemId === undefined || elemId.type !== "Identifier") return undefined;
  if (elemInit !== undefined) return undefined;
  if (right === undefined || right.type !== "Identifier") return undefined;
  if (body === undefined) return undefined;
  return { body, elemName: String(elemId.name), arrNode: right };
}

/** EXP126: emit the canonical `ITERATE_ARR <body with __ELEM__> END_ITERATE_ARR`
 * envelope around a walked array (data source) + a body. The elem name is
 * pushed onto `elemNameStack` for the duration of the body walk so Identifier
 * references to the element emit `__ELEM__` (see `emitIdentifierToken`). The
 * constBindings map is COPIED with the elem name deleted so the element is NOT
 * inlined (matches for-of's `v` which is a loop variable — even if `const v =
 * arr[i]` was collected by `collectConstBindings`, the element refers to the
 * loop variable inside the body, not the outer const). */
function emitIterateArrEnvelope(
  arrNode: AstNode,
  bodyWalk: () => void,
  elemName: string,
  tokens: string[],
  constBindings: Map<string, AstNode>,
  currentLoopVars: Set<string>,
  inliningStack: Set<string>,
  envelopeToken: string = "ITERATE_ARR",
): void {
  // Walk the array (data source) BEFORE the envelope. A faithful iteration
  // normalization preserves the data source — this avoids the chained-call FP
  // where `arr.filter(cb1).map(cb2)` would lose the `.filter(cb1)` data source
  // if skipped (the `.map`'s object IS the `.filter` call). Same insight as
  // EXP28's "faithful functor" fix.
  walkV2(arrNode, tokens, constBindings, currentLoopVars, inliningStack);
  tokens.push(envelopeToken);
  // Push elem name + copy constBindings without the elem (prevent inlining).
  elemNameStack.push(elemName);
  const newCb = new Map(constBindings);
  newCb.delete(elemName);
  try {
    bodyWalk();
  } finally {
    elemNameStack.pop();
  }
  tokens.push(`END_${envelopeToken}`);
}

/** The V2 custom AST walker. Emits normalized tokens with CFG + data-flow
 * transformations. `currentLoopVars` is the set of loop variables for the
 * innermost enclosing loop (reset when entering a nested loop). `inliningStack`
 * guards against cyclic const inlining (reset at function boundaries). */

/** EXP362: detect `arr.push(x)` — a single-argument push call on an Identifier.
 * Returns the array name + the argument node. The canonical `APPEND` form makes
 * `arr.push(x)` match `arr = [...arr, x]` (the N4 mutation↔immutable fix). Only
 * single-arg push on a plain Identifier is normalized: multi-arg push, property
 * access callee, non-Identifier object, OR a SpreadElement argument (`push(...x)`)
 * are left to the default walk. The spread-arg restriction avoids a token-count
 * regression on `arr.push(...values)` (the spread is a different idiom from the
 * single-value append that N4 normalizes). */
function detectAppendPush(node: AstNode): { arrName: string; argNode: AstNode } | undefined {
  if (node.type !== "CallExpression") return undefined;
  const callee = astNode(node.callee);
  if (callee === undefined || callee.type !== "MemberExpression") return undefined;
  const calleeObj = astNode(callee.object);
  const calleeProp = astNode(callee.property);
  if (calleeProp === undefined || calleeProp.type !== "Identifier" || String(calleeProp.name) !== "push") return undefined;
  if (calleeObj === undefined || calleeObj.type !== "Identifier") return undefined;
  const args = astNodeArray(node.arguments);
  if (args.length !== 1) return undefined;
  const arg = args[0]!;
  if (arg.type === "SpreadElement") return undefined; // push(...x) is a different idiom
  return { arrName: String(calleeObj.name), argNode: arg };
}

/** EXP362: detect `arr = [...arr, x]` — an assignment creating a new array by
 * spreading the current one + appending one element. Returns the array name +
 * the appended element node. The canonical `APPEND` form matches `arr.push(x)`.
 * Requires: left is an Identifier, right is an ArrayExpression with exactly two
 * elements where the first is a SpreadElement of the SAME Identifier and the
 * second is the appended value. This is the constrained N4 pattern — broader
 * spread forms (multiple spreads, multiple elements) are left to the default
 * walk. */
function detectAppendSpread(node: AstNode): { arrName: string; argNode: AstNode } | undefined {
  if (node.type !== "AssignmentExpression" || node.operator !== "=") return undefined;
  const left = astNode(node.left);
  const right = astNode(node.right);
  if (left === undefined || left.type !== "Identifier") return undefined;
  if (right === undefined || right.type !== "ArrayExpression") return undefined;
  const elements = astNodeArray(right.elements);
  if (elements.length !== 2) return undefined;
  const spreadEl = elements[0]!;
  const appendEl = elements[1]!;
  if (spreadEl.type !== "SpreadElement") return undefined;
  const spreadArg = astNode((spreadEl as { argument?: unknown }).argument);
  if (spreadArg === undefined || spreadArg.type !== "Identifier") return undefined;
  if (String(spreadArg.name) !== String(left.name)) return undefined;
  if (appendEl.type === "SpreadElement") return undefined; // [...arr, ...x] is a different idiom
  return { arrName: String(left.name), argNode: appendEl };
}

/** EXP390 Fix 6 (N4 harder): detect `arr.unshift(x)` — a single-argument
 * unshift call on an Identifier. Returns the array name + the argument node.
 * The canonical `PREPEND` form makes `arr.unshift(x)` match
 * `arr = [x,...arr]` (the N4 prepend mutation↔immutable fix). Same constraints
 * as `detectAppendPush`: single-arg, plain Identifier, no SpreadElement arg.
 * Math: monad laws (the array monad's `unshift` is the dual of `push` —
 * PREPEND is the dual of APPEND; the monad laws require both to satisfy the
 * left/right identity + associativity, which the canonical PREPEND form
 * preserves). */
function detectPrependUnshift(node: AstNode): { arrName: string; argNode: AstNode } | undefined {
  if (node.type !== "CallExpression") return undefined;
  const callee = astNode(node.callee);
  if (callee === undefined || callee.type !== "MemberExpression") return undefined;
  const calleeObj = astNode(callee.object);
  const calleeProp = astNode(callee.property);
  if (calleeProp === undefined || calleeProp.type !== "Identifier" || String(calleeProp.name) !== "unshift") return undefined;
  if (calleeObj === undefined || calleeObj.type !== "Identifier") return undefined;
  const args = astNodeArray(node.arguments);
  if (args.length !== 1) return undefined;
  const arg = args[0]!;
  if (arg.type === "SpreadElement") return undefined;
  return { arrName: String(calleeObj.name), argNode: arg };
}

/** EXP390 Fix 6 (N4 harder): detect `arr = [x,...arr]` — an assignment
 * creating a new array by prepending one element + spreading the current one.
 * Returns the array name + the prepended element node. The canonical `PREPEND`
 * form matches `arr.unshift(x)`. Requires: left is an Identifier, right is an
 * ArrayExpression with exactly two elements where the FIRST is the prepended
 * value and the SECOND is a SpreadElement of the SAME Identifier (the reverse
 * of `detectAppendSpread`). */
function detectPrependSpread(node: AstNode): { arrName: string; argNode: AstNode } | undefined {
  if (node.type !== "AssignmentExpression" || node.operator !== "=") return undefined;
  const left = astNode(node.left);
  const right = astNode(node.right);
  if (left === undefined || left.type !== "Identifier") return undefined;
  if (right === undefined || right.type !== "ArrayExpression") return undefined;
  const elements = astNodeArray(right.elements);
  if (elements.length !== 2) return undefined;
  const prependEl = elements[0]!;
  const spreadEl = elements[1]!;
  if (spreadEl.type !== "SpreadElement") return undefined;
  const spreadArg = astNode((spreadEl as { argument?: unknown }).argument);
  if (spreadArg === undefined || spreadArg.type !== "Identifier") return undefined;
  if (String(spreadArg.name) !== String(left.name)) return undefined;
  if (prependEl.type === "SpreadElement") return undefined;
  return { arrName: String(left.name), argNode: prependEl };
}

/** Emit the canonical `PREPEND ID <arg>` token sequence for both
 * `arr.unshift(x)` and `arr = [x,...arr]`. */
function emitPrependTokens(
  arrName: string,
  argNode: AstNode,
  tokens: string[],
  constBindings: Map<string, AstNode>,
  currentLoopVars: Set<string>,
  inliningStack: Set<string>,
): void {
  tokens.push("PREPEND");
  emitIdentifierToken(arrName, tokens, constBindings, currentLoopVars, inliningStack, walkV2);
  walkV2(argNode, tokens, constBindings, currentLoopVars, inliningStack);
}

/** Emit the canonical `APPEND ID <arg>` token sequence for both `arr.push(x)`
 * and `arr = [...arr, x]`. The array name normalizes to `ID` (all Identifiers →
 * ID); the argument is walked normally. Both forms produce identical tokens. */
function emitAppendTokens(
  arrName: string,
  argNode: AstNode,
  tokens: string[],
  constBindings: Map<string, AstNode>,
  currentLoopVars: Set<string>,
  inliningStack: Set<string>,
): void {
  tokens.push("APPEND");
  emitIdentifierToken(arrName, tokens, constBindings, currentLoopVars, inliningStack, walkV2);
  walkV2(argNode, tokens, constBindings, currentLoopVars, inliningStack);
}

function walkV2(
  node: AstNode,
  tokens: string[],
  constBindings: Map<string, AstNode>,
  currentLoopVars: Set<string>,
  inliningStack: Set<string>,
): void {
  // T4b split-idiom normalization: detect `str.split(delim)` CallExpressions and
  // emit a canonical `SPLIT ID STR_<delim-value>` token sequence (regardless of context —
  // whether the call is in a const decl, a standalone expression, or nested).
  if (node.type === "CallExpression") {
    const splitCall = detectSplitCall(node);
    if (splitCall !== undefined) {
      tokens.push("SPLIT");
      tokens.push("ID"); // str name → ID (all Identifiers normalize to ID)
      emitSplitDelimToken(splitCall.delimNode, tokens); // STR_<value> (FINDING 1 fix)
      return;
    }
    // EXP126: `arr.forEach(cb)` as a NON-statement context (rare — e.g.
    // `const r = arr.forEach(cb)` assigns undefined to r; or `return arr.forEach(cb)`).
    // In these contexts forEach is NOT equivalent to for-i/for-of (the return value
    // is observed, even if it's always undefined). Normalize anyway — the body
    // is still the per-element morphism. This handles the rare non-statement
    // forEach; the common `arr.forEach(cb);` statement is handled in the
    // ExpressionStatement case (which skips the wrapper token for symmetry with
    // for-i/for-of).
    // NOTE: the forEach-as-statement case is handled in ExpressionStatement to
    // avoid emitting an extra `ExpressionStatement` token (which would break
    // token-stream equality with for-i/for-of).
    // DELIBERATELY NOT handling map here — map returns a new array (pure
    // functor), so it's only equivalent when the result is discarded (the
    // ExpressionStatement case).
    // EXP362: `arr.push(x)` single-arg push → canonical `APPEND ID <x>` (matches
    // `arr = [...arr, x]` spread-append in the AssignmentExpression case below —
    // the N4 mutation↔immutable fix). Checked here (not in ExpressionStatement) so
    // the normalization fires in every context (statement, arg, return) — the
    // ExpressionStatement wrapper token is emitted symmetrically by the caller.
    const pushAppend = detectAppendPush(node);
    if (pushAppend !== undefined) {
      emitAppendTokens(pushAppend.arrName, pushAppend.argNode, tokens, constBindings, currentLoopVars, inliningStack);
      return;
    }
    // EXP390 Fix 6 (N4 harder): `arr.unshift(x)` single-arg unshift → canonical
    // `PREPEND ID <x>` (matches `arr = [x,...arr]` spread-prepend below — the
    // N4 prepend mutation↔immutable fix, dual of the APPEND/push fix).
    const prependUnshift = detectPrependUnshift(node);
    if (prependUnshift !== undefined) {
      emitPrependTokens(prependUnshift.arrName, prependUnshift.argNode, tokens, constBindings, currentLoopVars, inliningStack);
      return;
    }
    // EXP390 Fix 3 (EXP179): MAP normalization for `X.set(k, v)` / `X.get(k)`
    // (X map-like). Canonicalizes to `MAP_SET <k> <v>` / `MAP_GET <k>` so
    // `new Map` + `.set/.get` aligns with `{}` + `[k]=/[k]`.
    const mapCall = detectMapCall(node);
    if (mapCall !== undefined) {
      if (mapCall.op === "set") {
        tokens.push("MAP_SET");
        walkV2(mapCall.key, tokens, constBindings, currentLoopVars, inliningStack);
        walkV2(mapCall.value, tokens, constBindings, currentLoopVars, inliningStack);
      } else {
        tokens.push("MAP_GET");
        walkV2(mapCall.key, tokens, constBindings, currentLoopVars, inliningStack);
      }
      return;
    }
  }
  switch (node.type) {
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression": {
      // EXP390 Fix 1 (EXP177): generator↔array SEQUENCE canonicalization. Try
      // the SEQUENCE normalization FIRST (before pushing `FUNCTION`) so a pure-
      // yield generator + a pure array-build/return both emit ONLY `SEQUENCE...`
      // with no function-header tokens. The header carries the type signature
      // but not the sequence semantics — dropping it makes the two forms
      // produce identical token streams.
      if (tryEmitSequenceCanonical(node, tokens, constBindings, currentLoopVars, inliningStack)) {
        return;
      }
      // EXP390 Fix 5 (EXP174): canonicalize the function root token to
      // `FUNCTION` (was `ArrowFunctionExpression`/`FunctionDeclaration`/
      // `FunctionExpression`) so the arrow↔function equivalence class is caught.
      // After `FUNCTION`, push a constant `ID` placeholder for the name slot
      // (the arrow has no name; the function name is a binding, not behavior).
      // The constant `ID` makes named/anonymous/arrow all produce the same token
      // AND restores the token count that was regressed by skipping the `id`
      // child (v6-4 went 30→29 tokens, dropping below the minTokenCount=30
      // threshold). Walk children in canonical order (params, returnType,
      // typeParameters, body). No FP risk: two functions with DIFFERENT bodies
      // still produce different token streams (the body tokens differ).
      tokens.push("FUNCTION");
      tokens.push("ID"); // name-slot placeholder (arrow↔function↔named)
      // EXP390 Fix 5b: normalize arrow expression bodies to the block-body form.
      // `(...) => expr` ↔ `function(...) { return expr; }` — the arrow's
      // expression body is semantically `return expr`. Push `ReturnStatement`
      // before walking the expression so the token stream matches the block-
      // body form (which emits `ReturnStatement` via the ReturnStatement case).
      // Math: lambda calculus (η-expansion — `λx.M` ≡ `λx.λf.M f` for a fresh f;
      // here the fresh `f` is the implicit return). Only for non-BlockStatement
      // bodies (arrow expression bodies); BlockStatement bodies walk normally.
      // EXP108: N5 accumulator-return normalization. Detect the
      // `let x; <if-else-with-x-assignments>; return x;` pattern + emit the
      // transformed body (drop `let x;` + `return x;`, replace `x = expr;`
      // with `ReturnStatement expr;`). This makes the single-return form match
      // the equivalent early-return form. See `detectAccumulatorReturn` above.
      // Checked BEFORE the split-idiom detection (the two patterns are mutually
      // exclusive — the split-idiom requires a const array + for-loop, the
      // accumulator requires a let + if-else chain + return).
      const accName = detectAccumulatorReturn(node);
      if (accName !== undefined) {
        // Walk canonical children (params, returnType, typeParameters, skip
        // body — emit transformed below). Skip the `id` child (EXP174).
        const params = astNodeArray(node.params);
        const returnType = astNode(node.returnType);
        const typeParameters = astNode(node.typeParameters);
        for (const c of params) walkV2(c, tokens, constBindings, new Set(), inliningStack);
        if (returnType !== undefined) walkV2(returnType, tokens, constBindings, new Set(), inliningStack);
        if (typeParameters !== undefined) walkV2(typeParameters, tokens, constBindings, new Set(), inliningStack);
        emitAccumulatorBody(node, accName, tokens, constBindings, inliningStack);
        return;
      }
      // T4b split-idiom: detect the hand-rolled split loop in the body + replace
      // the span with `SPLIT ID STR_<delim-value>` (matching the `str.split(delim)` form).
      const splitSpan = detectSplitIdiom(node);
      if (splitSpan === undefined) {
        // No split idiom — walk canonical children (params, returnType,
        // typeParameters, body) — skip `id` (EXP174). For arrow expression
        // bodies, push `ReturnStatement` first (Fix 5b).
        const params = astNodeArray(node.params);
        const returnType = astNode(node.returnType);
        const typeParameters = astNode(node.typeParameters);
        const fnBody = astNode(node.body);
        for (const c of params) walkV2(c, tokens, constBindings, new Set(), inliningStack);
        if (returnType !== undefined) walkV2(returnType, tokens, constBindings, new Set(), inliningStack);
        if (typeParameters !== undefined) walkV2(typeParameters, tokens, constBindings, new Set(), inliningStack);
        if (fnBody !== undefined) {
          if (fnBody.type === "BlockStatement") {
            walkV2(fnBody, tokens, constBindings, new Set(), inliningStack);
          } else {
            // Arrow expression body — push `ReturnStatement` to match the
            // block-body form `function(...) { return <expr>; }`.
            tokens.push("ReturnStatement");
            walkV2(fnBody, tokens, constBindings, new Set(), inliningStack);
          }
        }
        return;
      }
      // Split-idiom case: walk canonical children; for the body's BlockStatement,
      // emit SPLIT for the span + walk the rest normally.
      const body = astNode(node.body);
      const params = astNodeArray(node.params);
      const returnType = astNode(node.returnType);
      const typeParameters = astNode(node.typeParameters);
      for (const c of params) walkV2(c, tokens, constBindings, new Set(), inliningStack);
      if (returnType !== undefined) walkV2(returnType, tokens, constBindings, new Set(), inliningStack);
      if (typeParameters !== undefined) walkV2(typeParameters, tokens, constBindings, new Set(), inliningStack);
      if (body !== undefined && body.type === "BlockStatement") {
        const bodyStmts = astNodeArray(body.body);
        for (let i = 0; i < bodyStmts.length; i += 1) {
          if (i === splitSpan.startStmtIdx) {
            tokens.push("SPLIT");
            tokens.push("ID"); // str name → ID
            emitSplitDelimToken(splitSpan.delimNode, tokens); // STR_<value> (FINDING 1 fix)
            i = splitSpan.endStmtIdx; // skip to after the span
            continue;
          }
          walkV2(bodyStmts[i]!, tokens, constBindings, new Set(), inliningStack);
        }
      } else if (body !== undefined) {
        walkV2(body, tokens, constBindings, new Set(), inliningStack);
      }
      return;
    }
    case "VariableDeclaration": {
      // EXP390 Fix 3 (EXP179): skip map-like decls (`const/let X = new Map` /
      // `const/let X = {}` where X is in MAP_BINDINGS). The MAP normalization
      // intercepts at use sites (`X.set(k, v)`, `X.get(k)`, `X[k] = v`, `X[k]`),
      // so the decl itself carries no semantic info beyond "X is a map-like
      // binding". Skipping both forms (`new Map` and `{}`) makes them produce
      // the same (empty) token stream for the decl. Single declarator only.
      // EXP390 Fix 3b: for a NON-EMPTY object literal init (`const m = {k: v,...}`),
      // emit `MAP_SET <k> <v>...` for each property (instead of skipping) so the
      // object-literal-build form matches the `.set`-call form:
      // `const m = { a: 1, b: 2 }; m[key]` ↔ `const m = new Map; m.set("a", 1); m.set("b", 2); m.get(key)`
      // both produce `MAP_SET STR_a NUM MAP_SET STR_b NUM... MAP_GET <key>`.
      {
        const decls = astNodeArray(node.declarations);
        if (decls.length === 1) {
          const id = astNode(decls[0]!.id);
          if (id?.type === "Identifier" && MAP_BINDINGS.has(String(id.name))) {
            const init = astNode(decls[0]!.init);
            if (init?.type === "ObjectExpression" && astNodeArray(init.properties).length > 0) {
              // Non-empty object literal — emit MAP_SET for each property.
              // EXP390 Fix 3c: use `emitMapKey` to normalize non-computed
              // Identifier property keys to `STR_<name>` (matches `m.set("a", 1)`).
              for (const p of astNodeArray(init.properties)) {
                if (p.type !== "ObjectProperty" || p.computed === true) continue;
                const keyNode = astNode(p.key);
                const valueNode = astNode(p.value);
                if (keyNode === undefined || valueNode === undefined) continue;
                tokens.push("MAP_SET");
                emitMapKey(keyNode, tokens, constBindings, currentLoopVars, inliningStack);
                walkV2(valueNode, tokens, constBindings, currentLoopVars, inliningStack);
              }
              return;
            }
            return; // skip the decl (`new Map()` or `{}`) — MAP normalization handles use sites
          }
        }
      }
      // EXP390 Fix 4 (EXP180): EXTRACT normalization — `let { p1, p2,... } = obj`
      // (ObjectPattern destructuring) → canonical `EXTRACT <obj> <key1> <value1>
      // [<default1>]...`. Matches the property-access run scan in
      // `emitStmtList` so `let { a, b } = obj` and `let a = obj.a; let b = obj.b`
      // produce the same token stream. Only fires for `let`/`var` with ≥2 simple
      // ObjectProperty properties.
      if (emitDestructuringExtract(node, tokens, constBindings, currentLoopVars, inliningStack, walkV2)) {
        return;
      }
      // T4b split-idiom: if a const/let decl's init is `str.split(delim)`, emit
      // just `SPLIT ID STR_<delim-value>` (no VariableDeclaration wrapper) — matching the
      // hand-rolled loop's SPLIT emission.
      {
        const decls = astNodeArray(node.declarations);
        if (decls.length === 1) {
          const id = astNode(decls[0]!.id);
          const init = astNode(decls[0]!.init);
          if (id?.type === "Identifier" && init?.type === "CallExpression") {
            const splitCall = detectSplitCall(init);
            if (splitCall !== undefined) {
              tokens.push("SPLIT");
              tokens.push("ID");
              emitSplitDelimToken(splitCall.delimNode, tokens); // STR_<value> (FINDING 1 fix)
              return;
            }
          }
        }
      }
      // Round 4 N3 fix: `const/let x = cond? a: b` → distribute into
      // `VariableDeclaration VariableDeclarator <x> DECIDE <test> ExpressionStatement AssignmentExpression <x> <a>
      //... ExpressionStatement AssignmentExpression <x> <b>`
      // (matches `let x; if (cond) x = a; else x = b;` → `VariableDeclaration VariableDeclarator <x> DECIDE...`).
      // The `isSimpleInitializer` change (excludes ConditionalExpression) ensures `const x =
      // ternary` is NOT inlined to use sites, so the ternary stays in place for this
      // distribution to fire. Single declarator with Identifier id + ConditionalExpression init.
      // The `VariableDeclarator` token is emitted explicitly to match the default walk (which
      // walks the VariableDeclarator child → default case → push `VariableDeclarator`).
      {
        const decls = astNodeArray(node.declarations);
        if (decls.length === 1) {
          const id = astNode(decls[0]!.id);
          const init = astNode(decls[0]!.init);
          if (id !== undefined && id.type === "Identifier" && init !== undefined && init.type === "ConditionalExpression") {
            tokens.push(node.type); // VariableDeclaration
            tokens.push("VariableDeclarator"); // the declarator wrapper (matches default walk)
            walkV2(id, tokens, constBindings, currentLoopVars, inliningStack); // declarator id → ID (or ID_NUM)
            emitTernaryDecision(init, tokens, constBindings, currentLoopVars, inliningStack,
              (branch, t, cb, lv, is) => {
                t.push("ExpressionStatement");
                t.push("AssignmentExpression");
                walkV2(id, t, cb, lv, is); // LHS: x → ID (re-walk the declarator id)
                walkV2(branch, t, cb, lv, is); // RHS: the branch value
              });
            return;
          }
        }
      }
      if (node.kind === "const") {
        // Round 5.2: shared `shouldSkipConstDecl` helper (was duplicated in
        // walkV2 + walkIterationBody). Skips const decls whose every declarator
        // is a bound Identifier in `constBindings` (inlined at use sites).
        if (shouldSkipConstDecl(node, constBindings)) return; // skip — inlined at use sites
      }
      tokens.push(node.type);
      for (const c of astChildren(node)) walkV2(c, tokens, constBindings, currentLoopVars, inliningStack);
      return;
    }
    case "Identifier":
    case "PrivateName": {
      // Round 5.2: shared `emitIdentifierToken` helper (was duplicated in
      // walkV2 + walkIterationBody, ~15 lines each, IDENTICAL modulo walkFn).
      // Handles const inlining (with cycle guard) + `ID_NUM` for known-numeric
      // Identifiers (Round 4 Fix 2 / Round 5.1).
      emitIdentifierToken(String(node.name), tokens, constBindings, currentLoopVars, inliningStack, walkV2);
      return;
    }
    case "StringLiteral": {
      // Round 5.2: shared `emitStringLiteralToken` helper (was duplicated,
      // IDENTICAL). Round 4 A4: `STR_<value>` (or `STR_<sha16>` for long/pipe
      // values) — preserves the string value in the token stream (fixes the
      // A4 pre-existing FP surface + the N3-CTRL FP).
      emitStringLiteralToken(node, tokens);
      return;
    }
    case "NumericLiteral": tokens.push("NUM"); return;
    case "RegExpLiteral": tokens.push("REGEX"); return;
    case "BigIntLiteral": tokens.push("BIGINT"); return;
    case "BooleanLiteral": tokens.push("BOOL"); return;
    case "NullLiteral": tokens.push("NULL"); return;
    case "TemplateLiteral":
      // TemplateLiteral has children (quasi + expression substitutions) — recurse.
      tokens.push("TPL");
      for (const c of astChildren(node)) walkV2(c, tokens, constBindings, currentLoopVars, inliningStack);
      return;
    case "ForStatement": {
      // EXP126: `for (let i = 0; i < arr.length; i++) { const v = arr[i]; <body> }`
      // = indexed iteration over the array. Normalize to
      // `<arr> ITERATE_ARR <body with __ELEM__> END_ITERATE_ARR`. The element name
      // is removed from constBindings (via the elemNameStack check in
      // `emitIdentifierToken`) so `v` is NOT inlined — matches for-of's `v`.
      const forIdx = detectForIndexOverArray(node);
      if (forIdx !== undefined) {
        emitIterateArrEnvelope(
          forIdx.arrNode,
          () => {
            for (const s of forIdx.bodyStmts) walkV2(s, tokens, new Map(constBindings), currentLoopVars, inliningStack);
          },
          forIdx.elemName,
          tokens,
          constBindings,
          currentLoopVars,
          inliningStack,
        );
        return;
      }
      // Fall through to the canonical LOOP token (not a forward for-i-over-arr[i]).
      emitLoopToken(node, tokens, constBindings, currentLoopVars, inliningStack, walkV2);
      return;
    }
    case "ForOfStatement": {
      // EXP126: `for (const v of arr) { <body> }` = direct iteration over the
      // array. Normalize to `<arr> ITERATE_ARR <body with __ELEM__>
      // END_ITERATE_ARR`.
      // EXP362: `for (const key of Object.keys(obj))` = key iteration over an
      // object. Normalize to `<obj> ITERATE_KEYS <body with __ELEM__>
      // END_ITERATE_KEYS` (matches for-in below). Check Object.keys FIRST so the
      // plain-array for-of falls through to detectForOfArrayLoop.
      const forOfKeys = detectForOfObjectKeysLoop(node);
      if (forOfKeys !== undefined) {
        emitIterateArrEnvelope(
          forOfKeys.arrNode,
          () => walkV2(forOfKeys.body, tokens, new Map(constBindings), currentLoopVars, inliningStack),
          forOfKeys.elemName,
          tokens,
          constBindings,
          currentLoopVars,
          inliningStack,
          "ITERATE_KEYS",
        );
        return;
      }
      const forOf = detectForOfArrayLoop(node);
      if (forOf !== undefined) {
        emitIterateArrEnvelope(
          forOf.arrNode,
          () => walkV2(forOf.body, tokens, new Map(constBindings), currentLoopVars, inliningStack),
          forOf.elemName,
          tokens,
          constBindings,
          currentLoopVars,
          inliningStack,
        );
        return;
      }
      // Fall through to default (shouldn't happen — detectForOfArrayLoop only
      // rejects non-canonical for-of, which then walks children normally).
      tokens.push(node.type);
      for (const c of astChildren(node)) walkV2(c, tokens, constBindings, currentLoopVars, inliningStack);
      return;
    }
    case "ForInStatement": {
      // EXP362: `for (const key in obj)` = key iteration over an object. Normalize
      // to `<obj> ITERATE_KEYS <body with __ELEM__> END_ITERATE_KEYS` — matching
      // `for (const key of Object.keys(obj))` (the N6 fix). Uses the distinct
      // `ITERATE_KEYS` token (not `ITERATE_ARR`) so value-iteration (for-of over
      // an array) does NOT match key-iteration (for-in / for-of-Object.keys) —
      // different semantics, no FP. Non-canonical for-in (non-const, non-Identifier
      // key/object) falls through to default.
      const forIn = detectForInOverObject(node);
      if (forIn !== undefined) {
        emitIterateArrEnvelope(
          forIn.arrNode,
          () => walkV2(forIn.body, tokens, new Map(constBindings), currentLoopVars, inliningStack),
          forIn.elemName,
          tokens,
          constBindings,
          currentLoopVars,
          inliningStack,
          "ITERATE_KEYS",
        );
        return;
      }
      tokens.push(node.type);
      for (const c of astChildren(node)) walkV2(c, tokens, constBindings, currentLoopVars, inliningStack);
      return;
    }
    case "WhileStatement":
    case "DoWhileStatement": {
      // Round 5.2: shared `emitLoopToken` helper (was duplicated in walkV2 +
      // walkIterationBody, IDENTICAL modulo walkFn). Canonical `LOOP` token;
      // for-init hoisted before LOOP; for-update DROPPED (loop mechanic);
      // test + body walked with the new loopVars.
      emitLoopToken(node, tokens, constBindings, currentLoopVars, inliningStack, walkV2);
      return;
    }
    case "IfStatement": {
      // Round 5.2: shared `emitIfStatementTokens` helper (was duplicated, ~40
      // lines each, modulo the trailing-else-if-continue drop which is Pass 2.5
      // only). Pass 2 passes `trailingElseIfContinueDrop = false` (no drop).
      emitIfStatementTokens(node, tokens, constBindings, currentLoopVars, inliningStack, walkV2, undefined, false);
      return;
    }
    case "SwitchStatement": {
      // Round 5.2: shared `emitSwitchStatementTokens` helper (was duplicated,
      // ~30 lines each; the walkIterationBody version inlined the equality-test
      // logic, now delegated to `emitDecisionTest` with walkFn). Pass 2 passes
      // `letDrop = undefined` (no let-binding drop).
      emitSwitchStatementTokens(node, tokens, constBindings, currentLoopVars, inliningStack, walkV2, undefined);
      return;
    }
    case "BlockStatement": {
      // Symmetric BlockStatement drop: a block is a pure grouping construct;
      // the `{ }` wrapper carries no semantic info beyond its statements
      // (the `directives` field holds legacy directives like "use strict",
      // which are implicit in ES modules and are NOT walked here). Always
      // drop the wrapper token and emit only the statements (after loop-update
      // stripping). This makes `withConst { const x = 5; return x; }` and
      // `inlined { return 5; }` produce the same token stream after const
      // inlining, AND makes both forms of O6 (if-chain vs switch) produce
      // the same stream regardless of how many top-level statements each
      // body has. The previous logic dropped the wrapper only for
      // single-statement bodies, which created an asymmetry: a 2-statement
      // body (const-decl + switch) emitted `BlockStatement` but a
      // 1-statement body didn't — mismatching the if-chain form. Symmetric
      // dropping fixes FINDING 2 + improves O6 (0.9329 → 1.0000) without
      // regressing any pair.
      //
      // Sources:
      // - Babel AST spec (github.com/babel/babel, MIT): BlockStatement{body,
      // directives} — `directives` is the only non-body field.
      // https://github.com/babel/babel/blob/main/packages/babel-parser/ast/spec.md
      // - jsinspect (danielstjules/jsinspect, MIT): KEEPS BlockStatement as a
      // structural marker (and does NOT normalize if↔switch). Our detector
      // is more aggressive — consistent with the Round 1 single-stmt drop.
      // - cargo-dupes (mpecan/cargo-dupes, Rust): PRESERVES `Block` as a node.
      // Same conservative approach. Our `symdrop` is a deliberate trade:
      // catch more semantic clones (O6, the finding cases) at the cost of a
      // theoretical false positive on block-scoped `let`/`const` referenced
      // outside the block (a runtime error in practice — devs don't write it).
      //
      // Round 5.2: `emitStmtList` now takes `walkFn` + optional `letDrop` (merged
      // with the old `emitIterationBodyStmtList`). Pass 2 passes `walkV2` +
      // `letDrop = undefined` (no let-binding drop).
      emitStmtList(astNodeArray(node.body), tokens, constBindings, currentLoopVars, inliningStack, walkV2);
      return;
    }
    case "BinaryExpression": {
      // Round 5.2: shared `emitBinaryExpressionToken` helper (was duplicated,
      // IDENTICAL modulo walkFn). Round 3 A5: type-aware commutative-operand
      // reorder (via `emitCommutativeBinary`, which itself takes `walkFn`).
      // Round 4 Fix 1: emit the operator in the token (`BinaryExpression_<op>`)
      // so different operators produce different tokens (eliminates operator-dropping FP).
      emitBinaryExpressionToken(node, tokens, constBindings, currentLoopVars, inliningStack, walkV2);
      return;
    }
    case "ReturnStatement": {
      // Round 4 N3 fix: `return x? a: b` → distribute into
      // `DECIDE <test> ReturnStatement <a> ReturnStatement <b>`
      // (matches `if (x) return a; else return b;` → `DECIDE <test> ReturnStatement <a> ReturnStatement <b>`).
      // Sources: babel-plugin-transform-ternary-to-if-else (OpenGG, MIT, commit 1441ca53) —
      // confirmed the ternary↔if-else equivalence via IIFE wrapping; adapted at the token level.
      const arg = astNode(node.argument);
      if (arg !== undefined && arg.type === "ConditionalExpression") {
        emitTernaryDecision(arg, tokens, constBindings, currentLoopVars, inliningStack,
          (branch, t, cb, lv, is) => { t.push("ReturnStatement"); walkV2(branch, t, cb, lv, is); });
        return;
      }
      // EXP390 Fix 2b (EXP178): promise-catch form in ReturnStatement position.
      // `return <expr>.catch(h)` or `return <expr>.then(cb).catch(h)` (possibly
      // wrapped in `await`) — emit the TRY_CATCH envelope (matches the
      // ExpressionStatement form and the try-catch form). The ReturnStatement
      // wrapper is dropped (the TRY_CATCH envelope replaces it).
      if (arg !== undefined) {
        const callNode = unwrapAwaitCall(arg);
        if (callNode !== undefined && callNode.type === "CallExpression") {
          const promiseCatch = detectPromiseCatchCall(callNode);
          if (promiseCatch !== undefined) {
            emitTryCatchEnvelope(
              promiseCatch.successBody,
              promiseCatch.handlerBody,
              promiseCatch.errName,
              promiseCatch.valName,
              tokens, constBindings, currentLoopVars, inliningStack,
            );
            return;
          }
        }
      }
      // EXP403: N5 find+nullish normalization in ReturnStatement position.
      // `return arr.find(pred)?? <fallback>` (or bare `return arr.find(pred)`)
      // → emit the `ITERATE_ARR DECIDE <pred-body> ReturnStatement __ELEM__
      // END_ITERATE_ARR ReturnStatement <fallback>` envelope (matches the
      // early-return form `for (const x of arr) { if (pred(x)) return x; }
      // return <fallback>;`). The ReturnStatement wrapper is DROPPED (the
      // envelope replaces it — same as the TRY_CATCH normalization above).
      // The `?? <fallback>` is the after-loop continuation; bare `arr.find`
      // (no `??`) has no trailing ReturnStatement (implicit `undefined`).
      // CPS: `return (arr.find(pred)?? fallback)` = `bind(find(arr,pred), k)`
      // where `k(x)=return x` and after-loop = `return fallback`.
      if (arg !== undefined) {
        // Form 1: `arr.find(pred)?? <fallback>` — LogicalExpression(??,...).
        if (arg.type === "LogicalExpression" && arg.operator === "??") {
          const left = astNode(arg.left);
          if (left !== undefined && left.type === "CallExpression") {
            const findCall = detectFindCall(left);
            if (findCall !== undefined) {
              emitFindNullishEnvelope(
                findCall.arrNode, findCall.predBody, findCall.elemName,
                astNode(arg.right),
                tokens, constBindings, currentLoopVars, inliningStack,
              );
              return;
            }
          }
        }
        // Form 2: bare `arr.find(pred)` (no `??`) — fallback is implicit
        // `undefined` → no trailing ReturnStatement.
        if (arg.type === "CallExpression") {
          const findCall = detectFindCall(arg);
          if (findCall !== undefined) {
            emitFindNullishEnvelope(
              findCall.arrNode, findCall.predBody, findCall.elemName,
              undefined, // no fallback → no trailing ReturnStatement
              tokens, constBindings, currentLoopVars, inliningStack,
            );
            return;
          }
        }
      }
      tokens.push(node.type);
      for (const c of astChildren(node)) walkV2(c, tokens, constBindings, currentLoopVars, inliningStack);
      return;
    }
    case "ExpressionStatement": {
      // EXP390 Fix 3d: drop the `ExpressionStatement` wrapper for map operations
      // (`m.set(k, v)`, `m.get(k)`, `m[k] = v`) so the Map form matches the object-
      // literal form (which emits MAP_SET/MAP_GET directly, no statement wrapper).
      // `m.set("a", 1); m.set("b", 2);` → `MAP_SET STR_a NUM MAP_SET STR_b NUM`
      // matches `{ a: 1, b: 2 }` → `MAP_SET STR_a NUM MAP_SET STR_b NUM`.
      {
        const expr0 = astNode(node.expression);
        if (expr0 !== undefined) {
          let isMapOp = false;
          if (expr0.type === "CallExpression") {
            if (detectMapCall(expr0) !== undefined) isMapOp = true;
          } else if (expr0.type === "AssignmentExpression" && expr0.operator === "=") {
            if (detectMapMemberAssign(expr0) !== undefined) isMapOp = true;
          }
          if (isMapOp) {
            // Walk the expression directly — the pre-switch block (CallExpression)
            // or the AssignmentExpression case will emit MAP_SET/MAP_GET.
            walkV2(expr0, tokens, constBindings, currentLoopVars, inliningStack);
            return;
          }
        }
      }
      // Round 4 N3 fix: `x = cond? a: b` (ExpressionStatement wrapping
      // AssignmentExpression(target, ConditionalExpression)) → distribute into
      // `DECIDE <test> ExpressionStatement AssignmentExpression <x> <a>
      // ExpressionStatement AssignmentExpression <x> <b>`
      // (matches `if (cond) x = a; else x = b;`).
      const expr = astNode(node.expression);
      if (expr !== undefined && expr.type === "AssignmentExpression" && expr.operator === "=") {
        const left = astNode(expr.left);
        const right = astNode(expr.right);
        if (left !== undefined && right !== undefined && right.type === "ConditionalExpression") {
          // EXP390 Fix 3 (EXP179): MAP normalization for `X[k] = cond? a: b`
          // (map-like X, computed). Intercept BEFORE the ternary distribution:
          // emit `ExpressionStatement MAP_SET <k> DECIDE <test> <a> <b>` so it
          // matches `m.set(k, cond? a: b)` →
          // `ExpressionStatement MAP_SET <k> DECIDE <test> <a> <b>`. Falls
          // through to the default distribution for non-map-like assignments.
          const mapAssign = detectMapMemberAssign(expr);
          if (mapAssign !== undefined) {
            tokens.push("ExpressionStatement"); // match the default walk's wrapper
            tokens.push("MAP_SET");
            walkV2(mapAssign.key, tokens, constBindings, currentLoopVars, inliningStack);
            emitTernaryDecision(right, tokens, constBindings, currentLoopVars, inliningStack,
              (branch, t, cb, lv, is) => walkV2(branch, t, cb, lv, is));
            return;
          }
          emitTernaryDecision(right, tokens, constBindings, currentLoopVars, inliningStack,
            (branch, t, cb, lv, is) => {
              t.push("ExpressionStatement");
              t.push("AssignmentExpression");
              walkV2(left, t, cb, lv, is); // LHS: the assignment target
              walkV2(branch, t, cb, lv, is); // RHS: the branch value
            });
          return;
        }
      }
      // EXP390 Fix 2 (EXP178): promise-catch form. Detect `<expr>.catch(h)` or
      // `<expr>.then(cb).catch(h)`, possibly wrapped in `await`. The
      // ExpressionStatement + AwaitExpression wrappers are dropped (the
      // TRY_CATCH envelope replaces them). Matches the try-catch form
      // (TryStatement case below).
      if (expr !== undefined) {
        const callNode = unwrapAwaitCall(expr);
        if (callNode !== undefined && callNode.type === "CallExpression") {
          const promiseCatch = detectPromiseCatchCall(callNode);
          if (promiseCatch !== undefined) {
            emitTryCatchEnvelope(
              promiseCatch.successBody,
              promiseCatch.handlerBody,
              promiseCatch.errName,
              promiseCatch.valName,
              tokens, constBindings, currentLoopVars, inliningStack,
            );
            return;
          }
        }
      }
      // EXP126: `arr.forEach(cb);` or `arr.map(cb);` as a statement (result
      // discarded) — the callback iteration forms. `forEach` returns undefined
      // (monadic functor — always safe to normalize); `map` returns a new array
      // (pure functor — only equivalent when the result is discarded, i.e. as
      // an ExpressionStatement). Normalize BOTH to
      // `<arr> ITERATE_ARR <body with __ELEM__> END_ITERATE_ARR`. Handling these
      // at the ExpressionStatement level (NOT at the CallExpression level) skips
      // the `ExpressionStatement` wrapper token, making the token stream
      // IDENTICAL to for-i/for-of (which are statements directly, no wrapper).
      // `const r = arr.map(cb)` is NOT normalized (map result is used — different
      // functor); `arr.forEach(cb)` in non-statement context (rare) falls
      // through to default CallExpression handling.
      if (expr !== undefined && expr.type === "CallExpression") {
        const cbCall = detectArrayCallbackCall(expr);
        if (cbCall !== undefined && (cbCall.kind === "forEach" || cbCall.kind === "map")) {
          emitIterateArrEnvelope(
            cbCall.arrNode,
            () => walkV2(cbCall.body, tokens, new Map(constBindings), currentLoopVars, inliningStack),
            cbCall.elemName,
            tokens,
            constBindings,
            currentLoopVars,
            inliningStack,
          );
          return;
        }
      }
      tokens.push(node.type);
      for (const c of astChildren(node)) walkV2(c, tokens, constBindings, currentLoopVars, inliningStack);
      return;
    }
    case "ConditionalExpression": {
      // Round 4 N3 fix: standalone ternary `x? a: b` (in function args, array
      // elements, object properties, etc.) → `DECIDE <test> <cons> <alt>`.
      // No equivalent if-else in expression position (you can't write
      // `foo(if (x) a; else b;)`), so no FP risk. The DECIDE normalization aligns
      // with IfStatement's DECIDE (automata theory: both reduce to the same DECIDE
      // state in the CFG).
      emitTernaryDecision(node, tokens, constBindings, currentLoopVars, inliningStack,
        (branch, t, cb, lv, is) => walkV2(branch, t, cb, lv, is));
      return;
    }
    case "AssignmentExpression": {
      // EXP390 Fix 3 (EXP179): MAP normalization for `X[k] = v` (X map-like,
      // computed). Canonicalizes to `MAP_SET <k> <v>` so the object form
      // `o[k] = v` aligns with the Map form `m.set(k, v)` (handled in the
      // CallExpression pre-switch block). Only fires for operator `=` and only
      // for computed MemberExpression left (`o[k]`, not `o.k`).
      const mapAssign = detectMapMemberAssign(node);
      if (mapAssign !== undefined) {
        tokens.push("MAP_SET");
        walkV2(mapAssign.key, tokens, constBindings, currentLoopVars, inliningStack);
        walkV2(mapAssign.value, tokens, constBindings, currentLoopVars, inliningStack);
        return;
      }
      // EXP362: `arr = [...arr, x]` spread-append → canonical `APPEND ID <x>`
      // (matches `arr.push(x)` from the CallExpression block above — the N4
      // mutation↔immutable fix). Only the constrained pattern (single spread of
      // the same Identifier + one appended element) is normalized; all other
      // assignments fall through to the default walk.
      const spreadAppend = detectAppendSpread(node);
      if (spreadAppend !== undefined) {
        emitAppendTokens(spreadAppend.arrName, spreadAppend.argNode, tokens, constBindings, currentLoopVars, inliningStack);
        return;
      }
      // EXP390 Fix 6 (N4 harder): `arr = [x,...arr]` spread-prepend → canonical
      // `PREPEND ID <x>` (matches `arr.unshift(x)` from the CallExpression block
      // above — the N4 prepend mutation↔immutable fix, dual of APPEND).
      const spreadPrepend = detectPrependSpread(node);
      if (spreadPrepend !== undefined) {
        emitPrependTokens(spreadPrepend.arrName, spreadPrepend.argNode, tokens, constBindings, currentLoopVars, inliningStack);
        return;
      }
      tokens.push(node.type);
      for (const c of astChildren(node)) walkV2(c, tokens, constBindings, currentLoopVars, inliningStack);
      return;
    }
    case "MemberExpression": {
      // EXP390 Fix 3 (EXP179): MAP normalization for `X[k]` (X map-like,
      // computed READ). Canonicalizes to `MAP_GET <k>` so the object form
      // `o[key]` aligns with the Map form `m.get(key)` (handled in the
      // CallExpression pre-switch block). The AssignmentExpression case
      // intercepts `X[k] = v` BEFORE the MemberExpression is walked, so this
      // case only sees `X[k]` in READ contexts. Falls through to default for
      // non-map-like member access (dot or computed on a non-map-like binding).
      const mapRead = detectMapMemberRead(node);
      if (mapRead !== undefined) {
        tokens.push("MAP_GET");
        walkV2(mapRead.key, tokens, constBindings, currentLoopVars, inliningStack);
        return;
      }
      tokens.push(node.type);
      for (const c of astChildren(node)) walkV2(c, tokens, constBindings, currentLoopVars, inliningStack);
      return;
    }
    case "TryStatement": {
      // EXP390 Fix 2 (EXP178): try-catch form. Detect `try { <body> } catch (e)
      // { <handler> }` (no finally) and emit the canonical TRY_CATCH envelope.
      // The TryStatement + CatchClause wrappers are dropped (the TRY_CATCH
      // envelope replaces them). Matches the promise-catch form
      // (ExpressionStatement case above).
      const tryCatch = detectTryCatchTryStatement(node);
      if (tryCatch !== undefined) {
        emitTryCatchEnvelope(
          tryCatch.successBody,
          tryCatch.handlerBody,
          tryCatch.errName,
          undefined, // try-catch has no .then cb param — AwaitExpression
                     // inside the try body emits `__VAL__` via the
                     // AwaitExpression case below.
          tokens, constBindings, currentLoopVars, inliningStack,
        );
        return;
      }
      tokens.push(node.type);
      for (const c of astChildren(node)) walkV2(c, tokens, constBindings, currentLoopVars, inliningStack);
      return;
    }
    case "AwaitExpression": {
      // EXP390 Fix 2 (EXP178): if inside a TRY_CATCH success body of the
      // try-catch form (tryCatchAwaitDepth > 0), the awaited value is the
      // canonical `__VAL__` placeholder. Drop the AwaitExpression wrapper (it
      // carries no semantic info beyond "this is async", which is implicit in
      // both forms — same as the ASYNC_RESOLVE / TSNonNull drops). Matches the
      //.then cb param (`v` → `__VAL__` via valNameStack) in the promise.then
      // form. Outside a TRY_CATCH, default walk.
      if (tryCatchAwaitDepth > 0) {
        tokens.push("__VAL__");
        return;
      }
      tokens.push(node.type);
      for (const c of astChildren(node)) walkV2(c, tokens, constBindings, currentLoopVars, inliningStack);
      return;
    }
    case "TSNonNullExpression": {
      // Round 5.3 T4c fix: drop the `!` non-null assertion wrapper. TypeScript's
      // `!` operator is a COMPILE-TIME type assertion that is ERASED at runtime
      // (confirmed: stackoverflow.com/questions/74377220, CC-BY-SA 4.0 — "Non-null
      // assertions are not done at runtime. The JavaScript code will be just:
      // <inner expression>"). So `x!.y` and `x.y` produce identical JavaScript.
      // Dropping the wrapper is the same principle as the symmetric BlockStatement
      // drop (Round 1 fix-up #2): a pure wrapper carries no semantic info beyond
      // its content. This closes the T4c gap: the mutant has `tokens.at(-1)!.value`
      // (with `!`) while the original's inlined form is `tokens.at(-1).value` (no `!`
      // — the `const prev = tokens.at(-1)` declaration is typed, so no `!` needed).
      // After inlining + this drop, both produce the same token stream → Jaccard 1.0.
      // FP risk: NONE — two functions that differ only by `!` assertions are
      // runtime-equivalent → catching them is a TP, not a FP.
      const inner = astNode((node as { expression?: unknown }).expression);
      if (inner !== undefined) walkV2(inner, tokens, constBindings, currentLoopVars, inliningStack);
      return;
    }
    default:
      tokens.push(node.type);
      for (const c of astChildren(node)) walkV2(c, tokens, constBindings, currentLoopVars, inliningStack);
      return;
  }
}

/** Compute the V2 normalized token stream for a function node (CFG + data-flow
 * normalization). Used by Pass-2 Jaccard. The `normalizedHash` (allowlist) still
 * uses the old `normalizeTokens` for stability. */
function normalizeTokensV2(fnNode: AstNode): string[] {
  KNOWN_NUMERIC = collectKnownNumeric(fnNode);
  // EXP390 Fix 3 (EXP179): collect map-like bindings (X = new Map or X = {}
  // used with computed access) so the MAP normalization can fire at use sites.
  // Map-like bindings are EXCLUDED from `constBindings` (so they're NOT inlined
  // — the MAP normalization needs to see `X.set(k, v)` / `X[k] = v` / `X[k]` at
  // use sites, not the inlined `new Map` / `{}` form).
  MAP_BINDINGS = collectMapBindings(fnNode);
  const constBindings = collectConstBindings(fnNode);
  for (const name of MAP_BINDINGS) constBindings.delete(name);
  const tokens: string[] = [];
  walkV2(fnNode, tokens, constBindings, new Set(), new Set());
  return tokens;
}

// ============================================================================
// T4a sub-body extraction pass (Round 2) — iteration body comparison.
// Extracts the "iteration body" (the per-iteration logic) from:
// (a) a function containing a for-loop: the for-loop's body statements (after
// stripping loop-var updates), with trailing-else-if-continue drop.
// (b) a self-tail-recursive function: the body statements between the loop-exit
// test (first `if (i >= N) return...`) and the tail call (last `return
// self(args)`), with let-binding drop + compound-assignment normalization.
// Then compares iteration bodies pairwise via Jaccard. This catches T4a
// (loop↔recursion) at Jaccard 1.0000 with no false positives on control pairs.
//
// The extra normalizations (compound-assignment, let-binding drop,
// trailing-else-if-continue drop) are ONLY applied in this pass — not in the
// main walkV2 (Pass 2) — to avoid affecting the existing Pass 2 behavior.
//
// Sources: TCO algorithm from DavidTimms/tail-call-eliminator (MIT) — see
// research/round2-t4a-t4b/tail-call-eliminator-source.md. No code extracted —
// the iteration body extraction + normalizations are original.
// ============================================================================

/** Detect a self-tail-recursive function: a named function whose body's last
 * top-level statement is `return self(args)` (tail call to itself). Returns the
 * set of param names that CHANGE between iterations (the "loop variables"). */
function detectTailRecursion(fnNode: AstNode): { isTailRecursive: true; loopVarsFromTailCall: Set<string>; } | { isTailRecursive: false } {
  const id = astNode(fnNode.id);
  const fnName = id?.type === "Identifier" ? String(id.name) : undefined;
  if (fnName === undefined) return { isTailRecursive: false };
  const body = astNode(fnNode.body);
  if (body === undefined || body.type !== "BlockStatement") return { isTailRecursive: false };
  const stmts = astNodeArray(body.body);
  if (stmts.length === 0) return { isTailRecursive: false };
  const last = stmts[stmts.length - 1]!;
  if (last.type !== "ReturnStatement") return { isTailRecursive: false };
  const call = astNode(last.argument);
  if (call === undefined || call.type !== "CallExpression") return { isTailRecursive: false };
  const callee = astNode(call.callee);
  if (callee === undefined || callee.type !== "Identifier" || String(callee.name) !== fnName) return { isTailRecursive: false };
  const params = astNodeArray(fnNode.params).map((p) => p.type === "Identifier" ? String(p.name) : undefined);
  const args = astNodeArray(call.arguments);
  const loopVars = new Set<string>();
  for (let i = 0; i < Math.min(params.length, args.length); i += 1) {
    const pName = params[i];
    const arg = args[i];
    if (pName === undefined) continue;
    if (arg === undefined || arg.type !== "Identifier" || String(arg.name) !== pName) {
      loopVars.add(pName);
    }
  }
  return { isTailRecursive: true, loopVarsFromTailCall: loopVars };
}

/** True if `node` is a ContinueStatement or a BlockStatement whose sole statement
 * is a ContinueStatement. */
function isSoleContinue(node: AstNode | undefined): boolean {
  if (node === undefined) return false;
  if (node.type === "ContinueStatement") return true;
  if (node.type === "BlockStatement") {
    const ss = astNodeArray(node.body);
    return ss.length === 1 && ss[0]!.type === "ContinueStatement";
  }
  return false;
}

/** Collect `let nextX = X` bindings (single declarator, Identifier init) to drop
 * in the iteration body. These are the "immutable state" pattern (`let nextX = X;
 * nextX = <expr>;...; tailCall(..., nextX,...)`) — dropping the `let nextX = X`
 * declaration aligns the recursive form with the mutation form. */
function collectLetAliasBindings(fnNode: AstNode): Set<string> {
  const bindings = new Set<string>();
  const body = astNode(fnNode.body);
  if (body === undefined || body.type !== "BlockStatement") return bindings;
  walk(body, (n) => {
    if (n.type === "VariableDeclaration" && n.kind === "let") {
      const decls = astNodeArray(n.declarations);
      if (decls.length === 1) {
        const id = astNode(decls[0]!.id);
        const init = astNode(decls[0]!.init);
        if (id?.type === "Identifier" && init?.type === "Identifier") {
          bindings.add(String(id.name));
        }
      }
    }
  });
  return bindings;
}

/** The iteration-body walker. A simplified version of walkV2 with these EXTRA
 * normalizations (only in this pass, not in the main walkV2):
 * - Compound-assignment normalization: `X += Y` → `X = X + Y` (emits
 * `AssignmentExpression <left> BinaryExpression <left> <right>`).
 * - Let-binding drop: `let nextX = X` declarations are skipped (the nextX
 * variable is treated as an alias for X in the iteration body).
 * - Trailing-else-if-continue drop: if an IfStatement's alternate is an
 * IfStatement whose consequent is a ContinueStatement (sole statement), the
 * alternate is dropped. Safe because continue is a no-op when the if is the
 * last statement of the loop body (skips nothing).
 * Uses the same const inlining + CFG normalization + symmetric BlockStatement
 * drop as the main walkV2. */
function walkIterationBody(
  node: AstNode,
  tokens: string[],
  constBindings: Map<string, AstNode>,
  currentLoopVars: Set<string>,
  inliningStack: Set<string>,
  letDrop: Set<string>,
): void {
  // Round 5.2: shared helpers take `walkFn` (the higher-order strategy
  // parameter). The thunk closes over `letDrop` so the shared helpers can
  // recurse into `walkIterationBody` without knowing about `letDrop`. This is
  // the same pattern `emitCommutativeBinary` already uses (line ~1897 before the
  // refactor). Defined once per `walkIterationBody` call; the closure captures
  // `letDrop` (a Set, never mutated — passed through unchanged).
  const walkFn: WalkFn = (n, t, cb, lv, is) => walkIterationBody(n, t, cb, lv, is, letDrop);
  switch (node.type) {
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression": {
      tokens.push(node.type);
      // Reset loop vars (nested function is not in the enclosing loop). KEEP the
      // inliningStack: if a const's init contains a nested function that references
      // the same const, keeping the stack prevents infinite re-inlining (the const
      // is already in the stack, so it emits "ID" instead of re-inlining).
      for (const c of astChildren(node)) walkIterationBody(c, tokens, constBindings, new Set(), inliningStack, letDrop);
      return;
    }
    case "VariableDeclaration": {
      // Let-binding drop: skip `let nextX = X` declarations (Pass 2.5 only).
      if (node.kind === "let" && letDrop.size > 0) {
        const decls = astNodeArray(node.declarations);
        if (decls.length === 1) {
          const id = astNode(decls[0]!.id);
          const init = astNode(decls[0]!.init);
          if (id?.type === "Identifier" && init?.type === "Identifier" && letDrop.has(String(id.name))) {
            return; // skip — dropped
          }
        }
      }
      // Round 5.2: shared `shouldSkipConstDecl` helper (was duplicated in
      // walkV2 + walkIterationBody).
      if (shouldSkipConstDecl(node, constBindings)) return;
      tokens.push(node.type);
      for (const c of astChildren(node)) walkIterationBody(c, tokens, constBindings, currentLoopVars, inliningStack, letDrop);
      return;
    }
    case "Identifier":
    case "PrivateName": {
      // Round 5.2: shared `emitIdentifierToken` helper (was duplicated, ~15
      // lines each, IDENTICAL modulo walkFn). Round 5.1: `ID_NUM` for
      // known-numeric Identifiers (same as walkV2), applied CONDITIONALLY per
      // pair in Pass 2.5 (`pass25IterationBodyJaccard`): when both forms'
      // KNOWN_NUMERIC sets are EQUAL, the with-ID_NUM shingles are used;
      // when the sets DIFFER, the fallback `ID_NUM → ID` shingles are used
      // (avoids regressing T4a/A1 where the for-loop form infers more numerics
      // via `let x = 0` than the recursive form's params). The token stream is
      // computed WITH ID_NUM here; the fallback is a cheap `ID_NUM → ID`
      // transform at comparison time.
      emitIdentifierToken(String(node.name), tokens, constBindings, currentLoopVars, inliningStack, walkFn);
      return;
    }
    case "StringLiteral": {
      // Round 5.2: shared `emitStringLiteralToken` helper (was duplicated,
      // IDENTICAL). Round 4 A4: `STR_<value>` (same as walkV2).
      emitStringLiteralToken(node, tokens);
      return;
    }
    case "NumericLiteral": tokens.push("NUM"); return;
    case "RegExpLiteral": tokens.push("REGEX"); return;
    case "BigIntLiteral": tokens.push("BIGINT"); return;
    case "BooleanLiteral": tokens.push("BOOL"); return;
    case "NullLiteral": tokens.push("NULL"); return;
    case "TemplateLiteral":
      tokens.push("TPL");
      for (const c of astChildren(node)) walkIterationBody(c, tokens, constBindings, currentLoopVars, inliningStack, letDrop);
      return;
    case "ForStatement":
    case "WhileStatement":
    case "DoWhileStatement": {
      // Round 5.2: shared `emitLoopToken` helper (was duplicated, IDENTICAL
      // modulo walkFn).
      emitLoopToken(node, tokens, constBindings, currentLoopVars, inliningStack, walkFn);
      return;
    }
    case "AssignmentExpression": {
      // Compound-assignment normalization: `X += Y` → `X = X + Y` (Pass 2.5 only).
      // Stays in walkIterationBody (NOT in walkV2 — walkV2 has no AssignmentExpression
      // case, falls through to default which emits `AssignmentExpression` + walks
      // children without expansion).
      if (node.operator === "+=" || node.operator === "-=" || node.operator === "*=" || node.operator === "/=" || node.operator === "%=") {
        const left = astNode(node.left);
        const right = astNode(node.right);
        tokens.push("AssignmentExpression");
        // LHS of `=`: X (the assignment target — emitted first, NOT reordered).
        if (left !== undefined) walkIterationBody(left, tokens, constBindings, currentLoopVars, inliningStack, letDrop);
        // Round 4 Fix 1: emit the operator in the token. `X += Y` expands to `X = X + Y`,
        // so the BinaryExpression operator is the arithmetic part of the compound-assignment
        // operator (`+=` → `+`, `-=` → `-`, `*=` → `*`, `/=` → `/`, `%=` → `%`).
        // EXP403: apply the SAME commutative-operand reorder as `emitCommutativeBinary`
        // so the compound-assignment expansion produces the same tokens as a real
        // `X = X + Y` BinaryExpression (which goes through emitCommutativeBinary and
        // reorders the operands). Without this, the for-loop form (`X += Y`) and the
        // recursive form's synthetic assignment (`X = X + Y`) produce DIFFERENT token
        // orders for the `+` operands — a structural mismatch that was previously
        // hidden by the without-ID_NUM fallback in Pass 2.5 but is exposed when the
        // knownNumeric sets are equal (e.g. after type-annotation inference). The
        // reorder uses the same `alwaysSafe`/`plusSafe` check as `emitCommutativeBinary`
        // (consistency — same functor, same normalization).
        const op = node.operator.charAt(0);
        const alwaysSafe = op === "*" || op === "==" || op === "===" || op === "!=" || op === "!==" || op === "&" || op === "|" || op === "^";
        const plusSafe = op === "+" && left !== undefined && right !== undefined &&
          isKnownNumeric(left, KNOWN_NUMERIC) && isKnownNumeric(right, KNOWN_NUMERIC);
        if (alwaysSafe || plusSafe) {
          // Walk the `+` operands into separate arrays, then reorder (same as
          // emitCommutativeBinary).
          const leftTokens: string[] = [];
          const rightTokens: string[] = [];
          if (left !== undefined) walkIterationBody(left, leftTokens, constBindings, currentLoopVars, inliningStack, letDrop);
          if (right !== undefined) walkIterationBody(right, rightTokens, constBindings, currentLoopVars, inliningStack, letDrop);
          tokens.push(`BinaryExpression_${op}`);
          if (compareTokenArrays(leftTokens, rightTokens) <= 0) {
            for (const t of leftTokens) tokens.push(t);
            for (const t of rightTokens) tokens.push(t);
          } else {
            for (const t of rightTokens) tokens.push(t);
            for (const t of leftTokens) tokens.push(t);
          }
        } else {
          // Non-commutative/unsafe: emit in original order (left then right).
          tokens.push(`BinaryExpression_${op}`);
          if (left !== undefined) walkIterationBody(left, tokens, constBindings, currentLoopVars, inliningStack, letDrop);
          if (right !== undefined) walkIterationBody(right, tokens, constBindings, currentLoopVars, inliningStack, letDrop);
        }
        return;
      }
      tokens.push(node.type);
      for (const c of astChildren(node)) walkIterationBody(c, tokens, constBindings, currentLoopVars, inliningStack, letDrop);
      return;
    }
    case "IfStatement": {
      // Round 5.2: shared `emitIfStatementTokens` helper (was duplicated, ~40
      // lines each, modulo the trailing-else-if-continue drop). Pass 2.5 passes
      // `trailingElseIfContinueDrop = true` (drops `else if (...) { continue; }`
      // when the if is the last statement of the loop body — A2). The old
      // walkIterationBody inlined the equality-test logic (because it couldn't
      // call `walkV2`); the shared `emitDecisionTest` (now parameterized by
      // walkFn) eliminates the inlining.
      emitIfStatementTokens(node, tokens, constBindings, currentLoopVars, inliningStack, walkFn, letDrop, true);
      return;
    }
    case "SwitchStatement": {
      // Round 5.2: shared `emitSwitchStatementTokens` helper (was duplicated,
      // ~30 lines each; the old walkIterationBody inlined the equality-test
      // logic, now delegated to `emitDecisionTest` with walkFn). Pass 2.5 passes
      // `letDrop` (for the let-binding drop in the case consequents).
      emitSwitchStatementTokens(node, tokens, constBindings, currentLoopVars, inliningStack, walkFn, letDrop);
      return;
    }
    case "BlockStatement": {
      // Round 5.2: `emitStmtList` (merged with the old
      // `emitIterationBodyStmtList`) now takes `walkFn` + optional `letDrop`.
      // Pass 2.5 passes `letDrop` (for the let-binding drop).
      emitStmtList(astNodeArray(node.body), tokens, constBindings, currentLoopVars, inliningStack, walkFn, letDrop);
      return;
    }
    case "BinaryExpression": {
      // Round 5.2: shared `emitBinaryExpressionToken` helper (was duplicated,
      // IDENTICAL modulo walkFn). Round 3 A5 + Round 4 Fix 1 (same as walkV2).
      emitBinaryExpressionToken(node, tokens, constBindings, currentLoopVars, inliningStack, walkFn);
      return;
    }
    case "TSNonNullExpression": {
      // Round 5.3 T4c fix: drop the `!` non-null assertion wrapper (same as
      // walkV2). TypeScript's `!` is erased at runtime → `x!.y` and `x.y` produce
      // identical JavaScript. Dropping the wrapper is sound (same principle as
      // the symmetric BlockStatement drop). Applied to Pass 2.5 too for
      // consistency (iteration bodies with `!` assertions normalize the same
      // as without).
      const inner = astNode((node as { expression?: unknown }).expression);
      if (inner !== undefined) walkFn(inner, tokens, constBindings, currentLoopVars, inliningStack);
      return;
    }
    default:
      tokens.push(node.type);
      for (const c of astChildren(node)) walkIterationBody(c, tokens, constBindings, currentLoopVars, inliningStack, letDrop);
      return;
  }
}

/** Round 5.2: the old `emitIterationBodyStmtList` was merged into `emitStmtList`
 * (parameterized by `walkFn` + optional `letDrop`). See `emitStmtList` above. */

/** Extract the iteration body tokens from a function. Returns null if the
 * function doesn't have a for-loop AND isn't self-tail-recursive.
 * - For a function with a for-loop: extracts the for-loop's body (after stripping
 * loop-var updates) with trailing-else-if-continue drop.
 * - For a self-tail-recursive function: extracts the body between the loop-exit
 * test (first `if (...) return...`) and the tail call (last `return self(args)`),
 * with let-binding drop + compound-assignment normalization.
 * - If the function has BOTH a for-loop AND is self-tail-recursive, extracts the
 * for-loop's body (the for-loop is the more specific pattern).
 *
 * Round 5.1: returns `{ tokens, knownNumeric }` instead of just `tokens`. The
 * `knownNumeric` set is the function's inferred numeric identifiers (via
 * `collectKnownNumeric`, extended in Round 5.1 to infer recursive-helper params
 * from strictly-numeric direct usage). Pass 2.5 uses this set to decide
 * CONDITIONALLY whether to apply ID_NUM (only when both forms' sets are EQUAL —
 * avoids regressing T4a where the for-loop form infers more numerics than the
 * recursive form). The `tokens` are computed WITH ID_NUM (via walkIterationBody);
 * Pass 2.5 applies the cheap `ID_NUM → ID` fallback transform when sets differ. */
function computeIterationBodyTokens(fnNode: AstNode): { tokens: string[]; knownNumeric: Set<string> } | null {
  const knownNumeric = collectKnownNumeric(fnNode);
  KNOWN_NUMERIC = knownNumeric;
  const body = astNode(fnNode.body);
  if (body === undefined || body.type !== "BlockStatement") return null;
  // (a) For-loop iteration body.
  let forLoop: AstNode | undefined = undefined;
  for (const s of astNodeArray(body.body)) {
    if (s.type === "ForStatement" || s.type === "WhileStatement" || s.type === "DoWhileStatement") {
      forLoop = s;
      break;
    }
  }
  if (forLoop !== undefined) {
    const test = astNode(forLoop.test);
    const loopVars = loopVarsOf(test);
    const forBody = astNode(forLoop.body);
    if (forBody === undefined) return null;
    const constBindings = collectConstBindings(fnNode);
    const tokens: string[] = [];
    // Round 5.2: the for-loop form has no let-binding drop (letDrop = empty).
    // The walkFn thunk closes over `forLetDrop` (empty) so `walkIterationBody`
    // recursion also gets an empty letDrop. `emitStmtList` (merged with the old
    // `emitIterationBodyStmtList`) takes `walkFn` + optional `letDrop`.
    const forLetDrop = new Set<string>();
    const walkFnFor: WalkFn = (n, t, cb, lv, is) => walkIterationBody(n, t, cb, lv, is, forLetDrop);
    if (forBody.type === "BlockStatement") {
      emitStmtList(astNodeArray(forBody.body), tokens, constBindings, loopVars, new Set(), walkFnFor, forLetDrop);
    } else {
      if (!shouldStripLoopUpdate(forBody, undefined, loopVars)) {
        walkIterationBody(forBody, tokens, constBindings, loopVars, new Set(), forLetDrop);
      }
    }
    return { tokens, knownNumeric };
  }
  // (b) Self-tail-recursive iteration body.
  const tco = detectTailRecursion(fnNode);
  if (!tco.isTailRecursive) return null;
  const stmts = astNodeArray(body.body);
  if (stmts.length < 2) return null;
  // Drop the first statement if it's the loop-exit test (an IfStatement with a
  // ReturnStatement consequent).
  let start = 0;
  const first = stmts[0]!;
  if (first.type === "IfStatement") {
    const cons = astNode(first.consequent);
    if (cons !== undefined && cons.type === "BlockStatement") {
      const consStmts = astNodeArray(cons.body);
      if (consStmts.length === 1 && consStmts[0]!.type === "ReturnStatement") {
        start = 1;
      }
    } else if (cons !== undefined && cons.type === "ReturnStatement") {
      start = 1;
    }
  }
  // Drop the last statement (the tail call).
  const filtered = stmts.slice(start, stmts.length - 1);
  const constBindings = collectConstBindings(fnNode);
  const letDrop = collectLetAliasBindings(fnNode);
  const tokens: string[] = [];
  // Round 3 A1 fix: empty recursive helper — extract the tail call's arg assignments
  // as the iteration body. When the recursive helper's body is empty (state update
  // only in the tail call's arguments — the documented Pass 2.5 limitation), the
  // `filtered` list is empty. We synthesize the iteration body from the tail call's
  // arg assignments:
  // - Skip unchanged params (arg is the same Identifier as the param).
  // - Skip "loop-mechanic" params (params that appear in the base-case test —
  // they correspond to the for-loop's update clause, which is dropped).
  // - Emit a synthetic `param = arg` assignment for the remaining changing params
  // (the "iteration body" — they correspond to the for-loop's body).
  // This catches loop↔recursion pairs where the recursive helper's body is empty
  // (e.g., `function recSum(n, i, s) { if (i > n) return s; return recSum(n, i+1, s+i); }`
  // ↔ `function loopSum(n) { let s = 0; for (let i = 0; i <= n; i++) s += i; return s; }`).
  // The synthetic `s = s + i` matches the loop form's compound-assignment-normalized
  // `s = s + i` → Jaccard 1.0 → caught.
  // Sources: type theory (the state transformation is the assignment of new values
  // to the recursive params) + the existing TCO algorithm (Round 2 research,
  // research/round2-t4a-t4b/tail-call-eliminator-source.md, MIT). No code extracted.
  if (filtered.length === 0 && start === 1) {
    // Collect "loop-mechanic" vars: identifiers in the base-case test ∩ changing params.
    const baseTest = astNode(first.test);
    const baseTestIds = new Set<string>();
    if (baseTest !== undefined) {
      walk(baseTest, (n) => {
        if (n.type === "Identifier") baseTestIds.add(String(n.name));
      });
    }
    const mechanic = new Set<string>();
    for (const v of baseTestIds) if (tco.loopVarsFromTailCall.has(v)) mechanic.add(v);
    // The tail call is the last statement: `return self(args)`.
    const last = stmts[stmts.length - 1]!;
    const lastArg = astNode((last as { argument?: unknown }).argument);
    if (lastArg !== undefined && lastArg.type === "CallExpression") {
      const callee = astNode(lastArg.callee);
      const fnId = astNode(fnNode.id);
      const fnName = fnId?.type === "Identifier" ? String(fnId.name) : undefined;
      if (callee !== undefined && callee.type === "Identifier" && fnName !== undefined && String(callee.name) === fnName) {
        const args = astNodeArray(lastArg.arguments);
        const params = astNodeArray(fnNode.params);
        for (let i = 0; i < Math.min(params.length, args.length); i += 1) {
          const param = params[i]!;
          const pName = param.type === "Identifier" ? String(param.name) : undefined;
          if (pName === undefined) continue;
          const arg = args[i];
          if (arg === undefined) continue;
          if (arg.type === "Identifier" && String(arg.name) === pName) continue; // unchanged
          if (mechanic.has(pName)) continue; // loop-mechanic update, dropped (like the for-update)
          // Emit synthetic `pName = arg` assignment: `ExpressionStatement AssignmentExpression <id-token> <walk(arg)>`.
          // The `ExpressionStatement` wrapper matches the loop form (where each `+=` is an
          // ExpressionStatement wrapping an AssignmentExpression that goes through compound-
          // assignment normalization). This mirrors the loop form's compound-assignment-
          // normalized `pName = pName +...` (for `+=` args) or `pName = arg` (for `=` args).
          // Round 5.1: the LHS uses `ID_NUM` when `pName` is known-numeric (consistent with
          // walkIterationBody's Identifier case; the conditional application in Pass 2.5
          // handles the fallback when the for-loop and recursive forms' sets differ).
          tokens.push("ExpressionStatement");
          tokens.push("AssignmentExpression");
          tokens.push(knownNumeric.has(pName) ? "ID_NUM" : "ID"); // LHS: pName → ID or ID_NUM
          // RHS: walk the arg (the new value for the param).
          walkIterationBody(arg, tokens, constBindings, mechanic, new Set(), letDrop);
        }
      }
    }
    return { tokens, knownNumeric };
  }
  // Round 5.2: `emitStmtList` (merged with the old `emitIterationBodyStmtList`)
  // takes `walkFn` + optional `letDrop`. The recursive form's `letDrop` (from
  // `collectLetAliasBindings`) is passed both to `emitStmtList` (for the
  // let-binding drop check) + to the walkFn thunk (for the recursion).
  const walkFnRec: WalkFn = (n, t, cb, lv, is) => walkIterationBody(n, t, cb, lv, is, letDrop);
  emitStmtList(filtered, tokens, constBindings, tco.loopVarsFromTailCall, new Set(), walkFnRec, letDrop);
  return { tokens, knownNumeric };
}

function parseSource(path: string, content: string): AstNode {
  const parsed = parse(content, {
    sourceType: "module",
    plugins: [...babelParserPluginsForSourcePath(path)],
  });
  return parsed.program as unknown as AstNode;
}

function collectAllFunctions(sources: readonly { path: string; content: string }[]): CollectedFunction[] {
  const all: CollectedFunction[] = [];
  for (const src of sources) {
    bestEffort(() => {
      const program = parseSource(src.path, src.content);
      collectFunctionsFromNode(program, undefined, src.path, src.content, all);
    });
  }
  return all;
}

function pass1ExactHash(functions: readonly CollectedFunction[], minBodySize: number): Pass1Cluster[] {
  const byHash = new Map<string, CollectedFunction[]>();
  for (const fn of functions) {
    if (fn.bodySize < minBodySize) continue;
    const list = byHash.get(fn.exactHash);
    if (list) list.push(fn);
    else byHash.set(fn.exactHash, [fn]);
  }
  const clusters: Pass1Cluster[] = [];
  for (const [hash, fns] of byHash) {
    if (fns.length < 2) continue;
    const files = new Set(fns.map((f) => f.path));
    const namesInSameFile = new Map<string, Set<string>>();
    for (const f of fns) {
      const set = namesInSameFile.get(f.path) ?? new Set<string>();
      set.add(f.name);
      namesInSameFile.set(f.path, set);
    }
    const crossFile = files.size >= 2;
    const sameFileDiffNames = [...namesInSameFile.values()].some((s) => s.size >= 2);
    if (crossFile || sameFileDiffNames) {
      clusters.push({ hash, functions: fns });
    }
  }
  return clusters;
}

/**
 * Pass-2 normalized-hash clusters: groups functions by their normalized token
 * hash (Identifier→ID, StringLiteral→STR, etc.). Functions with the same
 * normalized hash have identical structure (different names/strings/values but
 * the same AST shape). These clusters are used for allowlist drift detection
 * of normalized-only duplicates (functions that share a normalized hash but
 * NOT an exact hash). With `jaccardThreshold=1.0`, every Pass-2 finding pair
 * shares a normalized hash, making the allowlist mechanically verifiable.
 */
function pass2NormalizedClusters(functions: readonly CollectedFunction[], minBodySize: number): Pass1Cluster[] {
  const byHash = new Map<string, CollectedFunction[]>();
  for (const fn of functions) {
    if (fn.bodySize < minBodySize) continue;
    const list = byHash.get(fn.normalizedHash);
    if (list) list.push(fn);
    else byHash.set(fn.normalizedHash, [fn]);
  }
  const clusters: Pass1Cluster[] = [];
  for (const [hash, fns] of byHash) {
    if (fns.length < 2) continue;
    const files = new Set(fns.map((f) => f.path));
    const namesInSameFile = new Map<string, Set<string>>();
    for (const f of fns) {
      const set = namesInSameFile.get(f.path) ?? new Set<string>();
      set.add(f.name);
      namesInSameFile.set(f.path, set);
    }
    const crossFile = files.size >= 2;
    const sameFileDiffNames = [...namesInSameFile.values()].some((s) => s.size >= 2);
    if (crossFile || sameFileDiffNames) {
      clusters.push({ hash, functions: fns });
    }
  }
  return clusters;
}

interface Pass2Pair {
  a: CollectedFunction;
  b: CollectedFunction;
  similarity: number;
}

function pass2NormalizedJaccard(
  functions: readonly CollectedFunction[],
  minBodySize: number,
  minTokenCount: number,
  jaccardThreshold: number,
  shingleK: number,
): Pass2Pair[] {
  const eligible = functions.filter((f) => f.bodySize >= minBodySize && f.normalizedTokens.length >= minTokenCount);
  const shingleSets = eligible.map((f) => shingles(f.normalizedTokens, shingleK));
  // Hash-bucketing: Map<shingle, functionId[]>. Only compare pairs that share a shingle.
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < shingleSets.length; i += 1) {
    for (const s of shingleSets[i]!) {
      const list = buckets.get(s);
      if (list) list.push(i);
      else buckets.set(s, [i]);
    }
  }
  const candidatePairs = new Set<string>();
  for (const [, ids] of buckets) {
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = ids[i]!;
        const b = ids[j]!;
        if (a === b) continue;
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        candidatePairs.add(key);
      }
    }
  }
  const pairs: Pass2Pair[] = [];
  for (const key of candidatePairs) {
    const parts = key.split(":");
    const aIdx = Number.parseInt(parts[0] ?? "0", 10);
    const bIdx = Number.parseInt(parts[1] ?? "0", 10);
    const a = eligible[aIdx];
    const b = eligible[bIdx];
    if (a === undefined || b === undefined) continue;
    if (a.path === b.path && a.name === b.name) continue;
    const sim = jaccard(shingleSets[aIdx]!, shingleSets[bIdx]!);
    if (sim >= jaccardThreshold) pairs.push({ a, b, similarity: sim });
  }
  return pairs;
}

/** Pass 2.5 — iteration-body Jaccard (Round 2, T4a sub-body extraction).
 * Compares the iteration bodies (the per-iteration logic) of functions that have
 * a for-loop OR are self-tail-recursive. Uses the same shingle + Jaccard approach
 * as Pass 2 but on a SEPARATE token stream (`computeIterationBodyTokens`).
 * The extra normalizations (compound-assignment, let-binding drop,
 * trailing-else-if-continue drop) are ONLY in `computeIterationBodyTokens` —
 * this pass does NOT affect the main Pass 2 token streams.
 *
 * Round 5.1 — CONDITIONAL ID_NUM: `walkIterationBody` now emits `ID_NUM` for
 * known-numeric Identifiers (same as walkV2). Pass 2.5 applies this refinement
 * CONDITIONALLY per pair: when both forms' `knownNumeric` sets are EQUAL, the
 * with-ID_NUM shingles are used (ID_NUM distinguishes `i + s` vs `s + i` →
 * fixes the Fix 2 residual FP); when the sets DIFFER, the fallback
 * `ID_NUM → ID` shingles are used (current behavior, avoids regressing T4a/A1
 * where the for-loop form infers more numerics via `let x = 0` than the
 * recursive form's params). The bucketing uses the WITHOUT-ID_NUM shingles
 * (most-permissive) so no candidate pair is missed.
 *
 * Returns pairs where the iteration-body Jaccard >= threshold. */
function pass25IterationBodyJaccard(
  functions: readonly CollectedFunction[],
  minBodySize: number,
  minTokenCount: number,
  jaccardThreshold: number,
  shingleK: number,
): Pass2Pair[] {
  // Compute iteration body tokens for each eligible function (lazily — most
  // functions don't have a for-loop or aren't self-tail-recursive, so
  // `computeIterationBodyTokens` returns null for them).
  interface EligibleFn {
    fn: CollectedFunction;
    shinglesWithNum: Set<string>;   // with ID_NUM (the refinement)
    shinglesNoNum: Set<string>;      // with ID_NUM → ID (the fallback)
    knownNumeric: Set<string>;
  }
  const eligible: EligibleFn[] = [];
  for (const fn of functions) {
    if (fn.bodySize < minBodySize) continue;
    const result = computeIterationBodyTokens(fn.node);
    if (result === null) continue;
    if (result.tokens.length < minTokenCount) continue;
    // The fallback (ID_NUM → ID) is the current pre-Round-5.1 behavior; the
    // refinement (with ID_NUM) is the new behavior applied only when both
    // forms' knownNumeric sets agree (conditional, per-pair).
    const tokensNoNum = result.tokens.map((t) => t === "ID_NUM" ? "ID" : t);
    eligible.push({
      fn,
      shinglesWithNum: shingles(result.tokens, shingleK),
      shinglesNoNum: shingles(tokensNoNum, shingleK),
      knownNumeric: result.knownNumeric,
    });
  }
  if (eligible.length < 2) return [];
  // Bucket using the WITHOUT-ID_NUM shingles (the most-permissive fallback) so
  // no candidate pair is missed (a pair that would match only under fallback
  // must still be a candidate; bucketing with the refinement would miss it).
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < eligible.length; i += 1) {
    for (const s of eligible[i]!.shinglesNoNum) {
      const list = buckets.get(s);
      if (list) list.push(i);
      else buckets.set(s, [i]);
    }
  }
  const candidatePairs = new Set<string>();
  for (const [, ids] of buckets) {
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = ids[i]!;
        const b = ids[j]!;
        if (a === b) continue;
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        candidatePairs.add(key);
      }
    }
  }
  const pairs: Pass2Pair[] = [];
  for (const key of candidatePairs) {
    const parts = key.split(":");
    const aIdx = Number.parseInt(parts[0] ?? "0", 10);
    const bIdx = Number.parseInt(parts[1] ?? "0", 10);
    const ea = eligible[aIdx];
    const eb = eligible[bIdx];
    if (ea === undefined || eb === undefined) continue;
    if (ea.fn.path === eb.fn.path && ea.fn.name === eb.fn.name) continue;
    // Conditional ID_NUM: if both forms' knownNumeric sets are EQUAL, use the
    // with-ID_NUM shingles (ID_NUM distinguishes `i + s` vs `s + i` → fixes the
    // Fix 2 residual FP). Else, fall back to the without-ID_NUM shingles
    // (current pre-Round-5.1 behavior, avoids regressing T4a/A1 where the
    // for-loop form infers more numerics via `let x = 0` than the recursive
    // form's params — e.g., `count` is `let count = 0` → ID_NUM in for-loop
    // but only `count + 1` (`+` is NOT strictly-numeric) → ID in recursive).
    const setsEqual = ea.knownNumeric.size === eb.knownNumeric.size &&
      [...ea.knownNumeric].every((x) => eb.knownNumeric.has(x));
    const sa = setsEqual ? ea.shinglesWithNum : ea.shinglesNoNum;
    const sb = setsEqual ? eb.shinglesWithNum : eb.shinglesNoNum;
    const sim = jaccard(sa, sb);
    if (sim >= jaccardThreshold) pairs.push({ a: ea.fn, b: eb.fn, similarity: sim });
  }
  return pairs;
}

// ============================================================================
// Pass 2.6 — async-iteration Jaccard (Round 7, N2 async↔sync).
// Compares async-iteration forms (for+await ↔ reduce+.then) extracted via
// the algebraic-effect normalizer (`async-effect-normalizer.ts`). The
// canonical form is `ASYNC_ITER <op-tokens> ASYNC_CONT <cont-tokens>` (see
// the normalizer's header for the formalization + sources). The op and
// continuation are compared via the harmonic mean of their Jaccard scores
// (penalizes either being low; the op tokens are short so the continuation
// dominates). This is a separate pass from Pass 2.5 because the async-iter
// extraction is more aggressive (it normalizes await↔.then, accumulator
// substitution, dead-counter drop, accumulator-return fusion — none of
// which Pass 2.5 does). Pass 2.6 fires only when BOTH functions have an
// `ASYNC_ITER` form (Pattern A or B); functions without an async-iter
// form are skipped.
//
// Sources: Plotkin-Pretnar 2009, Leijen-Koka MSR TR-2017-21, EXP30
// (`experiments/algebraic-effects/`), rpetrich/babel-plugin-transform-
// async-to-promises MIT (algorithm inspired; no code extracted).
// ============================================================================

function pass26AsyncIterJaccard(
  functions: readonly CollectedFunction[],
  minBodySize: number,
  jaccardThreshold: number,
  shingleK: number,
): Pass2Pair[] {
  // Extract async-iter forms lazily — most functions don't have one.
  interface EligibleFn {
    fn: CollectedFunction;
    form: AsyncForm;
  }
  const eligible: EligibleFn[] = [];
  for (const fn of functions) {
    if (fn.bodySize < minBodySize) continue;
    const form = extractAsyncForm(fn.node);
    if (form.kind === "NONE") continue;
    if (form.opTokens.length === 0 && form.contTokens.length === 0) continue;
    eligible.push({ fn, form });
  }
  if (eligible.length < 2) return [];
  const pairs: Pass2Pair[] = [];
  for (let i = 0; i < eligible.length; i += 1) {
    for (let j = i + 1; j < eligible.length; j += 1) {
      const a = eligible[i]!;
      const b = eligible[j]!;
      if (a.fn.path === b.fn.path && a.fn.name === b.fn.name) continue;
      const cmp = compareAsyncForms(a.form, b.form, jaccardThreshold, shingleK);
      if (cmp.matched) pairs.push({ a: a.fn, b: b.fn, similarity: cmp.similarity });
    }
  }
  return pairs;
}

// ============================================================================
// Pass 3 — embedding-based semantic duplicate detection (EXP407).
//
// Runs AFTER Pass 1/2/2.5/2.6, only on pairs NOT already flagged. Computes
// the embedding cosine similarity for each candidate pair; if sim >= threshold
// AND the structural filter passes, flags as a semantic duplicate.
//
// The structural filter (stmtRatio < 1.0) rejects "same-structure-different-
// behavior" FPs (the 3 by-type control pairs v6-2, v6-3, v6-5 all have
// stmtRatio = 1.0). Real semantic duplicates (N1-N6+7) have DIFFERENT statement
// counts (different structure, same behavior).
//
// The crossFileOnly filter (default true) rejects same-file pairs (Pass 2
// already covers same-file; allowing same-file in Pass 3 produces many FPs
// on test files with multiple anonymous test setups).
//
// Tradeoff documented in EXP407:
// - threshold = 0.95 (default): ~0 FP on production, catches 0/6 missed-
// equivalent TPs (all have embScore < 0.95).
// - threshold = 0.4 (aggressive): catches 6/6 missed-equivalent TPs, but
// ~21,000 FPs on lodash (612 functions).
// - The 6 missed-equivalent pairs (N1-N6+7 small variants) require a
// stronger semantic check (cross-encoder, behavior testing) — future work.
//
// Sources: EXP393 (HYBRID decision), EXP397 (10-test evaluation, F1=0.94),
// EXP406 (5 FPs are small functions, bodySize filter), EXP407 (structural
// discriminator, production FP audit).
// ============================================================================

/** Count top-level statements in a function body (BlockStatement contents
 * plus nested statements). Used by Pass 3's structural-difference filter. */
function countStatementsInFunction(node: AstNode): number {
  let count = 0;
  function walk(n: AstNode): void {
    if (
      n.type === "ExpressionStatement" ||
      n.type === "ReturnStatement" ||
      n.type === "VariableDeclaration" ||
      n.type === "IfStatement" ||
      n.type === "ForStatement" ||
      n.type === "ForOfStatement" ||
      n.type === "ForInStatement" ||
      n.type === "WhileStatement" ||
      n.type === "DoWhileStatement" ||
      n.type === "SwitchStatement" ||
      n.type === "TryStatement" ||
      n.type === "ThrowStatement"
    ) {
      count += 1;
    }
    for (const child of astChildren(n)) walk(child);
  }
  walk(node);
  return count;
}

/** Extract the ordered sequence of StringLiteral VALUES from a function
 * body. Used by Pass 3's string-literal-order filter to reject swapped-
 * branch FPs (N3-CTRL: same string set, different order → different
 * semantics). Returns the sequence of string values in source order. */
function extractStringLiteralSequence(node: AstNode): string[] {
  const seq: string[] = [];
  function walk(n: AstNode): void {
    if (n.type === "StringLiteral" && typeof n.value === "string") {
      seq.push(n.value);
    }
    for (const child of astChildren(n)) walk(child);
  }
  walk(node);
  return seq;
}

/** Check if two sequences have the same SET of values but different ORDER.
 * This detects swapped-branch FPs: the two functions use the same string
 * literals but in different positions (e.g., "big"/"small" swapped).
 * Returns true if the order is the SAME (or the sets differ — different
 * content, not a swap). Returns false if the sets match but the order
 * differs (likely a swapped-branch FP). */
function stringLiteralOrderMatches(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 && b.length === 0) return true;
  if (a.length !== b.length) return true;  // different counts → different content
  const setA = new Set(a);
  const setB = new Set(b);
  // If the sets differ, the pair has different string content → not a swap.
  if (setA.size !== setB.size) return true;
  for (const v of setA) if (!setB.has(v)) return true;
  // Same SET, same length → check if the ORDER is the same.
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;  // same set, different order → swap FP
  }
  return true;
}

/** Pass 3 — embedding-based semantic duplicate detection. Returns pairs
 * that Pass 1/2/2.5/2.6 did NOT catch, where the embedding cosine sim is
 * >= threshold AND the structural filter passes.
 *
 * This function is ASYNC (loads the embedding model on first call). If
 * `@xenova/transformers` is not installed, returns an empty array (graceful
 * fallback — Pass 3 produces no findings). */
async function pass3EmbeddingSemantic(
  functions: readonly CollectedFunction[],
  defaultMinBodySize: number,
  defaultMinTokenCount: number,
  alreadyFlaggedPairKeys: ReadonlySet<string>,
  options: DuplicateBodyEmbeddingPass3Options,
): Promise<Pass2Pair[]> {
  if (!options.enabled) return [];
  const threshold = options.threshold ?? 0.92;
  const crossFileOnly = options.crossFileOnly ?? true;
  const requireStructuralDifference = options.requireStructuralDifference ?? true;
  const requireStringLiteralOrderMatch = options.requireStringLiteralOrderMatch ?? true;
  const minBodySize = options.minBodySize ?? defaultMinBodySize;
  const minTokenCount = options.minTokenCount ?? defaultMinTokenCount;
  const providerOpts: EmbeddingProviderOptions = {
    model: options.model,
    cacheDir: options.cacheDir,
    wasmPaths: options.wasmPaths,
  };
  const provider: EmbeddingProvider | null = await getEmbeddingProvider(providerOpts);
  if (provider === null) return [];  // package not installed — graceful fallback

  const eligible = functions.filter(
    (f) => f.bodySize >= minBodySize && f.normalizedTokens.length >= minTokenCount,
  );
  if (eligible.length < 2) return [];

  // Embed all eligible function texts in batches.
  const texts = eligible.map((f) => f.text);
  const embeddings = await provider.embedBatch(texts);
  if (embeddings.length !== eligible.length) return [];

  // Precompute statement counts for the structural filter.
  const stmtCounts = eligible.map((f) => countStatementsInFunction(f.node));
  // Precompute string-literal sequences for the order filter.
  const strSeqs = requireStringLiteralOrderMatch
    ? eligible.map((f) => extractStringLiteralSequence(f.node))
    : [];

  // O(n²) comparison (filtered by embedding threshold + structural filter).
  const pairs: Pass2Pair[] = [];
  for (let i = 0; i < eligible.length; i += 1) {
    for (let j = i + 1; j < eligible.length; j += 1) {
      const a = eligible[i]!;
      const b = eligible[j]!;
      // Same-name-same-file: skip (Pass 1/2 handle these; Pass 3 is for
      // cross-file OR different-name-same-file semantic duplicates).
      if (a.path === b.path && a.name === b.name) continue;
      if (crossFileOnly && a.path === b.path) continue;
      const pairKey = a.path < b.path || (a.path === b.path && a.line <= b.line)
        ? `${a.path}:${a.line}|${b.path}:${b.line}`
        : `${b.path}:${b.line}|${a.path}:${a.line}`;
      if (alreadyFlaggedPairKeys.has(pairKey)) continue;
      if (a.exactHash === b.exactHash) continue;  // Pass 1 already covered
      const embScore = provider.cosine(embeddings[i]!, embeddings[j]!);
      if (embScore < threshold) continue;
      if (requireStructuralDifference) {
        const aStmts = stmtCounts[i]!;
        const bStmts = stmtCounts[j]!;
        const stmtRatio = Math.min(aStmts, bStmts) / Math.max(aStmts, bStmts, 1);
        if (stmtRatio >= 1.0) continue;  // same structure → likely FP
      }
      if (requireStringLiteralOrderMatch) {
        // Reject swapped-branch FPs: same string-literal SET, different ORDER.
        if (!stringLiteralOrderMatches(strSeqs[i]!, strSeqs[j]!)) continue;
      }
      pairs.push({ a, b, similarity: embScore });
    }
  }
  return pairs;
}

function crossEntryMatches(
  entry: DuplicateBodyAllowlistCross,
  hash: string,
  fileA: string,
  fileB: string,
): boolean {
  return entry.hash === hash &&
    ((entry.fileA === fileA && entry.fileB === fileB) || (entry.fileA === fileB && entry.fileB === fileA));
}

function isCrossFileAllowlisted(
  hash: string,
  fns: readonly CollectedFunction[],
  allowlistCross: readonly DuplicateBodyAllowlistCross[],
): boolean {
  const files = [...new Set(fns.map((f) => f.path))];
  for (let i = 0; i < files.length; i += 1) {
    for (let j = i + 1; j < files.length; j += 1) {
      const fa = files[i]!;
      const fb = files[j]!;
      const covered = allowlistCross.some((e) => crossEntryMatches(e, hash, fa, fb));
      if (!covered) return false;
    }
  }
  return true;
}

function isSameFileAllowlisted(
  hash: string,
  fns: readonly CollectedFunction[],
  allowlistSameFile: readonly DuplicateBodyAllowlistSameFile[],
): boolean {
  const byFile = new Map<string, CollectedFunction[]>();
  for (const f of fns) {
    const list = byFile.get(f.path) ?? [];
    list.push(f);
    byFile.set(f.path, list);
  }
  for (const [file, groupFns] of byFile) {
    const entry = allowlistSameFile.find((e) => e.hash === hash && e.file === file);
    // One member more than the accepted count is a new duplicate.
    if (entry === undefined || groupFns.length > entry.count) return false;
  }
  return true;
}

function detectAllowlistDrift(
  pass1Clusters: readonly Pass1Cluster[],
  pass2Clusters: readonly Pass1Cluster[],
  allowlistCross: readonly DuplicateBodyAllowlistCross[],
  allowlistSameFile: readonly DuplicateBodyAllowlistSameFile[],
): { mirrorViolations: string[]; contractTests: string[] } {
  const violations: string[] = [];
  const contractTests = new Set<string>();
  // Build BOTH exact-hash and normalized-hash cluster maps so allowlist entries
  // can use either hash. An exact-hash entry matches a Pass-1 cluster; a
  // normalized-hash entry matches a Pass-2 cluster. The drift check verifies
  // every allowlist entry's hash still corresponds to a real cluster linking
  // the cited files (T7 inversion: stale entries FAIL).
  const exactClustersByHash = new Map<string, Pass1Cluster[]>();
  for (const cluster of pass1Clusters) {
    const list = exactClustersByHash.get(cluster.hash) ?? [];
    list.push(cluster);
    exactClustersByHash.set(cluster.hash, list);
  }
  const normClustersByHash = new Map<string, Pass1Cluster[]>();
  for (const cluster of pass2Clusters) {
    const list = normClustersByHash.get(cluster.hash) ?? [];
    list.push(cluster);
    normClustersByHash.set(cluster.hash, list);
  }
  for (const entry of allowlistCross) {
    if (entry.contractTest) contractTests.add(entry.contractTest);
    const exactClusters = exactClustersByHash.get(entry.hash) ?? [];
    const normClusters = normClustersByHash.get(entry.hash) ?? [];
    const found = exactClusters.some((c) =>
      c.functions.some((f) => f.path === entry.fileA) && c.functions.some((f) => f.path === entry.fileB),
    ) || normClusters.some((c) =>
      c.functions.some((f) => f.path === entry.fileA) && c.functions.some((f) => f.path === entry.fileB),
    );
    if (!found) {
      violations.push(
        `stale allowlist entry: ${entry.hash} ${entry.fileA} ↔ ${entry.fileB} — the pair no longer shares this hash; either update the hash or remove the entry`,
      );
    }
  }
  for (const entry of allowlistSameFile) {
    // The members the group still has in the file (the larger of its exact
    // and normalized clusters): none is a stale entry, fewer than the
    // accepted count is debt that fell (lower the count).
    const members = Math.max(0, ...[...(exactClustersByHash.get(entry.hash) ?? []), ...(normClustersByHash.get(entry.hash) ?? [])]
      .map((c) => c.functions.filter((f) => f.path === entry.file).length));
    if (members === 0) {
      violations.push(`stale same-file allowlist entry: ${entry.hash} ${entry.file} — no such clone group exists`);
    } else if (members < entry.count) {
      violations.push(`stale same-file allowlist entry: ${entry.hash} ${entry.file} — the group holds ${String(members)} member(s) there, the entry accepts ${String(entry.count)}: lower its count`);
    }
  }
  return { mirrorViolations: violations, contractTests: [...contractTests].sort() };
}

export function detectDuplicateBodies(opts: DuplicateBodyOptions): DuplicateBodyResult {
  const minBodySize = opts.minBodySize ?? DEFAULT_MIN_BODY_SIZE;
  const minTokenCount = opts.minTokenCount ?? DEFAULT_MIN_TOKEN_COUNT;
  const jaccardThreshold = opts.jaccardThreshold ?? DEFAULT_JACCARD_THRESHOLD;
  const shingleK = opts.shingleK ?? DEFAULT_SHINGLE_K;
  const functions = collectAllFunctions(opts.sources);
  const pass1Clusters = pass1ExactHash(functions, minBodySize);
  const pass2Clusters = pass2NormalizedClusters(functions, minBodySize);
  const pass2Pairs = pass2NormalizedJaccard(functions, minBodySize, minTokenCount, jaccardThreshold, shingleK);
  // Pass 2.5 — iteration-body Jaccard (Round 2, T4a sub-body extraction).
  // Compares iteration bodies of functions with for-loops OR self-tail-recursive
  // functions. Uses the same threshold + minTokenCount as Pass 2.
  const pass25Pairs = pass25IterationBodyJaccard(functions, minBodySize, minTokenCount, jaccardThreshold, shingleK);
  // Pass 2.6 — async-iteration Jaccard (Round 7, N2 async↔sync).
  // Compares async-iter forms (for+await ↔ reduce+.then) via the algebraic-
  // effect normalizer. Uses the same threshold as Pass 2; the canonical form
  // is `ASYNC_ITER <op> <cont>` so the Jaccard threshold is on the combined
  // op+continuation similarity (harmonic mean). No minTokenCount — the async-
  // iter form is the discriminative signal, not the body size.
  const pass26Pairs = pass26AsyncIterJaccard(functions, minBodySize, jaccardThreshold, shingleK);

  const findings: DuplicateBodyFinding[] = [];
  const flaggedPairs = new Set<string>();

  // Pass 1 findings (exact-hash clusters not in the allowlist).
  for (const cluster of pass1Clusters) {
    const crossFileAllowlisted = isCrossFileAllowlisted(cluster.hash, cluster.functions, opts.allowlistCross);
    const sameFileAllowlisted = isSameFileAllowlisted(cluster.hash, cluster.functions, opts.allowlistSameFile);
    if (crossFileAllowlisted || sameFileAllowlisted) continue;
    for (const fn of cluster.functions) {
      findings.push({
        file: fn.path,
        line: fn.line,
        name: fn.name,
        bodySize: fn.bodySize,
        passes: "exact",
        cluster: cluster.hash,
      });
    }
  }

  // Pass 2 findings (normalized Jaccard pairs not already flagged by Pass 1).
  for (const pair of pass2Pairs) {
    const pairKey = pair.a.path < pair.b.path || (pair.a.path === pair.b.path && pair.a.line <= pair.b.line)
      ? `${pair.a.path}:${pair.a.line}|${pair.b.path}:${pair.b.line}`
      : `${pair.b.path}:${pair.b.line}|${pair.a.path}:${pair.a.line}`;
    if (flaggedPairs.has(pairKey)) continue;
    // If both functions share the exact hash, Pass 1 already covered them.
    if (pair.a.exactHash === pair.b.exactHash) {
      flaggedPairs.add(pairKey);
      continue;
    }
    // Check allowlist coverage for the pair (cross-file or same-file).
    // Use the NORMALIZED hash (both functions share it with jaccardThreshold=1.0)
    // in addition to the exact hash, so normalized-only duplicates can be allowlisted.
    const pairFns = [pair.a, pair.b];
    const normHash = pair.a.normalizedHash;
    const allowlistedCross = isCrossFileAllowlisted(normHash, pairFns, opts.allowlistCross) ||
      isCrossFileAllowlisted(pair.a.exactHash, pairFns, opts.allowlistCross) ||
      isCrossFileAllowlisted(pair.b.exactHash, pairFns, opts.allowlistCross);
    // A same-file entry accepts a COUNT of the group's members in a file, so
    // it is judged on every member the pair's files hold, never the pair
    // alone (a third copy forms pairs of two).
    const pairFiles = new Set([pair.a.path, pair.b.path]);
    const group = functions.filter((fn) => pairFiles.has(fn.path) && fn.normalizedHash === normHash);
    const allowlistedSameFile = [normHash, pair.a.exactHash, pair.b.exactHash].some((hash) => isSameFileAllowlisted(hash, group, opts.allowlistSameFile));
    if (allowlistedCross || allowlistedSameFile) continue;
    findings.push(
      { file: pair.a.path, line: pair.a.line, name: pair.a.name, bodySize: pair.a.bodySize, passes: "normalized", cluster: pairKey },
      { file: pair.b.path, line: pair.b.line, name: pair.b.name, bodySize: pair.b.bodySize, passes: "normalized", cluster: pairKey },
    );
    flaggedPairs.add(pairKey);
  }

  // Pass 2.5 findings (iteration-body Jaccard — Round 2, T4a sub-body extraction).
  // These are pairs where the ITERATION BODIES (not the whole functions) match.
  // Only added if not already flagged by Pass 1 or Pass 2 (avoid duplicate findings).
  for (const pair of pass25Pairs) {
    const pairKey = pair.a.path < pair.b.path || (pair.a.path === pair.b.path && pair.a.line <= pair.b.line)
      ? `${pair.a.path}:${pair.a.line}|${pair.b.path}:${pair.b.line}`
      : `${pair.b.path}:${pair.b.line}|${pair.a.path}:${pair.a.line}`;
    if (flaggedPairs.has(pairKey)) continue;
    // If both functions share the exact hash, Pass 1 already covered them.
    if (pair.a.exactHash === pair.b.exactHash) {
      flaggedPairs.add(pairKey);
      continue;
    }
    // Check allowlist coverage (same logic as Pass 2).
    const pairFns = [pair.a, pair.b];
    const normHash = pair.a.normalizedHash;
    const allowlistedCross = isCrossFileAllowlisted(normHash, pairFns, opts.allowlistCross) ||
      isCrossFileAllowlisted(pair.a.exactHash, pairFns, opts.allowlistCross) ||
      isCrossFileAllowlisted(pair.b.exactHash, pairFns, opts.allowlistCross);
    const allowlistedSameFile = isSameFileAllowlisted(normHash, pairFns, opts.allowlistSameFile) ||
      isSameFileAllowlisted(pair.a.exactHash, pairFns, opts.allowlistSameFile) ||
      isSameFileAllowlisted(pair.b.exactHash, pairFns, opts.allowlistSameFile);
    if (allowlistedCross || allowlistedSameFile) continue;
    findings.push(
      { file: pair.a.path, line: pair.a.line, name: pair.a.name, bodySize: pair.a.bodySize, passes: "normalized", cluster: pairKey },
      { file: pair.b.path, line: pair.b.line, name: pair.b.name, bodySize: pair.b.bodySize, passes: "normalized", cluster: pairKey },
    );
    flaggedPairs.add(pairKey);
  }

  // Pass 2.6 findings (async-iter Jaccard — Round 7, N2 async↔sync).
  // Same dedup/allowlist logic as Pass 2 / 2.5.
  for (const pair of pass26Pairs) {
    const pairKey = pair.a.path < pair.b.path || (pair.a.path === pair.b.path && pair.a.line <= pair.b.line)
      ? `${pair.a.path}:${pair.a.line}|${pair.b.path}:${pair.b.line}`
      : `${pair.b.path}:${pair.b.line}|${pair.a.path}:${pair.a.line}`;
    if (flaggedPairs.has(pairKey)) continue;
    if (pair.a.exactHash === pair.b.exactHash) {
      flaggedPairs.add(pairKey);
      continue;
    }
    const pairFns = [pair.a, pair.b];
    const normHash = pair.a.normalizedHash;
    const allowlistedCross = isCrossFileAllowlisted(normHash, pairFns, opts.allowlistCross) ||
      isCrossFileAllowlisted(pair.a.exactHash, pairFns, opts.allowlistCross) ||
      isCrossFileAllowlisted(pair.b.exactHash, pairFns, opts.allowlistCross);
    const allowlistedSameFile = isSameFileAllowlisted(normHash, pairFns, opts.allowlistSameFile) ||
      isSameFileAllowlisted(pair.a.exactHash, pairFns, opts.allowlistSameFile) ||
      isSameFileAllowlisted(pair.b.exactHash, pairFns, opts.allowlistSameFile);
    if (allowlistedCross || allowlistedSameFile) continue;
    findings.push(
      { file: pair.a.path, line: pair.a.line, name: pair.a.name, bodySize: pair.a.bodySize, passes: "normalized", cluster: pairKey },
      { file: pair.b.path, line: pair.b.line, name: pair.b.name, bodySize: pair.b.bodySize, passes: "normalized", cluster: pairKey },
    );
    flaggedPairs.add(pairKey);
  }

  const drift = detectAllowlistDrift(pass1Clusters, pass2Clusters, opts.allowlistCross, opts.allowlistSameFile);

  return {
    findings: findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
    mirrorViolations: drift.mirrorViolations,
    contractTests: drift.contractTests,
  };
}

/**
 * Async variant of `detectDuplicateBodies` that includes Pass 3 (embedding-
 * based semantic duplicate detection, EXP407). Pass 3 runs AFTER Pass 1/2/
 * 2.5/2.6, only on pairs NOT already caught. When `opts.embeddingPass3` is
 * absent or `enabled: false`, this function delegates to the sync
 * `detectDuplicateBodies` (no embedding model loaded — graceful fallback).
 *
 * When Pass 3 is enabled, this function loads `@xenova/transformers` (via
 * `getEmbeddingProvider`), embeds all eligible function texts, and compares
 * all O(n²) pairs. The structural filter (`requireStructuralDifference`)
 * rejects same-structure-different-behavior FPs (the 3 by-type control pairs
 * v6-2, v6-3, v6-5 all have stmtRatio = 1.0). The `crossFileOnly` filter
 * (default true) rejects same-file pairs (Pass 2 covers same-file).
 *
 * Tradeoff (documented in EXP407):
 * - threshold = 0.95 (default): ~0 FP on production source (express 0, zod
 * 1, lodash 0 cross-file FPs on 50-file samples), catches 0/6 missed-
 * equivalent TPs (all have embScore < 0.95).
 * - threshold = 0.4 (aggressive): catches 6/6 missed-equivalent TPs, but
 * ~21,000 cross-file FPs on lodash (612 functions). NOT recommended for
 * production.
 *
 * The 6 missed-equivalent pairs (N1-N6+7 small variants) require a stronger
 * semantic check (cross-encoder, behavior testing) — future work.
 */
export async function detectDuplicateBodiesWithPass3(
  opts: DuplicateBodyOptions,
): Promise<DuplicateBodyResult> {
  // When Pass 3 is disabled, delegate to the sync version (no model load).
  if (!opts.embeddingPass3 || !opts.embeddingPass3.enabled) {
    return detectDuplicateBodies(opts);
  }
  // Run the sync base (Pass 1/2/2.5/2.6) first.
  const baseResult = detectDuplicateBodies(opts);
  // Collect the already-flagged pair keys so Pass 3 skips them.
  const alreadyFlaggedPairKeys = new Set<string>();
  const byCluster = new Map<string, DuplicateBodyFinding[]>();
  for (const f of baseResult.findings) {
    const list = byCluster.get(f.cluster);
    if (list) list.push(f);
    else byCluster.set(f.cluster, [f]);
  }
  for (const [, fs] of byCluster) {
    for (let i = 0; i < fs.length; i += 1) {
      for (let j = i + 1; j < fs.length; j += 1) {
        const a = fs[i]!;
        const b = fs[j]!;
        const key = a.file < b.file || (a.file === b.file && a.line <= b.line)
          ? `${a.file}:${a.line}|${b.file}:${b.line}`
          : `${b.file}:${b.line}|${a.file}:${a.line}`;
        alreadyFlaggedPairKeys.add(key);
      }
    }
  }
  // Run Pass 3.
  const minBodySize = opts.minBodySize ?? DEFAULT_MIN_BODY_SIZE;
  const minTokenCount = opts.minTokenCount ?? DEFAULT_MIN_TOKEN_COUNT;
  const functions = collectAllFunctions(opts.sources);
  const pass3Pairs = await pass3EmbeddingSemantic(
    functions,
    minBodySize,
    minTokenCount,
    alreadyFlaggedPairKeys,
    opts.embeddingPass3,
  );
  if (pass3Pairs.length === 0) return baseResult;
  // Append Pass 3 findings (deduplicated by pair key against the base).
  const findings: DuplicateBodyFinding[] = [...baseResult.findings];
  const flaggedPairs = new Set(alreadyFlaggedPairKeys);
  for (const pair of pass3Pairs) {
    const pairKey = pair.a.path < pair.b.path || (pair.a.path === pair.b.path && pair.a.line <= pair.b.line)
      ? `${pair.a.path}:${pair.a.line}|${pair.b.path}:${pair.b.line}`
      : `${pair.b.path}:${pair.b.line}|${pair.a.path}:${pair.a.line}`;
    if (flaggedPairs.has(pairKey)) continue;
    if (pair.a.exactHash === pair.b.exactHash) {
      flaggedPairs.add(pairKey);
      continue;
    }
    const pairFns = [pair.a, pair.b];
    const allowlistedCross = isCrossFileAllowlisted(pair.a.normalizedHash, pairFns, opts.allowlistCross) ||
      isCrossFileAllowlisted(pair.a.exactHash, pairFns, opts.allowlistCross) ||
      isCrossFileAllowlisted(pair.b.exactHash, pairFns, opts.allowlistCross);
    const allowlistedSameFile = isSameFileAllowlisted(pair.a.normalizedHash, pairFns, opts.allowlistSameFile) ||
      isSameFileAllowlisted(pair.a.exactHash, pairFns, opts.allowlistSameFile) ||
      isSameFileAllowlisted(pair.b.exactHash, pairFns, opts.allowlistSameFile);
    if (allowlistedCross || allowlistedSameFile) continue;
    findings.push(
      { file: pair.a.path, line: pair.a.line, name: pair.a.name, bodySize: pair.a.bodySize, passes: "embedding", cluster: pairKey },
      { file: pair.b.path, line: pair.b.line, name: pair.b.name, bodySize: pair.b.bodySize, passes: "embedding", cluster: pairKey },
    );
    flaggedPairs.add(pairKey);
  }
  return {
    findings: findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
    mirrorViolations: baseResult.mirrorViolations,
    contractTests: baseResult.contractTests,
  };
}

/**
 * Compute the exact + normalized hashes for every function in scope, so the
 * allowlist author can identify which functions share hashes and populate
 * `test/prevention/duplicate-bodies-allowlist.json` with the correct hashes.
 * The hashes depend on the exact current bytes (which mutate with every
 * commit), so this helper is the authoritative source of allowlist hashes.
 */
export function computeBodyHashes(
  sources: readonly { path: string; content: string }[],
): readonly BodyHashEntry[] {
  const functions = collectAllFunctions(sources);
  return functions.map((fn) => ({
    path: fn.path,
    line: fn.line,
    name: fn.name,
    bodySize: fn.bodySize,
    exactHash: fn.exactHash,
    normalizedHash: fn.normalizedHash,
  }));
}

// ============================================================================
// Debug exports (underscore-prefixed, NOT part of the public API).
// Used by probes in /home/example/code-harness-workspaces/landlock-self-protection-v1/probes/
// to dump the EXACT token streams the detector produces for V3/V4/V5 fixture
// pairs. Keeping these here (vs re-implementing walkV2 in each probe) avoids
// the stale-probe drift problem documented in the V3 run.mjs stale-probe warning.
//
// Round 5.3: these are RE-EXPORTS of existing internal functions (via
// `export {... as... }`), NOT new wrapper functions. New wrapper functions
// would be scanned by the detector itself and could match real functions at
// below-production minTokenCount (mt=1), creating new FPs. Re-exporting avoids
// creating new function bodies — the detector scans the original internal
// functions (which it already does), so no new findings. (The first attempt
// used wrapper functions; the FP stress test at mt=1 found a new FP where
// `_debugCollectFunctions` matched `enumerateDurableDirectory` — both small
// functions with similar structure. Re-exports eliminate this FP.)
// ============================================================================

export {
  collectAllFunctions as _debugCollectFunctions,
  normalizeTokensV2 as _debugNormalizeTokensV2,
  computeIterationBodyTokens as _debugComputeIterationBodyTokens,
  collectKnownNumeric as _debugCollectKnownNumeric,
}
