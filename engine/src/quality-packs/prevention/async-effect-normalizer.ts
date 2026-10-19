/**
 * D3 / N2 — Algebraic-effect normalizer for async↔sync equivalence.
 *
 * Formalization (Plotkin-Pretnar 2009, Leijen-Koka MSR TR-2017-21
 * "Structured Asynchrony with Algebraic Effects"):
 * An algebraic effect is an operation `op: A -> B` paired with a handler H.
 * When `op(v)` is performed, the delimited continuation `k: B -> Eff` is
 * captured; the handler `H(v, k)` performs the effect and resumes `k`.
 *
 * The three async presentations are the SAME effect ASYNC: A -> B:
 * async/await | `await expr` | code after `await` | JS runtime
 * callback | `fn(args, cb)` | the callback body | dispatcher
 * promise.then | `promise.then(k)` | the arrow/function body `k` | resolver
 *
 * Two async functions are EFFECT-EQUIVALENT iff they perform the same ASYNC
 * operation with the same continuation (modulo accumulator-style normalization).
 *
 * Canonical form (async ITERATION, the N2 shape):
 * ASYNC_ITER <op-tokens> ASYNC_CONT <continuation-tokens>
 *
 * The normalizer extracts two patterns (V4 N2 is the target; the third —
 * recursive-callback iteration — is left to a future iteration):
 * Pattern A — `for + await + accumulate` (async/await iteration):
 * ForStatement/ForOfStatement containing an AwaitExpression.
 * The async op is the awaited expression (e.g. `doubleValue(v)`).
 * The continuation is the loop body statements AFTER the await-binding.
 * Pattern B — `reduce +.then` chain (promise iteration):
 * `values.reduce((acc, v) => acc.then(...), Promise.resolve(0))`.
 * The async op is the non-.then CallExpression inside the chain.
 * The continuation is the innermost.then arrow body.
 *
 * The continuation is normalized with:
 * compound-assignment expansion: `X += Y` -> `X = X + Y` (LHS duplicated).
 * accumulator substitution: the accumulator name (loop form: the LHS of
 * `+=`; reduce form: the outermost.then arrow param) -> `ACCUM`.
 * bound-value substitution: the await-bound name (or the innermost.then
 * arrow param) -> `ASYNC_BOUND`.
 * accumulator-return fusion: `return ACCUM + X` -> `AssignmentExpression
 * BIN_+ ACCUM ACCUM X` (matches the compound-assignment expansion).
 * dead-counter drop: `let X = 0;` whose `X` is used ONLY in `X += 1` and
 * `X === 0? 0: Y` is dropped (since `X === 0? 0: Y ≡ Y` when `X`
 * starts at 0 and increments by 1 exactly when `Y` changes).
 * trailing-return drop: a final `return ACCUM;` (the function's post-loop
 * return or the innermost.then's fall-through return) is dropped.
 * loop-variable update strip: the loop variable's increment (`i++`,
 * `i += 1`) is stripped from the continuation (it's iteration machinery).
 *
 * Sources (see EXP30 / `experiments/algebraic-effects/`):
 * Plotkin-Pretnar 2009 "Handlers of Algebraic Effects"。
 * Leijen-Koka MSR TR-2017-21 "Structured Asynchrony with Algebraic Effects".
 * rpetrich/babel-plugin-transform-async-to-promises (MIT, 2018-01-07)
 * https://github.com/rpetrich/babel-plugin-transform-async-to-promises —
 * confirms the async/await ↔ `Promise.resolve.then` equivalence (the
 * canonical down-leveling transformation). Algorithm inspired by the
 * equivalence; no code extracted (the canonical form is original).
 *
 * Scope: this module is INTENTIONALLY narrow — it only catches the async
 * ITERATION pattern (for+await, reduce+.then). It does NOT catch single-
 * return async wrappers (EXP107 / `ASYNC_RESOLVE`); those are a separate
 * normalization in `duplicate-body-detector.ts` `walkV2`. This module and
 * the `ASYNC_RESOLVE` normalization are COMPLEMENTARY: ASYNC_RESOLVE catches
 * single-return wrappers; this module catches multi-statement iterations.
 */

import { astNode, astNodeArray, astChildren, type AstNode } from "./ast-helpers.ts";
import { jaccard, shingles } from "../../shared/similarity.ts";

/**
 * The extracted async form. `kind="NONE"` means the function does not match
 * any recognized async-iteration pattern. `opTokens` is the canonical tokens
 * for the async operation (e.g. `CALL_doubleValue ID`). `contTokens` is the
 * canonical tokens for the continuation body (e.g. an `IfStatement` chain).
 */
export interface AsyncForm {
  readonly kind: "ASYNC_ITER" | "NONE";
  readonly opTokens: readonly string[];
  readonly contTokens: readonly string[];
}

