/**
 * THE PROMOTION CONTEXT — what every promotion verb resolves first, the verbs
 * themselves (`status`, `plan`, `explain`: the domain answers them here; the
 * CLI, `promote-cli.ts`, only parses argv and maps the class to an exit code),
 * and the read-only answers the exposure surface serves
 * (`registrations/promotion.ts`, installed by the engine CLI).
 *
 * Two levels, so a question about EVERY pair never needs one pair chosen:
 *
 * - the REPOSITORY context ({@link resolveRepositoryContext}): the
 *   configuration, the repository and the git that answers about it (the
 *   configured executable, each call bounded), its registry, and the
 *   profiles any commit declares — what the signals iterate, one entry per
 *   declared profile;
 * - a PAIR's context ({@link contextFor}): one profile, read from the source
 *   commit S, with S and the target T.
 *
 * WHICH PROFILE, AND WHICH SOURCE (merge-door-final §5.1): `--source <rev>`
 * names S; otherwise the invoking checkout's HEAD names the profile and S is
 * the tip of its source branch; from a checkout of a profile's TARGET (which
 * carries no profile), the target tip's last `Promotion-Profile` trailer names
 * it. The profile that counts is always S's own. T is the local target branch
 * (else its remote-tracking ref).
 *
 * No command door is imported here: the engine bootstrap installs the
 * exposure source without loading the harness command table.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statfsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { deepFreeze } from "../../kernel/integrity.ts";
import { loadPinnedConfigSnapshot } from "../../kernel/config.ts";
import type { ConfigDocument, WorkspaceIsolationConfig } from "../../kernel/config-contracts.ts";
import { ensurePrivateStateDirectory } from "../../filesystem/private-state.ts";
import { configuredGitRepository, configuredWorktreeGitPort, type WorktreeGitPort } from "../../git/worktree-port.ts";
import { commitTreeReader, gitOutput, resolveRevision, type GitRepository } from "../../git/tree-reader.ts";
import { auditEvent, debugLog } from "../../shared/debug/debug-system.ts";
import type { PromotionSource } from "../../shared/exposure/registrations/promotion.ts";
import { qualificationEvidence, diffRunFailures, latestRunOfTree, readRunHistory, suiteLedgerPaths, SUITE_LEDGER_NAMES } from "../../shared/run-history.ts";
import { COMMAND_ENVIRONMENT, projectEnvironment } from "../../process/environment-projection.ts";
import type { JudgedRunRecord } from "../../shared/budget-verdict.ts";
import { commandsRun, configuredCheckoutCommandRunner, type CheckoutCommandRunner } from "../checkout-setup.ts";
import { generatedOutputPaths, pinnedBuildOutputPaths } from "../hash-binding-registry.ts";
import { repositoryRegistryArea, resolveRepositoryRegistry, type RepositoryRegistry } from "../repository-registry.ts";
import { PromotionError, answer, type PromotionAnswer } from "./codes.ts";
import { applyPromotion } from "./apply.ts";
import { promotionErrorOf, promotionFolder, promotionRefs, targetTip, type ApplyRun } from "./promotion-run.ts";
import { promotionState, readLastRun, type LastRun } from "./last-run.ts";
import { localHold } from "./publication.ts";
import { holdPromotion, releaseHold, rollbackPromotion } from "./rollback.ts";
import { autoPromotion, launchUnattendedApply, withUnattendedChain, type UnattendedLaunch } from "./trigger.ts";
import type { PromotionRequest } from "./promote-arguments.ts";
import { engineRelativeIn, promoterPlacement, runInPromoterHome, type PromoterPlacement } from "./promoter-home.ts";
import { branchOf, loadPromotionProfiles, parsePromotionProfile, profileCommandNames, selectPromotionProfile, type LoadedPromotionProfile } from "./profile.ts";
import { classifyTree, explainPaths, planPromotion, projectSource, type PromotionPlan } from "./projection.ts";
import { profileHistory, profileOfTrailer, trailerHistory } from "./trailers.ts";

/** The configuration a promotion reads: the command registry, the profile directory, the git it runs, the runner's retry policy and the lock wait. */
export type PromotionDocument = Pick<ConfigDocument, "workspaceIsolation" | "promotion" | "workspaceGit" | "harness" | "resourceLock">;

