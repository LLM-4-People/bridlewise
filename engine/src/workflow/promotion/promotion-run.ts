/**
 * THE PROMOTION RUN — what every verb that moves something shares
 * (`apply.ts`, `publication.ts`, `rollback.ts`, `promoter-home.ts`): what an
 * apply is asked and runs with, the profile's refs (`pending`, `hold`,
 * `receipts/<commit>` under `ROOT_POLICY.workflow.promotion.refNamespace`)
 * and the receipt reader, the repository's promotion folder and its candidate
 * names, the promotion locks, the identity a derived commit carries, the ONE
 * mapping of any failure to a typed answer, and the pending ref's drop. A
 * leaf below the verbs (no verb module is imported here), so they compose
 * without import cycles.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { HarnessError, InputError } from "../../kernel/errors.ts";
import { deepFreeze } from "../../kernel/integrity.ts";
import { ROOT_POLICY } from "../../kernel/root-policy.ts";
import { gitOutput, resolveRevision, type GitRepository } from "../../git/tree-reader.ts";
import type { CommitIdentity, WorktreeGitPort } from "../../git/worktree-port.ts";
import { auditEvent, debugLog } from "../../shared/debug/debug-system.ts";
import { assertSameFilesystem, type CheckoutCommandRunner } from "../checkout-setup.ts";
import { LockAcquisitionTimeout, acquireLock, configuredLockOptions } from "../resource-lock.ts";
import { repositoryId, repositoryRegistryArea, workspaceRootOf } from "../repository-registry.ts";
import { worktreeOperationTimeouts } from "../workflow-config.ts";
import { LandingError, landingGitFailure, sweepCandidates } from "../tree-landing.ts";
import { PromotionError } from "./codes.ts";
import type { PromotionPlan } from "./projection.ts";
import { branchOf, type PromotionProfile } from "./profile.ts";
import type { PromotionContext } from "./context.ts";

/** What `apply` was asked (see the header): the reasoned overrides and how far to go. */
export type ApplyRequest = Readonly<{
  /** `--accept-target-edits <path>…`: the target's direct edits to overwrite (EXACTLY the plan's list), or `null`. */
  acceptTargetEdits: readonly string[] | null;
  /** `--allow-deletions`: the deletion budget may be exceeded. */
  allowDeletions: boolean;
  /** `--release-hold`: a manual run releases the profile's hold first (one explicit act, UD-7). */
  releaseHold: boolean;
  /** `--reason`: why an override was granted (required with one; recorded in the receipt and the log). */
  reason: string | null;
  /** `--no-publish`: stop after the commit (the pending ref pins it; nothing moves). */
  noPublish: boolean;
  /** `--no-push`: publish locally only (the remote is not pushed; the next run pushes). */
  noPush: boolean;
  /** `--auto`: an unattended run (the trigger's): it never waits for a lock, a hold is its answer, and its entry chains one more run when the source moved (`trigger.ts`). */
  auto: boolean;
}>;

/** What an apply runs with besides its pair's context. */
export type ApplyRun = Readonly<{
  git: WorktreeGitPort;
  /** The ONE command runner (its errored-class retries) the candidate's commands run through. */
  runner: CheckoutCommandRunner;
  /** The generated outputs of a candidate's tree (the paths setup and converge may write). */
  generatedOutputs: (root: string) => ReadonlySet<string>;
  /** The ignored build outputs the source's pins describe (installed into the target checkout at the finish), repository-relative. */
  buildOutputs: () => readonly string[];
  /** The engine root's path below a checkout's top (where the config document lives). */
  engineRelative: string;
  /** The toolchain versions recorded in the receipt (git, node, and each tool the profile's commands run). */
  toolchain: Readonly<Record<string, unknown>>;
  /** The plan of the pair over a (reconciled) context: the lockfiles derived. */
  plan: (context: PromotionContext) => Promise<PromotionPlan>;
  /**
   * Told each named point a run passes (after the lock, the reconcile, the
   * plan, the candidate, the settle, the commit, the receipt, the pin, the
   * push, the land, the install, the finish): the crash-injection port of the
   * resume property test (merge-door-final §17.2 T-R1). Absent in production.
   */
  checkpoint?: (name: string) => void;
}>;


