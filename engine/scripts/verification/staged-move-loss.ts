/**
 * A MOVE THAT LEAVES THE INDEX, AT THE DOOR EVERY MOVE PASSES THROUGH.
 *
 * ── THE DEFECT, MEASURED ──────────────────────────────────────────────────
 *
 * `git mv` into a path some `.gitignore` covers exits 0 and the file STAYS
 * TRACKED. A plain `mv` followed by `git add -A` exits 0 and the file is
 * SILENTLY DROPPED from the index. Same intent, same exit code, opposite
 * outcome — and the difference is a habit nobody can be relied on to keep.
 *
 * There is exactly ONE moment when the loss is visible: between the `add` and
 * the commit, `git status` shows a staged DELETION of the old path and says
 * nothing at all about the new one. It reads like the first half of an
 * ordinary rename. After the commit it is genuinely silent — nothing staged,
 * nothing untracked, a file on disk that no clone will ever receive and that
 * the next `git clean -xfd` removes.
 *
 * ── WHY THIS FILE EXISTS AT ALL, AND WHERE IT STOPS ───────────────────────
 *
 * The invariant wanted is "a move never loses a tracked file". Its ladder:
 *
 *   1. Physically impossible — unavailable. `mv` is a syscall and `git add` is
 *      doing exactly what it is told; nothing in the OS or in git can be made
 *      to refuse a rename into an ignored directory, and git's own answer to
 *      the situation (drop it) is documented behaviour, not a bug.
 *   2. Unrepresentable — unavailable. The bad state is a pair of filesystem
 *      facts, not a value: there is no type anywhere in this project through
 *      which a shell command's arguments pass.
 *   3. Unreachable by shape — unavailable, for the same reason. `git mv` and
 *      `mv` are two programs on a PATH this project does not own; there is no
 *      door here that a move must be handed to.
 *   4. REFUSED AT A RUNTIME CHOKE POINT — available, and it is this file. The
 *      door every move must eventually pass through is `git commit`, because a
 *      move that is never committed has not happened. There is no CI in any of
 *      the three repositories, so `git commit` is not merely the lowest choke
 *      point available — it is the only one.
 *
 * The residual risk is named rather than hidden: `core.hooksPath` is LOCAL
 * config, so a tracked hook is inert in a clone nobody bootstrapped. That is
 * why `hookInstallationFailure` exists below and why the suites refuse on it —
 * an unbootstrapped repository is a refusal somewhere, not a silent pass.
 *
 * ── WHAT THIS FILE OWNS ───────────────────────────────────────────────────
 *
 * The rule, the wording, AND — unusually for this directory — the git calls.
 * `gitignore-anchoring.ts` deliberately owns no instrument because its callers
 * are test files that can supply one. This module's principal caller is a git
 * hook: a shell process with no harness, no injection point and no test
 * fixture, which cannot be handed an instrument. So the collector lives here,
 * and the acceptance instrument stays independent the other way round — the
 * tests drive `git commit` itself on throwaway repositories and never consult
 * the collector's opinion.
 *
 * ── A DELIBERATE DELETION IS DECLARED, NOT DESTROYED ──────────────────────
 *
 * The same signature (a staged deletion whose bytes sit at an ignored path)
 * is also left by a DELIBERATE deletion of a file that has an ignored copy for
 * another reason: a `.bkp/` backup, a frozen evidence snapshot, a leaked test
 * fixture. The only way out this rule used to offer, "remove the copy on disk
 * first", destroyed a copy somebody kept on purpose, and `--no-verify` turns
 * every other leg off too. So a deletion can be DECLARED before the commit
 * (`harness deletions declare <path>…`, src/git/declared-deletions.ts): the
 * path and the blob HEAD holds there, bound to HEAD (and to how many times it
 * had moved), to the file being gone from the disk, to the ignored copies it
 * had, and to this checkout's git directory. {@link judgeLosses} accepts a
 * paired deletion only when its declaration is still pending and every copy
 * this commit finds is one it recorded. Every other verdict keeps the refusal
 * and names itself (undeclared, mismatched, stale, expired, copies changed,
 * foreign). The declarations are read only when a loss exists, so an ordinary
 * commit never touches them. The `post-commit` hook consumes the ones the
 * commit used.
 *
 * ── WHAT COUNTS AS LEAVING THE INDEX ─────────────────────────────────────
 *
 * Read with RENAME DETECTION OFF (`--no-renames`): with it on, a staged new
 * file at least half similar to the deleted one turned the deletion into an
 * `R` and hid a real move into an ignored folder (wf-del-verify P1). A
 * deletion whose EXACT blob the index stages at another path (a `git mv`, a
 * move to a tracked path) is accounted for, so only content the index
 * really lets go is judged. A regular file REPLACED by something else at its
 * path (a typechange `T`: the file moved into an ignored folder and a
 * symlink left behind) is a deletion of the file's blob too (P4). The
 * ignored population is the one `git add -A` skipped on THIS machine
 * (`.git/info/exclude` and `core.excludesFile` included, P3), and every git
 * question is asked of the git being committed (the hook's environment).
 */

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DECLARATION_REFUSAL_CODES,
  DECLARE_DELETIONS_VERB,
  CLEAR_DECLARED_DELETIONS_VERB,
  judgeDeclaration,
  presentOnDisk,
  readDeclaredDeletions,
  type DeclarationVerdict,
  type DeclaredDeletion,
  type DeclaredDeletionsView,
} from "../../src/git/declared-deletions.ts";
import { blobSizes, ignoredCopies, type DeletedBlob, type MoveLoss } from "../../src/git/ignored-copies.ts";
import { gitNulRecords, trackedFiles } from "../../src/git/repository-ownership.ts";
import { auditEvent } from "../../src/shared/debug/debug-system.ts";
import { PROMOTION_TRIGGER_HOOK, isPromotionTriggerHookText, promotionTriggerHookText } from "../../src/workflow/promotion/trigger-hook.ts";
import { SHIPPED_HOOK_FILES } from "../../src/kernel/verification-paths.ts";

