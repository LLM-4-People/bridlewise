/**
 * Error message formatting — the client's HUMAN-TEXT PROJECTION of the
 * shared error taxonomy.
 *
 * The structured errors store (src/state/errors.ts) retains the full
 * technical detail (kind, code, statusCode, raw message) for debugging.
 * The chat transcript and ErrorBoundary consume this formatter to show
 * actionable, human-readable text.
 *
 * ── Why this is a projection and not a second table ──
 *
 * This module used to hand-maintain ~25 codes that `shared/errors.ts`
 * had never heard of. Two independent lists of the same vocabulary drift
 * the moment either side adds a code: the taxonomy grows a code with no
 * message, or this file keeps a message for a code nothing throws any
 * more — and neither drift is visible until a user sees the wrong text.
 *
 * The relationship is now one-way and enforced:
 *
 *   1. `shared/errors.ts` OWNS the vocabulary. Every key of
 *      `MESSAGE_FOR_CODE` below must be a code that owner declares —
 *      mechanically checked by tests/prevention/error-message-projection
 *      -owner.test.ts, which imports both sides and compares the sets, and
 *      which also fails if a SECOND code table appears anywhere in the app.
 *   2. A taxonomy code with no bespoke sentence is NOT unhandled: its
 *      status is DERIVED via `resolveStatus` (the owner's own resolution)
 *      and rendered by the shared status text. So adding a code to the
 *      taxonomy alone already produces a correct-by-status message; the
 *      table below only exists to say something BETTER than the status
 *      for the cases where a specific sentence helps the user act.
 *
 * Adding a message: add the code to `shared/errors.ts` first, then (if
 * the status text is not good enough) an entry here. Keep the fallback
 * honest — never hide that an error occurred.
 */

import {
  isClientInputCode,
  isKnownErrorCode,
  resolveStatus,
} from "../../shared/errors";

export type ErrorContext = {
  readonly code: string | null;
  readonly message: string;
  readonly statusCode: number | undefined;
};

/**
 * Human sentences for codes where the status text alone is not actionable.
 * Each says what happened AND what to do about it.
 *
 * KEYS ARE NOT FREE TEXT: every one must be declared by
 * `shared/errors.ts` (see the module doc). Exported so the guard can
 * read the real key set at runtime rather than re-parsing this source —
 * a comment or a renamed local cannot fool it.
 */
