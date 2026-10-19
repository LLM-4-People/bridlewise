import { InputError } from "../kernel/errors.ts";

/**
 * Minimal semantic-version utilities — the one canonical owner for version
 * parsing, comparison, and range satisfaction in the extension system.
 *
 * Supports MAJOR.MINOR.PATCH with optional numeric prerelease tags
 * (-<prerelease>) and the standard range operators: exact (`1.2.3`), caret
 * (`^1.2.3`), tilde (`~1.2.3`), and comparators (`>=`, `>`, `<=`, `<`, `=`).
 * Ranges may be combined with whitespace (AND) and `||` (OR). This is a
 * deterministic, dependency-free implementation scoped to the version
 * shapes the extension manifest actually uses; it is not a full semver
 * implementation (build metadata, complex prerelease precedence, star ranges
 * are intentionally out of scope — YAGNI).
 */

export type Semver = Readonly<{
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}>;

const SEMVER_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

const PRERELEASE_SPLIT = /[.]/u;

export function parseSemver(version: string): Semver {
  if (typeof version !== "string" || version.length === 0) {
    throw new InputError(`Invalid semantic version: '${String(version)}'`, "semver_invalid");
  }
  const match = SEMVER_PATTERN.exec(version.trim());
  if (match === null) {
    throw new InputError(`Invalid semantic version: '${version}'`, "semver_invalid");
  }
  const major = Number(match[1]!);
  const minor = Number(match[2]!);
  const patch = Number(match[3]!);
  const prerelease = match[4] === undefined ? null : match[4]!;
  return { major, minor, patch, prerelease };
}

export function isPrerelease(version: string): boolean {
  return parseSemver(version).prerelease !== null;
}

export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  const majorCmp = compareInt(pa.major, pb.major);
  if (majorCmp !== 0) return majorCmp;
  const minorCmp = compareInt(pa.minor, pb.minor);
  if (minorCmp !== 0) return minorCmp;
  const patchCmp = compareInt(pa.patch, pb.patch);
  if (patchCmp !== 0) return patchCmp;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

export function semverEqual(a: string, b: string): boolean {
  return compareSemver(a, b) === 0;
}

function compareInt(a: number, b: number): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Prerelease ordering per semver: a version with a prerelease has lower
 * precedence than the same version without. Identifiers consisting of only
 * digits are compared numerically; others lexically. Numeric identifiers
 * always have lower precedence than non-numeric. A larger set of fields
 * wins when all preceding fields are equal.
 */
function comparePrerelease(a: string | null, b: string | null): -1 | 0 | 1 {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const aParts = a.split(PRERELEASE_SPLIT);
  const bParts = b.split(PRERELEASE_SPLIT);
  const max = Math.min(aParts.length, bParts.length);
  for (let i = 0; i < max; i++) {
    const ap = aParts[i]!;
    const bp = bParts[i]!;
    const aNum = /^[0-9]+$/u.test(ap);
    const bNum = /^[0-9]+$/u.test(bp);
    if (aNum && bNum) {
      const an = Number(ap);
      const bn = Number(bp);
      if (an < bn) return -1;
      if (an > bn) return 1;
    } else if (aNum && !bNum) {
      return -1;
    } else if (!aNum && bNum) {
      return 1;
    } else {
      const lexical = ap < bp ? -1 : ap > bp ? 1 : 0;
      if (lexical !== 0) return lexical;
    }
  }
  if (aParts.length < bParts.length) return -1;
  if (aParts.length > bParts.length) return 1;
  return 0;
}

export type ComparatorOperator = ">=" | ">" | "<=" | "<" | "=";

export type Comparator = Readonly<{
  operator: ComparatorOperator;
  version: string;
}>;

const COMPARATOR_PATTERN = /^\s*(>=|>|<=|<|=)?\s*(0|[1-9][0-9]*\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)\s*$/u;

export function parseComparator(input: string): Comparator {
  const match = COMPARATOR_PATTERN.exec(input);
  if (match === null) {
    throw new InputError(`Invalid version comparator: '${input}'`, "semver_range_invalid");
  }
  const operator = (match[1] ?? "=") as ComparatorOperator;
  const version = match[2]!;
  return { operator, version };
}

export function satisfiesComparator(version: string, comparator: Comparator): boolean {
  const cmp = compareSemver(version, comparator.version);
  switch (comparator.operator) {
    case "=":
      return cmp === 0;
    case ">":
      return cmp > 0;
    case ">=":
      return cmp >= 0;
    case "<":
      return cmp < 0;
    case "<=":
      return cmp <= 0;
  }
}

