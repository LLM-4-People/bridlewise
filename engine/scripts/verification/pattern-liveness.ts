/**
 * PER-PATTERN LIVENESS — the rule that a SCALAR FLOOR CANNOT EXPRESS.
 *
 * ── THE CLASS THIS EXISTS FOR ─────────────────────────────────────────────
 *
 * Every declaration that selects files — a tsconfig `include`, a test
 * runner's `include`, a discovery policy's pattern list — is a LIST of
 * patterns whose results are unioned. Every guard over such a declaration has
 * historically been a floor on the UNION: "more than 300 test files were
 * discovered", "the compiler found some inputs". A floor on the union is
 * blind to the loss of any single pattern, because the survivors keep the
 * total above it. Measured on this project, all four driven:
 *
 *   - a web tsconfig with one dead `include` pattern typechecks 588 of 1,064
 *     files and EXITS 0; only when EVERY pattern is dead does TypeScript say
 *     `TS18003 No inputs were found`;
 *   - dropping `tests/cockpit/**` from the web runner's `include` loses 121
 *     of 451 files and still clears a `discovered > 300` floor;
 *   - dropping `tests/unit/**` loses 99 and clears it;
 *   - dropping `tests/performance/**` loses 1 and clears it.
 *
 * A PARTIAL loss of a universe is invisible; only a TOTAL loss is caught.
 * The answer is not a bigger floor — a bigger floor is still a scalar, and a
 * scalar cannot see which PART collapsed. The answer is that every declared
 * pattern must be able to name at least one file, and a pattern that names
 * nothing is a REFUSAL that says WHICH pattern died.
 *
 * ── WHY THIS FILE IS THE OWNER AND NOT A SECOND COPY ──────────────────────
 *
 * `test-surface.ts::assertEveryQualifiedPatternIsLive` already implemented
 * this rule for one declaration, against regexes and a git-derived
 * population. Two more declarations in two repositories now need it against
 * globs and the filesystem. The half that is AGNOSTIC — "which of these
 * declared patterns matched nothing, and what does the operator have to be
 * told" — lives here once and every caller consumes it; only the half that is
 * SPECIFIC (how a pattern is matched, and which error type the repository
 * raises) belongs to the caller. Adding a fourth declaration is a call, not a
 * fourth copy of the rule.
 *
 * DEPENDENCY-FREE ON PURPOSE: node built-ins only. It is imported from a
 * Vite config, from verification scripts, and from both repositories' test
 * suites, and a transitive import of the harness's configuration machinery
 * would make a build config load the whole harness to answer one question.
 */
import { globSync } from "node:fs";

/**
 * A pattern that was DECLARED, and the size of the population it turned out
 * to select. `matched` is the OUTPUT of the pattern, never a re-statement of
 * the pattern's text — a guard that reads the declaration and reports on the
 * declaration certifies the input and stays silent about the answer, which is
 * the exact shape that let a non-matching pattern pass for "dynamic
 * discovery".
 */
export type PatternMatch = Readonly<{
  readonly pattern: string;
  readonly matched: number;
}>;

/** Every declared pattern that selected nothing, in declaration order. */
export function deadPatterns(matches: readonly PatternMatch[]): readonly string[] {
  return matches.filter((m) => m.matched === 0).map((m) => m.pattern);
}

/**
 * The operator-facing refusal for a declaration with a dead pattern, or
 * `null` when every pattern is live.
 *
 * Returned rather than thrown so each repository raises its OWN error type
 * with its own code, while the RULE and the WORDING stay in one place. A
 * message is part of the enforcement here: the failure a scalar floor
 * produces ("only 330 files were discovered") sends the reader to look for a
 * deleted test, and the failure that helps names the pattern that stopped
 * matching.
 *
 * AN EMPTY DECLARATION IS ITSELF A REFUSAL. A caller that reads its patterns
 * from a config file and finds none has not proved the declaration healthy —
 * it has proved it could not find the declaration, which is the silently
 * smaller universe wearing the answer's clothes.
 */
export function patternLivenessFailure(
  subject: string,
  matches: readonly PatternMatch[],
): string | null {
  if (matches.length === 0) {
    return (
      `${subject} declares NO patterns. An empty declaration selects nothing and ` +
      `agrees with every floor; if the declaration moved, say where, and if it is ` +
      `genuinely empty, delete it rather than leaving a gate that checks nothing.`
    );
  }
  const dead = deadPatterns(matches);
  if (dead.length === 0) return null;
  const total = matches.reduce((sum, m) => sum + m.matched, 0);
  const live = matches
    .filter((m) => m.matched > 0)
    .map((m) => `${m.pattern} → ${m.matched}`)
    .join(", ");
  return (
    `${subject}: ${dead.length} of ${matches.length} declared patterns match NO file: ` +
    `${dead.join(", ")}. The surviving patterns still select ${total} files, so every ` +
    `total-count floor over this declaration passes while the dead pattern's files are ` +
    `silently no longer covered. Either the files moved and the pattern must follow, or ` +
    `the pattern is dead and must be deleted from the declaration. ` +
    `Live patterns: ${live.length === 0 ? "(none)" : live}.`
  );
}

/**
 * What each glob pattern selects on disk, in declaration order.
 *
 * `node:fs`'s own `globSync` is the matcher, which is deliberate on two
 * counts. It is the BUILT-IN mechanism, so there is no glob dialect of this
 * project's own invention to drift from the one the tools actually use; and
 * it is INDEPENDENT of the consumer being checked — TypeScript resolves a
 * tsconfig `include` with its own matcher and Vite resolves a runner
 * `include` with another, so a disagreement between them and this is a
 * finding rather than a tautology. An instrument that shares the subject's
 * machinery can only ever agree with it.
 *
 * `exclude` is applied exactly as the declaration applies it, because a
 * pattern whose every match is excluded is dead in the only sense that
 * matters: no file reaches the tool through it.
 */
export function globMatchCounts(
  patterns: readonly string[],
  cwd: string,
  exclude: readonly string[] = [],
): readonly PatternMatch[] {
  return patterns.map((pattern) => ({
    pattern,
    matched: globSync(pattern, exclude.length === 0 ? { cwd } : { cwd, exclude: [...exclude] }).length,
  }));
}

/**
 * What each REGEX alternative selects, over a supplied list of paths.
 *
 * ── WHY A SECOND COUNTER AND NOT A SECOND OWNER ───────────────────────────
 *
 * The fourth declaration class this project has is a regex, not a glob:
 * Playwright's `testMatch`. Everything downstream is identical — which
 * alternatives matched nothing, what the survivors still select, what an
 * operator must be told — so the VERDICT stays with `patternLivenessFailure`
 * and only the MATCHER differs. That is the whole reason this is nine lines
 * here rather than a parallel liveness story over there.
 *
 * A regex declaration hides its dead members better than a glob does, because
 * alternation makes them invisible: `(e2e|cockpit\/e2e)\/` still matches every
 * file under `cockpit/e2e/`, so a run that lost `tests/e2e/` entirely finds
 * exactly the same specs and says nothing. Total loss is loud (`No tests
 * found`); PARTIAL loss is silent, which is this class in one sentence.
 *
 * The alternatives are supplied by the caller because splitting a regex is the
 * one part that is specific to how a declaration is written — and a splitter
 * living here would be this module guessing at a syntax it does not own.
 */
export function regexMatchCounts(
  alternatives: readonly string[],
  paths: readonly string[],
): readonly PatternMatch[] {
  return alternatives.map((alternative) => ({
    pattern: alternative,
    matched: paths.filter((path) => new RegExp(alternative, "u").test(path)).length,
  }));
}
