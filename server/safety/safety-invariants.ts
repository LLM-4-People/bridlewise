/**
 * Web-server safety invariants — the hardcoded-value carve-out.
 *
 * "No configurables outside the global config file...
 * (or `root-policy.ts` for safety invariants)." The web UI server has no
 * `root-policy.ts` (that is the harness runtime's safety floor); this module
 * is the web server's equivalent owner for NON-CONFIGURABLE safety
 * invariants — values that must NOT be lowered or overridden at runtime
 * because doing so weakens a security guarantee.
 *
 * What lives here (and NOT in config.ts): values where lowering them = a
 * weaker security posture. Making them "configurable" would let an operator
 * accidentally downgrade auth (e.g. scrypt N=1 → instant brute force). They
 * are constants, not tunables.
 *
 * What does NOT live here: operational tunables (timeouts, TTLs, size
 * limits, rates) that ARE legitimately configurable — those live in
 * `server/config.ts` (the single source of truth). This module is only for
 * the security floor.
 *
 * The `no-hardcoded-config-values` prevention test recognizes this file as
 * an owner via the `@config-owner` marker (the explicit-add, deny-by-default
 * pattern), so a safety invariant is NOT a "scattered hardcoded value"
 * violation.
 *
 * @config-owner
 */

import { isLoopbackHostName } from "../../engine/src/shared/outbound-http.ts";

/**
 * scrypt cost parameter N (CPU/memory cost). OWASP-recommended minimum
 * (N=16384, r=8, p=1). Login is infrequent so the ~50ms blocking cost is
 * acceptable. This is a SAFETY FLOOR: lowering N weakens password hashing
 * (N=1 → trivially brute-forceable). It is intentionally NOT configurable.
 * The verifier reads N back from the stored hash string, so a future
 * increase is forward-compatible (old hashes verify at their stored N).
 */
export const SCRYPT_N = 16384;

/**
 * scrypt block size parameter r (memory-bandwidth cost). OWASP-recommended
 * minimum (r=8). A SAFETY FLOOR: lowering r weakens password hashing
 * (r=1 drastically cuts scrypt's memory hardness, making GPU brute force
 * cheaper). Intentionally NOT configurable. Kept with the other scrypt
 * safety invariants so the security floor has ONE owner.
 */
export const SCRYPT_R = 8;

/**
 * scrypt parallelization parameter p. OWASP-recommended minimum (p=1). A
 * SAFETY FLOOR: p must be a positive integer (p=0 is invalid). Intentionally
 * NOT configurable.
 */
export const SCRYPT_P = 1;

/**
 * scrypt derived-key length (bytes). 32 bytes = 256 bits. A SAFETY FLOOR:
 * lowering it (e.g. 16) halves the key strength. Intentionally NOT
 * configurable. The verifier checks the stored hash length against this.
 */
export const SCRYPT_KEYLEN = 32;

/**
 * scrypt salt length (bytes). 16 bytes = 128 bits. A SAFETY FLOOR: lowering
 * it (e.g. 8) raises the salt-collision probability. Intentionally NOT
 * configurable.
 */
export const SCRYPT_SALT_LEN = 16;

/**
 * Session-token entropy (bytes). 32 bytes = 256 bits of randomness. A SAFETY
 * FLOOR: lowering it (e.g. 16) halves the token entropy, making a guessed
 * session token more likely. Intentionally NOT configurable. The raw token
 * lives in the HttpOnly cookie; the DB stores only its SHA-256 hash.
 */
export const TOKEN_BYTES = 32;

/**
 * The host names that ARE loopback — the WHOLE name, never a prefix.
 *
 * ── THE DEFENCE THIS CLAIMED AND DID NOT HAVE ─────────────────────────────
 *
 * This was a list of PREFIXES, tested with `startsWith`, and the comment above
 * it named DNS rebinding as the attack it stopped. It did not stop it, and it
 * was wrong in both directions at once. Measured:
 *
 *   isLoopbackHost("127.0.0.1.evil.com")  was true   ← the named attack
 *   isLoopbackHost("localhost.evil.com")  was true   ←
 *   isLoopbackHost("[::1]")               was false  ← real loopback, refused
 *   isLoopbackHost("::1")                 was false  ←
 *
 * A rebinding host is a name an attacker owns that RESOLVES to 127.0.0.1; the
 * browser then sends it in the `Host` header. `startsWith` accepts every such
 * name that merely begins with the right characters, which is every name the
 * attacker cares to register. That is the whole attack, waved through by the
 * check written to stop it — an exemption stated as prose and never tested,
 * which is the shape both proven sandbox escapes wore.
 *
 * ── THE FIX IS AN EXACT PREDICATE, WITH THE PORT SEPARATED FIRST ─────────
 *
 * A `Host` header is `name` or `name:port`, and for IPv6 the name is bracketed
 * (`[::1]:5173`) precisely so the colons inside it are not port separators.
 * Splitting that off and asking the harness's ONE loopback predicate
 * (`isLoopbackHostName`, owned by the outbound door: `localhost` exactly, or
 * a loopback ADDRESS — 127.0.0.0/8, `::1`, parsed, never a prefix or a
 * suffix) cannot be widened by anything appended, because there is nothing
 * left to append to. The door and this gate used to answer "is this
 * loopback?" differently (the door admitted `*.localhost`, which the system
 * resolver sent to a LAN host); there is now one answer.
 */

/**
 * Whether a request `Host` header names a loopback address.
 *
 * The comparison is on the whole host, case-insensitively (host names are
 * case-insensitive and `LOCALHOST` is a legal spelling), after removing an
 * optional port. Anything else is refused, including a name that merely begins
 * with a loopback address.
 */
export function isLoopbackHost(host: string): boolean {
  return isLoopbackHostName(hostWithoutPort(host));
}

/**
 * A `Host` header with its port removed, keeping an IPv6 literal's brackets.
 *
 * Bracketed first, because that is the case a naive `split(":")[0]` gets
 * exactly backwards: `[::1]:5173` would become `[`, and `::1` would become the
 * empty string — both of which then fail to match a real loopback address.
 */
function hostWithoutPort(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    return close === -1 ? trimmed : trimmed.slice(0, close + 1);
  }
  // An unbracketed host with more than one colon is a bare IPv6 literal, which
  // carries no port; one colon is `name:port`.
  const first = trimmed.indexOf(":");
  if (first === -1) return trimmed;
  return trimmed.indexOf(":", first + 1) === -1 ? trimmed.slice(0, first) : trimmed;
}