/** What every promotion question resolves before any profile is chosen (see the header). */
export type RepositoryContext = Readonly<{
  document: PromotionDocument;
  isolation: WorkspaceIsolationConfig;
  /** `promotion.profileDirectory`: where the profiles live on a source branch. */
  profileDirectory: string;
  /** The checkout's top level. */
  top: string;
  /** The repository as its git answers (the configured executable, each call bounded). */
  repository: GitRepository;
  registry: RepositoryRegistry;
  commandNames: ReadonlySet<string>;
  /** The profiles `commit` declares, parsed and validated. */
  profilesAt(commit: string): readonly LoadedPromotionProfile[];
}>;

/** A pair's context: the repository's, one profile read from S, S and T. */
export type PromotionContext = RepositoryContext & Readonly<{
  loaded: LoadedPromotionProfile;
  source: string;
  target: string | null;
  /** The promotion's private directory for this profile (the registry's promotion area): named here, created only by a plan. */
  workDirectory: string;
}>;

/** The repository context of the checkout at `root` (see the header); `document` defaults to the pinned configuration. */
function resolveRepositoryContext(root: string, document: PromotionDocument = loadPinnedConfigSnapshot().document): RepositoryContext {
  const isolation = document.workspaceIsolation;
  const profileDirectory = document.promotion?.profileDirectory;
  if (isolation === undefined || profileDirectory === undefined) {
    throw new PromotionError("promotion_profile_missing", "the configuration declares no promotion profile directory (`promotion.profileDirectory`) or no command registry (`workspaceIsolation`)");
  }
  const located = configuredGitRepository(document, root);
  const port = configuredWorktreeGitPort(document);
  const top = port.toplevel(root, located.timeoutMs);
  const repository = deepFreeze({ ...located, root: top });
  const commandNames = new Set(Object.keys(isolation.commands));
  return deepFreeze({
    document,
    isolation,
    profileDirectory,
    top,
    repository,
    registry: resolveRepositoryRegistry(port, top, repository.timeoutMs),
    commandNames,
    profilesAt: (commit: string) => loadPromotionProfiles(commitTreeReader(repository, commit), profileDirectory, commandNames),
  });
}

/** From a checkout of a TARGET (no profile at HEAD): the profile its first-parent history's last promotion names (`Promotion-Profile: <name>@<blob>`), or `null`. */
function profileFromTargetTrailer(context: RepositoryContext, head: string | null): LoadedPromotionProfile | null {
  const named = head === null ? null : profileOfTrailer(trailerHistory(context.repository, head, { firstParent: true }).find((line) => line.trailers.profile !== null)?.trailers.profile ?? null);
  if (named === null) return null;
  const path = `${context.profileDirectory}/${named.name}.json`;
  const text = gitOutput(context.repository, ["cat-file", "blob", named.blob]).stdout.toString("utf8");
  return deepFreeze({ profile: parsePromotionProfile(text, { path, profileDirectory: context.profileDirectory, commandNames: context.commandNames }), path, blob: named.blob });
}

/** The profiles the invoking checkout declares: HEAD's, else the one its target trailer names (none: `[]`). */
function declaredProfiles(context: RepositoryContext): readonly LoadedPromotionProfile[] {
  const head = resolveRevision(context.repository, "HEAD");
  const atHead = head === null ? [] : context.profilesAt(head);
  if (atHead.length > 0) return atHead;
  const trailed = profileFromTargetTrailer(context, head);
  return trailed === null ? [] : [trailed];
}

