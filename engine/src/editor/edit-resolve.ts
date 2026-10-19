/**
 * String-preimage → byte-range resolver for the single `edit` tool.
 *
 * The model-facing tool expresses every edit as `(path, oldString, newString)`:
 * a string preimage, not a preimage hash and not byte offsets (a weak model can
 * produce a copied string reliably; it cannot compute a SHA-256 or count UTF-8
 * bytes). This module turns that preimage into the byte range the transactional
 * editor's `replaceRange` operation needs, computing the preimage hash itself.
 *
 * The resolution is a deterministic heal cascade, cheapest first, each level
 * strict-about-uniqueness so a drifted copy never edits the wrong spot:
 *
 *   1. exact        — the preimage occurs exactly once, verbatim.
 *   2. whitespace   — whitespace-run collapsed equality (CRLF/indent drift).
 *   3. escape-repair — a raw control char the model emitted where the file
 *                      spells an escape (`\n` inside a string literal).
 *   4. fuzzy        — nearest region by edit distance, when the drift is small.
 *
 * Every level verifies the recovered span occurs EXACTLY ONCE before accepting
 * it, and a token-boundary guard refuses a whitespace/fuzzy match that would
 * splice into the middle of an identifier. A miss at every level is a
 * structured refusal with an actionable detail string, never a wrong guess.
 *
 * This is the ONE owner of string-preimage resolution. `whitespaceEquivalent`
 * (the whitespace-collapse primitive) lives in `edit-operations.ts`; the edit
 * distance lives in the safety layer's `levenshtein`; both are imported, never
 * re-implemented here.
 */

import { InputError } from "../kernel/errors.ts";
import { whitespaceEquivalent } from "./edit-operations.ts";
import { levenshtein } from "../safety/hallucination-detector.ts";

/** How a resolution succeeded — the heal level that fired. */
export type ResolveStrategy = "exact" | "whitespace" | "escape" | "fuzzy";

export type ResolvedRange = Readonly<{
  /** UTF-8 byte offset of the matched span's start. */
  startByte: number;
  /** UTF-8 byte offset of the matched span's end (exclusive). */
  endByte: number;
  /** Which cascade level produced the match. */
  strategy: ResolveStrategy;
  /** The file's actual matched text (the healed preimage). */
  matchedText: string;
}>;

export type ResolveFailure = Readonly<{
  ok: false;
  reason:
    | "old_content_not_found"
    | "old_content_ambiguous_exact"
    | "old_content_ambiguous_fuzzy";
  /** Actionable, plain-language detail for the model's retry. */
  detail: string;
}>;

export type ResolveSuccess = Readonly<{ ok: true; }> & ResolvedRange;
export type ResolveResult = ResolveSuccess | ResolveFailure;

/** Tunables for the resolver (sourced from the `editor` config section). */
export type ResolveOptions = Readonly<{
  /** Whether a drifted preimage auto-heals (whitespace/escape/fuzzy) at all. */
  healCascadeEnabled?: boolean;
  /** Fuzzy acceptance: max edit distance as a fraction of the compared window. */
  fuzzyThreshold?: number;
}>;

/** The whole-file sentinels the model may pass as `oldString`. */
const WHOLE_FILE_SENTINELS: ReadonlySet<string> = new Set(["<all>", "*", "<entire-file>"]);

/** `true` when `oldString` is an explicit whole-file sentinel. */
export function isWholeFileSentinel(oldString: unknown): boolean {
  return typeof oldString === "string" && WHOLE_FILE_SENTINELS.has(oldString.trim());
}

/**
 * Resolve `oldString` to a byte range in `content`. Pure — never touches the
 * filesystem. Returns a structured refusal when the preimage is absent,
 * ambiguous, or only fuzzily matchable beyond the acceptance threshold.
 */
