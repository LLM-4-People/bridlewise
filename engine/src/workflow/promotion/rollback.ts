/**
 * ROLLBACK AND HOLD (merge-door-final §10; forward-only, never a forced push).
 *
 * `harness promote rollback --to <promotion commit Pg> --reason <text>`
 * ({@link rollbackPromotion}) restores the target to what an earlier
 * promotion shipped: a commit R whose tree is Pg's, whose ONE parent is the
 * target's current tip, carrying `Promotion-Profile` and `Promoted-From` of
 * Pg and `Promotion-Restores: <Pg>`, as Pg's committer at Pg's committer date
 * (the same rollback of the same tip is the same commit). R is built,
 * certified and published exactly like a promotion (`apply.ts` `buildAndPin`:
 * the candidate, the setup, the converge — a no-op on a converged tree —, the
 * verify gates, the commit with the hooks; `publication.ts`: the atomic push,
 * the landing, the finish), and it sets the profile's HOLD, pushed atomically
 * with R: automatic promotion stays paused until someone says the defect is
 * fixed (UD-7). Pg must be a promotion of this profile on the target's
 * first-parent line, not the tip, and not itself a rollback (a rollback of a
 * rollback is refused).
 *
 * `harness promote hold --reason` ({@link holdPromotion}) sets the hold
 * without a rollback; `harness promote release-hold --reason`
 * ({@link releaseHold}) deletes it — on the remote first. Each runs under the
 * target's lock, writes the last-run record and is audited with its reason.
 */
import { deepFreeze } from "../../kernel/integrity.ts";
import { ROOT_POLICY } from "../../kernel/root-policy.ts";
import { resolveRevision } from "../../git/tree-reader.ts";
import { auditEvent } from "../../shared/debug/debug-system.ts";
import { worktreeOperationTimeouts } from "../workflow-config.ts";
import { PromotionError, answer, type PromotionAnswer } from "./codes.ts";
import { lastRunRecorder, type LastRunRecorder } from "./last-run.ts";
import { branchOf } from "./profile.ts";
import { buildAndPin, reconcilePending } from "./apply.ts";
import { committerOf, promotionErrorOf, promotionRefs, readReceipt, shortId, withPromotionLock, type ApplyRun } from "./promotion-run.ts";
import { finishPromotion, holdBlob, publishCommit, pushHold, reconcileRemote, releaseHoldNow, setHold, syncHold } from "./publication.ts";
import { profileHistory, promotionTrailersOf } from "./trailers.ts";
import type { PromotionContext } from "./context.ts";

/** Runs `body` under the target's lock with its last-run record (`verb`), the answer recorded and a failure typed. */
async function recordedUnderLock(context: PromotionContext, verb: string, body: (recorder: LastRunRecorder) => Promise<PromotionAnswer>): Promise<PromotionAnswer> {
  const { profile } = context.loaded;
  return withPromotionLock(context, profile.target.ref, `harness promote ${verb} ${profile.name}`, async () => {
    const recorder = lastRunRecorder(context.workDirectory, profile.name, verb);
    try {
      const result = await body(recorder);
      recorder.end(result);
      return result;
    } catch (error) {
      const refused = promotionErrorOf(error, { profile: profile.name, verb });
      recorder.end(answer(refused.promotionCode, refused.message, refused.facts));
      throw refused;
    }
  });
}

