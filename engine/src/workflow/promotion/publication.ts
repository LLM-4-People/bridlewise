/**
 * PUBLICATION — how a promotion meets the remote and the checkout that holds
 * its target (merge-door-final §7.2 phases 2, 7 and 8, §7.3; the part that
 * must never be wrong). Shared by `apply.ts` and `rollback.ts`.
 *
 * {@link reconcileRemote} (phase 2) reads the remote's source, target and hold
 * refs (`ls-remote`) and fetches what it holds — the remote's hold is the
 * truth (a hold set or released on another machine counts here) — then
 * decides T: the local target equal to its remote's; behind it (landed
 * locally first: a fast-forward of the checkout that holds it, or a
 * compare-and-swap); ahead of it (an earlier promotion published locally
 * only: carried, and pushed); apart (`promotion_target_diverged`). A
 * promotion's source S must be ordered with the remote's
 * (`promotion_source_diverged`); S is pushed with C only when the remote's
 * source is a strict ancestor of it. A rollback reconciles the target and the
 * hold only: it never reads, orders or pushes the source (a local source
 * branch's unpushed commits are not its to publish). A `--no-publish` run
 * reconciles READ-ONLY: a local target behind its remote's is built on the
 * remote's tip without landing it, and a local hold is never deleted —
 * nothing it was promised not to move moves ({@link ReconcileMode}).
 *
 * {@link publishCommit} (phase 7): the REMOTE FIRST — ONE atomic, never-forced
 * push of C to the target, its receipt, S when the remote lags, and a
 * rollback's hold (`tree-landing.ts` `pushToRemote`), then `ls-remote` must
 * read C, or a tip that carries it (another machine built on C meanwhile;
 * `promotion_post_publish_mismatch` otherwise); a rejected push (the
 * remote moved) is answered for a re-plan, the remote's refusal and an
 * unreachable remote are typed. THEN LOCAL — `landCommit`: the checkout that
 * holds the target is fast-forwarded (a torn fast-forward completed with git
 * alone); its own overlapping edits PARK the promotion (the remote is already
 * right; the next run, or any fast-forward there, finishes it); a held
 * git's index lock is the environment's (never deleted). Nothing can be half
 * published: refs move by an atomic push or a compare-and-swap, C is pinned
 * by `pending` before any publication, and a rerun re-reads every tip.
 *
 * {@link finishPromotion} (phase 8): the target checkout's invariants (the
 * config document's mode, J12), the candidate's pinned build outputs
 * installed there as ONE journaled transaction (a running server never reads
 * half of them), its index baseline checked, the setup commands whose inputs
 * the landing changed named (`depsStale`: never run there, it may be
 * serving), `pending` deleted, the candidate removed.
 *
 * A HOLD (`<namespace>/<profile>/hold`, a JSON blob: who held which source,
 * when and why) stops automatic promotion until it is released (UD-7):
 * {@link setHold} / {@link releaseHoldNow} write it locally and on the remote.
 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

import { deepFreeze } from "../../kernel/integrity.ts";
import { schemaId } from "../../kernel/product-identity.ts";
import { canonicalJson } from "../../kernel/integrity.ts";
import { commitJournaled } from "../../filesystem/journaled-commit.ts";
import { checkIndexBaseline } from "../../git/index-baseline.ts";
import { gitOutput, resolveRevision, writeBlob } from "../../git/tree-reader.ts";
import type { WorktreeGitPort } from "../../git/worktree-port.ts";
import { auditEvent } from "../../shared/debug/debug-system.ts";
import { settleCheckout } from "../checkout-setup.ts";
import { engineRelativeIn } from "./promoter-home.ts";
import { worktreeOperationTimeouts } from "../workflow-config.ts";
import { branchCheckout, landCommit, pushToRemote, remoteFailureClass } from "../tree-landing.ts";
import { PromotionError } from "./codes.ts";
import { branchOf } from "./profile.ts";
import { candidatePath, dropPending, promotionRefs, readReceipt, removeCandidate, type ApplyRequest, type ApplyRun } from "./promotion-run.ts";
import type { TargetCheckoutState } from "./last-run.ts";
import type { PromotionContext } from "./context.ts";

const PROMOTION_HOLD_SCHEMA = schemaId("promotion-hold", 1);

/** A profile's hold (see the header). */
export type PromotionHold = Readonly<{ blob: string; heldSource: string | null; restores: string | null; reason: string; at: string; by: string }>;

