/**
 * `harness promote apply` — a promotion, end to end (merge-door-final §7):
 * the projected tree P becomes ONE certified commit C on top of the target tip
 * T, with the source commit S as its second parent and the provenance
 * trailers, then C is published and landed. Every phase has a checked
 * postcondition, every failure is typed, and a rerun IS the resume (§8): all
 * durable state is refs and trailers.
 *
 * 1. LOCK + RECOVER: one promotion per target ref (the repository-wide lock
 *    under the registry's `locks/`; a live holder is never broken; an
 *    unattended run, `--auto`, never waits: `promotion_locked`).
 * 2. RECONCILE (`publication.ts`): the remote's refs read and fetched; the
 *    target's local branch behind its remote is landed first (not by a
 *    `--no-publish` run: it builds on the remote's tip, moving nothing); local ahead (an
 *    earlier promotion not pushed yet) is carried; apart is
 *    `promotion_target_diverged`; the source must be ordered with its remote;
 *    a hold (after a rollback, UD-7) stops an unattended run and a manual one
 *    without `--release-hold --reason`. The `pending` ref: a commit already
 *    built for this S on this T, or already published, is the answer to
 *    resume (publish and finish it); a stale one is dropped (logged).
 * 3. PLAN (`projection.ts`): its refusals stand, except the two an explicit,
 *    reasoned flag accepts — the target's direct edits (`--accept-target-edits`
 *    with EXACTLY the plan's list) and the deletion budget (`--allow-deletions`).
 *    `up_to_date` / `unchanged` end the run (an unpushed earlier promotion is
 *    pushed first).
 * 4. CANDIDATE, 5. SETTLE, 6. COMMIT — `tree-landing.ts`, in a worktree
 *    `<profile>-<plan id>` in the repository's promotion folder under the
 *    workspace root (on the repository's filesystem), as S's committer at S's
 *    committer date: the same inputs give the same commit on any machine, with
 *    no git identity configured anywhere. C is pinned by `pending` and
 *    described by its receipt before anything is published. `--no-publish`
 *    stops here.
 * 7. PUBLISH (`publication.ts`): one atomic, never-forced push of C, its
 *    receipt (and S when the remote's source lags; a rollback's hold), then
 *    the landing in the checkout that holds the target (fast-forward; a torn
 *    one completed with git alone; overlapping local edits PARK it). A
 *    rejected push (the remote moved) re-plans ONCE from phase 2.
 *    `--no-push` publishes locally only.
 * 8. FINISH: the target checkout's invariants (the config mode), the
 *    candidate's pinned build outputs installed there (journaled, all or
 *    nothing), its index baseline checked, the setup commands its new tree
 *    needs named (`depsStale`, never run: it may be serving), `pending`
 *    deleted, the candidate removed. (An unattended run's chain — one more
 *    run when the source moved meanwhile — is launched by the unattended
 *    entry once this run and its locks are gone: `trigger.ts`.)
 *
 * The receipt (`promotion-receipt/v1`, canonical JSON, a blob under
 * `<namespace>/<profile>/receipts/<C>`, created once and pushed with C)
 * records what certified C: the plan (with its advisories), the accepted
 * overrides and their reasons, the convergence, every command with its
 * evidence (argv, attempts, duration, the load it met), the toolchain and how
 * C is published. It replaces the merge-manifest ledger (UD-6).
 *
 * EVERY FAILURE IS TYPED (§7.1 I-5): a refusal is a {@link PromotionError}
 * ({@link promotionErrorOf}; an error no code names is `promotion_unexpected`),
 * after a failed landing the sweep and the `promotion.refused` audit always
 * run, and the last-run record (`last-run.ts`) states every phase and the
 * answer.
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { canonicalJson, deepFreeze, sha256 } from "../../kernel/integrity.ts";
import { schemaId } from "../../kernel/product-identity.ts";
import { ROOT_POLICY } from "../../kernel/root-policy.ts";
import { gitOutput, resolveRevision, writeBlob } from "../../git/tree-reader.ts";
import type { CommitIdentity, WorktreeGitPort } from "../../git/worktree-port.ts";
import { auditEvent, debugLog } from "../../shared/debug/debug-system.ts";
import { checkoutCommandRunner, commandsRun, convergeBound, type CheckoutCommandRunner, type CheckoutStep } from "../checkout-setup.ts";
import { configuredLockOptions } from "../resource-lock.ts";
import { worktreeOperationTimeouts } from "../workflow-config.ts";
import { commitCandidate, createCandidate, landingGitOperationCount, runLandingPhase, settleCandidate, sweepCandidates, type SettleReport } from "../tree-landing.ts";
import { PromotionError, answer, mostSevereCode, promotionClass, type PromotionAnswer, type PromotionCode } from "./codes.ts";
import { lastRunRecorder, type LastRunRecorder } from "./last-run.ts";
import type { PromotionPlan, Refusal } from "./projection.ts";
import { branchOf } from "./profile.ts";
import {
  assertWorkRoot, candidatePath, committerOf, dropPending, isCandidateOf, promotionErrorOf, promotionFolder, promotionRefs, readReceipt, removeCandidate, shortId, withPromotionLock,
  type ApplyRequest, type ApplyRun,
} from "./promotion-run.ts";
import { finishPromotion, publishCommit, reconcileRemote, releaseHoldNow } from "./publication.ts";
import { promotionTrailersOf } from "./trailers.ts";
import type { PromotionContext } from "./context.ts";

const PROMOTION_RECEIPT_SCHEMA = schemaId("promotion-receipt", 1);

/**
 * The worst case of one `apply` over `context` (the ceiling a supervisor puts
 * on a re-executed one): the lock wait, every registry command the profile
 * runs — the converge commands once per pass of their bound — each with every
 * errored retry and its wait, the commit, the landing's git operations
 * (`LANDING_GIT_OPERATIONS`, each at the slowest local git ceiling), and the
 * remote's (two fetches or listings and a push per attempt; a rejected push
 * re-plans once). Derived from the configuration, so a slower command
 * declared tomorrow raises it.
 */
