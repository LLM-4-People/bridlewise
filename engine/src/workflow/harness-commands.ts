import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { atomicWriteFile } from "../filesystem/atomic-write.ts";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import { canonicalJson, deepFreeze, sha256 } from "../kernel/integrity.ts";
import { HarnessError, InputError, extractErrorContext, extractErrorMessage } from "../kernel/errors.ts";
import { loadPinnedConfigSnapshot } from "../kernel/config.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { resignTestSurfaceDispositionManifest } from "../kernel/test-surface-manifest.ts";
import { EXPERIMENT_INCLUDE_ENV_VAR } from "../shared/source-scan.ts";
import { DECISION_INDEX, README_CONSUMER_BLOCK, SHIPPED_HOOK_FILES, VERIFICATION_PATHS } from "../kernel/verification-paths.ts";
import { collectTestResults, readTestExecutionConfig, writeTestResultCollection, type TestResultCollection } from "./test-result-collector.ts";
import { generateModuleRegistrarReport, type ModuleRegistrarReport } from "./module-registrar.ts";
import { currentConfigContractArtifact, generateAutoGeneratorReport, type AutoGeneratorReport } from "./auto-generator.ts";
import {
  generatedOutputPaths,
  repairAllBindings,
  verifyAllBindings,
  type BindingRepairReport,
} from "./hash-binding-registry.ts";
import { configuredLockOptions, lockedResources, withLock, type AcquireLockOptions } from "./resource-lock.ts";
import { harnessFormat } from "./format-command.ts";
import { createMetricsCollector, type MetricsSnapshot } from "../performance/metrics-collector.ts";
import { configuredPerformanceConfig } from "../performance/configured-performance.ts";
import { createTimelineStore } from "../timeline/timeline-store.ts";
import { createRollbackController, type RollbackResult } from "../timeline/rollback.ts";
import { initializeHarnessRuntime } from "../runtime/harness-bootstrap.ts";
import { withRecordingContext } from "../timeline/recording-context.ts";
import { createExtensionManifest } from "../extensions/extension-manifest.ts";
import type { ExtensionManifestEntry } from "../extensions/extension-manifest.ts";
import { commandExitCode, parseHarnessCommandResult, renderCommandAnswer, takeOutputFormat, wrapResult, type CommandAnswer, type CommandOutputFormat, type HarnessCommandResult } from "./command-result.ts";

// Default subprocess timeouts (milliseconds). Used when the corresponding
// config section is absent. These are named constants — not inline literals —
// so the fallback values are discoverable and auditable. The canonical owner
// of these values is the central config contract (`workspaceGit.timeouts` for
// git operations, `harness.typecheckTimeoutMs` for the typecheck step); the
// constants here are only the fallback when config is unavailable. The
// numeric defaults live in `./workflow-config.ts` (the canonical owner for
// workflow operational defaults — no configurables outside
// the config owner).
import { DEFAULT_TYPECHECK_TIMEOUT_MS, DEFAULT_DISPOSITION_AUTO_ADD_TIMEOUT_MS, DEFAULT_SYNC_REGISTER_TIMEOUT_MS, DEFAULT_SYNC_REGENERATE_TIMEOUT_MS, DEFAULT_SYNC_CHECK_TIMEOUT_MS, DEFAULT_SYNC_BUNDLE_TIMEOUT_MS, DEFAULT_TIMELINE_COMMAND_LIMIT, worktreeOperationTimeouts } from "./workflow-config.ts";
import { checkIndexBaseline, indexBaselineDrift, INDEX_RECORD_VERB, recordIndexBaseline, repairIndexToBaseline } from "../git/index-baseline.ts";
import { clearDeclaredDeletions, declareDeletions, declaredDeletionsStatus } from "../git/declared-deletions.ts";
import { EVIDENCE_VERBS, ingestEvidence, materializeEvidence, syncEvidenceIgnore, trackedTop, verifyEvidence } from "./evidence-store.ts";
import { acceptFrozenRecords, frozenRecordsMessage, syncFrozenRecords, type FrozenRecordsReport } from "./record-links.ts";
import { engineAndCheckoutRoots, repositoryToplevel } from "../git/repository-ownership.ts";
import { gitOutput, workingTreeReader } from "../git/tree-reader.ts";
import { configuredGitRepository, configuredWorktreeGitPort } from "../git/worktree-port.ts";
import { repositoryRegistryArea, resolveRepositoryRegistry } from "./repository-registry.ts";
import { convergeBound, convergeUntilStable, unconsumedCommands, type ConvergenceReport } from "./checkout-setup.ts";
import { PromotionError } from "./promotion/codes.ts";
import { loadPromotionProfiles, profileCommandNames, type LoadedPromotionProfile } from "./promotion/profile.ts";
import { journalsUnder } from "../filesystem/journaled-commit.ts";
import { bootstrapProcess, isEntryPoint } from "../runtime/cli-debug.ts";
export { DEFAULT_TYPECHECK_TIMEOUT_MS } from "./workflow-config.ts";
// Sync orchestration bounds. Each sync step runs as its own CLI subprocess so
// it observes file truth (a step's writes must be visible to the next step's
// fresh module imports). The regenerate bound must exceed the sum of the
// inner subprocess budgets (auto-add + test-inventory + registrar scans).

// The defaults below apply only to a key the document leaves undeclared; a
// refused document propagates (kernel/config.ts, config-refusal-propagates).
export function resolveTypecheckTimeoutMs(): number {
  const harnessConfig = loadPinnedConfigSnapshot().document.harness;
  return typeof harnessConfig?.typecheckTimeoutMs === "number"
    ? harnessConfig.typecheckTimeoutMs
    : DEFAULT_TYPECHECK_TIMEOUT_MS;
}

export type HarnessCheckOptions = Readonly<{
  skipTypecheck?: boolean;
  skipArchitecture?: boolean;
  skipInventory?: boolean;
  onProgress?: (message: string) => void;
}>;

export type HarnessTestOptions = Readonly<{
  file?: string;
  all?: boolean;
  writeResults?: boolean;
  onProgress?: (message: string) => void;
}>;

export type CheckStepResult = Readonly<{
  step: string;
  status: "pass" | "fail" | "skip";
  message: string;
  details: unknown;
}>;

export type HarnessCheckOutput = Readonly<{
  typecheck: CheckStepResult;
  architecture: CheckStepResult;
  inventory: CheckStepResult;
  moduleRegistrar: CheckStepResult;
  autoGenerator: CheckStepResult;
  hashBindings: CheckStepResult;
  /** Would `harness regenerate` rewrite the config-contract artifact? (A second sync pass would.) */
  configSchemaArtifact: CheckStepResult;
  /** Would `harness regenerate` re-derive a source-authority pin? */
  pinAuthorities: CheckStepResult;
  /** Would `harness regenerate` prune a ratchet baseline (debt that fell)? */
  ratchetBaselines: CheckStepResult;
  /** Would `harness regenerate` rewrite a README's generated consumer block (the import graph moved)? */
  readmeConsumers: CheckStepResult;
  /** Would `harness regenerate` rewrite the decision index (a decision file's front matter changed)? */
  decisionIndex: CheckStepResult;
  /** Does the checkout's live index still match its recorded baseline (src/git/index-baseline.ts)? */
  liveIndex: CheckStepResult;
  /** Is a multi-file transaction left for recovery (src/filesystem/journaled-commit.ts)? */
  journals: CheckStepResult;
  /** Does every registry command have a consumer (a workspace phase or a promotion profile of this checkout)? */
  deadCommands: CheckStepResult;
  /** Which promotions are in flight (a pending commit, a hold, a promotion lock)? Listed, never failed. */
  promotions: CheckStepResult;
  /** Would `harness regenerate` rewrite a shipped hook (its owner's text changed, or the file was edited by hand)? */
  shippedHooks: CheckStepResult;
  /** Would `harness regenerate` rewrite the ignore file's generated evidence block (a manifest was added, moved or removed)? */
  evidenceIgnore: CheckStepResult;
  /** Does every file under a frozen record root hold the content its pinned manifest records (src/workflow/record-links.ts)? */
  frozenRecords: CheckStepResult;
  allPassed: boolean;
}>;

export type HarnessTestOutput = Readonly<{
  testResults: TestResultCollection;
  resultsPath: string | null;
}>;

export type DispositionAutoAddResult = Readonly<{
  status: "added" | "current" | "skipped";
  addedCount: number;
  addedPaths: readonly string[];
  prunedCount: number;
  prunedPaths: readonly string[];
}>;

export type HarnessRegenerateOutput = Readonly<{
  autoGenerator: AutoGeneratorReport;
  moduleRegistrar: ModuleRegistrarReport;
  hashBindings: BindingRepairReport;
  testInventory: Readonly<{
    status: "current" | "regenerated" | "skipped";
    testCount: number;
    inventoryHash: string;
  }>;
  dispositionAutoAdd: DispositionAutoAddResult;
  dispositionManifest: Readonly<{
    status: "current" | "regenerated";
    integrityHash: string;
  }>;
  /**
   * Config-document schema artifact regeneration (EXP468 finding fix).
   * `harness regenerate` now rewrites `traceability/config-document-schema.json`
   * from the artifact the on-disk root policy declares
   * (`currentConfigContractArtifact`), in canonical-JSON form, so the artifact
   * cannot drift from `src/kernel/config-contracts.ts` after a contract edit,
   * and one pass converges even when this pass re-pinned the contract source.
   */
  schemaArtifact: Readonly<{
    status: "current" | "regenerated";
    schemaHash: string;
    artifactPath: string;
  }>;
  /**
   * Source-authority pin regeneration (the object pins the hash-binding
   * registry cannot carry). `harness regenerate` re-derives the handoff
   * semantic-owner pins, the planned-node-test source pins, and the handoff
   * manifest projection from the CURRENT tree bytes, so a source move converges
   * in one command instead of a hand-edit.
   */
  pinAuthorities: Readonly<{
    status: "current" | "regenerated";
    converged: boolean;
  }>;
  /**
   * The shrink-only ratchet baselines (a2b-design H2): each is pruned against
   * its guard's scan (`scripts/verification/ratchet-baselines.ts`) — an entry
   * no finding matches is removed; a key is never added.
   */
  ratchetBaselines: RatchetBaselinesArm;
  /**
   * The README consumer blocks (`README_CONSUMER_BLOCK`): every marked
   * README's block re-projected from the import graph, so a moved import
   * never leaves a writer to run the generator by hand (WF-DEL leftover).
   */
  readmeConsumers: ReadmeConsumersArm;
  /**
   * The decision index (`docs/decisions/README.md`), generated from the
   * decision files' front matter (`scripts/verification/decision-index.ts`),
   * so a state flip in a decision never leaves its index row lying.
   */
  decisionIndex: DecisionIndexArm;
  /**
   * The shipped hooks (`SHIPPED_HOOK_FILES`): every canonical hook's whole
   * text, written by its generator (`scripts/verification/shipped-hooks.ts`)
   * from its owner, never by hand (PROMO34FIX-HOOK-GENERATOR).
   */
  shippedHooks: DecisionIndexArm;
  /**
   * The ignore file's evidence block (`ROOT_POLICY.workflow.evidenceStore.ignoreBlock`),
   * derived from the tracked evidence manifests (src/workflow/evidence-store.ts),
   * so the folder materialize writes into is ignored by construction.
   */
  evidenceIgnore: DecisionIndexArm;
  /** The frozen record roots' pinned content (`ROOT_POLICY.verification.frozenRecordManifest`, src/workflow/record-links.ts). */
  frozenRecords: DecisionIndexArm;
}>;

/** What a whole-file or block generator arm did (the decision index, the shipped hooks): `changed` is what a write rewrote, or what a check found stale. */
export type DecisionIndexArm = Readonly<{
  status: "current" | "regenerated" | "stale" | "absent";
  converged: boolean;
  changed: readonly string[];
}>;

/** What the README consumer arm did: `changed` is what a write rewrote, or what a check found stale. */
export type ReadmeConsumersArm = Readonly<{
  status: "current" | "regenerated" | "stale" | "absent";
  converged: boolean;
  readmes: number;
  changed: readonly string[];
}>;

/**
 * What the ratchet-baseline arm did: per baseline, its status, the stale keys
 * (a check reports them as drift) and the unbaselined ones (new debt: a check
 * fails on them, a write never adds them).
 */
export type RatchetBaselinesArm = Readonly<{
  status: "current" | "regenerated";
  converged: boolean;
  results: readonly Readonly<{ id: string; path: string; status: string; stale: readonly string[]; unbaselined: readonly string[] }>[];
}>;

export type HarnessSyncStepSummary = Readonly<{
  step: "bundle-build" | "register" | "regenerate" | "check";
  status: "pass" | "fail";
}>;

export type HarnessSyncOutput = Readonly<{
  /** The steps of the LAST pass (see `convergence` for every pass). */
  steps: readonly HarnessSyncStepSummary[];
  bundleBuild?: HarnessCommandResult;
  regenerateInitial?: HarnessCommandResult;
  register: HarnessCommandResult;
  regenerate: HarnessCommandResult;
  check: HarnessCommandResult;
  allPassed: boolean;
  convergence: ConvergenceReport;
}>;