/** How phase 2 runs (see the header): `promotesSource` (a promotion; `false`: a rollback), `noPublish` (read-only), `noPush` (an unpushed local target is not carried to the remote). */
type ReconcileMode = Readonly<{ promotesSource: boolean; noPublish: boolean; noPush: boolean }>;

/** What phase 2 found (see the header). */
export type RemoteState = Readonly<{
  /** T: the tip a promotion builds on. */
  target: string;
  /** The remote's target tip (`null`: no remote, or the remote has no target branch yet). */
  remoteTarget: string | null;
  /** S goes with C (a promotion whose remote's source is a strict ancestor of S). */
  pushSource: boolean;
  /** The local target tip when it is ahead of its remote's (an earlier promotion published locally only), and pushing is on; else `null`. */
  unpushedTarget: string | null;
  /** The hold in force (the remote's when there is a remote), or `null`. */
  hold: PromotionHold | null;
  /** The local target was behind its remote and was landed on the remote's tip here: from which tip, and how (`null`: it was not behind, the landing was refused, or the run is read-only). */
  caughtUp: Readonly<{ from: string; landing: string; landedIn: string | null }> | null;
}>;

/** The hold this repository records for the profile (its local ref: what a run last synchronized), or `null`. */
export function localHold(context: PromotionContext): PromotionHold | null {
  const blob = resolveRevision(context.repository, promotionRefs(context.loaded.profile.name).hold, "object");
  return blob === null ? null : readHold(context, blob);
}

/** The hold the blob `blob` records. */
function readHold(context: PromotionContext, blob: string): PromotionHold {
  const record = JSON.parse(gitOutput(context.repository, ["cat-file", "blob", blob]).stdout.toString("utf8")) as Partial<PromotionHold>;
  return deepFreeze({ blob, heldSource: record.heldSource ?? null, restores: record.restores ?? null, reason: String(record.reason ?? "(no reason recorded)"), at: String(record.at ?? ""), by: String(record.by ?? "") });
}

/** A remote operation git could not run, typed: the remote's refusal (`promotion_remote_refused`), else the machine's (`errorCode`). */
function remoteFailure(operation: string, words: string, errorCode: "promotion_remote_errored" | "promotion_push_errored"): PromotionError {
  return remoteFailureClass(words) === "refused"
    ? new PromotionError("promotion_remote_refused", `${operation} was refused: ${words}`, { operation, words })
    : new PromotionError(errorCode, `${operation} did not reach the remote: ${words}`, { operation, words });
}

function isAncestor(git: WorktreeGitPort, context: PromotionContext, ancestor: string, descendant: string): boolean {
  return git.isAncestor(context.top, ancestor, descendant, worktreeOperationTimeouts(context.document).inspectMs);
}

/**
 * The hold in force (see the header): with a remote, the remote's — fetched
 * into the local ref, or the local ref deleted when the remote released it
 * (except the hold of a rollback built here and not pushed yet, which goes
 * with it; and kept by a `readOnly` run) — else the local ref's.
 */
export function syncHold(context: PromotionContext, git: WorktreeGitPort, readOnly = false): PromotionHold | null {
  const { profile } = context.loaded;
  const timeouts = worktreeOperationTimeouts(context.document);
  const refs = promotionRefs(profile.name);
  const local = resolveRevision(context.repository, refs.hold, "object");
  if (profile.remote === null) return local === null ? null : readHold(context, local);
  const listing = git.lsRemote(context.top, profile.remote, [refs.hold], timeouts.fetchMs);
  if (listing.refusal !== null) throw remoteFailure(`git ls-remote ${profile.remote}`, listing.refusal, "promotion_remote_errored");
  const remoteHold = listing.refs.get(refs.hold) ?? null;
  if (remoteHold !== null) {
    if (remoteHold !== local) {
      const fetched = git.fetchRefs(context.top, profile.remote, [`+${refs.hold}:${refs.hold}`], timeouts.fetchMs);
      if (fetched.refusal !== null) throw remoteFailure(`git fetch ${profile.remote}`, fetched.refusal, "promotion_remote_errored");
    }
    return readHold(context, remoteHold);
  }
  if (local === null) return null;
  if (pendingRollbackHold(context) === local) return readHold(context, local);
  if (readOnly) return null;
  git.deleteRef(context.top, refs.hold, local, timeouts.inspectMs);
  auditEvent("promotion.recovery", { kind: "hold_released_remotely", profile: profile.name, hold: local });
  return null;
}

