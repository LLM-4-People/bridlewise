/**
 * THE PROMOTION DIAGNOSTIC CODES — the single source of every answer
 * `harness promote` gives: its code, its class (which fixes the exit code), and
 * the one remedy a person or an agent is told. A refusal raised anywhere in the
 * primitive is a {@link PromotionError} carrying one of these codes, so the
 * CLI, the exposure actions and the guide (`docs/process/MERGE-GUIDE.md`, whose
 * table is tested against this one) can never disagree about what a code means.
 *
 * Classes (merge-door-final §12):
 * - `ok` — nothing to do, or done;
 * - `input` — usage, a missing or invalid profile;
 * - `precondition` — fixable on the source or by an explicit flag (boundary
 *   refusals, target edits, the never-rule, the deletion budget);
 * - `errored` — the environment (a busy or offline machine; retries exhausted):
 *   nothing is blamed on the change;
 * - `failed` — a real defect in the source (a transform or a gate failed on the
 *   exact tree);
 * - `integrity` — a state that must not happen; stop and preserve evidence;
 * - `parked` — published to the remote, but the local checkout of the target
 *   holds overlapping edits: the next run (or a fast-forward there) finishes.
 *
 * An unattended run (`--auto`, the trigger's) exits 0 for the answers that
 * only say "not now" (`autoOk`: locked, held, parked): the trigger coalesces
 * them, and the next run resumes.
 */
import { HarnessError } from "../../kernel/errors.ts";
import { deepFreeze } from "../../kernel/integrity.ts";

const PROMOTION_CLASSES = deepFreeze(["ok", "input", "precondition", "errored", "failed", "integrity", "parked"] as const);
export type PromotionClass = typeof PROMOTION_CLASSES[number];

/** The process exit code of each class (0 is success; none collides with a harness code in use: 1 is a generic command failure). */
const PROMOTION_CLASS_EXIT: Readonly<Record<PromotionClass, number>> = deepFreeze({
  ok: 0,
  input: 2,
  precondition: 3,
  errored: 4,
  failed: 5,
  integrity: 6,
  parked: 7,
});

type CodeEntry = Readonly<{ class: PromotionClass; remedy: string; autoOk?: true }>;

