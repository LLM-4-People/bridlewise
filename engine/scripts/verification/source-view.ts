/**
 * ONE OWNER DECIDES WHAT A STRING IS, AND A SCANNER CANNOT REACH PAST IT.
 *
 * ── THE CLASS THIS EXISTS FOR ─────────────────────────────────────────────
 *
 * A source scanner asks a question of TEXT, and the answer depends entirely
 * on which text it asked. Three ways to get it wrong, all of them measured on
 * this tree:
 *
 *   * NO VIEW AT ALL. A guard matching raw bytes counts a declaration written
 *     inside a doc comment, and a fixture spelling out a declaration inside a
 *     template literal. Driven: a `MIGRATION_NOTE = \`export const
 *     MEMORY_TIERS = [...three tiers...]\`` planted above a REAL two-tier
 *     declaration left the tier-parity guard at exit 0, 40 passed, agreeing
 *     about the template while the declaration it protects had drifted.
 *   * THE WRONG VIEW. A module specifier IS a string literal, so a scan for
 *     `from "@harness/…"` over a string-blanked view can never match — five
 *     tests did exactly that and passed unconditionally.
 *   * A VIEW THAT MOVES THE LINES. Every stripper that DELETES its spans
 *     changes every line number after the first comment, so a guard reporting
 *     `file:line` from a stripped view points at a line the reader does not
 *     have. Measured while building this module: line numbers taken from a
 *     comment-deleting view were wrong by 19 lines on the first file checked.
 *
 * ── WHAT THIS OWNER GIVES INSTEAD ─────────────────────────────────────────
 *
 * `readSourceView(path)` is the sanctioned reader. It returns a `SourceView`,
 * which is BRANDED and is NOT a string: `view.matchAll(…)`, `re.test(view)`
 * and `view.includes(…)` do not typecheck, so a caller cannot accidentally
 * match against bytes it never chose. There is deliberately no `.raw()`.
 * To match anything you must name a view:
 *
 *   `code()`             comments, quoted-string interiors and template
 *                        interiors all blanked — the view for "is this token
 *                        real code".
 *   `codeWithStrings()`  comments and TEMPLATE interiors blanked, QUOTED
 *                        string interiors intact — the view for a question
 *                        whose subject lives inside a quoted string: a module
 *                        specifier, a status code, a vocabulary's members.
 *   `prose()`            the comments alone, WITH LINE NUMBERS, as data.
 *
 * `prose()` is not decoration. "Was this only in a comment?" is a real
 * question two scanners here have to answer, and a reader that merely strips
 * destroys the information — the guard can then refuse but cannot explain
 * itself, which is how a guard gets overridden.
 *
 * ── EVERY VIEW PRESERVES OFFSETS ──────────────────────────────────────────
 *
 * Blanked, never deleted: each removed character becomes a space and every
 * newline survives. So an index into any view is an index into the file, and
 * `lineAt(index)` is the line the reader will open. That is the property the
 * deleting strippers do not have, and it is why a scanner that reports a
 * location must come through here.
 *
 * ── STATED LIMITS, KEPT IN SOURCE ─────────────────────────────────────────
 *
 * This door has a corridor around it and pretending otherwise is worse than
 * the corridor:
 *
 *   * `readFileSync(p).toString()` still yields bytes, and so does reading
 *     through a `Buffer`. Nothing in the type system stops that.
 *   * A scanner that shells out to `grep`/`rg` never enters this module at
 *     all — and `grep` treats a file holding a NUL byte as binary, printing
 *     nothing and exiting cleanly.
 *
 * A type closes the door a caller would otherwise walk through by habit; only
 * a guard-of-guards over the byte-reading callers can refuse the ones that
 * walk around it. Either half alone is a door with a corridor beside it, and
 * this file is the first half.
 *
 * Shared by both repositories. Scanner grammar is local; finite retention
 * ceilings come from the canonical safety policy and never read live config.
 */
import { readFileSync } from "node:fs";
import { LEXICAL_REUSE_LIMITS } from "../../src/kernel/lexical-policy.ts";

/** What a lexed span is; everything outside a span is code. */
//
// `template` is separated from `string` because ONE question needs them apart:
// a test tree holds source-as-DATA, and it holds it in template literals. A
// vocabulary extractor must keep quoted-string interiors (the members ARE
// string literals) while refusing template interiors (a fixture quoting a
// declaration is not that declaration).
export type SpanKind =
  | "line-comment"
  | "block-comment"
  | "html-comment"
  | "string"
  | "template"
  | "regex";

export interface LexSpan {
  readonly kind: SpanKind;
  /** Index of the first character of the span. */
  readonly start: number;
  /** Index one past the last character of the span, clamped to the length. */
  readonly end: number;
}

/** Words after which a `/` begins a regex literal rather than a division. */
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "case", "do", "else", "yield", "await", "throw",
]);