/**
 * One staged deletion the rule paired with ignored copies, and what its
 * declaration (if any) is worth.
 */
export type JudgedLoss = Readonly<{
  deletion: DeletedBlob;
  /** Every ignored path holding the deletion's exact bytes. */
  copies: readonly string[];
  verdict: DeclarationVerdict;
  /** The declaration the verdict was read from, when one names the path. */
  declaration?: DeclaredDeletion;
  /** The copies no declaration recorded (a `copies-changed` verdict). */
  undeclaredCopies?: readonly string[];
}>;

/**
 * THE DECLARED-DELETION EXCEPTION, AT THE RULE. The losses are grouped by the
 * deletion they come from (one deletion, every ignored copy of it) and each
 * deletion is judged against the checkout's declarations — with the copies
 * this commit finds and whether its path is on disk (`present`): `declared` is
 * accepted; every other verdict stays refused. Pure over what it is handed,
 * so both halves can be planted.
 */
export function judgeLosses(
  losses: readonly MoveLoss[],
  deletions: readonly DeletedBlob[],
  declarations: DeclaredDeletionsView,
  present: (path: string) => boolean,
): Readonly<{ accepted: readonly JudgedLoss[]; refused: readonly JudgedLoss[] }> {
  const copies = new Map<string, string[]>();
  for (const loss of losses) copies.set(loss.from, [...(copies.get(loss.from) ?? []), loss.to]);
  const accepted: JudgedLoss[] = [];
  const refused: JudgedLoss[] = [];
  for (const deletion of deletions) {
    const paired = copies.get(deletion.path);
    if (paired === undefined) continue;
    const { verdict, declaration, undeclaredCopies } = judgeDeclaration(declarations, { path: deletion.path, blob: deletion.blob, copies: paired, present: present(deletion.path) });
    (verdict === "declared" ? accepted : refused).push({
      deletion, copies: paired, verdict,
      ...(declaration === undefined ? {} : { declaration }),
      ...(undeclaredCopies === undefined ? {} : { undeclaredCopies }),
    });
  }
  return { accepted, refused };
}

