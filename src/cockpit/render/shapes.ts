/**
 * COCKPIT RENDER — what shape is this tool's recorded output? (pure).
 *
 * The rule this module exists to keep: a richer rendering may only be chosen
 * when the RECORDED DATA actually has that shape. Every classifier here is a
 * test on the real value; when a test does not pass, the shape falls back to
 * plain preserved text. Nothing is coerced, re-ordered, re-indented, or
 * summarized away — `classifyOutput` returns views ONTO the recorded value,
 * and the plain-text fallback always carries the original string verbatim.
 *
 * Specifically NOT done here:
 *   - no guessing a file's line numbers when nothing recorded them;
 *   - no "prettifying" a command's stdout (whitespace is the output);
 *   - no inventing a result count a search never reported;
 *   - no silent truncation — every cap returns the hidden count so the UI
 *     can name it ("N more lines"), which is the §1.1 absence law applied to
 *     folding.
 */

import { isRecord } from "../../state/coverage.ts";
import { grammarForPath } from "./highlight.ts";
import {
  IMAGE_MAX_BYTES,
  JSON_AUTO_OPEN_DEPTH,
  JSON_AUTO_OPEN_MAX_CHILDREN,
} from "./render-config.ts";

// ── Fold arithmetic ─────────────────────────────────────────────────────────

export type Fold = Readonly<{ shown: readonly string[]; hidden: number; total: number }>;

/** Show at most `cap` lines; report exactly how many were held back. */
export function foldLines(lines: readonly string[], cap: number): Fold {
  if (lines.length <= cap) return { shown: lines, hidden: 0, total: lines.length };
  return { shown: lines.slice(0, cap), hidden: lines.length - cap, total: lines.length };
}

// ── Content probes ──────────────────────────────────────────────────────────

/**
 * True when the text already carries its own line-number rail (many file
 * readers return "  12→code"). Adding a second rail would double-number the
 * content, so the renderer must not. Requires a strong majority of non-blank
 * lines to match — one "1. item" does not make a numbered listing.
 */
const OWN_NUMBER_RE = /^\s*\d+\s*(?:→|\||:|\t)/;
export function carriesOwnLineNumbers(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length < 3) return false;
  let hits = 0;
  for (const l of lines) if (OWN_NUMBER_RE.test(l)) hits += 1;
  return hits / lines.length >= 0.8;
}

/** `path:line:text` / `path:line` grep-style rows. */
const GREP_ROW_RE = /^(.+?):(\d+):(?::(\d+):)?(.*)$/;

export type SearchHit = Readonly<{ path: string; line?: number; text: string }>;

/**
 * Read grep-style rows out of a string. Returns null unless a strong
 * majority of non-blank lines parse — a prose paragraph containing one colon
 * and a number must not become a "search result list".
 *
 * A search tool may frame its rows with its own summary — how many matches it
 * is showing of how many exist, which parts of the tree it could not reach.
 * Those lines are the tool speaking about the result, not prose that happens
 * to resemble it, and they arrive as contiguous blocks at the very start or
 * the very end. Counting them against the majority made the shape depend on
 * how many matches there happened to be: three matches under one summary line
 * fell below the threshold and the whole thing rendered as flat text, while
 * thirty of them did not. The frame is therefore excluded from the ratio and
 * the ratio is judged on the body — which still leaves a paragraph with no
 * rows in it failing, because a body of zero rows is a ratio of zero.
 */
