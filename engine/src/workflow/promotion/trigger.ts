/**
 * THE TRIGGER — `harness promote auto --refs <refs>` (merge-door-final §11),
 * the entry the tracked `reference-transaction` hook starts in the background
 * after a push or a fetch moved remote-tracking refs (`trigger-hook.ts`). It
 * takes about a second and never blocks git:
 *
 * 1. The promoter's own fetches and pushes carry the run variable
 *    (`ROOT_POLICY.workflow.promotion.runEnvironmentVariable`): nothing to do.
 * 2. For each moved `refs/remotes/<remote>/<branch>`, the profiles THAT COMMIT
 *    declares (the profile lives on the source, so no machine setting and no
 *    second list) whose source is `refs/heads/<branch>`, whose remote is
 *    `<remote>` and whose trigger is `on-source-publish`.
 * 3. Each one not already carrying that commit (its last `Promoted-From`)
 *    starts ONE unattended `apply --profile <p> --source <commit> --auto` in
 *    the background ({@link launchUnattendedApply}). A hold is never decided
 *    here: the local hold ref is only a mirror, so the run itself reads the
 *    remote's and answers `promotion_held` (a hold released on another machine
 *    resumes automation here at the next push). An unattended run never waits
 *    for a lock: a run in progress coalesces it (`promotion_locked`).
 * 4. LATEST WINS ({@link withUnattendedChain}): every `apply` that ends —
 *    whatever its answer, except a hold or a coalesced run — and only once
 *    its locks are released and its process is the top-level one (never a
 *    promoter home's supervised child, whose descendants die with it),
 *    fetches the remote's source and, when it holds a commit the run's S does
 *    not contain, asks THIS trigger about that tip: the run that held the lock
 *    owes the chain to the runs it coalesced.
 * 5. FEEDBACK WITHOUT A TERMINAL: when a matched profile's previous run did
 *    not end ok, the answer carries ONE notice line for it — `auto`'s `--text`
 *    report, which the hook prints on the pusher's stderr: the person or agent
 *    who pushed sees a blocked promotion at the next push, and nothing else.
 *    The run started in the background logs to a file of its own in the
 *    profile's area (`last-run.ts` `openUnattendedLog`), named by its record.
 *
 * Any scheduler may call `apply --auto` itself (idempotent; exit 0 when not
 * due); none is built in.
 */
import { closeSync } from "node:fs";

import { deepFreeze } from "../../kernel/integrity.ts";
import { ROOT_POLICY } from "../../kernel/root-policy.ts";
import { resolveRevision } from "../../git/tree-reader.ts";
import { startDetached } from "../../process/supervised-run.ts";
import type { WorktreeGitPort } from "../../git/worktree-port.ts";
import { auditEvent, debugLog } from "../../shared/debug/debug-system.ts";
import { worktreeOperationTimeouts } from "../workflow-config.ts";
import { PromotionError, answer, answerWith, type PromotionAnswer, type PromotionCode } from "./codes.ts";
import { openUnattendedLog, promotionState, readLastRun } from "./last-run.ts";
import { branchOf } from "./profile.ts";
import { isPromoterHomeChild, runningEngine } from "./promoter-home.ts";
import { formatPromoteArguments } from "./promote-arguments.ts";
import { promotionErrorOf, targetTip } from "./promotion-run.ts";
import { profileHistory } from "./trailers.ts";
import type { PromotionContext, RepositoryContext } from "./context.ts";

/** Starts one unattended run of a pair for `source` in the background; answers its pid. */
export type UnattendedLaunch = (context: PromotionContext, source: string) => number;

/**
 * The environment of an unattended run started from `environment`: a
 * top-level run of its own — never the promoter home's child (its
 * placement variable dropped: the new run finds its own promoter) — whose
 * log is `log`.
 */
