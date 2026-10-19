/**
 * Content search — the pure engine.
 *
 * This is the ONE place that answers "which raw lines of this project's files
 * match this pattern". It is deliberately separate from symbol search: the
 * hybrid BM25 ranker (`intelligence-bridge.ts searchCodeSymbols`) scores
 * DECLARED SYMBOLS, whose documents are name tokens plus module-path tokens.
 * It can never match a string literal, a comment, an error code, a config key,
 * a markdown line, or a file written in a language with no symbol extractor.
 * Content search answers a question no other mechanism in the tree answers, so
 * it is a distinct capability rather than a worse copy of symbol search.
 *
 * Two properties this engine guarantees that the previous inline walk did not:
 *
 * 1. **The answer says how complete it is.** The old walk stopped the instant
 *    it had collected its display quota and returned that prefix with nothing
 *    to say it was a prefix — so "3 matches" and "3 of 900 matches" were the
 *    same output, and a model reading it could not tell a rare symbol from a
 *    ubiquitous one. Here the scan continues past the display quota up to a
 *    separate, larger scan bound, and the result reports the true match count,
 *    how many were shown, and which bound (if any) cut the answer short.
 *
 * 2. **The order is the engine's, not the filesystem's.** Directory entries
 *    were consumed in `readdirSync` order, which is unspecified and differs
 *    between filesystems, so which subset of matches survived the cut was an
 *    accident of the disk layout and the same search could answer differently
 *    on two machines. Entries are sorted here, and matches are emitted in
 *    (path, line) order.
 *
 * What this engine deliberately does NOT do is score matches for relevance.
 * A caller supplies a REGEX, not a bag of query terms, and running a term
 * ranker over a regex produces an ordering computed from the wrong kind of
 * input — a confident ordering that means nothing, which is worse than an
 * ordering that plainly claims nothing. Callers who want ranked relevance for
 * a natural-language description have `search_symbols` (hybrid BM25 + fuzzy)
 * and `retrieve_relevant_files` for exactly that.
 *
 * The engine is synchronous and CPU-bound by nature (a regex applied to every
 * line of every file). It runs inside a worker thread — see
 * `content-search.ts`, the door every caller uses — because a caller-supplied
 * pattern can backtrack catastrophically and a single uninterruptible
 * `RegExp.test` cannot be timed out from inside. Nothing here may assume it is
 * on the main thread.
 */

import { readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

import { readFileText } from "../filesystem/file-read.ts";
import { projectKeepOut, resolveWithinProject } from "../filesystem/fs-gate.ts";

/** One matching line. */
export type ContentSearchMatch = Readonly<{
  /** Project-relative path, always with forward slashes. */
  readonly path: string;
  /** 1-based line number. */
  readonly line: number;
  /** The trimmed matching line, truncated to the preview bound. */
  readonly preview: string;
  /** True when `preview` is shorter than the trimmed source line. */
  readonly previewTruncated: boolean;
}>;

/**
 * Why a scan stopped short of examining the whole tree, or why the returned
 * matches are fewer than the matches that exist. Every field is a measured
 * fact about THIS scan, never a default — a caller can therefore tell a
 * complete answer from a partial one without guessing.
 */
export type ContentSearchCompleteness = Readonly<{
  /** Total matches found by the scan (may exceed `matches.length`). */
  readonly totalMatches: number;
  /** Matches actually returned. */
  readonly shownMatches: number;
  /** Files whose content was read and scanned. */
  readonly filesScanned: number;
  /** Files skipped because they exceeded the per-file byte bound. */
  readonly filesSkippedTooLarge: number;
  /** Files skipped because their bytes did not decode as text. */
  readonly filesSkippedBinary: number;
  /** Directories not descended into because the depth bound was reached. */
  readonly directoriesSkippedTooDeep: number;
  /** Directories that could not be listed at all — a permission denial, a
   *  broken link, a race with a delete. Counted apart from the depth bound
   *  because they are a different fact with a different remedy, and folding
   *  them together made the answer state a reason that was not the reason. */
  readonly directoriesUnreadable: number;
  /** True when matches exist beyond the ones returned. */
  readonly matchesTruncated: boolean;
  /** True when the scan itself stopped early at the scan bound, so matches
   *  beyond the returned set were never even counted. */
  readonly scanStoppedEarly: boolean;
}>;

export type ContentSearchResult = Readonly<{
  readonly matches: readonly ContentSearchMatch[];
  readonly completeness: ContentSearchCompleteness;
}>;

/** Every bound the engine obeys. All of them are resolved by the caller from
 *  the config owner — the engine holds no defaults of its own, so there is no
 *  second answer to "what is the limit" for a reader to disagree with. */
export type ContentSearchBounds = Readonly<{
  /** Maximum directory depth to descend. */
  readonly maxDepth: number;
  /** Maximum matches to RETURN. */
  readonly maxResults: number;
  /** Maximum matches to COUNT before abandoning the scan. Must be >=
   *  `maxResults`; the gap is what lets the result report an honest total
   *  instead of stopping at the display quota. */
  readonly maxScannedMatches: number;
  /** Maximum bytes of a single file to read. */
  readonly maxFileBytes: number;
  /** Maximum characters of a matching line to include in the preview. */
  readonly previewMaxChars: number;
}>;

export type ContentSearchRequest = Readonly<{
  readonly projectRoot: string;
  /** The regex source, as supplied by the caller. */
  readonly pattern: string;
  readonly bounds: ContentSearchBounds;
}>;

/**
 * A byte sequence that does not decode as text is not searchable, and running
 * a line regex over the replacement characters a lossy decode produces yields
 * matches at line numbers that do not exist in any editor's view of the file.
 * A single NUL is the standard, cheap discriminator: it cannot appear in valid
 * UTF-8 text, and every common binary container (images, archives, compiled
 * objects, databases) has one early.
 */
function looksBinary(content: string): boolean {
  return content.indexOf(String.fromCharCode(0)) !== -1;
}

/**
 * Impose the engine's own order on a directory listing.
 *
 * Exported and pure so the guarantee can be tested on an input this process
 * controls. Asserting it through a real directory cannot decide anything on a
 * filesystem whose `readdirSync` already returns sorted entries — which the one
 * this suite runs on does — so removing the ordering there passes. Here the
 * input is deliberately out of order, so the assertion has something to
 * separate: a sort that orders nothing (`.sort(() => 0)` is stable in V8 and
 * returns the input untouched) fails, and so does no sort at all.
 */
export function orderDirectoryEntries(names: readonly string[]): readonly string[] {
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Search a project's file content.
 *
 * Throws `SyntaxError` from `new RegExp` when the pattern does not compile;
 * the door translates that into the caller-facing refusal. Nothing here
 * swallows an error into an empty result — an empty result must mean "no
 * matches", never "something went wrong", or the two become indistinguishable
 * to the model reading the output.
 */
export function searchProjectContentSync(request: ContentSearchRequest): ContentSearchResult {
  const { projectRoot, pattern, bounds } = request;
  // No `g` flag: `test` on a global regex advances `lastIndex` between calls,
  // so consecutive lines would be probed from a moving offset and matches
  // would be dropped on alternating lines.
  const regex = new RegExp(pattern, "i");
  const root = resolve(projectRoot);

  const matches: ContentSearchMatch[] = [];
  let totalMatches = 0;
  let filesScanned = 0;
  let filesSkippedTooLarge = 0;
  let filesSkippedBinary = 0;
  let directoriesSkippedTooDeep = 0;
  let directoriesUnreadable = 0;
  let scanStoppedEarly = false;

  const scanCeiling = Math.max(bounds.maxScannedMatches, bounds.maxResults);
  // ONE keep-out operation for the whole walk: the list is measured once and
  // the folders the walk meets are answered once (not per entry).
  const keepOut = projectKeepOut(root);

  function walk(dir: string, depth: number): void {
    if (scanStoppedEarly) return;
    if (depth > bounds.maxDepth) {
      directoriesSkippedTooDeep += 1;
      return;
    }
    let names: readonly string[];
    try {
      names = readdirSync(dir, { withFileTypes: true })
        // A dot-prefixed entry is metadata (`.git`, `.bridlewise`), and
        // `node_modules` is dependency source the caller did not write.
        // Compared exactly rather than by prefix: a prefix test also hides a
        // directory legitimately named `node_modules_notes`, and silently
        // searching less than asked is the failure this engine exists to
        // stop reporting as success.
        .filter((d) => !d.name.startsWith(".") && d.name !== "node_modules")
        .map((d) => d.name);
      // Unspecified `readdirSync` order made the surviving subset of a
      // truncated search a property of the filesystem. The ordering lives in
      // its own exported function so it can be tested on an out-of-order input
      // rather than on whatever this machine's filesystem happens to hand out.
      names = orderDirectoryEntries(names);
    } catch {
      // An unreadable directory is a hole in the scan, not a failure of it —
      // and it is a DIFFERENT hole from the depth bound. Counting it as
      // depth-skipped made the answer tell the reader to raise a limit that
      // would not have helped.
      directoriesUnreadable += 1;
      return;
    }
    for (const name of names) {
      if (scanStoppedEarly) return;
      const fullPath = resolve(dir, name);
      // The path gate runs per entry, through the single owner of the
      // resolve-and-contain check, so an entry that escapes the project root
      // is skipped rather than read. It signals refusal by throwing.
      try {
        resolveWithinProject(fullPath, root, keepOut);
      } catch {
        continue;
      }
      let st;
      try {
        st = statSync(fullPath);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(fullPath, depth + 1);
        continue;
      }
      if (!st.isFile()) continue;
      if (st.size >= bounds.maxFileBytes) {
        filesSkippedTooLarge += 1;
        continue;
      }
      let content: string;
      try {
        content = readFileText(fullPath);
      } catch {
        continue;
      }
      if (looksBinary(content)) {
        filesSkippedBinary += 1;
        continue;
      }
      filesScanned += 1;
      const relPath = relative(root, fullPath).split(sep).join("/");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!regex.test(line)) continue;
        totalMatches += 1;
        if (matches.length < bounds.maxResults) {
          const trimmed = line.trim();
          const preview = trimmed.slice(0, bounds.previewMaxChars);
          matches.push({
            path: relPath,
            line: i + 1,
            preview,
            previewTruncated: preview.length < trimmed.length,
          });
        }
        if (totalMatches >= scanCeiling) {
          scanStoppedEarly = true;
          return;
        }
      }
    }
  }

  walk(root, 1);

  // Depth-first over a sorted listing is deterministic, but it is NOT path
  // order: a directory `b` is visited before a file `b.txt` because `b` sorts
  // first as a NAME, while `b.txt` sorts before `b/x.txt` as a PATH. The
  // header claimed (path, line) order and the fixture that checked it had no
  // such collision, so the claim was true of the fixture and false of the
  // engine. Sorted here, where the comparison is over the paths themselves.
  //
  // What this does NOT change is WHICH matches survive truncation — that is
  // still decided by walk order, and the completeness fields are how a caller
  // learns the answer was cut at all.
  matches.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));

  return {
    matches,
    completeness: {
      totalMatches,
      shownMatches: matches.length,
      filesScanned,
      filesSkippedTooLarge,
      filesSkippedBinary,
      directoriesSkippedTooDeep,
      directoriesUnreadable,
      matchesTruncated: totalMatches > matches.length,
      scanStoppedEarly,
    },
  };
}