export function parseSearchRows(text: string): readonly SearchHit[] | null {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length < 2) return null;
  const parseRow = (l: string): SearchHit | null => {
    const m = GREP_ROW_RE.exec(l);
    if (m === null) return null;
    const path = m[1]!;
    // A path with a space before the colon is prose, not a file path.
    if (path.includes(" ") && !path.includes("/")) return null;
    return { path, line: Number(m[2]), text: m[4] ?? "" };
  };
  let start = 0;
  while (start < lines.length && parseRow(lines[start]!) === null) start += 1;
  let end = lines.length;
  while (end > start && parseRow(lines[end - 1]!) === null) end -= 1;
  const body = lines.slice(start, end);
  if (body.length === 0) return null;
  const hits: SearchHit[] = [];
  for (const l of body) {
    const hit = parseRow(l);
    if (hit !== null) hits.push(hit);
  }
  // One row is not a list. Trimming the frame would otherwise promote a prose
  // paragraph that merely contains a single path-like line into a "search
  // result", which is the false positive the majority rule was protecting
  // against and which trimming alone would have reopened.
  if (hits.length < 2) return null;
  return hits.length / body.length >= 0.8 ? hits : null;
}

/** Read search hits out of an array of recorded objects. */
export function searchHitsFromArray(value: unknown): readonly SearchHit[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const hits: SearchHit[] = [];
  for (const item of value) {
    if (!isRecord(item) || Array.isArray(item)) return null;
    const path = item["path"] ?? item["file"] ?? item["filePath"] ?? item["filename"];
    if (typeof path !== "string") return null;
    const rawLine = item["line"] ?? item["lineNumber"] ?? item["line_number"];
    const text = item["text"] ?? item["match"] ?? item["snippet"] ?? item["content"] ?? item["preview"];
    hits.push({
      path,
      ...(typeof rawLine === "number" ? { line: rawLine } : {}),
      text: typeof text === "string" ? text : "",
    });
  }
  return hits;
}

// ── Images ──────────────────────────────────────────────────────────────────

/**
 * An image the RECORDED OUTPUT actually carries — a screenshot-returning
 * tool's payload, honoured as pixels instead of dumped as a base64 wall.
 *
 * `src` is the data: URI ready for an <img>, and it is null exactly when the
 * decoded payload is past `IMAGE_MAX_BYTES`: the refusal is decided HERE, at
 * the classifier, so a renderer holding this shape cannot render what the
 * budget refused — there is no src to hand to the element.
 */
export type ImageView = Readonly<{
  /** data: URI for the <img>; null = refused by the byte budget. */
  src: string | null;
  mediaType: string;
  /** Decoded size in bytes, derived from the base64 length. */
  bytes: number;
}>;

/**
 * Raster types only, deliberately. `image/svg+xml` is NOT here: an SVG is a
 * document (it can reference external resources and carry script), and this
 * probe admits content into an element on the page. Deny-by-default — an SVG
 * payload stays text/JSON, verbatim.
 */
const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** A full-string data: URI for an allowlisted raster type. Anchored at both
 * ends: a paragraph that merely CONTAINS a data URI is prose, not an image. */
const DATA_URI_RE = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

/**
 * Base64 openings of the four raster magic numbers — how a BARE base64
 * payload (no data: header) identifies itself. Each prefix is the base64 of
 * the format's own file signature, so a match is evidence about the decoded
 * bytes, not a guess from the tool's name.
 */
const BASE64_MAGIC: readonly (readonly [prefix: string, mediaType: string])[] = [
  ["iVBORw0KGgo", "image/png"], // \x89PNG\r\n\x1a\n
  ["/9j/", "image/jpeg"], // \xff\xd8\xff
  ["R0lGOD", "image/gif"], // GIF87a / GIF89a
  ["UklGR", "image/webp"], // RIFF
];

/** The whole string must be base64 — a magic-shaped prefix on prose is not
 * an image. */
const BASE64_BODY_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * A bare payload shorter than this is not claimed: no real image of any of
 * the four formats fits in under ~96 decoded bytes, and the floor keeps a
 * short token that happens to open like a magic number (a hash starting
 * "iVBORw0KGgo…" is astronomically unlikely, but deny-by-default costs
 * nothing here) from being dressed as a broken image.
 */
const BASE64_MIN_CHARS = 128;