export function applyCeilingMs(context: PromotionContext, runner: CheckoutCommandRunner, generatedOutputs: number): number {
  const { profile } = context.loaded;
  const { retries, backoffMs } = runner.retries;
  const attempts = (names: readonly string[]): number => commandsRun(context.isolation.commands, names).reduce((sum, name) => sum + context.isolation.commands[name]!.timeoutMs * (retries + 1) + backoffMs * (2 ** retries - 1), 0);
  const lockfiles = profile.transforms.flatMap((transform) => transform.kind === "lockfile" ? [transform.command] : []);
  const passes = convergeBound(generatedOutputs);
  const timeouts = worktreeOperationTimeouts(context.document);
  const oneBuild = attempts([...profile.phases.setup, ...profile.phases.verify, ...lockfiles])
    + passes * attempts(profile.phases.converge)
    + timeouts.mergeMs
    + landingGitOperationCount(passes) * Math.max(timeouts.worktreeMs, timeouts.inspectMs)
    + (profile.remote === null ? 0 : 2 * timeouts.fetchMs + timeouts.pushMs);
  return configuredLockOptions(context.document, "").timeoutMs + 2 * oneBuild;
}

/** The promotion commit's subject: the profile, the source branch at S, the target branch. */
function promotionSubject(context: PromotionContext): string {
  const { profile } = context.loaded;
  return `promote(${profile.name}): ${branchOf(profile.source.ref)}@${shortId(context.source)} into ${branchOf(profile.target.ref)}`;
}

/**
 * The promotion commit's message (merge-door-final §3): deterministic — the
 * profile, S and the target; the summary; the source commits it carries
 * since the last promotion (capped); the trailers.
 */
function promotionMessage(context: PromotionContext, plan: PromotionPlan, regenerated: number, accepted: readonly string[] | null): string {
  const { profile } = context.loaded;
  const { trailers, messageSourceLines } = ROOT_POLICY.workflow.promotion;
  const since = plan.lastPromoted.source;
  const commits = gitOutput(context.repository, ["log", "--format=%H%x00%s", since === null ? context.source : `${since}..${context.source}`]).stdout.toString("utf8")
    .split("\n").filter((line) => line.length > 0).map((line) => line.split("\0") as [string, string]);
  const listed = commits.slice(0, messageSourceLines).map(([sha, subject]) => `- ${subject} (${shortId(sha)})`);
  const more = commits.length - listed.length;
  const derived = profile.transforms.map((transform) => transform.path).filter((path) => !plan.projection.underived.includes(path));
  return [
    promotionSubject(context),
    "",
    `+${String(plan.summary.added)} ~${String(plan.summary.modified)} -${String(plan.summary.deleted)} (derived: ${derived.join(", ") || "none"}; regenerated: ${String(regenerated)})`,
    `${String(commits.length)} source commit(s) since ${since === null ? "the start of its history" : shortId(since)}:`,
    ...listed,
    ...(more > 0 ? [`… and ${String(more)} more`] : []),
    "",
    `${trailers.promotedFrom}: ${context.source}`,
    `${trailers.profile}: ${profile.name}@${context.loaded.blob ?? "working-tree"}`,
    ...(accepted === null || accepted.length === 0 ? [] : [`${trailers.acceptedTargetEdits}: ${accepted.join(", ")}`]),
  ].join("\n");
}

