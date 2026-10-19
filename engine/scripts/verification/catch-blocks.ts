/**
 * THE ONE CATCH CLASSIFIER. Every guard that asks "does this catch handle what
 * it caught?" asks it here, in both repositories.
 *
 * ── THE CLASS THIS EXISTS FOR ─────────────────────────────────────────────
 *
 * Five guards used to answer the question with four copy-pasted lexers and
 * four different rules: the engine's empty-catch guard and its R41/R44-C
 * copies (effectively-empty only), the engine's swallowed/unhandled guard
 * (which accepted a handler NAME anywhere in the body, comments and strings
 * included), a memory guard that looked for the text `handleError` within six
 * lines (a comment satisfied it), and the web guard (which allowed any
 * assignment). One code base, four definitions of "handled" — so a catch that
 * one guard admitted another refused, and the weakest reader decided.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────
 *
 * Bodies are read through the sanctioned `SourceView`: detection runs over
 * `code()` (comments and string interiors blanked), so a comment or a string
 * that NAMES a handler never counts as calling it. A catch body is:
 *
 *   `empty`      blank, or only no-op statements (`void e;`, a bare `e;`);
 *   `unhandled`  it has code but does none of the things below;
 *   `handled`    it throws (or rejects its promise), returns, CALLS a central handler
 *                (`CENTRAL_ERROR_HANDLERS`), or uses the caught binding in
 *                code or in a template substitution (`void e` or a bare `e;`
 *                discards it: not a use). `handledBy` says which, so a guard
 *                can hold a subsystem to a stricter policy on the SAME
 *                reading (the memory rule: a bare catch there must throw or
 *                call a central handler).
 *
 * A `.catch(handler)` with an inline block body is classified exactly like a
 * `try/catch`; an expression-bodied arrow or a handler reference is not a
 * block and is out of scope.
 */
import type { SourceView } from "./source-view.ts";

/**
 * The central handlers a catch may route through; a CALL is required, not a
 * mention. The engine's (`src/shared/debug/debug-system.ts`,
 * `src/shared/best-effort.ts`) and the web server's
 * (`server/observability/debug-bridge.ts`). Console output and
 * `process.emitWarning` are NOT central: they bypass the one logging system,
 * so a catch that only prints is unhandled (a2-design M3; the engine's console
 * ban names the two sink files that may print at all).
 */
export const CENTRAL_ERROR_HANDLERS = Object.freeze([
  "handleError", "reportBestEffortFailure", "bestEffort", "bestEffortAsync", "auditEvent",
  "webHandleError", "webWarn", "webAuditEvent",
] as const);

export type CatchVerdict = "empty" | "unhandled" | "handled";

export interface CatchBlock {
  /** 1-based line of the `catch` keyword in the file. */
  readonly line: number;
  /** `try` for `catch (e) { … }`, `promise` for `.catch((e) => { … })`. */
  readonly form: "try" | "promise";
  /** The caught binding's name, or `null` for `catch { … }` / `() => { … }`. */
  readonly binding: string | null;
  readonly verdict: CatchVerdict;
  /** For a `handled` body, HOW (a guard with a stricter policy for its subsystem reads this); null otherwise. */
  readonly handledBy: CatchHandling | null;
  /** The body as written in code (comments and string interiors blanked), trimmed and shortened for a report. */
  readonly excerpt: string;
}

const KEYWORDS = new Set([
  "return", "continue", "break", "debugger", "throw", "await", "yield", "void", "new", "delete", "typeof",
  "instanceof", "in", "of", "do", "for", "while", "if", "else", "switch", "case", "default", "try", "catch",
  "finally", "var", "let", "const", "function", "class", "extends", "super", "this", "true", "false", "null",
  "undefined", "with", "export", "import", "from", "as", "static", "get", "set", "enum", "async", "type", "namespace",
]);

const HANDLER_CALL = new RegExp(
  `(?<![\\w$.])(?:${CENTRAL_ERROR_HANDLERS.map((name) => name.replace(".", "\\s*\\.\\s*")).join("|")})\\s*\\(`,
  "u",
);

