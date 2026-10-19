// manifest-schema.mjs — Schema + validator for the EXP417 merge manifest.
//
// THIS IS THE SINGLE CANONICAL OWNER of the merge-manifest format. Every
// consumer that reads or writes a merge manifest imports from here — do NOT
// duplicate this validator.
//
// The declaration is on THIS file because this is the file the consumers
// reach: `scripts/harness-root/merge-round.mjs` imports it, and that module is
// executed on every suite run. It used to live only on
// `docs/history/src-shared-workflow/manifest-schema.mjs`, an archived RECORD
// with zero consumers whose own first line names a path that is not its own —
// so the ownership marker sat on the copy nobody could reach while the file
// everybody reaches claimed nothing. A reader grepping for "canonical owner"
// landed in the archive and would have edited a record.
//
// The archived copy is not deleted and must not be: `docs/history/README.md`
// records that everything there is evidence of what happened and that its
// paths must stay as measured. It is 91% identical to this file, and identical
// is not the same as duplicated — what makes a second copy a second OWNER is a
// consumer, and it has none. `tests/prevention/frozen-record-not-a-second-owner.test.ts`
// measures both halves so neither is prose.
//
// Binding user directive (2026-07-21):
// "for the workflow, the llm should output you the files to merge,
// including module, unit testing, etc. it should tell you for each
// if its a new file or a replacement of a current one."
//
// The manifest is a JSON file (`merge-manifest.json`) at the root of each
// experiment dir. It declares:
// - which experiment this is + which prior experiment it improves (if any);
// - every file to merge, with action "new" or "replace";
// - tests + config files (same shape as source files);
// - dependencies on other experiments (for topological ordering);
// - whether the change is breaking.
//
// The validator is dependency-free (no ajv) — KISS. It checks required
// fields, types, enum values, and path safety (no absolute paths, no
// path traversal outside integration/). It returns a list of issues
// (empty = valid).

import { readFileSync } from "node:fs";

export const MANIFEST_SCHEMA_VERSION = "exp417-merge-manifest/v1";

export const VALID_ACTIONS = Object.freeze(["new", "replace"]);

/**
 * Validate a parsed manifest object. Returns an array of issue strings
 * (empty array = valid). Each issue is prefixed with the field path.
 * @param {any} manifest
 * @returns {string[]}
 */
export function validateManifest(manifest) {
  const issues = [];
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["manifest: must be a JSON object"];
  }

  if (manifest.schema !== MANIFEST_SCHEMA_VERSION) {
    issues.push(
      `schema: expected "${MANIFEST_SCHEMA_VERSION}", got ${JSON.stringify(manifest.schema)}`,
    );
  }

  if (typeof manifest.experiment !== "string" || !manifest.experiment) {
    issues.push("experiment: required non-empty string");
  }

  if (typeof manifest.description !== "string" || !manifest.description) {
    issues.push("description: required non-empty string");
  }

  if (manifest.improves !== null && manifest.improves !== undefined) {
    if (typeof manifest.improves !== "string") {
      issues.push("improves: must be a string or null");
    }
  }

  if (manifest.authorCommit !== null && manifest.authorCommit !== undefined) {
    if (typeof manifest.authorCommit !== "string") {
      issues.push("authorCommit: must be a string or null");
    }
  }

  if (manifest.dependencies !== undefined) {
    if (!Array.isArray(manifest.dependencies) || !manifest.dependencies.every((d) => typeof d === "string")) {
      issues.push("dependencies: must be an array of strings");
    }
  } else {
    issues.push("dependencies: required (array of strings, may be empty)");
  }

  if (typeof manifest.breaking !== "boolean") {
    issues.push("breaking: required boolean");
  }

  for (const section of ["files", "tests", "config"]) {
    const val = manifest[section];
    if (val === undefined) {
      // tests + config are optional; files is required.
      if (section === "files") issues.push("files: required array");
      continue;
    }
    if (!Array.isArray(val)) {
      issues.push(`${section}: must be an array`);
      continue;
    }
    val.forEach((entry, i) => {
      issues.push(...validateFileEntry(entry, `${section}[${i}]`));
    });
  }

  return issues;
}

/**
 * Validate a single file entry from files/tests/config.
 * @returns {string[]}
 */
export function validateFileEntry(entry, prefix) {
  const issues = [];
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return [`${prefix}: must be an object`];
  }
  if (typeof entry.path !== "string" || !entry.path) {
    issues.push(`${prefix}.path: required non-empty string`);
  } else {
    issues.push(...checkPathSafety(entry.path, `${prefix}.path`));
  }
  if (typeof entry.source !== "string" || !entry.source) {
    issues.push(`${prefix}.source: required non-empty string`);
  } else {
    issues.push(...checkPathSafety(entry.source, `${prefix}.source`));
  }
  if (!VALID_ACTIONS.includes(entry.action)) {
    issues.push(`${prefix}.action: must be one of ${JSON.stringify(VALID_ACTIONS)}, got ${JSON.stringify(entry.action)}`);
  }
  if (entry.description !== undefined && typeof entry.description !== "string") {
    issues.push(`${prefix}.description: must be a string if present`);
  }
  return issues;
}

/**
 * Reject absolute paths, path traversal (..), backslash separators.
 * The merge script resolves `source` relative to the experiment dir and
 * `path` relative to integration/. Both must stay inside their roots.
 * @returns {string[]}
 */
export function checkPathSafety(p, prefix) {
  const issues = [];
  if (p.startsWith("/")) {
    issues.push(`${prefix}: must be relative, got absolute "${p}"`);
  }
  if (p.includes("\\")) {
    issues.push(`${prefix}: must use forward slashes, got "${p}"`);
  }
  const segments = p.split("/");
  if (segments.some((s) => s === "..")) {
    issues.push(`${prefix}: must not contain ".." (path traversal), got "${p}"`);
  }
  return issues;
}

/**
 * Load + validate a manifest from a file path.
 * @param {string} path
 * @returns {{ manifest: object|null, issues: string[] }}
 */
export function loadManifest(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return { manifest: null, issues: [`manifest: cannot read file: ${e.message}`] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { manifest: null, issues: [`manifest: invalid JSON: ${e.message}`] };
  }
  return { manifest: parsed, issues: validateManifest(parsed) };
}

/**
 * Collect ALL file entries (files + tests + config) from a manifest.
 * Returns a flat array with the `section` tag added to each entry.
 * @returns {Array<{path, action, source, description, section}>}
 */
export function collectAllFiles(manifest) {
  const out = [];
  for (const section of ["files", "tests", "config"]) {
    const arr = manifest[section];
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      out.push({ ...entry, section });
    }
  }
  return out;
}
