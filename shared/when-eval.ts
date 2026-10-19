/**
 * When-clause evaluator — a tiny declarative visibility predicate language.
 *
 * UI schema entries carry an optional `when` string. The frontend evaluates
 * it against a UI context object to decide whether the entry is visible. This
 * mirrors VS Code's `when` clause contexts (a lightweight subset).
 *
 * Supported grammar:
 * key — truthy (key present and truthy)
 *!key — falsy (key absent, null, false, 0, "")
 * key == 'value'string/number/boolean equality
 * key!= 'value'inequality
 * key == null — null check
 * key!= null — not-null check
 * expr1 && expr2 — logical AND
 * expr1 || expr2 — logical OR
 * (expr) — grouping
 *
 * Dotted paths resolve against nested context: `run.status` reads
 * `ctx.run.status`. Missing segments resolve to `undefined` (falsy).
 *
 * The evaluator is pure and dependency-free so it is unit-testable in Node.
 */

export type WhenContext = Readonly<Record<string, unknown>>;

/**
 * The grammar's OPERATOR vocabulary, declared by the parser that accepts
 * them — the one owner. A predicate palette or autocomplete that offers
 * operators derives them from THIS list, never a hand restatement, so an
 * operator the tokenizer refuses can never be offered and an operator it
 * gains can never be missed.
 */
export const WHEN_OPERATORS: readonly string[] = Object.freeze([
  "==", "!=", ">=", "<=", ">", "<", "&&", "||", "!",
]);

/** Evaluate a `when` expression against a context. Empty/undefined → true. */
/**
 * Parsed-expression cache.
 *
 * Every call used to re-tokenise and re-parse. Predicates are evaluated on
 * every store tick for every module, so the same handful of short strings were
 * being parsed thousands of times a second. The expression text is the perfect
 * cache key: the grammar is pure, so the same string always yields the same
 * tree.
 *
 * Bounded so a pathological caller cannot grow it without limit; predicates
 * come from declarations, so the real working set is tiny.
 */
const AST_CACHE = new Map<string, Node>();
const AST_CACHE_MAX = 512;

function parseCached(expr: string): Node {
  const hit = AST_CACHE.get(expr);
  if (hit !== undefined) return hit;
  const parser = new Parser(tokenize(expr));
  const ast = parser.parseExpr();
  parser.expectEnd();
  if (AST_CACHE.size >= AST_CACHE_MAX) AST_CACHE.clear();
  AST_CACHE.set(expr, ast);
  return ast;
}

export function evalWhen(expr: string | undefined, ctx: WhenContext): boolean {
  if (expr === undefined || expr.trim() === "") return true;
  return evalAst(parseCached(expr), ctx);
}

// ── Tokenizer ──

type Tok =
  | { type: "ident"; value: string }
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "op"; value: "!" | "==" | "!=" | ">" | "<" | ">=" | "<=" | "&&" | "||" | "(" | ")" }
  | { type: "keyword"; value: "null" | "true" | "false" };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    // whitespace
    if (/\s/u.test(ch)) { i++; continue; }
    // string literal
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      let str = "";
      while (i < src.length && src[i] !== quote) {
        // Quoted literals can contain their delimiter and backslashes.
        // Keep unknown escape pairs literal (e.g. a Windows path's \t).
        if (src[i] === "\\" && (src[i + 1] === quote || src[i + 1] === "\\")) i++;
        str += src[i];
        i++;
      }
      if (src[i] !== quote) throw new WhenParseError(`unterminated string in "${src}"`);
      i++;
      toks.push({ type: "string", value: str });
      continue;
    }
    // number literal
    if (/[0-9]/u.test(ch) || (ch === "-" && /[0-9]/u.test(src[i + 1] ?? ""))) {
      let num = ch;
      i++;
      while (i < src.length && /[0-9.]/u.test(src[i]!)) { num += src[i]; i++; }
      toks.push({ type: "number", value: Number(num) });
      continue;
    }
    // two-char operators
    const two = src.slice(i, i + 2);
    if (two === ">=" || two === "<=") {
      toks.push({ type: "op", value: two });
      i += 2;
      continue;
    }
    if (two === "==" || two === "!=" || two === "&&" || two === "||") {
      toks.push({ type: "op", value: two as "==" | "!=" | "&&" | "||" });
      i += 2;
      continue;
    }
    // single-char operators
    if (ch === ">" || ch === "<") {
      toks.push({ type: "op", value: ch });
      i++;
      continue;
    }
    if (ch === "!" || ch === "(" || ch === ")") {
      toks.push({ type: "op", value: ch });
      i++;
      continue;
    }
    // identifier / keyword
    if (/[a-zA-Z_]/u.test(ch)) {
      let ident = ch;
      i++;
      while (i < src.length && /[a-zA-Z0-9_.]/u.test(src[i]!)) { ident += src[i]; i++; }
      if (ident === "null" || ident === "true" || ident === "false") {
        toks.push({ type: "keyword", value: ident });
      } else {
        toks.push({ type: "ident", value: ident });
      }
      continue;
    }
    throw new WhenParseError(`unexpected character "${ch}" in "${src}"`);
  }
  return toks;
}

// ── AST ──

type Node =
  | { type: "ident"; value: string }
  | { type: "literal"; value: string | number | boolean | null }
  | { type: "not"; operand: Node }
  | { type: "binary"; op: "==" | "!=" | ">" | "<" | ">=" | "<=" | "&&" | "||"; left: Node; right: Node };

// ── Parser (recursive descent) ──

