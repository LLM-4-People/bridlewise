/**
 * DECLARED CAUSE FIXES — the flaky-test memory's declarations, read from git,
 * with the recorded reproductions that make them count (the verdict itself
 * is pure: src/shared/run-history.ts `flakyVerdictWithin`; the FLAKE-REPRO
 * decision).
 *
 * A commit that fixes the cause of an indicted test says so in its own
 * message, one trailer per test:
 *
 *     Flake-cause: <ledger identity> => <repository path>[, <repository path>…][ @ <fix commit>]
 *
 * naming the paths whose content the failure depended on (the cause's; the
 * test's own file is added here from the identity, and it may itself be the
 * cause). A later commit may declare an earlier fix that carried no trailer
 * by naming it (`@ <commit>`). A declaration explains NOTHING by itself: the
 * fix must have changed a declared cause SEMANTICALLY (the one semantic
 * reader, src/quality/languages/semantic-form.ts: a comment or layout edit
 * never counts, and is said by name), and the verdict also needs the
 * recorded reproduction of that (test, fix) — `harness flake reproduce`,
 * src/shared/flake-reproduction.ts.
 *
 * THE SYNTAX IS JUDGED AT COMMIT TIME (the commit-msg door,
 * scripts/commit-guard.ts, through {@link flakeCauseTrailerProblems}). A
 * malformed trailer already in history — pushed history is never rewritten —
 * is REPORTED by commit and IGNORED, never thrown: one typo must not turn
 * every later flaky verdict red for good.
 */
import { deepFreeze } from "../kernel/integrity.ts";
import { HarnessError } from "../kernel/errors.ts";
import { semanticForm } from "../quality/languages/semantic-form.ts";
import { readFlakeReproductions, type IgnoredFlakeReproduction } from "../shared/flake-reproduction.ts";
import { failureIdentityFile, type CauseChange, type CauseEvidence, type ContentKeyAt, type DeclaredCauseFix, type JudgedCauseFix, type SuiteIdentities } from "../shared/run-history.ts";
import { gitOutput, type GitRepository } from "./tree-reader.ts";

/** The trailer a fix commit declares its fixed cause with. */
export const FLAKE_CAUSE_TRAILER = "Flake-cause";

const UNIT = "\u001f";
const RECORD = "\u001e";

/** A path a declaration may name: repository-relative, no empty, `.` or `..` segment. */
function invalidPath(path: string): boolean {
  return path.startsWith("/") || path.split("/").some((segment) => segment === ".." || segment === "." || segment === "");
}

/**
 * One trailer value (`<identity> => <path>, <path>[ @ <commit>]`) as a
 * declaration, the test's own file first (`testPathOf` turns the identity's
 * runner-relative file into its repository path: the engine's ledger is
 * relative to the engine). A value that names no file, no cause, an absolute
 * or escaping path, or a malformed commit is refused
 * (`flake_cause_trailer_invalid`).
 */
export function parseFlakeCause(value: string, commit: string, testPathOf: (file: string) => string): DeclaredCauseFix {
  const arrow = value.lastIndexOf(" => ");
  const identity = arrow < 0 ? "" : value.slice(0, arrow).trim();
  const [paths = "", named, ...extra] = arrow < 0 ? [""] : value.slice(arrow + 4).split(" @ ");
  const causes = paths.split(",").map((path) => path.trim());
  const fixCommit = named === undefined ? commit : named.trim();
  const file = failureIdentityFile(identity);
  if (file === null || extra.length > 0 || causes.length === 0 || causes.some(invalidPath) || !/^[0-9a-f]{7,64}$/u.test(fixCommit)) {
    throw new HarnessError(`${commit}: the ${FLAKE_CAUSE_TRAILER} trailer "${value}" must read "<ledger identity> => <repository path>[, <path>…][ @ <fix commit>]"`, "flake_cause_trailer_invalid");
  }
  const testPath = testPathOf(file);
  return deepFreeze({ identity, paths: [testPath, ...new Set(causes.filter((cause) => cause !== testPath))], causes: [...new Set(causes)], commit: fixCommit });
}

