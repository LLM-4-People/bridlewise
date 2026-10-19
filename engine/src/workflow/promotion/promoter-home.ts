/**
 * THE PROMOTER HOME — S's committed code promotes S (merge-door-final §7.2
 * phase 0): a promotion is never run by a writer's dirty tree, nor by an
 * engine older or newer than the source it carries.
 *
 * {@link promoterPlacement} decides where `apply` runs:
 * - HERE when this engine already is S's — the variable
 *   `ROOT_POLICY.workflow.promotion.promoterHomeEnvironmentVariable` names
 *   this engine root (the re-executed child), or the checkout holding this
 *   engine is at S with nothing changed in its index or tracked files; also
 *   when the promoted repository does not host this engine (another
 *   repository's pair, an installed engine): there is no S-side copy of the
 *   promoter to run;
 * - otherwise in the HOME: a detached worktree `promote-<profile>-home` under
 *   the workspace root, moved to S when S moves.
 *
 * {@link runInPromoterHome} holds the home's lock (`promotion-home-<profile>`)
 * across everything it does, so no other run moves the home under a running
 * promoter (a manual run waits for it as `resourceLock` declares; an
 * unattended one never waits: it is coalesced, `promotion_locked`, and the
 * holder's entry chains, `trigger.ts`); prepares the home (the config document's mode, then the setup
 * commands the engine itself needs — those whose declared inputs lie under
 * the engine's folder — re-run when their inputs changed since the LAST
 * SOURCE WHOSE PREPARATION PASSED, recorded in the profile's private area only
 * after its setup passed: all of them when there is none, so a failed or
 * interrupted preparation is redone); and re-executes the same request there
 * through the engine's CLI entry (`<engine>/src/cli.ts harness promote …
 * --source <S>`, the operator's own door), answering the child's envelope.
 * Every failure is typed: a git step's by the landing's rule, the home's
 * setup `promotion_home_setup_failed`/`_errored`, a child that answers no
 * envelope `promotion_promoter_failed`/`_errored`.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { deepFreeze } from "../../kernel/integrity.ts";
import { engineRoot } from "../../kernel/engine-root.ts";
import { ROOT_POLICY } from "../../kernel/root-policy.ts";
import { atomicWriteFile } from "../../filesystem/atomic-write.ts";
import { ensurePrivateStateDirectory, PRIVATE_STATE_FILE_MODE } from "../../filesystem/private-state.ts";
import { resolveRevision } from "../../git/tree-reader.ts";
import { WorktreeGitError, type WorktreeGitPort } from "../../git/worktree-port.ts";
import { auditEvent } from "../../shared/debug/debug-system.ts";
import { superviseCommand } from "../../process/supervised-run.ts";
import { generatedOutputPaths } from "../hash-binding-registry.ts";
import { applyCheckoutFiles, checkoutCommandRunner, engineRelativePath, rerunChangedSetup, type CheckoutCommand, type CheckoutCommandRunner } from "../checkout-setup.ts";
import { landingGitFailure, runLandingPhase } from "../tree-landing.ts";
import { worktreeOperationTimeouts } from "../workflow-config.ts";
import { PromotionError, answerWith, type PromotionAnswer } from "./codes.ts";
import { applyCeilingMs } from "./apply.ts";
import { assertWorkRoot, promotionErrorOf, promotionFolder, withPromotionLock } from "./promotion-run.ts";
import { formatPromoteArguments, type PromotionRequest } from "./promote-arguments.ts";
import type { PromotionContext } from "./context.ts";

/** Where `apply` runs (see the header), and why; `engineRelative` is the engine's path below the top of the checkout holding it (`""` outside one). */
export type PromoterPlacement = Readonly<
  | { kind: "here"; reason: string; engineRelative: string }
  | { kind: "home"; reason: string; home: string; engineRelative: string }
>;

/** The engine a placement is judged for: its root, the entry module (relative to it) a re-execution runs, and the command words before the verb. */
export type PromoterEngine = Readonly<{ root: string; entry: string; command: readonly string[] }>;

/** This engine: its root and its CLI entry, `src/cli.ts harness promote …` (the one door an operator runs; it carries no import cycle). */
export function runningEngine(): PromoterEngine {
  const root = engineRoot();
  return deepFreeze({
    root,
    entry: relative(root, fileURLToPath(new URL("../../cli.ts", import.meta.url))).split(sep).join("/"),
    command: [ROOT_POLICY.protocol.harnessCommand, "promote"],
  });
}

function sameDirectory(a: string, b: string): boolean {
  return existsSync(a) && existsSync(b) && realpathSync(a) === realpathSync(b);
}

/**
 * The checkout holding the engine at `root` — its top, and the engine's path
 * below it — or `null` when git answers that it is in none (an installed
 * engine). A git step the machine ended (a ceiling, a signal) propagates: a
 * busy machine never makes a dirty checkout's promoter run as if installed.
 */
