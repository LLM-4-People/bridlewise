/**
 * THE ONE OWNERSHIP-PRUNED SOURCE WALK, shared by both test suites.
 *
 * A guard that scans source needs three things, and each used to be answered
 * separately by every guard: WHICH files the repository owns (not
 * dependencies, build output, runtime state or research copies parked under
 * an ignored directory), a refusal when the scan root is missing, unreadable
 * or ignored (a guard over nothing passes), and a SECOND INSTRUMENT that
 * notices when the walk silently lost part of its universe. The web suite had
 * all three in `tests/helpers/source-scan.ts`; the engine suite had ~55
 * hand-written `readdirSync` walkers with their own name lists. This module is
 * the single implementation: `tests/helpers/source-scan.ts` re-exports it and
 * engine guards import it directly.
 *
 * Ownership is the one reader `src/git/repository-ownership.ts`; nothing here
 * restates the ignore rules as a name list. A caller that deliberately narrows
 * its scan passes `ignore` and has said so in its own source.
 */
import { readdirSync, existsSync, statSync, realpathSync } from "node:fs";
import { join, relative, resolve as resolvePath, sep, extname } from "node:path";

import {
  ownedEntries,
  presentTrackedFiles,
  repositoryOwnership,
  type RepositoryOwnership,
} from "../../src/git/repository-ownership.ts";
import { shouldExcludeExperiment } from "../../src/shared/source-scan.ts";

/**
 * Every executable source extension the prevention suite scans. The single
 * owner of the extension set so a new executable extension added here
 * auto-covers every prevention test that imports it (deny-by-default: a
 * future `.mjs`/`.cjs` route with raw SQL or a scattered `BEGIN` is caught,
 * not silently skipped because the scan only looked at `.ts`). Covers the
 * Svelte/TS app (`.ts` + `.svelte`) and plain JS modules (`.mjs`/`.cjs`/
 * `.js`) so a bypass cannot hide in a non-TS extension.
 */
export const SOURCE_EXTS: readonly string[] = [".ts", ".svelte", ".mjs", ".cjs", ".js"];

/**
 * The repository-relative paths git holds in its index for the repository
 * whose top level is `repositoryRoot` AND that were present on disk when this
 * process first asked, read once per repository and cached.
 *
 * ── AN UNSTAGED DELETION IS ABSENT, NOT MISSING ───────────────────────────
 *
 * A tracked file deleted in the working tree (a module removed and awaiting
 * its commit) is a legitimate state, and git itself names it
 * (`ls-files --deleted`, via `presentTrackedFiles`). It is excluded from the
 * expectation, so a live tree holding deletions walks clean without touching
 * the index. The answer is cached at the FIRST question: a tracked file that
 * disappears AFTER it (removed or emptied out from under a run) is still
 * expected, so the walk still refuses a universe that shrank during the run.
 * A file that exists and was not walked is always refused.
 *
 * THIS IS THE SUITE'S SECOND INSTRUMENT. Everything else the prevention tests
 * know about the tree comes from walking the filesystem, which means every
 * such answer shares one failure mode: a directory that is not descended
 * produces "nothing is wrong" and "nothing was looked at" as the same value.
 * The index is written by git, cannot be steered by any pattern in this
 * repository, and is therefore able to DISAGREE. A guard with one instrument
 * can only be self-consistent; two instruments plus an explained gap is the
 * shape that can actually catch a loss.
 *
 * Cached per repository for the life of the process: a test run never
 * changes the index it scans (tests write working copies, never the live
 * checkout), and a scratch repository created by a test gets its own entry.
 * The ignored set, by contrast, is never cached (see the ownership reader).
 */
const TRACKED_PATHS_CACHE = new Map<string, ReadonlySet<string>>();

export function gitTrackedPaths(repositoryRoot: string): ReadonlySet<string> {
  const key = resolvePath(repositoryRoot);
  const cached = TRACKED_PATHS_CACHE.get(key);
  if (cached !== undefined) return cached;
  const listed = presentTrackedFiles(key);
  if (listed === undefined) throw new Error(`gitTrackedPaths(): ${key} is not inside a git working tree`);
  const paths = new Set(listed);
  TRACKED_PATHS_CACHE.set(key, paths);
  return paths;
}

/**
 * What a caller may narrow. `exts` chooses the extensions; `ignore` names
 * directory entries the caller deliberately does not look at; `exclude` is a
 * declared predicate over absolute paths (e.g. {@link experimentExclusion}).
 * Every narrowing is written at the call site, and the index-coverage oracle
 * applies the same narrowing to what it expects, so a narrowed walk is judged
 * against the narrowed index — never silently smaller than it.
 */