export function unattendedEnvironment(environment: NodeJS.ProcessEnv, log: string): NodeJS.ProcessEnv {
  const { promoterHomeEnvironmentVariable, logEnvironmentVariable } = ROOT_POLICY.workflow.promotion;
  const own: NodeJS.ProcessEnv = { ...environment, [logEnvironmentVariable]: log };
  delete own[promoterHomeEnvironmentVariable];
  return own;
}

/** The production launch: this engine's CLI entry, `apply --profile <p> --source <S> --auto`, detached; it reports through its last-run record, and its log lines land in a log of its own (see the header). */
export function launchUnattendedApply(context: PromotionContext, source: string): number {
  const engine = runningEngine();
  const log = openUnattendedLog(context.workDirectory);
  try {
    return startDetached(process.execPath, [
      ...process.execArgv,
      `${engine.root}/${engine.entry}`,
      ...engine.command,
      ...formatPromoteArguments({ verb: "apply", profile: context.loaded.profile.name, source, auto: true }),
    ], { cwd: context.top, env: unattendedEnvironment(process.env, log.path), stderr: log.fd });
  } finally {
    closeSync(log.fd);
  }
}

/** The moved remote-tracking refs of the hook's list (each `refs/remotes/<remote>/<branch>`), as remote and branch. */
function movedRefs(refs: string): readonly Readonly<{ ref: string; remote: string; branch: string }>[] {
  return deepFreeze(refs.split(/\s+/u).flatMap((ref) => {
    const match = /^refs\/remotes\/([^/]+)\/(.+)$/u.exec(ref);
    return match === null || match[2] === "HEAD" ? [] : [{ ref, remote: match[1]!, branch: match[2]! }];
  }));
}

/**
 * `harness promote auto --refs <refs>` (see the header) over the repository
 * context; `contextOf` resolves a pair at a source commit; `launch` starts a
 * background run (a test's spy).
 */
export function autoPromotion(
  repository: RepositoryContext,
  contextOf: (profile: string, source: string) => PromotionContext,
  refs: string,
  launch: UnattendedLaunch,
  environment: NodeJS.ProcessEnv = process.env,
): PromotionAnswer {
  const run = ROOT_POLICY.workflow.promotion.runEnvironmentVariable;
  if (environment[run] !== undefined && environment[run] !== "") {
    return answer("promotion_not_due", "the refs moved by a promotion's own fetch or push: nothing to trigger", { refs });
  }
  const started: { profile: string; source: string; pid: number }[] = [];
  const skipped: { profile: string; source: string; reason: string }[] = [];
  const notices: string[] = [];
  for (const moved of movedRefs(refs)) {
    const commit = resolveRevision(repository.repository, moved.ref);
    if (commit === null) continue;
    for (const loaded of repository.profilesAt(commit)) {
      const { profile } = loaded;
      if (profile.trigger !== "on-source-publish" || profile.remote !== moved.remote || branchOf(profile.source.ref) !== moved.branch) continue;
      const context = contextOf(profile.name, commit);
      const last = readLastRun(context.workDirectory);
      if (last?.result !== null && last?.result !== undefined && last.result.class !== "ok") {
        notices.push(`promotion ${profile.name}: ${promotionState(last)} — ${last.result.code} (${last.result.message.split("\n")[0]!}); run: ${ROOT_POLICY.protocol.harnessCommand} promote status --profile ${profile.name}`);
      }
      const target = targetTip(context.repository, profile);
      const reason = target !== null && profileHistory(context.repository, target, profile.name)[0]?.trailers.promotedFrom === commit ? "up to date" : null;
      if (reason !== null) {
        skipped.push({ profile: profile.name, source: commit, reason });
        auditEvent("promotion.trigger", { profile: profile.name, kind: "skipped", source: commit, reason });
        continue;
      }
      const pid = launch(context, commit);
      started.push({ profile: profile.name, source: commit, pid });
      auditEvent("promotion.trigger", { profile: profile.name, kind: "spawned", source: commit, pid });
    }
  }
  const data = { refs, started, skipped, notices };
  return started.length > 0
    ? answer("promotion_triggered", `started ${started.map((entry) => `${entry.profile} for ${entry.source}`).join(", ")} in the background`, data)
    : answer("promotion_not_due", skipped.length > 0 ? `nothing to start: ${skipped.map((entry) => `${entry.profile} ${entry.reason}`).join(", ")}` : "no promotion profile is triggered by these refs", data);
}