/** A pair's context (see the header); `profileName` and `sourceRev` are the `--profile` and `--source` flags. */
function contextFor(context: RepositoryContext, profileName: string | undefined, sourceRev: string | undefined): PromotionContext {
  let source: string | null;
  let chosen: LoadedPromotionProfile;
  if (sourceRev !== undefined) {
    source = resolveRevision(context.repository, sourceRev);
    if (source === null) throw new PromotionError("promotion_source_missing", `--source ${sourceRev} names no commit`, { source: sourceRev });
    chosen = selectPromotionProfile(context.profilesAt(source), profileName, `${sourceRev}:${context.profileDirectory}`);
  } else {
    const declared = declaredProfiles(context);
    if (declared.length === 0) {
      throw new PromotionError("promotion_profile_missing", `HEAD holds no promotion profile (${context.profileDirectory}/) and its history names none`, { profileDirectory: context.profileDirectory });
    }
    chosen = selectPromotionProfile(declared, profileName, `HEAD:${context.profileDirectory}`);
    source = resolveRevision(context.repository, chosen.profile.source.ref);
    if (source === null) throw new PromotionError("promotion_source_missing", `the source branch ${chosen.profile.source.ref} of profile ${chosen.profile.name} does not exist here`, { source: chosen.profile.source.ref });
    // THE PROFILE THAT COUNTS IS S's OWN (§5.1), never the invoking checkout's.
    chosen = selectPromotionProfile(context.profilesAt(source), chosen.profile.name, `${chosen.profile.source.ref}:${context.profileDirectory}`);
  }
  const { profile } = chosen;
  const target = targetTip(context.repository, profile);
  // Named, not created: only a plan writes there (a read — a signal, status, explain — leaves no state).
  const workDirectory = join(repositoryRegistryArea(context.registry, "promotion"), profile.name);
  return deepFreeze({ ...context, loaded: chosen, source, target, workDirectory });
}

/** {@link contextFor} over {@link resolveRepositoryContext}: one pair, resolved from the checkout at `root`. */
export function resolvePromotionContext(root: string, profileName: string | undefined, sourceRev: string | undefined, document?: PromotionDocument): PromotionContext {
  return contextFor(resolveRepositoryContext(root, document), profileName, sourceRev);
}

function pendingLine(context: PromotionContext, commits: number | null): string {
  return `${context.loaded.profile.name}: ${commits === null ? "no target yet" : `${String(commits)} source commit(s) not yet promoted`}`;
}

/**
 * The first version line of each of `tools` (`<tool> --version`, each bounded
 * by the repository's call ceiling; `null`: it did not answer). A probe gets
 * the command environment's projection (`COMMAND_ENVIRONMENT`: what a tool
 * needs to find itself and its locale, never a credential of this process),
 * like every command the harness runs (PROMO34FIX-TOOL-VERSIONS).
 */
function toolVersions(context: RepositoryContext, tools: Iterable<string>): Readonly<Record<string, string | null>> {
  const env = projectEnvironment(process.env, COMMAND_ENVIRONMENT);
  return deepFreeze(Object.fromEntries([...new Set(tools)].sort().map((tool) => {
    const probe = spawnSync(tool, ["--version"], { encoding: "utf8", env, timeout: context.repository.timeoutMs, killSignal: "SIGKILL" });
    return [tool, probe.status === 0 ? probe.stdout.trim().split("\n")[0]! : null];
  })));
}

/** The versions of the tools a promotion of this pair runs (its registry commands' executables), git's and node's. */
function profileToolchain(context: PromotionContext): Readonly<{ git: string; node: string; tools: Readonly<Record<string, string | null>> }> {
  const { profile } = context.loaded;
  return deepFreeze({
    git: gitOutput(context.repository, ["--version"]).stdout.toString("utf8").trim(),
    node: process.version,
    tools: toolVersions(context, commandsRun(context.isolation.commands, profileCommandNames(profile)).map((name) => context.isolation.commands[name]!.argv[0]!)),
  });
}