export type HarnessNewModuleOutput = Readonly<{
  modulePath: string;
  created: boolean;
  registered: boolean;
  registrarReport: ModuleRegistrarReport;
}>;

export type HarnessRegisterOutput = Readonly<{
  registrarReport: ModuleRegistrarReport;
}>;

export type HarnessFormatOutput = Readonly<{
  scanned: number;
  fixed: number;
  write: boolean;
  changedFiles: readonly string[];
}>;

/**
 * `harness check`'s ratchet step: it fails when a baseline holds debt that
 * fell (sync prunes it) AND when any guard finds debt its baseline does not
 * hold — a NEW dead link, a new unhandled catch — naming each key: the check
 * is the gate every commit and every workspace validate runs, so new debt is
 * refused there, not only in its guard's suite.
 */
export function ratchetBaselinesStep(ratchetBaselines: RatchetBaselinesArm): CheckStepResult {
  const newDebt = ratchetBaselines.results.flatMap((result) => result.unbaselined.map((key) => `${result.id}: ${key}`));
  return deepFreeze({
    step: "ratchet-baselines",
    status: ratchetBaselines.converged && newDebt.length === 0 ? "pass" : "fail",
    message: [
      ...(ratchetBaselines.converged ? [] : [`ratchet baselines hold debt that fell (run harness sync to prune): ${ratchetBaselines.results.flatMap((result) => result.stale.map((key) => `${result.path}: ${key}`)).join("; ")}`]),
      ...(newDebt.length === 0 ? [] : [`new debt no ratchet baseline accepts (fix each site; a baseline never takes a new entry): ${newDebt.join("; ")}`]),
    ].join(" | ") || "no ratchet baseline holds an entry its guard no longer finds, and no guard finds debt its baseline does not hold",
    details: ratchetBaselines,
  });
}

export async function harnessCheck(
  root: string,
  options: HarnessCheckOptions = {},
): Promise<HarnessCommandResult<HarnessCheckOutput>> {
  const onProgress = options.onProgress;
  const steps: CheckStepResult[] = [];

  emitProgress(onProgress, options.skipTypecheck ? "Skipping typecheck..." : "Running typecheck...");
  const typecheck = options.skipTypecheck ? skipStep("typecheck") : await runTypecheck(root);
  steps.push(typecheck);

  emitProgress(onProgress, options.skipArchitecture ? "Skipping architecture check..." : "Checking architecture...");
  const architecture = options.skipArchitecture ? skipStep("architecture") : runArchitectureCheck(root);
  steps.push(architecture);

  emitProgress(onProgress, options.skipInventory ? "Skipping inventory check..." : "Checking inventory...");
  const inventory = options.skipInventory ? skipStep("inventory") : runInventoryCheck(root);
  steps.push(inventory);

  emitProgress(onProgress, "Checking module registrar...");
  const moduleRegistrarReport = generateModuleRegistrarReport(root);
  steps.push(deepFreeze({
    step: "module-registrar",
    status: registrarInSync(moduleRegistrarReport) ? "pass" : "fail",
    message: registrarInSync(moduleRegistrarReport)
      ? "all modules registered and no drift"
      : registrarDriftMessage(moduleRegistrarReport),
    details: moduleRegistrarReport,
  }));

  emitProgress(onProgress, "Checking auto-generator...");
  const autoGeneratorReport = generateAutoGeneratorReport(root);
  steps.push(deepFreeze({
    step: "auto-generator",
    status: autoGeneratorReport.allMatch ? "pass" : "fail",
    message: autoGeneratorReport.allMatch ? "all bindings match" : "some bindings have drifted",
    details: autoGeneratorReport,
  }));

  emitProgress(onProgress, "Checking hash bindings...");
  const hashBindingsReport = verifyAllBindings(root);
  const hashBindingsStatus: "pass" | "fail" = hashBindingsReport.errors > 0 || !hashBindingsReport.allMatch ? "fail" : "pass";
  steps.push(deepFreeze({
    step: "hash-bindings",
    status: hashBindingsStatus,
    message: hashBindingsReport.allMatch
      ? `all ${hashBindingsReport.totalBindings} hash bindings match`
      : `${hashBindingsReport.mismatched} of ${hashBindingsReport.totalBindings} hash bindings drifted${hashBindingsReport.errors > 0 ? `, ${hashBindingsReport.errors} errors` : ""}`,
    details: hashBindingsReport,
  }));

  // CONVERGENCE: every output `harness regenerate` writes must already be what
  // it would write, or a sync that "passed" still leaves a second pass work to
  // do. The bindings, inventory, registrar and auto-generator steps above cover
  // their outputs; these two cover the rest, read-only.
  emitProgress(onProgress, "Checking config schema artifact...");
  const schemaArtifact = regenerateConfigSchemaArtifact(root, false);
  steps.push(deepFreeze({
    step: "config-schema-artifact",
    status: schemaArtifact.status === "current" ? "pass" : "fail",
    message: schemaArtifact.status === "current"
      ? "config schema artifact matches the on-disk root policy"
      : "config schema artifact is stale against the on-disk root policy (run harness sync)",
    details: schemaArtifact,
  }));

  emitProgress(onProgress, "Checking pin authorities...");
  const pinAuthorities = regeneratePinAuthorities(root, false);
  steps.push(deepFreeze({
    step: "pin-authorities",
    status: pinAuthorities.converged ? "pass" : "fail",
    message: pinAuthorities.converged ? "all source-authority pins are current" : "source-authority pins have drifted (run harness sync)",
    details: pinAuthorities,
  }));

  // A ratchet's NEW debt (a finding its baseline does not hold) fails here
  // too, not only in its guard's suite: the check is the gate every commit
  // and every workspace validate runs, and the scans already ran for the
  // stale half (a dead Markdown link is caught before any suite runs).
  emitProgress(onProgress, "Checking the ratchet baselines...");
  steps.push(ratchetBaselinesStep(regenerateRatchetBaselines(root, false)));

  emitProgress(onProgress, "Checking the README consumer blocks...");
  const readmeConsumers = regenerateReadmeConsumers(root, false);
  steps.push(deepFreeze({
    step: "readme-consumers",
    status: readmeConsumers.converged ? "pass" : "fail",
    message: readmeConsumers.converged
      ? `every generated README consumer block matches the import graph (${String(readmeConsumers.readmes)} README(s)${readmeConsumers.status === "absent" ? "; this tree carries no generator" : ""})`
      : `README consumer blocks are stale against the import graph (run harness sync): ${readmeConsumers.changed.join(", ")}`,
    details: readmeConsumers,
  }));

  emitProgress(onProgress, "Checking the decision index...");
  const decisionIndex = regenerateDecisionIndex(root, false);
  steps.push(deepFreeze({
    step: "decision-index",
    status: decisionIndex.converged ? "pass" : "fail",
    message: decisionIndex.converged
      ? `the decision index matches the decision files${decisionIndex.status === "absent" ? " (this tree carries no decisions)" : ""}`
      : `the decision index is stale against the decision files (run harness sync): ${decisionIndex.changed.join(", ")}`,
    details: decisionIndex,
  }));

  emitProgress(onProgress, "Checking the live index against its baseline...");
  steps.push(liveIndexStep(root));

  emitProgress(onProgress, "Checking for transactions left to recover...");
  steps.push(journalsStep(root));

  emitProgress(onProgress, "Checking that every registry command has a consumer...");
  steps.push(deadCommandsStep(root));

  emitProgress(onProgress, "Listing the promotions in flight...");
  steps.push(promotionsStep(root));

  emitProgress(onProgress, "Checking the shipped hooks...");
  const shippedHooks = regenerateShippedHooks(root, false);
  steps.push(deepFreeze({
    step: "shipped-hooks",
    status: shippedHooks.converged ? "pass" : "fail",
    message: shippedHooks.converged
      ? `every shipped hook is its owner's text${shippedHooks.status === "absent" ? " (this tree ships no hooks)" : ""}`
      : `shipped hooks differ from their owners' text (run harness sync): ${shippedHooks.changed.join(", ")}`,
    details: shippedHooks,
  }));

  emitProgress(onProgress, "Checking the evidence ignore rule...");
  steps.push(evidenceIgnoreStep(regenerateEvidenceIgnore(root, false)));

  emitProgress(onProgress, "Checking the frozen record roots' pinned content...");
  steps.push(frozenRecordsStep(syncFrozenRecords(trackedTop(root), false)));

  const allPassed = steps.every((step) => step.status !== "fail");
  const output: HarnessCheckOutput = deepFreeze({
    typecheck: steps[0]!,
    architecture: steps[1]!,
    inventory: steps[2]!,
    moduleRegistrar: steps[3]!,
    autoGenerator: steps[4]!,
    hashBindings: steps[5]!,
    configSchemaArtifact: steps[6]!,
    pinAuthorities: steps[7]!,
    ratchetBaselines: steps[8]!,
    readmeConsumers: steps[9]!,
    decisionIndex: steps[10]!,
    liveIndex: steps[11]!,
    journals: steps[12]!,
    deadCommands: steps[13]!,
    promotions: steps[14]!,
    shippedHooks: steps[15]!,
    evidenceIgnore: steps[16]!,
    frozenRecords: steps[17]!,
    allPassed,
  });
  return wrapResult("check", output);
}

/**
 * The live index against its recorded baseline: a checkout that never
 * recorded one (a candidate, a fresh clone) passes; a lost protected blob
 * fails with the one repair. A HEAD that moved with nothing lost advances the
 * record (src/git/index-baseline.ts), so an ordinary commit never reds this.
 */
function liveIndexStep(root: string): CheckStepResult {
  if (repositoryToplevel(root, "inherited") === undefined) return skipStep("live-index");
  const drift = checkIndexBaseline(root);
  return deepFreeze({
    step: "live-index",
    status: drift.state === "drifted" ? "fail" : "pass",
    message: drift.state === "drifted"
      ? `staged blobs of the index baseline are no longer staged and no commit took their place: ${JSON.stringify(drift.lost)}; restore them with: ${drift.repair.join(" ")} (or, if deliberate: ${INDEX_RECORD_VERB.join(" ")})`
      : drift.state === "clean" ? `the live index holds every protected staged blob of its baseline (${String(drift.protected)} protected${drift.advanced === true ? ", advanced after HEAD moved" : ""})` : "no index baseline is recorded in this checkout",
    details: drift,
  });
}

/**
 * `harness index status|record|repair` — the live index baseline's operator
 * surface (src/git/index-baseline.ts). `status` is a READ: it never advances
 * the record or moves its pin (`headMoved` says an advance is due).
 */
export function harnessIndex(root: string, argv: readonly string[]): HarnessCommandResult {
  const [verb, ...extra] = argv;
  if (extra.length > 0) throw unknownFlag(`index ${verb ?? ""}`.trim(), extra[0]!, []);
  if (verb === "status") {
    const state = indexBaselineDrift(root);
    return wrapResult("index", state, { status: state.state === "drifted" ? "fail" : "pass" });
  }
  if (verb === "record") return wrapResult("index", recordIndexBaseline(root), { status: "pass" });
  if (verb === "repair") return wrapResult("index", repairIndexToBaseline(root), { status: "pass" });
  throw new InputError(`unknown index subcommand: ${verb ?? "(none)"} (supported: ${INDEX_VERBS.join(", ")})`, "command_unavailable");
}

/** The verbs of `harness index`. */
const INDEX_VERBS = deepFreeze(["status", "record", "repair"] as const);

/**
 * `harness deletions declare [--paths-file <file>] [--paths-file-nul <file>]
 * [--] <path>… | status | clear`: the declared-deletion primitive's operator
 * surface (src/git/declared-deletions.ts). Paths are repository-relative, as
 * git prints them from the top, whatever the current folder. `status` fails
 * when a declaration is stale, mismatched or expired (it will be refused,
 * never used).
 */
export function harnessDeletions(root: string, argv: readonly string[]): HarnessCommandResult {
  const [verb, ...rest] = argv;
  if (verb === "declare") return wrapResult("deletions", declareDeletions(root, declarationPaths(rest)), { status: "pass" });
  if (rest.length > 0) throw unknownFlag(`deletions ${verb ?? ""}`.trim(), rest[0]!, []);
  if (verb === "status") {
    const status = declaredDeletionsStatus(root);
    return wrapResult("deletions", status, { status: status.declarations.some((entry) => entry.state !== "pending") ? "fail" : "pass" });
  }
  if (verb === "clear") return wrapResult("deletions", clearDeclaredDeletions(root), { status: "pass" });
  throw new InputError(`unknown deletions subcommand: ${verb ?? "(none)"} (supported: ${DELETIONS_VERBS.join(", ")})`, "command_unavailable");
}

/** The verbs of `harness deletions`. */
const DELETIONS_VERBS = deepFreeze(["declare", "status", "clear"] as const);

/**
 * `harness frozen accept --reason <why> [--paths-file <file>] [--] <path>…`:
 * the ONE door that re-pins an edited or removed frozen record
 * (src/workflow/record-links.ts `acceptFrozenRecords`), with its reason in the
 * manifest. `harness sync` never does.
 */