class Parser {
  private pos = 0;
  private toks: Tok[];

  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }

  private next(): Tok {
    const t = this.toks[this.pos];
    if (!t) throw new WhenParseError("unexpected end of expression");
    this.pos++;
    return t;
  }

  parseExpr(): Node {
    return this.parseOr();
  }

  private parseOr(): Node {
    let left = this.parseAnd();
    while (this.peek()?.type === "op" && this.peek()!.value === "||") {
      this.next();
      const right = this.parseAnd();
      left = { type: "binary", op: "||", left, right };
    }
    return left;
  }

  private parseAnd(): Node {
    let left = this.parseNot();
    while (this.peek()?.type === "op" && this.peek()!.value === "&&") {
      this.next();
      const right = this.parseNot();
      left = { type: "binary", op: "&&", left, right };
    }
    return left;
  }

  private parseNot(): Node {
    if (this.peek()?.type === "op" && this.peek()!.value === "!") {
      this.next();
      return { type: "not", operand: this.parseNot() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Node {
    const t = this.next();
    if (t.type === "op" && t.value === "(") {
      const inner = this.parseExpr();
      const close = this.next();
      if (!(close.type === "op" && close.value === ")")) {
        throw new WhenParseError("expected ')'");
      }
      return inner;
    }
    if (t.type === "ident") {
      // Could be a comparison: ident == literal / ident!= literal
      const p = this.peek();
      if (
        p?.type === "op" &&
        (p.value === "==" || p.value === "!=" ||
         p.value === ">" || p.value === "<" || p.value === ">=" || p.value === "<=")
      ) {
        const op = this.next().value as "==" | "!=" | ">" | "<" | ">=" | "<=";
        // The right-hand side may now be an IDENT as well as a literal, so a
        // predicate can compare two context paths (`data.used > data.limit`)
        // rather than only a path against a constant.
        const rhs = this.next();
        const right: Node = rhs.type === "ident"
          ? { type: "ident", value: rhs.value }
          : this.toLiteral(rhs);
        return { type: "binary", op, left: { type: "ident", value: t.value }, right };
      }
      return { type: "ident", value: t.value };
    }
    if (t.type === "keyword") {
      return { type: "literal", value: keywordValue(t.value) };
    }
    if (t.type === "string") {
      return { type: "literal", value: t.value };
    }
    if (t.type === "number") {
      return { type: "literal", value: t.value };
    }
    throw new WhenParseError(`unexpected token: ${JSON.stringify(t)}`);
  }

  private toLiteral(t: Tok): Node {
    if (t.type === "string") return { type: "literal", value: t.value };
    if (t.type === "number") return { type: "literal", value: t.value };
    if (t.type === "keyword") return { type: "literal", value: keywordValue(t.value) };
    throw new WhenParseError(`expected literal, got ${JSON.stringify(t)}`);
  }

  expectEnd(): void {
    if (this.pos < this.toks.length) {
      throw new WhenParseError(`unexpected trailing token: ${JSON.stringify(this.peek())}`);
    }
  }
}

function keywordValue(k: string): boolean | null {
  if (k === "true") return true;
  if (k === "false") return false;
  return null;
}

// ── Evaluator ──

function evalAst(node: Node, ctx: WhenContext): boolean {
  switch (node.type) {
    case "ident":
      return truthy(resolvePath(ctx, node.value));
    case "literal":
      return truthy(node.value);
    case "not":
      return !evalAst(node.operand, ctx);
    case "binary": {
      if (node.op === "&&") return evalAst(node.left, ctx) && evalAst(node.right, ctx);
      if (node.op === "||") return evalAst(node.left, ctx) || evalAst(node.right, ctx);
      const left = resolveIdent(node.left, ctx);
      // The RHS may be an ident now, so resolve it the same way rather than
      // assuming a literal.
      const right = resolveIdent(node.right, ctx);
      if (node.op === "==") return looseEqual(left, right);
      if (node.op === "!=") return !looseEqual(left, right);
      // Relational operators are NUMERIC. A non-numeric operand makes the
      // comparison false rather than throwing: a predicate over data that has
      // not arrived yet should hide the thing, not crash the render.
      const ln = toNumber(left);
      const rn = toNumber(right);
      if (ln === undefined || rn === undefined) return false;
      switch (node.op) {
        case ">": return ln > rn;
        case "<": return ln < rn;
        case ">=": return ln >= rn;
        case "<=": return ln <= rn;
      }
    }
  }
}

/** Coerce to a finite number, or undefined when not numeric. */
function toNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function resolveIdent(node: Node, ctx: WhenContext): unknown {
  if (node.type === "ident") return resolvePath(ctx, node.value);
  if (node.type === "literal") return node.value;
  // Fallback: evaluate the sub-expression to a boolean (shouldn't normally happen).
  return evalAst(node, ctx);
}

/** Resolve a dotted path against a nested object. Missing → undefined. */
export function resolvePath(obj: Readonly<Record<string, unknown>> | null | undefined, path: string): unknown {
  if (obj === null || obj === undefined) return undefined;
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Readonly<Record<string, unknown>>)[part];
  }
  return cur;
}

function truthy(v: unknown): boolean {
  return v !== null && v !== undefined && v !== false && v !== 0 && v !== "";
}

/** Loose equality: coerces the resolved value to compare against the literal. */
function looseEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  // null checks: `key == null` should match when key is undefined or null.
  if (right === null) return left === null || left === undefined;
  if (left === null || left === undefined) return false;
  // Coerce: compare as strings so `status == 'running'` works when status is a string.
  return String(left) === String(right);
}

// ── Typed error ──

export class WhenParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhenParseError";
  }
}
