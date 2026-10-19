/**
 * THE ONE MARKDOWN PARSER — markdown → a tree of PLAIN NODES (no HTML, ever),
 * shared by the cockpit's renderer (`src/cockpit/render/Prose.svelte`) and the
 * repository's link and code-span checks (`extractMarkdown`: the dead-link
 * ratchet, `engine/src/workflow/record-links.ts`, and the briefing check).
 * One grammar for both, so what a reader sees as a link is what the checks
 * judge as one (UR-16: a second, regex parser once judged code spans as
 * links and missed titled, angle-bracket and reference links).
 *
 * PROVENANCE: the safe-subset parser the old tree used for chat markdown
 * (`src/lib/shared/markdown-parser.ts`) was the right shape — pure TS, no
 * DOM, no HTML strings, rendered by a Svelte component that escapes every
 * node. The cockpit's import law (§13, tests/cockpit/cockpit-no-legacy-
 * imports.test.ts) forbade importing the old tree (now deleted), so this
 * is a PORT, not an import: the same node model and the same
 * security posture, extended here with the pieces model output actually uses
 * and the old parser dropped on the floor (tables, bare-URL autolinks,
 * strikethrough, backslash escapes).
 *
 * NO npm markdown dependency was added: the tree has none (package.json
 * carries only nanostores + zod), no CDN is permitted (§12.4), and the safe
 * subset is ~450 lines that we can audit line by line. A general-purpose
 * parser (marked/markdown-it) emits an HTML STRING, which would force
 * `{@html}` on untrusted model output — precisely the thing the renderer
 * guard (tests/cockpit/render-sanitization-owner.test.ts) forbids.
 *
 * SECURITY MODEL — the whole reason this file returns nodes, not markup:
 *   - every leaf is a `text`/`code` node carrying a plain string; the Svelte
 *     renderer interpolates it with `{value}`, so the DOM never parses it as
 *     markup. There is no code path from model output to innerHTML.
 *   - link hrefs are allowlisted to http/https/mailto. Anything else
 *     (javascript:, data:, vbscript:, a protocol-relative //host, a
 *     tab/newline-obfuscated "java\tscript:") DEMOTES the link to its plain
 *     text — the text still renders, the href is dropped.
 *   - raw HTML in the source is NOT parsed. `<script>alert(1)</script>` is
 *     text, and renders as the literal characters.
 *
 * STREAMING: lenient by construction. An unmatched `**`, `*`, `~~`, `` ` ``
 * or an unclosed fence renders as literal text / a code block to the end, so
 * a half-arrived token never produces broken structure.
 *
 * HONESTY: the parser only ever reports structure the source actually has.
 * It never invents a heading, never promotes a line to a list, and when a
 * document is past the caller's budget it is told so explicitly
 * (`parseProseBounded`) rather than being handed a silently truncated
 * tree.
 *
 * NAMING. The exported and internal symbols here deliberately do NOT share
 * names with the old tree's `markdown-parser.ts`. They are not the same
 * functions: this fork adds tables, bare-URL autolinks, strikethrough,
 * backslash escapes, tilde fences, a bounded entry point, and a hardened
 * link allowlist, and the import law (§13) means the two can never be
 * deduplicated into one owner while the old tree lives. Distinct names say
 * that plainly, and keep the scattered-helper guard meaningful instead of
 * teaching it to ignore a real collision.
 */

/**
 * What the extraction collects while the one grammar scans: every link
 * destination (inline, reference definition, image, autolink) and every code
 * span, with the 1-based line it starts on. The renderer passes none.
 */
type Collector = Readonly<{
  links: { target: string; line: number }[];
  codeSpans: { text: string; line: number }[];
}>;

/** The scan's context: the reference definitions in force, and the collector (absent when rendering). */
type InlineContext = Readonly<{ definitions: ReadonlyMap<string, string>; collector?: Collector }>;

const NO_DEFINITIONS: ReadonlyMap<string, string> = new Map();