/**
 * The plan's refusals this request does not override (see the header). An
 * accepted target-edit list must equal the plan's exactly; a different list
 * keeps the refusal and names the difference.
 */
function standingRefusals(plan: PromotionPlan, request: ApplyRequest): readonly Refusal[] {
  return plan.refusals.flatMap((entry): Refusal[] => {
    if (entry.code === "promotion_target_edits" && request.acceptTargetEdits !== null) {
      const wanted = new Set(plan.targetEdits);
      const given = new Set(request.acceptTargetEdits);
      const missing = [...wanted].filter((path) => !given.has(path));
      const extra = [...given].filter((path) => !wanted.has(path));
      if (missing.length === 0 && extra.length === 0) return [];
      return [{ ...entry, message: `${entry.message}; the accepted list is not the plan's: ${missing.length > 0 ? `missing ${missing.join(", ")}` : ""}${missing.length > 0 && extra.length > 0 ? "; " : ""}${extra.length > 0 ? `not edits ${extra.join(", ")}` : ""}` }];
    }
    if (entry.code === "promotion_deletion_budget" && request.allowDeletions) return [];
    return [entry];
  });
}

/** A pending commit's state: built for this S on this T (`built`), or already the target's tip (`published`). */
type Pending = Readonly<{ commit: string; published: boolean }>;

/**
 * RECONCILES the pending ref (see the header): the commit when it was built
 * for this S on this T (its first parent is T, its `Promoted-From` is S) or is
 * already T (published), else `null` after dropping it and its receipt with a
 * compare-and-swap (logged once). A rollback's pending commit is reconciled by
 * `rollback.ts`.
 */
export function reconcilePending(context: PromotionContext, git: WorktreeGitPort, inspectMs: number, accepts: (commit: string) => boolean): Pending | null {
  const refs = promotionRefs(context.loaded.profile.name);
  const pending = resolveRevision(context.repository, refs.pending, "object");
  if (pending === null) return null;
  if (pending === context.target) return deepFreeze({ commit: pending, published: true });
  if (resolveRevision(context.repository, `${pending}^1`, "object") === context.target && accepts(pending)) return deepFreeze({ commit: pending, published: false });
  dropPending(context, git, pending, inspectMs);
  return null;
}

/**
 * THE RETENTION of the profile's private area (under the target lock): the
 * lockfile memos and target-edit patches the latest plan neither used nor
 * wrote (older than `since`, its start) are removed — what a plan reads it
 * marks used, so a re-plan of unchanged inputs still finds its memo.
 * Answers the removed names.
 */
function sweepPromotionArea(workDirectory: string, since: number): readonly string[] {
  const stale = (path: string): boolean => {
    const at = statSync(path, { throwIfNoEntry: false })?.mtimeMs;
    return at !== undefined && at < since;
  };
  const memos = join(workDirectory, "lockfiles");
  const candidates = [
    ...(existsSync(memos) ? readdirSync(memos).map((name) => join(memos, name)) : []),
    ...(existsSync(workDirectory) ? readdirSync(workDirectory).filter((name) => name.startsWith("target-edits-") && name.endsWith(".patch")).map((name) => join(workDirectory, name)) : []),
  ];
  const removed = candidates.filter(stale);
  for (const path of removed) rmSync(path, { force: true });
  return removed.map((path) => path.slice(workDirectory.length + 1));
}