export type WalkOptions = Readonly<{
  exts?: readonly string[];
  ignore?: readonly string[];
  exclude?: (absolutePath: string) => boolean;
}>;

/**
 * The engine's one declared extra exclusion, as a walk predicate: experiment
 * directories directly below an engine scan root (`src/exp420/`, …), unless
 * `HARNESS_INCLUDE_EXPERIMENTS` opts them back in. `engineRoot` is the root the
 * experiment scan roots (`src/`, `test/`, …) are relative to.
 */
export function experimentExclusion(engineRoot: string): (absolutePath: string) => boolean {
  const base = resolvePath(engineRoot);
  return (absolutePath) => {
    const path = relative(base, absolutePath).split(sep).join("/");
    return !path.startsWith("..") && shouldExcludeExperiment(path);
  };
}

/**
 * The refusal `walk` raises when its answer is smaller than the index — and
 * it CARRIES THE PARTIAL ANSWER.
 *
 * ── WHY THE PARTIAL ANSWER IS ON THE ERROR ────────────────────────────────
 *
 * Earned immediately, by breaking something. The suite's source-tree
 * fingerprint calls `walk` twice around the whole run and compares the two
 * maps; a test that DELETES a tracked source file is exactly what it exists to
 * catch. Once `walk` refused on that deletion, the fingerprint's second call
 * threw before it could reach its verdict, vitest printed `error during close`
 * — and the process EXITED 0. A stricter helper made a correct guard blind.
 *
 * The two obvious repairs are both worse. An opt-out parameter is a hole any
 * caller can take and every caller must remember not to; a private walker in
 * the consumer is a second implementation of the universe. So the refusal
 * carries what it had found when it decided to refuse: a caller that must
 * still say something precise about the files it CAN see reads `found`, and a
 * caller that does not catch still gets a throw. Nothing is opted out of.
 *
 * GENERAL FORM, and it is the workflow lesson: adding a throw to a shared
 * helper changes the behaviour of every guard that calls it, and none of
 * those guards' own mutation plants can see it — each mutates only its own
 * subject. The helper's CONSUMERS are the population that must be re-driven.
 */
export class ScanUniverseError extends Error {
  readonly found: readonly string[];
  readonly missing: readonly string[];

  constructor(message: string, found: readonly string[], missing: readonly string[]) {
    super(message);
    this.name = "ScanUniverseError";
    this.found = found;
    this.missing = missing;
  }
}

/**
 * REFUSE A WALK THAT RETURNED LESS THAN THE GIT INDEX SAYS EXISTS.
 *
 * The expectation is DERIVED, per call, for exactly the `(root, extensions)`
 * pair the caller asked about: every tracked path under `root` whose
 * extension the caller selected, minus the paths a CALLER-SUPPLIED `ignore`
 * entry removes.
 *
 * ── WHY ONLY A CALLER-SUPPLIED `ignore` NARROWS THE EXPECTATION ───────────
 *
 * `scoped` is the difference between a declared scope and an accident. A test
 * that writes `ignore: ["helpers"]` has SAID what it is not looking at, and
 * that sentence is in its source where a reader can argue with it. The
 * walk has no default name list at all: what the repository does not own
 * comes from its versioned `.gitignore` files, which never hide a TRACKED
 * file, so an unscoped walk is expected to reach every tracked file under its
 * root.
 *
 * The comparison is set containment, never a count. See the note on `walk`
 * for why: the right number with the wrong set is a real outcome here.
 */
