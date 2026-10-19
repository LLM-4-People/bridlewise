/**
 * THE ONE SHRINK-ONLY RATCHET — how a guard carries accepted debt without
 * letting it grow.
 *
 * ── THE CLASS THIS EXISTS FOR ─────────────────────────────────────────────
 *
 * A guard that cannot go green today keeps a committed list of the sites it
 * tolerates. The list the literal guard kept was a plain map with no reason
 * per entry, compared with NOTHING but the tree: appending the offending line
 * to the list made a new violation pass (verify/a2-correctness §7 reproduced
 * it), and nothing refused a commit that grew the list. A debt register that
 * anyone can extend is a denylist with the sign flipped.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────
 *
 * A baseline is a self-identifying JSON document (`schema` =
 * {@link RATCHET_SCHEMA}) of entries `{ key, reason }`: `key` is the
 * finding's identity (a multiset: the same key may be listed as often as the
 * site occurs), `reason` says why the debt is accepted for now and who owns
 * paying it (a tracker id). Judged three ways against the guard's current
 * findings and against the baseline as COMMITTED (git `HEAD`):
 *
 *   - `unbaselined`  a finding the baseline does not hold: new debt — fix the
 *                    site, never add it;
 *   - `stale`        an entry no finding matches: the debt fell — delete it;
 *   - `grown`        an entry the committed baseline does not hold (or holds
 *                    fewer times): the list GREW since the last commit, which
 *                    is refused whatever it says.
 *
 * A baseline carries its registry `id`, and the committed baseline is found
 * BY THAT ID in `HEAD`'s tree, never by path (a2b-design M1: a `git mv` of a
 * baseline plus added entries read as "being introduced", so its growth
 * passed both doors). Only when `HEAD` holds no baseline with the id (nor, for
 * a baseline committed before ids, one at the same path) is it being
 * introduced; nothing can have grown yet. The commit guard applies the same `grown` rule to every STAGED
 * baseline against `HEAD` (`engine/scripts/commit-guard.ts`), so a commit
 * cannot grow a list the suite would then take as the new floor.
 */
import { execFileSync, spawnSync } from "node:child_process";

import { InputError } from "../../src/kernel/errors.ts";
import { schemaId } from "../../src/kernel/product-identity.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";

/** The schema a ratchet baseline declares (what makes a file one: the commit guard finds baselines by it). */
export const RATCHET_SCHEMA = schemaId("ratchet-baseline", 1);

export type RatchetEntry = Readonly<{ key: string; reason: string }>;
/** A baseline document: its schema, its registry id (`undefined` only in a baseline committed before ids) and its entries. */
export type RatchetBaseline = Readonly<{ schema: typeof RATCHET_SCHEMA; id?: string; entries: readonly RatchetEntry[] }>;