/** Every code the promotion primitive answers with (see the header). */
export const PROMOTION_CODES = deepFreeze({
  promotion_planned: { class: "ok", remedy: "Review the plan; nothing was written to any ref, checkout or index." },
  promotion_up_to_date: { class: "ok", remedy: "Nothing to do: the target already carries this source commit." },
  promotion_unchanged: { class: "ok", remedy: "Nothing to do: the projection of this source equals the target (only unprojected paths or regenerated values changed)." },
  promotion_status: { class: "ok", remedy: "Read the status; nothing was changed." },
  promotion_explained: { class: "ok", remedy: "Read the reason chain for each path." },
  promotion_committed: { class: "ok", remedy: "Review the commit (its receipt names every command that certified it); the pending ref pins it and nothing was published: the target ref, the remote and every checkout are untouched." },
  promotion_published: { class: "ok", remedy: "Nothing to do: the target (and its remote) carry the promotion commit, and the checkout holding the target was fast-forwarded; `status` shows whether its dependencies need a reinstall (depsStale)." },
  promotion_not_due: { class: "ok", remedy: "Nothing to do: no promotion profile is triggered by the refs that moved, or the trigger was the promoter's own fetch or push." },
  promotion_triggered: { class: "ok", remedy: "A promotion was started in the background: `status` shows its phase and its result." },
  promotion_rolled_back: { class: "ok", remedy: "The target was restored and automatic promotion is held: fix the defect on the source, then `release-hold --reason <text>`." },
  promotion_hold_set: { class: "ok", remedy: "Automatic promotion is paused for this profile until `release-hold --reason <text>`." },
  promotion_hold_released: { class: "ok", remedy: "Automatic promotion resumes at the next source publication (or run `apply`)." },
  promotion_not_held: { class: "ok", remedy: "Nothing to release: no hold is set for this profile." },
  promotion_usage: { class: "input", remedy: "Run `harness promote <status|plan|explain|apply|rollback|hold|release-hold|auto> [--profile <name>] [--source <rev>]` (apply: `--no-publish`, `--no-push`, `--accept-target-edits <path>… --reason <text>`, `--allow-deletions --reason <text>`, `--release-hold --reason <text>`, `--auto`; rollback: `--to <promotion commit> --reason <text>`; hold and release-hold: `--reason <text>`; auto: `--refs <refs>`)." },
  promotion_profile_missing: { class: "input", remedy: "Add the profile `<profile directory>/<name>.json` on the source branch (see promotion/README.md), or name an existing one with --profile." },
  promotion_profile_invalid: { class: "input", remedy: "Fix the profile on the source branch: the JSON pointer names the field and the rule it breaks." },
  promotion_source_missing: { class: "input", remedy: "Name a source revision that exists (--source <rev>), or create the profile's source branch." },
  promotion_target_missing: { class: "input", remedy: "Create the profile's target branch (or fetch it from the profile's remote): a promotion builds on the target's tip." },
  promotion_source_json_invalid: { class: "precondition", remedy: "Fix the named JSON file on the source (a package.json, a lockfile or a tsconfig): the projection must read it to resolve imports, packages and aliases." },
  promotion_entry_missing: { class: "precondition", remedy: "Fix on the source: restore the entry point, or correct `boundary.entryPoints` in the profile." },
  promotion_unresolved_import: { class: "precondition", remedy: "Fix on the source: the importer names a module the tree does not hold (a dangling import ships broken code)." },
  promotion_import_into_excluded: { class: "precondition", remedy: "Fix on the source: product code must not import a path the profile excludes (move the module into the product, or the import out of it)." },
  promotion_dependency_undeclared: { class: "precondition", remedy: "Fix on the source: declare the package in the owning package.json (`dependencies` for a runtime import)." },
  promotion_gitlink_unsupported: { class: "precondition", remedy: "Exclude the submodule path in the profile: a gitlink cannot be projected." },
  promotion_manifest_script_missing: { class: "precondition", remedy: "The profile keeps a script the source manifest does not declare (a typo or a rename): correct the transform's `scripts` list, or restore the script." },
  promotion_manifest_script_emptied: { class: "precondition", remedy: "Every segment of a kept script was pruned: add the script's file to `boundary.entryPoints`, or drop the script from the transform's `scripts` list." },
  promotion_manifest_script_unparseable: { class: "precondition", remedy: "Rewrite the kept script as `&&`-joined commands: `;`, `||`, pipes, substitutions and redirections cannot be projected." },
  promotion_manifest_bin_ambiguous: { class: "precondition", remedy: "Two devDependencies provide the command a kept script runs: remove the ambiguous one from the source manifest." },
  promotion_transform_failed: { class: "failed", remedy: "The transform's command failed on the derived inputs: read the output tail and fix the manifest on the source." },
  promotion_transform_errored: { class: "errored", remedy: "None: the machine was busy or offline (the retries are exhausted); run it again later." },
  promotion_never_rule: { class: "precondition", remedy: "The source was merged with the target after a promotion: restore the source from its reflog (never force-push without the coordinator)." },
  promotion_target_edits: { class: "precondition", remedy: "The target was edited directly since the last promotion: land the written patch on the source, or (apply) accept the exact list with a reason." },
  promotion_deletion_budget: { class: "precondition", remedy: "The projection deletes more of the target than the profile's safety budget allows: review `plan --diff` (a boundary typo?) before an explicit, reasoned override." },
  promotion_projection_mismatch: { class: "integrity", remedy: "Stop and keep the evidence: the written tree does not hold exactly the planned entries (the error names the tree); report it, never promote it." },
  promotion_source_unavailable: { class: "precondition", remedy: "This process has no promotion source installed (the web server does not run git): use the engine CLI, `npm run promote`." },
  promotion_locked: { class: "precondition", autoOk: true, remedy: "Another promotion of this target is running (it holds the target's lock): wait for it, then run again (a rerun resumes from the refs)." },
  promotion_held: { class: "precondition", autoOk: true, remedy: "Automatic promotion is held (after a rollback, or by `hold`): fix the source, then `release-hold --reason <text>`, or `apply --release-hold --reason <text>` once." },
  promotion_parked: { class: "parked", autoOk: true, remedy: "The remote carries the promotion, but the checkout holding the target has local edits on the paths it changes (named): commit them on the source or discard them there, then run again (or `git merge --ff-only` there) — nothing is rebuilt." },
  promotion_target_index_locked: { class: "errored", autoOk: true, remedy: "None: another git holds the target checkout's index (git's index lock); the promotion is published and the next run lands it. The promoter never deletes a lock." },
  promotion_target_diverged: { class: "precondition", remedy: "The target's local branch and its remote have both moved apart: reconcile the named refs by hand (never force), then run again." },
  promotion_source_diverged: { class: "precondition", remedy: "The source's local branch and its remote have both moved apart: reconcile them on the source (never force), then run again." },
  promotion_push_rejected: { class: "precondition", remedy: "The remote moved twice during the promotion (the push was re-planned once): inspect the remote; never force." },
  promotion_push_errored: { class: "errored", remedy: "None: the remote was not reached (the network, a busy server); the commit stays pinned and the next run pushes the same commit." },
  promotion_remote_errored: { class: "errored", remedy: "None: the remote was not reached while reading its refs (the network, a busy server); run again later." },
  promotion_remote_refused: { class: "precondition", remedy: "The remote refused (a permission, a protected branch, its hook: git's words are named): fix the remote's access or rules; the commit stays pinned." },
  promotion_post_publish_mismatch: { class: "integrity", remedy: "Stop and keep the evidence: after a successful push the remote's target is not the promotion commit; inspect the remote (`git ls-remote`) and report it." },
  promotion_rollback_invalid: { class: "precondition", remedy: "Name a promotion commit of this profile on the target's first-parent history that is not the current tip and is not itself a rollback (a rollback of a rollback is refused): `git log --first-parent <target>` lists them." },
  promotion_work_root_filesystem: { class: "input", remedy: "Set `workspaceIsolation.workspaceRoot` to a folder on the repository's filesystem (never a tmpfs): the candidate and the promoter home live there." },
  promotion_work_path_occupied: { class: "precondition", remedy: "A folder this run must create (the candidate or the promoter home: its path is named) exists and is not this repository's: remove it if nothing runs there, or give this checkout its own `workspaceIsolation.workspaceRoot`." },
  promotion_home_setup_failed: { class: "failed", remedy: "A setup command of the source's own engine failed in the promoter home (the folder is named): read its output tail and fix on the source; the next run re-runs it." },
  promotion_home_setup_errored: { class: "errored", remedy: "None: a setup command of the promoter home was ended by the environment (a busy or offline machine; the retries are exhausted); run it again later — the next run re-runs it." },
  promotion_promoter_failed: { class: "failed", remedy: "The source's own promoter, re-executed in the promoter home, ended without an answer (its exit code and last line are named): a defect in the source's engine; run the same verb from a checkout clean at the source to see it, and fix on the source." },
  promotion_promoter_errored: { class: "errored", remedy: "None: the source's promoter in the promoter home was ended by the environment (its ceiling or a signal); run it again later (a rerun resumes from the refs)." },
  promotion_setup_failed: { class: "failed", remedy: "A setup command failed on the projected tree: read its output tail and the kept candidate (its path is named), and fix on the source." },
  promotion_setup_errored: { class: "errored", remedy: "None: a setup command was ended by the environment (a busy or offline machine; the retries are exhausted); run it again later." },
  promotion_gate_failed: { class: "failed", remedy: "A converge or verify command failed on the exact tree: read its output tail and the kept candidate, and fix on the source." },
  promotion_gate_errored: { class: "errored", remedy: "None: a converge or verify command was ended by the environment (a busy or offline machine; the retries are exhausted); run it again later." },
  promotion_not_converged: { class: "failed", remedy: "The converge commands do not reach a fixed point on the projected tree (the named files keep changing): fix the generator on the source." },
  promotion_undeclared_write: { class: "failed", remedy: "A command wrote a path no generator declares (or a gate changed the tree it judges): register the output with its generator, or stop the command writing it." },
  promotion_commit_refused: { class: "failed", remedy: "The repository's commit hook refused the certified tree (its words are named): the gates missed what it checks — fix on the source and add the check as a gate." },
  promotion_objects_missing: { class: "integrity", remedy: "Stop and keep the evidence: the promotion commit reaches objects the store lacks; report it, never publish it." },
  promotion_candidate_mismatch: { class: "integrity", remedy: "Stop and keep the evidence: the candidate or its commit does not hold the tree and parents that were computed; report it, never publish it." },
  promotion_git_errored: { class: "errored", remedy: "None: a git step of the landing was ended by the environment (its ceiling, a signal, a full disk); run it again later (`workspaceGit.timeouts` bounds each step)." },
  promotion_git_failed: { class: "integrity", remedy: "Stop and keep the evidence: a git step of the landing refused (its operation and words are named, the candidate is kept); report it, never publish it." },
  promotion_pending_conflict: { class: "integrity", remedy: "Stop and keep the evidence: another run pinned the pending ref while this one held the target's lock; report it, never publish either commit." },
  promotion_unexpected: { class: "integrity", remedy: "Stop and keep the evidence: the landing ended on an error no code names (its message is given, the candidate is kept); report it." },
} satisfies Record<string, CodeEntry>);