export function resolvePreimageToRange(
  content: string,
  oldString: string,
  options?: ResolveOptions,
): ResolveResult {
  if (typeof oldString !== "string" || oldString.length === 0) {
    throw new InputError("oldString must be a non-empty string", "edit_resolve_oldstring_empty");
  }

  // 1. EXACT — verbatim, exactly once.
  const first = content.indexOf(oldString);
  if (first !== -1) {
    const second = content.indexOf(oldString, first + 1);
    if (second !== -1) {
      return {
        ok: false,
        reason: "old_content_ambiguous_exact",
        detail:
          `oldString matched MORE THAN ONCE (at chars ${first} and ${second}). Widen it: include the unique surrounding lines ` +
          `(e.g. the function signature above it) so it matches only the place you mean.`,
      };
    }
    return success(content, first, first + oldString.length, "exact");
  }

  if (options?.healCascadeEnabled === false) {
    return notFound(oldString);
  }

  // 2. WHITESPACE — collapse all whitespace runs; recover the file's real span.
  const ws = healWhitespace(content, oldString);
  if (ws.ok) return ws;

  // 3. ESCAPE-REPAIR — a raw control char where the file spells an escape.
  const esc = healEscapeDrift(content, oldString);
  if (esc.ok) return esc;

  // 4. FUZZY — nearest region by edit distance within the acceptance threshold.
  const fz = healFuzzy(content, oldString, options?.fuzzyThreshold);
  if (fz.ok) return fz;

  return notFound(oldString);
}

function success(content: string, startChar: number, endChar: number, strategy: ResolveStrategy): ResolveSuccess {
  return {
    ok: true,
    startByte: Buffer.byteLength(content.slice(0, startChar), "utf8"),
    endByte: Buffer.byteLength(content.slice(0, endChar), "utf8"),
    strategy,
    matchedText: content.slice(startChar, endChar),
  };
}

function notFound(oldString: string): ResolveFailure {
  return {
    ok: false,
    reason: "old_content_not_found",
    detail:
      `oldString was not found verbatim in the file. Re-check the exact text: copy it character-for-character, ` +
      `including indentation and newlines. If the content drifted, re-read the file. ` +
      `The file's opening is: ${JSON.stringify(oldString.slice(0, 80))}`,
  };
}

// ── Level 2: whitespace-normalized match ──

function strictNorm(s: string): string {
  return s.replace(/\s+/g, "");
}

function healWhitespace(content: string, oldString: string): ResolveResult {
  const strictOld = strictNorm(oldString);
  if (strictOld.length === 0) return { ok: false, reason: "old_content_not_found", detail: "oldString is all whitespace" };
  const strictFile = strictNorm(content);
  const strictIdx = strictFile.indexOf(strictOld);
  if (strictIdx === -1) return { ok: false, reason: "old_content_not_found", detail: "" };
  if (strictFile.indexOf(strictOld, strictIdx + 1) !== -1) {
    return { ok: false, reason: "old_content_ambiguous_exact", detail: "oldString matched more than once after whitespace normalization; widen it with unique surrounding lines" };
  }
  const actual = recoverWhitespaceRemoved(content, strictFile, strictIdx, strictOld.length);
  if (actual === null) return { ok: false, reason: "old_content_not_found", detail: "" };
  if (crossesTokenBoundary(content, actual, oldString)) {
    return { ok: false, reason: "old_content_not_found", detail: "the whitespace-normalized match lands inside a token; refusing to avoid a corrupt edit" };
  }
  const start = content.indexOf(actual);
  if (start === -1 || content.indexOf(actual, start + 1) !== -1) {
    return { ok: false, reason: "old_content_not_found", detail: "" };
  }
  return success(content, start, start + actual.length, "whitespace");
}

// ── Level 3: escape-drift repair ──

const ESCAPE_FOR: Readonly<Record<string, string>> = { "\n": "\\n", "\t": "\\t", "\r": "\\r" };

/**
 * Repair raw control chars inside a string the model produced from a JSON
 * round-trip of escaped source. A raw newline/tab/CR inside a non-template
 * string literal is re-escaped (a real line break is left alone). Conservative:
 * it never invents escapes, only re-escapes a raw control char that breaks a
 * string literal. Returns `{ repaired, changed }`.
 */
