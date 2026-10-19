/**
 * WHAT A FILE IS, AND WHAT THE ROOM MAY HONESTLY SAY ABOUT IT.
 *
 * Pure — no fetching, no DOM, no stores — so every sentence the room shows
 * about a file is decided by a function a Node test can drive directly.
 *
 * The rule this module exists to keep: THE ROOM NEVER GUESSES. Whether a file
 * is text is measured by the server (it sniffs the bytes; see
 * `server/editor-bridge.ts::probeFile`) and arrives on the wire. What is
 * decided here is only what FOLLOWS from that measurement — which views are
 * offered, and what the absence states say — and every one of those sentences
 * quotes the measured number rather than an adjective.
 */

import { LARGE_FILE_BYTES } from "./editor-config.ts";

// ── The probe wire (server/routes/editor.ts::/api/editor/probe) ───────────

export type FileProbe = Readonly<{
  abs: string;
  relativePath: string;
  kind: "file" | "directory" | "absent";
  size: number;
  text: boolean;
  binaryReason: string | null;
  mediaType: string | null;
  language: string;
  maxReadBytes: number;
  maxEditBytes: number;
}>;

/** Decode a probe payload, or `null` when the shape is not honest. A
 * partially-guessed object would be fabricated data about a real file. */
export function decodeProbe(wire: unknown): FileProbe | null {
  if (wire === null || typeof wire !== "object") return null;
  const p = wire as Record<string, unknown>;
  if (typeof p.abs !== "string" || typeof p.relativePath !== "string") return null;
  if (p.kind !== "file" && p.kind !== "directory" && p.kind !== "absent") return null;
  if (typeof p.size !== "number" || typeof p.text !== "boolean") return null;
  if (typeof p.language !== "string") return null;
  if (typeof p.maxReadBytes !== "number" || typeof p.maxEditBytes !== "number") return null;
  if (p.binaryReason !== null && typeof p.binaryReason !== "string") return null;
  if (p.mediaType !== null && typeof p.mediaType !== "string") return null;
  return wire as FileProbe;
}

export type MediaWire = Readonly<{
  path: string;
  mediaType: string;
  size: number;
  dataUrl: string;
}>;

/** Decode a media payload. A `dataUrl` that is not a data URL is refused —
 * an image element handed anything else would go out to the network. */
export function decodeMedia(wire: unknown): MediaWire | null {
  if (wire === null || typeof wire !== "object") return null;
  const m = wire as Record<string, unknown>;
  if (typeof m.path !== "string" || typeof m.mediaType !== "string") return null;
  if (typeof m.size !== "number" || typeof m.dataUrl !== "string") return null;
  if (!m.dataUrl.startsWith("data:")) return null;
  return wire as MediaWire;
}

// ── What the pane can show ────────────────────────────────────────────────

/**
 * The rendered form of a file — "as it is meant to be seen" — or `none` when
 * there is no such form and the room must not pretend there is.
 */
export type RenderMode = "markdown" | "page" | "image" | "diff" | "none";

/**
 * Which of the pane's three views is on screen.
 *
 * `rendered` is only reachable when `renderModeFor` says this file HAS a
 * rendered form; `edit` only when `isEditable` says it can actually be saved.
 * The pane never shows a control for a view a file does not have.
 */
export type PaneMode = "rendered" | "source" | "edit";

const MARKDOWN_EXT = new Set([".md", ".markdown", ".mdown", ".mkd"]);
const PAGE_EXT = new Set([".html", ".htm"]);
const DIFF_EXT = new Set([".diff", ".patch"]);

/** The lowercase extension of a path, including the dot (`""` when none). */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/** The file's own name — the word a delete confirmation has to be given. */
export function baseNameOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut === -1 ? path : path.slice(cut + 1);
}

/**
 * Which rendered form this file has, from the probe alone.
 *
 * An IMAGE is decided by the server's declared media type (an extension
 * allowlist there), never by us: the one place that decision is made is the
 * place that will actually hand back the bytes.
 */
