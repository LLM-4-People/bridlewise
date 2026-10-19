import { constants as osConstants } from "node:os";
import { fileURLToPath } from "node:url";
import { handleError } from "../shared/debug/debug-system.ts";

export class HarnessError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly safeDetails: Readonly<Record<string, string | number | boolean>>;

  constructor(
    message: string,
    code = "harness_error",
    retryable = false,
    safeDetails: Readonly<Record<string, string | number | boolean>> = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.retryable = retryable;
    this.safeDetails = Object.freeze({ ...safeDetails });
  }
}

/** The code of a refused input record (a report or envelope whose shape, schema or integrity is wrong): the one spelling, `src/workflow/command-result.ts` `parseSignedReport`'s. */
export const INPUT_ERROR_CODE = "input_error";

export class InputError extends HarnessError {
  constructor(
    message: string,
    code = "input_invalid",
    safeDetails: Readonly<Record<string, string | number | boolean>> = {},
  ) {
    super(message, code, false, safeDetails);
  }
}

export class SecurityError extends HarnessError {
  constructor(
    message: string,
    code = "security_denied",
    safeDetails: Readonly<Record<string, string | number | boolean>> = {},
  ) {
    super(message, code, false, safeDetails);
  }
}

/**
 * The config file's cross-process write lock could not be acquired inside
 * the policy timeout — another process holds the lock and has not released
 * it (a live holder still writing, or a wedged one). Retryable: the
 * contention itself is normal, only its duration was not.
 */
export class ConfigWriteLockTimeout extends HarnessError {
  constructor(
    message: string,
    safeDetails: Readonly<Record<string, string | number | boolean>> = {},
  ) {
    super(message, "config_write_lock_timeout", true, safeDetails);
  }
}

/**
 * A wait for the one instrument lock ended by a signal
 * (`instrument_lock_wait_interrupted`): the door exits 128 + its number,
 * holding nothing. Here, at the bottom of the import graph, so the CLI maps it
 * to its exit code by type without loading the lock's module (design LOW 14).
 */
export class InstrumentLockWaitInterrupted extends HarnessError {
  readonly signal: NodeJS.Signals;
  constructor(runner: string, signal: NodeJS.Signals) {
    super(`${runner} stopped waiting for the one instrument lock: ${signal} received (nothing was taken)`, "instrument_lock_wait_interrupted");
    this.name = "InstrumentLockWaitInterrupted";
    this.signal = signal;
  }
}

/** The exit code of a door whose wait a signal ended (128 + the signal's number, the shell's convention), or `undefined` for any other error. */
export function interruptedWaitExitCode(error: unknown): number | undefined {
  return error instanceof InstrumentLockWaitInterrupted ? 128 + osConstants.signals[error.signal] : undefined;
}

/**
 * One issue from a schema-validation failure.
 *
 * Declared STRUCTURALLY rather than as a Zod import: `errors.ts` sits at the
 * bottom of the import graph (essentially every module depends on it), so it
 * must not take a dependency on a validation library. Zod's `issue` objects
 * satisfy this shape as-is, and so would any replacement validator.
 */
export type SchemaIssue = Readonly<{
  code?: unknown;
  path?: readonly PropertyKey[];
  /** Offending key names, for `unrecognized_keys`-style issues. */
  keys?: readonly unknown[];
}>;

/**
 * Upper bound on a rendered schema-failure description, in characters. Owned
 * here because this module is the single owner of error FORMATTING; it bounds
 * a diagnostic string rather than configuring behaviour, so it is not an
 * operator-facing knob.
 */
const SCHEMA_FAILURE_DESCRIPTION_MAX_LENGTH = 512;

/** The marker used when a schema issue carries no usable location. */
const SCHEMA_ISSUE_ROOT_PATH = "<root>";