/**
 * Single-character operators after which a `/` begins a regex literal.
 * Deliberately excludes `<` and `>`: `</div>` and `<span>a/b</span>` are
 * ordinary Svelte template text. The one form that genuinely needs `>` is the
 * arrow, so `=>` is matched as a PAIR instead.
 */
const REGEX_PRECEDING_OPERATORS = "(,=:[!&|?{};+-*%^~";

/**
 * Does a `/` at this point begin a regex literal rather than a division?
 *
 * ONE OWNER FOR THIS DECISION. It used to live only inside `lexSpans`, which
 * meant `interpolationEnd` — walking `${…}` as an expression — had NO regex
 * rule at all, and an expression is exactly where a regex lives.
 */
function mayStartRegex(prev: string, prevPrev: string, prevWord: string): boolean {
  if (prev === "") return true;
  if (REGEX_PRECEDING_KEYWORDS.has(prevWord)) return true;
  if (/[A-Za-z0-9_$)\]"'`]/.test(prev)) return false;
  if (prev === ">") return prevPrev === "=";
  if (prev === "<") return false;
  return REGEX_PRECEDING_OPERATORS.includes(prev);
}

/**
 * The last two significant code characters and the identifier ending at the
 * last one — the state `mayStartRegex` needs. Comments are transparent to all
 * three: `x = /* c *​/ /re/` must still see `=`.
 */
interface CodeContext {
  prev: string;
  prevPrev: string;
  prevWord: string;
}

function noteCodeChar(src: string, context: CodeContext, ch: string, wordEnd: number): void {
  context.prevPrev = context.prev;
  context.prev = ch;
  context.prevWord = "";
  // Only a completed word can precede the next slash. Reconstruct it once
  // at its end, rather than scanning every growing prefix of an identifier.
  if (/[A-Za-z0-9_$]/.test(ch) && !/[A-Za-z0-9_$]/.test(src[wordEnd + 1] ?? "")) {
    let w = wordEnd;
    while (w > 0 && /[A-Za-z0-9_$]/.test(src[w - 1]!)) w -= 1;
    context.prevWord = src.slice(w, wordEnd + 1);
  }
}

/**
 * The end index of the regex literal starting at `start`, or `null` when the
 * `/` is not one.
 *
 * A regex literal CANNOT CONTAIN A RAW NEWLINE — that is the language, not a
 * heuristic. So a candidate that reaches end-of-line without closing was never
 * a regex, the `/` is put back as ordinary code, and the damage from a wrong
 * guess is capped at one line.
 */
function regexLiteralEnd(src: string, start: number): number | null {
  let i = start + 1;
  let inClass = false;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "\n") return null;
    if (ch === "\\") { i += 2; continue; }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) {
      i += 1;
      while (i < src.length && /[dgimsuvy]/.test(src[i]!)) i += 1;
      return i;
    }
    i += 1;
  }
  return null;
}

/**
 * The end of the quoted string starting at `start`, one past its closing quote.
 */
function quotedEnd(src: string, start: number): number {
  const quote = src[start]!;
  let i = start + 1;
  while (i < src.length && src[i] !== quote) {
    if (src[i] === "\\") i += 2;
    else i += 1;
  }
  return Math.min(src.length, i + 1);
}

/**
 * The end of the template literal starting at `start`, one past its backtick.
 *
 * ── WHY THIS IS NOT "THE NEXT BACKTICK" ───────────────────────────────────
 *
 * It was, and the consequence was the exact silent pass this module's header
 * describes, one level down. A template's `${…}` may contain another template,
 * and "scan to the next backtick" then ends the OUTER span at the INNER
 * literal's OPENING backtick — so the fixture's body lands in the CODE half,
 * at a line start, ahead of the real declaration. Driven, planted in
 * `contracts/wire-types.ts`:
 *
 *     export const MIGRATION_NOTE = `${`
 *     export const MEMORY_TIERS = ["present", "short-term", "long-term"];
 *     `}`;
 *     export const MEMORY_TIERS = ["present", "short-term"];
 *
 * — the vocabulary extractor read the FIXTURE and agreed with the owner while
 * the declaration it protects held two of three. Exit 0, 40 passed.
 *
 * So an interpolation is skipped as an EXPRESSION, with brace depth, and
 * everything the expression may itself contain — nested templates, quoted
 * strings, comments — is skipped by the same rules. The recursion terminates
 * because every branch advances `i`.
 *
 * A REGEX INSIDE THE INTERPOLATION IS LEXED. It did not used to be, and the
 * limit written here claimed the damage was "bounded to that literal because
 * the outer walk resumes at the next `}` it does find". That was false for
 * three of the four spellings — `/[{]/`, `` /`/ `` and `/'/` each swallowed
 * everything to end-of-file — and both live instances in this tree were the
 * third. See `interpolationEnd` for the measurements.
 *
 * STATED LIMIT, NARROWER AND TRUE: the regex/division decision inside an
 * interpolation is the same heuristic `lexSpans` uses, so it inherits the same
 * ambiguity — a `/` after an identifier is read as division, which is right
 * for `${a / b}` and wrong for the (invalid) `${a /re/}`. A candidate regex
 * reaching end-of-line is put back as code, so a wrong guess costs one line
 * rather than the rest of the file.
 */