export function renderModeFor(probe: FileProbe): RenderMode {
  if (probe.kind !== "file") return "none";
  if (probe.mediaType !== null) return "image";
  if (!probe.text) return "none";
  const ext = extensionOf(probe.relativePath);
  if (MARKDOWN_EXT.has(ext)) return "markdown";
  if (PAGE_EXT.has(ext)) return "page";
  if (DIFF_EXT.has(ext)) return "diff";
  return "none";
}

/** Plain words for a rendered form, for the control that switches to it. */
export function renderModeLabel(mode: RenderMode): string {
  switch (mode) {
    case "markdown":
      return "as a document";
    case "page":
      return "as a page";
    case "image":
      return "as an image";
    case "diff":
      return "as a change";
    case "none":
      return "";
  }
}

/** What switching to the rendered form will do, in plain words. */
export function renderModeExplanation(mode: RenderMode): string {
  switch (mode) {
    case "markdown":
      return "Shows this file's markdown formatted, instead of its characters.";
    case "page":
      return "Runs this page inside a sealed frame that cannot reach this page, your session, or the network.";
    case "image":
      return "Shows the picture these bytes hold, at its own size.";
    case "diff":
      return "Shows this patch the way a change is read: added and removed lines, with their line numbers.";
    case "none":
      return "";
  }
}

// ── Measured sentences (every one quotes its number) ──────────────────────

const UNITS = ["bytes", "KB", "MB", "GB"] as const;

/**
 * A byte count in the largest unit that keeps it under 1024, one decimal.
 *
 * NOT the old tree's `formatBytes`, and deliberately not named like it.
 * The cockpit may not import the old tree (that helper left at the
 * cutover), and the old helper
 * answers `"—"` for an unmeasured size — a dash is not plain words, and this
 * room's absences have to be sentences. Two different contracts, so two
 * functions with two names rather than one name meaning two things.
 */
