/**
 * COCKPIT RENDER — syntax highlighting as TOKENS, never as markup.
 *
 * WHY HAND-ROLLED. The repo has no highlighting dependency (package.json:
 * nanostores + zod), no CDN is permitted (§12.4), and every mainstream
 * highlighter (highlight.js, Prism, Shiki) has the same disqualifying
 * output shape: an HTML STRING. Consuming one means `{@html}` on tool output
 * and model output — the exact injection path the renderer guard forbids
 * (tests/cockpit/render-sanitization-owner.test.ts). Shiki additionally
 * ships megabytes of grammars + a WASM oniguruma build, which the flow
 * virtualizer cannot afford to load on a frame budget.
 *
 * So: a small scanner that emits `{ kind, text }` tokens. The Svelte
 * renderer maps each token to `<span class={kind}>{text}</span>` with normal
 * interpolation, so highlighting CANNOT introduce markup no matter how
 * hostile the code is. The colors come from tokens.css (--syn-*).
 *
 * HONESTY. A language we do not have a grammar for is returned as plain
 * tokens and reports `highlighted: false` — the UI says "no grammar for X"
 * rather than mis-coloring the code with a wrong grammar. Highlighting never
 * changes, reorders, or drops a single character: `linesOf` is a pure
 * partition of the input, and the round-trip is property-tested.
 *
 * PERFORMANCE. Single left-to-right pass with sticky regexes, no
 * backtracking across the whole buffer. Past MAX_HIGHLIGHT_CHARS the scanner
 * declines and returns plain lines (reported, not silent) so a 10MB tool
 * output cannot blow the 16ms frame.
 */

import { MAX_HIGHLIGHT_CHARS } from "./render-config.ts";

export type TokenKind =
  | "plain"
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "type"
  | "func"
  | "punct"
  | "meta";

export type Token = Readonly<{ kind: TokenKind; text: string }>;

export type HighlightResult = Readonly<{
  /** One token array per source line. Always `code.split("\n").length` long. */
  lines: readonly (readonly Token[])[];
  /** False when no grammar applied (unknown language, or over the cap). */
  highlighted: boolean;
  /** The resolved grammar id, or null when none applied. */
  grammar: string | null;
  /** Present when highlighting declined: the honest reason. */
  declined?: string;
}>;

// ── Grammars ────────────────────────────────────────────────────────────────

type Rule = Readonly<{ kind: TokenKind | "ident"; re: RegExp }>;

type Grammar = Readonly<{
  rules: readonly Rule[];
  keywords: ReadonlySet<string>;
  types: ReadonlySet<string>;
}>;

const set = (s: string): ReadonlySet<string> => new Set(s.split(/\s+/).filter(Boolean));

