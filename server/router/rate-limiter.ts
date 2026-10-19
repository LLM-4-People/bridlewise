/**
 * Rate limiter — token bucket keyed by IDENTITY (user ID or client IP),
 * configurable rate.
 *
 * FIX: no rate limiting allowed anyone to spam the API and exhaust
 * the LLM quota. This implements a token-bucket rate limiter. Each identity
 * gets `rateLimitPerMinute` tokens per minute; requests consume one token.
 * When the bucket is empty, requests get a 429.
 *
 * SECURITY FIX (rate-limit session-key bypass): the
 * limiter was keyed by the `harness_session` (anonymous isolation) cookie
 * via `resolveSessionId`. That cookie is NOT an identity — session.ts itself
 * documents "Session IDs are NOT authentication — they are isolation
 * scoping." Two bypass vectors made keying by it a security hole:
 *
 * 1. OMIT the cookie: `resolveSessionId` GENERATES a fresh UUID when the
 * cookie is missing, so an attacker who omits `harness_session` on
 * every request gets a fresh bucket every time → infinite budget
 * → the rate limit never trips (complete bypass). flagged this.
 * 2. ROTATE the cookie: the client controls the cookie value + can
 * delete/rotate it at will (session rotation also auto-rotates after
 * `sessionRotationHours`). Each new value → a fresh bucket → the
 * limit resets. HackTricks rate-limit-bypass: "requesting a fresh
 * session ID each time... attackers can bypass rate limits"; "cookie
 * jar garbage — submit random session cookies".
 *
 * The fix keys by something the attacker CANNOT control:
 * PRIMARY: the authenticated user ID (from `harness_auth`, resolved via
 * the shared `resolveAuthUser` — the same per-request cache the auth
 * gate uses, so one DB lookup per request; a free cache hit for
 * protected routes).
 * FALLBACK: the client IP (for unauthenticated public routes like
 * login/register, where there is no user yet — exactly the routes where
 * brute-force protection matters most). The IP is the un-spoofable
 * `socket.remoteAddress`; `X-Forwarded-For` is trusted ONLY when
 * `rateLimitTrustProxy` is explicitly enabled (deny-by-default — a
 * directly-connected client can spoof the header to rotate buckets).
 *
 * Lowest-level enforcement (Single-Party-Owner): the limiter derives the
 * key INTERNALLY from the request — the router passes `(req, db)`, NOT a
 * pre-derived key string. A route cannot forget to derive the key correctly
 * (or derive it from a client-controllable value) because it never derives
 * the key at all. The key-derivation owner is this module`).
 *
 * The bucket refills continuously (not in fixed windows), so bursts are
 * smoothed. The limiter is in-memory (sufficient for a single-process
 * local dev server).
 *
 * MEMORY-DoS FIX (-B1): the `buckets` Map is process-global
 * and keyed by identity. With `rateLimitTrustProxy` enabled, an attacker
 * can send spoofed `X-Forwarded-For` headers to create UNLIMITED buckets →
 * unbounded memory growth → memory DoS. The Map is now bounded by
 * `rateLimitMaxBuckets` (configurable): when the cap is reached, the
 * least-recently-used (oldest) bucket is evicted before a new one is
 * created (LRU via Map insertion order — no deps). This bounds
 * memory regardless of the key source (even a spoofed-header storm caps
 * at `rateLimitMaxBuckets` entries).
 */

import type { IncomingMessage } from "node:http";

import { serverConfig } from "../kernel/config.ts";
import { resolveAuthUser } from "../auth/user-context.ts";
import type { AsyncDbClient } from "../db/async-client.ts";

type Bucket = { tokens: number; lastRefill: number };

const buckets = new Map<string, Bucket>();

/** The refill window (ms) — read from serverConfig at call time so an env
 * override (HARNESS_WEB_RATE_LIMIT_REFILL_MS) is respected even if the
 * rate-limiter module was imported before the env was set. */
function refillIntervalMs(): number {
  return serverConfig.rateLimitRefillMs;
}