function assertIndexCoverage(
  root: string,
  exts: readonly string[],
  ignore: ReadonlySet<string>,
  scoped: boolean,
  exclude: ((absolutePath: string) => boolean) | undefined,
  found: readonly string[],
  extensionsChosen: boolean,
  ownership: RepositoryOwnership | null,
): void {
  const absoluteRoot = resolvePath(root);
  const repositoryRoot = ownership?.repositoryRoot;
  if (repositoryRoot === undefined) return;
  const prefix = relative(repositoryRoot, absoluteRoot).split(sep).join("/");
  // A root ABOVE the repository root (`..` segments) is not covered by this
  // index; saying nothing is the honest answer, and a bare `""` prefix means
  // the root IS the repository root.
  if (prefix.startsWith("..")) return;

  const expected: string[] = [];
  const omittedByDefault: string[] = [];
  for (const tracked of gitTrackedPaths(repositoryRoot)) {
    let underRoot: string;
    if (prefix === "") underRoot = tracked;
    else if (tracked.startsWith(`${prefix}/`)) underRoot = tracked.slice(prefix.length + 1);
    else continue;
    if (scoped && underRoot.split("/").some((segment) => ignore.has(segment))) continue;
    if (exclude?.(join(repositoryRoot, tracked)) === true) continue;
    const extension = extname(underRoot);
    if (!exts.includes(extension)) {
      if (
        !extensionsChosen &&
        SOURCE_EXTS.includes(extension)
      ) {
        omittedByDefault.push(tracked);
      }
      continue;
    }
    expected.push(tracked);
  }

  // ── THE EXTENSION SET IS PART OF THE UNIVERSE, AND NOTHING CHECKED IT ────
  //
  // The containment check below compares the walk against the index FOR THE
  // EXTENSIONS THE CALL ASKED ABOUT, so a whole extension missing from the
  // request is invisible by construction: the files are not expected, so they
  // cannot be missing. That is how a `.mjs` fork of a guarded script sat in a
  // scanned root, read by nothing, while every guard over that root stayed
  // green.
  //
  // A caller that NAMES its extensions has made a decision and is left alone —
  // narrowing to `.ts` on a directory of Svelte components is a legitimate
  // question. A caller that took the DEFAULT has not decided anything, and the
  // default is a claim about what source looks like rather than about this
  // root. So the default is refused the moment the index disagrees with it, and
  // the fix is one of two explicit answers rather than a silence.
  if (omittedByDefault.length > 0) {
    const shown = omittedByDefault.slice(0, 10).join(", ");
    const rest =
      omittedByDefault.length > 10 ? ` … and ${omittedByDefault.length - 10} more` : "";
    throw new ScanUniverseError(
      `walk(): this call took the DEFAULT extensions (${exts.join("|")}) and the git index holds ` +
      `${omittedByDefault.length} tracked executable source file(s) under ` +
      `"${prefix === "" ? "." : prefix}" that they exclude: ${shown}${rest}. The default is a ` +
      `claim about what source looks like in general, not about this root, and a guard reading ` +
      `this result would report that nothing is wrong about files it never opened. Pass \`exts\` ` +
      `to include them, or pass \`exts\` naming exactly what this guard means to judge — either ` +
      `is a decision, and taking the default here is not.`,
      found,
      omittedByDefault,
    );
  }

  const walked = new Set(
    found.map((file) => relative(repositoryRoot, resolvePath(file)).split(sep).join("/")),
  );
  const missing = expected.filter((path) => !walked.has(path));
  if (missing.length === 0) return;

  const shown = missing.slice(0, 10).join(", ");
  const rest = missing.length > 10 ? ` … and ${missing.length - 10} more` : "";
  throw new ScanUniverseError(
    `walk(): the git index holds ${expected.length} tracked file(s) under ` +
    `"${prefix === "" ? "." : prefix}" with extension ${exts.join("|")}, and this walk returned ` +
    `${found.length}; ${missing.length} tracked file(s) were never visited: ${shown}${rest}. ` +
    `The index is a second instrument written by git, so a walk that returns less than it holds ` +
    `has lost part of its universe — an entry whose stat failed (a directory counts as ONE entry ` +
    `and can be a thousand files), a real directory colliding with an ignore name ` +
    `(${[...ignore].join(", ") || "none"}${scoped ? ", supplied by this caller" : ", the default"}), ` +
    `or a tracked file no longer on disk. A guard reading ` +
    `this result would scan the smaller tree and report that nothing is wrong.`,
    found,
    missing,
  );
}