export function engineCheckout(git: WorktreeGitPort, root: string, timeoutMs: number): Readonly<{ top: string; engineRelative: string }> | null {
  let top: string;
  try {
    top = git.toplevel(root, timeoutMs);
  } catch (error) {
    if (error instanceof WorktreeGitError && landingGitFailure(error, "placement")?.failure === "git_failed") return null;
    throw error;
  }
  return deepFreeze({ top, engineRelative: engineRelativePath(top, root) });
}

/** This engine's path below the top of the checkout holding it (`""` for an engine outside a checkout): where a checkout's config document and ledgers live. */
export function engineRelativeIn(git: WorktreeGitPort, timeoutMs: number): string {
  return engineCheckout(git, engineRoot(), timeoutMs)?.engineRelative ?? "";
}

/** Whether this process is a promoter home's re-executed child: the placement variable names `engine` (its descendants end with it, under the supervisor). */
export function isPromoterHomeChild(engine: PromoterEngine = runningEngine(), environment: NodeJS.ProcessEnv = process.env): boolean {
  const named = environment[ROOT_POLICY.workflow.promotion.promoterHomeEnvironmentVariable];
  return named !== undefined && sameDirectory(named, engine.root);
}

/** Where `apply` over `context` runs (see the header). */
export function promoterPlacement(context: PromotionContext, git: WorktreeGitPort, engine: PromoterEngine = runningEngine(), environment: NodeJS.ProcessEnv = process.env): PromoterPlacement {
  const variable = ROOT_POLICY.workflow.promotion.promoterHomeEnvironmentVariable;
  const { inspectMs } = worktreeOperationTimeouts(context.document);
  const checkout = engineCheckout(git, engine.root, inspectMs);
  const here = (reason: string): PromoterPlacement => deepFreeze({ kind: "here", reason, engineRelative: checkout?.engineRelative ?? "" });
  if (isPromoterHomeChild(engine, environment)) return here(`${variable} names this engine (the promoter home)`);
  if (checkout === null) return here("this engine is not in a git checkout: there is no source-side copy to run");
  if (!sameDirectory(git.commonDir(checkout.top, inspectMs), context.registry.commonDir)) {
    return here("this engine belongs to another repository: the promoted one does not host its promoter");
  }
  const head = git.revParse(checkout.top, "HEAD", inspectMs);
  const clean = git.diffNames(checkout.top, "head-to-index", inspectMs).length === 0 && git.diffNames(checkout.top, "index-to-worktree", inspectMs).length === 0;
  if (head === context.source && clean) return here(`the checkout holding this engine is clean at the source ${context.source}`);
  return deepFreeze({
    kind: "home",
    reason: head === context.source ? "the checkout holding this engine has changes: the source's committed promoter runs instead" : `the checkout holding this engine is at ${head}, not the source ${context.source}`,
    home: join(promotionFolder(context), `${context.loaded.profile.name}-home`),
    engineRelative: checkout.engineRelative,
  });
}

/** Whether a setup command builds part of the engine (one of its declared inputs lies under the engine's folder). */
function enginesOwn(engineRelative: string): (name: string, command: CheckoutCommand) => boolean {
  return (_name, command) => (command.inputs ?? []).some((input) => input === engineRelative || input.startsWith(`${engineRelative}/`));
}

/** The record of the home's last PASSED preparation (see the header), in the profile's private promotion area. */
function preparedRecord(context: PromotionContext): string {
  return join(context.workDirectory, "promoter-home.json");
}