function templateEnd(src: string, start: number): number {
  const n = src.length;
  let i = start + 1;
  while (i < n) {
    const ch = src[i]!;
    if (ch === "\\") { i += 2; continue; }
    if (ch === "`") return i + 1;
    if (ch === "$" && src[i + 1] === "{") { i = interpolationEnd(src, i + 2); continue; }
    i += 1;
  }
  return n;
}

/**
 * One past the `}` closing the interpolation whose body starts at `start`.
 *
 * ── IT HAD NO REGEX RULE, AND THE STATED BOUND WAS FALSE ─────────────────
 *
 * An interpolation body is an EXPRESSION, and an expression is precisely where
 * a regex literal lives. Without a rule for one, every character inside a
 * regex was read as ordinary code, so the literal's own contents steered the
 * walk. The comment above `templateEnd` used to say the damage from an
 * unbalanced brace "is bounded to that literal because the outer walk resumes
 * at the next `}` it does find". DRIVEN, that was true for exactly ONE of the
 * four spellings — the one the sentence names:
 *
 *     const a = `${x.replace(/[}]/, "y")}`;   → benign  (the `}` closed early
 *                                                and the next `}` re-synced)
 *     const a = `${x.replace(/[{]/, "y")}`;   → SWALLOWED TO EOF (depth += 1)
 *     const a = `${x.replace(/`/,   "y")}`;   → SWALLOWED TO EOF (opened a
 *                                                template)
 *     const a = `${x.replace(/'/,   "y")}`;   → SWALLOWED TO EOF (opened a
 *                                                quoted string)
 *
 * Live in this tree twice, both the identical shell-quoting construct
 * `` return `'${s.replace(/'/g, "'\\''")}'`; `` — `src/shared/git-churn.ts`
 * inside the scanned population (3 characters lost, because it sits two lines
 * from EOF) and an archived experiment where ONE span swallowed 76 lines of
 * real code. Driven consequence: put that construct above a vocabulary
 * declaration and `findDeclaredUniverses` returns `[]` where the control
 * returns the vocabulary — a silently smaller universe INSIDE the instrument
 * built to refuse silently smaller universes.
 *
 * A stated bound that is false for three of four spellings is worse than no
 * bound, because a reader stops checking. The rule is here now, and what
 * remains is stated in `templateEnd`'s note.
 *
 * ── TWO CALLERS, TWO ANSWERS TO "WHAT HAPPENS INSIDE" ─────────────────────
 *
 * The same walk answers two questions, and the difference is `out`:
 *
 *   * from inside a template literal (`templateEnd`): the WHOLE template is
 *     one span already, so the interpolation interior must not emit — `out`
 *     is null and the walk only finds the closing `}`;
 *   * from template markup (`lexSpans` with `html` set): the `{` and `}` are
 *     code and everything the expression contains is classified into `out`,
 *     because an expression is a mode of its own — the JavaScript string,
 *     comment, template and regex rules apply inside `{…}` and NOWHERE else
 *     in the file.
 */
function interpolationEnd(src: string, start: number, out: LexSpan[] | null = null): number {
  const n = src.length;
  let i = start;
  let depth = 1;
  // At the head of an interpolation `prev` is empty, so a regex may open the
  // expression — `${/re/.test(x)}` and `{#if /re/.test(x)}` are ordinary.
  const context: CodeContext = { prev: "", prevPrev: "", prevWord: "" };
  while (i < n) {
    const ch = src[i]!;
    const next = src[i + 1] ?? "";
    if (ch === "\\") { i += 2; continue; }
    if (ch === "`") {
      const end = templateEnd(src, i);
      if (out !== null) out.push({ kind: "template", start: i, end });
      i = end;
      noteCodeChar(src, context, "`", i - 1);
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = quotedEnd(src, i);
      if (out !== null) out.push({ kind: "string", start: i, end });
      i = end;
      noteCodeChar(src, context, ch, i - 1);
      continue;
    }
    if (ch === "/" && next === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") j += 1;
      if (out !== null) out.push({ kind: "line-comment", start: i, end: j });
      i = j;
      continue;
    }
    if (ch === "/" && next === "*") {
      const close = src.indexOf("*/", i + 2);
      const end = close === -1 ? n : close + 2;
      if (out !== null) out.push({ kind: "block-comment", start: i, end });
      i = end;
      continue;
    }
    if (ch === "/" && mayStartRegex(context.prev, context.prevPrev, context.prevWord)) {
      const end = regexLiteralEnd(src, i);
      if (end !== null) {
        if (out !== null) out.push({ kind: "regex", start: i, end });
        i = end;
        noteCodeChar(src, context, "/", i - 1);
        continue;
      }
    }
    if (ch === "{") { depth += 1; noteCodeChar(src, context, ch, i); i += 1; continue; }
    if (ch === "}") {
      depth -= 1;
      i += 1;
      if (depth === 0) return i;
      noteCodeChar(src, context, "}", i - 1);
      continue;
    }
    if (!/\s/.test(ch)) noteCodeChar(src, context, ch, i);
    i += 1;
  }
  return n;
}