/** Shared rule fragments. All sticky (`y`) — they only match at lastIndex. */
const WS: Rule = { kind: "plain", re: /[ \t]+/y };
const IDENT: Rule = { kind: "ident", re: /[A-Za-z_$][\w$]*/y };
const NUMBER: Rule = {
  kind: "number",
  re: /0[xX][0-9a-fA-F_]+n?|0[bB][01_]+n?|0[oO][0-7_]+n?|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?n?|\.\d[\d_]*(?:[eE][+-]?\d+)?/y,
};
const PUNCT: Rule = { kind: "punct", re: /[{}()[\].,;:?!<>=+\-*/%&|^~@#]+/y };

const LINE_COMMENT_SLASH: Rule = { kind: "comment", re: /\/\/[^\n]*/y };
const BLOCK_COMMENT: Rule = { kind: "comment", re: /\/\*[\s\S]*?(?:\*\/|$)/y };
const HASH_COMMENT: Rule = { kind: "comment", re: /#[^\n]*/y };
const DASH_COMMENT: Rule = { kind: "comment", re: /--[^\n]*/y };

/** Quoted strings with backslash escapes; unterminated runs to end-of-line. */
const DQ_STRING: Rule = { kind: "string", re: /"(?:[^"\\\n]|\\[\s\S])*(?:"|$)/y };
const SQ_STRING: Rule = { kind: "string", re: /'(?:[^'\\\n]|\\[\s\S])*(?:'|$)/y };
const BACKTICK_STRING: Rule = { kind: "string", re: /`(?:[^`\\]|\\[\s\S])*(?:`|$)/y };

const TS_KEYWORDS = set(`
  abstract as async await break case catch class const continue debugger declare default delete do
  else enum export extends finally for from function get if implements import in infer instanceof
  interface is keyof let new of package private protected public readonly return satisfies set static
  super switch this throw try type typeof var void while with yield
`);
const TS_TYPES = set(`
  any bigint boolean false never null number object string symbol true undefined unknown
  Array Map Set Promise Record Readonly Partial Object String Number Boolean Error Date RegExp JSON Math
`);

const PY_KEYWORDS = set(`
  and as assert async await break class continue def del elif else except finally for from global if
  import in is lambda nonlocal not or pass raise return try while with yield match case
`);
const PY_TYPES = set(`
  True False None self cls int float str bool list dict set tuple bytes object type Exception
`);

const RUST_KEYWORDS = set(`
  as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod
  move mut pub ref return self Self static struct super trait type unsafe use where while
`);
const RUST_TYPES = set(`
  bool char f32 f64 i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize str String Vec Option Result
  Some None Ok Err Box true false
`);

const GO_KEYWORDS = set(`
  break case chan const continue default defer else fallthrough for func go goto if import interface
  map package range return select struct switch type var
`);
const GO_TYPES = set(`
  bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint
  uint8 uint16 uint32 uint64 uintptr true false nil iota make new len cap append copy delete panic recover
`);

const SH_KEYWORDS = set(`
  if then else elif fi case esac for while until do done in function select time coproc return break
  continue local export readonly declare typeset unset shift eval exec source trap set
`);
const SH_TYPES = set(`
  echo cd ls cat grep sed awk find git npm node curl mkdir rm cp mv chmod chown test printf read exit
  sudo apt docker kubectl make python pip
`);

const SQL_KEYWORDS = set(`
  select from where group by having order limit offset insert into values update set delete create
  table view index drop alter add column primary key foreign references join left right inner outer
  full on as and or not null distinct union all case when then else end with returning
`);

const JAVA_KEYWORDS = set(`
  abstract assert break case catch class const continue default do else enum extends final finally
  for goto if implements import instanceof interface native new package private protected public
  return static strictfp super switch synchronized this throw throws transient try volatile while
  record sealed var yield
`);
const JAVA_TYPES = set(`
  boolean byte char double float int long short void String Object Integer List Map Set true false null
`);

const C_KEYWORDS = set(`
  alignas alignof auto break case catch class const constexpr continue default delete do else enum
  explicit export extern for friend goto if inline namespace new noexcept nullptr operator private
  protected public register return sizeof static struct switch template this throw try typedef
  typename union using virtual volatile while
`);
const C_TYPES = set(`
  bool char double float int long short signed unsigned void size_t uint8_t uint16_t uint32_t
  uint64_t int8_t int16_t int32_t int64_t true false NULL std string vector map
`);

/** C-family scaffolding shared by ts/go/rust/java/c. */
function cFamily(keywords: ReadonlySet<string>, types: ReadonlySet<string>, extra: readonly Rule[] = []): Grammar {
  return {
    rules: [
      WS,
      LINE_COMMENT_SLASH,
      BLOCK_COMMENT,
      ...extra,
      DQ_STRING,
      SQ_STRING,
      BACKTICK_STRING,
      NUMBER,
      IDENT,
      PUNCT,
    ],
    keywords,
    types,
  };
}

const GRAMMARS: Readonly<Record<string, Grammar>> = {
  ts: cFamily(TS_KEYWORDS, TS_TYPES),
  python: {
    rules: [
      WS,
      HASH_COMMENT,
      { kind: "string", re: /(?:[rbfu]{0,2})"""[\s\S]*?(?:"""|$)/y },
      { kind: "string", re: /(?:[rbfu]{0,2})'''[\s\S]*?(?:'''|$)/y },
      { kind: "string", re: /(?:[rbfu]{0,2})"(?:[^"\\\n]|\\[\s\S])*(?:"|$)/y },
      { kind: "string", re: /(?:[rbfu]{0,2})'(?:[^'\\\n]|\\[\s\S])*(?:'|$)/y },
      { kind: "meta", re: /@[\w.]+/y },
      NUMBER,
      IDENT,
      PUNCT,
    ],
    keywords: PY_KEYWORDS,
    types: PY_TYPES,
  },
  rust: cFamily(RUST_KEYWORDS, RUST_TYPES, [
    { kind: "meta", re: /#!?\[[^\]\n]*\]/y },
    { kind: "meta", re: /'[a-z_]\w*(?![\w'])/y },
  ]),
  go: cFamily(GO_KEYWORDS, GO_TYPES),
  java: cFamily(JAVA_KEYWORDS, JAVA_TYPES, [{ kind: "meta", re: /@[\w.]+/y }]),
  c: cFamily(C_KEYWORDS, C_TYPES, [{ kind: "meta", re: /^[ \t]*#[a-z]+/my }]),
  json: {
    rules: [
      WS,
      { kind: "string", re: /"(?:[^"\\\n]|\\[\s\S])*(?:"|$)(?=\s*:)/y }, // key
      DQ_STRING,
      NUMBER,
      { kind: "keyword", re: /\b(?:true|false|null)\b/y },
      PUNCT,
    ],
    keywords: new Set(),
    types: new Set(),
  },
  sh: {
    rules: [
      WS,
      HASH_COMMENT,
      { kind: "meta", re: /\$\{[^}\n]*\}|\$[A-Za-z_]\w*|\$[0-9@*#?$!-]/y },
      DQ_STRING,
      SQ_STRING,
      { kind: "meta", re: /^[ \t]*[$#>](?=[ \t])/my }, // prompt marker
      { kind: "punct", re: /--?[A-Za-z][\w-]*/y }, // flags read as punctuation weight
      NUMBER,
      IDENT,
      PUNCT,
    ],
    keywords: SH_KEYWORDS,
    types: SH_TYPES,
  },
  css: {
    rules: [
      WS,
      BLOCK_COMMENT,
      { kind: "meta", re: /@[\w-]+/y },
      { kind: "keyword", re: /--[\w-]+/y },
      DQ_STRING,
      SQ_STRING,
      { kind: "number", re: /-?\d[\d.]*(?:px|rem|em|%|vh|vw|s|ms|deg|fr|ch|ex|pt)?/y },
      { kind: "type", re: /#[0-9a-fA-F]{3,8}\b/y },
      { kind: "func", re: /[\w-]+(?=\s*\()/y },
      { kind: "ident", re: /[A-Za-z_-][\w-]*/y },
      PUNCT,
    ],
    keywords: new Set(),
    types: new Set(),
  },
  html: {
    rules: [
      WS,
      { kind: "comment", re: /<!--[\s\S]*?(?:-->|$)/y },
      { kind: "keyword", re: /<\/?[A-Za-z][\w:-]*/y },
      { kind: "punct", re: /\/?>/y },
      DQ_STRING,
      SQ_STRING,
      { kind: "type", re: /[A-Za-z_:@#][\w:.-]*(?==)/y },
      { kind: "ident", re: /[A-Za-z_][\w-]*/y },
      PUNCT,
    ],
    keywords: new Set(),
    types: new Set(),
  },
  sql: {
    rules: [WS, DASH_COMMENT, BLOCK_COMMENT, SQ_STRING, DQ_STRING, NUMBER, IDENT, PUNCT],
    keywords: SQL_KEYWORDS,
    types: new Set(),
  },
  yaml: {
    rules: [
      WS,
      HASH_COMMENT,
      { kind: "type", re: /^[ \t]*-?[ \t]*[\w.$-]+(?=[ \t]*:)/my }, // key
      { kind: "meta", re: /^[ \t]*-(?=[ \t])/my },
      DQ_STRING,
      SQ_STRING,
      { kind: "keyword", re: /\b(?:true|false|null|yes|no|on|off)\b/y },
      NUMBER,
      { kind: "ident", re: /[^\s:#]+/y },
      PUNCT,
    ],
    keywords: new Set(),
    types: new Set(),
  },
  toml: {
    rules: [
      WS,
      HASH_COMMENT,
      { kind: "meta", re: /^[ \t]*\[[^\]\n]*\]/my },
      { kind: "type", re: /^[ \t]*[\w.$-]+(?=[ \t]*=)/my },
      DQ_STRING,
      SQ_STRING,
      { kind: "keyword", re: /\b(?:true|false)\b/y },
      NUMBER,
      { kind: "ident", re: /[^\s=#]+/y },
      PUNCT,
    ],
    keywords: new Set(),
    types: new Set(),
  },
};

/** Language alias → grammar id. Anything absent gets plain text, honestly. */
const ALIASES: Readonly<Record<string, string>> = {
  ts: "ts", tsx: "ts", typescript: "ts", js: "ts", jsx: "ts", mjs: "ts", cjs: "ts",
  javascript: "ts", node: "ts", svelte: "html", vue: "html",
  py: "python", python: "python", python3: "python",
  rs: "rust", rust: "rust",
  go: "go", golang: "go",
  java: "java", kt: "java", kotlin: "java", cs: "java", csharp: "java",
  c: "c", h: "c", cpp: "c", "c++": "c", cc: "c", hpp: "c", objc: "c",
  json: "json", json5: "json", jsonc: "json",
  sh: "sh", bash: "sh", shell: "sh", zsh: "sh", console: "sh", terminal: "sh", fish: "sh",
  css: "css", scss: "css", less: "css", sass: "css",
  html: "html", xml: "html", svg: "html",
  sql: "sql", psql: "sql", mysql: "sql",
  yaml: "yaml", yml: "yaml",
  toml: "toml", ini: "toml", cfg: "toml",
};

/** Resolve a fence's language word to a grammar id, or null when unknown. */
export function resolveGrammar(lang: string): string | null {
  const key = lang.trim().toLowerCase().split(/[\s,:]/)[0] ?? "";
  if (key === "") return null;
  return ALIASES[key] ?? null;
}

/** Guess a grammar from a file path's extension (for file-content output). */
export function grammarForPath(path: string): string | null {
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  return resolveGrammar(base.slice(dot + 1));
}

// ── Scanner ─────────────────────────────────────────────────────────────────

/** Split a token stream into per-line token arrays (a pure partition). */
function linesOf(tokens: readonly Token[], lineCount: number): Token[][] {
  const lines: Token[][] = [];
  for (let i = 0; i < lineCount; i += 1) lines.push([]);
  let line = 0;
  for (const tok of tokens) {
    if (!tok.text.includes("\n")) {
      if (tok.text.length > 0) lines[line]!.push(tok);
      continue;
    }
    const parts = tok.text.split("\n");
    for (let p = 0; p < parts.length; p += 1) {
      if (p > 0) line += 1;
      const text = parts[p]!;
      if (text.length > 0 && line < lines.length) lines[line]!.push({ kind: tok.kind, text });
    }
  }
  return lines;
}

/** Coalesce adjacent same-kind tokens so the DOM gets fewer spans. */
function coalesce(tokens: readonly Token[]): Token[] {
  const out: Token[] = [];
  for (const tok of tokens) {
    const last = out[out.length - 1];
    if (last !== undefined && last.kind === tok.kind) {
      out[out.length - 1] = { kind: last.kind, text: last.text + tok.text };
      continue;
    }
    out.push(tok);
  }
  return out;
}

function scan(code: string, grammar: Grammar): Token[] {
  const out: Token[] = [];
  const n = code.length;
  let pos = 0;
  let plainStart = -1;

  const flushPlain = (upto: number): void => {
    if (plainStart !== -1) {
      out.push({ kind: "plain", text: code.slice(plainStart, upto) });
      plainStart = -1;
    }
  };

  while (pos < n) {
    let matched = false;
    for (const rule of grammar.rules) {
      rule.re.lastIndex = pos;
      const m = rule.re.exec(code);
      if (m === null || m[0].length === 0) continue;
      const text = m[0];
      let kind: TokenKind;
      if (rule.kind === "ident") {
        if (grammar.keywords.has(text)) kind = "keyword";
        else if (grammar.types.has(text)) kind = "type";
        else if (code[pos + text.length] === "(") kind = "func";
        else kind = "plain";
      } else {
        kind = rule.kind;
      }
      // A plain-kind match still merges into the running plain run.
      if (kind === "plain") {
        if (plainStart === -1) plainStart = pos;
      } else {
        flushPlain(pos);
        out.push({ kind, text });
      }
      pos += text.length;
      matched = true;
      break;
    }
    if (!matched) {
      if (plainStart === -1) plainStart = pos;
      pos += 1;
    }
  }
  flushPlain(n);
  return coalesce(out);
}

/**
 * Highlight `code` as `lang`. Always returns one entry per source line, in
 * source order, containing exactly the source characters.
 */
export function highlight(code: string, lang: string): HighlightResult {
  const lineCount = code.split("\n").length;
  const plain = (declined?: string, grammar: string | null = null): HighlightResult => ({
    lines: linesOf([{ kind: "plain", text: code }], lineCount),
    highlighted: false,
    grammar,
    ...(declined === undefined ? {} : { declined }),
  });

  if (code.length > MAX_HIGHLIGHT_CHARS) {
    return plain(
      `${code.length.toLocaleString("en-US")} characters is past the ${MAX_HIGHLIGHT_CHARS.toLocaleString("en-US")}-character highlight budget`,
    );
  }
  const id = resolveGrammar(lang);
  if (id === null) {
    return plain(lang.trim() === "" ? "no language on the fence" : `no grammar for "${lang.trim()}"`);
  }
  const grammar = GRAMMARS[id];
  if (grammar === undefined) return plain(`no grammar for "${lang.trim()}"`);

  return { lines: linesOf(scan(code, grammar), lineCount), highlighted: true, grammar: id };
}

/** The grammar ids that actually exist — used by the guard test. */
export const GRAMMAR_IDS: readonly string[] = Object.keys(GRAMMARS);