export function fileSizeText(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "an unmeasured size";
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = unit === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${shown} ${UNITS[unit]}`;
}

/** Whether opening this file is a big enough act to be asked for separately. */
export function isLargeRead(probe: FileProbe): boolean {
  return probe.kind === "file" && probe.size > LARGE_FILE_BYTES;
}

/**
 * What the room says before it reads a large file: the measured size, the
 * threshold it crossed, and what pressing the verb will actually do.
 */
export function largeReadSentence(probe: FileProbe): string {
  const capped = probe.size > probe.maxReadBytes;
  const head = `this file is ${fileSizeText(probe.size)}, past the ${fileSizeText(LARGE_FILE_BYTES)} this room opens on a click`;
  if (capped) {
    return `${head} — opening it will load the first ${fileSizeText(probe.maxReadBytes)} and say so; the rest is not sent`;
  }
  return `${head} — opening it will load all of it, which may take a moment`;
}

/** What the room says instead of rendering bytes it cannot read as text. */
export function binarySentence(probe: FileProbe): string {
  const why = probe.binaryReason ?? "these bytes are not text";
  return `this file is not text — ${why}. It is ${fileSizeText(probe.size)} on disk.`;
}

/** What the room says when a file is past the WRITE cap, so `edit` is honestly
 * refused rather than offered and then rejected by the server. */
export function tooLargeToEditSentence(probe: FileProbe): string {
  return `this file is ${fileSizeText(probe.size)}, past the ${fileSizeText(probe.maxEditBytes)} this server accepts in one write — it can be read here but not saved from here`;
}

/**
 * Whether the server will send only the FIRST part of this file's text.
 *
 * The read route truncates at `maxReadBytes` and says so on the wire. The
 * probe carries the same number, so the room can know this BEFORE it reads —
 * which is what lets it decide about `edit` at the same moment it decides
 * about every other view.
 */
export function isPartialRead(probe: FileProbe): boolean {
  return probe.kind === "file" && probe.text && probe.size > probe.maxReadBytes;
}

/**
 * What the room says when it can only ever hold PART of a file.
 *
 * The two caps are independent numbers on this server (a 1 MiB read cap and a
 * 10 MiB write cap by default), so a file can sit between them: readable only
 * in part, and — until this — offered an `edit` control anyway. Pressing save
 * on that draft sends the truncated prefix as its preimage, the server compares
 * it against the whole file, and the write is refused. The user's work was
 * never at risk (the preimage check is what refuses it) but the room had
 * offered a capability it could not deliver, which is the same defect as an
 * empty box: a promise with nothing behind it.
 */
export function partialReadSentence(probe: FileProbe): string {
  return `this file is ${fileSizeText(probe.size)} and this server sends at most ${fileSizeText(probe.maxReadBytes)} of it, so what is shown here is the FIRST PART and not the file — it can be read here but not edited, because a save would offer this part in place of the whole`;
}

/** Whether the room may offer `edit` at all. */
export function isEditable(probe: FileProbe): boolean {
  return (
    probe.kind === "file" &&
    probe.text &&
    probe.size <= probe.maxEditBytes &&
    !isPartialRead(probe)
  );
}

/**
 * WHY `edit` IS NOT THERE, or `null` when it is.
 *
 * One function so the control and its explanation can never disagree: the
 * pane asks this exactly where it would otherwise have to re-derive which of
 * the two caps was crossed, and a sentence quoting the wrong cap is a measured
 * number stated about the wrong thing.
 */
export function notEditableSentence(probe: FileProbe): string | null {
  if (probe.kind !== "file" || !probe.text) return null;
  if (isEditable(probe)) return null;
  if (isPartialRead(probe)) return partialReadSentence(probe);
  return tooLargeToEditSentence(probe);
}

// ── What a sealed frame will not fetch ────────────────────────────────────

/**
 * Every address this page asks the browser to fetch — `src=` and `href=`
 * values that are not already inline.
 *
 * This exists because of what the frame's policy actually is. The shared CSP
 * owner (`src/cockpit/render/html-preview.ts::CSP_META`) sets
 * `default-src 'unsafe-inline' 'unsafe-eval' data: blob:` and
 * `connect-src 'none'` — so inline script and style RUN, and every reference
 * to a file beside this one, relative or absolute, is refused. A stylesheet
 * and a script are exactly what an `.html` file on a disk is made of, so a
 * page that looks complete in a browser can render as a blank rectangle here,
 * and the blankness is CORRECT rather than broken. Saying which files were
 * refused is the difference between those two readings.
 *
 * A fragment (`#top`), `data:`, `blob:`, `about:` and `javascript:` are not
 * fetches and are not counted. Duplicates collapse: the fact is how many
 * distinct files the page wants, not how many times it names them.
 */
export function externalReferences(html: string): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const attr = /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const m of html.matchAll(attr)) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (raw.length === 0) continue;
    if (raw.startsWith("#")) continue;
    if (/^(?:data|blob|about|javascript|mailto|tel):/i.test(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/** How many references are named before the sentence stops listing them. */
const REFS_NAMED = 3;

/**
 * What the room says about the files a page asks for and will not get. Empty
 * when the page asks for none — a page that is genuinely self-contained gets
 * no warning about a problem it does not have.
 */
export function sealedFrameSentence(refs: readonly string[]): string {
  if (refs.length === 0) return "";
  const named = refs.slice(0, REFS_NAMED).join(", ");
  const rest = refs.length - REFS_NAMED;
  const more = rest > 0 ? `, and ${rest} more` : "";
  const count = refs.length === 1 ? "1 file" : `${refs.length} files`;
  return `this page asks for ${count} beside it (${named}${more}) and the sealed frame fetches none of them — what you see below is this page WITHOUT them, which is not what it looks like on disk`;
}