/** The refs of a profile: its pending commit, its hold, and the receipt of a commit. */
export function promotionRefs(profile: string): Readonly<{ pending: string; hold: string; receipt: (commit: string) => string }> {
  const base = `${ROOT_POLICY.workflow.promotion.refNamespace}/${profile}`;
  return deepFreeze({ pending: `${base}/pending`, hold: `${base}/hold`, receipt: (commit: string) => `${base}/receipts/${commit}` });
}

/** `id` abbreviated as a promotion names a commit or a plan (`ROOT_POLICY.workflow.promotion.shortIdLength`). */
export function shortId(id: string): string {
  return id.slice(0, ROOT_POLICY.workflow.promotion.shortIdLength);
}

/**
 * The repository's promotion folder under the workspace root: every candidate
 * and the promoter home of every profile live in it, scoped by the
 * repository's id so clones sharing a workspace root never collide.
 */
export function promotionFolder(context: PromotionContext): string {
  return join(workspaceRootOf(context.registry, context.isolation.workspaceRoot), `promote-${repositoryId(context.registry, ROOT_POLICY.workflow.promotion.shortIdLength)}`);
}

/** The candidate folder of `profile` for the plan `planId` (in {@link promotionFolder}). */
export function candidatePath(context: PromotionContext, planId: string): string {
  return join(promotionFolder(context), `${context.loaded.profile.name}-${shortId(planId)}`);
}

/** Whether a folder name in {@link promotionFolder} is a candidate of `profile` (never its home). */
export function isCandidateOf(profile: string): (name: string) => boolean {
  const pattern = new RegExp(`^${profile}-[0-9a-f]{${String(ROOT_POLICY.workflow.promotion.shortIdLength)}}$`, "u");
  return (name) => pattern.test(name);
}

/**
 * Refuses (`promotion_work_root_filesystem`) a folder of a promotion — a
 * candidate, the promoter home — that would not live on the repository's
 * filesystem, BEFORE anything is created there; then makes its parent.
 */
export function assertWorkRoot(context: PromotionContext, path: string): void {
  try {
    assertSameFilesystem(context.registry.home, path, "promotion_work_root_filesystem");
  } catch (error) {
    if (error instanceof InputError && error.code === "promotion_work_root_filesystem") throw new PromotionError("promotion_work_root_filesystem", error.message, { path });
    throw error;
  }
  mkdirSync(dirname(path), { recursive: true });
}

/** The resource of the promotion lock `name` (a target ref: `promotion-refs-heads-<branch>`; the promoter home: `promotion-home-<profile>`). */
function lockResource(name: string): string {
  return `promotion-${name.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-")}`;
}

/**
 * Runs `body` holding the promotion lock `name` — a repository-wide lock
 * under the registry's `locks/`, waited for as `resourceLock` declares (not
 * at all when `wait` is false: an unattended run coalesces); a live holder is
 * never broken. A wait that runs out is `promotion_locked`.
 */
export async function withPromotionLock<T>(context: PromotionContext, name: string, owner: string, body: () => Promise<T>, wait = true): Promise<T> {
  let lock: Awaited<ReturnType<typeof acquireLock>>;
  try {
    lock = await acquireLock(context.top, lockResource(name), {
      ...configuredLockOptions(context.document, owner),
      ...(wait ? {} : { timeoutMs: 0 }),
      lockDirectory: repositoryRegistryArea(context.registry, "locks"),
    });
  } catch (error) {
    if (error instanceof LockAcquisitionTimeout) throw new PromotionError("promotion_locked", error.message, { lock: lockResource(name) });
    throw error;
  }
  try {
    return await body();
  } finally {
    lock.release();
  }
}