function getBucket(key: string): Bucket {
  const existing = buckets.get(key);
  if (existing !== undefined) {
    // LRU (-A): mark as recently used. JS Maps maintain insertion order;
    // delete + re-insert moves the key to the END (most-recently-used
    // position). The oldest (first-inserted) key is the eviction candidate.
    buckets.delete(key);
    buckets.set(key, existing);
    return existing;
  }
  // Cap enforcement (-A / -B1: memory-DoS fix): evict the
  // least-recently-used (oldest, first-inserted) bucket BEFORE creating a
  // new one so the `buckets` Map cannot grow unbounded. With
  // `rateLimitTrustProxy` enabled, an attacker can send spoofed
  // `X-Forwarded-For` headers to create unlimited buckets → unbounded
  // memory growth → memory DoS. The LRU cap bounds memory regardless of
  // the key source. The `while` (not `if`) guards against a config that
  // shrinks the cap below the current size (evicts down to the new cap).
  const maxBuckets = serverConfig.rateLimitMaxBuckets;
  while (buckets.size >= maxBuckets && buckets.size > 0) {
    const oldest = buckets.keys().next().value;
    if (oldest === undefined) break;
    buckets.delete(oldest);
  }
  const bucket: Bucket = { tokens: serverConfig.rateLimitPerMinute, lastRefill: Date.now() };
  buckets.set(key, bucket);
  return bucket;
}

function refill(bucket: Bucket): void {
  const now = Date.now();
  const elapsed = now - bucket.lastRefill;
  if (elapsed <= 0) return;
  const refilled = (elapsed / refillIntervalMs()) * serverConfig.rateLimitPerMinute;
  bucket.tokens = Math.min(bucket.tokens + refilled, serverConfig.rateLimitPerMinute);
  bucket.lastRefill = now;
}

/**
 * Derive the rate-limit key from the request — from something the client
 * CANNOT control: the authenticated user ID (primary) or the client IP
 * (fallback). This is the SINGLE key-derivation owner (the
 * router does NOT derive the key; it calls `checkRateLimit(req, db)` which
 * calls this). Exposed so the prevention test + diagnostics can verify the
 * derivation.
 *
 * Uses the shared `resolveAuthUser` so the
 * user resolution is cached per-request (the auth gate already resolved it
 * for protected routes → this is a free cache hit; for public routes it's
 * one cookie read that returns null fast when there is no `harness_auth`
 * cookie — no DB lookup).
 */
export async function rateLimitKey(req: IncomingMessage, db: AsyncDbClient): Promise<string> {
  const user = await resolveAuthUser(req, db);
  if (user !== null) {
    return `user:${user.userId}`;
  }
  return `ip:${clientIp(req)}`;
}

/**
 * The un-spoofable client IP for rate-limit keying. Prefers the left-most
 * `X-Forwarded-For` entry ONLY when `rateLimitTrustProxy` is explicitly
 * enabled (deny-by-default: a directly-connected client can spoof the
 * header to rotate the bucket → bypass; it is only trustworthy behind a
 * configured reverse proxy that sets + sanitizes it). Otherwise uses
 * `socket.remoteAddress` (the actual TCP peer — un-spoofable). Normalizes
 * the IPv4-mapped-IPv6 prefix (`::ffff:127.0.0.1` → `127.0.0.1`) so both
 * forms share one bucket. Exposed for the prevention test.
 */
export function clientIp(req: IncomingMessage): string {
  if (serverConfig.rateLimitTrustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const left =
      typeof xff === "string" ? xff.split(",")[0] ?? ""
      : Array.isArray(xff) && xff.length > 0 ? xff[0]! ?? ""
      : "";
    const trimmed = left.trim();
    if (trimmed.length > 0) return normalizeIp(trimmed);
  }
  const remote = req.socket?.remoteAddress ?? "unknown";
  return normalizeIp(remote);
}

/** Normalize an IP for rate-limit keying so equivalent peer addresses share
 * one bucket (-F8 fix). Strips the IPv4-mapped-IPv6 prefix
 * (`::ffff:127.0.0.1` → `127.0.0.1`) AND unifies the IPv6 loopback (`::1`)
 * with the IPv4 loopback (`127.0.0.1`) — a dual-stack server otherwise
 * gives a client different buckets depending on the stack
 * (`ip:::1` vs `ip:127.0.0.1`), letting the client pick the less-limited
 * stack. Exposed for the prevention test. */