/** The receipt's record of a command step: what ran, how it ended, and its evidence (§7.4). */
function receiptStep(step: CheckoutStep): Readonly<Record<string, unknown>> {
  return { step: step.step, status: step.status, message: step.message, ...(step.failure === undefined ? {} : { failure: step.failure }), ...(step.evidence === undefined ? {} : { evidence: step.evidence }) };
}

/** What a build answers: the pinned commit, its receipt, and what certified it. */
type Built = Readonly<{ commit: string; tree: string; parents: readonly string[]; receiptRef: string; candidate: string; settled: SettleReport; hookOutput: string; advisories: readonly Readonly<{ kind: string; path: string; detail: string }>[]; swept: readonly string[] }>;

/** What a landing build makes: the candidate's base (T and an optional second parent), the tree, the commit message and identity, and the receipt's own fields. */
export type BuildSpec = Readonly<{
  /** The candidate's name (its plan id: the same inputs, the same folder). */
  id: string;
  /** The commit's subject line (also the message of the candidate's `merge -s ours`). */
  subject: string;
  tree: string;
  /** The commit's second parent (S), or `null` for a single-parent commit (a rollback). */
  secondParent: string | null;
  message: (settled: SettleReport) => string;
  identity: CommitIdentity;
  receipt: (settled: SettleReport, parents: readonly string[]) => Readonly<Record<string, unknown>>;
  facts: Readonly<Record<string, unknown>>;
}>;

/**
 * Builds, certifies, commits and pins one commit (phases 4-6, shared by a
 * promotion and a rollback): the candidate, the settle, the commit with the
 * hooks, the receipt and `pending` — the candidate is kept for the finish
 * (its build outputs are installed from it). A failure sweeps it (kept while
 * `preserveOnFailure`, and always as an integrity answer's evidence).
 */
