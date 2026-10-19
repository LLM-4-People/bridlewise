/**
 * Dashboard authentication — simple, no-third-party, scrypt + HttpOnly
 * session cookie.
 *
 * Design (validated by web research 2026-07-23: OWASP Node.js auth practices,
 * "secure-auth-template" GitHub — crypto.scrypt, per-user salts, HttpOnly
 * SameSite session cookies, no external deps):
 *
 * 1. PASSWORD: hashed with `scrypt` (per-password random salt) and stored
 * as `scrypt$N$r$p$<saltB64>$<hashB64>` in the encrypted DB. Never
 * plaintext. Set via env (HARNESS_WEB_AUTH_PASSWORD) on first boot OR
 * via the setup flow (POST /api/auth/setup when no password exists).
 * 2. SESSION: a random 32-byte token stored in an HttpOnly, SameSite=Lax
 * cookie. The DB stores a SHA-256 HASH of the token (so a DB leak does
 * not expose active sessions) + an expiry. Every protected request
 * looks up the cookie token's hash in the DB.
 * 3. MIDDLEWARE: all API routes except /api/auth/* and /api/health require
 * a valid session. No session → 401.
 *
 * The server binds to 127.0.0.1 only (loopback), so this is defense-in-depth
 * on top of network isolation — not the sole boundary.
 */
import {
  scrypt,
  randomBytes,
  timingSafeEqual,
  type BinaryLike,
} from "node:crypto";
import type { ServerResponse } from "node:http";
import { serverConfig } from "../kernel/config.ts";
import { guarded } from "../kernel/canonical.ts";
import { AuthError } from "../kernel/errors.ts";
import { sha256 } from "../kernel/digest.ts";
import {
  SCRYPT_N,
  SCRYPT_R,
  SCRYPT_P,
  SCRYPT_KEYLEN,
  SCRYPT_SALT_LEN,
  TOKEN_BYTES,
} from "../safety/safety-invariants.ts";

// ── scrypt parameters (OWASP-recommended minimum, tuned for a local tool) ──
// N=16384 (the CPU/memory cost) is the SAFETY FLOOR — owned by
// server/safety-invariants.ts (the safety carve-out for security
// invariants); it is NOT configurable because lowering it weakens auth.
// r=8, p=1, keylen=32, saltlen=16 are the OWASP minimums — also safety
// floors, owned by safety-invariants.ts so the entire scrypt security
// floor has ONE owner (a split across auth.ts + safety-invariants.ts was
// an incomplete consolidation).
//
// ASYNC (rule: "the synchronous scrypt blocks the event loop on login"): the
// password hash + verify now use the ASYNC `crypto.scrypt`, which runs on
// the libuv thread pool (NOT the event loop) — so a login no longer blocks
// the single-threaded HTTP server for the ~50ms scrypt cost. This is the
// Node.js guidance ("Don't Block the Event Loop" → crypto.scrypt async form
// avoids blocking under this CPU-heavy work; OWASP Node.js auth guidance).
// Worker threads are overkill for a single scrypt call (login is
// infrequent); the async callback form is simpler + no serialization
// overhead. No new deps (built-in node:crypto). db-crypto.ts keeps
// the synchronous scrypt for the one-time DB-key bootstrap (not a
// per-request path).
const SCRYPT_PREFIX = "scrypt";

export const AUTH_COOKIE_NAME = "harness_auth";

/**
 * Promise wrapper around the async `crypto.scrypt`. Runs the CPU-heavy key
 * derivation on the libuv thread pool so the event loop stays responsive
 * (every HTTP request queues, but none blocks). Rejects on a derivation
 * failure (e.g. invalid params — never reachable here because the caller
 * validates N/r/p first); callers translate a rejection to a typed outcome.
 */
function scryptAsync(
  password: BinaryLike,
  salt: BinaryLike,
  keylen: number,
  options: Readonly<{ N: number; r: number; p: number; maxmem: number }>,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, keylen, options, guarded("auth.scrypt.done", (err: Error | null, derivedKey: Buffer) => {
      if (err !== null) reject(err);
      else resolve(derivedKey);
    }));
  });
}

// ── Password hashing ──

/**
 * Hash a password with scrypt + a random per-password salt. Returns
 * `scrypt$N$r$p$<saltB64>$<hashB64>` — a self-describing format so future
 * parameter changes are forward-compatible (the verifier reads N/r/p back).
 *
 * ASYNC: the scrypt derivation runs on the libuv thread pool, so the
 * event loop is never blocked. Callers MUST await this.
 */