/** A judged deletion's typed code: its refusal's ({@link DECLARATION_REFUSAL_CODES}), or `declared`. */
function refusalCode(judged: JudgedLoss): string {
  return judged.verdict === "declared" ? "declared" : DECLARATION_REFUSAL_CODES[judged.verdict];
}

/** Why a refused deletion's declaration did not count, in words (an undeclared one needs none). */
function declarationDetail(judged: JudgedLoss): string {
  const declared = judged.declaration;
  if (judged.verdict === "mismatched" && declared !== undefined) {
    return `\n      It was declared deleted with blob ${declared.blob}, but this commit deletes blob ${judged.deletion.blob}: ` +
      `the file changed after it was declared. Check the change, then declare it again.`;
  }
  if (judged.verdict === "stale" && declared !== undefined) {
    return `\n      It was declared against commit ${declared.head}, and HEAD has moved since: a declaration covers ` +
      `the commit it was made for, and only until HEAD moves (a commit, a reset, a checkout — even one back to ` +
      `that same commit). Declare it again.`;
  }
  if (judged.verdict === "expired") {
    return `\n      It was declared while it was gone from the disk, and something is at that path again: the ` +
      `declaration no longer describes this deletion. Check what is there, then declare it again once the file is gone.`;
  }
  if (judged.verdict === "copies-changed" && declared !== undefined) {
    return `\n      It was declared with its ignored copies at ${declared.copies.length === 0 ? "(none)" : declared.copies.join(", ")}, ` +
      `but this commit also finds ${(judged.undeclaredCopies ?? []).join(", ")}: a copy nobody declared — the file came ` +
      `back and was moved again, or a copy was made since. Check it (git mv keeps a move tracked), then declare it again.`;
  }
  if (judged.verdict === "foreign") {
    return `\n      Its declaration record was made for another git directory: withdraw it ` +
      `(\`${CLEAR_DECLARED_DELETIONS_VERB.join(" ")}\`) and declare it again.`;
  }
  return "";
}

/**
 * The operator-facing refusal, or `null` when nothing staged loses a file.
 *
 * Returned rather than thrown so the hook can print it and the suites can
 * assert on it, one wording in one place. Each refused deletion carries its
 * typed code ({@link DECLARATION_REFUSAL_CODES}).
 */
export function stagedMoveLossFailure(refused: readonly JudgedLoss[], mergeCommit = false): string | null {
  if (refused.length === 0) return null;
  const detail = refused
    .map((judged) => {
      return (
        `  ${judged.deletion.path}  [${refusalCode(judged)}]\n      is on disk at ${judged.copies.join(", ")}, ` +
        `which git IGNORES, so this commit removes it from the index and nothing afterwards says so.` +
        declarationDetail(judged)
      );
    })
    .join("\n");
  return (
    `This commit stages ${refused.length} deletion(s) whose content is still on disk at a path ` +
    `git ignores:\n${detail}\n\n` +
    `That is what a plain \`mv\` plus \`git add -A\` does. \`git mv\` keeps the file tracked at ` +
    `its new path, and this is the last moment anyone can see the difference: after the commit ` +
    `there is nothing staged, nothing untracked, and a file no clone will ever receive.\n\n` +
    `Either move it with \`git mv\`, or — if the destination really should be ignored and the ` +
    `file really should stay tracked — \`git add -f <new path>\`. If the deletion is deliberate, ` +
    `declare it (engine CLI, from engine/): \`node src/cli.ts ${DECLARE_DELETIONS_VERB.join(" ")} <path>…\`. ` +
    `Declare it once the file is gone from the disk and just before the commit: a declaration ` +
    `records each path with the blob HEAD holds there and the ignored copies it has; the next ` +
    `commit that stages exactly that deletion, with no copy nobody declared, while HEAD has not ` +
    `moved, is accepted, the ignored copies stay on disk, and the declaration is consumed. ` +
    `Removing the copy on disk first also works, when nobody keeps it on purpose.` +
    (mergeCommit
      ? `\n\nThis is a MERGE, and the deletion arrives with it: before the merge the file was still on disk, ` +
        `so it could not be declared. git has left the merge in progress: declare the deletion, then git commit ` +
        `(the commit completes the merge).`
      : "")
  );
}