export type InlineNode =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "code"; readonly code: string }
  | { readonly type: "bold"; readonly children: readonly InlineNode[] }
  | { readonly type: "italic"; readonly children: readonly InlineNode[] }
  | { readonly type: "strike"; readonly children: readonly InlineNode[] }
  | { readonly type: "link"; readonly href: string; readonly children: readonly InlineNode[] };

export type MdListItem = Readonly<{
  readonly children: readonly InlineNode[];
  readonly subBlocks: readonly MdBlock[];
}>;

export type CellAlign = "left" | "center" | "right" | "none";

export type MdBlock =
  | { readonly type: "code"; readonly lang: string; readonly code: string }
  | { readonly type: "paragraph"; readonly children: readonly InlineNode[] }
  | {
      readonly type: "heading";
      readonly level: 1 | 2 | 3 | 4 | 5 | 6;
      readonly children: readonly InlineNode[];
    }
  | { readonly type: "hr" }
  | { readonly type: "blockquote"; readonly children: readonly MdBlock[] }
  | { readonly type: "list"; readonly ordered: boolean; readonly items: readonly MdListItem[] }
  | {
      readonly type: "table";
      readonly align: readonly CellAlign[];
      readonly header: readonly (readonly InlineNode[])[];
      readonly rows: readonly (readonly (readonly InlineNode[])[])[];
    };

/**
 * Safe link schemes. Deliberately an ALLOWLIST: a denylist of "javascript:"
 * loses to `java\0script:`, `JaVaScRiPt:`, and `&#106;avascript:`.
 */
const SAFE_URL = /^(?:https?:\/\/|mailto:)/i;

/**
 * Characters stripped before the scheme test. Browsers ignore control
 * characters, tabs and newlines INSIDE a scheme, so a `java&#9;script:`
 * href navigates as javascript: while sailing past a naive regex. Removing
 * them first means the allowlist sees the scheme the BROWSER will see.
 * Written as explicit \uXXXX escapes: a literal control character in regex
 * source is unreadable, and a literal U+000A is a syntax error.
 */
const URL_NOISE =
  /[\u0000-\u0020\u007F-\u00A0\u1680\u2000-\u200F\u2028-\u202F\u205F\u3000\uFEFF]/g;

export function isSafeLinkTarget(href: string): boolean {
  const cleaned = href.replace(URL_NOISE, "");
  // A protocol-relative URL ("//evil.example") inherits the page scheme and
  // is not in the allowlist.
  if (cleaned.startsWith("//")) return false;
  return SAFE_URL.test(cleaned);
}

/** Normalize a link target for rendering. Only called after isSafeLinkTarget. */
export function safeHref(href: string): string {
  return href.replace(URL_NOISE, "").trim();
}

// ── Stream linkify ──────────────────────────────────────────────────────────

export type StreamSegment =
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "link"; href: string; text: string }>;

/**
 * Bare URLs in PLAIN STREAM TEXT (a command's output, leftover text) become
 * link segments — the same word-boundary scan, the same trailing-punctuation
 * trim and the SAME allowlist as markdown's autolink, so there is one place
 * a URL is judged safe to become an anchor.
 *
 * Deliberately NARROWER than the autolink on top of that: http(s) only. A
 * stream is not prose — `mailto:` in a build log is far likelier quoted
 * data than a door, and being wrong in that direction costs a link, never
 * an unwanted one.
 *
 * THE RAW TEXT IS THE INVARIANT: the segments' words concatenate back to
 * the input byte-for-byte (the link's words ARE the raw characters; only
 * the href is minted). That is what keeps a stream's selection-copy and its
 * copy button verbatim — mutation-tested against this exact property.
 */
