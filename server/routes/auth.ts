/**
 * Auth routes — multi-user authentication (v12; authentication, no
 * third party — scrypt + HttpOnly session cookie).
 *
 * Replaces the legacy single shared password with per-user accounts
 * (username + password). The FIRST registered user becomes the admin;
 * subsequent users are regular users. Every session is linked to a user_id
 * (the scoping key for all user data — see server/user-context.ts).
 *
 * Routes (all PUBLIC — no auth required to access these):
 * GET /api/auth/status — { setupRequired, authenticated, username?, isAdmin? }
 * POST /api/auth/register — { username, password } → create user (first=admin) +
 * create session → set cookie. 409 on username collision.
 * POST /api/auth/login — { username, password } → verify → create session → set cookie
 * POST /api/auth/logout — destroy session → clear cookie
 * POST /api/auth/change-password — require a valid session + currentPassword → verify → set new
 *
 * Security:
 * Passwords hashed with scrypt (per-password salt) before storage; the
 * hash is encrypted at rest (DbCrypto). Never plaintext.
 * The login error is identical for "unknown user" and "wrong password"
 * (no username enumeration via timing or message).
 * change-password requires BOTH a valid session (defense-in-depth) AND
 * the current password (identity gate) — a stolen session alone OR a
 * stolen password alone cannot rotate it.
 * The auth middleware (in the router) protects every other route. These
 * routes are the gate. register/login create sessions, logout destroys
 * them, change-password rotates the user's password.
 */
import type { Router, RouteContext } from "../router/router.ts";
import { sendJson } from "../router/router.ts";
import { z } from "zod";
import type { AsyncDbClient } from "../db/async-client.ts";
import {
  hashPassword,
  verifyPassword,
  createSessionToken,
  hashSessionToken,
  setAuthCookie,
  clearAuthCookie,
  DUMMY_PASSWORD_HASH,
} from "../auth/auth.ts";
import { AuthError, ConflictError } from "../kernel/errors.ts";
import { DEFAULT_PASSWORD_MIN_LENGTH } from "../kernel/config.ts";
import { webAuditEvent } from "../observability/debug-bridge.ts";
import {
  resolveAuthUser,
  readAuthCookie,
  type UserContext,
} from "../auth/user-context.ts";
import { USER_REGISTER_INPUT, USER_LOGIN_INPUT } from "../db/schema.ts";

// ── Shared helpers ──

/** Whether the request carries a valid (non-expired) auth session cookie.
 * Reused by the change-password route (defense-in-depth session check) +
 * the status route. Uses the cached resolver so it is free after the
 * middleware already resolved the user. */
async function currentUser(
  req: RouteContext["req"],
  db: AsyncDbClient,
): Promise<UserContext | null> {
  return resolveAuthUser(req, db);
}

/** Create a session for a user + set the cookie. Shared by register + login.
 * The Set-Cookie is owned by the auth owner (`server/auth.ts::setAuthCookie`)
 * the route never builds a Set-Cookie value itself (SPO: response
 * headers have one owner per domain). */
async function establishSession(
  ctx: RouteContext,
  db: AsyncDbClient,
  userId: string,
): Promise<void> {
  const token = createSessionToken();
  const tokenHash = hashSessionToken(token);
  // ctx.sessionId is the anonymous browser session (harness_session cookie)
  // — kept as audit metadata on the auth session (rate-limit keying). The
  // user_id is the scoping key.
  await db.createAuthSession(tokenHash, userId, ctx.sessionId);
  setAuthCookie(ctx.res, token);
}