function harnessFrozen(root: string, argv: readonly string[]): HarnessCommandResult {
  const [verb, ...rest] = argv;
  if (verb !== "accept") throw new InputError(`unknown frozen subcommand: ${verb ?? "(none)"} (supported: accept)`, "command_unavailable");
  const reasonAt = rest.indexOf("--reason");
  const reason = reasonAt < 0 ? undefined : rest[reasonAt + 1];
  if (reason === undefined || reason.startsWith("--")) throw new InputError("harness frozen accept needs --reason <why>", "frozen_accept_reason_missing");
  const paths = pathArguments([...rest.slice(0, reasonAt), ...rest.slice(reasonAt + 2)], "frozen accept", "frozen_accept_usage");
  const report = acceptFrozenRecords(trackedTop(root), paths, reason);
  return wrapResult("frozen", report, { status: report.converged ? "pass" : "fail" });
}

/**
 * `harness evidence ingest --manifest <file> <path>… | verify [--manifest
 * <file>]… | materialize <path>…`: the evidence store's operator surface
 * (src/workflow/evidence-store.ts). Paths and manifests are
 * repository-relative, whatever the current folder; path lists take
 * `--paths-file[-nul]` and `--` like `deletions declare`. `verify` fails when
 * any recorded object is missing, corrupt or readable by other users.
 */
export function harnessEvidence(root: string, argv: readonly string[]): HarnessCommandResult {
  const [verb, ...rest] = argv;
  const top = trackedTop(root);
  const { manifests, others } = manifestFlags(rest, verb ?? "");
  if (verb === "ingest") {
    if (manifests.length !== 1) throw new InputError("evidence ingest records into exactly one manifest: --manifest <repository path>", "evidence_usage");
    return wrapResult("evidence", ingestEvidence(top, pathArguments(others, "evidence ingest", "evidence_usage"), manifests[0]!), { status: "pass" });
  }
  if (verb === "verify") {
    if (others.length > 0) throw unknownFlag("evidence verify", others[0]!, ["--manifest <file>"]);
    const report = manifests.length === 0 ? verifyEvidence(top) : verifyEvidence(top, manifests);
    return wrapResult("evidence", report, { status: report.allPresent ? "pass" : "fail" });
  }
  if (verb === "materialize") {
    if (manifests.length > 0) throw unknownFlag("evidence materialize", "--manifest", ["--paths-file <file>", "--paths-file-nul <file>", "--"]);
    return wrapResult("evidence", materializeEvidence(top, pathArguments(others, "evidence materialize", "evidence_usage")), { status: "pass" });
  }
  throw new InputError(`unknown evidence subcommand: ${verb ?? "(none)"} (supported: ${EVIDENCE_VERBS.join(", ")})`, "command_unavailable");
}

/** The `--manifest <file>` values before any `--`, and every other argument (in order). */
function manifestFlags(argv: readonly string[], verb: string): Readonly<{ manifests: readonly string[]; others: readonly string[] }> {
  const manifests: string[] = [];
  const others: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--") {
      others.push(...argv.slice(index));
      break;
    }
    if (argument !== "--manifest") {
      others.push(argument);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) throw new InputError(`evidence ${verb}: --manifest needs a repository path`, "evidence_usage");
    manifests.push(value);
    index += 1;
  }
  return { manifests, others };
}

/** Each paths-file flag of `declare`, with the separator that ends one path in it. */
const PATHS_FILE_FLAGS: Readonly<Record<string, string>> = Object.freeze({ "--paths-file": "\n", "--paths-file-nul": "\0" });

/**
 * `declare`'s paths, each taken literally: every argument, every line of each
 * `--paths-file <file>` and every NUL-ended entry of each
 * `--paths-file-nul <file>` (`git diff -z --name-only` writes one: no path is
 * ever quoted), read from the current folder; a final separator ends the last
 * path, and an empty file holds none. After `--`, every argument is a path,
 * even one that begins with `--`. Nothing is expanded.
 */
export function declarationPaths(argv: readonly string[]): readonly string[] {
  return pathArguments(argv, "deletions declare", "declared_deletion_usage");
}

/**
 * THE ONE PATH-LIST PARSE of the verbs that take literal repository paths
 * (`deletions declare`, `evidence ingest|materialize`): every argument, every
 * entry of each `--paths-file[-nul] <file>`, everything after `--`; any other
 * flag is refused as unknown to `verb`.
 */
function pathArguments(argv: readonly string[], verb: string, usageCode: string): readonly string[] {
  const paths: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const separator = PATHS_FILE_FLAGS[argument];
    if (argument === "--") {
      paths.push(...argv.slice(index + 1));
      break;
    } else if (separator !== undefined) {
      const file = argv[index + 1];
      if (file === undefined) throw new InputError(`${argument} needs a file: one repository-relative path per entry`, usageCode);
      const text = readFileSync(resolve(file), "utf8");
      if (text.length > 0) paths.push(...(text.endsWith(separator) ? text.slice(0, -1) : text).split(separator));
      index += 1;
    } else if (argument.startsWith("--")) {
      throw unknownFlag(verb, argument, [...Object.keys(PATHS_FILE_FLAGS), "--"]);
    } else {
      paths.push(argument);
    }
  }
  return paths;
}

/**
 * DEAD COMMANDS: a registry command (`workspaceIsolation.commands`) that no
 * workspace phase and no promotion profile of this checkout runs is dead
 * config (`unconsumedCommands`). The configuration schema cannot judge it — a
 * profile is a data file on the source branch — so it is judged here, at
 * every check, where both consumers are visible: the profiles the working
 * tree declares (an invalid one fails the step). A checkout that declares a
 * profile directory but holds no profile (a product checkout: profiles never
 * ship) cannot see every consumer, so it is not judged there.
 */
function deadCommandsStep(root: string): CheckStepResult {
  const top = repositoryToplevel(root, "inherited");
  const { document } = loadPinnedConfigSnapshot();
  const isolation = document.workspaceIsolation;
  if (top === undefined || isolation === undefined) return skipStep("dead-commands");
  const directory = document.promotion?.profileDirectory;
  let consumers: readonly string[] = [];
  if (directory !== undefined) {
    let profiles: readonly LoadedPromotionProfile[];
    try {
      profiles = loadPromotionProfiles(workingTreeReader(top), directory, new Set(Object.keys(isolation.commands)));
    } catch (error) {
      if (!(error instanceof PromotionError)) throw error;
      return deepFreeze({ step: "dead-commands", status: "fail", message: `${error.promotionCode}: ${error.message}`, details: error.facts });
    }
    if (profiles.length === 0) return deepFreeze({ step: "dead-commands", status: "pass", message: `not judged: ${directory}/ holds no promotion profile here, so not every consumer of the registry is visible`, details: null });
    consumers = profiles.flatMap((loaded) => profileCommandNames(loaded.profile));
  }
  const dead = unconsumedCommands(isolation, consumers);
  return deepFreeze({
    step: "dead-commands",
    status: dead.length === 0 ? "pass" : "fail",
    message: dead.length === 0
      ? `every registry command is run by a workspace phase or a promotion profile (${String(Object.keys(isolation.commands).length)} commands)`
      : `registry commands no workspace phase and no promotion profile runs (dead config: remove them, or run them): ${dead.join(", ")}`,
    details: { dead },
  });
}

/**
 * The promotions in flight in the repository (merge-door-final §14): each
 * profile's pending commit and hold (refs under
 * `ROOT_POLICY.workflow.promotion.refNamespace`) and the promotion locks in
 * the registry. LISTED, never failed: a promotion may be running now, and a
 * hold is a decision, not a defect. A git or registry read that fails is
 * SAID (the step is skipped, naming the failure), never a crash of the whole
 * check (PROMO34FIX-CHECK-STEP); a refused configuration still propagates.
 */
export function promotionsStep(root: string): CheckStepResult {
  const top = repositoryToplevel(root, "inherited");
  if (top === undefined) return skipStep("promotions");
  const { document } = loadPinnedConfigSnapshot();
  const { refNamespace } = ROOT_POLICY.workflow.promotion;
  let refs: readonly string[];
  let held: readonly string[];
  try {
    refs = gitOutput(configuredGitRepository(document, top), ["for-each-ref", "--format=%(refname) %(objectname)", `${refNamespace}/`]).stdout.toString("utf8")
      .split("\n").filter((line) => /\/(?:pending|hold) [0-9a-f]+$/u.test(line));
    const locks = repositoryRegistryArea(resolveRepositoryRegistry(configuredWorktreeGitPort(document), top, worktreeOperationTimeouts(document).inspectMs), "locks");
    held = lockedResources(locks, "promotion-");
  } catch (error) {
    const code = error instanceof HarnessError ? error.code : (error as { code?: unknown } | null)?.code;
    return deepFreeze({
      step: "promotions",
      status: "skip",
      message: `the promotions in flight could not be listed: ${extractErrorMessage(error)}`,
      details: { error: typeof code === "string" ? code : "promotions_unreadable" },
    });
  }
  return deepFreeze({
    step: "promotions",
    status: "pass",
    message: refs.length === 0 && held.length === 0 ? "no promotion is in flight (no pending commit, hold or promotion lock)" : `in flight: ${[...refs, ...held.map((name) => `lock ${name}`)].join(", ")}`,
    details: { refs, locks: held },
  });
}

/**
 * Journals under the engine root and the checkout's top level: an ABANDONED
 * or unreadable one fails (a crash left files for recovery); one whose owner
 * is running is reported, not failed (a copy-back runs this very check).
 */
function journalsStep(root: string): CheckStepResult {
  const journals = engineAndCheckoutRoots(root).flatMap((journalRoot) => journalsUnder(journalRoot).map((journal) => ({ root: journalRoot, ...journal })));
  const stuck = journals.filter((journal) => journal.state !== "in-progress");
  return deepFreeze({
    step: "journals",
    status: stuck.length > 0 ? "fail" : "pass",
    message: stuck.length > 0
      ? `transactions left for recovery: ${stuck.map((journal) => `${journal.root} ${journal.name} (${journal.state})`).join(", ")} — the next run of the owning tool recovers an abandoned one`
      : journals.length > 0 ? `in progress: ${journals.map((journal) => journal.name).join(", ")}` : "no transaction is left for recovery",
    details: journals,
  });
}

export async function harnessTest(
  root: string,
  options: HarnessTestOptions = {},
): Promise<HarnessCommandResult<HarnessTestOutput>> {
  emitProgress(
    options.onProgress,
    options.file !== undefined ? `Running test file: ${options.file}...` : "Running all tests...",
  );
  const files = options.file !== undefined ? [options.file] : undefined;
  const useLock = options.file === undefined;
  const collect = async (): Promise<HarnessTestOutput> => {
    const testExecutionConfig = readTestExecutionConfig(root);
    const testResults = await collectTestResults(root, {
      ...(files !== undefined ? { files } : {}),
      // A full-suite `harness test` is bound to the pinned test inventory so a
      // stale inventory, a dynamically-disappearing test, or an un-inventoried
      // file fails the command instead of passing silently. Single-file runs
      // intentionally run unbound.
      ...(files === undefined ? { inventoryBinding: true } : {}),
      ...(testExecutionConfig.concurrency !== undefined ? { concurrency: testExecutionConfig.concurrency } : {}),
      ...(testExecutionConfig.parallelConcurrency !== undefined ? { parallelConcurrency: testExecutionConfig.parallelConcurrency } : {}),
      ...(testExecutionConfig.serialPhaseConcurrency !== undefined ? { serialPhaseConcurrency: testExecutionConfig.serialPhaseConcurrency } : {}),
    });
    let resultsPath: string | null = null;
    if (options.writeResults !== false) {
      resultsPath = writeTestResultCollection(testResults, root);
    }
    return deepFreeze({ testResults, resultsPath });
  };
  const output = useLock
    ? await withLock(root, "test", collect, resolveLockOptions("harness-test"))
    : await collect();
  return wrapResult("test", output);
}