/**
 * Canonical, redaction-safe rendering of schema-validation issues.
 *
 * WHY THIS EXISTS
 *
 * Every `safeParse` failure in this codebase used to be thrown as a bare
 * "does not match the canonical schema" with `result.error` discarded. That
 * turns a one-line fix (a key in the wrong place) into a bisect: the operator
 * is told THAT the document is wrong and never WHICH part. The config loader
 * is the worst case — an unknown key there stops the whole harness from
 * booting with no indication of the key.
 *
 * WHAT IT DELIBERATELY OMITS
 *
 * Only issue PATHS, issue CODES, and offending KEY NAMES are rendered — never
 * the offending VALUES. Paths and key names come from the schema's own
 * vocabulary, so they cannot leak a secret that happened to be stored under
 * one; a validator's default message can embed the received value, which a
 * config or a request body may not be safe to echo.
 */
export function describeSchemaIssues(issues: readonly SchemaIssue[]): string {
  if (issues.length === 0) return "no issues reported";
  const rendered: string[] = [];
  for (const issue of issues) {
    const path = (issue.path ?? []).map((segment) => String(segment)).join(".");
    const location = path.length === 0 ? SCHEMA_ISSUE_ROOT_PATH : path;
    const code = typeof issue.code === "string" ? issue.code : "invalid";
    const keys = (issue.keys ?? []).map((key) => String(key));
    rendered.push(keys.length === 0 ? `${location}: ${code}` : `${location}: ${code} (${keys.join(", ")})`);
  }
  const joined = rendered.join("; ");
  return joined.length <= SCHEMA_FAILURE_DESCRIPTION_MAX_LENGTH
    ? joined
    : `${joined.slice(0, SCHEMA_FAILURE_DESCRIPTION_MAX_LENGTH)}… (${issues.length} issues)`;
}

/**
 * Canonical error-message extractor. Returns `error.message` for `Error`
 * instances and `String(error)` for anything else. This is the single owner
 * of the `error instanceof Error ? error.message : String(error)` pattern so
 * that tool adapters, the tool registry, the provider adapter, the interactive
 * session, and every inline copy consume one implementation instead of
 * re-defining it.
 */
export function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Whether `error` is a system error carrying one of `codes` (`ENOENT`,
 * `EEXIST`, …) — THE one errno predicate (three private copies in
 * persisted-key, durable-filesystem-internal and resource-lock folded in), so
 * a catch can name the condition it expects and rethrow everything else.
 */
export function hasErrorCode(error: unknown, ...codes: readonly string[]): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "string" && codes.includes(error.code);
}

/**
 * Canonical abort-error detector. The tool adapter and the provider adapter
 * both need to recognize cancellation (DOMException `AbortError` name and the
 * Node `ABORT_ERR` code). This is the single owner; consumers import it from
 * here instead of re-defining a byte-identical private copy.
 */
export function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === "AbortError" || (error as { code?: string }).code === "ABORT_ERR";
  }
  return false;
}

/**
 * Canonical safe-error projection for CLI/REPL output. Returns a redacted
 * `{ error, message, retryable }` triple: the error code and retryable flag
 * for `HarnessError` instances, or `internal_error` / `false` for anything
 * else. The message always goes through `extractErrorMessage`. This is the
 * single owner so `cli.ts` and `cli-chat.ts` consume one implementation
 * instead of re-defining byte-identical private copies.
 */
export type SafeError = Readonly<{ error: string; message: string; retryable: boolean }>;

export function safeError(error: unknown): SafeError {
  if (error instanceof HarnessError) {
    return Object.freeze({ error: error.code, message: error.message, retryable: error.retryable });
  }
  return Object.freeze({ error: "internal_error", message: extractErrorMessage(error), retryable: false });
}

/**
 * Source location extracted from an error's stack trace: the first stack
 * frame that points at a real source file (skipping `<anonymous>`,
 * `node:internal`, and native frames). Frames inside `node_modules` are only
 * used when no application frame exists, so a native error surfaced through
 * library code still reports the application call site. `file` is the
 * absolute filesystem path (file: URLs are decoded); consumers that want a
 * repository-relative path relativize against their own root.
 *
 * When the error's own stack carries no source frame, the `cause` chain is
 * walked (cycle-safe) and the first location found wins. This matters for
 * wrapper errors — e.g. the node:test runner's `ERR_TEST_FAILURE` envelope
 * has a frame-less stack while its `cause` (the AssertionError) carries the
 * failing call site.
 */