export const MESSAGE_FOR_CODE: Readonly<Record<string, string>> = Object.freeze({
  // access
  // Reached only after the fetch choke point (src/data/broker.ts) already
  // retried the blocked request once — this sentence is the fallback for a
  // repeat refusal, not the first remedy.
  csrf_blocked: "Your session expired or the request came from an unexpected origin. It was retried once without success — reload the page and try again.",
  auth_failed: "Sign-in failed. Check your username and password.",
  setup_required: "No account exists yet. Create the first account to continue.",
  forbidden: "You don't have access to this. It belongs to another account.",
  path_outside_roots: "That path is outside the project. Pick a file inside the project folder.",
  path_traversal: "That path escapes the project folder, so it was refused.",
  path_second_name: "That file is also stored outside the project folder under another name, so opening it here would reach outside the project. It was refused.",
  workspace_commands_not_editable_here: "The commands a workspace or a new checkout runs, and the branches a workspace may land on, can only be changed in the settings file on this machine, not from here.",
  path_harness_state: "That file is this program's own data (a database, its key or its history), not part of the project, so it was refused.",
  path_credential_store: "That file is in a place that holds credentials (keys, tokens or a browser profile), so it is never opened here, even inside a project folder.",
  mcp_credential_env_refused: "This tool server's settings name an environment variable that is not on the list of credentials tool servers may use, so it was not started. Add the name to that list or remove it from the server.",
  // editing conflicts
  preimage_mismatch: "The file changed on disk since you opened it. Reload it and reapply your edit.",
  already_exists: "Something with that name already exists here. Choose a different name.",
  no_change: "The edit would not change the file, so nothing was saved.",
  empty_preimage: "The text to replace was empty, so there was nothing to match.",
  cannot_delete_root: "The project root can't be deleted.",
  // lookup
  file_not_found: "That file no longer exists. It may have been moved or deleted.",
  parent_not_found: "The containing folder doesn't exist.",
  not_a_file: "That path is a folder, not a file.",
  not_a_directory: "That path is a file, not a folder.",
  // input
  invalid_name: "That name isn't allowed. Avoid path separators and reserved characters.",
  invalid_path: "That path isn't valid.",
  file_too_large: "That file is too large to open here.",
  // service
  project_path_invalid: "The project folder is missing or unreadable. Re-open the project to fix its path.",
  config_unreadable: "The settings file can't be read (it may be half-saved or hand-edited into something that isn't valid), so settings are unavailable and no change can be saved. Retrying won't help: fix or restore the file — the error details and the server log name its path — then reload.",
  read_path_refused: "That folder holds credentials, keys or this program's own data, and no command or local tool server is ever given it. Name only the tool server's own installation folder.",
  tool_path_overlaps_writable: "That folder is one the program can also write to. A folder a program can write must never also be one it can run programs from, so it was refused.",
  project_is_harness_source: "That folder holds this program's own code, which nothing the model runs may be given. Choose a different folder.",
  config_write_lock_timeout: "Another process was writing the settings file at the same time, so this change was not saved. Try again in a moment.",
  service_unavailable: "That service is unavailable right now. Try again shortly.",
  rate_limited: "Too many requests. Please slow down.",
  sse_connection_limit: "Too many live streams are open. Close another tab and try again.",
  // not-ready (202) — a wait, not a failure
  map_not_ready: "Still reading through this project's code. This view will fill in when that finishes.",
  awareness_not_ready: "Still gathering data about this work. This will fill in shortly.",
  // mid-run stream failures — reported BY the server on the SSE error
  // frame. Before the frame carried a code, every one of these was
  // indistinguishable to the user.
  tool_iteration_limit: "The assistant reached its limit on tool uses for one reply and stopped. Try asking for something smaller.",
  pause_answer_timeout: "The assistant paused to ask you a question and nobody answered in time, so the run stopped. Ask it again to continue.",
  run_failed: "The assistant stopped because of an error on the server. Open the error panel for details, or just try again.",
  // stream transport (client-originated — the client observed the failure;
  // no server frame said why). Two states, two truths: `stream_error` is
  // the CONNECTING state, where the browser's own auto-reconnect really is
  // running; `stream_closed` is the CLOSED state, which the SSE protocol
  // reaches only when the server refused the stream (a non-200 answer) and
  // from which it never reconnects — so that sentence must promise nothing.
  stream_closed: "The live stream is no longer available and will not reconnect. What the run recorded is saved in this conversation.",
  stream_error: "The live stream was interrupted. Reconnecting automatically...",
  // payload transport (client-originated)
  parse: "Received malformed data from the server. This may be a bug — check the error log for details.",
  malformed: "Received malformed data from the server. This may be a bug — check the error log for details.",
  // the model itself reported a failure
  model: "The model returned an error. See the error panel for details.",
});

