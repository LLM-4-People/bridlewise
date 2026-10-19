/**
 * Session management — multi-user isolation via session cookies.
 *
 * Each browser gets a session ID (random UUID) stored in a cookie. The
 * server uses this ID to scope project/chat data so multiple users can
 * work concurrently without seeing each other's data (unless they share
 * a project via a NULL session_id, which is the legacy/shared default).
 *
 * The session ID is:
 * - Read from the `harness_session` cookie on every request.
 * - If missing, a new UUID is generated and set as a cookie.
 * - Stored in the `session_id` column of the `projects` table.
 *
 * Session IDs are NOT authentication — they are isolation scoping. Any
 * user who knows a session ID can access its data (the server binds to
 * 127.0.0.1 only, so this is a local development tool).
 */


import type { IncomingMessage, ServerResponse } from "node:http";

import { serverConfig } from "../kernel/config.ts";
// Raw uniqueness through the canonical owner — a session id doubles as a
// bearer token, so it stays a bare UUID (the owner's randomUuid, never a
// direct node:crypto import).
import { randomUuid } from "../kernel/canonical.ts";

export const SESSION_COOKIE_NAME = "harness_session";

/**
 * The rotation-marker cookie name. Stored alongside the session cookie; its
 * value is the creation timestamp (ms) used to decide when to rotate the
 * session ID. A named constant (not a magic string) so the read + the
 * Set-Cookie sites cannot drift on the cookie name.
 */
export const SESSION_CREATED_COOKIE_NAME = "harness_session_created";

// UNMENTIONED #5: Session rotation. When the session age exceeds this
// threshold (configurable via HARNESS_WEB_SESSION_ROTATION_HOURS), the
// session ID is rotated to a new UUID. This limits the impact of a leaked
// cookie — a stolen session ID is only valid until the next rotation.
// Default: 24 hours (1 day). Set to 0 to disable rotation.
//
// Read at CALL time (not import time) so a `resetServerConfig()` re-resolve
// is reflected here — capturing the value at import time would freeze a
// stale snapshot (the config-lazy isolation contract).
function sessionRotationMs(): number {
  const hours = serverConfig.sessionRotationHours;
  return hours > 0 ? hours * 60 * 60 * 1000 : 0;
}

/**
 * The cookie attribute string for the anonymous `harness_session` cookie.
 * the `Secure` flag is appended when the configured
 * origin is HTTPS (`serverConfig.cookieSecure`), matching the auth cookie
 * — previously this cookie had NO Secure flag (a prod leak over HTTPS).
 * The max-age is owned by `serverConfig.sessionCookieMaxAgeSeconds`
 * (previously an inline one-year literal here, now a config field).
 */
function sessionCookieAttributes(maxAgeSeconds: number): string {
  const parts = ["HttpOnly", "SameSite=Lax", `Path=/`, `Max-Age=${maxAgeSeconds}`];
  if (serverConfig.cookieSecure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Set the anonymous-session cookie pair (the session ID + the rotation
 * marker) on the response via `appendHeader` (not `setHeader`). The auth
 * owner (`server/auth.ts::setAuthCookie`) ALSO uses `appendHeader` so a
 * login response carries both the session cookie AND the auth cookie
 * without either overwriting the other (No Scattered Helpers: the
 * Set-Cookie mechanism is consistent across cookie owners — `appendHeader`
 * adds, never replaces, so call order cannot drop a cookie).
 */
function setSessionCookies(res: ServerResponse, sessionId: string): void {
  if (res.headersSent) return;
  const attrs = sessionCookieAttributes(serverConfig.sessionCookieMaxAgeSeconds);
  res.appendHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=${sessionId}; ${attrs}`);
  res.appendHeader("Set-Cookie", `${SESSION_CREATED_COOKIE_NAME}=${Date.now()}; ${attrs}`);
}

/**
 * Read the session ID from the request cookie, or generate a new one.
 * If a new one is generated, set it as a cookie on the response.
 */
export function resolveSessionId(
  req: IncomingMessage,
  res: ServerResponse,
): string {
  const existing = readCookie(req, SESSION_COOKIE_NAME);
  if (existing !== null) {
    // Check if the session needs rotation (age-based). The rotation marker
    // is stored as a second cookie (SESSION_CREATED_COOKIE_NAME).
    const createdRaw = readCookie(req, SESSION_CREATED_COOKIE_NAME);
    const created = createdRaw !== null ? Number(createdRaw) : 0;
    const rotationMs = sessionRotationMs();
    if (rotationMs > 0 && created > 0 && Date.now() - created > rotationMs) {
      // Rotate: generate a new session ID and update the cookie.
      const newSessionId = randomUuid();
      setSessionCookies(res, newSessionId);
      return newSessionId;
    }
    return existing;
  }

  const sessionId = randomUuid();
  // Set the cookie on the response so the browser stores it.
  // HttpOnly: not accessible via JS (prevents XSS theft).
  // SameSite=Lax: prevents CSRF.
  // Path=/: applies to all routes.
  // Secure (when HTTPS): not sent over plain HTTP.
  // Also set a creation timestamp cookie for session rotation.
  setSessionCookies(res, sessionId);
  return sessionId;
}

/**
 * Read a cookie value from the request by name. Returns null when the
 * cookie header is absent or the named cookie is not present.
 *
 * Single owner of cookie READING (No Scattered Helpers: cookie/session
 * operations have one owner). Both the anonymous-session reader
 * (`resolveSessionId` here) and the auth-cookie reader
 * (`readAuthCookie` in `server/user-context.ts`) go through this ONE
 * parser — there is no second `req.headers.cookie.split(";")` loop
 * elsewhere. A new cookie reader MUST call this, never re-implement the
 * parse loop (the prevention test `no-scattered-helpers` pins that
 * `req.headers.cookie` is read directly in exactly ONE file).
 */
export function readCookie(req: IncomingMessage, name: string): string | null {
  const cookieHeader = req.headers.cookie;
  if (cookieHeader === undefined) return null;
  const cookies = cookieHeader.split(";");
  for (const cookie of cookies) {
    const trimmed = cookie.trim();
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key === name) return value;
  }
  return null;
}