export async function buildAndPin(context: PromotionContext, run: ApplyRun, recorder: LastRunRecorder, spec: BuildSpec): Promise<Built> {
  const { git } = run;
  const { profile } = context.loaded;
  const timeouts = worktreeOperationTimeouts(context.document);
  const target = context.target!;
  const folder = promotionFolder(context);
  const candidate = candidatePath(context, spec.id);
  assertWorkRoot(context, candidate);
  const isCandidate = isCandidateOf(profile.name);
  const isThis = (name: string): boolean => join(folder, name) === candidate;
  // The leftovers of crashed or failed runs (the newest kept while asked), then this build's own earlier candidate: a build starts fresh.
  const swept = [
    ...sweepCandidates(git, context.top, folder, isCandidate, context.isolation.preserveOnFailure, timeouts.worktreeMs),
    ...sweepCandidates(git, context.top, folder, isThis, false, timeouts.worktreeMs),
  ];
  for (const path of swept) auditEvent("promotion.recovery", { kind: "candidate_swept", profile: profile.name, path });
  if (existsSync(candidate)) {
    // Not this repository's worktree (the sweep removed ours): a folder left there.
    throw new PromotionError("promotion_work_path_occupied", `${candidate} exists and is not a candidate of this repository: a folder was left there`, { candidate });
  }
  const facts = { profile: profile.name, source: context.source, target, candidate, ...spec.facts };
  let settled: SettleReport;
  let commit: string;
  let hookOutput: string;
  let parents: readonly string[];
  try {
    recorder.phase("candidate");
    const { merged } = await runLandingPhase("candidate", facts, () => createCandidate({
      git, repoRoot: context.top, path: candidate, target, source: spec.secondParent ?? target, tree: spec.tree,
      message: spec.subject, identity: spec.identity, timeoutMs: timeouts.worktreeMs,
    }));
    parents = merged ? [target, spec.secondParent!] : [target];
    run.checkpoint?.("candidate");
    recorder.phase("settle");
    settled = await runLandingPhase("settle", facts, () => settleCandidate({
      git, root: candidate, sourceRoot: context.top, engineRelative: run.engineRelative,
      isolation: context.isolation, phases: profile.phases, run: checkoutCommandRunner(candidate, run.runner),
      generatedOutputs: run.generatedOutputs, baseTree: spec.tree, timeoutMs: timeouts.worktreeMs,
    }));
    run.checkpoint?.("settled");
    recorder.phase("commit");
    ({ commit, output: hookOutput } = await runLandingPhase("commit", facts, () => commitCandidate({
      git, root: candidate, message: spec.message(settled), identity: spec.identity, tree: settled.tree, parents, timeoutMs: timeouts.mergeMs,
    })));
  } catch (error) {
    const refused = promotionErrorOf(error, { candidate });
    const kept = context.isolation.preserveOnFailure || promotionClass(refused.promotionCode) === "integrity";
    let sweepFailure: string | null = null;
    try {
      sweepCandidates(git, context.top, folder, kept ? (name) => isCandidate(name) && !isThis(name) : isThis, false, timeouts.worktreeMs);
    } catch (failure) {
      // The refusal stands and names it; the next run's sweep retries.
      sweepFailure = promotionErrorOf(failure, {}).message;
    }
    auditEvent("promotion.refused", { ...facts, code: refused.promotionCode, kept, sweepFailure });
    throw refused;
  }

  const refs = promotionRefs(profile.name);
  const receiptRef = refs.receipt(commit);
  const receipt = { schema: PROMOTION_RECEIPT_SCHEMA, ...spec.receipt(settled, parents), commit, tree: settled.tree, parents, convergence: settled.convergence, commands: settled.steps.map(receiptStep), toolchain: run.toolchain };
  run.checkpoint?.("committed");
  const receiptBlob = writeBlob(context.repository, `${canonicalJson(receipt)}\n`);
  const recorded = git.createRef(context.top, receiptRef, receiptBlob, timeouts.inspectMs);
  run.checkpoint?.("receipt");
  if (recorded.refusal !== null) debugLog("workflow", "info", "promotion receipt kept: this commit already has one", () => ({ receiptRef, refusal: recorded.refusal }));
  const pinned = git.createRef(context.top, refs.pending, commit, timeouts.inspectMs);
  if (pinned.refusal !== null) {
    // Under the target's lock nothing else pins: the lock was broken or bypassed. The receipt this run created goes (it describes no pinned commit); the candidate stays as the evidence.
    if (recorded.refusal === null) git.deleteRef(context.top, receiptRef, receiptBlob, timeouts.inspectMs);
    auditEvent("promotion.refused", { ...facts, code: "promotion_pending_conflict", kept: true, commit });
    throw new PromotionError("promotion_pending_conflict", `another run pinned ${refs.pending} while this one held the target's lock and built ${commit}: ${pinned.refusal}`, { commit, pending: refs.pending, candidate });
  }
  run.checkpoint?.("pinned");
  recorder.learn({ commit });
  auditEvent("promotion.commit", { ...facts, commit, tree: settled.tree, parents, passes: settled.convergence.passes, regenerated: settled.regenerated.length });
  const advisories = [
    ...((receipt as { advisories?: readonly Readonly<{ kind: string; path: string; detail: string }>[] }).advisories ?? []),
  ];
  return deepFreeze({ commit, tree: settled.tree, parents, receiptRef, candidate, settled, hookOutput, advisories, swept });
}

/** How the publication of a commit is spelled in its receipt: pushed to the remote atomically, landed locally only, or not published by this run. */
function publicationMode(context: PromotionContext, request: ApplyRequest): string {
  if (request.noPublish) return "none";
  return context.loaded.profile.remote === null || request.noPush ? "local" : "atomic-push";
}

/** The promotion build of a plan (see {@link buildAndPin}): the projected tree with S as the second parent, the trailers and the plan's receipt. */
async function buildPromotion(context: PromotionContext, request: ApplyRequest, run: ApplyRun, plan: PromotionPlan, recorder: LastRunRecorder): Promise<Built> {
  const built = await buildAndPin(context, run, recorder, {
    id: plan.planId,
    subject: promotionSubject(context),
    tree: plan.projection.tree,
    secondParent: context.source,
    message: (settled) => promotionMessage(context, plan, settled.regenerated.length, request.acceptTargetEdits),
    identity: committerOf(context, context.source),
    facts: { planId: plan.planId },
    receipt: (settled) => ({
      kind: "promotion",
      profile: plan.profile,
      source: context.source,
      target: context.target,
      planId: plan.planId,
      projectedTree: plan.projection.tree,
      summary: plan.summary,
      transforms: plan.transforms.map((entry) => ({ path: entry.path, digest: sha256(canonicalJson(entry)) })),
      acceptedTargetEdits: request.acceptTargetEdits === null ? null : { paths: request.acceptTargetEdits, reason: request.reason },
      allowedDeletions: request.allowDeletions ? { deleted: plan.summary.deleted, reason: request.reason } : null,
      regenerated: settled.regenerated,
      advisories: [
        ...plan.advisories,
        ...settled.regenerated.map((path) => ({ kind: "source_generated_outputs_stale", path, detail: "the projected tree's copy was not the fixed point of its generators: the candidate regenerated it" })),
      ],
      publication: publicationMode(context, request),
    }),
  });
  return built;
}

