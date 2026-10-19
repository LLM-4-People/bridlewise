/**
 * AN IGNORE RULE THAT MATCHES AT EVERY DEPTH BY ACCIDENT.
 *
 * ── THE CLASS, MEASURED ───────────────────────────────────────────────────
 *
 * A `.gitignore` pattern with no `/` in it matches a name at ANY depth. That
 * is git's documented behaviour and it is almost never what the person typing
 * it meant: they were thinking of one directory, at the root, holding output.
 * The rule they wrote also covers every directory of that name that will ever
 * exist anywhere in the tree — including source directories written years
 * later, and including the contents of a repository that later becomes a
 * subdirectory of this one.
 *
 * It has already happened here. `coverage/` — written for the coverage report
 * at the repository root — swallowed `src/lib/coverage/`, a live source
 * directory the component registry imports unconditionally, so the working
 * tree built and every fresh clone did not.
 *
 * And it is loaded to happen again, in the larger direction. Three trees are
 * moving toward one repository, and today one tree's unanchored patterns name
 * directories another tree TRACKS: 274 files under `docs/research/`, 53 + 27
 * under `experiments/`, and files under `.bkp/`. Nothing in git will report
 * that. Measured, on throwaway trees:
 *
 *   - `git mv` into a now-ignored path exits 0 and the file STAYS TRACKED;
 *   - `mv` followed by `git add -A` exits 0 and the file is SILENTLY DROPPED
 *     from the index.
 *
 * Same intent, same exit code, opposite outcome — and afterwards `git status`
 * is clean while the file sits on disk untracked AND ignored, so it is
 * invisible to status and gone at the next `git clean -xfd` or fresh clone.
 *
 * ── THE RULE, AND WHY IT HAS NO EXEMPTIONS ────────────────────────────────
 *
 * Every pattern must say which of the two things it means:
 *
 *   ANCHORED     — contains a `/` anywhere but the end (`/coverage/`,
 *                  `guardian/build/`). Git resolves it relative to the
 *                  directory holding the `.gitignore`, so it names ONE place.
 *   EVERY-DEPTH  — begins with `**\/`. Git resolves it at every depth, which
 *                  is right for `node_modules` and wrong for almost
 *                  everything else, and the author had to type it.
 *   IMPLICIT     — neither. Behaves exactly like `**\/`, and nobody said so.
 *
 * Only the third is refused. Nothing is exempted, including `*.log`-shaped
 * patterns: unanchored `*.log` and `**\/*.log` mean the identical thing to
 * git, so the explicit spelling costs nothing and removes the exemption
 * rather than defending it. An exemption is a claim about the world, and the
 * claims are what get this wrong.
 *
 * ── AND THE SECOND DIRECTION, WHICH THE FIRST ONE CREATES ─────────────────
 *
 * Anchoring alone would trade one silent failure for another: `/coverage/`
 * stops matching the moment this repository becomes a subdirectory of
 * another, and generated artifacts would start being tracked. The answer is
 * not to un-anchor. It is that every subtree carries its OWN `.gitignore`,
 * because git resolves an anchored pattern relative to the file that declares
 * it — so a subtree that moves takes its rules with it, correctly, with no
 * pattern edited. That property is a claim until it is driven, and the
 * callers drive it: they nest a copy of each owned subtree one level deeper
 * in a scratch repository and require every anchored pattern to still match.
 *
 * ── WHAT IS AND IS NOT IN HERE ────────────────────────────────────────────
 *
 * Rules and wording, node built-ins only, and NO SUBPROCESS. It reads one
 * kind of file — `.gitmodules`, git's own declaration of which repositories
 * live inside which — and nothing else. It is imported by both repositories'
 * suites, and each raises its own error type. The callers own the instruments
 * — `git ls-files` for the tracked population, `git check-ignore` for the
 * nesting drive — because an instrument that shares the subject's machinery
 * can only ever agree with it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The repositories declared as living INSIDE `root`, read from its
 * `.gitmodules`.
 *
 * Discovery, not a list: `.gitmodules` is git's own declaration of the
 * relationship, it is tracked, and adding a submodule tomorrow extends this
 * answer without anybody editing a guard. The alternative considered and
 * rejected was "every sibling directory holding a `.git`" — measured on this
 * workspace that returns ELEVEN repositories, most of them stale clones and
 * probe worktrees, and folding their indexes into the collision universe
 * would make the rule depend on what happens to be lying around.
 *
 * A declared submodule whose checkout is absent is skipped rather than
 * refused: a shallow clone is a legitimate state, and the caller counts the
 * roots it actually reached so a shrunken reach is visible as a number rather
 * than as a quiet pass.
 */
export function submoduleRoots(root: string): readonly string[] {
  return declaredSubmodulePaths(root).filter((candidate) => existsSync(join(candidate, ".git")));
}