/**
 * Recursively collect every `.ts` + `.svelte` file under a root, returning
 * joined paths (relative when the root is relative). The default extensions
 * cover the common prevention-test scan (mixed Svelte + TS sources); pass
 * `exts` to narrow (e.g. `.ts` only). What the repository does not own
 * (dependencies, build output, state) is pruned by its versioned ignore rules.
 *
 * ── A MISSING ROOT IS A REFUSAL, NEVER AN EMPTY ANSWER ────────────────────
 *
 * This function used to answer "nothing was found" and "nothing was looked
 * at" with the identical value: `[]`. Two lines did it — an `existsSync`
 * miss, and a `realpathSync` failure — and 106 guard files in 258 places
 * inherit whichever one fires. A guard whose subject directory is renamed
 * then reads no files, finds no offenders, and passes; the ones with no
 * population floor cannot tell that from clean, and the eight files that
 * report by `throw new Error` when the offender list is non-empty are
 * structurally incapable of telling them apart, because both states produce
 * an empty list.
 *
 * The refusal lives HERE rather than at the call sites because callers do not
 * own this function and so cannot forget it. That is the whole reason it is
 * one line in one place instead of an `expectNonEmpty(files)` helper every
 * future caller must remember to invoke — a helper you must remember is a
 * list you must maintain.
 *
 * BOTH paths throw, and the second one is a RACE guard rather than a second
 * reachable hole — which is worth writing down, because it was described as a
 * second hole and it measurably is not. Every input tried that makes
 * `realpathSync` fail (a dangling symlink, a symlink loop, a parent stripped
 * of its execute bit) makes `existsSync` return false FIRST, so the two
 * checks never disagree on an ordinary tree; a mutation reverting only the
 * `realpathSync` throw changes no answer this repository can produce. What is
 * left is the interval BETWEEN the two syscalls: a root removed there reaches
 * the catch, and a silent `[]` at that moment is exactly as invisible as at
 * any other. It throws for that reason, not because it doubles the coverage.
 *
 * ── AND THE FLOOR IS THE GIT INDEX, NOT A NUMBER ─────────────────────────
 *
 * Still deliberately NOT a `minimum` parameter, for the reason that argument
 * always had: the 258 call sites resolve to 88 distinct `(root, extensions)`
 * pairs, 47 of them iterate a SET of roots, and a per-call floor over a set
 * is forced down to its weakest member — 0 for the loop that discovers its
 * own roots, 1 for the `src/lib/*` sweep. A number written at the call site
 * bounds the weakest root and certifies nothing about the rest.
 *
 * What replaced it is `assertIndexCoverage` below, and it is not a floor a
 * caller supplies — it is a SECOND INSTRUMENT. `git ls-files` is written by
 * git, cannot be influenced by anything in this repository, and already knows
 * every source file that exists under any root. So the walk's answer is
 * checked for CONTAINMENT rather than for size: every tracked file under this
 * `(root, extensions)` pair, minus the ones an `ignore` entry legitimately
 * removes, must appear in what the walk returned. Nothing is spelled as a
 * count anywhere — the expectation is derived per call, from the index, for
 * exactly the pair that call asked about.
 *
 * A count would not have been enough, and that is measurable: a walk can
 * return the RIGHT NUMBER of files and the WRONG SET (one tracked file lost
 * inside a directory whose name collides with an `ignore` entry, one
 * untracked scratch file picked up elsewhere). Containment sees that; a
 * quotient does not. The mutation that swaps containment for `length >=`
 * exists for this reason.
 *
 * WHAT IT CATCHES that the two refusals above cannot — all of them silent
 * today, all of them a PARTIAL loss of the universe rather than a total one:
 *   - the per-entry `statSync` skip below swallowing a DIRECTORY, or every
 *     entry at once. DRIVEN: take the execute bit off a directory and leave
 *     the read bit, and `readdirSync` SUCCEEDS while every child `statSync`
 *     fails with EACCES — so the skip below fires for every entry, the root
 *     still exists and still `realpath`s, neither refusal above fires, and the
 *     caller receives `[]` for a tree full of source. "One entry, not the
 *     universe" is true of the code and can be false of the outcome;
 *   - a real source directory whose name collides with an `ignore` entry;
 *   - a tracked file removed from disk DURING a run (after the process first
 *     asked the index), so the guard reads a smaller tree than the run
 *     started with. A deletion already present when the process first asked
 *     is an unstaged deletion — a legitimate state, absent rather than
 *     missing (see {@link gitTrackedPaths}).
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it never complains that the walk found
 * MORE than the index holds. Untracked files are normal in a working tree —
 * scratch directories, build output, a file being written — and refusing on
 * them would make every guard in the suite hostage to the tidiness of the
 * checkout. The other direction is a different question with a different
 * owner: `tests/prevention/tracked-source-owner.test.ts` asks whether a
 * source file the program NEEDS is absent from the index, scoped to the roots
 * where that is a defect rather than a normal state.
 *
 * A root outside any git repository is skipped rather than refused, because
 * the second instrument does not exist there — there is no index to disagree
 * with. That is the only case where this check is silent, and it is silent
 * because it has nothing to say, not because it found nothing wrong.
 *
 * The per-entry `statSync` failure below stays a skip and says why: it is one
 * entry, not the universe, and the walk still returns everything else — and
 * now the index says so out loud when that entry mattered.
 */