/** The file modes of a regular file: the content a clone would receive. */
const REGULAR_FILE_MODES: ReadonlySet<string> = new Set(["100644", "100755"]);
/** A submodule entry names a commit of another repository, never a blob of this one. */
const GITLINK_MODE = "160000";

/**
 * What `git commit` is about to take out of this repository's index, read
 * from the git being committed (the hook's environment).
 *
 * `--raw --no-renames`: every change is its own record, so a similar new file
 * can never turn a deletion into a rename that hides it (P1). A deletion is
 * a `D` (any entry but a submodule's), or a `T` whose old entry was a regular
 * file (the file replaced at its path, e.g. by a symlink: P4). A deletion
 * whose EXACT blob the index stages at another path is accounted for (a
 * `git mv`, a move to a tracked path) and is not returned.
 */
export function stagedDeletions(root: string): readonly DeletedBlob[] {
  // `-z` for paths, and the raw format so the source blob comes for free.
  // `--no-abbrev` is load-bearing: the default prints a SEVEN-character
  // prefix, `git hash-object` prints the whole object name, and the two never
  // compare equal — the check ran, found nothing, and exited 0 on a commit
  // that was losing a file. Asking for the full name is also the spelling that
  // survives a repository whose object format is not SHA-1.
  const fields = gitNulRecords(root, ["diff", "--cached", "--raw", "--no-renames", "--no-abbrev", "-z"], "inherited");
  const removed: { path: string; blob: string }[] = [];
  const staged = new Set<string>();
  // `:<srcmode> <dstmode> <srcsha> <dstsha> <status>` then ONE path (no renames).
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [sourceMode, targetMode, sourceBlob, targetBlob, status] = fields[index]!.replace(/^:/u, "").split(" ");
    const path = fields[index + 1]!;
    if (REGULAR_FILE_MODES.has(targetMode ?? "")) staged.add(targetBlob!);
    const deleted = (status === "D" && sourceMode !== GITLINK_MODE) || (status === "T" && REGULAR_FILE_MODES.has(sourceMode ?? ""));
    if (deleted && path.length > 0 && (sourceBlob ?? "").length > 0) removed.push({ path, blob: sourceBlob! });
  }
  const leaving = removed.filter((deletion) => !staged.has(deletion.blob));
  const sizes = blobSizes(root, leaving.map((deletion) => deletion.blob), "inherited");
  return leaving.map((deletion) => ({ ...deletion, size: sizes.get(deletion.blob)! }));
}

/**
 * The whole question, asked of one repository: does this commit lose a file?
 * `failure` is the refusal (or `null`); `accepted` are the paired deletions a
 * declaration covers, which the hook reports. Every judged deletion is an
 * audit event. `mergeCommit`: the commit is the one `git merge` makes by
 * itself (the `pre-merge-commit` hook says so; git writes `MERGE_HEAD` only
 * after the refusal, leaving the merge in progress), so the refusal names the
 * merge's own route: declare, then `git commit`.
 *
 * Fast when it is not interesting — a commit staging no deletion at all does
 * one `git diff` and stops, which is the overwhelming majority of commits,
 * and the declarations are read only when a loss exists.
 */