/** Decoded byte count of a base64 body — exact, from length minus padding. */
function base64Bytes(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

function imageFromBase64(mediaType: string, b64: string): ImageView {
  const bytes = base64Bytes(b64);
  return {
    src: bytes <= IMAGE_MAX_BYTES ? `data:${mediaType};base64,${b64}` : null,
    mediaType,
    bytes,
  };
}

/**
 * Read an image out of a recorded output, or null. Claimed only on real
 * evidence about the VALUE (a data: URI, a magic-numbered base64 body, or an
 * explicit image record naming an allowlisted media type with base64 data)
 * — never from the tool's name.
 */
export function imageViewOf(output: unknown): ImageView | null {
  if (typeof output === "string") {
    const text = output.trim();
    const uri = DATA_URI_RE.exec(text);
    if (uri !== null) return imageFromBase64(uri[1]!, uri[2]!);
    if (text.length >= BASE64_MIN_CHARS && BASE64_BODY_RE.test(text)) {
      for (const [prefix, mediaType] of BASE64_MAGIC) {
        if (text.startsWith(prefix)) return imageFromBase64(mediaType, text);
      }
    }
    return null;
  }
  if (!isRecord(output) || Array.isArray(output)) return null;
  // The explicit image record, in the two spellings tools actually send:
  // nested (`{type:"image", source:{media_type, data}}`) and flat
  // (`{type:"image", mediaType|media_type|mimeType, data|base64}`).
  const kind = output["type"] ?? output["kind"];
  if (kind !== "image") return null;
  const source = isRecord(output["source"]) && !Array.isArray(output["source"])
    ? (output["source"] as Record<string, unknown>)
    : output;
  const mediaType = source["media_type"] ?? source["mediaType"] ?? source["mimeType"];
  const data = source["data"] ?? source["base64"];
  if (typeof mediaType !== "string" || !IMAGE_MEDIA_TYPES.has(mediaType)) return null;
  if (typeof data !== "string" || !BASE64_BODY_RE.test(data.trim()) || data.trim().length === 0) {
    return null;
  }
  return imageFromBase64(mediaType, data.trim());
}

// ── Markdown-shaped text ────────────────────────────────────────────────────

/**
 * Whether an UNCLASSIFIED string is a markdown document — the probe behind
 * the `markdown` shape.
 *
 * THE DETECTION RULE, stated because misclassification is the failure this
 * probe is shaped around: the text must contain at least TWO DISTINCT
 * block-level markdown constructs (heading · closed code fence · list of two
 * or more consecutive items · pipe table with its separator row · blockquote
 * of two or more lines). One signal alone is refused, deliberately:
 *
 *   - a `# comment` line is a heading to markdown and a comment to a shell —
 *     config dumps and script output are full of them;
 *   - one fenced pair is how logs quote code;
 *   - a lone `- ` line is a bullet to markdown and a diff marker to a patch.
 *
 * Two DIFFERENT constructs co-occurring is how a document written AS
 * markdown actually looks, and is vanishingly rare in raw output. And this
 * probe is only ever consulted for the leftover `text` shape: a command's
 * streams (the stdout-as-markdown false positive named in the design pass),
 * file content, search rows and structured data are all claimed before it —
 * their doctrine cannot be overridden by content that resembles prose.
 */
export function looksLikeMarkdown(text: string): boolean {
  const lines = text.split("\n");
  let kinds = 0;

  if (/^#{1,6}\s+\S/m.test(text)) kinds += 1;

  // A CLOSED fence — an opening ``` with no closer is a truncation artifact,
  // not a document.
  const fenceCount = lines.filter((l) => /^\s*(```|~~~)/.test(l)).length;
  if (fenceCount >= 2) kinds += 1;

  // Two or more CONSECUTIVE list items — a single stray bullet is not a list.
  let run = 0;
  let listFound = false;
  for (const l of lines) {
    if (/^\s*(?:[-*+]|\d{1,3}[.)])\s+\S/.test(l)) {
      run += 1;
      if (run >= 2) listFound = true;
    } else if (l.trim() !== "") {
      run = 0;
    }
  }
  if (listFound) kinds += 1;

  // A pipe table needs both halves: a row of cells AND the separator row.
  // The row is matched cell by cell — `[^|\n]*` between pipes — rather than
  // with a wildcard run between the first pipe and the last: a run that can
  // match anything between two anchors is a distance guess, and a cell can
  // never contain its own delimiter anyway.
  const hasPipeRow = lines.some((l) => /^\s*\|(?:[^|\n]*\|)+\s*$/.test(l));
  const hasSeparator = lines.some((l) => /^\s*\|?\s*:?-{3,}\s*(?:\|\s*:?-{3,}\s*)+\|?\s*$/.test(l));
  if (hasPipeRow && hasSeparator) kinds += 1;

  if (lines.filter((l) => /^\s*>\s+\S/.test(l)).length >= 2) kinds += 1;

  return kinds >= 2;
}

// ── Command output ──────────────────────────────────────────────────────────

export type CommandView = Readonly<{
  stdout?: string;
  stderr?: string;
  /** Only when the record carries one — never defaulted to 0. */
  exitCode?: number;
  /** The whole recorded value as text, when it was a bare string. */
  text?: string;
}>;

/** Pull the parts a command record actually carries. Absent stays absent. */
export function commandView(output: unknown): CommandView | null {
  if (typeof output === "string") return { text: output };
  if (!isRecord(output) || Array.isArray(output)) return null;
  const stdout = output["stdout"] ?? output["out"];
  const stderr = output["stderr"] ?? output["err"];
  const rawCode = output["exitCode"] ?? output["exit_code"] ?? output["code"] ?? output["status"];
  const view: {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  } = {};
  if (typeof stdout === "string") view.stdout = stdout;
  if (typeof stderr === "string") view.stderr = stderr;
  if (typeof rawCode === "number" && Number.isInteger(rawCode)) view.exitCode = rawCode;
  return view.stdout === undefined && view.stderr === undefined && view.exitCode === undefined
    ? null
    : view;
}

// ── The classifier ──────────────────────────────────────────────────────────

/**
 * Parse a recorded string as a JSON CONTAINER (an object or an array), or
 * null when it is anything else — unparseable, or a bare scalar. The tree
 * claim is made only on container shapes; see `classifyOutput`.
 */
export function parseJsonContainer(text: string): unknown | null {
  if (!text.startsWith("{") && !text.startsWith("[")) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed !== null && typeof parsed === "object") return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * The output shapes a tool may declare at registration. The manifest entry's
 * `outputShape` is the SINGLE owner of "what does this tool's output look
 * like" — the renderer reads it, never a hand-maintained set of tool names
 * (the three Set literals that lived here rotted on every new tool: a
 * file-reading tool registered tomorrow rendered as JSON until someone
 * hand-added its name). A tool whose entry declares no shape falls through
 * to the value's own structure.
 */
export type DeclaredOutputShape = "file" | "command" | "search";

export type OutputShape =
  | Readonly<{ kind: "empty" }>
  | Readonly<{
      kind: "file";
      text: string;
      /** Grammar id from the path's extension, or null (renders plain). */
      grammar: string | null;
      /** Path as the tool's own input recorded it. */
      path: string;
      /** False when the content already has a number rail of its own. */
      addLineNumbers: boolean;
    }>
  | Readonly<{ kind: "command"; view: CommandView }>
  | Readonly<{ kind: "search"; hits: readonly SearchHit[] }>
  | Readonly<{ kind: "image"; image: ImageView }>
  | Readonly<{ kind: "json"; value: unknown }>
  /** A markdown DOCUMENT (looksLikeMarkdown) — `text` is still the recorded
   * string verbatim, so the copy path and the fallback stay honest. */
  | Readonly<{ kind: "markdown"; text: string }>
  | Readonly<{ kind: "text"; text: string }>;

/** The path a file-reading tool's own input names, or null. */
export function inputPath(input: unknown): string | null {
  if (!isRecord(input) || Array.isArray(input)) return null;
  const p = input["path"] ?? input["file"] ?? input["filePath"] ?? input["filename"];
  return typeof p === "string" && p.length > 0 ? p : null;
}

/**
 * Choose a rendering shape for a tool's recorded input/output pair.
 *
 * Order matters: the tool's own NAME is consulted first (the strongest real
 * signal about what it returned), then the value's structure. Every branch
 * verifies the data before claiming the shape, so a `read_file` that failed
 * and returned an error object renders as JSON, not as fake file content.
 */
/**
 * Choose a rendering shape for a tool's recorded input/output pair.
 *
 * The tool's DECLARED shape (`declared`, from its manifest entry) is the
 * strongest signal — the registry's own answer. Every branch then verifies
 * the data before claiming the shape, so a `read_file` that failed and
 * returned an error object renders as JSON, not as fake file content.
 */
export function classifyOutput(
  input: unknown,
  output: unknown,
  declared?: DeclaredOutputShape,
): OutputShape {
  if (output === undefined || output === null || output === "") return { kind: "empty" };

  if (typeof output === "string") {
    // A command's streams are NEVER re-interpreted — stdout that happens to
    // be a lone base64 blob is still stdout, verbatim. Decided before the
    // image probe so the command doctrine cannot be overridden by content.
    if (declared === "command") return { kind: "command", view: { text: output } };
    // The image probe outranks the declared shape: a data: URI or a
    // magic-numbered base64 body IS an image — that is what the recorded
    // value is, whichever tool recorded it — and the alternative rendering
    // is a wall of base64 that tells the reader nothing.
    const image = imageViewOf(output);
    if (image !== null) return { kind: "image", image };
    if (declared === "file") {
      const path = inputPath(input);
      if (path !== null) {
        return {
          kind: "file",
          text: output,
          grammar: grammarForPath(path),
          path,
          addLineNumbers: !carriesOwnLineNumbers(output),
        };
      }
    }
    if (declared === "search") {
      const rows = parseSearchRows(output);
      if (rows !== null) return { kind: "search", hits: rows };
    }
    // A JSON STRING is structured data the transport never parsed: the
    // executor records several tools' results as JSON text (search_symbols,
    // create_artifact, edit — every tool whose entry declares no
    // `outputShape`), and dumping the recorded string into a `<pre>` shows
    // the reader a wall of quoted braces the tree exists to fold. The
    // claim is made on real evidence about the VALUE — the string parses to
    // an object or an array — and only in the leftover branch, after the
    // tool's own declared doctrine has had its claim: a command's stdout
    // that happens to be JSON stays stdout, and a file reader that read a
    // .json file stays file content. Bare scalars ("42", "true", "null")
    // are a sentence's shape, not a tree's — they stay text.
    const parsedJson = parseJsonContainer(output);
    if (parsedJson !== null) return { kind: "json", value: parsedJson };
    // Only the LEFTOVER text — everything with a stronger claim (command
    // streams above all) has already been taken, so stdout can never be
    // dressed as prose however markdown-shaped it looks.
    if (looksLikeMarkdown(output)) return { kind: "markdown", text: output };
    return { kind: "text", text: output };
  }

  if (declared === "command") {
    const view = commandView(output);
    if (view !== null) return { kind: "command", view };
  }

  if (declared === "search") {
    const direct = searchHitsFromArray(output);
    if (direct !== null) return { kind: "search", hits: direct };
    if (isRecord(output) && !Array.isArray(output)) {
      for (const key of ["results", "matches", "hits", "files"]) {
        const nested = searchHitsFromArray(output[key]);
        if (nested !== null) return { kind: "search", hits: nested };
      }
    }
  }

  // An explicit image record (`{type:"image", …}` with an allowlisted media
  // type and base64 data) — the structured spelling of the string case above.
  const image = imageViewOf(output);
  if (image !== null) return { kind: "image", image };

  return { kind: "json", value: output };
}

// ── JSON tree helpers ───────────────────────────────────────────────────────

export type JsonKind = "object" | "array" | "string" | "number" | "boolean" | "null" | "other";

export function jsonKindOf(v: unknown): JsonKind {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  switch (typeof v) {
    case "object":
      return "object";
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "other";
  }
}

/**
 * The one-line stand-in shown for a COLLAPSED container. It reports the real
 * child count and nothing else — no sampled values, no elision that could be
 * mistaken for content.
 */
export function collapsedSummary(v: unknown): string {
  if (Array.isArray(v)) {
    return v.length === 1 ? "[ 1 item ]" : `[ ${v.length.toLocaleString("en-US")} items ]`;
  }
  if (isRecord(v)) {
    const n = Object.keys(v).length;
    return n === 1 ? "{ 1 key }" : `{ ${n.toLocaleString("en-US")} keys }`;
  }
  return "";
}

/** Entries of a container, in RECORDED order (never sorted). */
export function jsonEntries(v: unknown): readonly (readonly [string, unknown])[] {
  if (Array.isArray(v)) return v.map((item, i) => [String(i), item] as const);
  if (isRecord(v)) return Object.entries(v);
  return [];
}

/* The auto-open policy lives in render-config.ts (the render layer's config
 * owner); this module only applies it. */

export function shouldAutoOpen(v: unknown, depth: number): boolean {
  if (depth >= JSON_AUTO_OPEN_DEPTH) return false;
  return jsonEntries(v).length <= JSON_AUTO_OPEN_MAX_CHILDREN;
}

/**
 * A one-line, NON-MANGLING summary of a recorded value, for a collapsed row.
 *
 * The pre-v2.1 collapsed tool line built its hint with
 * `JSON.stringify(v).replace(/[{}"]/g, "")` — which strips the very
 * characters that distinguish `{"a": "1"}` from `{"a": 1}` and turns a
 * string containing a brace into different text. That is reformatting away
 * meaning, which the honesty law forbids even in a hint.
 *
 * This builds the line from the value's OWN entries instead: keys in
 * recorded order, values summarized one level deep, containers reported by
 * their real child count. Nothing is deleted from inside a value; the line
 * is clipped at the end and the clip is visible.
 */
export function oneLineSummary(value: unknown, limit: number): string {
  const text = summarize(value, 1);
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function summarize(value: unknown, depth: number): string {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (depth <= 0) return collapsedSummary(value);
    return value.map((v) => summarize(v, depth - 1)).join(", ");
  }
  if (isRecord(value)) {
    if (depth <= 0) return collapsedSummary(value);
    return Object.entries(value)
      .map(([k, v]) => `${k}=${summarize(v, depth - 1)}`)
      .join(" ");
  }
  return String(value);
}

/** Fold a long string, reporting the exact remainder (never "…"). */
export function foldString(s: string, cap: number): Readonly<{ shown: string; hidden: number }> {
  if (s.length <= cap) return { shown: s, hidden: 0 };
  return { shown: s.slice(0, cap), hidden: s.length - cap };
}

/** Serialize a value for the copy button — the recorded value, verbatim. */
export function toCopyText(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

/**
 * A MEASURED duration, in the words a reader uses.
 *
 * ONE OWNER for a formatting rule three flow components were each stating
 * for themselves (ToolBeat's head, ActBeat's latency, and now the compressed
 * tool row, which must print the SAME duration the open card prints — a
 * "120ms" that became "0.1s" when the beat compressed would read as a
 * different measurement of the same call).
 *
 * Sub-second reads in whole milliseconds; a second or more reads in seconds
 * to one decimal. Nothing is rounded away that changes the answer.
 */
export function fmtDurationMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