function matchingClose(code: string, open: number, openChar: string, closeChar: string): number {
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    const character = code[index];
    if (character === openChar) depth += 1;
    else if (character === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function skipSpace(code: string, index: number): number {
  let cursor = index;
  while (cursor < code.length && /\s/u.test(code[cursor]!)) cursor += 1;
  return cursor;
}

/** A body's statements, split the way ASI and `;` split them (trimmed, non-empty). */
function statementsOf(body: string): readonly string[] {
  return body.split(/[;\n]/u).map((part) => part.trim()).filter((part) => part.length > 0);
}

/** A `void …` statement: it evaluates and DISCARDS (`void e`, `void extractErrorMessage(e)`). */
function isVoidStatement(statement: string): boolean {
  return /^void(?![\w$])/u.test(statement);
}

function isEffectivelyEmpty(body: string): boolean {
  return statementsOf(body).every((statement) =>
    isVoidStatement(statement) || (/^[A-Za-z_$][\w$]*$/u.test(statement) && !KEYWORDS.has(statement)));
}

/** Template substitutions (`${…}`) inside the comment-blanked body, where the code view blanks them. */
function substitutions(bodyWithTemplates: string): string {
  return [...bodyWithTemplates.matchAll(/\$\{([^`]*?)\}/gu)].map((match) => match[1]).join(" ");
}

/**
 * `body` without its evaluate-and-discard statements (every `void …`
 * statement, and a bare `e;`): they mention the binding and do nothing with
 * it, so they never count as a use (a2-correctness §6: `catch (e) { void e;
 * unrelated(); }` was "handled" by the mention alone, the ASI form
 * `void e⏎cleanup()` too — the same discard the empty verdict already
 * refuses when it is the whole body).
 */
function withoutDiscards(body: string, binding: string): string {
  const name = binding.replace(/\$/gu, "\\$");
  const withoutBare = body.replace(new RegExp(`(^|[;{}\\n])\\s*${name}\\s*;`, "gu"), "$1");
  return statementsOf(withoutBare).filter((statement) => !isVoidStatement(statement)).join("\n");
}

/** How a handled catch body handles what it caught (the strongest first). */
export type CatchHandling = "throw" | "handler" | "return" | "use";

/** Classify one catch body. `body` is the code view; `bodyWithTemplates` keeps template interiors. */
function classifyCatchBody(body: string, bodyWithTemplates: string, binding: string | null): Readonly<{ verdict: CatchVerdict; handledBy: CatchHandling | null }> {
  if (isEffectivelyEmpty(body)) return { verdict: "empty", handledBy: null };
  // `reject(…)` inside a promise executor passes the error on exactly as `throw` does.
  if (/(?<![\w$.])(?:throw(?![\w$])|reject\s*\()/u.test(body)) return { verdict: "handled", handledBy: "throw" };
  if (HANDLER_CALL.test(body)) return { verdict: "handled", handledBy: "handler" };
  if (/(?<![\w$.])return(?![\w$])/u.test(body)) return { verdict: "handled", handledBy: "return" };
  if (binding !== null) {
    const reference = new RegExp(`(?<![\\w$.])${binding.replace(/\$/gu, "\\$")}(?![\\w$])`, "u");
    if (reference.test(withoutDiscards(body, binding)) || reference.test(substitutions(withoutDiscards(bodyWithTemplates, binding)))) return { verdict: "handled", handledBy: "use" };
  }
  return { verdict: "unhandled", handledBy: null };
}

/** Every `try/catch` and inline-block `.catch(...)` handler in the file, classified. */
export function findCatchBlocks(view: SourceView): readonly CatchBlock[] {
  const code = view.code();
  const withTemplates = view.codeWithStringsAndTemplates();
  const blocks: CatchBlock[] = [];
  for (const match of code.matchAll(/(?<![\w$])catch(?![\w$])/gu)) {
    const keyword = match.index;
    const promise = code.slice(0, keyword).trimEnd().endsWith(".");
    let cursor = skipSpace(code, keyword + "catch".length);
    let binding: string | null = null;
    if (promise) {
      if (code[cursor] !== "(") continue;
      cursor = skipSpace(code, cursor + 1);
      if (code.startsWith("async", cursor)) cursor = skipSpace(code, cursor + "async".length);
      if (code.startsWith("function", cursor)) {
        cursor = code.indexOf("(", cursor);
        if (cursor === -1) continue;
      }
      if (code[cursor] === "(") {
        const close = matchingClose(code, cursor, "(", ")");
        if (close === -1) continue;
        binding = /^\s*([A-Za-z_$][\w$]*)/u.exec(code.slice(cursor + 1, close))?.[1] ?? null;
        cursor = skipSpace(code, close + 1);
      } else {
        const name = /^[A-Za-z_$][\w$]*/u.exec(code.slice(cursor))?.[0];
        if (name === undefined) continue;
        binding = name;
        cursor = skipSpace(code, cursor + name.length);
      }
      if (code.startsWith("=>", cursor)) cursor = skipSpace(code, cursor + 2);
    } else if (code[cursor] === "(") {
      const close = matchingClose(code, cursor, "(", ")");
      if (close === -1) continue;
      binding = /^\s*([A-Za-z_$][\w$]*)\s*(?::[^]*)?$/u.exec(code.slice(cursor + 1, close))?.[1] ?? null;
      cursor = skipSpace(code, close + 1);
    }
    if (code[cursor] !== "{") continue;
    const close = matchingClose(code, cursor, "{", "}");
    if (close === -1) continue;
    const body = code.slice(cursor + 1, close);
    const { verdict, handledBy } = classifyCatchBody(body, withTemplates.slice(cursor + 1, close), binding);
    blocks.push({
      line: view.lineAt(keyword),
      form: promise ? "promise" : "try",
      binding,
      verdict,
      handledBy,
      excerpt: body.replace(/\s+/gu, " ").trim().slice(0, 120),
    });
  }
  return blocks;
}