export function commitLossVerdict(root: string, mergeCommit = false): Readonly<{ failure: string | null; accepted: readonly JudgedLoss[] }> {
  const deletions = stagedDeletions(root);
  if (deletions.length === 0) return { failure: null, accepted: [] };
  const losses = ignoredCopies(root, deletions, "inherited");
  if (losses.length === 0) return { failure: null, accepted: [] };
  const declarations = readDeclaredDeletions(root, "inherited");
  const { accepted, refused } = judgeLosses(losses, deletions, declarations, (path) => presentOnDisk(root, path));
  for (const judged of accepted) {
    auditEvent("declared-deletion-accepted", { path: judged.deletion.path, blob: judged.deletion.blob, head: declarations.head, copies: judged.copies });
  }
  for (const judged of refused) {
    auditEvent("staged-move-loss-refused", {
      path: judged.deletion.path, blob: judged.deletion.blob, head: declarations.head, copies: judged.copies,
      code: refusalCode(judged),
    });
  }
  return { failure: stagedMoveLossFailure(refused, mergeCommit), accepted };
}

/** The directory a repository's tracked hooks live in, relative to its root. */
export const HOOKS_DIRECTORY = SHIPPED_HOOK_FILES.directory;

/** The hook this rule installs, and the name git looks for. */
export const HOOK_NAME = SHIPPED_HOOK_FILES.guarded[0];

/** The argument `pre-merge-commit` hands the guard: this is the commit `git merge` makes by itself. */
export const MERGE_COMMIT_FLAG = "--merge-commit";

/**
 * Every tracked hook that runs the commit guard: `pre-commit` for a commit,
 * `pre-merge-commit` for the merge commit git makes by itself (`git merge`
 * without a conflict never runs `pre-commit`; git ≥ 2.24 runs this one, and
 * its shim passes {@link MERGE_COMMIT_FLAG}), and `commit-msg` for the
 * message (its shim passes `--message <file>`: the `Lesson:` trailers,
 * `lesson-trailers.ts`).
 * `cherry-pick`, `revert` and `rebase` run NO commit hook (git's design): a
 * commit made that way is certified by `harness check` and the suites, never
 * by this door (see `.githooks/README.md`).
 */
export const GUARDED_HOOKS = SHIPPED_HOOK_FILES.guarded;

/**
 * EVERY TRACKED HOOK WHOSE TEXT IS CANONICAL: the {@link GUARDED_HOOKS}, which
 * hand over to the commit guard, and the promotion trigger
 * (`reference-transaction`, src/workflow/promotion/trigger-hook.ts), which
 * runs exactly its code lines — a different text could abort every ref update
 * in the repository. The commit door refuses a staged hook of either kind that
 * is deleted, loses its execute bit or is not canonical
 * ({@link hookTextIsCanonical}); the installation checks of both suites judge
 * the working copies the same way.
 */
export const SHIPPED_HOOKS = Object.freeze([...GUARDED_HOOKS, PROMOTION_TRIGGER_HOOK] as const);

/** The program every guarded hook hands over to — its file name, the one spelling. */
export const COMMIT_GUARD_PROGRAM = "commit-guard.ts";

/** Where {@link COMMIT_GUARD_PROGRAM} lives in a repository, relative to its root: the one program a shipped hook may run. */
export const COMMIT_GUARD_REPOSITORY_PATH = `engine/scripts/${COMMIT_GUARD_PROGRAM}`;

/**
 * The guard program of the harness running THIS check, by absolute path (a
 * throwaway repository has no `engine/scripts/` of its own, so its hooks name
 * the real guard this way). Derived from this module's own location, never spelled.
 */
export const COMMIT_GUARD_PATH = fileURLToPath(new URL(`../${COMMIT_GUARD_PROGRAM}`, import.meta.url));

/** The flag the `commit-msg` hook hands the guard, followed by the message file. */
export const COMMIT_MESSAGE_FLAG = "--message";

/** The arguments each guarded hook hands the guard after the repository root. */
const HOOK_GUARD_ARGUMENTS: Readonly<Record<(typeof GUARDED_HOOKS)[number], readonly string[]>> = Object.freeze({
  [HOOK_NAME]: [],
  "pre-merge-commit": [MERGE_COMMIT_FLAG],
  "commit-msg": [COMMIT_MESSAGE_FLAG, '"$1"'],
});

