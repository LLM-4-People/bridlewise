/**
 * Product identity — the SINGLE source of truth for every value that names
 * this product to the outside world or to its own persisted/wire formats.
 *
 * ── WHY THIS MODULE EXISTS ────────────────────────────────────────────────
 *
 * A rename of the product is hard only when its name, its schema-namespace
 * prefix, its config-file basename, its state-directory name and its crypto
 * domain prefix are scattered across the tree as string literals with no
 * owner. Each scattered literal is a place a rename can miss, and a missed
 * one desynchronises two on-disk or wire formats that must agree. This
 * module is the owner: every consumer imports the identity from here, so a
 * rename is a one-line change at the owner followed by a re-pin, never a
 * tree-wide search.
 *
 * ── WHAT LIVES HERE ───────────────────────────────────────────────────────
 *
 *   - the product name (`bridlewise`),
 *   - the schema-namespace prefix prepended to every `…/vN` schema id,
 *   - the config-file basename (`bridlewise.config.json`),
 *   - the state-directory name (`.bridlewise`),
 *   - the crypto domain-separation prefix used for `canonicalDomainHash`,
 *   - the derivers (`schemaId`, `cryptoDomain`, `statePath`) that build a
 *     concrete identity value from the single prefix.
 *
 * ── WHY A LEAF, NOT root-policy ───────────────────────────────────────────
 *
 * `root-policy.ts` is self-referentially pinned: it carries `bundleSha256`
 * while itself living inside the bundle, so any edit to it re-primes the
 * build/pin ordering ritual. The product identity is consumed by root-policy
 * (the config basename, the schema ids it pins), so it must be a leaf module
 * that root-policy imports — never the other way around, and never a value
 * root-policy restates.
 *
 * The prevention guard `product-identity-owner.test.ts` denies any of these
 * literals appearing outside this module and its declared exceptions, so a
 * new scattered literal reds the suite instead of silently forking the
 * identity.
 */

/** The product's public name. */
export const PRODUCT_NAME = "bridlewise" as const;

/**
 * The namespace prefix prepended to every versioned schema identifier.
 * A schema id is always `<schemaNamespace>-<slug>/v<version>`; see
 * {@link schemaId}. Module-private: the public surface is the {@link schemaId}
 * deriver, so no consumer restates the prefix.
 */
const SCHEMA_NAMESPACE = PRODUCT_NAME;

/**
 * The basename of the runtime configuration file read from the repository
 * root.
 */
export const CONFIG_FILE_BASENAME = `${PRODUCT_NAME}.config.json` as const;

/**
 * The name of the repository-local state directory (never pushed). Every
 * state path is built from this single root via {@link statePath}.
 */
export const STATE_DIRECTORY_NAME = `.${PRODUCT_NAME}` as const;

/**
 * The domain-separation prefix for `canonicalDomainHash`. A crypto domain is
 * always `<cryptoDomainPrefix>/<slug>/v<version>` (with an optional trailing
 * NUL separator added by the caller); see {@link cryptoDomain}. Module-private:
 * the public surface is the {@link cryptoDomain} deriver.
 */
const CRYPTO_DOMAIN_PREFIX = PRODUCT_NAME;

/**
 * Build a versioned schema identifier from the single namespace prefix.
 *
 * `schemaId("memory", 1)` → `"bridlewise-memory/v1"`. Every schema id in
 * the tree is this shape; constructing them here means the namespace prefix
 * appears exactly once.
 */
export function schemaId<S extends string, V extends number>(
  slug: S,
  version: V,
): `${typeof SCHEMA_NAMESPACE}-${S}/v${V}` {
  return `${SCHEMA_NAMESPACE}-${slug}/v${version}`;
}

/**
 * Build a crypto domain-separation string from the single prefix.
 *
 * `cryptoDomain("timeline-chain", 1)` → `"bridlewise/timeline-chain/v1"`.
 * Callers that need a NUL-terminated domain append it themselves.
 */
export function cryptoDomain<S extends string, V extends number>(
  slug: S,
  version: V,
): `${typeof CRYPTO_DOMAIN_PREFIX}/${S}/v${V}` {
  return `${CRYPTO_DOMAIN_PREFIX}/${slug}/v${version}`;
}

/**
 * Build a repository-local state path rooted at the single state directory.
 *
 * `statePath("state", "locks")` → `".bridlewise/state/locks"`. With no
 * segments it returns the state directory itself (with a trailing slash for
 * prefix-exclusion contexts use {@link statePathPrefix}).
 */
export function statePath(...segments: readonly string[]): string {
  return [STATE_DIRECTORY_NAME, ...segments].join("/");
}

/** The state directory with a trailing slash, for prefix-exclusion lists. */
export function statePathPrefix(): string {
  return `${STATE_DIRECTORY_NAME}/`;
}