/**
 * Every comment, string, template and regex span in `src`, in order and
 * non-overlapping.
 *
 * ── WHY THERE IS EXACTLY ONE OF THESE ─────────────────────────────────────
 *
 * Five near-identical state machines used to answer "is this a comment, is
 * this a string", and none of them knew about REGEX LITERALS — and a regex
 * literal is allowed to contain a quote:
 *
 *     const re = /^\s*(?:dofile)\s*\(\s*["'](\.[^"']+)["']\s*\)/mg;
 *
 * The first `"` inside that literal opened a string the scanner then carried
 * forward until it happened to find another quote. Everything between was
 * misclassified, in BOTH directions and silently: real code hidden as string
 * interior, and comment text surviving into the "code" view.
 *
 * ── TWO FILE MODES, BECAUSE A QUOTE MEANS DIFFERENT THINGS IN EACH ───────
 *
 * Without `html` the file is ONE mode — JavaScript or TypeScript — and the
 * flat walk below is the language: a quote in code position IS a delimiter,
 * and prose apostrophes can only exist inside strings and comments, which the
 * walk classifies before it ever reaches them. That is the `.ts`/`.mjs` path
 * and it is unchanged.
 *
 * With `html` the file is a Svelte template, and Svelte's own parser is a
 * MODE-AWARE STATE MACHINE: plain markup text is read until `<` or `{` and
 * treats apostrophes and quotes as LITERAL characters; only inside `{…}`
 * expressions (JavaScript rules), inside quoted attribute values, and inside
 * `<script>`/`<style>` content do delimiters exist (sveltejs/svelte
 * `phases/1-parse/state/text.js`, `state/element.js`, `read/expression.js`).
 * A flat walk over such a file makes the guards' green PARITY-DEPENDENT: one
 * prose apostrophe pairs with the next quote anywhere in the file, and the
 * phantom "string" between them swallowed real code (blanked out of `code()`
 * — a hidden offender) and misclassified swallowed text (a false one). Both
 * directions were driven on this tree before this machine existed. So the
 * `html` path is the smallest machine that answers what the consumers ask:
 *
 *   MARKUP   default: `<!--` opens a markup comment; `<` followed by a tag
 *            shape opens TAG; `{` opens EXPRESSION — except a block CLOSE
 *            tag (`{`, optional whitespace, a `/` that opens no comment:
 *            `{/if}`), which is a keyword run to its `}`, as Svelte's own
 *            tag reader decides; every other character — quotes and
 *            apostrophes included — is literal prose.
 *   TAG      inside `<name … >`: quoted attribute values are STRING spans
 *            (the material a value-scan matches, kept from the flat era);
 *            `{…}` is an expression (spread + shorthand attributes);
 *            `//` and `/* *\/` are comments (Svelte reads JS comments in
 *            tags); `>` closes the tag.
 *   EXPRESSION `{…}`: the full JavaScript walk — strings, templates with
 *            nested `${…}`, JS comments, regex literals, brace depth — the
 *            same rules `interpolationEnd` already owned, now emitting.
 *   SCRIPT   after `<script…>`: flat JavaScript to the literal `</script`,
 *            where `<` is an operator, not a mode switch.
 *   STYLE    after `<style…>`: the same walk to `</style` — CSS strings and
 *            `/* *\/` comments, the flat-era treatment, kept.
 *
 * Stated limits, kept in source: unquoted attribute values stay code (they
 * were code in the flat era and no consumer matches inside one); tag names
 * are a run of non-special characters (no grammar); `{` opens an expression
 * in every `html` file — this tree's scanned populations hold no `.html`
 * (the walk helpers select `.ts/.svelte/.mjs/.cjs/.js/.css`), so raw-HTML
 * prose containing `{` is outside every population, and the moment one joins
 * it this sentence is where a reader looks.
 */
/** Finite per-module reuse budgets; callers' own SourceViews retain their own inputs. */
export { LEXICAL_REUSE_LIMITS };

type LexicalInput = Readonly<{ source: string; html: boolean; spans: readonly LexSpan[] }>;
const lexicalInputs = [new Map<string, LexicalInput>(), new Map<string, LexicalInput>()] as const;
const lexicalRecency = new Set<LexicalInput>();
let lexicalCharacters = 0;
let lexicalSpanCount = 0;

