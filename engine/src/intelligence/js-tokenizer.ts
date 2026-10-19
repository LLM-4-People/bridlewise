/**
 * THE JS/TS TOKENIZER — source text to tokens (identifiers, punctuation,
 * string and template literals, numbers, regex literals) with their line and
 * column, comments dropped. A token stream, not a parse: the symbol extractor
 * reads definitions from it, the data-flow and TypeScript quality-pack
 * analyses read their patterns from it, and the reachability walk
 * (`src/workflow/reachability.ts`) reads import edges from it — a specifier
 * in a comment or inside another string is never an edge.
 *
 * Kept apart from the symbol extractor (which loads the tree-sitter
 * extractor) so a consumer that only needs tokens loads nothing else.
 */
import { deepFreeze } from "../kernel/integrity.ts";

export type Token = Readonly<{
  kind: "identifier" | "punctuation" | "string" | "template" | "number" | "regex";
  value: string;
  line: number;
  column: number;
}>;

/** Keywords after which a `/` opens a regular expression: an operand is expected next. */
const REGEX_AFTER_KEYWORD: ReadonlySet<string> = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
/** Keywords whose parenthesized head a statement follows: `if (x) /re/` opens a regular expression after the `)`. */
const STATEMENT_HEAD: ReadonlySet<string> = new Set(["if", "while", "for", "with"]);

/**
 * Whether a `/` after `tokens` opens a regular expression rather than
 * dividing: after nothing, after a keyword that expects an operand, after an
 * operator or an opening bracket (so after the `>` of `=>` too), and after the
 * `)` of a statement head (`closesHead`); never after an operand (a name, a
 * literal, `]`, `}`, a postfix `++`/`--`).
 */
function opensRegex(tokens: readonly Token[], closesHead: ReadonlySet<number>): boolean {
  const index = tokens.length - 1;
  const prev = tokens[index];
  if (prev === undefined) return true;
  if (prev.kind === "identifier") return REGEX_AFTER_KEYWORD.has(prev.value);
  if (prev.kind !== "punctuation") return false;
  if (prev.value === ")") return closesHead.has(index);
  if (prev.value === "]" || prev.value === "}") return false;
  if ((prev.value === "+" || prev.value === "-") && tokens[index - 1]?.value === prev.value) return false;
  return true;
}

/** The index just past the quoted string opening at `start` (a newline ends an unterminated one). */
function quotedEnd(source: string, start: number): number {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i += 1) {
    const c = source[i];
    if (c === "\\") i += 1;
    else if (c === quote) return i + 1;
    else if (c === "\n") return i;
  }
  return source.length;
}

/** The index just past the template literal opening at `start` (a backtick): each `${…}` is skipped whole, with its own strings, templates and braces. */
function templateEnd(source: string, start: number): number {
  for (let i = start + 1; i < source.length;) {
    const c = source[i];
    if (c === "\\") i += 2;
    else if (c === "`") return i + 1;
    else if (c === "$" && source[i + 1] === "{") i = substitutionEnd(source, i + 2);
    else i += 1;
  }
  return source.length;
}

/** The index just past the `}` that closes a template substitution whose body starts at `start`. */
function substitutionEnd(source: string, start: number): number {
  let depth = 0;
  for (let i = start; i < source.length;) {
    const c = source[i];
    if (c === "`") i = templateEnd(source, i);
    else if (c === '"' || c === "'") i = quotedEnd(source, i);
    else if (c === "}" && depth === 0) return i + 1;
    else {
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      i += 1;
    }
  }
  return source.length;
}

export function tokenizeWithPositions(source: string): readonly Token[] {
  const tokens: Token[] = [];
  /** The token index of each `)` that closes a statement head (`if (…)`), and the opener stack that finds them. */
  const closesHead = new Set<number>();
  const openers: boolean[] = [];
  let line = 1;
  let column = 1;
  for (let i = 0; i < source.length;) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === "\n") {
      line += 1;
      column = 1;
      i += 1;
      continue;
    }
    if (/\s/u.test(ch)) {
      column += 1;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      while (i < source.length) {
        if (source[i] === "*" && source[i + 1] === "/") { i += 2; column += 2; break; }
        if (source[i] === "\n") { line += 1; column = 1; } else { column += 1; }
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next !== undefined && opensRegex(tokens, closesHead)) {
      let inClass = false;
      const startLine = line;
      const startCol = column;
      i += 1;
      while (i < source.length) {
        const c = source[i]!;
        if (c === "\\") { i += 2; column += 2; continue; }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) {
          i += 1;
          column += 1;
          while (i < source.length && /[a-z]/iu.test(source[i]!)) { i += 1; column += 1; }
          break;
        }
        if (c === "\n") { line += 1; column = 1; } else { column += 1; }
        i += 1;
      }
      tokens.push({ kind: "regex", value: "/regex/", line: startLine, column: startCol });
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const startLine = line;
      const startCol = column;
      let value = "";
      i += 1;
      column += 1;
      while (i < source.length) {
        const c = source[i]!;
        if (c === "\\") {
          const esc = source[i + 1];
          if (esc !== undefined) value += esc;
          i += 2;
          column += 2;
        } else if (c === quote) {
          i += 1;
          column += 1;
          break;
        } else {
          if (c === "\n") { line += 1; column = 1; } else { column += 1; }
          value += c;
          i += 1;
        }
      }
      tokens.push({ kind: "string", value, line: startLine, column: startCol });
      continue;
    }
    if (ch === "`") {
      // One token, its raw text: a `${…}` substitution (its own strings and
      // templates included) is skipped whole, so a backtick inside it never
      // ends the template early.
      const end = templateEnd(source, i);
      const raw = source.slice(i, end);
      tokens.push({ kind: "template", value: raw.slice(1, raw.endsWith("`") && raw.length > 1 ? -1 : undefined), line, column });
      const newlines = raw.split("\n").length - 1;
      if (newlines > 0) {
        line += newlines;
        column = raw.length - raw.lastIndexOf("\n");
      } else column += raw.length;
      i = end;
      continue;
    }
    if (/[0-9]/u.test(ch)) {
      const start = i;
      const startLine = line;
      const startCol = column;
      while (i < source.length && /[0-9._xa-fA-F]/u.test(source[i]!)) { i += 1; column += 1; }
      tokens.push({ kind: "number", value: source.slice(start, i), line: startLine, column: startCol });
      continue;
    }
    if (/[A-Za-z_$]/u.test(ch)) {
      const start = i;
      const startLine = line;
      const startCol = column;
      while (i < source.length && /[A-Za-z0-9_$]/u.test(source[i]!)) { i += 1; column += 1; }
      tokens.push({ kind: "identifier", value: source.slice(start, i), line: startLine, column: startCol });
      continue;
    }
    if (ch === "(") {
      const prev = tokens.at(-1);
      openers.push(prev?.kind === "identifier" && STATEMENT_HEAD.has(prev.value));
    } else if (ch === ")" && openers.pop() === true) closesHead.add(tokens.length);
    tokens.push({ kind: "punctuation", value: ch, line, column });
    i += 1;
    column += 1;
  }
  return deepFreeze(tokens);
}