/** The source commits not yet on the target, and the age in hours of the oldest (`null` before the target exists). */
function pendingFacts(context: PromotionContext): Readonly<{ commits: number | null; oldestPendingAgeHours: number | null }> {
  if (context.target === null) return deepFreeze({ commits: null, oldestPendingAgeHours: null });
  const times = gitOutput(context.repository, ["log", "--format=%ct", `${context.target}..${context.source}`, "--"]).stdout.toString("utf8").split("\n").filter((line) => line.length > 0).map(Number);
  const oldest = times.length === 0 ? null : Math.min(...times);
  return deepFreeze({ commits: times.length, oldestPendingAgeHours: oldest === null ? null : Math.round((Date.now() / 1000 - oldest) / 360) / 10 });
}

/** Whether the pending source commits change what ships: a projected path the source changed since the last promoted source (the light plan: no command runs). */
function productChanged(context: PromotionContext): boolean | null {
  if (context.target === null) return null;
  const projection = projectSource(context.repository, context.loaded, context.source, context.target);
  if (projection.lastPromoted.source === null) return true;
  const changed = gitOutput(context.repository, ["diff", "--name-only", "-z", "--no-renames", projection.lastPromoted.source, context.source, "--"]).stdout.toString("utf8").split("\0").filter((path) => path.length > 0);
  return changed.some((path) => projection.classification.projected.has(path) || projection.classification.notProjected.get(path)?.rule === undefined);
}

/** The work folder's facts a promotion needs: on the repository's filesystem, and its free bytes. */
function workRootFacts(context: PromotionContext): Readonly<{ folder: string; sameFilesystem: boolean; freeBytes: number | null }> {
  const folder = promotionFolder(context);
  let existing = folder;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  const stats = statfsSync(existing, { bigint: false });
  return deepFreeze({ folder, sameFilesystem: statSync(existing).dev === statSync(context.registry.home).dev, freeBytes: stats.bavail * stats.bsize });
}

/** `harness promote status`: the refs, the last run, the pending commits and the preflight a promotion needs (no plan). */
function promotionStatus(context: PromotionContext): PromotionAnswer {
  const { profile } = context.loaded;
  const refs = promotionRefs(profile.name);
  const last = readLastRun(context.workDirectory);
  const pending = pendingFacts(context);
  const hooksPath = gitOutput(context.repository, ["config", "--get", "core.hooksPath"], { allowed: [0, 1] }).stdout.toString("utf8").trim();
  const data = {
    profile: { name: profile.name, path: context.loaded.path, blob: context.loaded.blob, source: profile.source.ref, target: profile.target.ref, remote: profile.remote, trigger: profile.trigger },
    source: context.source,
    target: context.target,
    pending,
    refs: { pending: resolveRevision(context.repository, refs.pending, "object"), hold: resolveRevision(context.repository, refs.hold, "object") },
    hold: localHold(context),
    state: promotionState(last),
    lastRun: last,
    preflight: { ...profileToolchain(context), workRoot: workRootFacts(context), hooksPath: hooksPath === "" ? null : hooksPath },
  };
  return answer("promotion_status", `${pendingLine(context, pending.commits)}; ${promotionState(last)}`, data);
}

/**
 * The ONE command runner as the configuration declares it (its errored-class
 * retries included). The native supervisor's builder is loaded here, on
 * first use, never by the boot graph (the engine bootstrap imports this
 * module).
 */
async function commandRunner(context: PromotionContext): Promise<CheckoutCommandRunner> {
  const { testProcessSupervisorBinary } = await import("../../../guardian/build.ts");
  return configuredCheckoutCommandRunner(context.document, context.isolation, testProcessSupervisorBinary());
}

/** The lockfile runner of a context: the ONE command runner and the toolchain its lockfile commands run. */
async function lockfileRun(context: PromotionContext) {
  const lockfileTools = context.loaded.profile.transforms.flatMap((transform) => transform.kind === "lockfile" ? [context.isolation.commands[transform.command]!.argv[0]!] : []);
  return deepFreeze({
    runner: await commandRunner(context),
    toolchain: toolVersions(context, lockfileTools),
    workDirectory: ensurePrivateStateDirectory(context.workDirectory),
  });
}