/** Private readers share facts; only the public mutable-span door copies them. */
function readLexicalSpans(src: string, html: boolean): readonly LexSpan[] {
  // Nonprimitive inputs may have live coercions/getters and are never retained.
  if (typeof src !== "string" || typeof html !== "boolean") return scanSpans(src, html);
  const inputs = lexicalInputs[html ? 1 : 0];
  const previous = inputs.get(src);
  if (previous !== undefined) {
    lexicalRecency.delete(previous);
    lexicalRecency.add(previous);
    return previous.spans;
  }
  const spans = scanSpans(src, html);
  if (src.length > LEXICAL_REUSE_LIMITS.maximumSourceCharacters || spans.length > LEXICAL_REUSE_LIMITS.maximumSpans) return spans;
  while (lexicalRecency.size >= LEXICAL_REUSE_LIMITS.maximumInputs
    || lexicalCharacters + src.length > LEXICAL_REUSE_LIMITS.maximumSourceCharacters
    || lexicalSpanCount + spans.length > LEXICAL_REUSE_LIMITS.maximumSpans) {
    const oldest = lexicalRecency.values().next().value!;
    lexicalRecency.delete(oldest);
    lexicalInputs[oldest.html ? 1 : 0].delete(oldest.source);
    lexicalCharacters -= oldest.source.length;
    lexicalSpanCount -= oldest.spans.length;
  }
  const input = { source: src, html, spans };
  inputs.set(src, input);
  lexicalRecency.add(input);
  lexicalCharacters += src.length;
  lexicalSpanCount += spans.length;
  return spans;
}

export function lexSpans(src: string, html: boolean): LexSpan[] {
  // An uncached scan already owns fresh mutable output; copying it adds work
  // without protecting retained state.
  if (typeof src !== "string" || typeof html !== "boolean") return scanSpans(src, html);
  const spans = readLexicalSpans(src, html);
  if (src.length > LEXICAL_REUSE_LIMITS.maximumSourceCharacters || spans.length > LEXICAL_REUSE_LIMITS.maximumSpans) return spans as LexSpan[];
  return spans.map(span => ({ ...span }));
}

function scanSpans(src: string, html: boolean): LexSpan[] {
  const spans: LexSpan[] = [];
  const n = src.length;
  if (!html) {
    lexCodeInto(src, 0, n, spans);
    return spans;
  }
  let i = 0;
  while (i < n) {
    const c = src[i]!;
    if (c === "<") {
      if (src.startsWith("<!--", i)) {
        let j = i + 4;
        while (j < n && !src.startsWith("-->", j)) j += 1;
        const end = Math.min(n, j + 3);
        spans.push({ kind: "html-comment", start: i, end });
        i = end;
        continue;
      }
      const after = src[i + 1] ?? "";
      const opensTag =
        /[A-Za-z]/.test(after) ||
        (after === "/" && /[A-Za-z]/.test(src[i + 2] ?? ""));
      if (opensTag) {
        const tag = lexTagInto(src, i, spans);
        i = tag.end;
        if (!tag.closing && !tag.selfClosed && (tag.name === "script" || tag.name === "style")) {
          const close = src.indexOf(`</${tag.name}`, i);
          const contentEnd = close === -1 ? n : close;
          lexCodeInto(src, i, contentEnd, spans);
          i = contentEnd;
        }
        continue;
      }
      // `a < b` in prose: Svelte's text state stops at every `<`, but only a
      // tag shape starts one — anything else is literal text.
      i += 1;
      continue;
    }
    if (c === "{") {
      // A BLOCK CLOSE TAG (`{/if}`, `{/each}`, `{ /await }`) is a keyword,
      // never JavaScript, and it ends at its `}`. Decided exactly as Svelte's
      // own tag reader decides (svelte/src/compiler/phases/1-parse/state/
      // tag.js): `{`, optional whitespace, then a `/` that does not open a
      // comment. Handed to the expression walk instead, the `/` sat where a
      // regex may start, so `{/if}</p>` lexed `/if}</` as a regex literal and
      // the walk swallowed the markup after it — every later markup comment
      // stopped being one.
      let j = i + 1;
      while (j < n && /\s/u.test(src[j]!)) j += 1;
      if (src[j] === "/" && src[j + 1] !== "*" && src[j + 1] !== "/") {
        const close = src.indexOf("}", j);
        i = close === -1 ? n : close + 1;
        continue;
      }
      i = interpolationEnd(src, i + 1, spans);
      continue;
    }
    // Markup prose: quotes and apostrophes are LITERAL here. That sentence is
    // this machine's whole reason to exist.
    i += 1;
  }
  return spans;
}

/** A tag walked to its closing `>`, with the content modes decided by name. */
interface TagWalk {
  /** The tag's own name as written (empty for a closing tag). */
  readonly name: string;
  readonly closing: boolean;
  readonly selfClosed: boolean;
  /** Index one past the tag's closing `>`. */
  readonly end: number;
}