export function linkifyStreamText(text: string): readonly StreamSegment[] {
  const out: StreamSegment[] = [];
  let plain = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if ((ch === "h" || ch === "H") && (i === 0 || /[\s(<]/.test(text[i - 1]!))) {
      AUTOLINK_RE.lastIndex = i;
      const m = AUTOLINK_RE.exec(text);
      if (m !== null) {
        const raw = m[0].replace(AUTOLINK_TRAIL, "");
        if (raw.length > 0 && /^https?:\/\//i.test(raw) && isSafeLinkTarget(raw)) {
          if (plain.length > 0) {
            out.push({ kind: "text", text: plain });
            plain = "";
          }
          out.push({ kind: "link", href: safeHref(raw), text: raw });
          i += raw.length;
          continue;
        }
      }
    }
    plain += ch;
    i += 1;
  }
  if (plain.length > 0) out.push({ kind: "text", text: plain });
  return out;
}

// ── Inline parser ───────────────────────────────────────────────────────────

/** Bare URLs the model wrote without markdown link syntax. */
const AUTOLINK_RE = /https?:\/\/[^\s<>"'`\\]+/y;
/** Trailing characters that are almost always sentence punctuation, not URL. */
const AUTOLINK_TRAIL = /[.,;:!?)\]}'"]+$/;
/** Punctuation a backslash may escape (CommonMark's set). */
const ESCAPABLE = /[\\`*_{}[\]()#+\-.!>~|]/;

/** How many line breaks `input` holds before `index` (the line an offset is on, relative to the input's first line). */
function linesBefore(input: string, index: number): number {
  let count = 0;
  for (let at = input.indexOf("\n"); at !== -1 && at < index; at = input.indexOf("\n", at + 1)) count += 1;
  return count;
}

/** A reference label as CommonMark matches it: case-folded, inner whitespace collapsed. */
function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/gu, " ").toLowerCase();
}

/** `text` with its backslash escapes resolved (a destination's `\_` is `_`). */
function unescapeText(text: string): string {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!>~|<"'])/gu, "$1");
}

/** The index of the `]` that closes the `[` at `open` (nested brackets balanced, escapes skipped), or -1. */
function closingBracket(input: string, open: number): number {
  let depth = 0;
  for (let j = open; j < input.length; j += 1) {
    const ch = input[j];
    if (ch === "\\") { j += 1; continue; }
    if (ch === "[") depth += 1;
    else if (ch === "]") { depth -= 1; if (depth === 0) return j; }
  }
  return -1;
}

/**
 * An inline link's `(destination "title")` starting at `open` (the `(`): the
 * destination (`<…>` or a run without spaces whose parentheses balance), an
 * optional title in `"…"`, `'…'` or `(…)`, then `)`. `undefined` when the
 * text after `]` is not one (the `[` is then literal text).
 */
function inlineDestination(input: string, open: number): Readonly<{ destination: string; end: number }> | undefined {
  let j = open + 1;
  const skipSpace = (): void => { while (j < input.length && (input[j] === " " || input[j] === "\t" || input[j] === "\n")) j += 1; };
  skipSpace();
  let destination: string;
  if (input[j] === "<") {
    const close = input.indexOf(">", j + 1);
    if (close === -1) return undefined;
    destination = input.slice(j + 1, close);
    if (/[<\n]/u.test(destination)) return undefined;
    j = close + 1;
  } else {
    const start = j;
    let depth = 0;
    while (j < input.length) {
      const ch = input[j]!;
      if (ch === "\\" && j + 1 < input.length) { j += 2; continue; }
      if (ch === " " || ch === "\t" || ch === "\n") break;
      if (ch === "(") depth += 1;
      else if (ch === ")") { if (depth === 0) break; depth -= 1; }
      j += 1;
    }
    if (depth !== 0) return undefined;
    destination = input.slice(start, j);
  }
  skipSpace();
  const quote = input[j];
  if (quote === "\"" || quote === "'" || quote === "(") {
    const closer = quote === "(" ? ")" : quote;
    let k = j + 1;
    while (k < input.length && input[k] !== closer) k += input[k] === "\\" ? 2 : 1;
    if (k >= input.length) return undefined;
    j = k + 1;
    skipSpace();
  }
  if (input[j] !== ")") return undefined;
  return { destination: unescapeText(destination), end: j + 1 };
}

/** The length of the run of backticks starting at `index`. */
function backtickRun(input: string, index: number): number {
  let n = 0;
  while (input[index + n] === "`") n += 1;
  return n;
}

