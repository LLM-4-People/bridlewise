/**
 * CSRF guard — stateless same-origin + custom-header protection for the
 * API-only backend.
 *
 * Threat model. The dashboard authenticates with an HttpOnly session cookie
 * (`harness_auth`, set by routes/auth.ts). Cookies are sent automatically by
 * the browser on every same-site request, so a cross-site form POST to
 * `/api/projects` would carry the victim's cookie and create a project on
 * the attacker's behalf — a classic CSRF. The guard blocks this.
 *
 * Defense (OWASP CSRF Prevention Cheat Sheet — "Verifying Origin With
 * Referer Fallback" + "Custom Request Headers"). For unsafe methods
 * (POST/PUT/PATCH/DELETE) the request must satisfy ONE of:
 *
 * 1. SAME-ORIGIN: the `Origin` header (or `Referer` fallback) host matches
 * the configured allowed origin. Browsers always send `Origin` on
 * POST/PUT/PATCH/DELETE; a cross-site attacker's origin will not match.
 * When `Origin` is absent, `Referer` is checked (same-origin policy).
 * 2. CUSTOM HEADER: the request carries a custom header
 * (`X-Requested-With`, any value). A cross-site form POST cannot set
 * custom headers without triggering a CORS preflight, which the
 * single-origin CORS policy (server/index.ts) blocks. This path lets
 * non-browser clients (curl, tests) opt in by sending the header.
 *
 * Either defense alone is sufficient; requiring BOTH would break legitimate
 * same-origin browser fetches (the Vite dev client sets `Content-Type` but
 * not `X-Requested-With` by default, and the browser's `fetch` always sends
 * `Origin` for unsafe methods). The OR is the OWASP-recommended stateless
 * pattern for an API that uses cookie auth.
 *
 * Safe methods (GET/HEAD/OPTIONS) are exempt — they must not mutate state
 * (the router enforces this by convention), and exempting them keeps the
 * boot burst + SSE + preflight unblocked.
 *
 * Zero new dependencies. The allowed origin is the existing
 * `serverConfig.allowedOrigin` (the single source of truth). The
 * custom-header name is a security invariant, not a tunable, so it lives
 * here as a constant (not in the config file).
 */

import type { IncomingMessage } from "node:http";
import { serverConfig } from "../kernel/config.ts";
import { CSRF_CUSTOM_HEADER } from "../../shared/constants.ts";
import { CsrfError } from "../kernel/errors.ts";

// Re-export so existing `import { CSRF_CUSTOM_HEADER } from
// "../csrf.ts"` call sites (server tests, the route registry) keep
// resolving — the canonical owner is now `shared/constants.ts`
// (Single-Party-Owner the client fetch wrapper imports the same
// constant so the server + client cannot drift on the header name).
export { CSRF_CUSTOM_HEADER };

/** HTTP methods that must not mutate state and are exempt from CSRF checks. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Whether a request method is "safe" (idempotent / non-mutating) and thus
 * exempt from the CSRF check. Exported for the route-consistency test.
 */
export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

/**
 * Extract the effective origin of an incoming request: the `Origin` header
 * first, falling back to `Referer` (per OWASP). Returns null when neither is
 * present (a non-browser request, or a browser that stripped both).
 */
function requestOrigin(req: IncomingMessage): string | null {
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.length > 0) return origin;
  const referer = req.headers.referer;
  if (typeof referer === "string" && referer.length > 0) return referer;
  return null;
}

/**
 * Compare an origin URL's host to the configured allowed origin's host.
 * Only the host (hostname:port) is compared — the scheme is NOT checked
 * because a same-origin request may legitimately arrive over HTTP (dev) or
 * HTTPS (prod) and the allowed-origin literal encodes one scheme; comparing
 * hosts is the robust same-origin check (OWASP: "verify that the hostname
 * in the Referer header matches the target origin"). A null/invalid
 * candidate never matches.
 */
function sameHost(candidate: string, allowed: string): boolean {
  let candHost: string;
  let allowedHost: string;
  try {
    candHost = new URL(candidate).host;
    allowedHost = new URL(allowed).host;
  } catch {
    return false;
  }
  return candHost.length > 0 && candHost === allowedHost;
}

/**
 * Whether the request carries the custom CSRF header (any non-empty value).
 * Header names are case-insensitive (Node lowercases them).
 */
function hasCustomHeader(req: IncomingMessage): boolean {
  const v = req.headers[CSRF_CUSTOM_HEADER];
  return typeof v === "string" ? v.length > 0 : Array.isArray(v) && v.length > 0;
}

/**
 * Check CSRF protection for an incoming request. Returns normally (void)
 * when the request is allowed (safe method, same-origin, or custom-header
 * present); THROWS `CsrfError` (HTTP 403) when the request is blocked.
 *
 * Call this in the router's dispatch BEFORE the route handler runs (after
 * the auth gate so 401 takes precedence over 403). The router catches the
 * thrown `CsrfError` + maps it to the 403 response via the centralized
 * error-mapping choke point (`statusForError` + `errorBody`) —
 * Single-Party-Owner ( -V8): the guard THROWS instead of
 * writing its own 403, so the router owns ALL error responses (consistent
 * with / routes + guards throw, the router maps).
 */
export function checkCsrf(req: IncomingMessage): void {
  const method = req.method ?? "GET";
  if (isSafeMethod(method)) return;
  // Defense 1: same-origin (Origin / Referer fallback).
  const origin = requestOrigin(req);
  if (origin !== null && sameHost(origin, serverConfig.allowedOrigin)) {
    return;
  }
  // Defense 2: custom header (non-browser clients opt in).
  if (hasCustomHeader(req)) {
    return;
  }
  // Blocked. The error code is stable for the prevention test + client
  // diagnostics. A 403 (not 401) signals "you are authenticated but this
  // request is forbidden as a CSRF" — distinct from auth failures. The
  // router maps the thrown CsrfError to the 403 response body.
  throw new CsrfError(
    "Cross-site request blocked: missing same-origin header or custom request header.",
    "csrf_blocked",
  );
}
