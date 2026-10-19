/**
 * User context — the multi-user authentication + scoping gate (v12).
 *
 * (authentication) + the multi-user task: every protected
 * route MUST call `requireUserContext(ctx, db)` FIRST. It resolves the
 * authenticated user from the `harness_auth` session cookie (token →
 * SHA-256 hash → auth_sessions → user_id → users) and returns the typed
 * user context (`{ userId, username, isAdmin }`). All DB queries that
 * touch user data are then scoped by `userId` — there is NO other path
 * to user data.
 *
 * Design (validated by web research 2026-07-23: OWASP Node.js auth,
 * session-based multi-user, per-user data isolation, row-level scoping):
 * The session cookie stores a random 32-byte token (HttpOnly,
 * SameSite=Lax). The DB stores only its SHA-256 hash (a DB leak does
 * not expose active sessions).
 * Resolution is cached per-request (WeakMap keyed by the IncomingMessage)
 * so the auth middleware (the 401 gate) + the route gate share ONE DB
 * lookup — no double resolution, no per-route overhead.
 * `requireUserContext` throws `AuthError` (HTTP 401) when there is no
 * valid session — the router maps it to a 401 response. The auth
 * middleware in the router is the outer 401 gate; this is the per-route
 * gate (defense-in-depth: a route that forgets to call it is still
 * protected by the middleware, but a route that DOES call it gets the
 * typed userId for scoping).
 *
 * No new deps (built-in node:crypto). No `throw new Error`
 * (typed AuthError).
 */
import type { IncomingMessage } from "node:http";

import { AuthError, ForbiddenError } from "../kernel/errors.ts";
import { hashSessionToken, isSessionExpired, AUTH_COOKIE_NAME } from "./auth.ts";
import { readCookie } from "./session.ts";
import { serverConfig } from "../kernel/config.ts";
import type { AsyncDbClient } from "../db/async-client.ts";
import type { RouteContext } from "../router/router.ts";

/** The authenticated user context — the scoping key for ALL user data. */
export type UserContext = Readonly<{
  readonly userId: string;
  readonly username: string;
  readonly isAdmin: boolean;
}>;

// Per-request resolution cache. Keyed by the IncomingMessage so the auth
// middleware (which has req/res) and the route gate (which has ctx.req)
// share the SAME resolved user — one DB lookup per request, no re-resolution.
const userCache = new WeakMap<IncomingMessage, UserContext | null>();

/** Read the `harness_auth` cookie value from the request, or null. A thin
 * delegate to the single cookie-reader owner (`readCookie` in
 * `server/session.ts`) — there is no second cookie-parse loop here (No
 * Scattered Helpers: cookie reading has one owner; the auth owner reads
 * the auth cookie through the shared parser, not a copy of it). */
export function readAuthCookie(req: IncomingMessage): string | null {
  return readCookie(req, AUTH_COOKIE_NAME);
}

/**
 * Resolve the authenticated user from the request's session cookie. Returns
 * the user context, or null when there is no cookie, no session, an expired
 * session, or no matching user. Pure (no throws) — the callers decide
 * whether null is an error (the middleware → 401; the gate → throws).
 *
 * Caches the result on the request object so a second call (e.g. the route
 * gate after the middleware already resolved) is free — and now that the
 * lookup crosses the async facade, "free" means it never reaches the read
 * pool a second time either. One request, one auth resolution.
 */
export async function resolveAuthUser(
  req: IncomingMessage,
  db: AsyncDbClient,
): Promise<UserContext | null> {
  const cached = userCache.get(req);
  if (cached !== undefined) return cached;
  let resolved: UserContext | null = null;
  const token = readAuthCookie(req);
  if (token !== null && token.length > 0) {
    const tokenHash = hashSessionToken(token);
    const session = await db.getAuthSession(tokenHash);
    if (session !== null && !isSessionExpired(session.created_at, serverConfig.authSessionTtlHours)) {
      const user = await db.getUserById(session.user_id);
      if (user !== null) {
        resolved = {
          userId: user.id,
          username: user.username,
          isAdmin: Number(user.is_admin) === 1,
        };
      }
    }
  }
  userCache.set(req, resolved);
  return resolved;
}

/**
 * The per-route gate. Resolves the authenticated user from the session
 * cookie and returns the typed user context. Throws `AuthError` (HTTP 401)
 * when not authenticated — the router maps it to a 401 response. ALL
 * protected routes MUST call this FIRST and scope every DB query by the
 * returned `userId`. This is the single enforcement point for per-user
 * data isolation.
 */
export async function requireUserContext(
  ctx: RouteContext,
  db: AsyncDbClient,
): Promise<UserContext> {
  const user = await resolveAuthUser(ctx.req, db);
  if (user === null) {
    throw new AuthError("Authentication required. Please log in.", "auth_required");
  }
  return user;
}

/**
 * The admin gate. Resolves the authenticated user AND requires `isAdmin`.
 * Throws `AuthError` (HTTP 401) when not authenticated, `ForbiddenError`
 * (HTTP 403) when authenticated but not an admin. The single enforcement
 * point for global-mutation routes (PUT /api/config, schema actions/
 * customizations) — a regular user must not mutate global harness state.
 * (route registry: privilege gating centralized here, not
 * ad-hoc in each route.)
 */
export async function requireAdminContext(
  ctx: RouteContext,
  db: AsyncDbClient,
): Promise<UserContext> {
  const user = await requireUserContext(ctx, db);
  if (!user.isAdmin) {
    throw new ForbiddenError("Administrator privileges are required for this action.", "admin_required");
  }
  return user;
}

// SPO: the route-level `requireProjectByPath` gate is REMOVED
// (dead code). Project-path ownership is now enforced at the
// BRIDGE choke point (`server/fs-gate.ts` `assertProjectPathOwnership`),
// which every project-scoped bridge (editor, git, git-ops, intelligence,
// awareness, quality) calls when a route passes the `FsGate`. The route-
// level helper was a parallel gate path that bypassed the bridge; removing
// it closes that path (Deny-by-Default — the bridge is the single owner).
// The behavioral contract (ForbiddenError `project_path_not_owned` on a
// path the caller does not own) is preserved at the bridge.