/**
 * TAG mode: walk one tag from its `<`, classifying what Svelte classifies —
 * quoted attribute values, embedded `{expressions}`, and the JS comments
 * Svelte's own attribute reader accepts inside tags — until the `>` that
 * closes it. Emits into `out`; returns where the markup walk resumes.
 *
 * No regex rule here on purpose: a regex literal is not legal tag syntax in
 * Svelte (the walker inside `{…}` owns them where they do live), and carrying
 * the flat heuristic in here would reintroduce exactly the context-blindness
 * this machine exists to end.
 */
function lexTagInto(src: string, start: number, out: LexSpan[]): TagWalk {
  const n = src.length;
  let i = start + 1;
  const closing = src[i] === "/";
  if (closing) i += 1;
  const nameStart = i;
  while (i < n && !/[\s/>]/.test(src[i]!)) i += 1;
  const name = src.slice(nameStart, i);
  let selfClosed = false;
  while (i < n) {
    const c = src[i]!;
    const c2 = src[i + 1] ?? "";
    if (c === "/" && c2 === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") j += 1;
      out.push({ kind: "line-comment", start: i, end: j });
      i = j;
      continue;
    }
    if (c === "/" && c2 === "*") {
      const close = src.indexOf("*/", i + 2);
      const end = close === -1 ? n : close + 2;
      out.push({ kind: "block-comment", start: i, end });
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      // A quoted attribute value: string material, with `{expressions}`
      // embedded in it (Svelte parses both). HTML attribute values carry no
      // backslash escapes — the matching quote closes, wherever it is.
      const quote = c;
      let chunkStart = i;
      i += 1;
      while (i < n && src[i] !== quote) {
        if (src[i] === "{") {
          if (i > chunkStart) out.push({ kind: "string", start: chunkStart, end: i });
          i = interpolationEnd(src, i + 1, out);
          chunkStart = i;
          continue;
        }
        i += 1;
      }
      const end = Math.min(n, i + 1);
      if (end > chunkStart) out.push({ kind: "string", start: chunkStart, end });
      i = end;
      continue;
    }
    if (c === "{") {
      i = interpolationEnd(src, i + 1, out);
      continue;
    }
    if (c === "/" && c2 === ">") { selfClosed = true; i += 2; break; }
    if (c === ">") { i += 1; break; }
    i += 1;
  }
  return { name: closing ? "" : name, closing, selfClosed, end: i };
}

/**
 * The flat JavaScript walk over `[from, to)`, emitting spans: line and block
 * comments, quoted strings, templates (with their `${…}` interiors skipped by
 * the same rules), and regex literals.
 *
 * This is the whole file when `html` is off, and the `<script>`/`<style>`
 * content regions when it is on — one owner of "what is a string in
 * JavaScript", used at every mode boundary where JavaScript rules apply.
 * The last-two-code-characters state for the regex/division decision is local
 * to a walk and resets at its start, which is correct for every region this
 * is called over: a region boundary is a template boundary, and no regex
 * literal spans one.
 */
function lexCodeInto(src: string, from: number, to: number, out: LexSpan[]): number {
  const n = to;
  let i = from;
  const context: CodeContext = { prev: "", prevPrev: "", prevWord: "" };
  while (i < n) {
    const c = src[i]!;
    const c2 = src[i + 1] ?? "";
    if (c === "/" && c2 === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") j += 1;
      out.push({ kind: "line-comment", start: i, end: j });
      i = j;
      continue;
    }
    if (c === "/" && c2 === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j += 1;
      const end = Math.min(n, j + 2);
      out.push({ kind: "block-comment", start: i, end });
      i = end;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      // A TEMPLATE ENDS AT ITS OWN BACKTICK, NOT AT THE NEXT ONE. See
      // `templateEnd`: `${…}` may hold another template, and stopping at the
      // next backtick ends the outer span inside the inner literal, spilling a
      // fixture's body into the code half at a line start.
      //
      // CLAMPED TO THE REGION: the literal scanners search to end-of-file,
      // but a script or style region ends at its closing tag wherever that
      // is — an unterminated literal inside the region would otherwise run
      // past the boundary, and the markup walk would resume INSIDE the
      // emitted span. Overlapping spans break renderSpans' arithmetic (and
      // every view built on it), so a literal that outruns its region is
      // cut at the region's edge: same bytes, same offsets, never past.
      const end = Math.min(
        to,
        c === "`" ? templateEnd(src, i) : quotedEnd(src, i),
      );
      out.push({ kind: c === "`" ? "template" : "string", start: i, end });
      i = end;
      noteCodeChar(src, context, c, i - 1);
      continue;
    }
    if (c === "/") {
      const mayBeRegex = mayStartRegex(context.prev, context.prevPrev, context.prevWord);
      if (mayBeRegex) {
        const end = regexLiteralEnd(src, i);
        if (end !== null) {
          // Same region clamp as the literal scanners above: a regex
          // candidate may not outrun its region.
          const clamped = Math.min(end, to);
          out.push({ kind: "regex", start: i, end: clamped });
          i = clamped;
          noteCodeChar(src, context, "/", i - 1);
          continue;
        }
      }
    }
    if (!/\s/.test(c)) noteCodeChar(src, context, c, i);
    i += 1;
  }
  return i;
}

