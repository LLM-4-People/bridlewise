/**
 * Client debug owner — the SINGLE entry point for ALL client-side debug
 * logging, warnings, and error reporting in Svelte components (binding
 * "A proper centralized debug/error system must be implemented
 * and enforced everywhere... everything goes through it. When not in
 * debug mode, ignore debug.").
 *
 * This is the client-side mirror of the server `webWarn`/`webDebugLog`
 * bridge (server/debug-bridge.ts). The browser cannot import the canonical
 * backend debug system (it is Node-specific), so this module provides a
 * lightweight, self-contained, zero-overhead owner that enforces the
 * SAME contract: every `console.warn`/`console.error`/`console.log` in a
 * `.svelte` component goes through HERE — never directly. This gives:
 *
 * ONE named owner of the client debug surface.
 * Zero overhead when off (the `enabled` guard returns immediately —
 * no string formatting, no argument allocation). "when not
 * in debug mode, zero overhead."
 * A future settings toggle can call `configureClientDebug`
 * to turn client debug on/off from the web UI without touching any
 * component.
 * Consistent, attributable output (every line carries its category so
 * the source module is identifiable in the console).
 *
 * Usage in a component:
 * import { clientWarn } from "../shared/client-debug";
 * clientWarn("chat", "beginChatRun failed:", err);
 *
 * The default is OFF (zero overhead). Enable explicitly:
 * import { configureClientDebug } from "../shared/client-debug";
 * configureClientDebug({ enabled: true }); // e.g. from a settings toggle
 */

/** Debug category = the source module name (e.g. "chat", "timeline",
 * "graph", "sidebar"). Makes every debug line attributable in the console. */
export type ClientDebugCategory = string;

/** Debug level. Mirrors the backend DebugMessageLevel union. */
export type ClientDebugLevel = "debug" | "info" | "warn" | "error";

/** Configuration for the client debug system. */
export interface ClientDebugConfig {
  /** Master switch. When false, EVERY call returns immediately (zero
   * overhead). Default false. */
  enabled: boolean;
  /** Optional category allow-list. When non-empty, only messages whose
   * category is in the list are emitted (a deny-by-default filter —
   * rule: explicit-add). When empty, all categories pass. Default []. */
  categories: readonly ClientDebugCategory[];
}

/** The live config (module-private — mutated only via
 * `configureClientDebug`). Defaults to OFF (zero overhead). */
let config: ClientDebugConfig = {
  enabled: false,
  categories: [],
};

/** Whether a category passes the category filter (deny-by-default when the
 * allow-list is non-empty — explicit-add). */
function categoryAllowed(category: ClientDebugCategory): boolean {
  const cats = config.categories;
  return cats.length === 0 || cats.includes(category);
}

/** Configure the client debug system. Called once (e.g. from a settings
 * toggle or a bootstrap read of a localStorage flag). Before
 * this is called with `enabled: true`, every `clientWarn`/`clientError`/
 * `clientLog` is a no-op (zero overhead). */
export function configureClientDebug(cfg: Partial<ClientDebugConfig>): ClientDebugConfig {
  config = {
    enabled: cfg.enabled ?? false,
    categories: cfg.categories ?? [],
  };
  return config;
}

/** Reset to the unconfigured no-op state (for tests). */
export function resetClientDebug(): void {
  config = { enabled: false, categories: [] };
}

/** Whether the client debug system is currently emitting. */
export function isClientDebugEnabled(): boolean {
  return config.enabled;
}

/** Emit a warn-level message. Zero-overhead when the system is off. */
export function clientWarn(
  category: ClientDebugCategory,
  ...args: unknown[]
): void {
  if (!config.enabled || !categoryAllowed(category)) return;
  console.warn(`[${category}]`, ...args);
}

/** Emit an error-level message. Zero-overhead when the system is off.
 * Error-level is for genuine component-level failures (a run cancel
 * failed, a worker terminate failed) — NOT for user-facing errors,
 * which go through `clientErrorMessage` from error-messages.ts. */
export function clientError(
  category: ClientDebugCategory,
  ...args: unknown[]
): void {
  if (!config.enabled || !categoryAllowed(category)) return;
  console.error(`[${category}]`, ...args);
}

/** Emit a debug/info-level message. Zero-overhead when the system is off.
 * Use for diagnostic tracing that should NEVER appear in production
 * (e.g. "worker resize failed — non-fatal"). */
export function clientLog(
  category: ClientDebugCategory,
  ...args: unknown[]
): void {
  if (!config.enabled || !categoryAllowed(category)) return;
  console.log(`[${category}]`, ...args);
}
