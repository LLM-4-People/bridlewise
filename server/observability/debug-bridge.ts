/**
 * Web-server debug bridge — the single entry point for ALL debug logging,
 * warnings, and error handling in the web UI server.
 *
 * This is a THIN ADAPTER over the canonical harness debug system
 * (`integration/src/shared/debug/debug-system.ts`) — the web server does
 * NOT reimplement logging. The backend system already provides:
 * `debugLog` — zero-overhead when disabled (the `context` thunk is never
 * evaluated when the system is off — "when not in debug mode,
 * zero overhead").
 * `handleError` — central error classification (typed code, retryable,
 * source location) + redaction + dedup; never swallows.
 * `auditEvent` — the always-on safety floor.
 *
 * ZERO OVERHEAD BY DEFAULT. The web server process never calls
 * `configureWebDebug`, so the backend singleton stays in its `NO_OP_SYSTEM`
 * state: every `webDebugLog`/`webWarn`/`webHandleError` call returns
 * IMMEDIATELY at the `if (!s.configured)` guard (no string formatting, no
 * object allocation, no thunk evaluation). This is the zero-overhead contract:
 * "when debug mode is OFF, zero overhead." The debug system is enabled
 * explicitly via `configureWebDebug` (e.g. from a future settings toggle or
 * an env-driven bootstrap), at which point the console sink emits to stderr.
 *
 * Why a bridge instead of importing the backend functions directly at each
 * call site: (1) one import for the web server (the bridge is the single
 * named owner of the debug surface); (2) the web server's error
 * CONTEXT shape (`{ module, operation,... }`) is named here once; (3) a
 * future change to the debug surface changes one file, not every route.
 *
 * "No swallowed catches / `throw new Error(...)`." Every catch
 * block in the web server must call `webHandleError` (or `webWarn`) or
 * rethrow as a typed error. The `no-empty-catch` prevention test enforces
 * this mechanically; this bridge gives those catches a real, zero-overhead
 * destination.
 */

import {
  debugLog as backendDebugLog,
  handleError as backendHandleError,
  auditEvent as backendAuditEvent,
  reportAlwaysOn as backendReportAlwaysOn,
  configureDebugSystem,
  resetDebugSystem,
  getDebugSignals,
  createConsoleSink as backendCreateConsoleSink,
  type DebugContextThunk,
  type DebugMessageLevel,
  type DebugConfig,
  type DebugSink,
} from "../../engine/src/shared/debug/debug-system.ts";
// The section's schema + defaults are hub-owned values (the hub re-exports
// the debug config module, so the bridge reaches them only through it —
// a second import path would bypass the hub's re-export decisions).
import { DEBUG_CONFIG_DEFAULTS, DEBUG_CONFIG_SCHEMA } from "../kernel/canonical.ts";
import { ConfigError } from "../kernel/errors.ts";

/** Re-export the canonical console sink so the web-server bootstrap can
 * attach it without importing the backend module directly (single-named
 * debug surface). Writes structured debug events to stderr. */
export function createConsoleSink(): DebugSink {
  return backendCreateConsoleSink();
}

/**
 * Emit a debug message at the given category/level. The `context` thunk is
 * ONLY evaluated when the system is configured AND the level/category pass
 * their filters — otherwise this returns immediately (zero overhead).
 *
 * Categories mirror the web-server module names (e.g. "run", "mcp-runtime",
 * "auto-heal") so debug output is attributable to its source module.
 */
export function webDebugLog(
  category: string,
  level: DebugMessageLevel,
  message: string,
  context?: DebugContextThunk,
): void {
  backendDebugLog(category, level, message, context);
}

/**
 * Emit a warning-level debug message. The canonical destination for
 * best-effort failure logging in the web server (catch blocks that must not
 * break the request but should be visible when debug is on). Zero overhead
 * when the system is unconfigured.
 */
export function webWarn(
  category: string,
  message: string,
  context?: DebugContextThunk,
): void {
  backendDebugLog(category, "warn", message, context);
}

/**
 * Central error handler. Extracts the typed error code, retryable flag, and
 * source location; emits a structured error event; increments the
 * error-count signal. Does NOT swallow — the caller decides whether to
 * rethrow, return, or continue. Zero overhead when the system is
 * unconfigured (the canonical `handleError` returns at the `!configured`
 * guard before any extraction).
 */
export function webHandleError(
  error: unknown,
  context: { module: string; operation: string; readonly [key: string]: unknown },
): void {
  backendHandleError(error, context);
}