export function repairEscapeDrift(text: string): Readonly<{ repaired: string; changed: boolean }> {
  if (typeof text !== "string" || text.length === 0) return { repaired: text, changed: false };
  let out = "";
  let changed = false;
  let inStr: string | null = null;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (inStr === null) {
      if (c === '"' || c === "'" || c === "`") { inStr = c; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (c === "\\") { out += c + (text[i + 1] ?? ""); i += 2; continue; }
    if (c === inStr) { inStr = null; out += c; i++; continue; }
    if ((c === "\n" || c === "\r" || c === "\t") && inStr !== "`") {
      out += ESCAPE_FOR[c]!;
      changed = true;
      i++;
      continue;
    }
    out += c; i++;
  }
  return { repaired: changed ? out : text, changed };
}

function healEscapeDrift(content: string, oldString: string): ResolveResult {
  const rep = repairEscapeDrift(oldString);
  if (!rep.changed) return { ok: false, reason: "old_content_not_found", detail: "" };
  const idx = content.indexOf(rep.repaired);
  if (idx === -1) return { ok: false, reason: "old_content_not_found", detail: "" };
  if (content.indexOf(rep.repaired, idx + 1) !== -1) {
    return { ok: false, reason: "old_content_ambiguous_exact", detail: "the escape-repaired oldString matched more than once; widen it with unique surrounding lines" };
  }
  return success(content, idx, idx + rep.repaired.length, "escape");
}

// ── Level 4: fuzzy match by edit distance ──

const IDENT_CHAR = /[A-Za-z0-9_$]/;

function healFuzzy(content: string, oldString: string, fuzzyThreshold?: number): ResolveResult {
  const fileLen = content.length;
  const oldLen = oldString.length;
  if (oldLen === 0 || fileLen === 0) return { ok: false, reason: "old_content_not_found", detail: "" };
  const shorterThanFile = fileLen < oldLen;
  const windowLen = shorterThanFile ? fileLen : oldLen;
  // Acceptance: distance must be a small fraction of the compared window. The
  // configurable `fuzzyThreshold` (0..1) scales it; absent, a quarter of the
  // window (generous — real drift is < 10%, this only rejects near-total
  // mismatch).
  const ratio = fuzzyThreshold !== undefined && fuzzyThreshold > 0 ? fuzzyThreshold : 0.25;
  const cap = Math.max(2, Math.floor(windowLen * ratio));

  // Anchor on the first line (or its longest shared identifier token) to avoid
  // a coarse full-file scan that locks onto a wrong-but-similar region.
  const firstLineEnd = oldString.indexOf("\n");
  const firstLine = firstLineEnd === -1 ? oldString : oldString.slice(0, firstLineEnd);
  const firstLineTrim = firstLine.trim();
  const candidates: number[] = [];
  if (firstLineTrim.length >= 6) {
    let searchFrom = 0;
    while (candidates.length < 50) {
      const idx = content.indexOf(firstLineTrim, searchFrom);
      if (idx === -1) break;
      candidates.push(idx - (firstLine.length - firstLine.trimStart().length));
      searchFrom = idx + 1;
    }
  }
  if (candidates.length === 0) {
    const token = longestSharedToken(firstLineTrim, content);
    if (token !== null) {
      let searchFrom = 0;
      while (candidates.length < 50) {
        const idx = content.indexOf(token, searchFrom);
        if (idx === -1) break;
        candidates.push(Math.max(0, idx - firstLineTrim.indexOf(token)));
        searchFrom = idx + 1;
      }
    }
  }
  if (candidates.length === 0) {
    const range = fileLen - windowLen;
    if (range < 0) return { ok: false, reason: "old_content_not_found", detail: "" };
    const stride = Math.max(1, Math.floor(range / 500));
    for (let start = 0; start <= range; start += stride) candidates.push(start);
  }

  let bestDist = Infinity;
  let bestStart = -1;
  for (const startBase of candidates) {
    for (let delta = -8; delta <= 8; delta++) {
      const start = startBase + delta;
      if (start < 0 || start + windowLen > fileLen) continue;
      const candidate = content.slice(start, start + windowLen);
      const reference = shorterThanFile ? bestPreimageWindow(oldString, candidate) : oldString;
      let sameChars = 0;
      for (let k = 0; k < windowLen; k += 4) if (candidate[k] === reference[k]) sameChars++;
      if (sameChars < windowLen / 8) continue;
      const d = cappedLevenshtein(reference, candidate, cap + 1);
      if (d < bestDist) {
        bestDist = d;
        bestStart = start;
        if (d === 0) break;
      }
    }
    if (bestDist === 0) break;
  }

  if (bestStart === -1 || bestDist > cap) {
    return { ok: false, reason: "old_content_not_found", detail: "", };
  }
  // Length refinement at the locked start: the drift may have changed the
  // region's length, so try nearby lengths and keep the boundary that
  // minimizes distance.
  let bestLen = windowLen;
  if (!shorterThanFile) {
    for (let dl = -24; dl <= 24; dl++) {
      const len = windowLen + dl;
      if (len <= 0 || bestStart + len > fileLen) continue;
      const cand = content.slice(bestStart, bestStart + len);
      const d = cappedLevenshtein(oldString, cand, bestDist);
      if (d < bestDist) { bestDist = d; bestLen = len; }
    }
  }
  const actual = content.slice(bestStart, bestStart + bestLen);
  if (crossesTokenBoundary(content, actual, oldString)) {
    return { ok: false, reason: "old_content_not_found", detail: "the fuzzy match lands inside a token; refusing to avoid a corrupt edit" };
  }
  // Uniqueness: the recovered span must occur exactly once.
  let occurrences = 0;
  let i = content.indexOf(actual);
  while (i !== -1) { occurrences++; if (occurrences > 1) break; i = content.indexOf(actual, i + 1); }
  if (occurrences > 1) {
    return { ok: false, reason: "old_content_ambiguous_fuzzy", detail: "the fuzzy-matched region occurs more than once; widen oldString with unique surrounding lines" };
  }
  return success(content, bestStart, bestStart + bestLen, "fuzzy");
}

// ── Shared helpers ──

function crossesTokenBoundary(src: string, actual: string, oldString: string): boolean {
  const start = src.indexOf(actual);
  if (start === -1) return false;
  const end = start + actual.length;
  const trimmedOld = oldString.replace(/^\s+/, "").replace(/\s+$/, "");
  const oldFirst = trimmedOld[0] ?? "";
  const oldLast = trimmedOld[trimmedOld.length - 1] ?? "";
  const before = start > 0 ? src[start - 1]! : "";
  const after = end < src.length ? src[end]! : "";
  if (before && IDENT_CHAR.test(before) && IDENT_CHAR.test(oldFirst)) return true;
  if (after && IDENT_CHAR.test(after) && IDENT_CHAR.test(oldLast)) return true;
  return false;
}

function recoverWhitespaceRemoved(src: string, strictSrc: string, strictStart: number, strictLength: number): string | null {
  let srcIdx = 0;
  let strictIdx = 0;
  while (srcIdx < src.length && strictIdx < strictStart) {
    const c = src[srcIdx]!;
    if (/\s/.test(c)) srcIdx++;
    else if (c === strictSrc[strictIdx]) { strictIdx++; srcIdx++; }
    else return null;
  }
  const startSrc = srcIdx;
  const target = strictStart + strictLength;
  while (srcIdx < src.length && strictIdx < target) {
    const c = src[srcIdx]!;
    if (/\s/.test(c)) srcIdx++;
    else if (c === strictSrc[strictIdx]) { strictIdx++; srcIdx++; }
    else return null;
  }
  return src.slice(startSrc, srcIdx);
}

function longestSharedToken(line: string, src: string): string | null {
  const tokens = line.match(/[A-Za-z_$][A-Za-z0-9_$]{3,}/g);
  if (tokens === null) return null;
  const sorted = [...new Set(tokens)].sort((a, b) => b.length - a.length);
  for (const t of sorted) {
    if (src.includes(t)) return t;
  }
  return null;
}

function bestPreimageWindow(preimage: string, candidate: string): string {
  const len = candidate.length;
  if (preimage.length <= len) return preimage;
  let best = preimage.slice(0, len);
  let bestDist = Infinity;
  const stride = Math.max(1, Math.floor((preimage.length - len) / 64));
  for (let start = 0; start + len <= preimage.length; start += stride) {
    const window = preimage.slice(start, start + len);
    let same = 0;
    for (let k = 0; k < len; k += 4) if (window[k] === candidate[k]) same++;
    if (same < len / 8) continue;
    const d = levenshtein(window, candidate);
    if (d < bestDist) { bestDist = d; best = window; if (d === 0) break; }
  }
  return best;
}

/**
 * The whitespace-equivalence primitive, re-exported so hosts that heal on the
 * same whitespace-drift question import from ONE owner (the editor package)
 * rather than re-implementing the collapse.
 */
export { whitespaceEquivalent };

/** Levenshtein with an early-exit cap (the safety layer's version is uncapped). */
function cappedLevenshtein(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const d = levenshtein(a, b);
  return d > cap ? cap + 1 : d;
}