export function harnessRegenerate(
  root: string,
  options: Readonly<{ write?: boolean; prune?: readonly string[] }> = {},
): HarnessCommandResult<HarnessRegenerateOutput> {
  const write = options.write ?? false;
  // Recompute the dispositions manifest integrity hash FIRST: when entries
  // are added or edited manually the `integrityHash` field goes stale, and
  // the strict manifest parse in the auto-add step below refuses a
  // stale-hash manifest. Healing the hash first keeps manual edits
  // recoverable through `harness regenerate` alone.
  const dispositionManifest = recomputeDispositionManifestIntegrityHash(root, write);
  // Auto-add missing disposition entries for recognizable test files so
  // agents never have to register new test files manually. This runs as a
  // subprocess (scripts/run-tests.ts --auto-add-dispositions) to keep the
  // builder-layer test-surface modules out of the runtime import graph —
  // the same pattern as regenerateTestInventory below. Read-only mode never
  // mutates the manifest, so the step is skipped there.
  const dispositionAutoAdd = autoAddDispositionEntries(root, write, options.prune ?? []);
  // Repair hash bindings so the disposition binding is current before the
  // test-inventory generation validates it. Then regenerate the test
  // inventory (which atomically writes the inventory file AND updates the
  // root-policy inventory-hash pin). Then repair bindings AGAIN to verify
  // consistency after the inventory write. This makes `harness regenerate`
  // the single command that updates ALL artifacts.
  repairAllBindings(root, { write });
  const testInventory = regenerateTestInventory(root, write);
  const hashBindings = repairAllBindings(root, { write });
  // The registrar write runs BEFORE the auto-generator snapshot so the report
  // reflects the final on-disk state. The auto-generator sources its binding
  // baselines from the hash-binding registry (file-truthful), so the repairs
  // above are visible to it even though ROOT_POLICY was imported at process
  // start.
  const moduleRegistrar = generateModuleRegistrarReport(root, { write });
  const autoGenerator = generateAutoGeneratorReport(root, { write: false });
  // Regenerate the config-document schema artifact (`traceability/config-
  // document-schema.json`). When `src/kernel/config-contracts.ts` changes, the
  // artifact drifts from the on-disk JSON file; it is rebuilt from the on-disk
  // policy pins the bindings repair above just wrote. Without this step, the EXP468 finding "harness regenerate does
  // NOT regenerate the schema artifact" requires a manual one-line `node
  // -e` workaround. The artifact is written in canonical-JSON form so it
  // matches the byte-format the test
  // (`test/config/config-contracts.test.ts`) expects (no pretty-printing
  // drift).
  const schemaArtifact = regenerateConfigSchemaArtifact(root, write);
  // The pin-authority arm: re-derive every source-authority pin the
  // hash-binding registry cannot carry (the `{path, byteLength, sha256}`
  // object pins — handoff semantic owners, the planned-node-test source
  // authority) plus their content projections (the handoff manifest). Without
  // this step a source move leaves those pins stale and an operator must run a
  // separate script by hand — the hand-maintained-pin defect. Runs as a
  // subprocess so the builder-layer driver (and the test-realm planned-node
  // authority) stays out of the runtime import graph.
  const pinAuthorities = regeneratePinAuthorities(root, write);
  // The ratchet arm: every shrink-only baseline pruned against its guard's
  // scan, so a debt that fell leaves its list without a hand edit (a2b-design H2).
  const ratchetBaselines = regenerateRatchetBaselines(root, write);
  // The README consumer arm, last: its blocks project the import graph of
  // the tree every arm above has finished writing.
  const readmeConsumers = regenerateReadmeConsumers(root, write);
  // The decision index: rebuilt from the decision files' front matter.
  const decisionIndex = regenerateDecisionIndex(root, write);
  // The shipped hooks: each canonical hook's text, from its owner.
  const shippedHooks = regenerateShippedHooks(root, write);
  // The evidence ignore rule: derived from the tracked evidence manifests.
  const evidenceIgnore = regenerateEvidenceIgnore(root, write);
  // The frozen roots' pinned content: a change there is a manifest change the diff shows.
  const frozenRecords = syncFrozenRecords(trackedTop(root), write);
  const output: HarnessRegenerateOutput = deepFreeze({ autoGenerator, moduleRegistrar, hashBindings, testInventory, dispositionAutoAdd, dispositionManifest, schemaArtifact, pinAuthorities, ratchetBaselines, readmeConsumers, decisionIndex, shippedHooks, evidenceIgnore, frozenRecords });
  // In write mode the status is derived from POST-WRITE state: every binding
  // repaired, the registrar left the manifest clean, the inventory was
  // written or already current, and the schema artifact is current. In check
  // mode (write=false) the predicate fallback derives the status from the
  // (unmodified) reports.
  // The test-inventory arm is required to converge only when this tree HAS a
  // test surface to scan; on a product-only tree its guided skip is the
  // correct answer, not a failure. The product pins (hash bindings, module
  // registrar, config schema artifact) must still converge in both cases.
  const testInventoryConverged = testSurfacePresent(root) ? testInventory.status !== "skipped" : true;
  const status = write
    ? (hashBindings.allMatch && autoGenerator.allMatch &&
        moduleRegistrar.postWrite !== null && moduleRegistrar.postWrite.clean &&
        moduleRegistrar.postWrite.unregisteredModules === 0 && testInventoryConverged &&
        (schemaArtifact.status === "current" || schemaArtifact.status === "regenerated") &&
        pinAuthorities.converged && ratchetBaselines.converged && readmeConsumers.converged && decisionIndex.converged && shippedHooks.converged && evidenceIgnore.converged && frozenRecords.converged
      ? "pass" : "fail")
    : undefined;
  return wrapResult("regenerate", output, status === undefined ? {} : { status });
}

/**
 * Auto-add missing disposition entries for recognizable test files by invoking
 * `scripts/run-tests.ts --auto-add-dispositions` as a subprocess. The
 * test-surface manifest logic lives in the builder layer
 * (`scripts/verification/test-surface.ts`); runtime modules must not import
 * builder modules (see the note on `recomputeDispositionManifestIntegrityHash`),
 * so the subprocess boundary keeps the layer rule intact while giving
 * `harness regenerate` (and therefore `harness sync`) one-shot behavior:
 * new test files are registered in the manifest before the inventory and
 * hash bindings are regenerated. The subprocess also cleans up ephemeral
 * foundation-cascade residue files before scanning, so residue is never
 * registered. In read-only mode (`write === false`) nothing is mutated and
 * the step reports `skipped`.
 */
/**
 * Whether this working tree carries the test surface (the engine suite and its
 * runner). Discovered from the tree, never a hardcoded branch name: the
 * disposition auto-add and the test-inventory regeneration scan a test tree,
 * and on a tree that ships the product only (no `scripts/run-tests.ts`) those
 * arms have no subject. The gate is the runner script's presence — the one
 * file every test-surface arm converges on — so a tree either has the whole
 * surface or reports the guided skip, never a partial crash.
 */
function testSurfacePresent(root: string): boolean {
  return existsSync(resolve(root, "scripts/tooling/run-tests.ts")) && existsSync(resolve(root, "scripts/test-inventory.ts"));
}

/** `--prune <path>` for each path: the named, deliberate test deletions (see `test_surface_prune_refused`). */
export function pruneArguments(prune: readonly string[]): readonly string[] {
  return prune.flatMap((path) => ["--prune", path]);
}

function autoAddDispositionEntries(root: string, write: boolean, prune: readonly string[]): DispositionAutoAddResult {
  if (!write) {
    return deepFreeze({ status: "skipped", addedCount: 0, addedPaths: deepFreeze([]), prunedCount: 0, prunedPaths: deepFreeze([]) });
  }
  if (!testSurfacePresent(root)) {
    return deepFreeze({ status: "skipped", addedCount: 0, addedPaths: deepFreeze([]), prunedCount: 0, prunedPaths: deepFreeze([]) });
  }
  const stdout = runScriptSubprocess(root, "scripts/tooling/run-tests.ts", ["--auto-add-dispositions", ...pruneArguments(prune)], DEFAULT_DISPOSITION_AUTO_ADD_TIMEOUT_MS);
  const parsed = JSON.parse(stdout) as { status: string; addedCount: number; addedPaths: string[]; prunedCount: number; prunedPaths: string[] };
  return deepFreeze({
    status: parsed.status === "added" || (parsed.prunedCount ?? 0) > 0 ? "added" : "current",
    addedCount: parsed.addedCount,
    addedPaths: deepFreeze([...parsed.addedPaths]),
    prunedCount: parsed.prunedCount ?? 0,
    prunedPaths: deepFreeze([...(parsed.prunedPaths ?? [])]),
  });
}

/**
 * Heal a stale disposition-manifest signature — through the manifest's ONE
 * owner, never beside it.
 *
 * When entries are edited by hand the `integrityHash` field goes stale and the
 * strict parse in the auto-add step below refuses the manifest, so healing it
 * first keeps a manual edit recoverable through `harness regenerate` alone.
 *
 * WHAT THIS USED TO BE, AND WHY IT MATTERED. It was an inlined copy of the
 * manifest logic, sitting here because importing the builder-layer
 * verification module would have put `src/ -> scripts/` into the runtime
 * import graph. The constraint was real; the copy was not the only way to
 * satisfy it. The copy read the file with a raw `JSON.parse`, checked two
 * fields by hand instead of against the schema, and wrote `policyHash` from
 * the CURRENT policy unconditionally — so a manifest whose discovery policy
 * had moved on was silently re-blessed here, and the refusal that exists to
 * catch exactly that could be walked straight past. It was the only such path
 * in the repository.
 *
 * The shared half now lives in the runtime layer, where both this command and
 * the builder module may import it, and the distinction the copy erased is
 * enforced there: a stale SIGNATURE heals, a stale POLICY refuses.
 */
function recomputeDispositionManifestIntegrityHash(
  root: string,
  write: boolean,
): Readonly<{
  status: "current" | "regenerated";
  integrityHash: string;
}> {
  const manifestPath = resolve(root, ROOT_POLICY.verification.testDiscovery.dispositionRegistry.manifestPath);
  if (!existsSync(manifestPath)) {
    if (!testSurfacePresent(root)) {
      // A product-only tree carries no test surface to recompute against;
      // report current rather than refuse — the manifest's subject is absent.
      return deepFreeze({ status: "current", integrityHash: ROOT_POLICY.verification.testSurfaceDispositionBinding.identityHash });
    }
    throw new InputError("test-surface disposition manifest file not found", "input_error");
  }
  const current = readFileSync(manifestPath, "utf8");
  const resigned = resignTestSurfaceDispositionManifest(current);
  if (resigned.status === "current" || !write) {
    return deepFreeze({ status: resigned.status, integrityHash: resigned.integrityHash });
  }
  const writeResult = atomicWriteFile(manifestPath, resigned.text);
  if (!writeResult.success) {
    throw new InputError(`Could not write disposition manifest: ${writeResult.reason ?? "unknown"}`, "input_error");
  }
  return deepFreeze({ status: "regenerated", integrityHash: resigned.integrityHash });
}

function regenerateTestInventory(root: string, write: boolean): Readonly<{
  status: "current" | "regenerated" | "skipped";
  testCount: number;
  inventoryHash: string;
}> {
  // Invoke scripts/test-inventory.ts as a subprocess to keep the builder-layer
  // test-inventory generator (and its @babel/parser dependency) out of the
  // runtime import graph. Runtime modules must not depend on builder modules.
  // On a product-only tree the test surface is absent: report the guided skip
  // rather than spawn a runner that is not there.
  if (!testSurfacePresent(root)) {
    return { status: "skipped", testCount: 0, inventoryHash: ROOT_POLICY.verification.testInventoryHash };
  }
  const stdout = runScriptSubprocess(root, "scripts/test-inventory.ts", [write ? "--write" : "--check"], 180_000);
  const parsed = JSON.parse(stdout) as {
    inventoryHash: string;
    testCount: number;
    status: string;
  };
  if (write) {
    return {
      status: parsed.status === "written" ? "regenerated" : "current",
      testCount: parsed.testCount,
      inventoryHash: parsed.inventoryHash,
    };
  }
  return {
    status: parsed.status === "current" ? "current" : "skipped",
    testCount: parsed.testCount,
    inventoryHash: parsed.inventoryHash,
  };
}

/**
 * Re-derive the source-authority pins the hash-binding registry cannot carry
 * (the `{path, byteLength, sha256}` object pins) plus their content
 * projections. The driver (`scripts/pin-authority-regeneration.ts`)
 * owns the registry of pin authorities and the per-file rewrite; this step is
 * the choke-point invocation so `harness regenerate` / `harness sync` converge
 * them in one command. Runs as a subprocess: the driver reads a test-realm
 * authority (`test/support/`), which runtime modules must not import. The
 * driver is a MANDATORY runtime dependency of this command (a product tree
 * runs it too — a testing-only authority with no subject there is
 * converged by absence inside the driver), so it must never live under a
 * declared testing-only folder.
 */
function regeneratePinAuthorities(root: string, write: boolean): Readonly<{
  status: "current" | "regenerated";
  converged: boolean;
}> {
  const stdout = runScriptSubprocess(
    root,
    "scripts/pin-authority-regeneration.ts",
    [write ? "--write" : "--check"],
    DEFAULT_SYNC_REGENERATE_TIMEOUT_MS,
  );
  const parsed = JSON.parse(stdout) as { allCurrent: boolean; results: ReadonlyArray<{ status: string }> };
  return deepFreeze({
    status: parsed.results.some((r) => r.status === "regenerated") ? "regenerated" : "current",
    converged: parsed.allCurrent,
  });
}

/**
 * The ratchet-baseline arm (a2b-design H2), as a subprocess like the other
 * builder-layer arms: with `write`, each registered baseline loses the
 * entries no finding of its guard matches; without, a stale entry is drift.
 * A key is never added (a new site fails its guard; growth fails the commit
 * guard against HEAD).
 */