/** This engine's path below the top of the checkout holding it (see {@link engineRelativeIn}). */
function engineRelativeOf(context: RepositoryContext): string {
  return engineRelativeIn(configuredWorktreeGitPort(context.document), context.repository.timeoutMs);
}

/** The newest judged row of `ledger` (by its timestamp) that measured `commit`'s TREE (`latestRunOfTree`: the row names that tree), or `null`. */
function judgedRowAt(repository: GitRepository, ledger: string, commit: string | null): JudgedRunRecord | null {
  const tree = commit === null ? null : resolveRevision(repository, commit, "tree");
  return tree === null ? null : latestRunOfTree(readRunHistory(ledger), tree) ?? null;
}

/**
 * The `source_evidence` advisories (merge-door-final §6.4 #6; never a gate,
 * UD-8): for each suite ledger of the invoking checkout, the newest judged
 * run of S and its failures against the newest of the last promoted source —
 * or `unmeasured`, said so. Each names whose ledger it read (the checkout's
 * top): a ledger is per checkout, so another checkout's runs of S are not
 * seen here.
 */
function sourceEvidence(context: PromotionContext, plan: PromotionPlan): readonly Readonly<{ kind: string; path: string; detail: string }>[] {
  const ledgers = suiteLedgerPaths(engineRelativeOf(context));
  return deepFreeze(SUITE_LEDGER_NAMES.map((suite) => {
    const ledger = join(context.top, ledgers[suite]);
    const whose = `the ledger of ${context.top}`;
    const current = judgedRowAt(context.repository, ledger, plan.source);
    if (current === null) return { kind: "source_evidence", path: ledgers[suite], detail: `${suite}: unmeasured — no judged run of the source ${plan.source} in ${whose}` };
    const baseline = judgedRowAt(context.repository, ledger, plan.lastPromoted.source);
    const failures = `${String(current.failures?.length ?? 0)} failure(s) at the source (run ${current.timestamp ?? "undated"}, ${whose}); ${qualificationEvidence(current)}`;
    if (baseline === null) return { kind: "source_evidence", path: ledgers[suite], detail: `${suite}: ${failures}; the last promoted source ${plan.lastPromoted.source ?? "(none)"} has no judged run in ${whose}, so nothing is compared` };
    const diff = diffRunFailures(baseline, current);
    return {
      kind: "source_evidence",
      path: ledgers[suite],
      detail: diff.verdict === "unmeasured"
        ? `${suite}: ${failures}; against the last promoted source: unmeasured (${diff.reason})`
        : `${suite}: ${failures}; against the last promoted source: ${String(diff.new.length)} new (${diff.new.join(", ") || "none"}), ${String(diff.changed.length)} failing differently, ${String(diff.fixed.length)} fixed`,
    };
  }));
}

/** `harness promote plan` over a resolved context (the lockfiles derived through the ONE command runner; the source's suite evidence advised). */
async function promotionPlan(context: PromotionContext): Promise<PromotionPlan> {
  const planned = await planPromotion({
    repository: context.repository,
    loaded: context.loaded,
    source: context.source,
    target: context.target,
    commands: context.isolation.commands,
    lockfiles: await lockfileRun(context),
    workDirectory: ensurePrivateStateDirectory(context.workDirectory),
  });
  const plan: PromotionPlan = deepFreeze({ ...planned, advisories: [...planned.advisories, ...sourceEvidence(context, planned)] });
  auditEvent("promotion.plan", { profile: plan.profile.name, code: plan.code, source: plan.source, target: plan.target, added: plan.summary.added, modified: plan.summary.modified, deleted: plan.summary.deleted, refusals: plan.refusals.length, advisories: plan.advisories.length, totalMs: plan.timings.totalMs });
  return plan;
}