/** The answer of a commit built and pinned, nothing published (`--no-publish`; a rerun of a pinned build). */
function committedAnswer(context: PromotionContext, commit: string, built: Built | null): PromotionAnswer {
  const refs = promotionRefs(context.loaded.profile.name);
  const receipt = readReceipt(context, commit);
  const message = built === null
    ? `${commit} is built and certified for ${shortId(context.source)} on ${shortId(context.target!)}; pinned by ${refs.pending}, nothing published (resumed: an earlier run built it)`
    : `${commit} is built and certified for ${shortId(context.source)} on ${shortId(context.target!)} (${String(built.settled.steps.length)} step(s), ${String(built.settled.convergence.passes)} converge pass(es), ${String(built.settled.regenerated.length)} regenerated); pinned by ${refs.pending}, nothing published`;
  return answer("promotion_committed", message, {
    commit,
    pending: refs.pending,
    receiptRef: refs.receipt(commit),
    resumed: built === null,
    receipt,
    ...(built === null ? {} : {
      tree: built.tree,
      parents: built.parents,
      regenerated: built.settled.regenerated,
      steps: built.settled.steps.map(receiptStep),
      // What the repository's commit hooks said while certifying the exact tree (not in the receipt: it may carry timings).
      hookOutput: built.hookOutput,
      advisories: (receipt?.["advisories"] ?? []) as unknown,
      swept: built.swept,
    }),
  });
}

/**
 * `harness promote apply` over a pair's context (see the header). A refusal
 * is a {@link PromotionError}; the lock is released whatever happens, and the
 * last-run record states the answer.
 */
export async function applyPromotion(context: PromotionContext, request: ApplyRequest, run: ApplyRun): Promise<PromotionAnswer> {
  const { profile } = context.loaded;
  // A missing target is the reconcile's refusal (the one owner of T), recorded like any other.
  return withPromotionLock(context, profile.target.ref, `harness promote apply ${profile.name}`, async () => {
    const recorder = lastRunRecorder(context.workDirectory, profile.name, "apply");
    recorder.learn({ source: context.source, target: context.target });
    try {
      const result = await lockedApply(context, request, run, recorder);
      recorder.end(result);
      return result;
    } catch (error) {
      const refused = promotionErrorOf(error, { profile: profile.name });
      recorder.end(answer(refused.promotionCode, refused.message, refused.facts));
      throw refused;
    }
  }, !request.auto);
}

/** Whether `commit` is a promotion of S by this profile (its `Promoted-From` is S and it restores nothing). */
function isPromotionOfSource(context: PromotionContext): (commit: string) => boolean {
  return (commit) => {
    const trailers = promotionTrailersOf(context.repository, commit);
    return trailers.promotedFrom === context.source && trailers.restores === null;
  };
}