function regenerateRatchetBaselines(root: string, write: boolean): RatchetBaselinesArm {
  const stdout = runScriptSubprocess(root, "scripts/verification/ratchet-baselines.ts", [write ? "--write" : "--check"], DEFAULT_SYNC_REGENERATE_TIMEOUT_MS);
  const parsed = JSON.parse(stdout) as { allCurrent: boolean; results: RatchetBaselinesArm["results"] };
  return deepFreeze({
    status: parsed.results.some((result) => result.status === "pruned") ? "regenerated" : "current",
    converged: parsed.allCurrent,
    results: parsed.results.map(({ id, path, status, stale, unbaselined }) => ({ id, path, status, stale, unbaselined })),
  });
}

/** `harness check`'s evidence-ignore step: a stale generated block FAILS the check, naming the file (design N3', correctness E5). */
export function evidenceIgnoreStep(evidenceIgnore: DecisionIndexArm): CheckStepResult {
  return deepFreeze({
    step: "evidence-ignore",
    status: evidenceIgnore.converged ? "pass" : "fail",
    message: evidenceIgnore.converged
      ? `the ignore file's evidence block matches the tracked evidence manifests${evidenceIgnore.status === "absent" ? " (this tree has no ignore file)" : ""}`
      : `the ignore file's evidence block is stale against the tracked evidence manifests (run harness sync): ${evidenceIgnore.changed.join(", ")}`,
    details: evidenceIgnore,
  });
}

/** `harness check`'s frozen-records step: a frozen root whose content left its pin FAILS the check, naming each path. */
export function frozenRecordsStep(frozenRecords: FrozenRecordsReport): CheckStepResult {
  return deepFreeze({
    step: "frozen-records",
    status: frozenRecords.converged ? "pass" : "fail",
    message: frozenRecordsMessage(frozenRecords),
    details: frozenRecords,
  });
}

/**
 * The decision-index arm (wf-1b3a-design M1), as a subprocess like the other
 * builder-layer arms: `docs/decisions/README.md`'s index rebuilt from the
 * decision files (`scripts/verification/decision-index.ts`). A tree without
 * the generator (a product-only tree) or without the decisions folder is
 * converged by absence.
 */
function regenerateDecisionIndex(root: string, write: boolean): DecisionIndexArm {
  if (!existsSync(resolve(root, DECISION_INDEX.generator))) return deepFreeze({ status: "absent" as const, converged: true, changed: [] });
  const report = generatorReport<DecisionIndexArm["status"]>(root, DECISION_INDEX.generator, [write ? "--write" : "--check"], "the decision index generator", "decision_index_no_result");
  return deepFreeze({ status: report.status, converged: report.allCurrent, changed: report.changed });
}

/** The shipped-hooks arm (`SHIPPED_HOOK_FILES.generator`, relative to the engine); a tree without the generator is converged by absence. */
/** The evidence ignore arm (in process: the evidence store is a runtime module): the generated block, from the tracked manifests. */
function regenerateEvidenceIgnore(root: string, write: boolean): DecisionIndexArm {
  const report = syncEvidenceIgnore(trackedTop(root), write);
  return deepFreeze({ status: report.status, converged: report.converged, changed: report.changed });
}

function regenerateShippedHooks(root: string, write: boolean): DecisionIndexArm {
  if (!existsSync(resolve(root, SHIPPED_HOOK_FILES.generator))) return deepFreeze({ status: "absent" as const, converged: true, changed: [] });
  const report = generatorReport<DecisionIndexArm["status"]>(root, SHIPPED_HOOK_FILES.generator, [write ? "--write" : "--check"], "the shipped hooks generator", "shipped_hooks_no_result");
  return deepFreeze({ status: report.status, converged: report.allCurrent, changed: report.changed });
}

/**
 * THE ONE PROTOCOL of a builder-layer generator run as a subprocess (the
 * runtime must not import the builder layer): ONE JSON line, the LAST one
 * (`runScriptSubprocess` hands back the last non-empty stdout line, so a line
 * an import printed before it is not the answer), `{ allCurrent, status,
 * changed, … }`. A generator that printed nothing, or no JSON last, or
 * another shape, judged nothing: typed `code`, never a silent "current" and
 * never an untyped SyntaxError (wf-del2-correctness NEW-11).
 */
function generatorReport<Status extends string>(root: string, generator: string, args: readonly string[], label: string, code: string): Readonly<{ allCurrent: boolean; status: Status; changed: readonly string[] } & Record<string, unknown>> {
  const last = runScriptSubprocess(root, generator, args, DEFAULT_SYNC_REGENERATE_TIMEOUT_MS);
  let parsed: { allCurrent: boolean; status: Status; changed: readonly string[] } & Record<string, unknown>;
  try {
    parsed = JSON.parse(last) as typeof parsed;
  } catch {
    throw new HarnessError(`${label} ${generator} printed no result line (its last line is not the JSON result)`, code);
  }
  if (typeof parsed !== "object" || parsed === null || typeof parsed.allCurrent !== "boolean" || !Array.isArray(parsed.changed)) {
    throw new HarnessError(`${label} ${generator} printed a result of another shape (no allCurrent flag or changed list)`, code);
  }
  return parsed;
}

/**
 * The README consumer arm: the generator (`README_CONSUMER_BLOCK.generator`,
 * relative to the repository git names for `root`) as a subprocess like the
 * other builder-layer arms — it walks the whole repository's import graph
 * with the web suite's resolver, which the runtime must not import. With
 * `write` every marked README's block is rewritten; without, a stale block is
 * drift. The generator projects exactly `generatedReadmePaths` (one
 * selection, hash-binding-registry.ts). A tree without the generator — a product-only tree has no test
 * surface; its READMEs are byte-locked to the testing tree, where this arm
 * runs — or outside a work tree is converged by absence.
 */
export function regenerateReadmeConsumers(root: string, write: boolean): ReadmeConsumersArm {
  const absent = deepFreeze({ status: "absent" as const, converged: true, readmes: 0, changed: [] });
  const repositoryRoot = repositoryToplevel(root, "directory");
  if (repositoryRoot === undefined) return absent;
  const generator = resolve(repositoryRoot, README_CONSUMER_BLOCK.generator);
  if (!existsSync(generator)) return absent;
  const report = generatorReport<"current" | "regenerated" | "stale">(root, generator, [write ? "--write" : "--check", `--root=${repositoryRoot}`], "the README consumer generator", "readme_consumers_no_result");
  return deepFreeze({ status: report.status, converged: report.allCurrent, readmes: typeof report["readmes"] === "number" ? report["readmes"] : 0, changed: report.changed });
}

/**
 * Regenerate `traceability/config-document-schema.json` from the artifact the
 * ON-DISK root policy declares (`currentConfigContractArtifact`), in
 * canonical-JSON form.
 *
 * Per the EXP468 audit finding: "harness regenerate does NOT regenerate
 * `traceability/config-document-schema.json` — I had to regenerate it
 * manually from `getConfigContractArtifact()`. This is a tooling gap:
 * the regenerate command should emit the schema artifact."
 *
 * When `src/config-contracts.ts` changes, the literal
 * `getConfigContractArtifact()` drifts from the on-disk JSON file.
 * This function rewrites the artifact in canonical-JSON form so the
 * `test/config/config-contracts.test.ts` byte-bind stays valid without
 * a manual `node -e` workaround.
 *
 * In read-only mode (`write === false`) nothing is mutated; the function
 * reports whether the on-disk artifact is current or stale.
 */
function regenerateConfigSchemaArtifact(root: string, write: boolean): Readonly<{
  status: "current" | "regenerated";
  schemaHash: string;
  artifactPath: string;
}> {
  const artifactPath = resolve(root, ROOT_POLICY.configuration.contract.generatedSchemaPath);
  // The canonical-JSON form is what `test/config/config-contracts.test.ts`
  // expects (no pretty-printing drift). `canonicalJson` produces a stable
  // byte-string for the same object regardless of key insertion order.
  // Built from the on-disk policy pins: the bindings repair above may have
  // re-pinned the contract source in this very process.
  const canonicalContent = `${canonicalJson(currentConfigContractArtifact(root))}\n`;
  const schemaHash = sha256(canonicalContent);
  if (!existsSync(artifactPath)) {
    if (!write) {
      return deepFreeze({ status: "regenerated", schemaHash, artifactPath });
    }
    // Ensure the parent directory exists (traceability/ may not exist on a
    // fresh checkout).
    const parent = resolve(artifactPath, "..");
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    const writeResult = atomicWriteFile(artifactPath, canonicalContent);
    if (!writeResult.success) {
      throw new InputError(`Could not write schema artifact: ${writeResult.reason ?? "unknown"}`, "input_error");
    }
    return deepFreeze({ status: "regenerated", schemaHash, artifactPath });
  }
  const currentBytes = readFileSync(artifactPath, "utf8");
  const currentHash = sha256(currentBytes);
  if (currentHash === schemaHash) {
    return deepFreeze({ status: "current", schemaHash, artifactPath });
  }
  if (!write) {
    return deepFreeze({ status: "regenerated", schemaHash, artifactPath });
  }
  const writeResult = atomicWriteFile(artifactPath, canonicalContent);
  if (!writeResult.success) {
    throw new InputError(`Could not write schema artifact: ${writeResult.reason ?? "unknown"}`, "input_error");
  }
  return deepFreeze({ status: "regenerated", schemaHash, artifactPath });
}

export function harnessRegister(
  root: string,
  options: Readonly<{ write?: boolean }> = {},
): HarnessCommandResult<HarnessRegisterOutput> {
  const write = options.write ?? false;
  const registrarReport = generateModuleRegistrarReport(root, { write });
  const output: HarnessRegisterOutput = deepFreeze({ registrarReport });
  // In write mode the status reflects the POST-WRITE state: correcting drift
  // and then leaving a clean manifest is a pass, even though the report's
  // top-level counts describe the pre-fix drift. In read-only mode the
  // predicate fallback derives the status from the unmodified report.
  const status = write
    ? (registrarReport.postWrite !== null && registrarReport.postWrite.clean &&
        registrarReport.postWrite.unregisteredModules === 0 ? "pass" : "fail")
    : undefined;
  return wrapResult("register", output, status === undefined ? {} : { status });
}

/**
 * One-shot consistency command — the recommended way to bring the harness
 * into a consistent state after any edit. Without `--with-bundle`, runs in
 * order:
 * 1. `harness register --write` (fix module drift)
 * 2. `harness regenerate` (auto-add dispositions, fix hash bindings +
 * inventory, regenerate the module registrar)
 * 3. `harness check --skip-typecheck` (verify every gate passes)
 *
 * With `--with-bundle`, runs:
 * 1. `harness register --write` (fix module drift)
 * 2. `harness regenerate` (stabilize the non-bundle hash bindings — manifest
 *    hash, config-contracts sha256, disposition identity, etc.)
 * 3. `node scripts/build-bundle.ts` (rebuild the production bundle from the
 *    STABILIZED root-policy so the bundle embeds the correct non-bundle pins)
 * 4. `harness regenerate` (re-pin the fresh bundle sha256 into root-policy)
 * 5. `harness check --skip-typecheck` (verify every gate passes)
 *
 * The bundle includes root-policy.ts, which pins the bundle sha256 AND the
 * non-bundle hash bindings. Building the bundle before the non-bundle pins
 * are stabilized leaves the bundle stale (the staleness test rebuilds from
 * the updated root-policy and detects the non-self-referential pin drift).
 * Building the bundle after the initial regenerate, then re-pinning with a
 * final regenerate, makes the bundle + the pin converge in a single
 * invocation — eliminating the two-round manual chore (build-bundle ->
 * regenerate -> build-bundle -> regenerate) that was the #1 agent time-waste
 * when touching config/root-policy/workflow-config files.
 *
 * Each step runs as its OWN CLI subprocess. This is the correctness crux:
 * every step reads file truth through fresh module imports. Running the steps
 * in-process would compare against the STALE statically-imported
 * ARCHITECTURE_MANIFEST / ROOT_POLICY from process start, so a manifest or
 * root-policy pin written by step 1/2 would be invisible to step 2/3 in the
 * same process — the exact false-drift failure mode this command exists to
 * eliminate. Subprocesses preserve the semantics of running the commands by
 * hand while giving one unified result.
 *
 * All steps always run so a single invocation reports the complete picture
 * even when an early step fails. The overall status is explicit: the nested
 * write-mode reports describe PRE-FIX drift counts, so the predicate fallback
 * in `wrapResult` must not derive the status from them. `register` and
 * `regenerate` remain available as separate commands for fine-grained
 * control; `sync` is the preferred one-shot operation. Use `--with-bundle`
 * after any edit that changes a bundled source file (src/, workflow-config,
 * root-policy) so the bundle + hash bindings stabilize in a single pass.
 *
 * CONVERGENCE IS CHECKED, NOT ASSUMED — the fixed point is this command's
 * own: the pass repeats until one leaves every generated output
 * (`generatedOutputPaths`) byte-identical, bounded by the number of outputs
 * (plus the confirming pass). A pass that changes nothing ends it, with its
 * own status (an already-synced tree costs one pass; a failing check on a
 * tree the pass no longer changes is a real failure); the bound exhausted is
 * `harness_sync_not_converged`, naming the
 * outputs still changing (an oscillating generator is reported, never looped
 * on). `result.convergence` states the passes, what each changed, and — the
 * `source_generated_outputs_stale` finding — which tracked outputs the FIRST
 * pass rewrote: the tree was not synced (or a generated value depends on
 * history, not on sources). Every caller gets it: the CLI, the candidate
 * checkout, the workspace's regenerate phase.
 */