/**
 * Record an audit event (the safety floor — recorded when `audit.enabled`
 * is true, INDEPENDENT of the master `enabled` switch). Use for
 * security-relevant web-server events (auth login/logout, tool dispatch,
 * config change).
 */
export function webAuditEvent(
  type: string,
  data: Readonly<Record<string, unknown>> = {},
): void {
  backendAuditEvent(type, data);
}

/**
 * An ALWAYS-ON report (the debug system's `reportAlwaysOn`): an event the
 * operator must see whatever the debug switch says — a database thread lost
 * or restarted, a restart circuit opening. One redacted record: through the
 * configured sinks, or one stderr line when none is configured. Use it only
 * for rare, operationally significant events; it is never zero-overhead.
 */
export function webAlwaysOn(
  category: string,
  message: string,
  context: Readonly<Record<string, unknown>> = {},
): void {
  backendReportAlwaysOn(category, message, context);
}

/** The web-server debug categories (module names that emit debug/warn/error).
 * When `configureWebDebug` is called WITHOUT an explicit `categories`
 * override, these are the default allow-list — so a plain
 * `configureWebDebug({ enabled: true })` actually emits (the backend's
 * default `categories: []` would block everything). The list is the FULL set
 * of category literals the server's own `webWarn`/`webHandleError` call sites
 * emit, and the debug-owner census derives that set from the sources and reds
 * when a call site appears that the list does not cover — a hand list here
 * rotted before (six names while the server emitted ~30, silently
 * category-suppressing the rest), so the list is now held to the call sites
 * mechanically rather than by memory. */
const DEFAULT_WEB_DEBUG_CATEGORIES = [
  "agent-runtime-bridge",
  "atomic-write",
  "auto-check-runner",
  "auto-heal",
  "blocks",
  "db",
  "db-crypto",
  "dedup-bridge",
  "editor-bridge",
  "file-tree",
  "git-bridge",
  "harness-config",
  "history-cursor",
  "intelligence",
  "landlock",
  "llm",
  "llm-bridge",
  "mcp-bridge",
  "mcp-runtime",
  "memory",
  "migration",
  "process",
  "rewind",
  "router",
  "run",
  "run-feed",
  "safety-runtime",
  "sse",
  "timeline-bridge",
  "tool",
  "tool-executor",
  "tools-bridge",
  "ui-schema",
  "worker-pool",
] as const;

/**
 * Configure the web-server debug system. Called once at startup (when
 * debug is enabled — e.g. via an env flag or a future settings toggle).
 * Before this is called, every `webDebugLog`/`webWarn`/`webHandleError` is
 * a no-op (zero overhead). When called, attaches a console sink
 * (stderr) so debug output is visible.
 *
 * ── ⚠ THIS DOOR CAST INSTEAD OF PARSING, AND IT WAS THE WHOLE POLICY ──────
 *
 * The body was a spread followed by `as DebugConfig`. A TypeScript assertion
 * is not a check: `Partial<DebugConfig>` came in, was merged over the
 * defaults, and went to `configureDebugSystem` with NOTHING having validated
 * it. DRIVEN across the repo boundary against the harness redactor, one
 * `webDebugLog` per case, presence by deep reachability scan:
 *
 *   shipped policy                     → canary GONE
 *   caller sets forbiddenPatterns: []  → CANARY SURVIVES, both counters +0
 *   caller sets redaction.enabled:false→ CANARY SURVIVES, both counters +0
 *   caller sets level: "NOT-A-LEVEL"   → ACCEPTED without complaint
 *
 * The sink surface was bounded — a branded `DebugSink`, a module-private
 * `WeakSet` refusing spread copies, a total implementation map — and the
 * entire REDACTION POLICY was unbounded. The strong half of the door was
 * guarding the wrong side.
 *
 * TWO CHANGES, AND THEY ANSWER DIFFERENT HALVES:
 *
 *  1. PARSE, DO NOT CAST. The merged object goes through
 *     `DEBUG_CONFIG_SCHEMA.parse`, which is the same `strictObject` the
 *     harness validates `bridlewise.config.json` with. `level:
 *     "NOT-A-LEVEL"` is now a `ZodError` naming the field, an unknown key is
 *     refused rather than carried, and the returned value is the PARSED one
 *     so a caller inspecting the result sees what was installed.
 *
 *  2. DENY BY DEFAULT ON THE REDACTION POLICY. Parsing alone would still
 *     honour `redaction.enabled: false` — a well-typed instruction to turn
 *     the control off. A debug bridge for a web server has no legitimate
 *     reason to disable credential redaction, so it is REFUSED rather than
 *     obeyed, loudly, before the system is configured.
 *
 *     Note what is NOT needed here any more: emptying the key-name list. That
 *     attack no longer exists to defend against, because the harness redactor
 *     now derives its vocabulary from `secret-signals.ts` in code and the
 *     config field only ADDS to it. A caller passing an empty array gets the
 *     full policy — the defence is structural, one repository away, and this
 *     door does not have to know about it.
 *
 * `baseConfig` overrides the canonical defaults (`DEBUG_CONFIG_DEFAULTS`);
 * when omitted, the defaults are used with `enabled: true` so a plain
 * `configureWebDebug` call turns debug on. When `baseConfig.categories` is
 * omitted, the default web-server module allow-list is used (the backend's
 * empty-array default would block all emission).
 *
 * @returns the PARSED config actually installed.
 * @throws {ConfigError} (`debug_redaction_required`) when the policy would
 *   disable redaction (deny by default).
 * @throws {ZodError} when any field fails the canonical schema.
 */