/** {@link applyPromotion} under the target's lock (see the header). */
async function lockedApply(initial: PromotionContext, request: ApplyRequest, run: ApplyRun, recorder: LastRunRecorder): Promise<PromotionAnswer> {
  const { profile } = initial.loaded;
  const { git } = run;
  const timeouts = worktreeOperationTimeouts(initial.document);
  run.checkpoint?.("locked");
  for (let attempt = 1; ; attempt += 1) {
    recorder.phase("reconcile");
    const remote = reconcileRemote(initial, git, { promotesSource: true, noPublish: request.noPublish, noPush: request.noPush });
    run.checkpoint?.("reconciled");
    const context: PromotionContext = deepFreeze({ ...initial, target: remote.target });
    recorder.learn({ target: context.target });
    if (remote.hold !== null) {
      if (request.auto || !request.releaseHold) {
        throw new PromotionError("promotion_held", `promotion of ${profile.name} is held (${remote.hold.reason}); ${request.auto ? "an unattended run never releases it" : "a manual run releases it with --release-hold --reason"}`, { hold: remote.hold });
      }
      releaseHoldNow(context, git, remote, request.reason!);
    }
    let commit: string;
    let built: Built | null = null;
    const pending = reconcilePending(context, git, timeouts.inspectMs, isPromotionOfSource(context));
    if (pending !== null) {
      if (request.noPublish) return committedAnswer(context, pending.commit, null);
      auditEvent("promotion.recovery", { kind: "pending_resumed", profile: profile.name, pending: pending.commit, published: pending.published });
      commit = pending.commit;
    } else {
      recorder.phase("plan");
      const planned = Date.now();
      const plan = await run.plan(context);
      run.checkpoint?.("planned");
      recorder.learn({ advisories: plan.advisories, targetEdits: plan.targetEdits });
      const retired = sweepPromotionArea(context.workDirectory, planned);
      if (retired.length > 0) auditEvent("promotion.recovery", { kind: "area_swept", profile: profile.name, removed: retired });
      if (plan.code === "promotion_up_to_date" || plan.code === "promotion_unchanged") {
        if (!request.noPublish && remote.unpushedTarget !== null) {
          // An earlier promotion published locally only (`--no-push`): it is pushed now.
          commit = remote.unpushedTarget;
        } else {
          return answer(plan.code, `nothing to build: ${plan.next}`, plan);
        }
      } else {
        const standing = standingRefusals(plan, request);
        const code: PromotionCode | null = mostSevereCode(standing.map((entry) => entry.code));
        if (code !== null) {
          throw new PromotionError(code, `${String(standing.length)} refusal(s): ${standing.map((entry) => entry.message).join("; ")}`, { refusals: standing, planId: plan.planId, targetEdits: plan.targetEdits, targetEditsPatch: plan.targetEditsPatch });
        }
        if (request.acceptTargetEdits !== null || request.allowDeletions) {
          auditEvent("promotion.override", { profile: profile.name, source: context.source, target: context.target, kinds: [...(request.acceptTargetEdits === null ? [] : ["accept-target-edits"]), ...(request.allowDeletions ? ["allow-deletions"] : [])], paths: request.acceptTargetEdits, reason: request.reason });
        }
        built = await buildPromotion(context, request, run, plan, recorder);
        if (request.noPublish) {
          removeCandidate(context, git, built.candidate);
          return committedAnswer(context, built.commit, built);
        }
        commit = built.commit;
      }
    }
    recorder.phase("publish");
    const published = publishCommit(context, run, request, remote, commit);
    if (published.outcome === "rejected") {
      if (attempt === 1) {
        debugLog("workflow", "warn", "promotion re-plans: the target moved during the publication", () => ({ profile: profile.name, commit, detail: published.detail }));
        continue;
      }
      throw new PromotionError("promotion_push_rejected", `the target moved again while ${commit} was published (re-planned once already): ${published.detail}`, { commit, detail: published.detail });
    }
    recorder.learn({ commit, pushed: published.pushed });
    recorder.phase("finish");
    // This run's landing, whichever step made it: the publication's, or the reconcile's catch-up of a target behind
    // its remote (a parked run, rerun) — whose tip before it is what the finish measures the stale setup from.
    const caughtUp = published.landing === null && remote.target === commit ? remote.caughtUp : null;
    const finished = finishPromotion(context, run, commit, caughtUp?.from ?? published.localBefore);
    run.checkpoint?.("finished");
    recorder.learn({ targetCheckout: finished.targetCheckout });
    const landing = caughtUp?.landing ?? published.landing;
    const landedIn = caughtUp?.landedIn ?? published.landedIn;
    return answer("promotion_published", `${commit} is ${published.pushed ? `pushed to ${profile.remote!} and ` : ""}${landing === null ? "on the target" : `landed on ${branchOf(profile.target.ref)} (${landing})`}${finished.targetCheckout.depsStale.length > 0 ? `; the target checkout needs ${finished.targetCheckout.depsStale.join(", ")} re-run` : ""}`, {
      commit,
      pushed: published.pushed,
      landing,
      landedIn,
      receiptRef: promotionRefs(profile.name).receipt(commit),
      resumed: built === null,
      targetCheckout: finished.targetCheckout,
      installed: finished.installed,
      ...(built === null ? {} : { hookOutput: built.hookOutput, regenerated: built.settled.regenerated, steps: built.settled.steps.map(receiptStep), advisories: built.advisories }),
    });
  }
}