/** How a hook names the repository's own guard (the default program of {@link guardHookBody}). */
const REPOSITORY_GUARD = `"$root/${COMMIT_GUARD_REPOSITORY_PATH}"`;

/** The one interpreter line a guarded hook starts with. */
const HOOK_SHEBANG = "#!/bin/sh";

/**
 * THE CANONICAL BODY of a guarded hook: the one text every guarded hook runs
 * (`set -e`, the root from git, then `exec` of the guard so its status IS the
 * hook's). `program` is the guard as the hook names it: the repository's own
 * (`"$root/engine/scripts/commit-guard.ts"`, the default) or, for a throwaway
 * repository, {@link COMMIT_GUARD_PATH}.
 */
export function guardHookBody(hook: (typeof GUARDED_HOOKS)[number], program: string = REPOSITORY_GUARD): readonly string[] {
  return Object.freeze([
    "set -e",
    "root=$(git rev-parse --show-toplevel)",
    "exec node --experimental-strip-types \\",
    `  ${[program, '"$root"', ...HOOK_GUARD_ARGUMENTS[hook]].join(" ")}`,
  ]);
}

/** A whole guarded hook: the shebang and {@link guardHookBody} (what a fixture writes). */
export function guardHookText(hook: (typeof GUARDED_HOOKS)[number], program?: string): string {
  return `${[HOOK_SHEBANG, ...guardHookBody(hook, program)].join("\n")}\n`;
}

/** What each guarded hook explains to its reader, between its shebang and its body (comment lines of the shipped text). */
const GUARDED_HOOK_PROSE: Readonly<Record<(typeof GUARDED_HOOKS)[number], readonly string[]>> = Object.freeze({
  [HOOK_NAME]: [
    "# Refuse a commit that would drop a tracked file out of the index.",
    "#",
    "# A plain `mv` into an ignored path plus `git add -A` exits 0 and stages a",
    "# DELETION of the old path with nothing standing in for it; `git mv` keeps the",
    "# file tracked. This is the last moment the difference is visible, and there is",
    "# no CI here, so `git commit` is the only door both spellings pass through.",
    "#",
    "# The rule lives in one owner. Before the monorepo assembly this file existed",
    "# twice — once in the harness root reaching `$root/integration/`, once in the",
    "# web tree reaching `$root/../harness-main-v1/integration/` — two spellings of",
    "# one relative literal, which is exactly the duplication the assembly removes.",
    "# Now there is one tree and one path: the engine is in-tree at `engine/`. If it",
    "# is absent the hook fails and the commit is refused, which is the right",
    "# answer: a check that cannot run has not certified anything.",
  ],
  "pre-merge-commit": [
    "# The merge commit git makes by itself (`git merge` with no conflict) runs no",
    "# `pre-commit`; git runs this hook instead, and it hands over to the same door",
    "# as `pre-commit`, so a merge is certified exactly like a commit (--merge-commit",
    "# lets a refusal name the merge's own route). `cherry-pick`,",
    "# `revert` and `rebase` run no commit hook at all (git's design): see README.md.",
  ],
  "commit-msg": [
    "# The message of a commit: one that turns a workflow lesson to `acted` names",
    "# it in a `Lesson: L-<id>` trailer (engine/scripts/verification/lesson-trailers.ts).",
    "# It hands over to the same door as `pre-commit`, in its message mode.",
  ],
});

/**
 * THE SHIPPED TEXT of a shipped hook — what `harness sync` writes at
 * `<HOOKS_DIRECTORY>/<hook>` (`scripts/verification/shipped-hooks.ts`, the
 * generator; `SHIPPED_HOOK_FILES`): a guarded hook's shebang, its prose and
 * {@link guardHookBody} for the repository's own guard; the trigger's
 * `promotionTriggerHookText`. Canonical by construction
 * ({@link hookTextIsCanonical}).
 */
