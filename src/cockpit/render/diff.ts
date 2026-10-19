/**
 * COCKPIT RENDER — unified diff → structure (pure, Node-testable).
 *
 * Input is the REAL patch text from the existing `/api/git/diff-patch` route.
 * Nothing here synthesizes a hunk, a line number, or a path: every number
 * this module reports is either read out of the patch's own `@@` header or
 * counted by walking the patch's own lines. A patch that carries no `@@`
 * header produces no hunks (and the caller renders honest absence) rather
 * than a guessed single hunk starting at line 1.
 *
 * LINE NUMBERS. A unified hunk header `@@ -a,b +c,d @@` states where the
 * hunk sits in each side. We walk the hunk body advancing the old counter on
 * context/deletion and the new counter on context/addition — the standard,
 * exact correspondence. When the header is malformed the hunk still renders,
 * with line numbers ABSENT (undefined), never invented.
 *
 * INTRA-LINE EMPHASIS. For a deletion paired with an addition we compute the
 * common prefix and common suffix — a real, cheap measurement (O(len), no
 * edit-distance matrix). The differing middle is marked. When the two lines
 * share almost nothing, no segments are emitted and the whole line reads as
 * changed: emphasis is only claimed where commonality genuinely exists.
 *
 * LAYOUT DECISION (documented once, applied everywhere): diffs and code
 * scroll HORIZONTALLY, they do not wrap. A diff's meaning is columnar — the
 * +/- gutter, the line-number rail, and indentation alignment all encode
 * structure, and soft-wrapping silently destroys the correspondence between
 * a visual row and a source line. Prose and command output wrap (there the
 * column carries no meaning). See tokens.css --diff-* / --code-*.
 */

import { highlight, type TokenKind } from "./highlight.ts";

export type DiffLineKind = "add" | "del" | "context" | "meta" | "marker";

/** One intra-line run. `changed` marks the differing middle. */
export type DiffSeg = Readonly<{ changed: boolean; text: string }>;

export type DiffLine = Readonly<{
  kind: DiffLineKind;
  /** Content with the leading +/-/space marker removed (meta keeps its text). */
  text: string;
  /** 1-based line number on the old side, or undefined when not applicable. */
  oldNo?: number;
  /** 1-based line number on the new side, or undefined when not applicable. */
  newNo?: number;
  /** Intra-line runs, present only when a real prefix/suffix overlap was found. */
  segs?: readonly DiffSeg[];
}>;

export type DiffHunk = Readonly<{
  /** The `@@ ... @@` line exactly as recorded. */
  header: string;
  /** The trailing section hint some patches carry after the second `@@`. */
  section: string;
  oldStart?: number;
  newStart?: number;
  lines: readonly DiffLine[];
}>;

export type DiffFile = Readonly<{
  /** Path as the patch states it, or undefined when the patch never names one. */
  path?: string;
  /** `diff --git`, `index`, `new file mode`… lines, verbatim. */
  meta: readonly string[];
  hunks: readonly DiffHunk[];
}>;

export type ParsedDiff = Readonly<{
  files: readonly DiffFile[];
  added: number;
  removed: number;
  /** Total renderable body lines across every hunk (for fold arithmetic). */
  lineCount: number;
  /** True when the text carried no `@@` hunk header at all. */
  empty: boolean;
}>;

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/**
 * Two lines whose common prefix+suffix covers less than this fraction of the
 * longer line are treated as wholly different — below it, "emphasis" would
 * be noise (a coincidental shared brace) rather than a real correspondence.
 */
const MIN_INTRALINE_OVERLAP = 0.25;

function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}

function commonSuffixLen(a: string, b: string, floor: number): number {
  const n = Math.min(a.length, b.length) - floor;
  let i = 0;
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
  return i;
}

/**
 * Segment a changed pair. Returns undefined when the overlap is too small to
 * mean anything — the caller then renders the line uniformly changed.
 */
export function intralineSegs(
  oldText: string,
  newText: string,
): Readonly<{ del?: readonly DiffSeg[]; add?: readonly DiffSeg[] }> {
  if (oldText === newText) return {};
  const pre = commonPrefixLen(oldText, newText);
  const suf = commonSuffixLen(oldText, newText, pre);
  const longer = Math.max(oldText.length, newText.length);
  if (longer === 0) return {};
  if ((pre + suf) / longer < MIN_INTRALINE_OVERLAP) return {};

  const build = (s: string): readonly DiffSeg[] => {
    const mid = s.slice(pre, s.length - suf);
    const out: DiffSeg[] = [];
    if (pre > 0) out.push({ changed: false, text: s.slice(0, pre) });
    if (mid.length > 0) out.push({ changed: true, text: mid });
    if (suf > 0) out.push({ changed: false, text: s.slice(s.length - suf) });
    return out;
  };
  return { del: build(oldText), add: build(newText) };
}

/**
 * Walk a hunk's finished lines and attach intra-line segments to each
 * deletion/addition pair (the k-th deletion of a run against the k-th
 * addition of the run that immediately follows it).
 */