/**
 * Resolve a caret range into an AND of two comparators.
 * `^1.2.3` => `>=1.2.3 <2.0.0`
 * `^0.2.3` => `>=0.2.3 <0.3.0`
 * `^0.0.3` => `>=0.0.3 <0.0.4`
 */
function expandCaret(version: string): readonly Comparator[] {
  const v = parseSemver(version);
  const lower: Comparator = { operator: ">=", version };
  let upperVersion: string;
  if (v.major > 0) {
    upperVersion = `${v.major + 1}.0.0`;
  } else if (v.minor > 0) {
    upperVersion = `0.${v.minor + 1}.0`;
  } else {
    upperVersion = `0.0.${v.patch + 1}`;
  }
  return [lower, { operator: "<", version: upperVersion }];
}

/**
 * Resolve a tilde range into an AND of two comparators.
 * `~1.2.3` => `>=1.2.3 <1.3.0`
 * `~1.0.0` => `>=1.0.0 <1.1.0`
 */
function expandTilde(version: string): readonly Comparator[] {
  const v = parseSemver(version);
  const lower: Comparator = { operator: ">=", version };
  const upperVersion = `${v.major}.${v.minor + 1}.0`;
  return [lower, { operator: "<", version: upperVersion }];
}

export type RangeToken =
  | Readonly<{ kind: "comparator"; comparator: Comparator }>
  | Readonly<{ kind: "caret"; comparators: readonly Comparator[] }>
  | Readonly<{ kind: "tilde"; comparators: readonly Comparator[] }>
  | Readonly<{ kind: "exact"; version: string }>;

function parseRangeToken(token: string): RangeToken {
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    throw new InputError("Invalid version range: empty token", "semver_range_invalid");
  }
  if (trimmed.startsWith("^")) {
    const version = trimmed.slice(1).trim();
    parseSemver(version);
    return { kind: "caret", comparators: expandCaret(version) };
  }
  if (trimmed.startsWith("~")) {
    const version = trimmed.slice(1).trim();
    parseSemver(version);
    return { kind: "tilde", comparators: expandTilde(version) };
  }
  if (/^(>=|>|<=|<|=)/u.test(trimmed)) {
    return { kind: "comparator", comparator: parseComparator(trimmed) };
  }
  parseSemver(trimmed);
  return { kind: "exact", version: trimmed };
}

export type VersionRange = Readonly<{
  raw: string;
  orSets: readonly (readonly RangeToken[])[];
}>;

export function parseVersionRange(range: string): VersionRange {
  if (typeof range !== "string" || range.trim().length === 0) {
    throw new InputError("Invalid version range: empty", "semver_range_invalid");
  }
  const orParts = range.split("||").map((p) => p.trim()).filter((p) => p.length > 0);
  if (orParts.length === 0) {
    throw new InputError("Invalid version range: empty", "semver_range_invalid");
  }
  const orSets: (readonly RangeToken[])[] = [];
  for (const orPart of orParts) {
    const tokens = orPart.split(/\s+/u).filter((t) => t.length > 0);
    if (tokens.length === 0) {
      throw new InputError("Invalid version range: empty AND set", "semver_range_invalid");
    }
    const parsed = tokens.map(parseRangeToken);
    orSets.push(parsed);
  }
  return { raw: range, orSets };
}

export function satisfiesRange(version: string, range: string): boolean {
  const parsed = parseVersionRange(range);
  const v = parseSemver(version);
  void v;
  for (const andSet of parsed.orSets) {
    let satisfied = true;
    for (const token of andSet) {
      if (!tokenSatisfied(version, token)) {
        satisfied = false;
        break;
      }
    }
    if (satisfied) return true;
  }
  return false;
}

function tokenSatisfied(version: string, token: RangeToken): boolean {
  switch (token.kind) {
    case "exact":
      return semverEqual(version, token.version);
    case "comparator":
      return satisfiesComparator(version, token.comparator);
    case "caret":
    case "tilde":
      return token.comparators.every((c) => satisfiesComparator(version, c));
  }
}

export function isValidSemver(version: string): boolean {
  try {
    parseSemver(version);
    return true;
  } catch {
    return false;
  }
}

export function isValidRange(range: string): boolean {
  try {
    parseVersionRange(range);
    return true;
  } catch {
    return false;
  }
}