/**
 * What `.gitmodules` DECLARES, before asking whether each checkout is present.
 *
 * Exists because `submoduleRoots` returns the empty array for two states a
 * caller must tell apart: `.gitmodules` is absent (this root genuinely has no
 * submodules) and `.gitmodules` declares paths whose checkouts are all gone
 * (the declaration is stale, or the parse stopped working). Both look like a
 * clean answer, and only one of them is. A caller that refuses an empty
 * universe needs the declared list to say WHICH it is refusing; deriving
 * `submoduleRoots` from this keeps one parse rather than two.
 */
export function declaredSubmodulePaths(root: string): readonly string[] {
  const declaration = join(root, ".gitmodules");
  if (!existsSync(declaration)) return [];
  const paths: string[] = [];
  for (const line of readFileSync(declaration, "utf8").split("\n")) {
    const match = /^\s*path\s*=\s*(.+?)\s*$/u.exec(line);
    if (match === null) continue;
    paths.push(join(root, match[1] ?? ""));
  }
  return paths;
}

/** One declared pattern, with where it was declared. */
export type IgnorePattern = Readonly<{
  /** Repository-relative path of the `.gitignore` that declares it. */
  readonly file: string;
  /** 1-based line number, so a failure names the line to edit. */
  readonly line: number;
  /** The pattern exactly as written, negation prefix included. */
  readonly raw: string;
  /** The pattern with any `!` prefix removed — what git matches with. */
  readonly pattern: string;
  readonly negated: boolean;
}>;

/** How git will resolve a pattern's position in the tree. */
export type Anchoring = "anchored" | "every-depth" | "implicit";

/**
 * Parse a `.gitignore` the way git reads it: blank lines and `#` comments are
 * not patterns, a leading `!` negates, and trailing whitespace is stripped
 * unless escaped.
 *
 * Deliberately NOT a full matcher. This answers one question — where in the
 * tree will git look for this name — and a matcher would be a second
 * implementation of git's globbing that could disagree with the real one. The
 * callers ask git itself whether a path is ignored.
 */
export function parseGitignore(source: string, file: string): readonly IgnorePattern[] {
  const out: IgnorePattern[] = [];
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const original = lines[index] ?? "";
    // Trailing whitespace is not part of the pattern unless backslash-escaped.
    const trimmed = original.replace(/(?<!\\)\s+$/u, "");
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("#")) continue;
    const negated = trimmed.startsWith("!");
    out.push({
      file,
      line: index + 1,
      raw: trimmed,
      pattern: negated ? trimmed.slice(1) : trimmed,
      negated,
    });
  }
  return out;
}

/**
 * Where git will look for this pattern.
 *
 * The rule is git's own: a pattern containing a `/` at any position other
 * than the trailing one is relative to the declaring `.gitignore`'s
 * directory; otherwise it matches the name at every depth. `**\/` is the
 * spelling that says "every depth" out loud.
 */
export function anchoringOf(pattern: string): Anchoring {
  const core = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
  // A LEADING SLASH DOES NOT ANCHOR `**/`, AND THE LOOK OF IT SAYS OTHERWISE.
  // git resolves `/**/x/` relative to the declaring directory and then `**/`
  // matches ZERO OR MORE directories, so it reaches every depth exactly like
  // `**/x/` does. Driven, git 2.47.3: `/**/server/` ignores `server/f.ts`,
  // `a/server/f.ts` AND `deep/er/server/f.ts`, where `/server/` ignores only
  // the first. Reading the slash as an anchor let that spelling through the
  // whole rule — and it is the spelling this file's own remedy used to print,
  // so the guard would have certified the advice that did not work.
  const body = core.startsWith("/") ? core.slice(1) : core;
  if (body.startsWith("**/")) return "every-depth";
  if (core.includes("/")) return "anchored";
  return "implicit";
}

/**
 * The literal directory name an every-depth pattern claims, or `null` when
 * the pattern is not a plain name (it holds a wildcard, so it names a shape
 * rather than a directory and cannot collide with a tracked path segment by
 * spelling).
 */
export function everyDepthName(pattern: string): string | null {
  if (anchoringOf(pattern) !== "every-depth") return null;
  const core = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
  // The optional leading `/` is dropped for the same reason `anchoringOf`
  // ignores it: it does not anchor a `**/`, so `/**/server/` names `server`.
  const body = core.startsWith("/") ? core.slice(1) : core;
  const name = body.slice("**/".length);
  if (name.length === 0) return null;
  return /[*?[\]]/u.test(name) ? null : name;
}

/**
 * Every distinct path SEGMENT appearing in a set of tracked paths.
 *
 * This is the collision universe, and it comes from the git index rather than
 * from a list of directory names somebody maintains. A name that some
 * repository tracks files under is a name no repository may ignore at every
 * depth, because the trees are converging and the ignore rule would win.
 */