function pairRuns(lines: DiffLine[]): void {
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.kind !== "del") {
      i += 1;
      continue;
    }
    let d = i;
    while (d < lines.length && lines[d]!.kind === "del") d += 1;
    let a = d;
    while (a < lines.length && lines[a]!.kind === "add") a += 1;
    const dels = d - i;
    const adds = a - d;
    const pairs = Math.min(dels, adds);
    for (let k = 0; k < pairs; k += 1) {
      const delLine = lines[i + k]!;
      const addLine = lines[d + k]!;
      const segs = intralineSegs(delLine.text, addLine.text);
      if (segs.del !== undefined) lines[i + k] = { ...delLine, segs: segs.del };
      if (segs.add !== undefined) lines[d + k] = { ...addLine, segs: segs.add };
    }
    i = a > i ? a : i + 1;
  }
}

/** Parse a unified patch. Never throws; unparseable text yields no hunks. */
export function parseUnifiedDiff(patch: string): ParsedDiff {
  const files: DiffFile[] = [];
  let added = 0;
  let removed = 0;
  let lineCount = 0;

  let curFile: { path?: string; meta: string[]; hunks: DiffHunk[] } | null = null;
  let curHunk: { header: string; section: string; oldStart?: number; newStart?: number; lines: DiffLine[] } | null =
    null;
  let oldNo = 0;
  let newNo = 0;
  let numbered = false;

  const closeHunk = (): void => {
    if (curHunk === null) return;
    pairRuns(curHunk.lines);
    curFile!.hunks.push({
      header: curHunk.header,
      section: curHunk.section,
      ...(curHunk.oldStart === undefined ? {} : { oldStart: curHunk.oldStart }),
      ...(curHunk.newStart === undefined ? {} : { newStart: curHunk.newStart }),
      lines: curHunk.lines,
    });
    curHunk = null;
  };
  const closeFile = (): void => {
    closeHunk();
    if (curFile === null) return;
    files.push({
      ...(curFile.path === undefined ? {} : { path: curFile.path }),
      meta: curFile.meta,
      hunks: curFile.hunks,
    });
    curFile = null;
  };
  const ensureFile = (): void => {
    if (curFile === null) curFile = { meta: [], hunks: [] };
  };

  // A trailing newline produces a final empty element; it is not a diff line.
  const raw = patch.split("\n");
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();

  for (const line of raw) {
    if (line.startsWith("diff --git ")) {
      closeFile();
      ensureFile();
      curFile!.meta.push(line);
      // `diff --git a/x b/x` — take the b-side path, the post-change name.
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m !== null) curFile!.path = m[2]!;
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      ensureFile();
      closeHunk();
      curFile!.meta.push(line);
      if (line.startsWith("+++ ") && curFile!.path === undefined) {
        const p = line.slice(4).trim();
        if (p !== "/dev/null") curFile!.path = p.replace(/^b\//, "");
      }
      continue;
    }
    const hm = HUNK_RE.exec(line);
    if (hm !== null) {
      ensureFile();
      closeHunk();
      const os = Number(hm[1]);
      const ns = Number(hm[3]);
      numbered = Number.isFinite(os) && Number.isFinite(ns);
      oldNo = os;
      newNo = ns;
      curHunk = {
        header: line,
        section: hm[5] ?? "",
        ...(numbered ? { oldStart: os, newStart: ns } : {}),
        lines: [],
      };
      continue;
    }
    if (curHunk === null) {
      // Outside any hunk: index/mode/similarity lines and the like.
      if (line.length > 0) {
        ensureFile();
        curFile!.meta.push(line);
      }
      continue;
    }
    // Inside a hunk body.
    if (line.startsWith("\\")) {
      // "\ No newline at end of file" — a real marker, not a content line.
      curHunk.lines.push({ kind: "marker", text: line });
      lineCount += 1;
      continue;
    }
    const marker = line[0] ?? " ";
    const text = line.slice(1);
    if (marker === "+") {
      added += 1;
      lineCount += 1;
      curHunk.lines.push({ kind: "add", text, ...(numbered ? { newNo } : {}) });
      newNo += 1;
      continue;
    }
    if (marker === "-") {
      removed += 1;
      lineCount += 1;
      curHunk.lines.push({ kind: "del", text, ...(numbered ? { oldNo } : {}) });
      oldNo += 1;
      continue;
    }
    // Context (leading space, or a bare empty line inside a hunk).
    lineCount += 1;
    curHunk.lines.push({
      kind: "context",
      text,
      ...(numbered ? { oldNo, newNo } : {}),
    });
    oldNo += 1;
    newNo += 1;
  }
  closeFile();

  return { files, added, removed, lineCount, empty: lineCount === 0 };
}

// ── Painting a diff line: syntax colour AND change emphasis together ────────