/**
 * Walk `src` as alternating code runs and lexed spans, letting the caller
 * decide what each span prints. The single traversal every stripper shares, so
 * "what is a string" is answered once.
 */
export function renderSpans(
  src: string,
  html: boolean,
  print: (kind: SpanKind, text: string) => string,
): string {
  return renderLexedSpans(src, readLexicalSpans(src, html), print);
}

function renderLexedSpans(src: string, spans: readonly LexSpan[], print: (kind: SpanKind, text: string) => string): string {
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += src.slice(cursor, span.start);
    out += print(span.kind, src.slice(span.start, span.end));
    cursor = span.end;
  }
  return out + src.slice(cursor);
}

/**
 * Same UTF-16 length and newlines, nothing else. Erase each non-newline run
 * in one repeat instead of a regex replacement for every source character.
 */
export function blankSourceText(text: string): string {
  let out = "";
  let cursor = 0;
  let newline = text.indexOf("\n");
  while (newline !== -1) {
    out += " ".repeat(newline - cursor) + "\n";
    cursor = newline + 1;
    newline = text.indexOf("\n", cursor);
  }
  return out + " ".repeat(text.length - cursor);
}

/** A comment's own text, and the line it starts on. */
export interface ProseLine {
  /** 1-based line number in the FILE — the line a reader will open. */
  readonly line: number;
  /** The comment's text as written, including its opener. */
  readonly text: string;
  readonly kind: SpanKind;
}

// The brand. A real, module-private symbol and NOT exported, so no other
// module can name the key and therefore none can produce a value of this type:
// a `SourceView` can only come from this file's readers, which is the whole
// point of the door. A `declare`d brand would be erased at run time and the
// object literal below would carry `undefined` as a key.
const SOURCE_VIEW_BRAND: unique symbol = Symbol("source-view");

/**
 * Does this path name a TEMPLATE source — a file where markup text is a mode
 * and quotes in prose are literal characters?
 *
 * THE ONE OWNER of the file-type dispatch. `sourceViewOf` reads it to choose
 * the lexing mode, and every consumer that strips or spans source text by a
 * PATH imports it rather than re-spelling the extension list — one rule for
 * "which files are templates", shared by the lexer and every guard built on
 * it. A scanner handed a bare FRAGMENT (no file behind it) must name the mode
 * itself, and the honest name for a fragment is a probe path with the
 * fragment's own extension: a TS fragment says `probe.ts`, a markup fragment
 * says `probe.svelte`. Content-guessing the mode from the bytes is exactly
 * the parity hazard the mode machine exists to end.
 */
export function isTemplateSource(path: string): boolean {
  return /\.(?:svelte|html|htm)$/u.test(path);
}

/**
 * A file's text, reachable ONLY through a named view.
 *
 * It is deliberately not assignable to `string`. A caller who wants to match
 * something must say which view it is matching, and the compiler refuses the
 * shortcut — `tsc` already runs in both repositories, so the door is enforced
 * by a gate that exists rather than one somebody must add.
 */
export interface SourceView {
  readonly [SOURCE_VIEW_BRAND]: "source-view";
  /** The path this view was read from, for a guard's own reporting. */
  readonly path: string;
  /** UTF-16 code-unit length of the source — every view has this length. */
  readonly length: number;
  /** Comments, quoted-string interiors AND template interiors blanked. */
  code(): string;
  /** Comments and TEMPLATE interiors blanked; quoted strings intact. */
  codeWithStrings(): string;
  /**
   * ONLY comments blanked; quoted strings AND template interiors intact.
   *
   * For guards whose subject can live inside a template literal — a
   * hardcoded `` `/tmp/...` `` path is a template interior, and a guard that
   * reads it through `codeWithStrings()` goes blind to one of its own banned
   * shapes (§29's stripped-view trap, from the template side).
   */
  codeWithStringsAndTemplates(): string;
  /** The comments alone, with the line each one starts on. */
  prose(): readonly ProseLine[];
  /** The 1-based line holding `index`, which is an index into any view. */
  lineAt(index: number): number;
  /**
   * EVERY hit of `pattern` in one of the views, each at its TRUE line — THE
   * one spelling of "matchAll over a view, report `lineAt`" (the pattern's
   * own flags kept, `g` added), so no guard rebuilds a pattern without its
   * flags or counts lines on a transformed copy (a4-design H1).
   */
  matches(pattern: RegExp, over: SourceViewName): readonly SourceMatch[];
}