export function trackedSegments(paths: Iterable<string>): ReadonlySet<string> {
  const segments = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    // The last part is the file itself; only the directories it sits under
    // can be swallowed by a directory-shaped ignore rule.
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      if (part !== undefined && part.length > 0) segments.add(part);
    }
  }
  return segments;
}

/**
 * A spelling this rule tells an operator to write instead, and the
 * `.gitignore` that should declare it.
 *
 * IT IS A FIELD RATHER THAN A SENTENCE BECAUSE THE ADVICE IS PART OF THE RULE.
 * A remedy printed only as prose cannot be fed back through the rule that
 * printed it, and one of them was wrong for exactly as long as that was true:
 * the every-depth branch advised `/**\/server/`, which git still matches at
 * every depth, so an operator who followed it changed nothing and had a message
 * saying they had. Every `why` below is BUILT from this list, and
 * `unremediedFindings` runs the list back through the rule, so a remedy the
 * rule would itself reject is a red test rather than a plausible sentence.
 */
export type Remedy = Readonly<{
  /** Repository-relative path of the `.gitignore` that should declare it. */
  readonly file: string;
  /** The pattern text, exactly as it should be typed, negation included. */
  readonly pattern: string;
}>;

/** A pattern that fails one of the two rules, with the reason in plain words. */
export type AnchoringFinding = Readonly<{
  readonly pattern: IgnorePattern;
  readonly why: string;
  /**
   * Every spelling `why` offers. All of them, not the recommended one: an
   * alternative the operator is invited to choose is advice the rule is giving,
   * and it carries the same burden as the first.
   */
  readonly remedies: readonly Remedy[];
}>;

/**
 * Every pattern that is implicitly every-depth, plus every explicitly
 * every-depth pattern whose name collides with a directory some repository
 * tracks files under.
 *
 * The two rules are reported together because they are one question asked
 * twice: is this rule going to reach further than its author could see. The
 * first catches the author who never chose; the second catches the author who
 * chose "every depth" for a name that is now somebody's source directory.
 */
export function anchoringFindings(
  patterns: readonly IgnorePattern[],
  segments: ReadonlySet<string>,
): readonly AnchoringFinding[] {
  const findings: AnchoringFinding[] = [];
  for (const pattern of patterns) {
    const negation = pattern.negated ? "!" : "";
    const anchoring = anchoringOf(pattern.pattern);
    if (anchoring === "implicit") {
      const anchored: Remedy = { file: pattern.file, pattern: `${negation}/${pattern.pattern}` };
      // THE SECOND SPELLING IS NOT ALWAYS AVAILABLE, and offering it anyway was
      // the same defect as the one below. `**/x` is refused by the collision
      // rule whenever `x` is a directory some repository tracks files under —
      // so for those names the message must say so instead of inviting a
      // choice the rule will reject on the next run.
      const name = everyDepthName(`**/${pattern.pattern}`);
      const everyDepth: Remedy = { file: pattern.file, pattern: `${negation}**/${pattern.pattern}` };
      const everyDepthAvailable = name === null || !segments.has(name);
      findings.push({
        pattern,
        remedies: everyDepthAvailable ? [anchored, everyDepth] : [anchored],
        why:
          `"${pattern.raw}" has no "/" in it, so git matches that name at EVERY depth — ` +
          `including directories nobody has written yet, and including another tree's ` +
          `source once these repositories are one. Write "${anchored.pattern}" to mean the ` +
          `one place you were thinking of` +
          (everyDepthAvailable
            ? `, or "${everyDepth.pattern}" to mean every depth on purpose.`
            : `. The every-depth spelling "${everyDepth.pattern}" is NOT open to you here: ` +
              `"${name}" is a directory git already tracks files under, so this same rule ` +
              `refuses it for the reason the next paragraph gives.`),
      });
      continue;
    }
    const name = everyDepthName(pattern.pattern);
    if (name !== null && segments.has(name)) {
      // THE REMEDY IS BUILT FROM THE NAME, NOT FROM THE PATTERN. It used to be
      // `"/" + pattern.pattern`, and every pattern reaching this branch begins
      // `**/` by construction — so the advice printed was `/**/server/`, which
      // git still matches at EVERY depth. An operator who followed it changed
      // nothing and had a message telling them they had. A remedy that does
      // not fix the thing it names is worse than no remedy, because it is
      // believed.
      const trailingSlash = pattern.pattern.endsWith("/") ? "/" : "";
      const anchored: Remedy = { file: pattern.file, pattern: `${negation}/${name}${trailingSlash}` };
      findings.push({
        pattern,
        remedies: [anchored],
        why:
          `"${pattern.raw}" ignores "${name}" at every depth, and "${name}" is a directory ` +
          `that git already TRACKS files under. When these trees become one repository the ` +
          `rule wins and those files leave the index — a plain \`mv\` plus \`git add -A\` ` +
          `stages the old path's DELETION (visible in \`git status\` until you commit, and ` +
          `silent forever after), where \`git mv\` keeps the file tracked at its new path. ` +
          `Anchor it to the one place it belongs: "${anchored.pattern}".`,
      });
    }
  }
  return findings;
}