/** Phase 2 (see the header): the remote's refs read and fetched, T decided (the local branch landed when it lagged, unless read-only), a promotion's S ordered, the hold in force. */
export function reconcileRemote(context: PromotionContext, git: WorktreeGitPort, mode: ReconcileMode): RemoteState {
  const { profile } = context.loaded;
  const timeouts = worktreeOperationTimeouts(context.document);
  const local = resolveRevision(context.repository, profile.target.ref);
  const hold = syncHold(context, git, mode.noPublish);
  if (profile.remote === null) {
    if (local === null) throw new PromotionError("promotion_target_missing", `the target ${profile.target.ref} does not exist: a promotion builds on the target's tip`, { target: profile.target.ref });
    return deepFreeze({ target: local, remoteTarget: null, pushSource: false, unpushedTarget: null, hold, caughtUp: null });
  }
  const { remote } = profile;
  const listing = git.lsRemote(context.top, remote, mode.promotesSource ? [profile.source.ref, profile.target.ref] : [profile.target.ref], timeouts.fetchMs);
  if (listing.refusal !== null) throw remoteFailure(`git ls-remote ${remote}`, listing.refusal, "promotion_remote_errored");
  const remoteTarget = listing.refs.get(profile.target.ref) ?? null;
  const remoteSource = mode.promotesSource ? listing.refs.get(profile.source.ref) ?? null : null;
  const refspecs = [
    ...(remoteTarget === null ? [] : [`+${profile.target.ref}:refs/remotes/${remote}/${branchOf(profile.target.ref)}`]),
    ...(remoteSource === null ? [] : [`+${profile.source.ref}:refs/remotes/${remote}/${branchOf(profile.source.ref)}`]),
  ];
  if (refspecs.length > 0) {
    const fetched = git.fetchRefs(context.top, remote, refspecs, timeouts.fetchMs);
    if (fetched.refusal !== null) throw remoteFailure(`git fetch ${remote}`, fetched.refusal, "promotion_remote_errored");
  }
  let target: string;
  let unpushedTarget: string | null = null;
  let caughtUp: RemoteState["caughtUp"] = null;
  if (remoteTarget === null && local === null) {
    throw new PromotionError("promotion_target_missing", `the target ${profile.target.ref} exists neither here nor on ${remote}: a promotion builds on the target's tip`, { target: profile.target.ref, remote });
  } else if (remoteTarget === null) {
    target = local!;
    unpushedTarget = mode.noPush ? null : local;
  } else if (local === null || local === remoteTarget) {
    target = remoteTarget;
  } else if (isAncestor(git, context, local, remoteTarget)) {
    // Behind: the remote's tip lands locally first (parked by local edits, or read-only: the plan builds on the remote's tip anyway).
    target = remoteTarget;
    if (!mode.noPublish) {
      const landed = landCommit(git, context.top, branchOf(profile.target.ref), remoteTarget, local, engineRelativeIn(git, timeouts.inspectMs), timeouts.worktreeMs);
      auditEvent("promotion.recovery", { kind: "target_caught_up", profile: profile.name, from: local, to: remoteTarget, landing: landed.landing, refusal: landed.refusal, overlap: landed.overlap });
      if (landed.refusal === null) caughtUp = { from: local, landing: landed.landing, landedIn: landed.landedIn };
    }
  } else if (isAncestor(git, context, remoteTarget, local)) {
    target = local;
    unpushedTarget = mode.noPush ? null : local;
  } else {
    throw new PromotionError("promotion_target_diverged", `${profile.target.ref} (${local}) and ${remote}'s (${remoteTarget}) have moved apart`, { local, remote: remoteTarget });
  }
  let pushSource = false;
  if (remoteSource !== null && remoteSource !== context.source) {
    if (isAncestor(git, context, remoteSource, context.source)) pushSource = true;
    else if (!isAncestor(git, context, context.source, remoteSource)) {
      throw new PromotionError("promotion_source_diverged", `the source ${context.source} and ${remote}'s ${profile.source.ref} (${remoteSource}) have moved apart`, { source: context.source, remote: remoteSource });
    }
  }
  return deepFreeze({ target, remoteTarget, pushSource, unpushedTarget, hold, caughtUp });
}