/** What an apply or a rollback runs with in this process (the placement's engine layout; the plan and the build outputs of this engine). */
function applyRun(context: PromotionContext, git: WorktreeGitPort, runner: CheckoutCommandRunner, engineRelative: string): ApplyRun {
  return deepFreeze({
    git,
    runner,
    generatedOutputs: generatedOutputPaths,
    buildOutputs: pinnedBuildOutputPaths,
    engineRelative,
    toolchain: profileToolchain(context),
    plan: (reconciled: PromotionContext) => promotionPlan(reconciled),
  });
}

/**
 * `harness promote apply` and `rollback` (see `apply.ts`, `rollback.ts`): run
 * by S's own promoter (`promoter-home.ts`) — here when this engine is S's,
 * else re-executed in the promoter home. An `apply` then owes its chain
 * (`trigger.ts` `withUnattendedChain`: latest wins — the top-level process's,
 * never the home's child), once every lock it took is released.
 */
async function promotionBuild(context: PromotionContext, request: PromotionRequest, contextOf: (profile: string, source: string) => PromotionContext, launch: UnattendedLaunch): Promise<PromotionAnswer> {
  const git = configuredWorktreeGitPort(context.document);
  const build = async (): Promise<PromotionAnswer> => {
    const runner = await commandRunner(context);
    let placement: PromoterPlacement;
    try {
      placement = promoterPlacement(context, git);
    } catch (error) {
      throw promotionErrorOf(error, { phase: "placement" });
    }
    debugLog("workflow", "info", `promotion ${request.verb} runs ${placement.kind === "home" ? "in the promoter home" : "here"}`, () => ({ profile: context.loaded.profile.name, source: context.source, ...placement }));
    if (placement.kind === "home") return runInPromoterHome(context, git, placement, request, runner);
    const run = applyRun(context, git, runner, placement.engineRelative);
    if (request.verb === "rollback") return rollbackPromotion(context, { to: request.to!, reason: request.reason! }, run);
    return applyPromotion(context, {
      acceptTargetEdits: request.acceptTargetEdits ?? null,
      allowDeletions: request.allowDeletions === true,
      releaseHold: request.releaseHold === true,
      reason: request.reason ?? null,
      noPublish: request.noPublish === true,
      noPush: request.noPush === true,
      auto: request.auto === true,
    }, run);
  };
  return request.verb === "apply" ? withUnattendedChain(context, git, build, contextOf, launch) : build();
}

/** `harness promote auto --refs <refs>` over the checkout at `root` (see `trigger.ts`); `launch` starts each unattended run (production: in the background). */
export function promotionAuto(root: string, refs: string, document: PromotionDocument | undefined, launch: UnattendedLaunch = launchUnattendedApply, environment: NodeJS.ProcessEnv = process.env): PromotionAnswer {
  const repository = resolveRepositoryContext(root, document);
  return autoPromotion(repository, (profile, source) => contextFor(repository, profile, source), refs, launch, environment);
}

async function verbAnswer(root: string, request: PromotionRequest, document: PromotionDocument | undefined, launch: UnattendedLaunch): Promise<PromotionAnswer> {
  if (request.verb === "auto") return promotionAuto(root, request.refs ?? "", document, launch);
  const repository = resolveRepositoryContext(root, document);
  const context = contextFor(repository, request.profile, request.source);
  if (request.verb === "status") return promotionStatus(context);
  if (request.verb === "apply" || request.verb === "rollback") return promotionBuild(context, request, (profile, source) => contextFor(repository, profile, source), launch);
  if (request.verb === "hold") return holdPromotion(context, request.reason!, { git: configuredWorktreeGitPort(context.document) });
  if (request.verb === "release-hold") return releaseHold(context, request.reason!, { git: configuredWorktreeGitPort(context.document) });
  if (request.verb === "explain") {
    const paths = request.paths ?? [];
    if (paths.length === 0) throw new PromotionError("promotion_usage", "explain needs at least one path");
    const classification = classifyTree(commitTreeReader(context.repository, context.source), context.loaded.profile);
    return answer("promotion_explained", `${String(paths.length)} path(s) explained against ${context.source}`, explainPaths(classification, paths));
  }
  const plan = await promotionPlan(context);
  const wantsDiff = request.diff === true || request.patch === true;
  const diff = context.target === null || !wantsDiff ? null : gitOutput(context.repository, ["diff", "-M", request.patch === true ? "--patch-with-stat" : "--stat", context.target, plan.projection.tree]).stdout.toString("utf8");
  const message = plan.refusals.length > 0
    ? `${String(plan.refusals.length)} refusal(s): ${plan.refusals.map((entry) => entry.code).join(", ")}`
    : `+${String(plan.summary.added)} ~${String(plan.summary.modified)} -${String(plan.summary.deleted)} (derived ${String(plan.summary.derived)}, generated ${String(plan.summary.generated)}); ${plan.next}`;
  return answer(plan.code, message, diff === null ? plan : { ...plan, diff });
}

