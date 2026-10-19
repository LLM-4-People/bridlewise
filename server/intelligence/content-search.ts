/**
 * Content search — the door.
 *
 * Every caller that wants to search file CONTENT comes through here. The
 * engine (`content-search-engine.ts`) is pure and knows no bounds of its own;
 * this module resolves every bound from the config owner, runs the engine on a
 * worker thread that can be killed, and renders the result into the text the
 * model reads.
 *
 * Placing the bound resolution HERE rather than in the tool handler is what
 * makes the caps de facto: a future surface that wants content search calls
 * this function and is bounded because the door bounds it, not because whoever
 * wrote that surface remembered to.
 */

import { redactSecretFileText } from "../../engine/src/privacy/secret-files.ts";
import { getPrivacyPolicy } from "../kernel/harness-config.ts";
import { getSearchLimits, getSearchLinePreviewMaxChars, getSearchMaxScannedMatches, getSearchTimeoutMs, getToolBounds } from "../kernel/harness-config.ts";
import { ServiceUnavailableError } from "../kernel/errors.ts";
import { runWorkerTask } from "../run/worker-pool.ts";
import type { ContentSearchResult } from "./content-search-engine.ts";

const CONTENT_SEARCH_WORKER_URL = new URL("./content-search-worker.ts", import.meta.url);

/**
 * Run a content search off the main thread.
 *
 * Rejects with `ServiceUnavailableError` when the worker fails, is refused by
 * the pool's concurrency cap, or is terminated for exceeding its deadline. A
 * pattern that does not compile arrives as the same typed error carrying the
 * code `content_search_invalid_pattern`.
 */
export async function searchProjectContent(projectRoot: string, pattern: string): Promise<ContentSearchResult> {
  const limits = getSearchLimits();
  const bounds = {
    maxDepth: limits.maxDepth,
    maxResults: limits.maxResults,
    maxScannedMatches: getSearchMaxScannedMatches(),
    maxFileBytes: getToolBounds().maxFileBytes,
    previewMaxChars: getSearchLinePreviewMaxChars(),
  };
  return runWorkerTask<ContentSearchResult>({
    workerUrl: CONTENT_SEARCH_WORKER_URL,
    workerData: { projectRoot, pattern, bounds },
    errorClass: ServiceUnavailableError,
    label: "content-search",
    timeoutMs: getSearchTimeoutMs(),
    // Two identical searches issued concurrently for the same project answer
    // the same question, so they share one thread rather than each paying the
    // full walk. The pattern is part of the key because a different pattern is
    // a different question.
    dedupKey: `${projectRoot}::${pattern}`,
    validateOk: (raw) => (raw as { result?: ContentSearchResult }).result,
  });
}

/**
 * Render a content-search result as the text the model reads.
 *
 * The completeness line is the point of this function. The previous output was
 * the match list alone, so a truncated answer and a complete one were
 * typographically identical and a model had no way to learn that its pattern
 * was too broad. Stating the true total, the shown count and the reason for
 * every shortfall turns a silent partial answer into a fact the model can act
 * on — narrow the pattern, or trust the list because nothing was cut.
 */
export function formatContentSearchResult(result: ContentSearchResult): string {
  const { matches, completeness } = result;
  // A match inside a secret file (by name) shows its key, never its value.
  const lines = matches.map((m) => `${m.path}:${m.line}: ${redactSecretFileText(m.path, m.preview, getPrivacyPolicy())}${m.previewTruncated ? " …" : ""}`);

  const notes: string[] = [];
  if (completeness.scanStoppedEarly) {
    notes.push(
      `The scan stopped after ${completeness.totalMatches} matches, so the real total is higher and unknown. Narrow the pattern.`,
    );
  } else if (completeness.matchesTruncated) {
    notes.push(
      `Showing ${completeness.shownMatches} of ${completeness.totalMatches} matches. Narrow the pattern to see the rest.`,
    );
  }
  if (completeness.directoriesSkippedTooDeep > 0) {
    notes.push(
      completeness.directoriesSkippedTooDeep === 1
        ? "1 directory was not searched because it sits deeper than the depth limit."
        : `${completeness.directoriesSkippedTooDeep} directories were not searched because they sit deeper than the depth limit.`,
    );
  }
  if (completeness.directoriesUnreadable > 0) {
    // Named apart from the depth bound: the remedy is different, and telling a
    // reader to raise a depth limit that would not have helped is worse than
    // saying nothing.
    notes.push(
      completeness.directoriesUnreadable === 1
        ? "1 directory could not be listed and was not searched."
        : `${completeness.directoriesUnreadable} directories could not be listed and were not searched.`,
    );
  }
  if (completeness.filesSkippedTooLarge > 0) {
    notes.push(`${completeness.filesSkippedTooLarge} file(s) were skipped for exceeding the per-file size limit.`);
  }
  if (completeness.filesSkippedBinary > 0) {
    notes.push(`${completeness.filesSkippedBinary} file(s) were skipped because they are not text.`);
  }

  if (matches.length === 0) {
    // Even "nothing found" carries its coverage, because "no matches in the
    // 400 files searched" and "no matches, but half the tree was never
    // reached" are different answers that used to print the same sentence.
    const head = `No matches found. Searched ${completeness.filesScanned} file(s).`;
    return notes.length === 0 ? head : `${head}\n${notes.join("\n")}`;
  }

  const head = `${completeness.shownMatches} match(es) shown from ${completeness.filesScanned} file(s) searched.`;
  return [head, ...lines, ...notes].join("\n");
}