/** The hold blob the pinned (pending) rollback carries in its receipt, or `null` when the pending commit is no rollback. */
function pendingRollbackHold(context: PromotionContext): string | null {
  const pending = resolveRevision(context.repository, promotionRefs(context.loaded.profile.name).pending, "object");
  const hold = pending === null ? undefined : readReceipt(context, pending)?.["hold"];
  return typeof hold === "string" ? hold : null;
}

/** The hold a rollback or `hold` sets (see the header): the blob of the hold in force (an existing hold stays: still held), else a new one written — no ref yet ({@link setHold} creates it). */
export function holdBlob(context: PromotionContext, facts: Readonly<{ heldSource: string | null; restores: string | null; reason: string }>): string {
  const existing = resolveRevision(context.repository, promotionRefs(context.loaded.profile.name).hold, "object");
  if (existing !== null) return existing;
  return writeBlob(context.repository, `${canonicalJson({ schema: PROMOTION_HOLD_SCHEMA, profile: context.loaded.profile.name, ...facts, at: new Date().toISOString(), by: userInfo().username })}\n`);
}

/** Puts the hold `blob` in force locally: its ref created unless one exists (an existing hold stays); answers the blob in force. A rollback creates it only once R is pinned (a failed build leaves no hold behind). */
export function setHold(context: PromotionContext, git: WorktreeGitPort, blob: string): string {
  const refs = promotionRefs(context.loaded.profile.name);
  const existing = resolveRevision(context.repository, refs.hold, "object");
  if (existing !== null) return existing;
  const created = git.createRef(context.top, refs.hold, blob, worktreeOperationTimeouts(context.document).inspectMs);
  if (created.refusal !== null) return resolveRevision(context.repository, refs.hold, "object") ?? blob;
  return blob;
}

/** Pushes the hold ref's state to the remote (a deletion when `deleted`): typed when the remote refuses or is not reached. */
export function pushHold(context: PromotionContext, git: WorktreeGitPort, deleted: boolean): void {
  const { profile } = context.loaded;
  if (profile.remote === null) return;
  const refs = promotionRefs(profile.name);
  const verdict = pushToRemote(git, context.top, profile.remote, [deleted ? `:${refs.hold}` : `${refs.hold}:${refs.hold}`], worktreeOperationTimeouts(context.document).pushMs);
  if (verdict.verdict === "pushed") return;
  if (verdict.verdict === "errored") throw new PromotionError("promotion_push_errored", `the hold could not reach ${profile.remote}: ${verdict.detail}`, { detail: verdict.detail });
  throw new PromotionError("promotion_remote_refused", `${profile.remote} refused the hold: ${verdict.detail}`, { detail: verdict.detail });
}

/** Releases the hold in force (`release-hold`, or `apply --release-hold`): deleted on the remote first, then locally; logged with its reason. */
export function releaseHoldNow(context: PromotionContext, git: WorktreeGitPort, remote: Pick<RemoteState, "hold">, reason: string): void {
  if (remote.hold === null) return;
  const refs = promotionRefs(context.loaded.profile.name);
  pushHold(context, git, true);
  const local = resolveRevision(context.repository, refs.hold, "object");
  if (local !== null) git.deleteRef(context.top, refs.hold, local, worktreeOperationTimeouts(context.document).inspectMs);
  auditEvent("promotion.releaseHold", { profile: context.loaded.profile.name, hold: remote.hold.blob, heldSource: remote.hold.heldSource, reason });
}

/**
 * Whether the remote's target tip `listed` carries `commit` — a push accepted
 * and then built upon by another machine before the verification read it: the
 * tip fetched into the remote-tracking ref, and `commit` its ancestor.
 */