export async function harnessSync(
  root: string,
  options: Readonly<{ withBundle?: boolean; prune?: readonly string[]; onProgress?: (message: string) => void }> = {},
): Promise<HarnessCommandResult<HarnessSyncOutput>> {
  const repositoryRoot = repositoryToplevel(root, "directory") ?? resolve(root, "..");
  const outputs = [...generatedOutputPaths(repositoryRoot)];
  const fingerprint = (): ReadonlyMap<string, string> => new Map(outputs.map((path) => {
    const absolute = join(repositoryRoot, path);
    return [path, existsSync(absolute) ? sha256(readFileSync(absolute)) : "absent"] as const;
  }));
  let pass = 0;
  const { output, convergence } = await convergeUntilStable(() => {
    pass += 1;
    emitProgress(options.onProgress, `sync pass ${pass}:`);
    return syncPass(root, options);
  }, fingerprint, convergeBound(outputs.length), { subject: "harness sync", code: "harness_sync_not_converged" });
  return wrapResult("sync", deepFreeze({ ...output, convergence }), { status: output.allPassed ? "pass" : "fail" });
}

/** One pass of `harness sync` (see {@link harnessSync}): the steps, each a CLI subprocess. */
async function syncPass(
  root: string,
  options: Readonly<{ withBundle?: boolean; prune?: readonly string[]; onProgress?: (message: string) => void }>,
): Promise<Omit<HarnessSyncOutput, "convergence">> {
  const prune = pruneArguments(options.prune ?? []);
  // Without --with-bundle: register -> regenerate -> check (3 steps).
  // With --with-bundle: register -> regenerate (stabilize non-bundle pins) ->
  //   build-bundle (build from the stabilized root-policy) -> regenerate (pin
  //   the fresh bundle sha256) -> check (5 steps).
  // The bundle includes root-policy.ts, which pins the bundle sha256 AND the
  // non-bundle hash bindings (manifest hash, config-contracts sha256, etc.).
  // Building the bundle BEFORE the non-bundle pins are stabilized leaves the
  // bundle stale (the staleness test rebuilds from the updated root-policy
  // and detects the non-self-referential pin drift). Building the bundle
  // AFTER the initial regenerate, then re-pinning with a final regenerate,
  // makes the bundle + the pin converge in a single `harness sync
  // --with-bundle` invocation — eliminating the two-round manual chore.
  const totalSteps = options.withBundle ? 5 : 3;
  let stepIndex = 0;
  let bundleBuild: HarnessCommandResult | undefined;
  let regenerateInitial: HarnessCommandResult | undefined;
  stepIndex += 1;
  emitProgress(options.onProgress, `sync step ${stepIndex}/${totalSteps}: harness register --write (fix module drift)...`);
  const register = runSyncStep(root, "register", ["--write"], DEFAULT_SYNC_REGISTER_TIMEOUT_MS);
  stepIndex += 1;
  emitProgress(options.onProgress, `sync step ${stepIndex}/${totalSteps}: harness regenerate (fix hash bindings + inventory)...`);
  regenerateInitial = runSyncStep(root, "regenerate", prune, DEFAULT_SYNC_REGENERATE_TIMEOUT_MS);
  let regenerate = regenerateInitial;
  if (options.withBundle) {
    stepIndex += 1;
    emitProgress(options.onProgress, `sync step ${stepIndex}/${totalSteps}: build production bundle (scripts/build-bundle.ts)...`);
    bundleBuild = runBundleBuildStep(root);
    stepIndex += 1;
    emitProgress(options.onProgress, `sync step ${stepIndex}/${totalSteps}: harness regenerate (pin fresh bundle sha256)...`);
    regenerate = runSyncStep(root, "regenerate", prune, DEFAULT_SYNC_REGENERATE_TIMEOUT_MS);
  }
  stepIndex += 1;
  emitProgress(options.onProgress, `sync step ${stepIndex}/${totalSteps}: harness check --skip-typecheck (verify)...`);
  const check = runSyncStep(root, "check", ["--skip-typecheck"], DEFAULT_SYNC_CHECK_TIMEOUT_MS);
  const steps: HarnessSyncStepSummary[] = [];
  steps.push(deepFreeze({ step: "register", status: register.status }));
  steps.push(deepFreeze({ step: "regenerate", status: regenerateInitial.status }));
  if (bundleBuild !== undefined) steps.push(deepFreeze({ step: "bundle-build", status: bundleBuild.status }));
  if (options.withBundle) steps.push(deepFreeze({ step: "regenerate", status: regenerate.status }));
  steps.push(deepFreeze({ step: "check", status: check.status }));
  const allPassed = steps.every((step) => step.status === "pass");
  return deepFreeze({
    steps: deepFreeze(steps),
    ...(bundleBuild !== undefined ? { bundleBuild } : {}),
    ...(regenerateInitial !== regenerate ? { regenerateInitial } : {}),
    register,
    regenerate,
    check,
    allPassed,
  });
}

/**
 * Run the production bundle build (`scripts/build-bundle.ts`) as a subprocess
 * and wrap its BuildSummary into a HarnessCommandResult. In `harness sync
 * --with-bundle`, this runs AFTER the initial regenerate (which stabilizes
 * the non-bundle hash bindings) so the bundle embeds the correct pins, then
 * a final regenerate pins the fresh bundle sha256. A build failure (esbuild
 * error, missing entry) surfaces as status "fail" with the stderr diagnostic;
 * it does NOT abort the remaining sync steps (the full picture is more useful
 * than a hard abort).
 *
 * Exported so the `harness sync --with-bundle` regression test can exercise the
 * bundle-build step in isolation (one subprocess) without re-running the
 * full register/regenerate/check sync (multiple subprocesses) — keeping the
 * test-suite contention low (the full sync is verified by the cached
 * `syncOnce` test; this isolates the new bundle-build step).
 */
export function runBundleBuildStep(root: string): HarnessCommandResult {
  try {
    // The bundle build emits pretty-printed multi-line JSON, so capture the
    // full stdout (not just the final line) and parse the whole document.
    const stdout = runScriptSubprocess(root, "scripts/build-bundle.ts", [], DEFAULT_SYNC_BUNDLE_TIMEOUT_MS, { fullOutput: true });
    const summary = JSON.parse(stdout) as unknown;
    return wrapResult("bundle-build", summary, { status: "pass" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "bundle build failed";
    return wrapResult("bundle-build", deepFreeze({ error: message }), { status: "fail" });
  }
}

/**
 * Run one sync step as a CLI subprocess and return its integrity-verified
 * command result. A non-zero exit code (status "fail") still carries the JSON
 * payload on stdout, so it is parsed like a success; only a missing/invalid
 * payload is an orchestration error.
 */
function runSyncStep(
  root: string,
  step: "register" | "regenerate" | "check",
  args: readonly string[],
  timeoutMs: number,
): HarnessCommandResult {
  const stdout = runScriptSubprocess(root, "src/cli.ts", ["harness", step, ...args], timeoutMs);
  const parsed = parseHarnessCommandResult(JSON.parse(stdout));
  if (parsed.command !== step) {
    throw new InputError(`sync step '${step}' returned a result for command '${parsed.command}'`, "input_error");
  }
  return parsed;
}

/**
 * Invoke a repository script (`src/cli.ts`, `scripts/test-inventory.ts`,
 * `scripts/run-tests.ts`,...) as a subprocess and return stdout's final
 * non-empty line (the JSON status payload). Non-zero exits that still emitted
 * a payload are NOT errors here — `--check`-style commands exit 1 on drift
 * while carrying the payload on stdout; the caller interprets the payload's
 * own status field. A non-zero exit without any stdout payload is a genuine
 * failure and is re-thrown.
 *
 * When `fullOutput` is true, the full stdout (trimmed) is returned instead of
 * just the final non-empty line — for scripts that emit multi-line /
 * pretty-printed JSON (e.g. scripts/build-bundle.ts), where taking only the
 * last line would yield a partial fragment that fails to parse.
 */
function runScriptSubprocess(
  root: string,
  scriptRelativePath: string,
  args: readonly string[],
  timeoutMs: number,
  options: Readonly<{ fullOutput?: boolean }> = {},
): string {
  const scriptPath = resolve(root, scriptRelativePath);
  let stdout: string;
  try {
    stdout = execFileSync(process.execPath, [scriptPath, ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });
  } catch (error) {
    const stdoutValue = (error as { stdout?: unknown } | null)?.stdout;
    if (typeof stdoutValue === "string" && stdoutValue.trim().length > 0) {
      stdout = stdoutValue;
    } else {
      // No payload on stdout — a genuine subprocess failure. The scripts
      // report a failure as ONE typed JSON line (`{"error": <code>,
      // "message": …}`) on stderr; that record is the error channel, and it
      // is passed through with its own code and message. It is FOUND, not
      // assumed to be the last line: a runtime warning printed after it
      // (a Node deprecation notice) used to replace the typed refusal with
      // "failed without a status payload: (node:123) Warning: …".
      const stderrValue = (error as { stderr?: unknown } | null)?.stderr;
      const lines = typeof stderrValue === "string" ? stderrValue.trim().split("\n").filter((line) => line.trim().length > 0) : [];
      const typed = typedFailureRecord(lines);
      if (typed !== undefined) {
        // The STEP is named as a step, never as a location: `src/cli.ts: <a
        // syntax error in another file>` sent the operator to the wrong file
        // (wf1a-correctness). A location, when there is one, is the
        // refusal's own (e.g. `source_syntax_invalid` names the source file).
        throw new HarnessError(`the ${scriptRelativePath} step failed: ${typed.message}`, typed.code);
      }
      const baseMessage = error instanceof Error ? error.message : "subprocess failed";
      throw new InputError(
        `subprocess ${scriptRelativePath} failed without a status payload: ${lines.at(-1) ?? baseMessage}`,
        "input_error",
      );
    }
  }
  if (options.fullOutput) return stdout.trim();
  return stdout.trim().split("\n").filter((line) => line.trim().length > 0).at(-1) ?? "";
}

/** The last stderr line that is a typed failure record (`{"error": <code>, "message": <text>}`), if any. */
function typedFailureRecord(lines: readonly string[]): Readonly<{ code: string; message: string }> | undefined {
  for (const line of lines.toReversed()) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch (error) {
      // Not a record (a warning, a progress line): keep looking.
      if (!(error instanceof SyntaxError)) throw error;
      continue;
    }
    const { error, message, originalCode } = (typeof record === "object" && record !== null ? record : {}) as
      { error?: unknown; message?: unknown; originalCode?: unknown };
    // A nested harness CLI wraps a typed refusal as `harness_command_failed`
    // with the refusal's own code in `originalCode`: pass the original on.
    if (typeof error === "string" && typeof message === "string") return { code: typeof originalCode === "string" ? originalCode : error, message };
  }
  return undefined;
}

export function harnessNewModule(
  root: string,
  modulePath: string,
): HarnessCommandResult<HarnessNewModuleOutput> {
  if (typeof modulePath !== "string" || modulePath.length === 0) {
    throw new InputError("module path must be a non-empty string", "input_error");
  }
  const normalizedPath = modulePath.startsWith("src/") || modulePath.startsWith("scripts/") || modulePath.startsWith("verification/")
    ? modulePath
    : `src/${modulePath}`;
  const absolutePath = resolve(root, normalizedPath);
  const directory = absolutePath.slice(0, absolutePath.lastIndexOf(sep));
  const created = !existsSync(absolutePath);
  if (created) {
    mkdirSync(directory, { recursive: true });
    const template = generateModuleTemplate(normalizedPath);
    const writeResult = atomicWriteFile(absolutePath, template);
    if (!writeResult.success) {
      throw new InputError(`Could not write module file: ${writeResult.reason ?? "unknown"}`, "input_error");
    }
  }
  const manifestExists = existsSync(resolve(root, "src/architecture-manifest.ts"));
  const registrarReport = generateModuleRegistrarReport(root, { write: created && manifestExists });
  const output: HarnessNewModuleOutput = deepFreeze({
    modulePath: normalizedPath,
    created,
    registered: registrarReport.unregisteredModules === 0,
    registrarReport,
  });
  return wrapResult("new-module", output);
}

function resolveLockOptions(owner: string): AcquireLockOptions {
  return configuredLockOptions(loadPinnedConfigSnapshot().document, owner);
}


async function runTypecheck(root: string): Promise<CheckStepResult> {
  try {
    execFileSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "--noEmit"], { cwd: root, encoding: "utf8", stdio: "pipe", timeout: resolveTypecheckTimeoutMs() });
    return deepFreeze({ step: "typecheck", status: "pass", message: "typecheck passed", details: null });
  } catch (error) {
    const message = error instanceof Error ? error.message : "typecheck failed";
    return deepFreeze({ step: "typecheck", status: "fail", message, details: null });
  }
}