export function configureWebDebug(
  baseConfig?: Partial<DebugConfig>,
  sinks?: ReadonlyArray<DebugSink>,
): DebugConfig {
  const merged = {
    ...DEBUG_CONFIG_DEFAULTS,
    ...baseConfig,
    enabled: baseConfig?.enabled !== false,
    categories: baseConfig?.categories ?? [...DEFAULT_WEB_DEBUG_CATEGORIES],
    redaction: { ...DEBUG_CONFIG_DEFAULTS.redaction, ...baseConfig?.redaction },
  };

  // Deny by default, and BEFORE the parse rather than after: a policy that
  // switches the credential redactor off is refused whether or not the rest
  // of it is well-formed. Checked on the MERGED value, so omitting the field
  // inherits the shipped `true` and only an explicit `false` is refused.
  if (!merged.redaction.enabled) {
    throw new ConfigError(
      "configureWebDebug: refusing a debug policy with redaction.enabled=false — " +
      "the web debug bridge may not disable credential redaction (deny by default).",
      "debug_redaction_required",
    );
  }

  const cfg = DEBUG_CONFIG_SCHEMA.parse(merged);
  const allSinks = sinks !== undefined && sinks.length > 0 ? sinks : [];
  configureDebugSystem(cfg, allSinks);
  webDebugConfigured = true;
  return cfg;
}

/** Reset the debug system to the unconfigured no-op state (for tests). */
export function resetWebDebug(): void {
  resetDebugSystem();
  webDebugConfigured = false;
}

/** @returns the live debug signal counters (a snapshot copy). Zero before
 * configuration. */
export function getWebDebugSignals(): ReturnType<typeof getDebugSignals> {
  return getDebugSignals();
}

/** Whether the web-server debug system has been configured (emitting).
 * False until `configureWebDebug` is called (the zero-overhead default). */
let webDebugConfigured = false;
export function isWebDebugEnabled(): boolean {
  return webDebugConfigured;
}

/**
 * Always-on informational output to stdout (NOT gated by debug mode).
 * The single owner of always-on process console output — a startup
 * banner, a one-time "server is up" message, etc. This is NOT debug
 * logging (which is zero-overhead when off); it is unconditional
 * informational output that the operator should always see.
 *
 * Single-Party-Owner: the debug bridge owns ALL process
 * console output — debug logging (webWarn/webDebugLog, zero-overhead
 * when off) AND always-on informational output (webConsoleInfo). No
 * `console.log`/`process.stdout.write` should appear outside this
 * module.
 */
export function webConsoleInfo(message: string): void {
  process.stdout.write(`${message}\n`);
}

/**
 * Always-on error output to stderr (NOT gated by debug mode). The single
 * owner of always-on process-level FATAL error output — an uncaught
 * exception or unhandled rejection that escapes all try/catch blocks. This
 * is NOT debug logging (which is zero-overhead when off); it is
 * unconditional error output that the operator must ALWAYS see (a fatal
 * error that is silent in production is undebuggable).
 *
 * Single-Party-Owner: the debug bridge owns ALL process console output —
 * debug logging (webWarn/webDebugLog, zero-overhead when off), always-on
 * informational output (webConsoleInfo, stdout), AND always-on fatal error
 * output (webConsoleError, stderr). No `process.stderr.write` should appear
 * outside this module.
 */
export function webConsoleError(message: string): void {
  process.stderr.write(`${message}\n`);
}