/**
 * One `.gitignore` and everything it declares. The pair travels together
 * because half the rules here are about WHERE a pattern was written, not only
 * about what it says.
 */
export type GitignoreDeclaration = Readonly<{
  readonly file: string;
  readonly patterns: readonly IgnorePattern[];
}>;

/**
 * Anchored patterns that name a path inside a subtree which declares its own
 * `.gitignore`.
 *
 * ── WHY THIS IS THE OTHER HALF OF ANCHORING ───────────────────────────────
 *
 * Anchoring survives a subtree moving BECAUSE git resolves the pattern
 * relative to the file that declares it. That protection is only available to
 * a subtree whose rules travel with it. A root file carrying
 * `tests/performance/.report.json` is anchored, is correct today, and stops
 * matching the instant `tests/performance/` moves — while the `.gitignore`
 * sitting inside that very directory would have kept working. The rule was in
 * the wrong file, which is invisible until the move.
 *
 * Only a STRICTLY DEEPER declaring directory can claim a rule; the repository
 * root's prefix is the empty string, which every path begins with.
 */
export function misplacedAnchoredPatterns(
  declarations: readonly GitignoreDeclaration[],
): readonly AnchoringFinding[] {
  const directoryOf = (file: string): string =>
    file.endsWith(".gitignore") ? file.slice(0, -".gitignore".length) : file;
  const findings: AnchoringFinding[] = [];
  for (const declaration of declarations) {
    const directory = directoryOf(declaration.file);
    for (const pattern of declaration.patterns) {
      if (anchoringOf(pattern.pattern) !== "anchored") continue;
      const body = pattern.pattern.startsWith("/") ? pattern.pattern.slice(1) : pattern.pattern;
      const target = `${directory}${body}`;
      for (const other of declarations) {
        if (other.file === declaration.file) continue;
        const otherDirectory = directoryOf(other.file);
        if (otherDirectory.length <= directory.length) continue;
        if (!target.startsWith(otherDirectory)) continue;
        // The remedy for a MISPLACED rule is the same rule declared in the file
        // that can carry it, re-anchored to that file's own directory — which
        // is what git will resolve it against once it lives there.
        const relocated: Remedy = {
          file: other.file,
          pattern: `${pattern.negated ? "!" : ""}/${target.slice(otherDirectory.length)}`,
        };
        findings.push({
          pattern,
          remedies: [relocated],
          why:
            `"${pattern.raw}" names a path inside ${otherDirectory}, a subtree that declares its ` +
            `own rules in ${other.file}. Anchoring only survives a move when the rule travels ` +
            `with the subtree it governs; left here it stops matching the moment ${otherDirectory} ` +
            `moves, and the artifact it hides starts being tracked. Move it into ${other.file} as ` +
            `"${relocated.pattern}", which git resolves against that file's own directory.`,
        });
        break;
      }
    }
  }
  return findings;
}

/**
 * Every finding both rules produce over one set of declarations.
 *
 * One assembly, because "what does this rule refuse" is one question. The
 * refusal message and the remedy round-trip must be looking at the same set,
 * and two call sites building it separately is how they would drift apart.
 */
export function allFindings(
  declarations: readonly GitignoreDeclaration[],
  segments: ReadonlySet<string>,
): readonly AnchoringFinding[] {
  return [
    ...anchoringFindings(declarations.flatMap((declaration) => declaration.patterns), segments),
    ...misplacedAnchoredPatterns(declarations),
  ];
}

/**
 * THE REMEDY IS PART OF THE GUARD, SO IT IS HELD TO THE GUARD.
 *
 * Apply every spelling this rule prints — delete the pattern it refused, write
 * each remedy into the `.gitignore` the remedy names — and ask the rule again.
 * Anything still refused is advice that does not survive being taken, which is
 * strictly worse than no advice: an operator who follows it changes nothing,
 * and the message told them they had.
 *
 * It is the general form of a defect this file carried in one branch and, until
 * this function existed, in a second one nobody had looked at. The first
 * printed `/**\/server/` for `**\/server/`, which git still matches at every
 * depth. The second offered `**\/x` as a free alternative to `/x` for ANY
 * unanchored pattern — and `**\/x` is refused by the collision rule whenever
 * `x` is a directory some repository tracks files under, which is the case the
 * rule most often fires on.
 *
 * The caller supplies violations; a green answer over a set with no findings at
 * all proves nothing, so it also returns what it examined.
 */