const ASYNC_NONE: AsyncForm = { kind: "NONE", opTokens: [], contTokens: [] };

/** Extract the async-iteration form from a function node. */
export function extractAsyncForm(fnNode: AstNode): AsyncForm {
  const a = extractForAwaitIteration(fnNode);
  if (a !== null) return a;
  const b = extractReduceThenIteration(fnNode);
  if (b !== null) return b;
  return ASYNC_NONE;
}

/** True if two async forms are equivalent at the given Jaccard threshold. */
export function compareAsyncForms(a: AsyncForm, b: AsyncForm, threshold: number, k: number): { similarity: number; matched: boolean } {
  if (a.kind === "NONE" || b.kind === "NONE") return { similarity: 0, matched: false };
  if (a.kind !== b.kind) return { similarity: 0, matched: false };
  const opSim = jaccard(shingles(a.opTokens, k), shingles(b.opTokens, k));
  const contSim = jaccard(shingles(a.contTokens, k), shingles(b.contTokens, k));
  // Combined similarity: the op must match (the two forms perform the same
  // async operation), and the continuation must match (the bodies are the same).
  // Combined Jaccard = harmonic mean (penalizes either being low). The op
  // tokens are short (often just `CALL_<name> ID`), so the harmonic mean
  // weights the continuation more heavily.
  const combined = harmonicMean(opSim, contSim);
  return { similarity: combined, matched: combined >= threshold };
}

function harmonicMean(a: number, b: number): number {
  if (a <= 0 && b <= 0) return 0;
  return (2 * a * b) / (a + b);
}

// ---------------------------------------------------------------------------
// AST walker (local — does not share state with the detector's `walkV2`).
// ---------------------------------------------------------------------------

function walk(n: AstNode, f: (n: AstNode) => void): void {
  f(n);
  for (const c of astChildren(n)) walk(c, f);
}

// ---------------------------------------------------------------------------
// Discriminative-token emitter (with substitution).
// Identifier <subst[name]> -> marker (ACCUM, ASYNC_BOUND)
// Identifier -> "ID"
// StringLiteral -> "STR_<value>"
// NumericLiteral -> "NUM"
// BooleanLiteral -> "BOOL"
// NullLiteral -> "NULL"
// CallExpression -> "CALL_<callee>" + arg tokens
// MemberExpression -> "DOT_<prop>" + object tokens
// BinaryExpression / LogicalExpression -> "BIN_<op>" + l + r
// AssignmentExpression X += Y -> "AssignmentExpression BIN_+ X X Y"
// IfStatement -> "IfStatement" + test + cons + alt
// ReturnStatement -> "ReturnStatement" + arg
// ExpressionStatement -> bare inner expression (matches walkV2)
// ---------------------------------------------------------------------------