/** The endings after which no chain is owed (see the header): a hold (nothing runs until it is released) and a run coalesced into a running one (the holder chains). */
// DELIBERATE SUBSET: 2 of 66 — every other ending (an answer or a refusal) owes the chain; only these two mean another run, or a person, owns the next step.
const UNCHAINED: ReadonlySet<PromotionCode> = new Set<PromotionCode>(["promotion_held", "promotion_locked"]);

/**
 * THE CHAIN (see the header, 4): after `ended`, the remote's source fetched
 * into its remote-tracking ref (the port's run variable: the fetch triggers
 * nothing) and, when it holds a commit the run's S does not contain, the
 * trigger's rules over that tip ({@link autoPromotion}). Answers the trigger's answer, or `null`
 * when no chain is owed. Never throws: a chain that cannot be decided is
 * logged, and the run's own answer stands.
 */
function chainUnattended(
  context: PromotionContext,
  git: WorktreeGitPort,
  ended: PromotionCode,
  contextOf: (profile: string, source: string) => PromotionContext,
  launch: UnattendedLaunch,
): PromotionAnswer | null {
  const { profile } = context.loaded;
  if (profile.remote === null || UNCHAINED.has(ended)) return null;
  const tracking = `refs/remotes/${profile.remote}/${branchOf(profile.source.ref)}`;
  try {
    const fetched = git.fetchRefs(context.top, profile.remote, [`+${profile.source.ref}:${tracking}`], worktreeOperationTimeouts(context.document).fetchMs);
    if (fetched.refusal !== null) {
      debugLog("workflow", "warn", "the promotion chain could not read the remote's source: the next push triggers again", () => ({ profile: profile.name, refusal: fetched.refusal }));
      return null;
    }
    const now = resolveRevision(context.repository, tracking);
    // Only a source the run's S does not already contain is newer (never a tip S carries: a `--no-push` run, a local S ahead of the remote).
    if (now === null || git.isAncestor(context.top, now, context.source, worktreeOperationTimeouts(context.document).inspectMs)) return null;
    auditEvent("promotion.trigger", { profile: profile.name, kind: "chained", source: now, after: context.source, ended });
    return autoPromotion(context, contextOf, tracking, launch, {});
  } catch (error) {
    const failure = promotionErrorOf(error, { profile: profile.name, phase: "chain" });
    debugLog("workflow", "warn", "the promotion chain failed: the next push triggers again", () => ({ profile: profile.name, code: failure.promotionCode, message: failure.message }));
    return null;
  }
}

/**
 * Runs `run` — one `apply`, whatever its placement — and then owes its chain
 * ({@link chainUnattended}): after the run's locks are released and whatever
 * it answered, a refusal included. The answer gains `chained` (the trigger's
 * answer, or `null`); a refusal propagates unchanged. The promoter home's
 * child (`environment` names `engine` as the home's) owes none: its
 * descendants end with it, and its top-level parent chains.
 */
export async function withUnattendedChain(
  context: PromotionContext,
  git: WorktreeGitPort,
  run: () => Promise<PromotionAnswer>,
  contextOf: (profile: string, source: string) => PromotionContext,
  launch: UnattendedLaunch,
  environment: NodeJS.ProcessEnv = process.env,
  engine = runningEngine(),
): Promise<PromotionAnswer> {
  if (isPromoterHomeChild(engine, environment)) return run();
  let result: PromotionAnswer;
  try {
    result = await run();
  } catch (error) {
    chainUnattended(context, git, error instanceof PromotionError ? error.promotionCode : "promotion_unexpected", contextOf, launch);
    throw error;
  }
  const chained = chainUnattended(context, git, result.code, contextOf, launch);
  return answerWith(result, { chained: chained === null ? null : chained.data });
}