/**
 * THE VERBS (`harness promote <verb>`, the exposure actions): one answer per
 * request — a refusal is an answer, never a crash — logged once. `launch`
 * starts each unattended run the request owes (the trigger's, an apply's
 * chain; production: in the background).
 */
export async function runPromotionVerb(root: string, request: PromotionRequest, document?: PromotionDocument, launch: UnattendedLaunch = launchUnattendedApply): Promise<PromotionAnswer> {
  const started = Date.now();
  let result: PromotionAnswer;
  try {
    result = await verbAnswer(root, request, document, launch);
  } catch (error) {
    if (!(error instanceof PromotionError)) throw error;
    result = answer(error.promotionCode, error.message, error.facts);
  }
  auditEvent("promotion.verb", { verb: request.verb, profile: request.profile ?? null, source: request.source ?? null, code: result.code, class: result.class, durationMs: Date.now() - started });
  return result;
}

/** One entry per declared profile (see the header): each answered by `compute`, a profile that cannot be answered reading its refusal. */
function perProfile(root: string, document: PromotionDocument | undefined, compute: (context: PromotionContext) => string): string {
  try {
    const repository = resolveRepositoryContext(root, document);
    const declared = declaredProfiles(repository);
    if (declared.length === 0) return `none (${repository.profileDirectory}/ holds no promotion profile at HEAD)`;
    return declared.map(({ profile }) => {
      try {
        return compute(contextFor(repository, profile.name, undefined));
      } catch (error) {
        if (error instanceof PromotionError) return `${profile.name}: ${error.promotionCode}: ${error.message}`;
        throw error;
      }
    }).join(" | ");
  } catch (error) {
    if (error instanceof PromotionError) return `${error.promotionCode}: ${error.message}`;
    throw error;
  }
}

/** When a record was measured (its end, else its start), for a cached row. */
function measuredAt(record: LastRun): string {
  return `measured ${record.endedAt ?? record.startedAt}`;
}

/**
 * The promotion source the engine CLI installs for the exposure surface
 * (`registrations/promotion.ts`): the signals and actions answered over the
 * checkout at `root`. Each signal answers one entry per declared profile; a
 * profile that cannot be answered (no source branch) reads its refusal's
 * words, never a guess, and never hides the others. The state-like rows read
 * the last-run record (a cache) and say when it was measured.
 */