function remoteCarries(context: PromotionContext, git: WorktreeGitPort, commit: string, listed: string): boolean {
  const { profile } = context.loaded;
  const fetched = git.fetchRefs(context.top, profile.remote!, [`+${profile.target.ref}:refs/remotes/${profile.remote!}/${branchOf(profile.target.ref)}`], worktreeOperationTimeouts(context.document).fetchMs);
  if (fetched.refusal !== null) throw remoteFailure(`git fetch ${profile.remote!} (after the push)`, fetched.refusal, "promotion_remote_errored");
  return resolveRevision(context.repository, listed, "object") !== null && isAncestor(git, context, commit, listed);
}

/** What phase 7 did (see the header). */
export type Publication = Readonly<
  | { outcome: "rejected"; detail: string }
  | { outcome: "published"; pushed: boolean; landing: string | null; landedIn: string | null; localBefore: string | null }
>;

/** Phase 7 (see the header): the remote first, then the checkout that holds the target. */
export function publishCommit(context: PromotionContext, run: Pick<ApplyRun, "git" | "checkpoint">, request: Pick<ApplyRequest, "noPush">, remote: RemoteState, commit: string): Publication {
  const { git } = run;
  const { profile } = context.loaded;
  const timeouts = worktreeOperationTimeouts(context.document);
  const refs = promotionRefs(profile.name);
  let pushed = false;
  if (profile.remote !== null && !request.noPush && remote.remoteTarget !== commit) {
    const receiptRef = refs.receipt(commit);
    const receipt = readReceipt(context, commit);
    const refspecs = [
      `${commit}:${profile.target.ref}`,
      ...(receipt === null ? [] : [`${receiptRef}:${receiptRef}`]),
      ...(typeof receipt?.["hold"] === "string" && resolveRevision(context.repository, refs.hold, "object") !== null ? [`${refs.hold}:${refs.hold}`] : []),
      ...(remote.pushSource ? [`${context.source}:${profile.source.ref}`] : []),
    ];
    const verdict = pushToRemote(git, context.top, profile.remote, refspecs, timeouts.pushMs);
    run.checkpoint?.("pushed");
    if (verdict.verdict === "rejected") return deepFreeze({ outcome: "rejected", detail: verdict.detail });
    if (verdict.verdict === "refused") throw new PromotionError("promotion_remote_refused", `${profile.remote} refused the promotion push: ${verdict.detail}`, { commit, detail: verdict.detail });
    if (verdict.verdict === "errored") throw new PromotionError("promotion_push_errored", `the promotion push did not reach ${profile.remote}: ${verdict.detail}`, { commit, detail: verdict.detail });
    const after = git.lsRemote(context.top, profile.remote, [profile.target.ref], timeouts.fetchMs);
    if (after.refusal !== null) throw remoteFailure(`git ls-remote ${profile.remote} (after the push)`, after.refusal, "promotion_remote_errored");
    const listed = after.refs.get(profile.target.ref) ?? null;
    if (listed !== commit && !(listed !== null && remoteCarries(context, git, commit, listed))) {
      throw new PromotionError("promotion_post_publish_mismatch", `after an accepted push ${profile.remote}'s ${profile.target.ref} is ${listed ?? "absent"}, which does not carry ${commit}`, { commit, remote: listed });
    }
    pushed = true;
    auditEvent("promotion.published", { profile: profile.name, commit, remote: profile.remote, refs: refspecs.map((refspec) => refspec.split(":")[1]) });
  }
  const local = resolveRevision(context.repository, profile.target.ref);
  if (local === commit || local === null) return deepFreeze({ outcome: "published", pushed, landing: null, landedIn: null, localBefore: local });
  const landed = landCommit(git, context.top, branchOf(profile.target.ref), commit, local, engineRelativeIn(git, timeouts.inspectMs), timeouts.worktreeMs);
  run.checkpoint?.("landed");
  if (landed.refusal !== null) {
    if (resolveRevision(context.repository, profile.target.ref) !== local) return deepFreeze({ outcome: "rejected", detail: `${profile.target.ref} moved during the landing: ${landed.refusal}` });
    if (landed.indexLocked) throw new PromotionError("promotion_target_index_locked", `the checkout ${landed.landedIn ?? "?"} has its index locked by another git: ${landed.refusal}`, { checkout: landed.landedIn, commit, pushed });
    auditEvent("promotion.published", { profile: profile.name, commit, mode: "parked", checkout: landed.landedIn, overlap: landed.overlap });
    throw new PromotionError("promotion_parked", `${commit} is ${pushed || profile.remote !== null ? `on ${profile.remote ?? "the remote"}` : "pinned"}, but the checkout ${landed.landedIn ?? "?"} holds local edits on paths the landing changes (${landed.overlap.join(", ") || "see git's words"}): ${landed.refusal}`, { commit, pushed, checkout: landed.landedIn, overlap: landed.overlap, refusal: landed.refusal });
  }
  auditEvent("promotion.published", { profile: profile.name, commit, mode: landed.landing, checkout: landed.landedIn });
  if (landed.landing === "torn-completion") auditEvent("promotion.recovery", { kind: "torn_completed", profile: profile.name, commit, checkout: landed.landedIn });
  return deepFreeze({ outcome: "published", pushed, landing: landed.landing, landedIn: landed.landedIn, localBefore: local });
}

