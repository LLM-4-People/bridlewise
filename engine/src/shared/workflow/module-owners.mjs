// module-owners.mjs — Data-driven designated module owners resolver.
//
// Promoted from the hardcoded MODULE_OWNERS in scripts/merge-integration.mjs
// (EXP465) per the EXP471 directive: "Designated module owners are hardcoded
// in the merge script — should move to a central module-owners.json so the
// merge is data-driven." This is the canonical resolver; the per-round merge
// (scripts/harness-root/merge-round.mjs) reads it (the one-shot integration
// merge that also did was deleted with the owned-change composition, A5).
//
// Semantics (identical to the original ownerFor):
// - excludePaths: paths starting with any exclude entry return "__exclude__".
// - exact paths (kind=exact): checked first; an exact match returns its owner.
// - prefixes (kind=prefix): longest-prefix match wins (we sort prefixes
// descending by length so the first match is the longest).
// - A prefix entry whose path does not end with "/" and contains no "/" is a
// bare prefix (e.g. "src/memory/tool-result-") — matched with startsWith.
// - No match returns null (no designated owner; highest-exp-number wins).

import { readFileSync, existsSync } from "node:fs";

export const MODULE_OWNERS_SCHEMA = "exp471-module-owners/v1";
export const EXCLUDE_OWNER = "__exclude__";

/**
 * Load + validate a module-owners.json file.
 * @param {string} path absolute or relative path to the JSON file
 * @returns {{ owners: object[], excludePaths: string[], raw: object } | null}
 */
export function loadModuleOwners(path) {
  if (!existsSync(path)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (raw.schema !== MODULE_OWNERS_SCHEMA) return null;
  const owners = Array.isArray(raw.owners) ? raw.owners : [];
  const excludePaths = Array.isArray(raw.excludePaths) ? raw.excludePaths : [];
  return { owners, excludePaths, raw };
}

/**
 * Resolve the designated owner for a relative integration/ path.
 * Returns the owner experiment name, EXCLUDE_OWNER for excluded paths, or
 * null when no owner is designated.
 * @param {string} relPath forward-slash relative path inside integration/
 * @param {{ owners: object[], excludePaths: string[] }} config
 * @returns {string|null}
 */
export function ownerForPath(relPath, config) {
  if (!config) return null;
  const p = String(relPath);
  for (const ex of config.excludePaths) {
    if (p.startsWith(ex)) return EXCLUDE_OWNER;
  }
  // Exact paths first.
  let exactOwner = null;
  for (const o of config.owners) {
    if (o.kind === "exact" && o.path === p) {
      exactOwner = o.owner;
      break;
    }
  }
  if (exactOwner !== null) return exactOwner;
  // Longest-prefix match among prefix entries. A prefix entry is matched by
  // startsWith on its path (covers "dir/" prefixes and bare "stem-" prefixes).
  let best = null;
  let bestLen = -1;
  for (const o of config.owners) {
    if (o.kind !== "prefix") continue;
    if (p.startsWith(o.path) && o.path.length > bestLen) {
      best = o;
      bestLen = o.path.length;
    }
  }
  return best ? best.owner : null;
}

/**
 * Whether a path is excluded (vendored / generated / non-conforming).
 * @param {string} relPath
 * @param {{ excludePaths: string[] }} config
 * @returns {boolean}
 */
export function isExcludedPath(relPath, config) {
  if (!config) return false;
  const p = String(relPath);
  return config.excludePaths.some((ex) => p.startsWith(ex));
}