export function formatErrorMessage(ctx: ErrorContext): string {
  const { code, message, statusCode } = ctx;

  // Network errors (server down, CORS, etc.) — the user wants "Server
  // offline" not a generic "Failed to fetch" or a misleading rate-limit
  // message when the server is actually unreachable (exp519). Checked
  // BEFORE any status branch so a true offline never surfaces as a 429.
  if (
    code === "network" ||
    message.includes("NetworkError") ||
    message.includes("Failed to fetch") ||
    (message.includes("fetch") && message.includes("resource"))
  ) {
    return "Server offline. Make sure it's running, then try again.";
  }

  // Timeout
  if (code === "timeout" || message.toLowerCase().includes("timed out")) {
    return "The request took too long. The server may be busy — try again in a moment.";
  }

  // ── The bespoke projection ──
  // Reachable only since `fetchJson` stopped discarding the server's
  // `error` field and synthesising `http_<status>`. Before that every
  // distinction here collapsed into its status: `path_traversal`,
  // `forbidden` and `csrf_blocked` were indistinguishable as `http_403`,
  // so the user was told "Access denied" for a path-escape attempt, a
  // stale session, and a genuine permission failure alike.
  const typed = code === null ? undefined : MESSAGE_FOR_CODE[code];
  if (typed !== undefined) return typed;

  // The status the CALLER observed (a REST response) wins over a derived
  // one — it is the status that actually came back.
  if (statusCode !== undefined) {
    const fromStatus = statusText(statusCode);
    if (fromStatus !== undefined) return fromStatus;
  }

  // Run start failures (non-network) — the raw message carries the reason.
  if (code === "run_start") {
    return "The assistant couldn't start working on your message. " + message;
  }

  // ── Derived, not hand-maintained ──
  // No bespoke sentence and no observed status. If the taxonomy owner
  // knows this code, ask IT what the code means and render the shared
  // status text. This is what stops the table above from having to grow an
  // entry for every new code just to avoid a raw technical string.
  if (code !== null && isKnownErrorCode(code)) {
    const derived = statusText(isClientInputCode(code) ? 400 : resolveStatus(code));
    if (derived !== undefined) return derived;
  }

  // Fallback: show the message as-is, without the technical code prefix.
  // An unrecognised code degrades rather than breaking, and never hides
  // that an error occurred.
  return message;
}

/**
 * The human text for an HTTP status. The SINGLE status→text mapping —
 * used both when the caller supplies a `statusCode` and when the status is
 * DERIVED from a taxonomy code that has no bespoke sentence, so the two
 * paths cannot say different things about the same status.
 *
 * Declared AFTER `formatErrorMessage` (hoisted) deliberately: the offline
 * check must be the first status-shaped test a reader — and the ordering
 * guard in tests/prevention/chat-ux-fixes.test.ts — encounters in this
 * file, so a true offline can never be reported as a rate limit.
 */
function statusText(statusCode: number): string | undefined {
  if (statusCode >= 500) {
    return "The server encountered an error. Try again in a moment.";
  }
  if (statusCode === 429) {
    // A TRUE 429 (the server responded with rate_limited). Distinct from
    // a network error (server offline): here the server IS up but asking
    // the client to slow down.
    return "Too many requests — please wait a moment and try again.";
  }
  if (statusCode === 404) {
    return "The requested resource was not found. It may have been removed.";
  }
  if (statusCode === 403) {
    return "Access denied. The server refused this request.";
  }
  if (statusCode === 413) {
    return "The request was too large. Try sending less data.";
  }
  if (statusCode >= 400) {
    return "The request was rejected. Check your input and try again.";
  }
  return undefined;
}

/**
 * Extract a human-displayable message from a thrown value (the single
 * owner — SPO). Before the pattern
 * `err instanceof ClientError? err.message: err instanceof Error?
 * err.message: String(err)` was duplicated across 10+ components AND
 * was redundant (ClientError extends Error, so the two branches were
 * identical). This helper is the choke point: every catch block in the
 * harness that needs a displayable message calls this instead of
 * re-implementing the `instanceof Error` check, so the extraction logic
 * cannot drift or be re-duplicated (No Scattered Helpers + ).
 *
 * Note: structured error CODE→message mapping (network/timeout/HTTP)
 * belongs in `formatErrorMessage` above (it takes an ErrorContext).
 * This helper is the simple "give me a string for this thrown thing"
 * path used by panel catch blocks that just need to show `err.message`.
 */
export function clientErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
