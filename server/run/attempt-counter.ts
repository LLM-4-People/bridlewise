/**
 * Per-tool-name attempt-counter logic for the run stream (fix).
 *
 * The displayed "attempt N" badge must mean the PREVIOUS call of the same
 * tool name FAILED and this is a retry. A successful call RESETS the
 * counter so the next call of the same tool (e.g. the next read_file) is
 * "attempt 1" again (hidden by the UI's `attemptCount > 1` gate). The prior
 * code incremented on EVERY `tool_call_start` → 5 successful read_file
 * calls in a row showed "attempt 5" on the 5th file (a false positive).
 *
 * Pure + Node-testable (no I/O, no stores). The run stream keeps a per-run
 * `Map<string, number>`; these helpers are the SINGLE owner of the
 * increment/reset decision so the behavior is verified by a
 * behavioral test, not a source-grep.
 */

/**
 * The attempt number to DISPLAY for the current call, given the previous
 * outstanding counter value. Always `prev + 1`: a fresh call is "attempt 1",
 * a retry after a failure is "attempt 2", etc.
 */
export function attemptNumberForCall(prev: number): number {
  return prev + 1;
}

/**
 * The counter value to STORE for the NEXT call, after the current call
 * finishes. A SUCCESS resets to 0 (next call = "attempt 1", hidden). A
 * FAILURE leaves the attempt outstanding (next call increments to the
 * next attempt number — the retry the user wants to see).
 */
export function nextCounterAfterCall(prev: number, success: boolean): number {
  return success ? 0 : prev + 1;
}