/** The view a match runs over (every one has the source's length, so its indexes are the file's). */
export type SourceViewName = "code" | "codeWithStrings" | "codeWithStringsAndTemplates";

/** One hit: its index and line in the file, the matched text, and the match itself (its groups). */
export type SourceMatch = Readonly<{ index: number; line: number; text: string; match: RegExpExecArray }>;

/**
 * A view over text that is already in hand — a planted fixture, a temp file's
 * contents, a string a test assembled.
 *
 * SEPARATE FROM `readSourceView` ON PURPOSE. A fixture is not a scan, and the
 * guard-of-guards that refuses unsanctioned byte reads has to be able to tell
 * "this test built a string" from "this scanner read the tree".
 */
export function sourceViewOf(text: string, path: string): SourceView {
  // Svelte and HTML files carry template comments and template modes; a `<!`
  // in ordinary TS does not open one, so the flag is derived from the path
  // rather than guessed (`isTemplateSource` is the one owner of that rule).
  const html = isTemplateSource(path);
  // The views differ only in rendering; lexical facts belong to this input.
  let spans: readonly LexSpan[] | null = null;
  const readSpans = (): readonly LexSpan[] => spans ??= readLexicalSpans(text, html);
  let codeCache: string | null = null;
  let withStringsCache: string | null = null;
  let withStringsAndTemplatesCache: string | null = null;
  let proseCache: readonly ProseLine[] | null = null;
  // Line starts, computed once: `lineAt` is called per finding and a scan over
  // the whole prefix per call turns a linear guard quadratic.
  let lineStarts: number[] | null = null;

  const isComment = (kind: SpanKind): boolean =>
    kind === "line-comment" || kind === "block-comment" || kind === "html-comment";

  return {
    [SOURCE_VIEW_BRAND]: "source-view",
    path,
    length: text.length,
    code(): string {
      if (codeCache === null) {
        codeCache = renderLexedSpans(text, readSpans(), (kind, span) => {
          if (kind === "regex") return span;
          if (isComment(kind)) return blankSourceText(span);
          // Keep the delimiters, blank the interior: an initializer must still
          // read as a list/template and not as a bare run of spaces.
          const quote = span[0]!;
          const closed = span.length > 1 && span.endsWith(quote);
          const body = closed ? span.slice(1, -1) : span.slice(1);
          return quote + blankSourceText(body) + (closed ? quote : "");
        });
      }
      return codeCache;
    },
    codeWithStrings(): string {
      if (withStringsCache === null) {
        withStringsCache = renderLexedSpans(text, readSpans(), (kind, span) => {
          if (kind === "string" || kind === "regex") return span;
          if (isComment(kind)) return blankSourceText(span);
          const closed = span.length > 1 && span.endsWith("`");
          const body = closed ? span.slice(1, -1) : span.slice(1);
          return "`" + blankSourceText(body) + (closed ? "`" : "");
        });
      }
      return withStringsCache;
    },
    codeWithStringsAndTemplates(): string {
      if (withStringsAndTemplatesCache === null) {
        withStringsAndTemplatesCache = renderLexedSpans(text, readSpans(), (kind, span) =>
          isComment(kind) ? blankSourceText(span) : span,
        );
      }
      return withStringsAndTemplatesCache;
    },
    prose(): readonly ProseLine[] {
      if (proseCache === null) {
        const out: ProseLine[] = [];
        for (const span of readSpans()) {
          if (!isComment(span.kind)) continue;
          out.push({
            line: this.lineAt(span.start),
            text: text.slice(span.start, span.end),
            kind: span.kind,
          });
        }
        proseCache = out;
      }
      return proseCache;
    },
    matches(pattern: RegExp, over: SourceViewName): readonly SourceMatch[] {
      const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
      return [...this[over]().matchAll(global)].map((match) => ({ index: match.index, line: this.lineAt(match.index), text: match[0], match: match as RegExpExecArray }));
    },
    lineAt(index: number): number {
      if (lineStarts === null) {
        const starts = [0];
        for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") starts.push(i + 1);
        lineStarts = starts;
      }
      // Binary search: the last start at or before `index`.
      let low = 0;
      let high = lineStarts.length - 1;
      while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (lineStarts[mid]! <= index) low = mid;
        else high = mid - 1;
      }
      return low + 1;
    },
  };
}

/**
 * THE SANCTIONED READER. Every scanner that matches a pattern against source
 * comes through here.
 *
 * COUNTS COME FROM BYTES, NEVER FROM `grep`: a source file containing a NUL
 * byte is binary to GNU grep, which then prints nothing and exits cleanly — a
 * silently smaller universe. This reads the file.
 */
export function readSourceView(path: string): SourceView {
  return sourceViewOf(readFileSync(path, "utf8"), path);
}