export function normalizeIp(ip: string): string {
  let n = ip.replace(/^::ffff:/, "");
  if (n === "::1") n = "127.0.0.1";
  return n;
}

/**
 * Check if the request has rate-limit budget. Returns true if the request
 * is allowed (and consumes a token), false if rate-limited. The
 * route-facing API: derives the key INTERNALLY from `(req, db)` so the
 * router never passes a client-controllable key (the
 * session-cookie bypass fix). Reuses the shared auth resolver so the key
 * is the authenticated userId (or the un-spoofable client IP for
 * unauthenticated public routes like login).
 */
export async function checkRateLimit(req: IncomingMessage, db: AsyncDbClient): Promise<boolean> {
  return consumeToken(await rateLimitKey(req, db));
}

/**
 * Consume one token from the named bucket. The LOW-LEVEL bucket primitive
 * (takes a raw key) — used by `checkRateLimit` internally + by unit tests
 * that exercise the bucket mechanism directly (exhaustion, per-key
 * independence). Routes MUST use `checkRateLimit(req, db)` (the
 * key-deriving wrapper), NOT this — the prevention test enforces that the
 * router does not call `consumeToken` directly (a route deriving its own
 * key could re-introduce the client-controllable-key bypass).
 */
export function consumeToken(key: string): boolean {
  const bucket = getBucket(key);
  refill(bucket);
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/**
 * Consume one token from a NAMED, SCOPE-OWNED bucket — the sanctioned door
 * for a SECOND, concern-scoped budget on top of the request gate (e.g. the
 * client-telemetry ingestion budget). The key is built HERE from a declared
 * scope and a server-derived owner id, exactly like `checkRateLimit` builds
 * its own: a caller cannot hand in a raw key, so the client-controllable-key
 * bypass this module exists to close cannot re-enter through the side door.
 * The owner id must be something the SERVER established (an authenticated
 * user id), never a value read from the request's body or headers.
 */
export function consumeScopedToken(scope: string, ownerId: string): boolean {
  return consumeToken(`${scope}:${ownerId}`);
}

/**
 * The `Retry-After` value (seconds) a rate-limited client should wait before
 * retrying. The SINGLE owner of rate-limit timing. The token bucket refills
 * `rateLimitPerMinute` tokens every `rateLimitRefillMs` ms, so one token
 * refills every `rateLimitRefillMs / rateLimitPerMinute` ms. The Retry-After
 * is the time until at least one token is available, rounded up to the next
 * whole second (HTTP `Retry-After` is an integer-seconds count). With the
 * defaults (60 tokens / 1000ms) this is ~1s, NOT 60s — the prior hardcoded
 * "60" was both scattered (outside the rate-limit owner) AND wrong
 * (over-conservative by ~60×).
 */
export function rateLimitRetryAfterSeconds(): number {
  const perTokenMs = serverConfig.rateLimitRefillMs / Math.max(1, serverConfig.rateLimitPerMinute);
  return Math.max(1, Math.ceil(perTokenMs / 1000));
}

/** Get the current token count for a key (for diagnostics). Takes a raw key
 * (the same form `rateLimitKey` produces, e.g. `user:<id>` / `ip:<ip>`). */
export function getRemainingTokens(key: string): number {
  const bucket = buckets.get(key);
  if (bucket === undefined) return serverConfig.rateLimitPerMinute;
  refill(bucket);
  return Math.floor(bucket.tokens);
}

/** Reset all buckets (for tests). */
export function resetRateLimiter(): void {
  buckets.clear();
}

/** The current number of live buckets (for diagnostics + the LRU-cap
 * prevention test). -A: the LRU cap (`rateLimitMaxBuckets`) bounds this
 * count so the `buckets` Map cannot grow unbounded. Exposed so the test can
 * verify the cap is enforced + eviction keeps the count at/below it. */
export function rateLimitBucketCount(): number {
  return buckets.size;
}