export function unremediedFindings(
  declarations: readonly GitignoreDeclaration[],
  segments: ReadonlySet<string>,
): Readonly<{ examined: readonly AnchoringFinding[]; remaining: readonly AnchoringFinding[] }> {
  const examined = allFindings(declarations, segments);
  if (examined.length === 0) return { examined, remaining: [] };

  const refused = new Set(examined.map((f) => `${f.pattern.file}:${String(f.pattern.line)}`));
  const byFile = new Map<string, IgnorePattern[]>();
  for (const declaration of declarations) {
    byFile.set(
      declaration.file,
      declaration.patterns.filter((p) => !refused.has(`${p.file}:${String(p.line)}`)),
    );
  }
  for (const finding of examined) {
    for (const remedy of finding.remedies) {
      const patterns = byFile.get(remedy.file) ?? [];
      // Parsed rather than constructed: the remedy re-enters through the same
      // door a person typing it into the file would use, so a remedy that does
      // not even survive the parse is caught here too.
      patterns.push(...parseGitignore(`${remedy.pattern}\n`, remedy.file));
      byFile.set(remedy.file, patterns);
    }
  }
  const remedied = [...byFile].map(([file, patterns]) => ({ file, patterns }));
  return { examined, remaining: allFindings(remedied, segments) };
}

/**
 * The operator-facing refusal for a set of `.gitignore` declarations, or
 * `null` when every pattern names a place it can defend.
 *
 * Returned rather than thrown so each repository raises its own error type
 * while the rule and the wording live in one place.
 *
 * AN EMPTY UNIVERSE IS ITSELF A REFUSAL, on both inputs. No `.gitignore` file
 * found means the discovery broke, not that the tree is clean; no tracked
 * segment found means the index was not read, and the collision rule would
 * then certify every pattern for free. A guard whose universe comes back
 * empty must fail rather than pass.
 */
export function gitignoreAnchoringFailure(
  subject: string,
  declarations: readonly GitignoreDeclaration[],
  segments: ReadonlySet<string>,
): string | null {
  if (declarations.length === 0) {
    return (
      `${subject}: no .gitignore file was found. That is a broken discovery, not a clean ` +
      `tree — an ignore rule this check never read is a rule it certified by not looking.`
    );
  }
  const patterns = declarations.flatMap((declaration) => declaration.patterns);
  if (patterns.length === 0) {
    return (
      `${subject}: ${declarations.length} .gitignore file(s) were found and NOT ONE pattern was ` +
      `parsed out of them. Either the files are empty, or the parse stopped working; both ` +
      `produce a clean verdict for the same wrong reason.`
    );
  }
  if (segments.size === 0) {
    return (
      `${subject}: the tracked-path universe is empty, so the every-depth collision rule ` +
      `has nothing to compare against and would pass every pattern. Read the git index of ` +
      `every repository whose files these rules will govern.`
    );
  }
  const findings = allFindings(declarations, segments);
  if (findings.length === 0) return null;
  const detail = findings
    .map((f) => `  ${f.pattern.file}:${f.pattern.line}: ${f.why}`)
    .join("\n");
  return (
    `${subject}: ${findings.length} of ${patterns.length} ignore patterns across ` +
    `${declarations.length} file(s) reach further than the place they name, or sit in a file ` +
    `that cannot carry them:\n${detail}`
  );
}

/**
 * The concrete relative path an ANCHORED pattern names, for driving the
 * second direction — or `null` when the pattern is not anchored or holds a
 * wildcard, in which case there is no single path to build.
 *
 * A caller creates this path inside a scratch repository where the owning
 * subtree has been NESTED one level deeper, and asks git whether it is still
 * ignored. That is what proves anchoring survives the move rather than
 * asserting it.
 */
export function anchoredProbePath(pattern: string): string | null {
  if (anchoringOf(pattern) !== "anchored") return null;
  const core = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
  const body = core.startsWith("/") ? core.slice(1) : core;
  if (body.length === 0) return null;
  if (/[*?[\]]/u.test(body)) return null;
  return pattern.endsWith("/") ? `${body}/probe.txt` : body;
}