/** The registrar's verdict: every module registered, none drifted, the composition-root lists derived. */
function registrarInSync(report: ModuleRegistrarReport): boolean {
  return report.unregisteredModules === 0 && report.driftedModules === 0 && report.compositionRootsCurrent;
}

function registrarDriftMessage(report: ModuleRegistrarReport): string {
  return `${report.unregisteredModules} unregistered, ${report.driftedModules} drifted` +
    (report.compositionRootsCurrent ? "" : ", composition-root lists stale (run harness sync)");
}

function runArchitectureCheck(root: string): CheckStepResult {
  try {
    const moduleRegistrar = generateModuleRegistrarReport(root);
    return deepFreeze({
      step: "architecture",
      status: registrarInSync(moduleRegistrar) ? "pass" : "fail",
      message: registrarInSync(moduleRegistrar)
        ? "architecture manifest is in sync"
        : registrarDriftMessage(moduleRegistrar),
      details: moduleRegistrar,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "architecture check failed";
    return deepFreeze({ step: "architecture", status: "fail", message, details: null });
  }
}

function runInventoryCheck(root: string): CheckStepResult {
  try {
    const inventoryPath = resolve(root, VERIFICATION_PATHS.testInventory);
    if (!existsSync(inventoryPath)) {
      return deepFreeze({ step: "inventory", status: "fail", message: "test inventory file not found", details: null });
    }
    const fileBytes = readFileSync(inventoryPath, "utf8");
    const parsed = JSON.parse(fileBytes) as { inventoryHash?: string };
    const currentHash = ROOT_POLICY.verification.testInventoryHash;
    const fileHash = typeof parsed.inventoryHash === "string" ? parsed.inventoryHash : sha256(fileBytes);
    return deepFreeze({
      step: "inventory",
      status: fileHash === currentHash ? "pass" : "fail",
      message: fileHash === currentHash ? "inventory hash matches root policy" : "inventory hash has drifted",
      details: deepFreeze({ fileHash, currentHash }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "inventory check failed";
    return deepFreeze({ step: "inventory", status: "fail", message, details: null });
  }
}

function skipStep(name: string): CheckStepResult {
  return deepFreeze({ step: name, status: "skip", message: `${name} skipped`, details: null });
}

function generateModuleTemplate(modulePath: string): string {
  const baseName = modulePath.slice(modulePath.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
  const underscoreName = baseName.replace(/-/g, "_");
  const pascalName = baseName.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
  return `export const ${underscoreName.toUpperCase()}_REVISION = "${baseName}/v1" as const;

export function ${pascalName.charAt(0).toLowerCase() + pascalName.slice(1)}(): string {
  return "${baseName}";
}
`;
}

export const HARNESS_SUBCOMMANDS = deepFreeze([
  "check", "test", "register", "regenerate", "sync", "new-module", "eval",
  "timeline", "metrics", "rollback", "extension", "benchmark", "diagnostic", "workspace",
  "format", "index", "deletions", "evidence", "promote", "slot", "flake", "frozen",
] as const);

export type HarnessSubcommand = typeof HARNESS_SUBCOMMANDS[number];

/**
 * Actionable error report emitted on stderr when a harness subcommand fails.
 * Carries the failing subcommand, the function/file/line/column where the
 * error originated (extracted from the error's own stack trace, never
 * hardcoded), the original message, the original typed code when the error
 * carries one, and the full stack for debugging. `error` preserves the
 * pre-existing top-level code semantics (`InputError` surfaces its own code;
 * anything else is `harness_command_failed`) so existing consumers of the
 * stderr contract do not break.
 */
export type HarnessCommandErrorReport = Readonly<{
  error: string;
  message: string;
  command: string;
  subcommand: string;
  function: string | null;
  file: string | null;
  line: number | null;
  column: number | null;
  originalCode: string | null;
  stack: string | null;
}>;

export function wrapCommandError(command: string, subcommand: string, error: unknown): HarnessCommandErrorReport {
  const context = extractErrorContext(error);
  const errorCode = error instanceof HarnessError
    ? error.code
    : typeof (error as { code?: unknown } | null | undefined)?.code === "string"
      ? (error as { code: string }).code
      : null;
  return deepFreeze({
    error: error instanceof InputError ? error.code : "harness_command_failed",
    message: context.message,
    command,
    subcommand,
    function: context.function,
    file: context.file === null ? null : relativizeToCwd(context.file),
    line: context.line,
    column: context.column,
    originalCode: errorCode,
    stack: context.stack,
  });
}

function relativizeToCwd(file: string): string {
  const relativePath = relative(process.cwd(), file).replaceAll("\\", "/");
  if (relativePath === "" || relativePath.startsWith("../") || isAbsolute(relativePath)) return file;
  return relativePath;
}

export async function runHarnessCli(argv: readonly string[]): Promise<number> {
  // Strip the `--include-experiments` opt-in flag from anywhere in argv and
  // propagate it to every scanner (in-process module-registrar and the
  // test-inventory subprocess) through the single env var the shared helper
  // reads. Keeping one env var as the source of truth means subprocesses
  // inherit the opt-in automatically without per-command plumbing.
  const includeExperiments = argv.includes("--include-experiments");
  if (includeExperiments) {
    process.env[EXPERIMENT_INCLUDE_ENV_VAR] = "1";
  }
  // THE ONE OUTPUT OPTION of every verb (`--json`, the default, or `--text`),
  // taken out here so no verb parses it: the dispatch renders every answer.
  const { format, argv: args } = takeOutputFormat(includeExperiments ? argv.filter((a) => a !== "--include-experiments") : argv);
  if (args.length === 0) {
    writeCommandError(format, { error: "no_harness_subcommand", message: `a harness subcommand is required (${HARNESS_SUBCOMMANDS.join(", ")})`, available: [...HARNESS_SUBCOMMANDS] });
    return 1;
  }
  const subcommand = args[0]!;
  if (!HARNESS_SUBCOMMANDS.includes(subcommand as HarnessSubcommand)) {
    writeCommandError(format, { error: "unknown_harness_subcommand", message: `unknown harness subcommand: ${subcommand} (${HARNESS_SUBCOMMANDS.join(", ")})`, subcommand, available: [...HARNESS_SUBCOMMANDS] });
    return 1;
  }
  // This function is ITSELF a production entry point (it carries its own
  // `import.meta.url` main guard below), so it cannot rely on `cli.ts`
  // having initialized the runtime. Initialization is idempotent, so the
  // nested path (cli.ts → here) performs it exactly once.
  initializeHarnessRuntime();
  // A real actor for the boundary: the actual subcommand being executed.
  // When nested inside the cli.ts boundary this REPLACES the actor with the
  // more specific one and inherits the outer run correlation.
  return await withRecordingContext(
    { actor: { kind: "cli", id: `harness:${subcommand}` } },
    () => dispatchHarnessSubcommand(subcommand, args.slice(1), format),
  );
}

/** A refusal on stderr, in the asked format: the record as JSON, or `<error>: <message>` (with where it arose, when known). */
function writeCommandError(format: CommandOutputFormat, report: Readonly<{ error: string; message: string; file?: string | null; line?: number | null } & Record<string, unknown>>): void {
  if (format === "json") {
    process.stderr.write(`${canonicalJson(report)}\n`);
    return;
  }
  const at = report.file === undefined || report.file === null ? "" : ` (at ${report.file}${report.line === undefined || report.line === null ? "" : `:${String(report.line)}`})`;
  process.stderr.write(`${report.error}: ${report.message}${at}\n`);
}

/** Execute one validated harness subcommand. Only reachable through the recording boundary in {@link runHarnessCli}. */
async function dispatchHarnessSubcommand(subcommand: string, rest: readonly string[], format: CommandOutputFormat): Promise<number> {
  const root = process.cwd();
  const onProgress = (message: string) => process.stderr.write(`${message}\n`);
  try {
    // Every verb's answer: its envelope, and (a verb that maps its own exit
    // code, or has its own report) the code and the report.
    let answer: CommandAnswer;
    if (subcommand === "check") {
      answer = { result: await harnessCheck(root, { ...parseCheckOptions(rest), onProgress }) };
    } else if (subcommand === "test") {
      answer = { result: await harnessTest(root, { ...parseTestOptions(rest), onProgress }) };
    } else if (subcommand === "register") {
      answer = { result: harnessRegister(root, parseRegisterOptions(rest)) };
    } else if (subcommand === "regenerate") {
      const { prune } = parsePruneOptions("regenerate", rest, false);
      answer = { result: harnessRegenerate(root, { write: true, prune }) };
    } else if (subcommand === "sync") {
      const { prune, withBundle } = parsePruneOptions("sync", rest, true);
      answer = { result: await harnessSync(root, { withBundle, prune, onProgress }) };
    } else if (subcommand === "new-module") {
      if (rest.length === 0) throw new InputError("new-module requires a module path", "input_error");
      if (rest.length > 1) throw new InputError("new-module accepts exactly one module path", "input_error");
      answer = { result: harnessNewModule(root, rest[0]!) };
    } else if (subcommand === "eval") {
      const { runEvalCli } = await import("../evaluation/cli.ts");
      answer = await runEvalCli(rest, onProgress);
    } else if (subcommand === "benchmark") {
      const { runBenchmarkCli } = await import("../performance/benchmark-cli.ts");
      answer = await runBenchmarkCli(rest);
    } else if (subcommand === "diagnostic") {
      const { runDiagnosticCli } = await import("../performance/diagnostic-cli.ts");
      answer = runDiagnosticCli(rest);
    } else if (subcommand === "slot") {
      const { runSlotCli } = await import("./slot-cli.ts");
      answer = await runSlotCli(rest);
    } else if (subcommand === "flake") {
      const { runFlakeCli } = await import("./flake-cli.ts");
      answer = await runFlakeCli(rest);
    } else if (subcommand === "workspace") {
      const { runWorkspaceCli } = await import("./workspace-cli.ts");
      answer = { result: await runWorkspaceCli(root, rest) };
    } else if (subcommand === "promote") {
      // Exit code: the class of the answer's code (src/workflow/promotion/codes.ts); its own report.
      const { runPromoteCli } = await import("./promotion/promote-cli.ts");
      answer = await runPromoteCli(root, rest);
    } else if (subcommand === "format") {
      const write = !rest.includes("--check");
      const unknown = rest.filter((a) => a !== "--check");
      if (unknown.length > 0) throw unknownFlag("format", unknown[0]!, ["--check"]);
      const formatResult = harnessFormat(root, { write });
      const output: HarnessFormatOutput = deepFreeze({
        scanned: formatResult.scanned,
        fixed: formatResult.fixed,
        write: formatResult.write,
        changedFiles: formatResult.results.filter((r) => r.changed).map((r) => r.path),
      });
      // `--check` is a gate (the workspace's validate phase runs it): a file
      // the fixer WOULD change is a failure, not a report.
      answer = { result: wrapResult("format", output, { status: !write && output.changedFiles.length > 0 ? "fail" : "pass" }) };
    } else if (subcommand === "index") {
      answer = { result: harnessIndex(root, rest) };
    } else if (subcommand === "deletions") {
      answer = { result: harnessDeletions(root, rest) };
    } else if (subcommand === "frozen") {
      answer = { result: harnessFrozen(root, rest) };
    } else if (subcommand === "evidence") {
      answer = { result: harnessEvidence(root, rest) };
    } else if (subcommand === "timeline") {
      answer = { result: await harnessTimeline(root, parseTimelineOptions(rest)) };
    } else if (subcommand === "metrics") {
      if (rest.length > 0) throw unknownFlag("metrics", rest[0]!, []);
      answer = { result: harnessMetrics(root) };
    } else if (subcommand === "rollback") {
      answer = { result: harnessRollback(root, parseRollbackOptions(rest)) };
    } else if (subcommand === "extension") {
      const extensionSub = rest[0];
      if (extensionSub === "list") {
        if (rest.length > 1) throw unknownFlag("extension list", rest[1]!, []);
        answer = { result: harnessExtensionList() };
      } else {
        throw new InputError(
          `unknown extension subcommand: ${extensionSub ?? "(none)"} (supported: list)`,
          "command_unavailable",
        );
      }
    } else {
      throw new InputError(`unhandled harness subcommand: ${subcommand}`, "command_unavailable");
    }
    process.stdout.write(renderCommandAnswer(answer, format));
    return commandExitCode(answer);
  } catch (error) {
    writeCommandError(format, wrapCommandError("harness", subcommand, error));
    return 1;
  }
}

function parseCheckOptions(argv: readonly string[]): HarnessCheckOptions {
  const options: { skipTypecheck?: boolean; skipArchitecture?: boolean; skipInventory?: boolean } = {};
  for (const arg of argv) {
    if (arg === "--skip-typecheck") options.skipTypecheck = true;
    else if (arg === "--skip-architecture") options.skipArchitecture = true;
    else if (arg === "--skip-inventory") options.skipInventory = true;
    else throw unknownFlag("check", arg, ["--skip-typecheck", "--skip-architecture", "--skip-inventory"]);
  }
  return deepFreeze(options);
}

/** `[--with-bundle] [--prune <test path>]…` for `sync`; the same without `--with-bundle` for `regenerate`. */
function parsePruneOptions(subcommand: string, argv: readonly string[], bundleFlag: boolean): Readonly<{ prune: readonly string[]; withBundle: boolean }> {
  const prune: string[] = [];
  let withBundle = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--prune" && index + 1 < argv.length) prune.push(argv[++index]!);
    else if (arg === "--with-bundle" && bundleFlag) withBundle = true;
    else throw unknownFlag(subcommand, arg, [...(bundleFlag ? ["--with-bundle"] : []), "--prune <test path>"]);
  }
  return { prune, withBundle };
}

function unknownFlag(subcommand: string, flag: string, supported: readonly string[]): InputError {
  const supportedText = supported.length === 0 ? "no flags supported" : `supported: ${supported.join(", ")}`;
  return new InputError(`unknown ${subcommand} flag: ${flag} (${supportedText})`, "unknown_flag");
}

function parseTestOptions(argv: readonly string[]): HarnessTestOptions {
  const options: { file?: string; all?: boolean; writeResults?: boolean } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--file" && index + 1 < argv.length) {
      const fileArg = argv[index + 1];
      if (fileArg !== undefined) options.file = fileArg;
      index += 1;
    } else if (arg === "--all") {
      options.all = true;
    } else if (arg === "--no-write") {
      options.writeResults = false;
    } else {
      throw unknownFlag("test", arg, ["--file", "--all", "--no-write"]);
    }
  }
  return deepFreeze(options);
}

function parseRegisterOptions(argv: readonly string[]): Readonly<{ write: boolean }> {
  for (const arg of argv) {
    if (arg !== "--write") throw unknownFlag("register", arg, ["--write"]);
  }
  return deepFreeze({ write: argv.includes("--write") });
}

function emitProgress(onProgress: ((message: string) => void) | undefined, message: string): void {
  if (onProgress !== undefined) onProgress(message);
}

export type HarnessTimelineOptions = Readonly<{
  runId?: string;
  limit?: number;
  eventType?: string;
}>;

export type TimelineEventSummary = Readonly<{
  eventId: string;
  sequence: string;
  eventType: string;
  wallTime: string;
  runId: string | null;
  description: string;
}>;

export type HarnessTimelineOutput = Readonly<{
  events: readonly TimelineEventSummary[];
  total: number;
  hasMore: boolean;
}>;

/**
 * Query the durable timeline event ledger from the CLI.
 *
 * The typed `TimelineQuery` port scopes every query to a single ledger id
 * (each chat session is its own ledger). A cross-run investigation CLI needs
 * to read events across all ledgers, so this queries the stable `event_log`
 * schema directly with read-only SQLite access and parameterized filters.
 * The schema is owned by `timeline-schema.ts`; the column names read here
 * (event_id, sequence, event_type, wall_time, run_id, description) are the
 * foundational columns present since the genesis migration.
 */
async function harnessTimeline(
  root: string,
  options: HarnessTimelineOptions,
): Promise<HarnessCommandResult<HarnessTimelineOutput>> {
  const config = loadPinnedConfigSnapshot();
  const stateRoot = config.document.state.root;
  const dbPath = join(root, stateRoot, "timeline.db");
  if (!existsSync(dbPath)) {
    return wrapResult("timeline", deepFreeze({ events: [], total: 0, hasMore: false }));
  }
  const limit = options.limit ?? DEFAULT_TIMELINE_COMMAND_LIMIT;
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (options.runId !== undefined) {
    conditions.push("run_id = ?");
    params.push(options.runId);
  }
  if (options.eventType !== undefined) {
    conditions.push("event_type = ?");
    params.push(options.eventType);
  }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(
      `SELECT event_id, sequence, event_type, wall_time, run_id, description FROM event_log ${whereClause} ORDER BY sequence DESC LIMIT ?`,
    ).all(...params, limit) as Array<{
      event_id: unknown;
      sequence: unknown;
      event_type: unknown;
      wall_time: unknown;
      run_id: unknown;
      description: unknown;
    }>;
    const countRow = db.prepare(`SELECT COUNT(*) AS c FROM event_log ${whereClause}`).get(...params) as { c: number } | undefined;
    const total = countRow?.c ?? 0;
    const events: TimelineEventSummary[] = rows.map((r) => deepFreeze({
      eventId: String(r.event_id),
      sequence: String(r.sequence),
      eventType: String(r.event_type),
      wallTime: String(r.wall_time),
      runId: r.run_id === null ? null : String(r.run_id),
      description: String(r.description),
    }));
    return wrapResult("timeline", deepFreeze({ events: deepFreeze(events), total, hasMore: total > events.length }));
  } finally {
    db.close();
  }
}

function parseTimelineOptions(argv: readonly string[]): HarnessTimelineOptions {
  let runId: string | undefined;
  let limit: number | undefined;
  let eventType: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--run-id" && index + 1 < argv.length) {
      runId = argv[index + 1];
      index += 1;
    } else if (arg === "--limit" && index + 1 < argv.length) {
      const parsed = Number(argv[index + 1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = Math.floor(parsed);
      }
      index += 1;
    } else if (arg === "--event-type" && index + 1 < argv.length) {
      eventType = argv[index + 1];
      index += 1;
    } else {
      throw unknownFlag("timeline", arg, ["--run-id", "--limit", "--event-type"]);
    }
  }
  const options: { runId?: string; limit?: number; eventType?: string } = {};
  if (runId !== undefined) options.runId = runId;
  if (limit !== undefined) options.limit = limit;
  if (eventType !== undefined) options.eventType = eventType;
  return deepFreeze(options);
}

// ---------------------------------------------------------------------------
// harness metrics
// ---------------------------------------------------------------------------

export type ResourceEventSummary = Readonly<{
  eventId: string;
  sequence: string;
  runId: string | null;
  description: string;
  wallTime: string;
}>;

export type HarnessMetricsOutput = Readonly<{
  snapshot: MetricsSnapshot;
  recentResourceEvents: readonly ResourceEventSummary[];
}>;

/**
 * Surface the performance metrics snapshot from the CLI.
 *
 * The MetricsCollector is an in-process aggregator; a fresh CLI invocation
 * has no live data, so `snapshot` reports an honest zero-state result
 * (`entryCount: 0`, empty entries) rather than `not_yet_implemented`. To
 * show real persisted data, the command also queries the durable timeline
 * for the most recent `resource` events (metrics are flushed to the timeline
 * by the chat runtime via `timeline.recordResource`).
 *
 * The `dbPath` override is an injection point for tests so they can point
 * at a fixture timeline database without going through the pinned config.
 */
export function harnessMetrics(
  root: string,
  overrides: Readonly<{ dbPath?: string }> = {},
): HarnessCommandResult<HarnessMetricsOutput> {
  const config = loadPinnedConfigSnapshot();
  const collector = createMetricsCollector({ config: configuredPerformanceConfig() });
  const snapshot = collector.snapshot();
  collector.close();

  const dbPath = overrides.dbPath ?? (() => {
    const stateRoot = config.document.state.root;
    return join(root, stateRoot, "timeline.db");
  })();
  let recentResourceEvents: ResourceEventSummary[] = [];
  if (existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare(
        `SELECT event_id, sequence, run_id, description, wall_time FROM event_log WHERE event_type = 'resource' ORDER BY sequence DESC LIMIT 50`,
      ).all() as Array<{
        event_id: unknown;
        sequence: unknown;
        run_id: unknown;
        description: unknown;
        wall_time: unknown;
      }>;
      recentResourceEvents = rows.map((r) => deepFreeze({
        eventId: String(r.event_id),
        sequence: String(r.sequence),
        runId: r.run_id === null ? null : String(r.run_id),
        description: String(r.description),
        wallTime: String(r.wall_time),
      }));
    } finally {
      db.close();
    }
  }

  return wrapResult("metrics", deepFreeze({ snapshot, recentResourceEvents: deepFreeze(recentResourceEvents) }));
}