export function shippedHookText(hook: (typeof SHIPPED_HOOKS)[number]): string {
  if (hook === PROMOTION_TRIGGER_HOOK) return promotionTriggerHookText();
  return `${[HOOK_SHEBANG, ...GUARDED_HOOK_PROSE[hook], ...guardHookBody(hook)].join("\n")}\n`;
}

/**
 * The programs a guarded hook may name: the repository's own guard, or this
 * harness's by its absolute path when that path is LITERAL inside a
 * double-quoted shell word — no `"`, `\`, `$`, backtick or control character,
 * the only bytes the shell interprets there. It used to be a narrower
 * `[A-Za-z0-9_./-]` set, so a harness checked out under a path with a `+`
 * (`~/.local/state/bridlewise-promo-0+1-candidate`) refused every throwaway
 * repository's hook that named it (PROMO-0+1).
 */
const ACCEPTED_GUARD_PROGRAMS: readonly string[] = Object.freeze(
  /^[^"\\$`\u0000-\u001f\u007f]+$/u.test(COMMIT_GUARD_PATH) ? [REPOSITORY_GUARD, `"${COMMIT_GUARD_PATH}"`] : [REPOSITORY_GUARD],
);

/**
 * WHETHER A HOOK'S TEXT HANDS OVER TO THE GUARD — the hook is compared with
 * its CANONICAL text ({@link guardHookBody}), never parsed for a mention
 * (wf1b2-design G6: `# commit-guard.ts` + `exit 0`, or `… || true`) and never
 * shell-parsed (WF-1b3b verify H1: a `#!/bin/true` shebang, a comment ending
 * in `\` that swallowed `exit 0` in a continuation join, any path ending in
 * `/commit-guard.ts`). Line 1 is exactly {@link HOOK_SHEBANG}; the body's
 * lines follow each other exactly, naming an accepted program; every other
 * line is blank or a comment (a comment never continues a line in sh, and no
 * comment may sit inside the body's one continuation). After the `exec` line
 * nothing runs. The one check both the commit door (the staged text) and the
 * installation checks (the working text) apply.
 */
export function handsOverToGuard(text: string, hook: string): boolean {
  if (!(GUARDED_HOOKS as readonly string[]).includes(hook)) return false;
  const lines = text.split("\n");
  if (lines[0] !== HOOK_SHEBANG) return false;
  const code = lines.map((line, index) => ({ line, index })).slice(1).filter(({ line }) => !/^[ \t]*(#.*)?$/u.test(line));
  return ACCEPTED_GUARD_PROGRAMS.some((program) => {
    const body = guardHookBody(hook as (typeof GUARDED_HOOKS)[number], program);
    return code.length === body.length && code.every(({ line, index }, at) => line === body[at] && index === code[0]!.index + at);
  });
}

/** Whether `text` is the canonical text of the shipped hook `hook` (see {@link SHIPPED_HOOKS}); any other name is never canonical. */
export function hookTextIsCanonical(text: string, hook: string): boolean {
  return hook === PROMOTION_TRIGGER_HOOK ? isPromotionTriggerHookText(text) : handsOverToGuard(text, hook);
}

/** What a shipped hook that is not canonical fails to do, in words (a refusal's or an installation check's). */
export function canonicalHookDuty(hook: string): string {
  return hook === PROMOTION_TRIGGER_HOOK
    ? "runs exactly the promotion trigger's code (src/workflow/promotion/trigger-hook.ts): any other text could abort every ref update"
    : `hands over to ${COMMIT_GUARD_PROGRAM}`;
}

/**
 * What a repository must be able to say about its own commit hook.
 *
 * Every field is read from git or from the filesystem, never assumed, because
 * the whole point of the bootstrap guard is that "it is installed" is a claim
 * about a machine rather than about a tree.
 */
export type HookInstallation = Readonly<{
  /** The repository this describes, for the message. */
  readonly root: string;
  /** Which shipped hook (a name in {@link SHIPPED_HOOKS}). */
  readonly hook: string;
  /** `core.hooksPath` as git resolves it here, or `null` when unset. */
  readonly hooksPath: string | null;
  /** Whether the hook file exists at `HOOKS_DIRECTORY/HOOK_NAME`. */
  readonly present: boolean;
  /** Whether git holds it in the index — an untracked hook reaches no clone. */
  readonly tracked: boolean;
  /** Whether the owner execute bit is set; git will not run it otherwise. */
  readonly executable: boolean;
  /** Whether the hook's text is its canonical one ({@link hookTextIsCanonical}: a structural comparison). */
  readonly canonical: boolean;
}>;

/**
 * Every shipped hook of `root`, as git and the filesystem state it (the one
 * reader both suites' installation checks use).
 */
export function readHookInstallations(root: string): readonly HookInstallation[] {
  const configured = spawnSync("git", ["config", "--get", "core.hooksPath"], { cwd: root, encoding: "utf8" });
  const tracked = new Set(trackedFiles(root) ?? []);
  return SHIPPED_HOOKS.map((hook) => {
    const path = `${HOOKS_DIRECTORY}/${hook}`;
    const stats = statSync(`${root}/${path}`, { throwIfNoEntry: false });
    const present = stats?.isFile() === true;
    return Object.freeze({
      root,
      hook,
      hooksPath: configured.status === 0 ? configured.stdout.trim() : null,
      present,
      tracked: tracked.has(path),
      executable: present && (stats!.mode & 0o100) !== 0,
      canonical: present && hookTextIsCanonical(readFileSync(`${root}/${path}`, "utf8"), hook),
    });
  });
}

/**
 * DENY BY DEFAULT: a repository that has not been bootstrapped is a refusal.
 *
 * `core.hooksPath` cannot be tracked — it is local config, by design, because
 * a repository that could ship executable hooks to everyone who clones it
 * would be a remote-code-execution vector. So the hook is tracked, the
 * pointer is not, and the gap between them is exactly where "it works on my
 * machine" lives. This turns that gap into a red suite with the command to run
 * printed in it, which is the guided state a missing configurable owes the
 * person who hit it.
 */
export function hookInstallationFailure(
  installations: readonly HookInstallation[],
  bootstrapCommand: string,
): string | null {
  if (installations.length === 0) {
    return (
      `no repository was examined for its commit hook. That is a broken discovery, not a clean ` +
      `answer — a repository this check never reached is one it approved by not looking.`
    );
  }
  const problems: string[] = [];
  for (const installation of installations) {
    const expected = HOOKS_DIRECTORY;
    if (installation.hooksPath !== expected) {
      problems.push(
        `  ${installation.root}: core.hooksPath is ` +
          `${installation.hooksPath === null ? "not set" : JSON.stringify(installation.hooksPath)}, ` +
          `so git runs no hook here and a move that drops a tracked file commits in silence.`,
      );
    }
    const hook = `${expected}/${installation.hook}`;
    if (!installation.present) {
      problems.push(`  ${installation.root}: ${hook} does not exist.`);
      continue;
    }
    if (!installation.tracked) {
      problems.push(
        `  ${installation.root}: ${hook} is not tracked, so it exists on this ` +
          `machine and in no clone.`,
      );
    }
    if (!installation.executable) {
      problems.push(
        `  ${installation.root}: ${hook} is not executable, and git skips a hook ` +
          `it cannot run without reporting anything.`,
      );
    }
    if (!installation.canonical) {
      problems.push(`  ${installation.root}: ${hook} is not canonical: it no longer ${canonicalHookDuty(installation.hook)}.`);
    }
  }
  if (problems.length === 0) return null;
  return (
    `${problems.length} problem(s) with the commit hooks across ${new Set(installations.map((installation) => installation.root)).size} ` +
    `repository/ies:\n${problems.join("\n")}\n\n` +
    `Run: ${bootstrapCommand}\n` +
    `It sets core.hooksPath in every repository it can reach. The setting is per-clone and ` +
    `cannot be committed, which is why this check exists rather than trusting the tree.`
  );
}