export function emitTokensWithSubst(node: AstNode, out: string[], subst: Readonly<Record<string, string>>): void {
  if (node === null || node === undefined) return;
  if (node.type === "Identifier") {
    const sub = subst[String(node.name)];
    if (sub !== undefined) { out.push(sub); return; }
    out.push("ID");
    return;
  }
  switch (node.type) {
    case "PrivateName":
      out.push("ID");
      return;
    case "StringLiteral":
      out.push("STR_" + String(node.value));
      return;
    case "NumericLiteral":
      out.push("NUM");
      return;
    case "BooleanLiteral":
      out.push("BOOL");
      return;
    case "NullLiteral":
      out.push("NULL");
      return;
    case "RegExpLiteral":
      out.push("REGEX");
      return;
    case "BigIntLiteral":
      out.push("BIGINT");
      return;
    case "TemplateLiteral":
      out.push("TPL");
      for (const c of astChildren(node)) emitTokensWithSubst(c, out, subst);
      return;
    case "MemberExpression": {
      const obj = astNode(node.object);
      const prop = astNode(node.property);
      if (prop !== undefined && prop.type === "Identifier" && !node.computed) {
        out.push("DOT_" + String(prop.name));
      } else {
        out.push("DOT_");
      }
      if (obj !== undefined) emitTokensWithSubst(obj, out, subst);
      return;
    }
    case "CallExpression": {
      const callee = astNode(node.callee);
      if (callee !== undefined && callee.type === "Identifier") {
        out.push("CALL_" + String(callee.name));
      } else if (callee !== undefined && callee.type === "MemberExpression") {
        const prop = astNode(callee.property);
        if (prop !== undefined && prop.type === "Identifier" && !callee.computed) {
          out.push("CALLMETHOD_" + String(prop.name));
        } else {
          out.push("CALLMETHOD_");
        }
        const obj = astNode(callee.object);
        if (obj !== undefined) emitTokensWithSubst(obj, out, subst);
      } else {
        out.push("CALL_");
        if (callee !== undefined) emitTokensWithSubst(callee, out, subst);
      }
      for (const a of astNodeArray(node.arguments)) emitTokensWithSubst(a, out, subst);
      return;
    }
    case "AwaitExpression": {
      out.push("ASYNC_OP");
      const arg = astNode(node.argument);
      if (arg !== undefined) emitTokensWithSubst(arg, out, subst);
      return;
    }
    case "ArrowFunctionExpression":
    case "FunctionExpression":
    case "FunctionDeclaration":
      // Function nesting is the iteration boundary — don't recurse.
      out.push("FN");
      return;
    case "BinaryExpression":
    case "LogicalExpression": {
      out.push("BIN_" + String(node.operator));
      const l = astNode(node.left);
      const r = astNode(node.right);
      if (l !== undefined) emitTokensWithSubst(l, out, subst);
      if (r !== undefined) emitTokensWithSubst(r, out, subst);
      return;
    }
    case "AssignmentExpression": {
      const op = String(node.operator);
      if (op === "+=" || op === "-=" || op === "*=" || op === "/=" || op === "%=") {
        const bareOp = op.slice(0, -1);
        out.push("AssignmentExpression");
        out.push("BIN_" + bareOp);
        const l = astNode(node.left);
        const r = astNode(node.right);
        if (l !== undefined) { emitTokensWithSubst(l, out, subst); emitTokensWithSubst(l, out, subst); }
        if (r !== undefined) emitTokensWithSubst(r, out, subst);
      } else {
        out.push("AssignmentExpression");
        const l = astNode(node.left);
        const r = astNode(node.right);
        if (l !== undefined) emitTokensWithSubst(l, out, subst);
        if (r !== undefined) emitTokensWithSubst(r, out, subst);
      }
      return;
    }
    case "IfStatement": {
      out.push("IfStatement");
      const test = astNode(node.test);
      const cons = astNode(node.consequent);
      const alt = astNode(node.alternate);
      if (test !== undefined) emitTokensWithSubst(test, out, subst);
      if (cons !== undefined) emitTokensWithSubst(cons, out, subst);
      if (alt !== undefined) emitTokensWithSubst(alt, out, subst);
      return;
    }
    case "BlockStatement": {
      for (const c of astNodeArray(node.body)) emitTokensWithSubst(c, out, subst);
      return;
    }
    case "ReturnStatement": {
      out.push("ReturnStatement");
      const arg = astNode(node.argument);
      if (arg !== undefined) emitTokensWithSubst(arg, out, subst);
      return;
    }
    case "VariableDeclaration": {
      out.push(node.type);
      for (const d of astNodeArray(node.declarations)) emitTokensWithSubst(d, out, subst);
      return;
    }
    case "VariableDeclarator": {
      out.push(node.type);
      const id = astNode(node.id);
      const init = astNode(node.init);
      if (id !== undefined) emitTokensWithSubst(id, out, subst);
      if (init !== undefined) emitTokensWithSubst(init, out, subst);
      return;
    }
    case "ForStatement":
    case "ForOfStatement":
    case "ForInStatement":
    case "WhileStatement":
    case "DoWhileStatement": {
      // The continuation shouldn't contain loops (the async iter is the only
      // loop); but if it does, treat as a generic node (emit type + children).
      out.push(node.type);
      for (const c of astChildren(node)) emitTokensWithSubst(c, out, subst);
      return;
    }
    case "UnaryExpression": {
      out.push("UnaryExpression");
      const arg = astNode(node.argument);
      if (arg !== undefined) emitTokensWithSubst(arg, out, subst);
      return;
    }
    case "ExpressionStatement": {
      // Drop the wrapper — emit the inner expression (matches walkV2).
      const expr = astNode(node.expression);
      if (expr !== undefined) emitTokensWithSubst(expr, out, subst);
      return;
    }
    case "ConditionalExpression": {
      // Rewrite as an IfStatement with implicit-return consequent/alternate
      // (aligns the bare-ternary form with the if/return form).
      out.push("IfStatement");
      const test = astNode(node.test);
      const cons = astNode(node.consequent);
      const alt = astNode(node.alternate);
      if (test !== undefined) emitTokensWithSubst(test, out, subst);
      out.push("ReturnStatement");
      if (cons !== undefined) emitTokensWithSubst(cons, out, subst);
      out.push("ReturnStatement");
      if (alt !== undefined) emitTokensWithSubst(alt, out, subst);
      return;
    }
    case "TSNonNullExpression":
    case "TSAsExpression":
    case "TSTypeAssertion": {
      // Drop TS wrappers (matches walkV2 TS handling).
      const expr = astNode(node.expression);
      if (expr !== undefined) emitTokensWithSubst(expr, out, subst);
      return;
    }
    default: {
      out.push(node.type);
      for (const c of astChildren(node)) emitTokensWithSubst(c, out, subst);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Dead-counter analysis.
// A "dead counter" is a `let X = 0;` declaration where X is ONLY used in:
// - `X += 1` (increment by literal 1)
// - `X === 0` (test against literal 0, inside a ConditionalExpression)
// Such a counter is semantically redundant: `X === 0? 0: Y` is equivalent
// to `Y` when X starts at 0 and increments by 1 exactly when Y changes.
// For V4 N2 original: `count` is a dead counter. Dropping `count += 1` and
// replacing `count === 0? 0: sum` with `sum` makes the original
// continuation match the mutant continuation.
// ---------------------------------------------------------------------------

function findDeadCounters(fnBody: AstNode): Set<string> {
  const candidates = new Set<string>();
  for (const s of astNodeArray(fnBody.body)) {
    if (s.type === "VariableDeclaration" && s.kind === "let") {
      for (const d of astNodeArray(s.declarations)) {
        const id = astNode(d.id);
        const init = astNode(d.init);
        if (
          id !== undefined && id.type === "Identifier" &&
          init !== undefined && init.type === "NumericLiteral" && init.value === 0
        ) {
          candidates.add(String(id.name));
        }
      }
    }
  }
  if (candidates.size === 0) return new Set();
  const dead = new Set<string>();
  for (const name of candidates) {
    if (checkAllUsesDead(fnBody, name)) dead.add(name);
  }
  return dead;
}

function checkAllUsesDead(root: AstNode, name: string): boolean {
  let isDead = true;
  const skipIds = new Set<AstNode>();
  walk(root, (n) => {
    if (n.type === "VariableDeclarator") {
      const id = astNode(n.id);
      if (id !== undefined && id.type === "Identifier" && String(id.name) === name) {
        skipIds.add(id);
      }
    }
  });
  const visit = (node: AstNode, parent: AstNode | undefined, parentKey: string | undefined): void => {
    if (!isDead) return;
    if (node.type === "Identifier" && String(node.name) === name) {
      if (parent !== undefined && parentKey === "id" && parent.type === "VariableDeclarator") {
        return; // declaration id — not a use.
      }
      if (parent !== undefined && parent.type === "AssignmentExpression" && parentKey === "left" && parent.operator === "+=") {
        const r = astNode(parent.right);
        if (r !== undefined && r.type === "NumericLiteral" && r.value === 1) return; // OK: X += 1
        isDead = false;
        return;
      }
      if (parent !== undefined && parent.type === "BinaryExpression" && parent.operator === "===" && (parentKey === "left" || parentKey === "right")) {
        const other = parentKey === "left" ? astNode(parent.right) : astNode(parent.left);
        if (other !== undefined && other.type === "NumericLiteral" && other.value === 0) return; // OK: X === 0
        isDead = false;
        return;
      }
      isDead = false;
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === "type" || k === "loc" || k === "start" || k === "end" || k === "extra") continue;
      if (Array.isArray(v)) {
        for (const e of v) {
          const c = astNode(e);
          if (c !== undefined) visit(c, node, k);
        }
      } else {
        const c = astNode(v);
        if (c !== undefined) visit(c, node, k);
      }
    }
  };
  visit(root, undefined, undefined);
  return isDead;
}

/** Drop dead-counter uses from a list of statements. Returns a new array. */
function dropDeadCounters(stmts: readonly AstNode[], dead: Set<string>): AstNode[] {
  if (dead.size === 0) return [...stmts];
  return stmts.map((s) => dropDeadInStmt(s, dead)).filter((s): s is AstNode => s !== null);
}

function dropDeadInStmt(node: AstNode, dead: Set<string>): AstNode | null {
  if (node.type === "ExpressionStatement") {
    const e = astNode(node.expression);
    if (e !== undefined && e.type === "AssignmentExpression" && e.operator === "+=") {
      const l = astNode(e.left);
      const r = astNode(e.right);
      if (
        l !== undefined && l.type === "Identifier" && dead.has(String(l.name)) &&
        r !== undefined && r.type === "NumericLiteral" && r.value === 1
      ) {
        return null; // drop `X += 1`
      }
    }
    return node;
  }
  if (node.type === "ReturnStatement") {
    const arg = astNode(node.argument);
    if (arg !== undefined && arg.type === "ConditionalExpression") {
      const test = astNode(arg.test);
      if (test !== undefined && test.type === "BinaryExpression" && test.operator === "===") {
        const l = astNode(test.left);
        const r = astNode(test.right);
        const lIsDead = l !== undefined && l.type === "Identifier" && dead.has(String(l.name));
        const rIsDead = r !== undefined && r.type === "Identifier" && dead.has(String(r.name));
        if (lIsDead || rIsDead) {
          const other = lIsDead ? r : l;
          if (other !== undefined && other.type === "NumericLiteral" && other.value === 0) {
            const alt = astNode(arg.alternate);
            if (alt !== undefined) {
              return { ...node, argument: alt };
            }
          }
        }
      }
    }
    return node;
  }
  if (node.type === "BlockStatement") {
    const newBody = astNodeArray(node.body)
      .map((s) => dropDeadInStmt(s, dead))
      .filter((s): s is AstNode => s !== null);
    return { ...node, body: newBody };
  }
  if (node.type === "IfStatement") {
    const cons = astNode(node.consequent);
    const alt = astNode(node.alternate);
    let newNode: AstNode = node;
    if (cons !== undefined) {
      const newCons = dropDeadInStmt(cons, dead);
      if (newCons !== cons) newNode = { ...newNode, consequent: newCons === null ? { type: "BlockStatement", body: [] } : newCons };
    }
    if (alt !== undefined) {
      const newAlt = dropDeadInStmt(alt, dead);
      if (newAlt !== alt) newNode = { ...newNode, alternate: newAlt === null ? undefined : newAlt };
    }
    return newNode;
  }
  return node;
}

// ---------------------------------------------------------------------------
// Pattern A: `for + await + accumulate` iteration.
// ---------------------------------------------------------------------------

function findAwaitExpr(n: AstNode): AstNode | undefined {
  let found: AstNode | undefined;
  walk(n, (c) => {
    if (found === undefined && c.type === "AwaitExpression") found = c;
  });
  return found;
}

function findLoopWithAwait(fnBody: AstNode): AstNode | undefined {
  let loop: AstNode | undefined;
  walk(fnBody, (c) => {
    if (loop !== undefined) return;
    if (
      c.type === "ForStatement" ||
      c.type === "ForOfStatement" ||
      c.type === "ForInStatement" ||
      c.type === "WhileStatement" ||
      c.type === "DoWhileStatement"
    ) {
      if (findAwaitExpr(c) !== undefined) loop = c;
    }
  });
  return loop;
}

function findLoopVars(loop: AstNode): Set<string> {
  const out = new Set<string>();
  if (loop.type === "ForStatement") {
    const init = astNode(loop.init);
    const update = astNode(loop.update);
    if (init !== undefined && init.type === "VariableDeclaration") {
      for (const d of astNodeArray(init.declarations)) {
        const id = astNode(d.id);
        if (id !== undefined && id.type === "Identifier") out.add(String(id.name));
      }
    }
    if (update !== undefined) {
      if (update.type === "UpdateExpression") {
        const arg = astNode(update.argument);
        if (arg !== undefined && arg.type === "Identifier") out.add(String(arg.name));
      } else if (update.type === "AssignmentExpression") {
        const l = astNode(update.left);
        if (l !== undefined && l.type === "Identifier") out.add(String(l.name));
      }
    }
  } else if (loop.type === "WhileStatement" || loop.type === "DoWhileStatement") {
    const test = astNode(loop.test);
    if (test !== undefined) {
      walk(test, (n) => {
        if (n.type === "Identifier") out.add(String(n.name));
      });
    }
  } else if (loop.type === "ForOfStatement" || loop.type === "ForInStatement") {
    const left = astNode(loop.left);
    if (left !== undefined) {
      if (left.type === "VariableDeclaration") {
        for (const d of astNodeArray(left.declarations)) {
          const id = astNode(d.id);
          if (id !== undefined && id.type === "Identifier") out.add(String(id.name));
        }
      } else if (left.type === "Identifier") {
        out.add(String(left.name));
      }
    }
  }
  return out;
}

/** Strip ExpressionStatements that are bare loop-var updates. */
function stripLoopVarUpdates(stmts: AstNode[], loopVars: Set<string>): AstNode[] {
  if (loopVars.size === 0) return stmts;
  return stmts.filter((s) => {
    if (s.type !== "ExpressionStatement") return true;
    const e = astNode(s.expression);
    if (e === undefined) return true;
    if (e.type === "UpdateExpression") {
      const arg = astNode(e.argument);
      if (arg !== undefined && arg.type === "Identifier" && loopVars.has(String(arg.name))) return false;
    }
    if (e.type === "AssignmentExpression") {
      const l = astNode(e.left);
      if (l !== undefined && l.type === "Identifier" && loopVars.has(String(l.name))) return false;
    }
    return true;
  });
}

/** If a TryStatement contains an AwaitExpression in its try-block, replace the
 * TryStatement with the try-block's statements (the catch is the error
 * handler — for the canonical form, the try-block body IS the continuation,
 * and the catch's `.catch` equivalent is handled by the algebraic-effect
 * normalization at the higher level — both `for+await+try-catch` and
 * `reduce+.then+.catch` produce the same canonical continuation if the
 * try-block /.then-arrow body are the same). Returns the new statement list.
 * Only flattens a single level (top-level TryStatements in `stmts`). */
function flattenTryAroundAwait(stmts: AstNode[]): AstNode[] {
  const out: AstNode[] = [];
  for (const s of stmts) {
    if (s.type === "TryStatement") {
      const block = astNode(s.block);
      if (block !== undefined && block.type === "BlockStatement") {
        // Only flatten if the try-block contains an AwaitExpression.
        if (findAwaitExpr(block) !== undefined) {
          out.push(...astNodeArray(block.body));
          continue;
        }
      }
    }
    out.push(s);
  }
  return out;
}

/** Find the accumulator name (LHS of `X += Y` in the loop body, excluding dead
 * counters and loop vars). */
function findAccumulatorName(loopBody: AstNode, dead: Set<string>): string | undefined {
  let name: string | undefined;
  walk(loopBody, (n) => {
    if (name !== undefined) return;
    if (n.type === "AssignmentExpression") {
      const op = String(n.operator);
      if (op === "+=" || op === "-=" || op === "*=" || op === "/=" || op === "%=") {
        const l = astNode(n.left);
        if (l !== undefined && l.type === "Identifier") {
          const nm = String(l.name);
          if (!dead.has(nm)) name = nm;
        }
      }
    }
  });
  return name;
}

function extractForAwaitIteration(fnNode: AstNode): AsyncForm | null {
  const body = astNode(fnNode.body);
  if (body === undefined || body.type !== "BlockStatement") return null;
  const loop = findLoopWithAwait(body);
  if (loop === undefined) return null;
  const loopBody = astNode(loop.body);
  if (loopBody === undefined) return null;
  const deadCounters = findDeadCounters(body);
  const loopVars = findLoopVars(loop);
  const accumName = findAccumulatorName(loopBody, new Set([...deadCounters, ...loopVars]));
  let stmts: AstNode[] = loopBody.type === "BlockStatement" ? [...astNodeArray(loopBody.body)] : [loopBody];
  // Flatten try-catch wrappers around await (so the await's containing
  // statements become top-level statements of the loop body). MUST run before
  // dropDeadCounters / stripLoopVarUpdates so they can see inside the try block.
  stmts = flattenTryAroundAwait(stmts);
  stmts = dropDeadCounters(stmts, deadCounters);
  stmts = stripLoopVarUpdates(stmts, loopVars);
  // Find the statement that contains an await.
  let awaitStmtIdx = -1;
  let awaitExpr: AstNode | undefined;
  let boundVar: string | undefined;
  for (let i = 0; i < stmts.length; i += 1) {
    const s = stmts[i]!;
    const aw = findAwaitExpr(s);
    if (aw !== undefined) {
      awaitStmtIdx = i;
      awaitExpr = aw;
      if (s.type === "VariableDeclaration") {
        for (const d of astNodeArray(s.declarations)) {
          const id = astNode(d.id);
          const init = astNode(d.init);
          if (id !== undefined && id.type === "Identifier" && init !== undefined && findAwaitExpr(init) !== undefined) {
            boundVar = String(id.name);
          }
        }
      }
      break;
    }
  }
  if (awaitStmtIdx === -1 || awaitExpr === undefined) return null;
  const opArg = astNode(awaitExpr.argument);
  const opTokens: string[] = [];
  if (opArg !== undefined) emitTokensWithSubst(opArg, opTokens, {});
  const subst: Record<string, string> = {};
  if (boundVar !== undefined) subst[boundVar] = "ASYNC_BOUND";
  if (accumName !== undefined) subst[accumName] = "ACCUM";
  // Continuation: loop body statements AFTER the await-binding.
  const contTokens: string[] = [];
  for (let i = awaitStmtIdx + 1; i < stmts.length; i += 1) {
    emitTokensWithSubst(stmts[i]!, contTokens, subst);
  }
  // Also include the post-loop statements (the final `return...`), with
  // dead-counter dropping applied.
  const postLoopStmts = astNodeArray(body.body).filter((s) => s !== loop);
  const postLoopDropped = dropDeadCounters(postLoopStmts, deadCounters);
  for (const s of postLoopDropped) {
    if (s.type === "ReturnStatement") {
      const arg = astNode(s.argument);
      // Drop a trailing `return ACCUM;` (the final `return sum;` — it's the
      // mutant's fall-through return's twin).
      if (arg !== undefined && arg.type === "Identifier" && accumName !== undefined && String(arg.name) === accumName) {
        continue; // drop
      }
      contTokens.push("ReturnStatement");
      if (arg !== undefined) emitTokensWithSubst(arg, contTokens, subst);
    }
  }
  // Accumulator-return fusion: replace `ReturnStatement BIN_+ ACCUM X` with
  // `AssignmentExpression BIN_+ ACCUM ACCUM X` (matches the compound-assignment
  // expansion `ACCUM += X` -> `AssignmentExpression BIN_+ ACCUM ACCUM X`).
  fuseAccumulatorReturns(contTokens, "+");
  fuseAccumulatorReturns(contTokens, "-");
  // Drop a trailing `ReturnStatement ACCUM` (the fall-through return).
  if (contTokens.length >= 2 && contTokens[contTokens.length - 2] === "ReturnStatement" && contTokens[contTokens.length - 1] === "ACCUM") {
    contTokens.splice(contTokens.length - 2, 2);
  }
  return { kind: "ASYNC_ITER", opTokens, contTokens };
}

/** Replace `ReturnStatement BIN_<op> ACCUM X...` with
 * `AssignmentExpression BIN_<op> ACCUM ACCUM X...` in-place. */
function fuseAccumulatorReturns(toks: string[], op: string): void {
  const marker = "BIN_" + op;
  for (let i = 0; i + 2 < toks.length; i += 1) {
    if (toks[i] === "ReturnStatement" && toks[i + 1] === marker && toks[i + 2] === "ACCUM") {
      toks.splice(i, 2, "AssignmentExpression", marker, "ACCUM");
      // Now the sequence is: AssignmentExpression BIN_+ ACCUM [rest] — same as
      // the compound-assignment expansion (with the duplicated LHS).
      i += 1; // skip the marker we just inserted
    }
  }
}

// ---------------------------------------------------------------------------
// Pattern B: `reduce +.then` chain iteration.
// ---------------------------------------------------------------------------

function findReduceThenChain(fnBody: AstNode): AstNode | undefined {
  let target: AstNode | undefined;
  walk(fnBody, (n) => {
    if (target !== undefined) return;
    if (n.type === "CallExpression") {
      const callee = astNode(n.callee);
      if (callee !== undefined && callee.type === "MemberExpression") {
        const prop = astNode(callee.property);
        if (prop !== undefined && prop.type === "Identifier" && String(prop.name) === "reduce") {
          const cb = astNode(astNodeArray(n.arguments)[0]);
          if (cb !== undefined && (cb.type === "ArrowFunctionExpression" || cb.type === "FunctionExpression")) {
            const cbBody = astNode(cb.body);
            if (cbBody !== undefined && containsThenChain(cbBody)) target = n;
          }
        }
      }
    }
  });
  return target;
}

function containsThenChain(n: AstNode): boolean {
  let found = false;
  walk(n, (c) => {
    if (found) return;
    if (c.type === "CallExpression") {
      const callee = astNode(c.callee);
      if (callee !== undefined && callee.type === "MemberExpression") {
        const prop = astNode(callee.property);
        if (prop !== undefined && prop.type === "Identifier" && String(prop.name) === "then") {
          found = true;
        }
      }
    }
  });
  return found;
}

/** Find the outermost `.then(...)` call in `node`. Handles `.catch` / `.finally`
 * wrappers (a `.then` inside a `.catch` chain is the object of the `.catch`
 * call — e.g. `x.then(a).catch(b)` has the `.then` as the object of `.catch`). */
function findOutermostThen(node: AstNode): AstNode | undefined {
  if (node.type === "CallExpression") {
    const callee = astNode(node.callee);
    if (callee !== undefined && callee.type === "MemberExpression") {
      const prop = astNode(callee.property);
      if (prop !== undefined && prop.type === "Identifier") {
        const name = String(prop.name);
        if (name === "then") return node;
        // Unwrap `.catch` / `.finally` — recurse on the object (the underlying
        // promise chain). For `x.then(a).catch(b)`, the object is `x.then(a)`.
        if (name === "catch" || name === "finally") {
          const obj = astNode(callee.object);
          if (obj !== undefined) return findOutermostThen(obj);
        }
      }
    }
  }
  if (node.type === "BlockStatement") {
    const stmts = astNodeArray(node.body);
    if (stmts.length === 1 && stmts[0]!.type === "ReturnStatement") {
      return findOutermostThen(stmts[0]!);
    }
  }
  if (node.type === "ReturnStatement") {
    const arg = astNode(node.argument);
    if (arg !== undefined) return findOutermostThen(arg);
  }
  return undefined;
}

/** Find a non-`.then` CallExpression inside `node` — the async op. */
function findNonThenCall(node: AstNode, accName: string | undefined): AstNode | undefined {
  let found: AstNode | undefined;
  walk(node, (c) => {
    if (found !== undefined) return;
    if (c.type === "CallExpression") {
      const callee = astNode(c.callee);
      if (callee !== undefined && callee.type === "MemberExpression") {
        const prop = astNode(callee.property);
        if (prop !== undefined && prop.type === "Identifier") {
          // skip `.then` calls (the chain itself); skip other member calls too
          // (only the bare Identifier callee is the async op).
          return;
        }
      }
      if (callee !== undefined && callee.type === "Identifier") {
        if (accName !== undefined && String(callee.name) === accName) return; // skip the accumulator itself
        found = c;
      }
    }
  });
  return found;
}

interface ThenChainInfo {
  opExpr: AstNode | undefined;
  contBody: AstNode | undefined;
  contParam: string | undefined;
  accumName: string | undefined;
}

function walkThenChain(node: AstNode, accName: string | undefined): ThenChainInfo | null {
  const outerThen = findOutermostThen(node);
  if (outerThen === undefined) return null;
  let current: AstNode | undefined = outerThen;
  let outermostParam: string | undefined;
  let opExpr: AstNode | undefined;
  let contBody: AstNode | undefined;
  let contParam: string | undefined;
  let depth = 0;
  while (current !== undefined) {
    const arrowArg = astNode(astNodeArray(current.arguments)[0]);
    if (arrowArg === undefined || (arrowArg.type !== "ArrowFunctionExpression" && arrowArg.type !== "FunctionExpression")) {
      break;
    }
    const arrowBody = astNode(arrowArg.body);
    const arrowParam = astNode(astNodeArray(arrowArg.params)[0]);
    const paramName = arrowParam !== undefined && arrowParam.type === "Identifier" ? String(arrowParam.name) : undefined;
    if (depth === 0) outermostParam = paramName;
    depth += 1;
    const opCall = arrowBody !== undefined ? findNonThenCall(arrowBody, accName) : undefined;
    if (opCall !== undefined && opExpr === undefined) {
      opExpr = opCall;
    }
    const nextThen = arrowBody !== undefined ? findOutermostThen(arrowBody) : undefined;
    if (nextThen === undefined) {
      contBody = arrowBody;
      contParam = paramName;
      break;
    }
    current = nextThen;
  }
  const accumName = outermostParam !== undefined ? outermostParam : accName;
  return { opExpr, contBody, contParam, accumName };
}

function extractReduceThenIteration(fnNode: AstNode): AsyncForm | null {
  const body = astNode(fnNode.body);
  if (body === undefined || body.type !== "BlockStatement") return null;
  const reduceCall = findReduceThenChain(body);
  if (reduceCall === undefined) return null;
  const cb = astNode(astNodeArray(reduceCall.arguments)[0]);
  if (cb === undefined || (cb.type !== "ArrowFunctionExpression" && cb.type !== "FunctionExpression")) return null;
  const cbBody = astNode(cb.body);
  if (cbBody === undefined) return null;
  const params = astNodeArray(cb.params);
  const accParam = params[0];
  const accName = accParam !== undefined && accParam.type === "Identifier" ? String(accParam.name) : undefined;
  const chainInfo = walkThenChain(cbBody, accName);
  if (chainInfo === null) return null;
  const { opExpr, contBody, contParam, accumName } = chainInfo;
  const opTokens: string[] = [];
  if (opExpr !== undefined) emitTokensWithSubst(opExpr, opTokens, {});
  const contTokens: string[] = [];
  if (contBody !== undefined) {
    emitContFromThenBody(contBody, contParam, accumName, contTokens);
  }
  return { kind: "ASYNC_ITER", opTokens, contTokens };
}

function emitContFromThenBody(
  contBody: AstNode,
  contParam: string | undefined,
  accName: string | undefined,
  out: string[],
): void {
  let body: AstNode = contBody;
  // If the body is a bare ConditionalExpression, rewrite as a BlockStatement
  // with an IfStatement (so the accumulator-return fusion fires).
  if (body.type === "ConditionalExpression") {
    body = {
      type: "BlockStatement",
      body: [
        {
          type: "IfStatement",
          test: body.test,
          consequent: {
            type: "BlockStatement",
            body: [{ type: "ReturnStatement", argument: body.consequent }],
          },
          alternate: { type: "ReturnStatement", argument: body.alternate },
        } as AstNode,
      ],
    } as AstNode;
  }
  const subst: Record<string, string> = {};
  if (contParam !== undefined) subst[contParam] = "ASYNC_BOUND";
  if (accName !== undefined) subst[accName] = "ACCUM";
  emitTokensWithSubst(body, out, subst);
  fuseAccumulatorReturns(out, "+");
  fuseAccumulatorReturns(out, "-");
  if (out.length >= 2 && out[out.length - 2] === "ReturnStatement" && out[out.length - 1] === "ACCUM") {
    out.splice(out.length - 2, 2);
  }
}

// ---------------------------------------------------------------------------
// Jaccard over k-shingles — reuses the canonical owner (shared/similarity.ts).
// The local duplicate copies were removed (No Scattered Helpers, ).
// The canonical `jaccard` returns 0 when either set is empty (conservative
// for dedup); `shingles` always produces a non-empty set (at minimum
// `Set([""])`), so the empty-case divergence between the former local copy
// (which returned 1 when both empty) and the canonical copy never manifests
// in practice. The canonical owner is now the single implementation.
// ---------------------------------------------------------------------------