/** The setup commands of the profile one of whose declared inputs `changed` touches (what the target checkout needs re-run). */
function staleSetup(context: PromotionContext, changed: readonly string[]): readonly string[] {
  return context.loaded.profile.phases.setup.filter((name) => (context.isolation.commands[name]?.inputs ?? []).some((input) => changed.some((path) => path === input || path.startsWith(`${input}/`))));
}

/** Phase 8 (see the header). `localBefore` is the target's local tip before the landing (`null`: nothing landed here). */
export function finishPromotion(context: PromotionContext, run: Pick<ApplyRun, "git" | "engineRelative" | "buildOutputs" | "checkpoint">, commit: string, localBefore: string | null): Readonly<{ targetCheckout: TargetCheckoutState; installed: readonly string[] }> {
  const { git } = run;
  const { profile } = context.loaded;
  const timeouts = worktreeOperationTimeouts(context.document);
  const refs = promotionRefs(profile.name);
  const checkout = branchCheckout(git, context.top, branchOf(profile.target.ref), timeouts.inspectMs);
  const changed = localBefore === null || localBefore === commit ? [] : git.diffNameOnly({ cwd: context.top, refA: localBefore, refB: commit, threeDot: false, timeoutMs: timeouts.inspectMs });
  const receipt = readReceipt(context, commit);
  const planId = typeof receipt?.["planId"] === "string" ? receipt["planId"] : typeof receipt?.["restores"] === "string" ? receipt["restores"] : null;
  const candidate = planId === null ? null : candidatePath(context, planId);
  let installed: readonly string[] = [];
  if (checkout !== null) {
    settleCheckout(checkout, run.engineRelative);
    if (candidate !== null && existsSync(candidate)) installed = installBuildOutputs(checkout, candidate, run.buildOutputs());
    run.checkpoint?.("installed");
    checkIndexBaseline(checkout);
  }
  const depsStale = staleSetup(context, changed);
  const pending = resolveRevision(context.repository, refs.pending, "object");
  if (pending === commit) git.deleteRef(context.top, refs.pending, pending, timeouts.inspectMs);
  else if (pending !== null) dropPending(context, git, pending, timeouts.inspectMs);
  if (candidate !== null) removeCandidate(context, git, candidate);
  if (depsStale.length > 0) auditEvent("promotion.liveCheckout", { profile: profile.name, checkout, depsStale });
  return deepFreeze({ targetCheckout: { path: checkout, overlap: [], depsStale }, installed });
}

/** Installs the candidate's `paths` (the pinned build outputs it built) into `checkout` as ONE journaled transaction; answers what changed. */
function installBuildOutputs(checkout: string, candidate: string, paths: readonly string[]): readonly string[] {
  const files = paths.flatMap((path) => {
    const built = join(candidate, path);
    const stats = lstatSync(built, { throwIfNoEntry: false });
    if (stats === undefined || !stats.isFile()) return [];
    const bytes = readFileSync(built);
    const current = join(checkout, path);
    if (existsSync(current) && readFileSync(current).equals(bytes) && (lstatSync(current).mode & 0o777) === (stats.mode & 0o777)) return [];
    return [{ path, bytes: new Uint8Array(bytes), mode: stats.mode & 0o777 }];
  });
  if (files.length > 0) commitJournaled(checkout, "promotion-build-outputs", files);
  return deepFreeze(files.map((file) => file.path));
}