export type PromotionCode = keyof typeof PROMOTION_CODES;

/** The class of `code`. */
export function promotionClass(code: PromotionCode): PromotionClass {
  return PROMOTION_CODES[code].class;
}

/**
 * Which class answers for a plan holding several refusals: the most severe
 * first (the lowest rank) — a state that must not happen, then a usage or
 * profile error, a real defect, what is fixable on the source, and last the
 * machine's (an errored transform never hides a refusal the source must fix).
 * A record over the class union, so a new class cannot go unranked.
 */
const PROMOTION_CLASS_RANK: Readonly<Record<PromotionClass, number>> = deepFreeze({
  integrity: 0,
  input: 1,
  failed: 2,
  precondition: 3,
  parked: 4,
  errored: 5,
  ok: 6,
});

/** The code that answers for `codes` (the first of the most severe class; `null` for none). */
export function mostSevereCode(codes: readonly PromotionCode[]): PromotionCode | null {
  let found: PromotionCode | null = null;
  for (const code of codes) {
    if (found === null || PROMOTION_CLASS_RANK[promotionClass(code)] < PROMOTION_CLASS_RANK[promotionClass(found)]) found = code;
  }
  return found;
}

/** The exit code `code` ends a command with; an unattended run (`auto`) exits 0 for an answer that only says "not now" (see the header). */
export function promotionExitCode(code: PromotionCode, auto = false): number {
  const entry: CodeEntry = PROMOTION_CODES[code];
  return auto && entry.autoOk === true ? 0 : PROMOTION_CLASS_EXIT[entry.class];
}