/** Whether `text` declares itself a ratchet baseline (cheap: no full parse unless it names the schema). */
export function declaresRatchetBaseline(text: string): boolean {
  if (!text.includes(RATCHET_SCHEMA)) return false;
  try {
    const value = JSON.parse(text) as { schema?: unknown };
    return value !== null && typeof value === "object" && value.schema === RATCHET_SCHEMA;
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

/** Parse and validate a baseline; `source` names it in a refusal. Every entry needs a key and a reason. */
export function parseRatchetBaseline(text: string, source: string): RatchetBaseline {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new InputError(`${source} is not JSON: ${error instanceof Error ? error.message : String(error)}`, "ratchet_baseline_invalid");
  }
  const document = value as { schema?: unknown; id?: unknown; entries?: unknown } | null;
  if (document === null || typeof document !== "object" || document.schema !== RATCHET_SCHEMA || !Array.isArray(document.entries)
    || (document.id !== undefined && (typeof document.id !== "string" || document.id.trim().length === 0))) {
    throw new InputError(`${source} is not a ${RATCHET_SCHEMA} document ({ schema, id, entries: [{ key, reason }] })`, "ratchet_baseline_invalid");
  }
  const entries = document.entries.map((entry: unknown, index: number): RatchetEntry => {
    const { key, reason } = (entry ?? {}) as { key?: unknown; reason?: unknown };
    if (typeof key !== "string" || key.trim().length === 0) {
      throw new InputError(`${source} entry ${index} has no key`, "ratchet_baseline_invalid");
    }
    if (typeof reason !== "string" || reason.trim().length === 0) {
      throw new InputError(`${source} entry ${index} (${key}) has no reason: every accepted debt says why, and who pays it`, "ratchet_baseline_unjustified");
    }
    return Object.freeze({ key, reason });
  });
  return Object.freeze({ schema: RATCHET_SCHEMA, ...(typeof document.id === "string" ? { id: document.id } : {}), entries: Object.freeze(entries) });
}

/**
 * The baseline of registry id `id` as committed at `HEAD` — found by its id,
 * anywhere in HEAD's tree (a baseline moved to a new path is still the one
 * committed) — or `undefined` when `HEAD` does not hold it yet (the baseline
 * is being introduced). Read with the caller's git environment, so inside a
 * hook it is the repository being committed to. (The by-path read of
 * baselines committed before ids is gone: every baseline HEAD holds carries
 * its id, WF1B3BFIX-RATCHET-PATH-FALLBACK.)
 */
export function committedRatchetBaseline(repositoryRoot: string, id: string): RatchetBaseline | undefined {
  return baselinesIn(repositoryRoot, "HEAD").get(id);
}

/**
 * A blob's text (`git show <spec>`), or `undefined` when the revision does
 * not hold that path. Outside a repository it refuses: "nothing committed"
 * must never be how a missing repository reads.
 */
export function gitBlob(repositoryRoot: string, spec: string): string | undefined {
  assertRepository(repositoryRoot);
  if (spawnSync("git", ["cat-file", "-e", spec], { cwd: repositoryRoot, stdio: "ignore" }).status !== 0) return undefined;
  return execFileSync("git", ["show", spec], { cwd: repositoryRoot, encoding: "utf8", maxBuffer: ROOT_POLICY.runtime.limits.maximumGitOutputBytes });
}

/** Refuses (`ratchet_repository_missing`) a root outside any git repository: "nothing committed" must never be how a missing repository reads. */
function assertRepository(repositoryRoot: string): void {
  if (spawnSync("git", ["rev-parse", "--git-dir"], { cwd: repositoryRoot, stdio: "ignore" }).status !== 0) {
    throw new InputError(`${repositoryRoot} is not inside a git repository, so a committed baseline cannot be read`, "ratchet_repository_missing");
  }
}

function counts(keys: Iterable<string>): Map<string, number> {
  const tally = new Map<string, number>();
  for (const key of keys) tally.set(key, (tally.get(key) ?? 0) + 1);
  return tally;
}

/** The keys of `left` beyond what `right` holds (a multiset difference), in `left`'s order. */
function beyond(left: readonly string[], right: readonly string[]): readonly string[] {
  const available = counts(right);
  const extra: string[] = [];
  for (const key of left) {
    const remaining = available.get(key) ?? 0;
    if (remaining > 0) available.set(key, remaining - 1);
    else extra.push(key);
  }
  return extra;
}

/** The entries `current` holds beyond the committed baseline: the list grew. Empty when nothing was committed yet. */
export function ratchetGrowth(current: RatchetBaseline, committed: RatchetBaseline | undefined): readonly string[] {
  if (committed === undefined) return [];
  return beyond(current.entries.map((entry) => entry.key), committed.entries.map((entry) => entry.key));
}

export type RatchetVerdict = Readonly<{
  /** Findings the baseline does not hold: new debt (fix the site). */
  unbaselined: readonly string[];
  /** Entries no finding matches: the debt fell (delete the entry). */
  stale: readonly string[];
  /** Entries the committed baseline does not hold: the list grew (refused). */
  grown: readonly string[];
}>;

/** Judge the guard's current `findings` (keys, a multiset) against its baseline and the committed baseline. */
export function judgeRatchet(findings: readonly string[], baseline: RatchetBaseline, committed: RatchetBaseline | undefined): RatchetVerdict {
  const keys = baseline.entries.map((entry) => entry.key);
  return Object.freeze({
    unbaselined: Object.freeze([...beyond(findings, keys)]),
    stale: Object.freeze([...beyond(keys, findings)]),
    grown: Object.freeze([...ratchetGrowth(baseline, committed)]),
  });
}

/** The one failure text for a verdict (undefined when it holds): what to do about each kind. */
export function ratchetFailure(baselinePath: string, verdict: RatchetVerdict): string | undefined {
  const parts: string[] = [];
  if (verdict.unbaselined.length > 0) parts.push(`new debt — fix each site (a ratchet baseline never takes a new entry):\n${verdict.unbaselined.map((key) => `  + ${key}`).join("\n")}`);
  if (verdict.stale.length > 0) parts.push(`the debt fell — delete these entries from ${baselinePath}:\n${verdict.stale.map((key) => `  - ${key}`).join("\n")}`);
  if (verdict.grown.length > 0) parts.push(`${baselinePath} GREW since HEAD — a ratchet only shrinks; remove the added entries and fix their sites:\n${verdict.grown.map((key) => `  + ${key}`).join("\n")}`);
  return parts.length === 0 ? undefined : parts.join("\n\n");
}

/**
 * Every ratchet baseline a tree holds (`HEAD`'s, or the index's), keyed by its
 * id. One that names no id is not a baseline any reader can find (a staged
 * one is refused by {@link stagedRatchetGrowth}; every baseline HEAD holds
 * carries its id).
 */
function baselinesIn(repositoryRoot: string, tree: "HEAD" | "index"): ReadonlyMap<string, RatchetBaseline> {
  assertRepository(repositoryRoot);
  const args = tree === "HEAD" ? ["grep", "-l", "-z", "--fixed-strings", RATCHET_SCHEMA, "HEAD", "--", "*.json"] : ["grep", "--cached", "-l", "-z", "--fixed-strings", RATCHET_SCHEMA, "--", "*.json"];
  const listed = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8", maxBuffer: ROOT_POLICY.runtime.limits.maximumGitOutputBytes });
  const baselines = new Map<string, RatchetBaseline>();
  for (const entry of (listed.status === 0 ? listed.stdout : "").split("\0").filter((listedPath) => listedPath.length > 0)) {
    const spec = tree === "HEAD" ? entry : `:${entry}`;
    const text = gitBlob(repositoryRoot, spec);
    if (text === undefined || !declaresRatchetBaseline(text)) continue;
    const baseline = parseRatchetBaseline(text, spec);
    if (baseline.id !== undefined) baselines.set(baseline.id, baseline);
  }
  return baselines;
}

/**
 * Every STAGED ratchet baseline that grew against `HEAD` (the commit guard's
 * leg): each staged `.json` whose staged text declares {@link RATCHET_SCHEMA}
 * is judged with {@link ratchetGrowth} against HEAD's baseline of the SAME
 * ID, wherever it lives (a2b-design M1: a moved baseline is the same one).
 * A staged baseline whose id HEAD does not hold is judged against every
 * baseline this commit RETIRES (HEAD holds it, the index no longer does):
 * renaming a baseline's id, or moving it and renaming it, is a retirement
 * plus an introduction, and the "introduced" list may hold nothing the
 * retired one did not (WF-1b3b design M9 / verify L2: a `git mv` with a new
 * id read as introduced and its growth passed). With nothing retired it is a
 * genuine introduction. A
 * deletion, or a file that is not a baseline, is not judged; a staged
 * baseline that does not parse (an entry with no reason) or names no id
 * throws, so the guard refuses it too.
 */
export function stagedRatchetGrowth(repositoryRoot: string, stagedPaths: readonly string[]): readonly Readonly<{ path: string; grown: readonly string[] }>[] {
  const grownBaselines: { path: string; grown: readonly string[] }[] = [];
  let committed: Readonly<{ head: ReadonlyMap<string, RatchetBaseline>; retired: RatchetBaseline | undefined }> | undefined;
  for (const path of stagedPaths) {
    if (!path.endsWith(".json")) continue;
    const staged = gitBlob(repositoryRoot, `:${path}`);
    if (staged === undefined || !declaresRatchetBaseline(staged)) continue;
    const baseline = parseRatchetBaseline(staged, `the staged ${path}`);
    if (baseline.id === undefined) throw new InputError(`the staged ${path} names no id: a baseline carries its registry id (harness sync writes it)`, "ratchet_baseline_invalid");
    committed ??= (() => {
      const head = baselinesIn(repositoryRoot, "HEAD");
      const index = baselinesIn(repositoryRoot, "index");
      const retired = [...head].filter(([key]) => !index.has(key)).flatMap(([, gone]) => gone.entries);
      return { head, retired: retired.length === 0 ? undefined : Object.freeze({ schema: RATCHET_SCHEMA, entries: Object.freeze(retired) }) };
    })();
    const grown = ratchetGrowth(baseline, committed.head.get(baseline.id) ?? committed.retired);
    if (grown.length > 0) grownBaselines.push({ path, grown });
  }
  return grownBaselines;
}