/** The committer of `commit` and its committer date: the identity and date of a commit derived from it. */
export function committerOf(context: PromotionContext, commit: string): CommitIdentity {
  const [name, email, date] = gitOutput(context.repository, ["log", "-1", "--format=%cn%x00%ce%x00%cI", commit]).stdout.toString("utf8").trim().split("\0");
  return deepFreeze({ name: name!, email: email!, date: date! });
}


/**
 * The PromotionError any failure of a promotion is answered with — never a
 * rethrow (see the header): a landing refusal's code is its failure's,
 * prefixed; a git step failed outside a phase is typed as one; anything else
 * is `promotion_unexpected` (integrity), its message and kind named.
 */
export function promotionErrorOf(error: unknown, facts: Readonly<Record<string, unknown>>): PromotionError {
  if (error instanceof PromotionError) return error;
  if (error instanceof LandingError) return new PromotionError(`promotion_${error.failure}`, error.message, { ...error.facts, ...facts });
  const git = landingGitFailure(error, "promotion");
  if (git !== null) return promotionErrorOf(git, facts);
  const kind = error instanceof HarnessError ? error.code : error instanceof Error ? error.name : typeof error;
  debugLog("workflow", "error", `promotion ended on an unexpected error: ${kind}`, () => ({ kind, stack: error instanceof Error ? error.stack ?? error.message : String(error), ...facts }));
  return new PromotionError("promotion_unexpected", `the promotion ended on an error no code names (${kind}): ${error instanceof Error ? error.message : String(error)}`, { ...facts, kind });
}

/** The receipt a commit's receipt ref holds (`null`: none). */
export function readReceipt(context: PromotionContext, commit: string): Readonly<Record<string, unknown>> | null {
  const blob = resolveRevision(context.repository, promotionRefs(context.loaded.profile.name).receipt(commit), "object");
  return blob === null ? null : deepFreeze(JSON.parse(gitOutput(context.repository, ["cat-file", "blob", blob]).stdout.toString("utf8")) as Record<string, unknown>);
}


/**
 * Drops `pending` (a compare-and-swap), logged once; and its receipt, unless
 * the commit WAS published — an ancestor of the (reconciled) target: a run
 * that pushed it and died before its finish, after which another machine
 * promoted on top — whose receipt is the record of what shipped (UD-6).
 */
export function dropPending(context: PromotionContext, git: WorktreeGitPort, pending: string, inspectMs: number): void {
  const refs = promotionRefs(context.loaded.profile.name);
  const dropped = git.deleteRef(context.top, refs.pending, pending, inspectMs);
  const shipped = context.target !== null && git.isAncestor(context.top, pending, context.target, inspectMs);
  const receipt = resolveRevision(context.repository, refs.receipt(pending), "object");
  if (dropped.refusal === null && receipt !== null && !shipped) git.deleteRef(context.top, refs.receipt(pending), receipt, inspectMs);
  auditEvent("promotion.recovery", { kind: "pending_dropped", profile: context.loaded.profile.name, pending, shipped, target: context.target, source: context.source, refusal: dropped.refusal });
}


/** Removes `candidate` (a worktree of this repository in the promotion folder), when it still exists. */
export function removeCandidate(context: PromotionContext, git: WorktreeGitPort, candidate: string): void {
  const timeouts = worktreeOperationTimeouts(context.document);
  sweepCandidates(git, context.top, dirname(candidate), (name) => join(dirname(candidate), name) === candidate, false, timeouts.worktreeMs);
}

/** The target tip T of `profile`: the local target branch, else its remote-tracking ref; `null` before the target exists. */
export function targetTip(repository: GitRepository, profile: PromotionProfile): string | null {
  return resolveRevision(repository, profile.target.ref) ?? (profile.remote === null ? null : resolveRevision(repository, `refs/remotes/${profile.remote}/${branchOf(profile.target.ref)}`));
}