/**
 * One renderable run of a diff line: a syntax role plus whether it sits
 * inside the intra-line change. The two signals are ORTHOGONAL — colour says
 * "this is a string literal", the wash says "this part is what changed" —
 * so rendering them as one flat list of runs lets a reader see both at once
 * instead of the renderer having to pick a winner.
 */
export type DiffPiece = Readonly<{ kind: TokenKind; changed: boolean; text: string }>;

/**
 * Tokenize a diff line and overlay its intra-line segments.
 *
 * Diff lines are highlighted INDIVIDUALLY (a diff shows lines out of their
 * surrounding context by definition, so there is no multi-line state to
 * carry). `lang` empty, or a language with no grammar, yields a single plain
 * run — which is what the caller should render when it cannot honestly name
 * the file's language.
 */
export function paintDiffLine(
  text: string,
  lang: string,
  segs?: readonly DiffSeg[],
): readonly DiffPiece[] {
  const hl = highlight(text, lang);
  const tokens = hl.lines[0] ?? [];
  const flat: DiffPiece[] =
    tokens.length > 0
      ? tokens.map((t) => ({ kind: t.kind, changed: false, text: t.text }))
      : text.length > 0
        ? [{ kind: "plain" as TokenKind, changed: false, text }]
        : [];
  if (segs === undefined || segs.length === 0) return flat;

  // Walk both partitions of the SAME string in lockstep, cutting at whichever
  // boundary comes first. Both cover [0, text.length), so the result is a
  // partition too — no character is added, dropped, or reordered.
  const out: DiffPiece[] = [];
  let ti = 0;
  let tOff = 0;
  let si = 0;
  let sOff = 0;
  while (ti < flat.length && si < segs.length) {
    const tok = flat[ti]!;
    const seg = segs[si]!;
    const tRemain = tok.text.length - tOff;
    const sRemain = seg.text.length - sOff;
    const take = Math.min(tRemain, sRemain);
    if (take > 0) {
      out.push({ kind: tok.kind, changed: seg.changed, text: tok.text.slice(tOff, tOff + take) });
    }
    tOff += take;
    sOff += take;
    if (tOff >= tok.text.length) {
      ti += 1;
      tOff = 0;
    }
    if (sOff >= seg.text.length) {
      si += 1;
      sOff = 0;
    }
  }
  return out.length > 0 ? out : flat;
}

/**
 * The first hunk of the first file, as a ParsedDiff — the micro-diff preview
 * (§3.2). Returns the same shape so one renderer serves both the preview and
 * the full sheet. `capped` reports how many body lines were left out, so the
 * caller can name the remainder instead of truncating silently.
 */
export function firstHunkOf(
  parsed: ParsedDiff,
  maxLines: number,
): Readonly<{ preview: ParsedDiff; hidden: number }> {
  const file = parsed.files.find((f) => f.hunks.length > 0);
  if (file === undefined) return { preview: parsed, hidden: 0 };
  const hunk = file.hunks[0]!;
  const shown = hunk.lines.slice(0, maxLines);
  const hiddenInHunk = hunk.lines.length - shown.length;
  const restLines = parsed.lineCount - hunk.lines.length;
  const previewHunk: DiffHunk = { ...hunk, lines: shown };
  let added = 0;
  let removed = 0;
  for (const l of shown) {
    if (l.kind === "add") added += 1;
    else if (l.kind === "del") removed += 1;
  }
  return {
    preview: {
      files: [{ ...file, hunks: [previewHunk] }],
      added,
      removed,
      lineCount: shown.length,
      empty: shown.length === 0,
    },
    hidden: hiddenInHunk + restLines,
  };
}

/**
 * THE patch summary — ± counted and the first hunk NAMED, from the one
 * parser that also renders the patch.
 *
 * Two callers used to answer "how many lines changed in this patch?"
 * independently: the flow's effect beat wrapped `parseUnifiedDiff` in a
 * private helper, and the custody room's `countPatch` scanned the raw text
 * for leading `+`/`-`. Two implementations of one measurement is exactly the
 * drift a header number and the lines on screen must never have, and the
 * text scan is the weaker of the two — it has to special-case `+++`/`---`
 * by hand and cannot tell a hunk body from a file header. Counting is
 * therefore owned HERE, next to the parse it is derived from, and the beat
 * and the sheet report the same numbers because they call the same function.
 *
 * `firstHunk` is the first hunk's own `@@` header, or "" when the patch
 * carries no readable hunk — never a guessed one.
 */
export function summarizePatch(
  patch: string,
  previewLines: number,
): Readonly<{ added: number; removed: number; firstHunk: string }> {
  const parsed = parseUnifiedDiff(patch);
  const { preview } = firstHunkOf(parsed, previewLines);
  const firstFile = preview.files[0];
  const firstHunkLines = firstFile?.hunks[0]?.lines ?? [];
  return Object.freeze({
    added: parsed.added,
    removed: parsed.removed,
    firstHunk: firstHunkLines.length > 0 ? firstFile!.hunks[0]!.header : "",
  });
}