/** `harness promote rollback --to <Pg> --reason <text>` (see the header). */
export function rollbackPromotion(initial: PromotionContext, request: Readonly<{ to: string; reason: string }>, run: ApplyRun): Promise<PromotionAnswer> {
  return recordedUnderLock(initial, "rollback", async (recorder) => {
    const { profile } = initial.loaded;
    const { trailers } = ROOT_POLICY.workflow.promotion;
    const { git } = run;
    const timeouts = worktreeOperationTimeouts(initial.document);
    recorder.phase("reconcile");
    // The target and the hold only: a rollback never reads, orders or pushes the source.
    const remote = reconcileRemote(initial, git, { promotesSource: false, noPublish: false, noPush: false });
    const context: PromotionContext = deepFreeze({ ...initial, target: remote.target });
    const target = remote.target;
    const to = resolveRevision(context.repository, request.to);
    const history = profileHistory(context.repository, target, profile.name);
    const line = history.find((entry) => entry.commit === to);
    const invalid = (why: string): PromotionError => new PromotionError("promotion_rollback_invalid", `${request.to} cannot be rolled back to: ${why}`, { to: request.to, target });
    if (to === null) throw invalid("it names no commit");
    if (line === undefined) throw invalid(`it is not a promotion of ${profile.name} on ${branchOf(profile.target.ref)}'s first-parent history`);
    if (line.trailers.restores !== null) throw invalid(`it is itself a rollback (of ${line.trailers.restores}): a rollback of a rollback is refused`);
    if (to === target) throw invalid(`it is ${branchOf(profile.target.ref)}'s tip: there is nothing to roll back`);
    const pending = reconcilePending(context, git, timeouts.inspectMs, (commit) => promotionTrailersOf(context.repository, commit).restores === to);
    let commit: string;
    if (pending !== null) {
      auditEvent("promotion.recovery", { kind: "pending_resumed", profile: profile.name, pending: pending.commit, rollback: to });
      commit = pending.commit;
    } else {
      const heldSource = history[0]?.trailers.promotedFrom ?? null;
      // The hold's blob now (the receipt names it), its ref only once R is pinned: a failed build leaves no hold behind.
      const hold = holdBlob(context, { heldSource, restores: to, reason: request.reason });
      const subject = `rollback(${profile.name}): restore ${shortId(to)} on ${branchOf(profile.target.ref)}`;
      const built = await buildAndPin(context, run, recorder, {
        id: to,
        subject,
        tree: resolveTree(context, to),
        secondParent: null,
        message: () => [
          subject, "", request.reason, "",
          `${trailers.promotedFrom}: ${line.trailers.promotedFrom ?? to}`,
          `${trailers.profile}: ${line.trailers.profile!}`,
          `${trailers.restores}: ${to}`,
        ].join("\n"),
        identity: committerOf(context, to),
        facts: { restores: to },
        receipt: () => ({ kind: "rollback", profile: { name: profile.name, blob: context.loaded.blob, path: context.loaded.path }, restores: to, target, reason: request.reason, hold, publication: profile.remote === null ? "local" : "atomic-push" }),
      });
      commit = built.commit;
    }
    // The pinned rollback's hold in force here (created now, or again after a crash between the pin and the ref), so it is pushed with R.
    const held = readReceipt(context, commit)?.["hold"];
    if (typeof held === "string") setHold(context, git, held);
    recorder.phase("publish");
    const published = publishCommit(context, run, { noPush: false }, remote, commit);
    if (published.outcome === "rejected") {
      throw new PromotionError("promotion_push_rejected", `the target moved while the rollback ${commit} was published: ${published.detail} (run the rollback again: it rebuilds on the new tip)`, { commit, detail: published.detail });
    }
    recorder.learn({ commit, pushed: published.pushed });
    recorder.phase("finish");
    const finished = finishPromotion(context, run, commit, published.localBefore);
    recorder.learn({ targetCheckout: finished.targetCheckout });
    auditEvent("promotion.rollback", { profile: profile.name, commit, restores: to, from: target, reason: request.reason, pushed: published.pushed });
    return answer("promotion_rolled_back", `${branchOf(profile.target.ref)} is restored to ${shortId(to)}'s tree by ${commit}${published.pushed ? `, pushed to ${profile.remote!}` : ""}; automatic promotion is held`, {
      commit, restores: to, pushed: published.pushed, landing: published.landing, hold: readReceipt(context, commit)?.["hold"] ?? null, targetCheckout: finished.targetCheckout,
    });
  });
}

/** The tree of `commit`. */
function resolveTree(context: PromotionContext, commit: string): string {
  const tree = resolveRevision(context.repository, `${commit}^{tree}`, "object");
  if (tree === null) throw new PromotionError("promotion_rollback_invalid", `${commit} has no tree`, { commit });
  return tree;
}

/** `harness promote hold --reason <text>` (see the header). */
export function holdPromotion(context: PromotionContext, reason: string, run: Pick<ApplyRun, "git">): Promise<PromotionAnswer> {
  return recordedUnderLock(context, "hold", async () => {
    const { profile } = context.loaded;
    const existing = syncHold(context, run.git);
    if (existing !== null) return answer("promotion_hold_set", `${profile.name} is already held (${existing.reason})`, { hold: existing });
    const target = resolveRevision(context.repository, profile.target.ref) ?? context.target;
    const heldSource = target === null ? null : profileHistory(context.repository, target, profile.name)[0]?.trailers.promotedFrom ?? null;
    const blob = setHold(context, run.git, holdBlob(context, { heldSource, restores: null, reason }));
    try {
      pushHold(context, run.git, false);
    } catch (error) {
      // Not on the remote, so not in force anywhere else: the local ref goes too (the hold is all or nothing).
      run.git.deleteRef(context.top, promotionRefs(profile.name).hold, blob, worktreeOperationTimeouts(context.document).inspectMs);
      throw error;
    }
    auditEvent("promotion.hold", { profile: profile.name, hold: blob, heldSource, reason });
    return answer("promotion_hold_set", `automatic promotion of ${profile.name} is held: ${reason}`, { hold: blob, heldSource });
  });
}

/** `harness promote release-hold --reason <text>` (see the header). */
export function releaseHold(context: PromotionContext, reason: string, run: Pick<ApplyRun, "git">): Promise<PromotionAnswer> {
  return recordedUnderLock(context, "release-hold", async () => {
    const { profile } = context.loaded;
    const hold = syncHold(context, run.git);
    if (hold === null) return answer("promotion_not_held", `${profile.name} holds no hold`, {});
    releaseHoldNow(context, run.git, { hold }, reason);
    return answer("promotion_hold_released", `automatic promotion of ${profile.name} resumes: ${reason}`, { released: hold });
  });
}