export function enginePromotionSource(root: string, document?: PromotionDocument): PromotionSource {
  const cached = (read: (record: LastRun, name: string) => string) => () => perProfile(root, document, (context) => {
    const record = readLastRun(context.workDirectory);
    return `${context.loaded.profile.name}: ${record === null ? "no run recorded" : `${read(record, context.loaded.profile.name)} (${measuredAt(record)})`}`;
  });
  const verb = (request: PromotionRequest): Promise<PromotionAnswer> => runPromotionVerb(root, request, document);
  const named = (profile: string | undefined): Readonly<{ profile?: string }> => (profile === undefined ? {} : { profile });
  return deepFreeze({
    profiles: () => perProfile(root, document, (context) => {
      const { profile } = context.loaded;
      return `${profile.name}@${context.loaded.blob ?? "working tree"} (${context.loaded.path}): ${branchOf(profile.source.ref)} → ${branchOf(profile.target.ref)} (${profile.trigger}; ${String(profile.boundary.entryPoints.length)} entry points, ${String(profile.boundary.include.length)} includes, ${String(profile.boundary.exclude.length)} excludes)`;
    }),
    state: () => perProfile(root, document, (context) => `${context.loaded.profile.name}: ${promotionState(readLastRun(context.workDirectory))}`),
    lastResult: cached((record) => (record.result === null ? `running ${record.verb} (${record.phase})` : `${record.result.code} (${record.result.class}): ${record.result.message.split("\n")[0]!}`)),
    lastPromoted: () => perProfile(root, document, (context) => {
      const last = context.target === null ? undefined : profileHistory(context.repository, context.target, context.loaded.profile.name)[0];
      if (last === undefined) return `${context.loaded.profile.name}: never promoted`;
      const at = gitOutput(context.repository, ["log", "-1", "--format=%cI", last.commit]).stdout.toString("utf8").trim();
      return `${context.loaded.profile.name}: ${last.commit} ${last.trailers.restores === null ? `carries ${last.trailers.promotedFrom ?? "?"}` : `restores ${last.trailers.restores}`} (${at})`;
    }),
    pending: () => perProfile(root, document, (context) => {
      const facts = pendingFacts(context);
      const changed = productChanged(context);
      return `${pendingLine(context, facts.commits)}${facts.oldestPendingAgeHours === null ? "" : `, the oldest ${String(facts.oldestPendingAgeHours)} h old`}${changed === null ? "" : changed ? ", changing what ships" : ", none changing what ships"}`;
    }),
    held: () => perProfile(root, document, (context) => {
      const hold = localHold(context);
      return `${context.loaded.profile.name}: ${hold === null ? "not held" : `held since ${hold.at} by ${hold.by}${hold.heldSource === null ? "" : ` (source ${hold.heldSource})`}: ${hold.reason}`}`;
    }),
    targetCheckout: cached((record) => (record.targetCheckout === null ? "not landed by its last run" : `${record.targetCheckout.path ?? "no checkout holds the target"}${record.targetCheckout.depsStale.length > 0 ? `; needs ${record.targetCheckout.depsStale.join(", ")} re-run` : ""}${record.targetCheckout.overlap.length > 0 ? `; overlapping edits: ${record.targetCheckout.overlap.join(", ")}` : ""}`)),
    targetEdits: cached((record) => (record.targetEdits.length === 0 ? "none" : `${String(record.targetEdits.length)}: ${record.targetEdits.join(", ")}`)),
    advisories: cached((record) => {
      if (record.advisories.length === 0) return "none";
      const byKind = new Map<string, number>();
      for (const advisory of record.advisories) byKind.set(advisory.kind, (byKind.get(advisory.kind) ?? 0) + 1);
      return [...byKind].map(([kind, count]) => `${String(count)} ${kind}`).join(", ");
    }),
    lastRunDurationMs: cached((record) => String(Object.values(record.durations).reduce((sum, ms) => sum + ms, 0))),
    status: (profile, source) => verb({ verb: "status", ...named(profile), ...(source === undefined ? {} : { source }) }),
    plan: (profile, source) => verb({ verb: "plan", ...named(profile), ...(source === undefined ? {} : { source }) }),
    explain: (paths, profile, source) => verb({ verb: "explain", paths, ...named(profile), ...(source === undefined ? {} : { source }) }),
    apply: (request) => verb({ verb: "apply", ...request }),
    rollback: (to, reason, profile) => verb({ verb: "rollback", to, reason, ...named(profile) }),
    hold: (reason, profile) => verb({ verb: "hold", reason, ...named(profile) }),
    releaseHold: (reason, profile) => verb({ verb: "release-hold", reason, ...named(profile) }),
  });
}