export function walk(
  root: string,
  opts: WalkOptions = {},
  visited: Set<string> = new Set(),
  // Computed once by the top-level call and handed down; `null` means the root
  // is outside any git work tree, so there is no declaration to apply.
  ownership?: RepositoryOwnership | null,
): string[] {
  const extensionsChosen = opts.exts !== undefined;
  const exts = opts.exts ?? [".ts", ".svelte"];
  const scoped = opts.ignore !== undefined;
  // No default name list: the repository's versioned ignore rules (below)
  // already exclude dependencies and build output inside a work tree, and a
  // root outside one has no declaration, so everything under it is scanned.
  const ignore = new Set(opts.ignore ?? []);
  const out: string[] = [];
  if (!existsSync(root)) {
    throw new Error(
      `walk(): scan root does not exist: ${root} (resolved: ${resolvePath(root)}). ` +
      `A guard whose root is absent scans nothing and passes; say where the files moved, ` +
      `or discover the roots instead of naming them.`,
    );
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch (error) {
    throw new Error(
      `walk(): scan root is unreadable: ${root} (resolved: ${resolvePath(root)}): ` +
      `${error instanceof Error ? error.message : String(error)}. ` +
      `An unreadable root yields no files, which is indistinguishable from a clean tree.`,
    );
  }
  if (visited.has(realRoot)) return out;
  // THE TOP-LEVEL CALL IS THE ONE THE CALLER SEES, and it is the only one
  // whose answer becomes a guard's universe. `visited` is empty exactly once
  // per call from outside; every recursive descent below arrives with it
  // populated, so the index check runs once per caller rather than once per
  // directory.
  const isTopLevel = visited.size === 0;
  const owned = ownership === undefined ? repositoryOwnership(root) ?? null : ownership;
  // ── ONLY WHAT THE REPOSITORY OWNS ────────────────────────────────────────
  //
  // The disk holds more than the repository: dependencies, build output,
  // runtime state, and research copies of whole source trees parked under a
  // gitignored directory (`research/responses-api/**` was read by the
  // truncation guard as if it were production source). The repository's
  // versioned `.gitignore` files already declare what it does not own, and
  // `repositoryOwnership` (the one reader of that declaration, shared with the
  // engine suite) answers it once per top-level walk, so every entry is pruned
  // at the directory rather than filtered afterwards. A tracked file is never
  // pruned: git only reports untracked ignored paths.
  //
  // An ignored ROOT is refused rather than answered with `[]`, for the reason
  // the missing root above is: a guard whose root the repository does not own
  // scans nothing it owns and would pass. Discover roots through
  // `repositoryOwnedEntries` instead of naming or listing an ignored one.
  if (isTopLevel && owned?.isIgnored(root)) {
    throw new Error(
      `walk(): scan root is ignored by the repository's .gitignore: ${root}. The repository does not own ` +
      `it, so a guard over it judges bytes nobody ships; discover roots with repositoryOwnedEntries().`,
    );
  }
  visited.add(realRoot);
  for (const entry of readdirSync(root)) {
    if (ignore.has(entry)) continue;
    const full = join(root, entry);
    if (opts.exclude?.(full) === true) continue;
    if (owned?.isIgnored(full)) continue;
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      // ONE ENTRY, NOT THE UNIVERSE. A broken symlink or an unreadable file
      // inside a readable tree drops that entry and the walk continues; the
      // caller still receives every other file, so the scan's universe is
      // narrowed by one rather than emptied. That is the difference from the
      // two refusals above, and it is why this one is allowed to stay silent.
      continue;
    }
    if (isDir) {
      out.push(...walk(full, { ...opts, exts: [...exts], ...(scoped ? { ignore: [...ignore] } : {}) }, visited, owned));
    } else if (exts.includes(extname(full))) {
      out.push(full);
    }
  }
  if (isTopLevel) assertIndexCoverage(root, exts, ignore, scoped, opts.exclude, out, extensionsChosen, owned);
  return out;
}

/**
 * Recursively collect every `.ts` file under a root (joined paths). The
 * `.ts`-only narrowing covers the backend + state-module scans that must not
 * pick up `.svelte` components.
 */
export function walkTs(root: string): string[] {
  return walk(root, { exts: [".ts"] });
}

/**
 * The entries of `dir` the repository owns — the door for guards that
 * DISCOVER their scan roots from a directory listing, so a gitignored tree
 * (dependencies, build output, `research/` copies) and git's own directory
 * never become a root. Outside a work tree there is no declaration, so every
 * entry is returned.
 */
export function repositoryOwnedEntries(dir: string): string[] {
  const owned = ownedEntries(dir);
  return owned === undefined ? readdirSync(dir).toSorted() : [...owned];
}