/** The bytes of `path` in `treeish` as text, or null when the path is absent there. */
function textAt(repository: GitRepository, treeish: string, path: string): string | null {
  const found = gitOutput(repository, ["cat-file", "blob", `${treeish}:${path}`], { allowed: [0, 128] });
  return found.status === 0 ? found.stdout.toString("utf8") : null;
}

/**
 * THE ONE JUDGEMENT OF A FIX'S CHANGE TO ITS DECLARED CAUSES: semantic when
 * at least one cause's semantic form differs between the fix's parent and
 * the fix (a cause added or removed is a semantic change); otherwise why
 * not, path by path — "comment or layout only", "unchanged", or the kind no
 * reader judges. A cause that does not parse is refused by name.
 */
export async function judgeCauseChange(repository: GitRepository, declared: DeclaredCauseFix): Promise<CauseChange> {
  const notes: string[] = [];
  for (const cause of declared.causes) {
    const before = textAt(repository, `${declared.commit}^`, cause);
    const after = textAt(repository, declared.commit, cause);
    if (before === after) {
      notes.push(`${cause}: unchanged`);
      continue;
    }
    if (before === null || after === null) return { semantic: true };
    const [formBefore, formAfter] = [await semanticForm(cause, before), await semanticForm(cause, after)];
    if ("unjudged" in formBefore || "unjudged" in formAfter) {
      notes.push(`${cause}: ${"unjudged" in formBefore ? formBefore.unjudged : (formAfter as { unjudged: string }).unjudged}`);
      continue;
    }
    if (formBefore.form !== formAfter.form) return { semantic: true };
    notes.push(`${cause}: comment or layout only`);
  }
  return { semantic: false, why: `the fix changed no declared cause's meaning (${notes.join("; ")})` };
}

/**
 * THE COMMIT-MSG DOOR'S CHECK: every `Flake-cause:` trailer of `message`
 * (git's own trailer parse) is well formed. Returns one line per malformed
 * trailer; none is the healthy answer.
 */
export function flakeCauseTrailerProblems(repository: GitRepository, message: string): readonly string[] {
  const trailers = gitOutput(repository, ["interpret-trailers", "--parse", "--no-divider"], { input: Buffer.from(message, "utf8") }).stdout.toString("utf8");
  return trailers.split("\n").filter((line) => line.startsWith(`${FLAKE_CAUSE_TRAILER}:`)).flatMap((line) => {
    try {
      parseFlakeCause(line.slice(FLAKE_CAUSE_TRAILER.length + 1).trim(), "0000000", (file) => file);
      return [];
    } catch (error) {
      return [(error as Error).message.replace(/^0000000: /u, "")];
    }
  });
}

/** A declaration that explains nothing because it cannot be read: said by the verdict's caller, never thrown. */
export type IgnoredDeclaration = Readonly<{ commit: string; value: string; why: string }>;

/** The declared fixes and recorded reproductions, with what was ignored and why. */
export type DeclaredCauseEvidence = CauseEvidence & Readonly<{
  ignoredDeclarations: readonly IgnoredDeclaration[];
  ignoredReproductions: readonly IgnoredFlakeReproduction[];
}>;

/** What the caller's suite brings to the evidence: the configured statistical N, and its suites' identities now (null: no live suite). */
export type CauseEvidenceOptions = Readonly<{ flakeReproduction: Readonly<{ statisticalRuns: number; significance: number; deterministicShims: readonly string[] }>; suites: SuiteIdentities | null }>;

/**
 * The declared fixes reachable from HEAD (their commits resolved to full
 * object names), each with its judged change; the recorded reproductions and
 * moves under `engineRoot`; and the content reader the verdict compares them
 * with (`<tree-ish>:<path>` object ids, memoized per call). A malformed
 * trailer, an unknown commit, a fix that changed no cause's meaning or a
 * cause that does not parse is reported in `ignoredDeclarations`, never
 * thrown.
 */