export type ErrorSourceLocation = Readonly<{
  functionName: string | null;
  file: string | null;
  line: number | null;
  column: number | null;
}>;

const STACK_FRAME_PATTERN = /^\s*at\s+(?:(?<functionName>[^()]+?)\s+)?\(?(?<file>[^()]+?\.(?:[cm]?[tj]s)):(?<line>[0-9]+):(?<column>[0-9]+)\)?\s*$/u;

const EMPTY_SOURCE_LOCATION: ErrorSourceLocation = Object.freeze({ functionName: null, file: null, line: null, column: null });

export function extractErrorSourceLocation(error: unknown): ErrorSourceLocation {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const location = extractOwnStackLocation(current);
    if (location.file !== null) return location;
    current = (current as { cause?: unknown }).cause;
  }
  return EMPTY_SOURCE_LOCATION;
}

function extractOwnStackLocation(error: unknown): ErrorSourceLocation {
  if (!(error instanceof Error) || typeof error.stack !== "string") return EMPTY_SOURCE_LOCATION;
  let fallback: ErrorSourceLocation | null = null;
  for (const frameLine of error.stack.split("\n")) {
    const match = STACK_FRAME_PATTERN.exec(frameLine);
    if (!match || match.groups === undefined) continue;
    const rawFile = match.groups.file!;
    if (rawFile.startsWith("node:")) continue;
    let file = rawFile;
    if (rawFile.startsWith("file://")) {
      try {
        file = fileURLToPath(rawFile);
      } catch (e) {handleError(e, { module: "errors", operation: "catch" });
        // Malformed file: URL in a stack frame — keep the raw text rather
        // than dropping the location entirely.
        file = rawFile;
      }
    }
    const location: ErrorSourceLocation = Object.freeze({
      functionName: match.groups.functionName?.trim() ?? null,
      file,
      line: Number.parseInt(match.groups.line!, 10),
      column: Number.parseInt(match.groups.column!, 10),
    });
    if (!file.includes("/node_modules/") && !file.includes("\\node_modules\\")) return location;
    fallback ??= location;
  }
  return fallback ?? EMPTY_SOURCE_LOCATION;
}

/**
 * Canonical actionable error context for CLI/receipt output: the message
 * (via {@link extractErrorMessage}), the throwing function/file/line/column
 * (via {@link extractErrorSourceLocation}), and the raw stack trace. Every
 * field is `null` when unavailable so the projection is safe for canonical
 * JSON serialization (which rejects `undefined`).
 */
export type ErrorContext = Readonly<{
  message: string;
  /** A typed error's own code (`HarnessError.code`), or null. */
  code: string | null;
  /**
   * A typed error's `safeDetails` — the declared-safe facts it carries (the
   * candidate-format refusal's violation list, a refused source path), or
   * null. Dropping them left "Candidate format rejected" with no word of
   * WHICH file (SEC-b, WF-1c).
   */
  details: Readonly<Record<string, string | number | boolean>> | null;
  function: string | null;
  file: string | null;
  line: number | null;
  column: number | null;
  stack: string | null;
}>;

export function extractErrorContext(error: unknown): ErrorContext {
  const location = extractErrorSourceLocation(error);
  const typed = error instanceof HarnessError ? error : undefined;
  return Object.freeze({
    message: extractErrorMessage(error),
    code: typed?.code ?? null,
    details: typed !== undefined && Object.keys(typed.safeDetails).length > 0 ? typed.safeDetails : null,
    function: location.functionName,
    file: location.file,
    line: location.line,
    column: location.column,
    stack: error instanceof Error && typeof error.stack === "string" ? error.stack : null,
  });
}