function scanInline(input: string, context: InlineContext = { definitions: NO_DEFINITIONS }, line = 1): readonly InlineNode[] {
  const nodes: InlineNode[] = [];
  let i = 0;
  let text = "";
  const lineAt = (index: number): number => line + linesBefore(input, index);
  const collect = (target: string, index: number): void => {
    context.collector?.links.push({ target, line: lineAt(index) });
  };
  /**
   * A link to `destination` worded `linkText` (at `index` of the input, its
   * words at `wordsAt`): an anchor when the scheme is safe, else its words.
   * An inline link is collected here; a reference link's destination is its
   * definition's, collected once where it is defined.
   */
  const pushLink = (destination: string, linkText: string, index: number, wordsAt: number, inline: boolean): void => {
    if (inline) collect(destination, index);
    const children = scanInline(linkText, context, lineAt(wordsAt));
    if (isSafeLinkTarget(destination)) {
      nodes.push({ type: "link", href: safeHref(destination), children });
    } else {
      // Unsafe or local: keep the words, drop the target. Nothing is
      // hidden from the reader; the link simply cannot navigate.
      nodes.push(...children);
    }
  };

  function flushText(): void {
    if (text.length > 0) {
      nodes.push({ type: "text", text });
      text = "";
    }
  }

  while (i < input.length) {
    const ch = input[i]!;

    // Backslash escape: `\*` is a literal asterisk, not an emphasis marker.
    if (ch === "\\") {
      const next = input[i + 1];
      if (next !== undefined && ESCAPABLE.test(next)) {
        text += next;
        i += 2;
        continue;
      }
    }

    // Inline code: a run of N backticks closes at the next run of exactly
    // N (CommonMark), so ``a ` b`` is one span. Highest precedence —
    // markers (and link syntax) inside a code span are literal.
    if (ch === "`") {
      const run = backtickRun(input, i);
      let close = -1;
      for (let j = input.indexOf("`", i + run); j !== -1; j = input.indexOf("`", j + backtickRun(input, j))) {
        if (backtickRun(input, j) === run) { close = j; break; }
      }
      if (close === -1) {
        text += input.slice(i, i + run);
        i += run;
        continue;
      }
      flushText();
      const raw = input.slice(i + run, close).replace(/\n/gu, " ");
      const code = raw.length > 1 && raw.startsWith(" ") && raw.endsWith(" ") && raw.trim().length > 0 ? raw.slice(1, -1) : raw;
      context.collector?.codeSpans.push({ text: code, line: lineAt(i) });
      nodes.push({ type: "code", code });
      i = close + run;
      continue;
    }

    // Strikethrough: ~~...~~
    if (ch === "~" && input[i + 1] === "~") {
      const close = findClosingMarker(input, i + 2, "~~");
      if (close !== -1) {
        flushText();
        nodes.push({ type: "strike", children: scanInline(input.slice(i + 2, close), context, lineAt(i + 2)) });
        i = close + 2;
        continue;
      }
    }

    // Bold: **...**
    if (ch === "*" && input[i + 1] === "*") {
      const close = findClosingMarker(input, i + 2, "**");
      if (close !== -1) {
        flushText();
        nodes.push({ type: "bold", children: scanInline(input.slice(i + 2, close), context, lineAt(i + 2)) });
        i = close + 2;
        continue;
      }
    }

    // Italic: *...* (single). Avoid matching the second * of a bold pair.
    if (ch === "*" && input[i + 1] !== "*") {
      const close = findClosingMarker(input, i + 1, "*");
      if (close !== -1) {
        flushText();
        nodes.push({ type: "italic", children: scanInline(input.slice(i + 1, close), context, lineAt(i + 1)) });
        i = close + 1;
        continue;
      }
    }

    // Link: [text](destination "title"), [text][label], [label][] or
    // [label] (a reference link names a definition of this document).
    if (ch === "[") {
      const textClose = closingBracket(input, i);
      if (textClose !== -1) {
        const linkText = input.slice(i + 1, textClose);
        if (input[textClose + 1] === "(") {
          const inline = inlineDestination(input, textClose + 1);
          if (inline !== undefined) {
            flushText();
            pushLink(inline.destination, linkText, i, i + 1, true);
            i = inline.end;
            continue;
          }
        } else {
          const full = input[textClose + 1] === "[" ? input.indexOf("]", textClose + 2) : -1;
          const label = full === -1 ? linkText : input.slice(textClose + 2, full) || linkText;
          const destination = context.definitions.get(normalizeLabel(label));
          if (destination !== undefined) {
            flushText();
            pushLink(destination, linkText, i, i + 1, false);
            i = (full === -1 ? textClose : full) + 1;
            continue;
          }
        }
      }
    }

    // Bare URL autolink (only at a word boundary, so "xhttp://" is not a link).
    if ((ch === "h" || ch === "H") && (i === 0 || /[\s(<]/.test(input[i - 1]!))) {
      AUTOLINK_RE.lastIndex = i;
      const m = AUTOLINK_RE.exec(input);
      if (m !== null) {
        const raw = m[0].replace(AUTOLINK_TRAIL, "");
        if (raw.length > 0 && isSafeLinkTarget(raw)) {
          flushText();
          collect(raw, i);
          nodes.push({ type: "link", href: safeHref(raw), children: [{ type: "text", text: raw }] });
          i += raw.length;
          continue;
        }
      }
    }

    text += ch;
    i += 1;
  }

  flushText();
  return nodes;
}

/**
 * Find the next `marker` whose preceding char is not whitespace (so `** **`
 * is not emphasis). Returns -1 when there is none — the caller then renders
 * the opener literally, which is what makes streaming safe.
 */
function findClosingMarker(input: string, start: number, marker: string): number {
  let j = start;
  while (j < input.length) {
    const idx = input.indexOf(marker, j);
    if (idx === -1) return -1;
    const prev = input[idx - 1];
    if (prev !== " " && prev !== "\t" && prev !== "\n" && prev !== undefined) return idx;
    j = idx + marker.length;
  }
  return -1;
}

// ── Block parsers ───────────────────────────────────────────────────────────

const FENCE_RE = /^ {0,3}(?:```|~~~)/;
const HEADING_RE = /^( {0,3})(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const HR_RE = /^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const BLOCKQUOTE_RE = /^[ \t]{0,3}>[ \t]?(.*)$/;
const UL_RE = /^([ \t]*)([-*+])[ \t]+(.*)$/;
const OL_RE = /^([ \t]*)(\d{1,9})[.)][ \t]+(.*)$/;
/** A table delimiter row: `| --- | :--: |` (the row that MAKES it a table). */
const TABLE_DELIM_RE = /^[ \t]{0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/** ``` and ~~~ are both exactly three characters — the marker's fixed width. */
const FENCE_MARKER_LEN = 3;

function matchFenceLine(line: string): { lang: string; marker: string } | null {
  if (!FENCE_RE.test(line)) return null;
  const trimmed = line.trimStart();
  const marker = trimmed.slice(0, FENCE_MARKER_LEN);
  return { lang: trimmed.slice(FENCE_MARKER_LEN).trim(), marker };
}

function indentWidth(line: string): number {
  let n = 0;
  while (n < line.length && (line[n] === " " || line[n] === "\t")) n += 1;
  return n;
}

/** A reference definition line: `[label]: destination "optional title"` (up to three spaces of indent). */
const DEFINITION_RE = /^ {0,3}\[([^\]]+)\]:[ \t]*(<[^>\n]*>|\S+)(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/;

/**
 * The document's reference definitions (label → destination, the first
 * definition of a label wins) and the lines that hold them: a definition
 * starts a block (after a blank line, a heading, a rule, another definition
 * or the start), never inside a fenced code block.
 */
function collectDefinitions(lines: readonly string[]): Readonly<{ definitions: ReadonlyMap<string, string>; lines: ReadonlySet<number>; at: ReadonlyMap<number, string> }> {
  const definitions = new Map<string, string>();
  const held = new Set<number>();
  const at = new Map<number, string>();
  let fence: string | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const marker = matchFenceLine(line);
    if (fence !== undefined) {
      if (marker !== null && marker.marker === fence && marker.lang === "") fence = undefined;
      continue;
    }
    if (marker !== null) {
      fence = marker.marker;
      continue;
    }
    const previous = i === 0 ? "" : lines[i - 1]!;
    const startsBlock = previous.trim() === "" || held.has(i - 1) || HEADING_RE.test(previous) || HR_RE.test(previous);
    const match = startsBlock ? DEFINITION_RE.exec(line) : null;
    if (match === null) continue;
    const raw = match[2]!;
    const destination = unescapeText(raw.startsWith("<") ? raw.slice(1, -1) : raw);
    const label = normalizeLabel(match[1]!);
    if (!definitions.has(label)) definitions.set(label, destination);
    held.add(i);
    at.set(i, destination);
  }
  return { definitions, lines: held, at };
}

export function parseProse(src: string): readonly MdBlock[] {
  const lines = src.split("\n");
  const found = collectDefinitions(lines);
  return scanBlocks(lines, 0, lines.length, { definitions: found.definitions }, 0, found.lines);
}

/**
 * Parse with the size cap applied (the renderer's budget, its own setting).
 * `overLimit` is true when the document was too large to parse and `blocks`
 * is therefore the source as ONE plain paragraph — the caller must say so on
 * screen rather than pretending the prose had no structure.
 */
export function parseProseBounded(
  src: string,
  maxChars: number,
): Readonly<{ blocks: readonly MdBlock[]; overLimit: boolean }> {
  if (src.length > maxChars) {
    return { blocks: [{ type: "paragraph", children: [{ type: "text", text: src }] }], overLimit: true };
  }
  return { blocks: parseProse(src), overLimit: false };
}

/** One link destination or code span the document holds, with the 1-based line it starts on. */
export type MarkdownLink = Readonly<{ target: string; line: number }>;
export type MarkdownCodeSpan = Readonly<{ text: string; line: number }>;

/**
 * THE EXTRACTION, through the same grammar the renderer parses with: every
 * link destination the document holds — inline (`[t](dest "title")`,
 * `[t](<dest with spaces>)`), image, autolink, reference link and reference
 * definition (`[label]: dest`) — and every code span, each with its line.
 * Code (spans and fenced blocks) is never a link: what a reader sees as code
 * the checks never judge as one. Destinations are spelled as written, with
 * their backslash escapes resolved.
 */
export function extractMarkdown(src: string): Readonly<{ links: readonly MarkdownLink[]; codeSpans: readonly MarkdownCodeSpan[] }> {
  const lines = src.split("\n");
  const found = collectDefinitions(lines);
  const collector: Collector = { links: [], codeSpans: [] };
  for (const [index, destination] of found.at) collector.links.push({ target: destination, line: index + 1 });
  scanBlocks(lines, 0, lines.length, { definitions: found.definitions, collector }, 0, found.lines);
  const byLine = <T extends { line: number }>(items: T[]): readonly T[] => Object.freeze(items.map((item) => Object.freeze({ ...item })).sort((left, right) => left.line - right.line));
  return Object.freeze({ links: byLine(collector.links), codeSpans: byLine(collector.codeSpans) });
}

function scanBlocks(
  lines: readonly string[],
  start: number,
  end: number,
  context: InlineContext,
  lineOffset: number,
  definitionLines: ReadonlySet<number> = new Set(),
): readonly MdBlock[] {
  const blocks: MdBlock[] = [];
  let i = start;
  const lineOf = (index: number): number => lineOffset + index + 1;

  while (i < end) {
    const line = lines[i]!;
    if (definitionLines.has(i)) {
      i += 1;
      continue;
    }

    // Fenced code block. The closing fence must use the same marker family,
    // so a ``` block can contain ~~~ and vice versa.
    const fence = matchFenceLine(line);
    if (fence !== null) {
      const lang = fence.lang;
      i += 1;
      const codeLines: string[] = [];
      let closed = false;
      while (i < end) {
        const close = matchFenceLine(lines[i]!);
        if (close !== null && close.marker === fence.marker && close.lang === "") {
          closed = true;
          i += 1;
          break;
        }
        codeLines.push(lines[i]!);
        i += 1;
      }
      blocks.push({ type: "code", lang, code: codeLines.join("\n") });
      if (!closed) break;
      continue;
    }

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // HR before list: "---" is a rule, "- x" is a list item.
    if (HR_RE.test(line)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }

    const h = HEADING_RE.exec(line);
    if (h !== null && h[2] !== undefined) {
      const level = h[2].length as 1 | 2 | 3 | 4 | 5 | 6;
      const text = (h[3] ?? "").replace(/#{0,}\s*$/, "").trim();
      blocks.push({ type: "heading", level, children: scanInline(text, context, lineOf(i)) });
      i += 1;
      continue;
    }

    if (BLOCKQUOTE_RE.test(line)) {
      const quoteStart = i;
      const quoteLines: string[] = [];
      while (i < end && BLOCKQUOTE_RE.test(lines[i]!)) {
        const m = BLOCKQUOTE_RE.exec(lines[i]!);
        quoteLines.push(m![1] ?? "");
        i += 1;
      }
      blocks.push({ type: "blockquote", children: scanBlocks(quoteLines, 0, quoteLines.length, context, lineOffset + quoteStart) });
      continue;
    }

    // Table: a header row followed by a delimiter row. Both are required —
    // a line with pipes alone stays a paragraph (no invented structure).
    if (
      line.includes("|") &&
      i + 1 < end &&
      TABLE_DELIM_RE.test(lines[i + 1]!) &&
      lines[i + 1]!.includes("-")
    ) {
      const table = parseTable(lines, i, end, context, lineOffset);
      if (table !== null) {
        blocks.push(table.block);
        i = table.next;
        continue;
      }
    }

    if (UL_RE.test(line) || OL_RE.test(line)) {
      const ordered = OL_RE.test(line);
      const result = scanList(lines, i, end, ordered, context, lineOffset);
      blocks.push({ type: "list", ordered, items: result.items });
      i = result.next;
      continue;
    }

    // Paragraph: consecutive non-blank, non-special lines.
    const paraStart = i;
    const paraLines: string[] = [line];
    i += 1;
    while (
      i < end &&
      lines[i]!.trim() !== "" &&
      matchFenceLine(lines[i]!) === null &&
      !HR_RE.test(lines[i]!) &&
      !HEADING_RE.test(lines[i]!) &&
      !BLOCKQUOTE_RE.test(lines[i]!) &&
      !UL_RE.test(lines[i]!) &&
      !OL_RE.test(lines[i]!) &&
      !definitionLines.has(i)
    ) {
      paraLines.push(lines[i]!);
      i += 1;
    }
    blocks.push({ type: "paragraph", children: scanInline(paraLines.join("\n"), context, lineOf(paraStart)) });
  }

  return blocks;
}

/** Split a table row on unescaped pipes, dropping the optional outer pipes. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === "\\" && line[i + 1] === "|") {
      cur += "|";
      i += 1;
      continue;
    }
    if (ch === "|") {
      cells.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  if (cells.length > 0 && cells[0]!.trim() === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1]!.trim() === "") cells.pop();
  return cells.map((c) => c.trim());
}

function alignOf(spec: string): CellAlign {
  const s = spec.trim();
  const left = s.startsWith(":");
  const right = s.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return "none";
}

function parseTable(
  lines: readonly string[],
  start: number,
  end: number,
  context: InlineContext,
  lineOffset: number,
): Readonly<{ block: MdBlock; next: number }> | null {
  const header = splitRow(lines[start]!);
  const align = splitRow(lines[start + 1]!).map(alignOf);
  if (header.length === 0 || align.length === 0) return null;
  // A real table's delimiter row has one spec per header column.
  if (align.length !== header.length) return null;

  const rows: (readonly InlineNode[])[][] = [];
  let i = start + 2;
  while (i < end) {
    const line = lines[i]!;
    if (line.trim() === "" || !line.includes("|")) break;
    const cells = splitRow(line);
    // Render exactly the cells the row has: short rows are NOT padded with
    // invented empties beyond the column count, long rows are not clipped.
    const rowLine = lineOffset + i + 1;
    rows.push(cells.map((c) => scanInline(c, context, rowLine)));
    i += 1;
  }

  return {
    block: {
      type: "table",
      align,
      header: header.map((c) => scanInline(c, context, lineOffset + start + 1)),
      rows,
    },
    next: i,
  };
}

function scanList(
  lines: readonly string[],
  start: number,
  end: number,
  ordered: boolean,
  context: InlineContext,
  lineOffset: number,
): Readonly<{ items: readonly MdListItem[]; next: number }> {
  const items: MdListItem[] = [];
  let i = start;

  while (i < end) {
    const line = lines[i]!;
    const marker = ordered ? OL_RE.exec(line) : UL_RE.exec(line);
    if (marker === null) {
      if (line.trim() === "") {
        let peek = i + 1;
        while (peek < end && lines[peek]!.trim() === "") peek += 1;
        if (peek < end) {
          const nextMarker = ordered ? OL_RE.exec(lines[peek]!) : UL_RE.exec(lines[peek]!);
          if (nextMarker !== null) {
            i = peek;
            continue;
          }
        }
        break;
      }
      const lastItem = items[items.length - 1];
      if (lastItem !== undefined && isLazyContinuation(line)) {
        const sub = collectIndentedRun(lines, i, end, 2, context, lineOffset);
        items[items.length - 1] = {
          ...lastItem,
          subBlocks: [...lastItem.subBlocks, ...sub.blocks],
        };
        i = sub.next;
        continue;
      }
      break;
    }

    const indent = marker[1]!.length;
    const content = marker[3] ?? "";
    items.push({ children: scanInline(content.trim(), context, lineOffset + i + 1), subBlocks: [] });
    i += 1;

    const contentCol = indent + (ordered ? marker[2]!.length + 2 : 2);
    while (i < end) {
      const cont = lines[i]!;
      if (cont.trim() === "") {
        let peek = i + 1;
        while (peek < end && lines[peek]!.trim() === "") peek += 1;
        if (peek < end && indentWidth(lines[peek]!) >= contentCol) {
          i = peek;
          continue;
        }
        break;
      }
      if (indentWidth(cont) >= contentCol) {
        const sub = collectIndentedRun(lines, i, end, contentCol, context, lineOffset);
        items[items.length - 1] = {
          ...items[items.length - 1]!,
          subBlocks: [...items[items.length - 1]!.subBlocks, ...sub.blocks],
        };
        i = sub.next;
        continue;
      }
      break;
    }
  }

  return { items, next: i };
}

function isLazyContinuation(line: string): boolean {
  return indentWidth(line) >= 2 && line.trim() !== "";
}

function collectIndentedRun(
  lines: readonly string[],
  start: number,
  end: number,
  minIndent: number,
  context: InlineContext,
  lineOffset: number,
): Readonly<{ blocks: readonly MdBlock[]; next: number }> {
  const subLines: string[] = [];
  let i = start;
  while (i < end) {
    const line = lines[i]!;
    if (line.trim() === "") {
      let peek = i + 1;
      while (peek < end && lines[peek]!.trim() === "") peek += 1;
      if (peek < end && indentWidth(lines[peek]!) >= minIndent) {
        subLines.push("");
        i += 1;
        continue;
      }
      break;
    }
    if (indentWidth(line) >= minIndent) {
      subLines.push(line.slice(minIndent));
      i += 1;
      continue;
    }
    break;
  }
  return { blocks: scanBlocks(subLines, 0, subLines.length, context, lineOffset + start), next: i };
}