/** The last source whose preparation of `home` passed, or `null`: none recorded, recorded for another folder, unreadable, or no longer in the repository. */
function preparedSource(context: PromotionContext, home: string): string | null {
  const path = preparedRecord(context);
  if (!existsSync(path)) return null;
  let record: { home?: unknown; source?: unknown };
  try {
    record = JSON.parse(readFileSync(path, "utf8")) as typeof record;
  } catch (error) {
    // A torn record proves nothing was prepared: everything re-runs.
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  return record.home === home && typeof record.source === "string" ? resolveRevision(context.repository, record.source) : null;
}

/** Makes or moves the home to S and prepares it (see the header); answers the setup steps it ran. */
async function prepareHome(context: PromotionContext, git: WorktreeGitPort, placement: Extract<PromoterPlacement, { kind: "home" }>, runner: CheckoutCommandRunner): Promise<readonly string[]> {
  const timeouts = worktreeOperationTimeouts(context.document);
  const { home } = placement;
  assertWorkRoot(context, home);
  const prepared = preparedSource(context, home);
  git.worktreePrune(context.top, timeouts.inspectMs);
  if (!git.worktreeList(context.top, timeouts.inspectMs).some((entry) => sameDirectory(entry.path, home))) {
    if (existsSync(home)) throw new PromotionError("promotion_work_path_occupied", `${home} exists and is not this repository's promoter home: another checkout sharing the workspace root keeps its home there, or a folder was left there`, { home });
    git.worktreeAddDetached({ repoRoot: context.top, worktreePath: home, commitSha: context.source, timeoutMs: timeouts.worktreeMs });
  } else if (git.revParse(home, "HEAD", timeouts.inspectMs) !== context.source) {
    git.checkoutDetached(home, context.source, timeouts.worktreeMs, true);
  }
  applyCheckoutFiles(home, context.top, placement.engineRelative, { links: [] });
  const everyInput = Object.values(context.isolation.commands).flatMap((command) => command.inputs ?? []);
  const changed = prepared === null
    ? everyInput
    : prepared === context.source ? [] : git.diffNameOnly({ cwd: home, refA: prepared, refB: context.source, threeDot: false, timeoutMs: timeouts.inspectMs });
  const steps = await rerunChangedSetup(context.isolation, changed, checkoutCommandRunner(home, runner), enginesOwn(placement.engineRelative));
  const failed = steps.find((step) => step.status === "fail");
  if (failed !== undefined) {
    throw new PromotionError(failed.failure === "errored" ? "promotion_home_setup_errored" : "promotion_home_setup_failed", `the promoter home ${home} could not be prepared at ${context.source}: ${failed.message}`, { home, step: failed.step, tail: failed.details.join("\n") });
  }
  ensurePrivateStateDirectory(context.workDirectory);
  atomicWriteFile(preparedRecord(context), `${JSON.stringify({ home, source: context.source })}\n`, { requiredMode: PRIVATE_STATE_FILE_MODE });
  return steps.map((step) => `${step.step}: ${step.status}`);
}

/** The promotion answer of the child's stdout (one harness command envelope), or `null` when it holds none. */
function envelopeAnswer(stdout: string): PromotionAnswer | null {
  try {
    const envelope = JSON.parse(stdout) as { result?: PromotionAnswer } | null;
    return envelope?.result !== undefined && typeof envelope.result.code === "string" ? envelope.result : null;
  } catch {
    return null;
  }
}

/** The child's answer, or the typed refusal naming how it ended and its last line (ended by its ceiling or a signal: errored, the machine's; exited without an answer: failed, the source's promoter). */
function childAnswer(stdout: string, run: Readonly<{ ending: string; exitCode: number }>): PromotionAnswer {
  const found = envelopeAnswer(stdout);
  if (found !== null) return found;
  const ended = run.ending === "exited" ? `exit ${String(run.exitCode)}` : `ended: ${run.ending}`;
  throw new PromotionError(run.ending === "exited" ? "promotion_promoter_failed" : "promotion_promoter_errored", `the promoter home's child answered no promotion envelope (${ended}): ${stdout.trim().split("\n").at(-1) || "(no output)"}`, { ended });
}

/**
 * Re-executes `request` in the promoter home over S (see the header), as the
 * pair's own profile with `--source <S>`: the child's answer (its exit code
 * follows from its code's class), naming the home it ran in.
 */
export async function runInPromoterHome(
  context: PromotionContext,
  git: WorktreeGitPort,
  placement: Extract<PromoterPlacement, { kind: "home" }>,
  request: PromotionRequest,
  runner: CheckoutCommandRunner,
  engine: PromoterEngine = runningEngine(),
): Promise<PromotionAnswer> {
  const { profile } = context.loaded;
  return withPromotionLock(context, `home-${profile.name}`, `the promoter home of ${profile.name}`, async () => {
    try {
      return await homeRun(context, git, placement, request, runner, engine);
    } catch (error) {
      // Typed, whatever failed (a git step, the home's generated outputs, the supervisor): never an untyped exit.
      throw promotionErrorOf(error, { home: placement.home });
    }
  }, request.auto !== true);
}

/** {@link runInPromoterHome} under the home's lock: prepare (a landing phase: logged, its git steps typed), then the supervised child. */
async function homeRun(
  context: PromotionContext,
  git: WorktreeGitPort,
  placement: Extract<PromoterPlacement, { kind: "home" }>,
  request: PromotionRequest,
  runner: CheckoutCommandRunner,
  engine: PromoterEngine,
): Promise<PromotionAnswer> {
  const { profile } = context.loaded;
  const facts = { profile: profile.name, source: context.source, home: placement.home };
  const prepared = await runLandingPhase("promoter-home", facts, () => prepareHome(context, git, placement, runner));
  const homeEngine = join(placement.home, placement.engineRelative);
  const variable = ROOT_POLICY.workflow.promotion.promoterHomeEnvironmentVariable;
  auditEvent("promotion.promoterHome", { ...facts, reason: placement.reason, setup: prepared });
  // Under the ONE process owner: the child and everything it starts end with it, at its worst case or on an interrupt.
  const chunks: Buffer[] = [];
  const run = await superviseCommand({
    supervisor: runner.supervisor,
    command: process.execPath,
    args: [join(homeEngine, engine.entry), ...engine.command, ...formatPromoteArguments({ ...request, profile: profile.name, source: context.source })],
    hardCeilingMs: applyCeilingMs(context, runner, generatedOutputPaths(placement.home).size),
    killGraceMs: runner.killGraceMs,
    cwd: context.top,
    env: { ...process.env, [variable]: homeEngine },
    onStdout: (chunk) => chunks.push(chunk),
    onStderr: (chunk) => process.stderr.write(chunk),
    killOnInterrupt: true,
  });
  return answerWith(childAnswer(Buffer.concat(chunks).toString("utf8"), run), { promoterHome: placement.home });
}