export async function declaredCauseFixes(repository: GitRepository, testPathOf: (file: string) => string, engineRoot: string, options: CauseEvidenceOptions): Promise<DeclaredCauseEvidence> {
  const log = gitOutput(repository, [
    "log", "--extended-regexp", `--grep=^${FLAKE_CAUSE_TRAILER}:`,
    `--format=%H${UNIT}%(trailers:key=${FLAKE_CAUSE_TRAILER},valueonly,separator=${UNIT})${RECORD}`, "HEAD",
  ]).stdout.toString("utf8");
  const commits = new Map<string, string | null>();
  const fullCommit = (name: string): string | null => {
    if (!commits.has(name)) {
      const found = gitOutput(repository, ["rev-parse", "-q", "--verify", `${name}^{commit}`], { allowed: [0, 1, 128] });
      commits.set(name, found.status === 0 ? found.stdout.toString("utf8").trim() : null);
    }
    return commits.get(name)!;
  };
  const declared: JudgedCauseFix[] = [];
  const ignoredDeclarations: IgnoredDeclaration[] = [];
  for (const record of log.split(RECORD).map((entry) => entry.trim()).filter((entry) => entry.length > 0)) {
    const [commit, ...values] = record.split(UNIT).map((part) => part.trim());
    for (const value of values.filter((entry) => entry.length > 0)) {
      try {
        const parsed = parseFlakeCause(value, commit!, testPathOf);
        const resolved = fullCommit(parsed.commit);
        if (resolved === null) {
          ignoredDeclarations.push({ commit: commit!, value, why: `names ${parsed.commit}, which is no commit of this repository` });
          continue;
        }
        const fix = { ...parsed, commit: resolved };
        const change = await judgeCauseChange(repository, fix);
        if (!change.semantic) ignoredDeclarations.push({ commit: commit!, value, why: change.why });
        declared.push(deepFreeze({ ...fix, change }));
      } catch (error) {
        ignoredDeclarations.push({ commit: commit!, value, why: (error as Error).message });
      }
    }
  }
  const reproductions = readFlakeReproductions(engineRoot);
  return deepFreeze({
    declared,
    reproductions: reproductions.records,
    statisticalRuns: options.flakeReproduction.statisticalRuns,
    significance: options.flakeReproduction.significance,
    deterministicShims: options.flakeReproduction.deterministicShims,
    moves: reproductions.moves,
    suites: options.suites,
    ignoredDeclarations,
    ignoredReproductions: reproductions.ignored,
    contentKeyAt: flakeCauseContentKeys(repository),
  });
}

/**
 * THE ONE CONTENT READER of declared paths: the content key of `paths` in a
 * tree-ish (`<path>=<object id>` lines, `<path>=` for a path absent there —
 * the test's own file WHOLE: every test in it is held by the whole file, so
 * no parse of the file can leave the failing test's own body out (security
 * T-1/T-2, correctness F-N1, design F4/F5);
 * `<tree-ish>:<path>` object ids, memoized per reader), null when the
 * tree-ish itself is unknown (a dirty run's private tree). The verdict and the
 * reproduction door both read through it; `contentKeyComplete` says whether
 * every path was present.
 */
export function flakeCauseContentKeys(repository: GitRepository): ContentKeyAt {
  const objects = new Map<string, string | null>();
  const objectAt = (spec: string): string | null => {
    // `<tree-ish>:<path>` takes no peel suffix (it would join the path), so it is asked bare.
    if (!objects.has(spec)) {
      const found = gitOutput(repository, ["rev-parse", "-q", "--verify", spec], { allowed: [0, 1, 128] });
      objects.set(spec, found.status === 0 ? found.stdout.toString("utf8").trim() : null);
    }
    return objects.get(spec)!;
  };
  return (treeish: string, paths: readonly string[]) => {
    if (objectAt(`${treeish}^{tree}`) === null) return null;
    return paths.map((path) => `${path}=${objectAt(`${treeish}:${path}`) ?? ""}`).join("\n");
  };
}

/** What a LIVE arm says about what it ignored (empty when nothing was). */
export function ignoredCauseEvidenceMessage(evidence: DeclaredCauseEvidence): string {
  const lines = [
    ...evidence.ignoredDeclarations.map((entry) => `declaration in ${entry.commit} ignored (${entry.value}): ${entry.why}`),
    ...evidence.ignoredReproductions.map((entry) => `reproduction record ${entry.file} ignored: ${entry.why}`),
  ];
  return lines.length === 0 ? "" : `flaky-test memory: ${String(lines.length)} declaration(s) or record(s) explain nothing: ${lines.join("; ")}`;
}