/**
 * ── THE OTHER DIRECTION OF THE SAME RULE: A RULE THAT STOPS SHORT ──────────
 *
 * Everything above asks whether a rule reaches TOO FAR. What follows asks
 * whether it reaches far enough to cover the one rename this workspace's own
 * contract tells operators to perform.
 *
 * §39/W-08 prescribes `mv <dir> <dir>.<label>-$(date +%s)` — move state aside,
 * never clear it, so the evidence survives. The renamed directory holds exactly
 * the bytes the ignore rule was written to keep out of the index, under a name
 * the rule does not match. `git status` stays clean, because an ignored
 * directory and an untracked-but-unmentioned one look identical to a person,
 * and `git add -A` sweeps it in.
 *
 * MEASURED: `.bridlewise.fresh-evidence-1785461259/` beside `.bridlewise/`,
 * nine files committed including the database encryption key. Nothing in this
 * tree writes the string `fresh-evidence` — an operator typed it — so the next
 * label is whatever the next operator types, and a second literal beside the
 * first would defend exactly one more spelling.
 */

/**
 * The suffix a moved-aside rename appends, as a regular expression over the
 * whole suffix.
 *
 * DERIVED FROM THE TWO LIVE SPELLINGS AND THE PRESCRIPTION, not invented:
 * `.bridlewise.fresh-evidence-1785461259` (observed, committed) and
 * `.experimental-vitest-cache.evidence-<epoch>` (written by W-08 and swept by
 * `scripts/testing/sweep-cache-evidence.ts`, which sweeps every
 * `.experimental-vitest-cache.<label>` copy, epoch or not). Both are
 * `.<label>-<unix seconds>`.
 *
 * THE EPOCH IS THE DISCRIMINATING PART, and it is why this shape can be an
 * ignore rule at all. A label alone (`.aside`, `.bkp`) is a word, and a rule
 * over words swallows directories people mean to track. Ten-or-more digits at
 * the end of a name is a timestamp, and nothing in a source tree is named after
 * one: measured on this repository, ZERO of 253 tracked path segments and zero
 * tracked basenames match it, while every one of the seven directories on disk
 * that do match is a real moved-aside directory.
 */
export const MOVED_ASIDE_SUFFIX = /^\.[A-Za-z0-9._-]+-\d{10,}$/u;

/**
 * The moved-aside spelling of one directory — the name W-08 produces.
 *
 * The label is a caller's choice on purpose: the guard drives more than one, so
 * a rule that happens to cover the ONE label somebody wrote here would still be
 * reported. The epoch is likewise supplied, so the probe is reproducible rather
 * than dependent on the clock.
 *
 * IT REFUSES A SUFFIX ITS OWN SHAPE DOES NOT ADMIT. `MOVED_ASIDE_SUFFIX` is the
 * derivation; a generator free to build names outside it would let a caller
 * probe a spelling the rule never claimed to cover and read the resulting
 * coverage as evidence about W-08's rename. Computing the shape and not judging
 * by it is the inert shape wearing a constant.
 */
export function movedAsideSpelling(directory: string, label: string, epoch: number): string {
  const suffix = `.${label}-${String(epoch)}`;
  if (!MOVED_ASIDE_SUFFIX.test(suffix)) {
    throw new Error(
      `"${suffix}" is not a moved-aside suffix (${String(MOVED_ASIDE_SUFFIX)}). W-08 renames a ` +
        `directory to <dir>.<label>-$(date +%s); a probe built from any other shape would be ` +
        `asking about a rename nothing in this workspace performs.`,
    );
  }
  return `${directory}${suffix}`;
}

/**
 * One ignore rule that names a DIRECTORY, resolved to the repository-relative
 * path it governs.
 */
export type DirectoryRule = Readonly<{
  readonly pattern: IgnorePattern;
  /** Repository-relative path the rule names, with any glob instantiated. */
  readonly directory: string;
}>;

/** The stand-in a glob metacharacter is instantiated to when building a probe. */
const GLOB_SAMPLE = "sample";

/**
 * A pattern's glob made concrete, so a rule that names a SHAPE can still be
 * probed — or `null` when the shape cannot be instantiated.
 *
 * `bench/.gitignore` carries `/.*\/`, which is not a name at all: it says "every
 * dot-directory at the bench root is scratch". A question about that rule's
 * moved-aside sibling is only answerable against a concrete member of the shape,
 * so one is built. Refusing (`null`) rather than guessing is deny-by-default:
 * an unrecognised bracket expression makes the caller red, naming the pattern,
 * instead of quietly leaving it out of a population it is supposed to bound.
 */