export function registerAuthRoutes(router: Router, db: AsyncDbClient): void {
  // ── GET /api/auth/status ──
  // setupRequired = NO users registered yet (the new "setup" state). When
  // authenticated, also returns the username + admin flag so the UI can
  // render the logged-in user.
  router.get("/api/auth/status", async (ctx) => {
    const setupRequired = await db.countUsers() === 0;
    const user = await currentUser(ctx.req, db);
    sendJson(ctx.res, {
      setupRequired,
      authenticated: user !== null,
      ...(user !== null ? { username: user.username, isAdmin: user.isAdmin } : {}),
    });
  });

  // ── POST /api/auth/register ──
  // Create a user (the FIRST becomes the admin). Username collisions map to
  // 409 (the typed error code; the router maps AuthError→401, so collisions
  // use a dedicated ConflictError below). After creating the user, establish
  // a session (register = setup + login combined, matching the old setup UX).
  //
  // Deny-by-default: open registration is allowed ONLY during setup (no
  // users yet). After the first user is created, an anonymous caller can no
  // longer register — only an authenticated admin can add new users (so a
  // logged-in admin creates accounts, but an attacker who reaches the server
  // cannot self-register). This closes the open-registration hole where
  // anyone could create a non-admin account at any time after setup.
  router.post("/api/auth/register", async (ctx) => {
    if (await db.countUsers() > 0) {
      // Setup is complete — require an authenticated admin to create new users.
      const actor = await currentUser(ctx.req, db);
      if (actor === null || !actor.isAdmin) {
        throw new AuthError(
          "Registration is closed. Ask an administrator to create your account.",
          "registration_closed",
        );
      }
    }
    const input = USER_REGISTER_INPUT.parse(ctx.body);
    // Username uniqueness: check first for a clear 409 (the UNIQUE index
    // would also reject, but mapping a raw SQLite constraint error to 409
    // is fragile; an explicit check gives a precise message).
    if (await db.getUserByUsername(input.username) !== null) {
      throw new ConflictError(`Username '${input.username}' is already taken.`, "auth_username_taken");
    }
    const passwordHash = await hashPassword(input.password);
    const user = await db.createUser(input.username, passwordHash);
    await establishSession(ctx, db, user.id);
    webAuditEvent("auth.register", { session: ctx.sessionId, username: user.username, admin: Number(user.is_admin) === 1 });
    sendJson(ctx.res, {
      ok: true,
      authenticated: true,
      username: user.username,
      isAdmin: Number(user.is_admin) === 1,
    });
  });

  // ── POST /api/auth/login ──
  // Verify username + password → create session → set cookie. The error is
  // IDENTICAL for an unknown user and a wrong password (no enumeration).
  router.post("/api/auth/login", async (ctx) => {
    const input = USER_LOGIN_INPUT.parse(ctx.body);
    const user = await db.getUserByUsername(input.username);
    // Always run verifyPassword so the timing for an unknown user matches
    // the timing for a wrong password (mitigates user enumeration via
    // response timing). When the user is unknown, verify against a dummy
    // hash (a pre-computed scrypt hash of a random value).
    //
    // IMPORTANT: verifyPassword MUST be called unconditionally — the prior
    // code used `user !== null && await verifyPassword(...)` which SHORT-
    // CIRCUITS: for an unknown user the `&&` skips verifyPassword entirely,
    // so the unknown-user path is far faster than the wrong-password path
    // (no scrypt cost), a clear timing oracle for user existence. The fix
    // computes the password check FIRST (always paying the scrypt cost),
    // then combines it with the user-existence check.
    const storedHash = user !== null ? user.password_hash : DUMMY_PASSWORD_HASH;
    const passwordOk = await verifyPassword(input.password, storedHash);
    const valid = user !== null && passwordOk;
    if (!valid) {
      webAuditEvent("auth.login_failed", { session: ctx.sessionId, username: input.username });
      throw new AuthError("Invalid username or password", "auth_invalid_credentials");
    }
    await establishSession(ctx, db, user.id);
    webAuditEvent("auth.login_success", { session: ctx.sessionId, username: user.username });
    sendJson(ctx.res, {
      ok: true,
      authenticated: true,
      username: user.username,
      isAdmin: Number(user.is_admin) === 1,
    });
  });

  // ── POST /api/auth/logout ──
  router.post("/api/auth/logout", async (ctx) => {
    const cookie = readAuthCookie(ctx.req);
    if (cookie !== null) {
      await db.deleteAuthSession(hashSessionToken(cookie));
    }
    webAuditEvent("auth.logout", { session: ctx.sessionId });
    clearAuthCookie(ctx.res);
    sendJson(ctx.res, { ok: true, authenticated: false });
  });

  // ── POST /api/auth/change-password ──
  // Requires:
  // 1. A valid (non-expired) session cookie — defense-in-depth:
  // the route is middleware-exempt, so it checks the session ITSELF so a
  // leaked current password without the browser session cannot rotate it.
  // 2. The correct current password — the identity gate.
  // 3. A new password meeting the same minimum length as register
  // (`DEFAULT_PASSWORD_MIN_LENGTH` — the single auth-policy owner in
  // config.ts), and differing from the current password (no silent no-op).
  // After a successful rotation the existing session STAYS valid; the new
  // password takes effect on the next login.
  const CHANGE_PASSWORD_SCHEMA = z.strictObject({
    currentPassword: z.string().min(1).max(1024),
    newPassword: z.string().min(DEFAULT_PASSWORD_MIN_LENGTH).max(1024),
  });

  router.post("/api/auth/change-password", async (ctx) => {
    const user = await currentUser(ctx.req, db);
    if (user === null) {
      throw new AuthError("A valid session is required to change the password.", "auth_change_password_no_session");
    }
    const input = CHANGE_PASSWORD_SCHEMA.parse(ctx.body);
    const stored = await db.getUserById(user.userId);
    if (stored === null) {
      // The session's user was deleted mid-session. Treat as unauthenticated.
      throw new AuthError("Account no longer exists. Please log in again.", "auth_account_missing");
    }
    if (!(await verifyPassword(input.currentPassword, stored.password_hash))) {
      webAuditEvent("auth.change_password_failed", { session: ctx.sessionId, username: user.username });
      throw new AuthError("Current password is incorrect.", "auth_current_password_invalid");
    }
    // Reject a no-op rotation (new === current) with a clear message.
    if (input.currentPassword === input.newPassword) {
      throw new AuthError("The new password must differ from the current password.", "auth_password_unchanged");
    }
    await db.setUserPasswordHash(user.userId, await hashPassword(input.newPassword));
    webAuditEvent("auth.change_password_success", { session: ctx.sessionId, username: user.username });
    sendJson(ctx.res, { ok: true, message: "Password changed. The new password takes effect on the next login." });
  });
}

// The 409 ConflictError (HTTP 409 — username collision) is now owned by
// server/errors.ts (the single typed-error hierarchy). The local
// class was removed; the import above wires the canonical one.

// The login-timing-equality dummy hash is owned by the auth owner
// (server/auth.ts::DUMMY_PASSWORD_HASH) — imported above, not redefined here.