// ---------------------------------------------------------------------------
// harness rollback
// ---------------------------------------------------------------------------

export type RollbackRecentEffect = Readonly<{
  eventId: string;
  sequence: string;
  effectId: string | null;
  ledgerId: string;
  description: string;
  wallTime: string;
}>;

export type HarnessRollbackOutput = Readonly<{
  effectId: string | null;
  result: RollbackResult | null;
  recentEffects: readonly RollbackRecentEffect[];
}>;

export type HarnessRollbackOptions = Readonly<{
  effectId?: string;
}>;

/**
 * Roll back timeline effects from the CLI.
 *
 * With `--effect-id <id>`: resolve the effect across all ledgers, then drive
 * {@link createRollbackController}.execute against the matching ledger.
 * Without `--effect-id`: list recent `file-effect` events that are candidates
 * for rollback (the controller marks them reversible). Rollback appends a
 * `rollback` event; the original evidence is never modified (append-only).
 *
 * The `dbPath` override is an injection point for tests so they can point
 * at a fixture timeline database without going through the pinned config.
 */
export function harnessRollback(
  root: string,
  options: HarnessRollbackOptions = {},
  overrides: Readonly<{ dbPath?: string }> = {},
): HarnessCommandResult<HarnessRollbackOutput> {
  const dbPath = overrides.dbPath ?? (() => {
    const config = loadPinnedConfigSnapshot();
    const stateRoot = config.document.state.root;
    return join(root, stateRoot, "timeline.db");
  })();
  if (!existsSync(dbPath)) {
    return wrapResult("rollback", deepFreeze({
      effectId: options.effectId ?? null,
      result: null,
      recentEffects: [],
    }));
  }

  if (options.effectId !== undefined) {
    const lookupDb = new DatabaseSync(dbPath, { readOnly: true });
    let ledgerId: string;
    let sequence: string;
    try {
      const row = lookupDb.prepare(
        `SELECT ledger_id, sequence FROM event_log WHERE effect_id = ? ORDER BY sequence DESC LIMIT 1`,
      ).get(options.effectId) as { ledger_id: unknown; sequence: unknown } | undefined;
      if (row === undefined) {
        throw new InputError(
          `No timeline event found with effectId '${options.effectId}'`,
          "rollback_effect_not_found",
        );
      }
      ledgerId = String(row.ledger_id);
      sequence = String(row.sequence);
    } finally {
      lookupDb.close();
    }

    const store = createTimelineStore({ path: dbPath, ledgerId });
    try {
      const controller = createRollbackController(store);
      const result = controller.execute({ targetSequence: sequence, ledgerId });
      return wrapResult("rollback", deepFreeze({
        effectId: options.effectId,
        result,
        recentEffects: [],
      }));
    } finally {
      store.close();
    }
  }

  // No effect-id: list recent file-effect events as rollback candidates.
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(
      `SELECT event_id, sequence, effect_id, ledger_id, description, wall_time FROM event_log WHERE event_type = 'file-effect' ORDER BY sequence DESC LIMIT 20`,
    ).all() as Array<{
      event_id: unknown;
      sequence: unknown;
      effect_id: unknown;
      ledger_id: unknown;
      description: unknown;
      wall_time: unknown;
    }>;
    const recentEffects: RollbackRecentEffect[] = rows.map((r) => deepFreeze({
      eventId: String(r.event_id),
      sequence: String(r.sequence),
      effectId: r.effect_id === null ? null : String(r.effect_id),
      ledgerId: String(r.ledger_id),
      description: String(r.description),
      wallTime: String(r.wall_time),
    }));
    return wrapResult("rollback", deepFreeze({
      effectId: null,
      result: null,
      recentEffects: deepFreeze(recentEffects),
    }));
  } finally {
    db.close();
  }
}

function parseRollbackOptions(argv: readonly string[]): HarnessRollbackOptions {
  let effectId: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--effect-id" && index + 1 < argv.length) {
      effectId = argv[index + 1];
      index += 1;
    } else {
      throw unknownFlag("rollback", arg, ["--effect-id"]);
    }
  }
  if (effectId === undefined) return deepFreeze({});
  return deepFreeze({ effectId });
}

// ---------------------------------------------------------------------------
// harness extension
// ---------------------------------------------------------------------------

export type HarnessExtensionListOutput = Readonly<{
  extensions: readonly ExtensionManifestEntry[];
  total: number;
}>;

export type HarnessExtensionOutput = HarnessExtensionListOutput;

/**
 * List registered extensions from the in-memory extension manifest.
 *
 * The manifest is in-memory and empty at CLI start (extensions are
 * registered through the lifecycle/approval workflow, not through chat
 * tools), so this surfaces the current view without invoking the approval
 * workflow. Self-modification operations (install/edit/delete/upgrade/
 * downgrade/rollback) require the approval workflow with explicit user
 * approval and are not exposed as one-shot CLI mutations per the
 * self-modification governance gate.
 */
export function harnessExtensionList(): HarnessCommandResult<HarnessExtensionListOutput> {
  const manifest = createExtensionManifest();
  const extensions = manifest.entries();
  return wrapResult("extension", deepFreeze({
    extensions: deepFreeze([...extensions]),
    total: extensions.length,
  }));
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  process.exitCode = await runHarnessCli(process.argv.slice(2));
}