/** One typed refusal of the primitive: a code from {@link PROMOTION_CODES}, with the facts that name what was refused. */
export class PromotionError extends HarnessError {
  readonly promotionCode: PromotionCode;
  readonly facts: Readonly<Record<string, unknown>>;

  constructor(code: PromotionCode, message: string, facts: Readonly<Record<string, unknown>> = {}) {
    super(message, code, promotionClass(code) === "errored", {});
    this.promotionCode = code;
    this.facts = deepFreeze({ ...facts });
  }
}

/** The envelope every promotion verb answers with: the code, its class and remedy (from {@link PROMOTION_CODES}), the message and the data. */
export type PromotionAnswer = Readonly<{
  ok: boolean;
  code: PromotionCode;
  class: PromotionClass;
  message: string;
  remedy: string;
  data: unknown;
}>;

/** The answer `code` gives with `message` and `data`. */
export function answer(code: PromotionCode, message: string, data: unknown): PromotionAnswer {
  const entry = PROMOTION_CODES[code];
  return deepFreeze({ ok: entry.class === "ok", code, class: entry.class, message, remedy: entry.remedy, data });
}

/** `result` with `facts` added to its data (a data that is no object becomes `{ value }`): the same code, class, message and remedy. */
export function answerWith(result: PromotionAnswer, facts: Readonly<Record<string, unknown>>): PromotionAnswer {
  const data = typeof result.data === "object" && result.data !== null ? result.data : { value: result.data };
  return answer(result.code, result.message, { ...data, ...facts });
}
