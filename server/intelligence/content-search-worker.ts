/**
 * Content-search worker thread entry point.
 *
 * The search itself is a caller-supplied regular expression applied to every
 * line of every file in a project. Two independent properties make that
 * unsafe to run on the server's event loop:
 *
 * - **It is unbounded CPU by design.** Even a well-behaved pattern reads and
 *   scans the whole tree, which on a large project is seconds of blocking
 *   during which no request, no SSE frame and no other user's chat advances.
 *
 * - **A single match can be uninterruptible for minutes.** The pattern comes
 *   from the model, and a pattern with nested quantifiers backtracks
 *   exponentially in the length of the subject line. Measured on this machine,
 *   `(a+)+$` against a single 35-character line ran for 64.6 seconds inside ONE
 *   `RegExp.test` call; 37 characters took 468 seconds, and the growth is such
 *   that a 61-character line never finishes. No deadline checked between lines can interrupt that,
 *   because control never returns between lines — the only thing that can stop
 *   it is killing the thread it runs on.
 *
 * So the door (`content-search.ts`) runs this worker through the shared worker
 * pool, which terminates the thread when its timeout elapses. The pattern
 * still cannot be validated as safe — deciding whether a regex backtracks
 * catastrophically is not something a pattern inspection can do reliably, and
 * a heuristic denylist of "dangerous shapes" would refuse legitimate patterns
 * while still missing others. A killable thread needs no such judgement.
 *
 * Built-in `node:worker_threads` — no new runtime dependency, and the same
 * pattern the repository-map, quick-view and awareness workers already use.
 */
import { parentPort, workerData } from "node:worker_threads";

import { searchProjectContentSync, type ContentSearchRequest, type ContentSearchResult } from "./content-search-engine.ts";
import { postWorkerResult } from "../run/worker-ipc.ts";

type WorkerOk = Readonly<{ ok: true; result: ContentSearchResult }>;
type WorkerErr = Readonly<{ ok: false; error: Readonly<{ message: string; code?: string }> }>;
type WorkerResult = WorkerOk | WorkerErr;

if (parentPort === null) {
  // Spawned without a parent port (e.g. run directly) — nothing to do.
  process.exit(1);
}

const input = workerData as ContentSearchRequest | undefined;
if (
  input === undefined
  || typeof input.projectRoot !== "string"
  || input.projectRoot.length === 0
  || typeof input.pattern !== "string"
  || input.bounds === null
  || typeof input.bounds !== "object"
) {
  postWorkerResult({
    ok: false,
    error: { message: "Content search worker requires a projectRoot, a pattern and bounds.", code: "content_search_worker_bad_input" },
  } satisfies WorkerResult);
} else {
  try {
    postWorkerResult({ ok: true, result: searchProjectContentSync(input) } satisfies WorkerResult);
  } catch (err) {
    // A pattern that does not compile arrives here as a SyntaxError. It is
    // reported as a typed refusal rather than an empty match list, because an
    // empty list is what a successful search of a project with no matches
    // returns, and the model cannot act on the difference if both look alike.
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof SyntaxError ? "content_search_invalid_pattern" : (err as { code?: string } | null)?.code;
    postWorkerResult({ ok: false, error: { message, ...(code !== undefined ? { code } : {}) } } satisfies WorkerResult);
  }
}