export function literalInstance(pattern: string): string | null {
  const core = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
  const anchorless = core.startsWith("/") ? core.slice(1) : core;
  const body = anchorless.startsWith("**/") ? anchorless.slice("**/".length) : anchorless;
  if (body.length === 0) return null;
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] ?? "";
    if (ch === "\\") {
      const next = body[i + 1];
      if (next === undefined) return null;
      out += next;
      i += 1;
      continue;
    }
    if (ch === "*" || ch === "?") {
      out += GLOB_SAMPLE;
      continue;
    }
    if (ch === "[") {
      const close = body.indexOf("]", i + 1);
      if (close === -1) return null;
      const set = body.slice(i + 1, close);
      // A NEGATED class is refused rather than sampled: picking a character
      // that is NOT in a set is a guess about the set, and a wrong guess makes
      // the probe ask about a path the rule never covered.
      if (set.startsWith("!") || set.startsWith("^") || set.length === 0) return null;
      out += set[0] ?? "";
      i = close;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * The literal, glob-free stem of a pattern — the place somebody actually wrote
 * down, before any wildcard begins.
 *
 * `**\/.bridlewise.*` → `.bridlewise.`   (a family of a place)
 * `/.dev/`              → `.dev`             (a place)
 * `**\/*-[0-9]…*`       → `` (empty)         (a SHAPE; it names nowhere)
 * `**\/*.log`           → `` (empty)         (a shape too)
 *
 * SIBLING OF `literalInstance`, AND A DIFFERENT QUESTION. That function asks
 * "what one path would this pattern name if its globs were filled in", which
 * needs a stand-in and therefore answers `.bridlewise.sample` for a family
 * rule. This one asks the weaker and more useful question: "did the author
 * write down a place at all". A pattern beginning with a wildcard did not.
 *
 * IT IS A NECESSARY CONDITION, NEVER A SUFFICIENT ONE. A stem is a prefix a
 * matching name must have; it does not establish that the pattern matches any
 * particular name, and a caller that treats it as matching has built a second,
 * wrong implementation of git's globbing. Callers classify the RULE with this
 * and then ask git about the PATH.
 */
export function patternStem(pattern: string): string {
  const core = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
  const anchorless = core.startsWith("/") ? core.slice(1) : core;
  const body = anchorless.startsWith("**/") ? anchorless.slice("**/".length) : anchorless;
  let stem = "";
  for (let at = 0; at < body.length; at += 1) {
    const ch = body[at] ?? "";
    if (ch === "\\") {
      stem += body[at + 1] ?? "";
      at += 1;
      continue;
    }
    if (ch === "*" || ch === "?" || ch === "[") break;
    stem += ch;
  }
  return stem;
}

/**
 * The rules declared at `root` that NAME a place, as written — every pattern
 * whose stem is non-empty, in file order.
 *
 * The read lives here because this module already owns "what does a
 * `.gitignore` declare": it reads them, it parses them, and it is where a
 * reader looks for the answer. A caller that opened the file itself would be a
 * second reader of one question, and would also be reading BYTES of a file
 * that is not source — no comment/string/prose view applies to a rules file,
 * whose `#` comments and `*` globs are not any programming language's.
 *
 * An absent or unreadable `.gitignore` yields no rules rather than throwing:
 * a tree with no ignore file declares nothing, which is a true answer, and the
 * caller's own liveness check is what refuses an empty universe it did not
 * expect.
 */
export function namingRulesAt(root: string): readonly string[] {
  return declaredRulesAt(root).filter((raw) => {
    const bare = raw.startsWith("!") ? raw.slice(1) : raw;
    return patternStem(bare).length > 0;
  });
}

/**
 * Every rule declared at `root`, as written, in file order — comments and
 * blank lines dropped, because they are not rules.
 *
 * The companion to `namingRulesAt`, and the reason both live here: a caller
 * that wants a scratch repository obeying THIS tree's rules needs the rules,
 * not the file. Handing it the bytes would make it a second reader of a
 * declaration this module already owns, and would put a guard's eyes on a file
 * that is not source in any language — a `.gitignore`'s `#` comments and `*`
 * globs belong to git's matcher, and no comment/string/prose view of source
 * applies to them.
 */
export function declaredRulesAt(root: string): readonly string[] {
  const declaration = join(root, ".gitignore");
  if (!existsSync(declaration)) return [];
  return parseGitignore(readFileSync(declaration, "utf8"), ".gitignore").map(
    (pattern) => pattern.raw,
  );
}

/**
 * Every rule across these declarations that names a directory, with the path
 * it names.
 *
 * DIRECTORY-STYLE MEANS ONE OF TWO THINGS, and both are needed. A trailing `/`
 * is git's own way of saying "a directory only". Without one, the pattern may
 * still name a directory — `engine/.gitignore` carries `/large-codebases` with
 * NO slash, deliberately, because the path is a SYMLINK and a trailing slash
 * makes git match real directories only. So the second test is the disk, asked
 * through a predicate the caller supplies: this module owns rules and wording
 * and creates no subprocess and reads no tree.
 *
 * Negated patterns are skipped. A `!` rule re-admits a path; it ignores
 * nothing, so it has no coverage obligation.
 */
export function directoryStyleRules(
  declarations: readonly GitignoreDeclaration[],
  namesADirectory: (repositoryRelativePath: string) => boolean,
): readonly DirectoryRule[] {
  const directoryOf = (file: string): string =>
    file.endsWith(".gitignore") ? file.slice(0, -".gitignore".length) : file;
  const rules: DirectoryRule[] = [];
  for (const declaration of declarations) {
    const base = directoryOf(declaration.file);
    for (const pattern of declaration.patterns) {
      if (pattern.negated) continue;
      const instance = literalInstance(pattern.pattern);
      if (instance === null) continue;
      const directory = `${base}${instance}`;
      if (!pattern.pattern.endsWith("/") && !namesADirectory(directory)) continue;
      rules.push({ pattern, directory });
    }
  }
  return rules;
}

/**
 * The least population a live walk may return, stated PER BRANCH.
 *
 * `directoryStyleRules` admits a pattern two ways, and only one of them asks
 * the disk. A trailing `/` is git's own declaration and needs no predicate; a
 * SLASHLESS pattern is admitted only when `namesADirectory` says the path is a
 * directory, so that predicate is the sole supplier of the second branch.
 *
 * A SINGLE SCALAR CANNOT SEE THAT BRANCH DIE, and that is measured rather than
 * feared: with `namesADirectory` replaced by `() => false`, this repository's
 * `examined` moved 32 -> 31 and every remaining rule was still covered, so the
 * verdict stayed green while `engine/.gitignore`'s `/large-codebases` — the one
 * slashless rule in the tree, and the one the slashless branch exists for — was
 * silently dropped. A floor of 25 cannot see a loss of one. Per-branch liveness
 * can, and a scalar never will however high it is set.
 */
export type CoverageFloor = Readonly<{
  /** Least number of directory-style rules a live walk finds, both branches. */
  readonly rules: number;
  /**
   * Least number admitted by the DISK predicate — patterns with no trailing
   * `/`. One is enough: this is liveness, not a budget.
   */
  readonly slashless: number;
}>;

/**
 * The operator-facing refusal for directory rules whose moved-aside sibling no
 * rule covers, or `null` when every one of them is covered.
 *
 * AN EMPTY POPULATION IS A REFUSAL, for the reason `gitignoreAnchoringFailure`
 * gives: a walk that returned nothing certifies every rule for free, and the
 * `namesADirectory` predicate is exactly the input that can silently shrink it
 * (a symlink that stopped existing takes its rule out of the subject). Both
 * refusals live HERE rather than at the call site so every caller — the live
 * assertion and the plant that certifies it — is held to the same population.
 */
export function movedAsideCoverageFailure(
  subject: string,
  examined: readonly DirectoryRule[],
  uncovered: readonly DirectoryRule[],
  floor: CoverageFloor,
): string | null {
  if (examined.length < floor.rules) {
    return (
      `${subject}: only ${examined.length} directory-style ignore rule(s) were found, below the ` +
      `floor of ${floor.rules}. That is a walk that shrank, not a tree that got simpler — a rule ` +
      `this check never examined is a rule it certified by not looking.`
    );
  }
  const slashless = examined.filter((rule) => !rule.pattern.pattern.endsWith("/"));
  if (slashless.length < floor.slashless) {
    return (
      `${subject}: ${slashless.length} of ${examined.length} directory-style ignore rule(s) have ` +
      `no trailing "/", below the floor of ${floor.slashless}. A slashless pattern enters this ` +
      `population ONLY because the disk predicate said its path is a directory, so a count of ` +
      `zero means that predicate answered no to everything and the branch it supplies is dead — ` +
      `not that the tree stopped carrying such a rule. The total above cannot see this: losing ` +
      `the whole branch moves it by one.`
    );
  }
  if (uncovered.length === 0) return null;
  const detail = uncovered
    .map(
      (rule) =>
        `  ${rule.pattern.file}:${String(rule.pattern.line)}: "${rule.pattern.raw}" ignores ` +
        `${rule.directory}, and nothing ignores ${rule.directory}.<label>-<epoch>.`,
    )
    .join("\n");
  return (
    `${subject}: ${uncovered.length} of ${examined.length} directory-style ignore rule(s) do not ` +
    `cover their own MOVED-ASIDE spelling:\n${detail}\n\n` +
    `§39/W-08 tells operators to preserve state by renaming it — \`mv <dir> ` +
    `<dir>.<label>-$(date +%s)\` — and the renamed directory holds exactly the bytes the rule ` +
    `above was written to keep out of the index, under a name it does not match. That is how ` +
    `nine files including a database encryption key were committed from ` +
    `\`.bridlewise.fresh-evidence-<epoch>/\` with \`git status\` clean throughout. Do NOT fix ` +
    `this by adding one literal per rule: the next label is whatever the next operator types. ` +
    `The root \`.gitignore\` carries a single rule for the SHAPE — a name ending in ` +
    `\`.<label>-<unix seconds>\` — and a rule reported here is one that shape does not reach.`
  );
}