export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== "string" || password.length === 0) {
    throw new AuthError("Password must be a non-empty string", "auth_password_empty");
  }
  const salt = randomBytes(SCRYPT_SALT_LEN);
  const hash = await scryptAsync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 128 * SCRYPT_N * SCRYPT_R * 2,
  });
  return `${SCRYPT_PREFIX}$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/**
 * Verify a password against a stored scrypt hash. Constant-time comparison
 * (timingSafeEqual) so the verify duration does not leak whether the hash
 * prefix matched. Returns false on any parse failure (never throws for a
 * malformed stored hash — that would be a non-constant-time signal).
 *
 * ASYNC: the scrypt derivation runs on the libuv thread pool. A
 * derivation failure on a malformed stored hash resolves to `false` (never
 * rejects — the parse failures below short-circuit before the derivation,
 * and a derivation error is caught + mapped to `false` so verify stays
 * total: always returns a boolean, never throws). Callers MUST await this.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (typeof password !== "string" || password.length === 0) return false;
  if (typeof stored !== "string" || stored.length === 0) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== SCRYPT_PREFIX) return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, "base64");
    expected = Buffer.from(parts[5]!, "base64");
  } catch {
    return false;
  }
  if (expected.length !== SCRYPT_KEYLEN) return false;
  let computed: Buffer;
  try {
    computed = await scryptAsync(password, salt, SCRYPT_KEYLEN, {
      N,
      r,
      p,
      maxmem: 128 * N * r * 2,
    });
  } catch {
    // A derivation failure (e.g. absurd N from a corrupt stored hash) must
    // never throw out of verify — map to false (total: boolean | never throw).
    return false;
  }
  if (computed.length !== expected.length) return false;
  return timingSafeEqual(computed, expected);
}

// ── Session tokens ──

/**
 * Generate a cryptographically random session token (32 bytes, hex-encoded).
 * Stored in the client's HttpOnly cookie; the DB stores only its SHA-256
 * hash so a DB compromise does not expose active sessions.
 */
export function createSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

/**
 * Hash a session token for DB storage (SHA-256). The raw token lives only in
 * the cookie; the DB never stores the raw token.
 */
export function hashSessionToken(token: string): string {
  return sha256(token);
}

/**
 * Whether a session has expired given its creation timestamp + the configured
 * TTL. A TTL of 0 means no expiry.
 */
export function isSessionExpired(createdAt: string, ttlHours: number): boolean {
  if (ttlHours <= 0) return false;
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return true;
  return Date.now() - created > ttlHours * 60 * 60 * 1000;
}

/**
 * The cookie attribute string for setting/clearing the auth session cookie.
 * HttpOnly (XSS protection), SameSite=Lax (CSRF protection), Path=/.
 *
 * 
 * `Secure` is appended when the configured origin is HTTPS
 * (`serverConfig.cookieSecure`) so a non-loopback HTTPS deployment does
 * not leak the cookie over a downgraded http hop. Previously the cookie
 * had NO Secure flag (a real prod leak).
 * `maxAgeSeconds` is OPTIONAL: `undefined` OMITS `Max-Age` entirely → a
 * browser-session cookie (deleted when the browser closes), which is
 * the correct meaning of `authSessionTtlHours = 0` (no expiry). The prior
 * code forced a one-day `Max-Age` when the TTL was 0 — both a
 * hardcoded magic number AND a bug (the documented
 * "session cookie on TTL=0" behavior was never implemented). `0` still
 * means DELETE (used by `clearAuthCookie` on logout).
 */
export function authCookieAttributes(maxAgeSeconds?: number): string {
  const parts = ["HttpOnly", "SameSite=Lax", "Path=/"];
  if (serverConfig.cookieSecure) parts.push("Secure");
  if (maxAgeSeconds !== undefined) parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join("; ");
}

/**
 * Session TTL in seconds (for the cookie Max-Age). 0 → session cookie
 * (expires when the browser closes); a positive value → persistent cookie.
 */
export function sessionTtlSeconds(): number {
  const hours = serverConfig.authSessionTtlHours;
  return hours > 0 ? hours * 60 * 60 : 0;
}

// ── Auth-cookie Set-Cookie operations (single owner — SPO) ──
// (cross-cutting): the auth-cookie Set-Cookie previously lived in
// `routes/auth.ts` (the route built the cookie string + called
// `res.appendHeader`). That scattered the auth-cookie response header
// across the route + the auth owner. ALL auth-cookie operations
// (attributes + name + TTL + set + clear) now live in THIS module — the
// single auth owner. The route imports + calls these; it never builds a
// Set-Cookie value itself (No Scattered Helpers: response headers have one
// owner per domain — the auth owner for the auth cookie, the session owner
// for the anonymous session cookie, the router for generic error/JSON
// responses). `appendHeader` (not `setHeader`) so any prior Set-Cookie
// from `resolveSessionId` (the anonymous session cookie set by the
// router) is preserved — both cookies are sent.

/**
 * Set the auth session cookie on the response. When the configured auth TTL
 * is 0 (no expiry) the cookie is a browser-session cookie (Max-Age
 * omitted); a positive TTL sets a persistent cookie. The `Secure` flag is
 * owned by `authCookieAttributes` (derived from the configured origin).
 */
export function setAuthCookie(res: ServerResponse, token: string): void {
  const ttl = sessionTtlSeconds();
  res.appendHeader(
    "Set-Cookie",
    `${AUTH_COOKIE_NAME}=${token}; ${authCookieAttributes(ttl > 0 ? ttl : undefined)}`,
  );
}

/** Clear the auth cookie (Max-Age=0 expires it immediately). */
export function clearAuthCookie(res: ServerResponse): void {
  res.appendHeader("Set-Cookie", `${AUTH_COOKIE_NAME}=; ${authCookieAttributes(0)}`);
}

/**
 * A pre-computed scrypt hash (N=16384, r=8, p=1 — the safety floor) of a
 * random dummy value, used as the comparison hash for the login-timing-
 * equality path (unknown user). The login route verifies the supplied
 * password against it so the scrypt cost is paid regardless of whether the
 * user exists — the response timing does not leak user existence (no
 * username enumeration via timing). Generated once; the salt/hash are
 * random and never correspond to any real password.
 *
 * Owned by the auth owner (server/auth.ts) so auth constants are not
 * scattered in the route file. The route imports + uses it.
 */
export const DUMMY_PASSWORD_HASH =
  "scrypt$16384$8$1$ZMs/odBrwID269cVfjtG2A==$GKH4psrSbGGooEYblptvU7SMfxxGNvY1nvpQjWznGEw=";
