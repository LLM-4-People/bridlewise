import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { HarnessError, InputError } from "../kernel/errors.ts";
import { deepFreeze, generateId, sha256 } from "../kernel/integrity.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { ensurePrivateStateDirectory } from "../filesystem/private-state.ts";
import { detectWriteSetConflictAmong } from "../agents/agent-config.ts";
import { DEFAULT_TIMELINE_QUERY_LIMIT, type TimelineConfig, type WorkspaceIsolationConfig } from "../kernel/config-contracts.ts";
import {
  bindTransientWriteRootCapability,
  compileExactWriteLease,
  EXACT_WRITE_LEASE_OPERATIONS,
  type ExactWriteEffect,
} from "../modules/effect-boundary/domain/write-lease.ts";
import type { GitIdentity } from "../git/git-port.ts";
import type { StatusEntry, WorktreeGitPort } from "../git/worktree-port.ts";
import { snapshotWorkingTree, type WorkingTreeSnapshot } from "../git/working-copy.ts";
import { indexFilePath } from "../git/repository-ownership.ts";
import { atomicWriteFile } from "../filesystem/atomic-write.ts";
import { blobSizes, ignoredCopies } from "../git/ignored-copies.ts";
import { createTimelineStore } from "../timeline/timeline-store.ts";
import type { EventLedgerStoragePort } from "../timeline/timeline-types.ts";
import { auditEvent } from "../shared/debug/debug-system.ts";
import { currentQualificationOutcome, qualificationTerminal, runForInvocation, diffRunFailures, failureIdentityFile, importJudgedRuns, latestRunOfTree, readRunHistory, runsOfTree, suiteLedgerPaths, type SuiteLedgerName } from "../shared/run-history.ts";
import { openTaskRows, ownersOf } from "./failure-owners.ts";
import { finiteNumber, type JudgedRunRecord, type RunQualificationTerminal } from "../shared/budget-verdict.ts";
import { acquireLock } from "./resource-lock.ts";
import { generatedOutputPaths, isGenerationOnlyChange } from "./hash-binding-registry.ts";
import { frozenAcceptancesBetween } from "./record-links.ts";
import { applyCheckoutFiles, assertSameFilesystem, removeGateLogs, runCheckoutPhase, runDeclaredCommands, settleCheckout, type CheckoutCommand, type CheckoutPhase, type CheckoutStep } from "./checkout-setup.ts";
import { LandingError, branchCheckout, commitCandidate, landCommit, refuseUndeclaredWrites } from "./tree-landing.ts";
import { importWorkspaceTimelineShard, openWorkspaceTimelineShard } from "./timeline-shard.ts";
import { createWorkspaceRecordStore, type WorkspaceRecordStore } from "./workspace-registry.ts";
import { repositoryRegistryArea, resolveRepositoryRegistry, workspaceRootOf, type RepositoryRegistry } from "./repository-registry.ts";
import { DEFAULT_MAXIMUM_PERSISTED_GATE_STRING_CHARACTERS } from "./workflow-config.ts";
import {
  assertLeasableWriteSet,
  assertWorkspaceAgentName,
  assertWorkspaceTransition,
  canonicalizeWriteSetPath,
  computeMergedSinceConflicts,
  computePendingWriteSetConflicts,
  computeUnleasedPaths,
  finalizeMergeReceipt,
  isTerminalWorkspaceState,
  recordedReason,
  WORKSPACE_SCHEMA_VERSION,
  type ConflictEntry,
  type ConflictReport,
  type MergeReceipt,
  type ValidationReport,
  type WorkspaceGateResult,
  type WorkspaceLanding,
  type WorkspaceOverlay,
  type WorkspaceRecord,
  type WorkspaceState,
  type WorkspaceTransition,
} from "./workspace-contracts.ts";


/** A budget's value in a ledger row: `field` is a dotted path (`performanceMeasurements.apiResponseMaxMs`); a non-finite or absent value is none. */
export function budgetFieldOf(row: unknown, field: string): number | undefined {
  let value: unknown = row;
  for (const key of field.split(".")) value = value !== null && typeof value === "object" ? (value as Readonly<Record<string, unknown>>)[key] : undefined;
  return finiteNumber(value) ?? undefined;
}
export { createWorkspaceRecordStore, type WorkspaceRecordStore } from "./workspace-registry.ts";

/**
 * Workspace manager — the lifecycle of isolated workspaces (git worktrees)
 * and the serialized integrator that lands them (`harness workspace`,
 * `npm run ws`).
 *
 * ONE REGISTRY PER REPOSITORY, in its git common directory
 * (`<common dir>/bridlewise/`: `workspaces/` the records, `locks/` the two
 * repository locks, `timeline/` the shards and the integrator's ledger), so
 * a command run from any checkout of the repository — the canonical one, a
 * workspace's own worktree — sees the same records and takes the same locks.
 *
 * Every record write is a compare-and-swap on its revision
 * (`workspace-registry.ts`): a command that read a record before another
 * wrote it (a validate that ran for an hour while an extend or an abort
 * happened) is refused, `workspace_record_changed`, never a lost update.
 *
 * CREATE: the target must be a declared land target
 *   (`workspaceIsolation.landTargets`: a product branch that changes only
 *   through its promotion door is never one) and a `--base` must be in the
 *   target's history; then, under the ADMISSION lock, the static write-set
 *   check against every pending lease and the record reserved as `admitted`;
 *   then — outside the lock — `git worktree add` at `<workspaceRoot>/<id>`
 *   (relative to the repository home, on the same filesystem), the checkout
 *   files (links, the config mode) and the `setup` phase (dependencies from
 *   the worktree's own lockfiles, native outputs, the bundle). Three kinds:
 *   - feature: branch `agent/<name>/<nonce>` at the target's tip (or `--base`);
 *   - overlay: a feature workspace started from `snapshotWorkingTree` of the
 *     invoking dirty checkout (its real index and files untouched), leased for
 *     what the snapshot changed; refused when a staged blob differs from both
 *     HEAD and the worktree, or a staged deletion's file is still on disk
 *     (the snapshot could not carry either), or when a deleted file's bytes
 *     sit at an ignored path (a move-loss);
 *   - read-only: a detached worktree for a verifier, no lease, never merges.
 * THE CHANGED SET is what `git merge` brings: the diff from the fork point
 *   with the target (`merge-base(target tip, HEAD)`) to HEAD. A changed path
 *   needs no lease only when its change is REGENERATION ONLY
 *   (`isGenerationOnlyChange`: a wholly generated output, or a pin or
 *   generated block re-derived with nothing authored changed); the
 *   merged-since and pending-lease checks judge the same authored set.
 * VALIDATE in the worktree, fail-fast: the write-set proof (clean worktree,
 *   authored changes ⊆ lease), the `validate` phase; with `--full` also
 *   `regenerate`, the `converged` check (nothing left uncommitted) and the
 *   `merge` phase.
 * LEDGER GATES (a command that declares its suite `ledger`) are judged like
 *   a qualification: the run's row against the BASELINE of the target's tip —
 *   a non-mutation run of the target's TREE (a row's `treeId`, the tree the
 *   run measured wherever it was taken: a candidate's qualification of the
 *   tree a commit landed is that commit's baseline; a row that names no tree
 *   measures none and is never a baseline), in the workspace's ledger or the landing checkout's; when none
 *   exists it is measured first, LIKE FOR LIKE, in the same worktree detached
 *   at the target's tip (`ensureTargetBaselines`: the row that run recorded
 *   is the baseline, whatever identity the target's runner wrote; a tip whose
 *   regenerate rewrites it, or a run that recorded nothing, is said so) —
 *   never a run demanded of a live checkout. A gate passes iff no failure is
 *   new and none fails differently; the land imports the qualifying rows (of
 *   the landed tree only) into the landing checkout's ledger.
 *   There is ONE judge (UR-17): no subset run re-judged by a full suite, and
 *   no new failure forgiven because its file passed when re-run alone.
 * MERGE (under the MERGE lock), in the WORKSPACE, never in a checkout anyone
 *   else uses: the land-target, lease, staleness, merged-since and
 *   pending-lease checks; detach at the target's tip T; `merge --no-ff
 *   --no-commit --no-autostash` of the branch; a conflict on a generated
 *   output whose branch-side change is regeneration only is resolved to T's
 *   side — any other is reported; the `regenerate` phase, whose writes must
 *   all be generated outputs; then ONE `git commit`, which runs the
 *   repository's hooks (the commit guard certifies the merge commit M like
 *   any commit); the `merge` phase (skipped when M's tree is the tree
 *   `validate --full` qualified); the convergence check; then the LAND:
 *   `merge --ff-only --no-autostash M` in the checkout that has the target
 *   checked out (git refuses, changing nothing, if that would touch its
 *   dirty, staged or untracked state, or if the target moved), a
 *   compare-and-swap `update-ref` when no checkout has it, or the overlay's
 *   adoption into the checkout it came from (only while that checkout still
 *   holds exactly the snapshot and the same index). A failure before the land
 *   that the integrator survives leaves every checkout untouched: the
 *   worktree goes back to its branch and the record to `active` (to
 *   `validating` when git refused the land itself: nothing the validation
 *   judged changed). Then the timeline import, teardown and the hashed
 *   receipt.
 * RECOVER: an integrator that DIED (killed, out of memory, a tool timeout)
 *   leaves its record `merging`. Holding the merge lock proves no integrator
 *   runs; `recover` (and `sweep`) then finish a land that happened (`merged`)
 *   or put the worktree back on its branch (`active`).
 * ABORT removes the worktree and branch (or quarantines them); SWEEP ends
 *   expired leases, recovers dead integrators' records and removes
 *   quarantined worktrees past their retention.
 */

const WORKSPACE_INTEGRATOR_LEDGER_ID = "workspace-integrator" as const;
const TRUNCATION_MARKER = "...[truncated]";

/** One gate's outcome as a command step reports it (a built-in gate is built the same way). */
export type WorkspaceGateOutcome = CheckoutStep;

/**
 * The commands port: the production one runs each declared command under
 * the native supervisor (`checkoutCommandRunner`); tests inject fakes.
 */
export type WorkspaceCommands = Readonly<{
  run(checkoutRoot: string, name: string, command: CheckoutCommand): Promise<WorkspaceGateOutcome>;
}>;

export type WorkspaceManagerTimeouts = Readonly<{
  /** Worktree add/remove/switch and the land. */
  worktreeMs: number;
  /** Repository inspection. */
  inspectMs: number;
  /** The merge commit, which runs the repository's commit hooks. */
  mergeMs: number;
}>;

export type WorkspaceTimelineHooks = Readonly<{
  queryDefaultLimit?: TimelineConfig["queryDefaultLimit"];
  openShard(workspaceId: string): EventLedgerStoragePort;
  openCanonical(): EventLedgerStoragePort;
}>;

export type WorkspaceManagerOptions = Readonly<{
  /** Any directory inside the checkout the command runs from. */
  checkoutRoot: string;
  /** The engine root's path relative to a checkout's top level (derived by the caller). */
  engineRelative: string;
  config: WorkspaceIsolationConfig;
  git: WorktreeGitPort;
  commands: WorkspaceCommands;
  timeouts: WorkspaceManagerTimeouts;
  /** The integrator's commit identity; absent: the repository's configured identity. */
  identity?: GitIdentity;
  records?: WorkspaceRecordStore;
  timeline?: WorkspaceTimelineHooks | null;
  /** The one snapshot of a dirty tree (tests may observe it). */
  snapshot?: typeof snapshotWorkingTree;
  now?: () => Date;
  /** Told what the manager is doing (an operator's progress line). */
  onProgress?: (line: string) => void;
}>;

export type WorkspaceCreateRequest = Readonly<{
  agentName: string;
  mode: "feature" | "overlay" | "read-only";
  /** Leased paths (feature; added to an overlay's own changed set). */
  writeSet: readonly string[];
  /** The commit a feature or read-only workspace starts at (default: the target's tip; read-only: HEAD). */
  base?: string;
  /** The branch a feature workspace lands on (default: the branch checked out where the command runs). */
  target?: string;
}>;

export type WorkspaceManager = Readonly<{
  registry: RepositoryRegistry;
  create(request: WorkspaceCreateRequest): Promise<WorkspaceRecord>;
  extend(workspaceId: string, writeSet: readonly string[]): Promise<WorkspaceRecord>;
  validate(workspaceId: string, options?: Readonly<{ full?: boolean }>): Promise<ValidationReport>;
  merge(workspaceId: string): Promise<MergeReceipt>;
  /** Finishes or rolls back a merge whose integrator died (see `recover` below). */
  recover(workspaceId: string): Promise<WorkspaceRecord>;
  abort(workspaceId: string, options?: Readonly<{ quarantine?: boolean; reason?: string }>): WorkspaceRecord;
  snapshot(workspaceId: string, label: string): WorkingTreeSnapshot;
  list(): readonly WorkspaceRecord[];
  status(workspaceId: string): WorkspaceRecord;
  sweep(): Promise<readonly string[]>;
}>;

export class WorkspaceConflictError extends HarnessError {
  readonly report: ConflictReport;
  constructor(report: ConflictReport) {
    super(
      `workspace conflict (${report.kind}): ${report.conflicts.map((entry) => entry.path).join(", ")}`,
      "workspace_conflict",
      false,
      { kind: report.kind, count: report.conflicts.length },
    );
    this.report = report;
  }
}

export class WorkspaceLeaseExpiredError extends HarnessError {
  constructor(workspaceId: string) {
    super(`workspace lease for ${workspaceId} has expired`, "workspace_lease_expired", false, { workspaceId });
  }
}

export class WorkspaceIntegrityError extends HarnessError {
  constructor(workspaceId: string, detail: string) {
    super(`workspace ${workspaceId} worktree integrity failed: ${detail}`, "workspace_integrity_failed", false, { workspaceId });
  }
}

/** A phase's gate failed (setup, regenerate or merge): nothing landed. */
export class WorkspaceGateFailedError extends HarnessError {
  readonly gateResults: readonly WorkspaceGateResult[];
  constructor(workspaceId: string, phase: string, gateResults: readonly WorkspaceGateResult[], code = "workspace_gate_failed") {
    const failing = gateResults.filter((gate) => gate.status === "fail");
    const failed = failing.map((gate) => gate.gate).join(", ");
    // Each failed gate's own words and its output tail: the operator reads
    // WHY here, not only which gate.
    const why = failing.map((gate) => `${gate.gate}: ${gate.message}${gate.details.length === 0 ? "" : `\n${gate.details.join("\n")}`}`).join("\n");
    super(`workspace ${workspaceId}: the ${phase} phase failed (${failed}); nothing landed\n${why}`, code, false, { workspaceId, phase, failed });
    this.gateResults = gateResults;
  }
}

/** Cap one gate outcome at the persistence boundary (reports, receipts). */
function persistedGate(outcome: WorkspaceGateOutcome): WorkspaceGateResult {
  const cap = (text: string): string =>
    text.length <= DEFAULT_MAXIMUM_PERSISTED_GATE_STRING_CHARACTERS
      ? text
      : `${text.slice(0, DEFAULT_MAXIMUM_PERSISTED_GATE_STRING_CHARACTERS - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
  return deepFreeze({ gate: outcome.step, status: outcome.status, message: cap(outcome.message), details: deepFreeze(outcome.details.map(cap)) });
}

function builtinGate(gate: string, status: CheckoutStep["status"], message: string, details: readonly string[] = []): WorkspaceGateOutcome {
  return deepFreeze({ step: gate, status, message, details: deepFreeze([...details]) });
}

/** The timeline stores of a registry: per-workspace shards and the integrator's ledger, in its `timeline/` area. */
export function createWorkspaceTimelineHooks(
  registry: RepositoryRegistry,
  timelineConfig?: Partial<TimelineConfig>,
): WorkspaceTimelineHooks {
  // Timeline configuration consists of scalar values. Capture the same
  // immutable selection for every later store open and import page limit.
  const capturedConfig = timelineConfig !== undefined ? deepFreeze({ ...timelineConfig }) : undefined;
  const dbFilename = capturedConfig?.dbFilename ?? "timeline.db";
  const stateRootAbsolute = ensurePrivateStateDirectory(repositoryRegistryArea(registry, "timeline"));
  return deepFreeze({
    queryDefaultLimit: capturedConfig?.queryDefaultLimit ?? DEFAULT_TIMELINE_QUERY_LIMIT,
    openShard(workspaceId: string): EventLedgerStoragePort {
      return openWorkspaceTimelineShard({ stateRootAbsolute, workspaceId, ...(capturedConfig !== undefined ? { timelineConfig: capturedConfig } : {}) });
    },
    openCanonical(): EventLedgerStoragePort {
      return createTimelineStore({
        path: join(stateRootAbsolute, dbFilename),
        ledgerId: WORKSPACE_INTEGRATOR_LEDGER_ID,
        ...(capturedConfig !== undefined ? { timelineConfig: capturedConfig } : {}),
      });
    },
  });
}

/** The paths the status names (the port's one reader, `StatusEntry`). */
function statusPaths(entries: readonly StatusEntry[]): readonly string[] {
  return entries.map((entry) => entry.path);
}

/** THE ONE EXPIRY PREDICATE: `record`'s lease ran out before `nowMs` (admission, every verb and the sweep ask here). */
function leaseExpired(record: WorkspaceRecord, nowMs: number): boolean {
  return nowMs > new Date(record.lease.expiresAt).getTime();
}

/** The paths whose WORKING-TREE side differs from the index (unstaged, or untracked): what ran after the staging wrote. */
function unstagedStatusPaths(entries: readonly StatusEntry[]): readonly string[] {
  return statusPaths(entries.filter((entry) => entry.unstaged || entry.untracked));
}

export function createWorkspaceManager(options: WorkspaceManagerOptions): WorkspaceManager {
  const { config, git, commands, timeouts } = options;
  const timeline = options.timeline ?? null;
  const now = options.now ?? (() => new Date());
  const snapshot = options.snapshot ?? snapshotWorkingTree;
  const progress = options.onProgress ?? ((): void => undefined);
  const checkoutRoot = git.toplevel(resolve(options.checkoutRoot), timeouts.inspectMs);
  const registry = resolveRepositoryRegistry(git, checkoutRoot, timeouts.inspectMs);
  const store = options.records ?? createWorkspaceRecordStore(repositoryRegistryArea(registry, "workspaces"));
  const lockDirectory = repositoryRegistryArea(registry, "locks");
  const workspaceRoot = workspaceRootOf(registry, config.workspaceRoot);
  const snapshotIdentity = options.identity === undefined ? {} : { identity: options.identity };

  function iso(date: Date): string {
    return date.toISOString();
  }

  async function withRepositoryLock<T>(lock: WorkspaceIsolationConfig["mergeLock"], owner: string, work: () => Promise<T> | T): Promise<T> {
    ensurePrivateStateDirectory(lockDirectory);
    const handle = await acquireLock(registry.root, lock.name, { lockDirectory, timeoutMs: lock.timeoutMs, unreadableAfterMs: lock.staleMs, owner });
    try {
      return await work();
    } finally {
      handle.release();
    }
  }

  function requireRecord(workspaceId: string): WorkspaceRecord {
    const record = store.load(workspaceId);
    if (record === null) throw new InputError(`workspace ${workspaceId} does not exist`, "workspace_not_found");
    return record;
  }

  function transition(record: WorkspaceRecord, to: WorkspaceState, reason: string): WorkspaceRecord {
    assertWorkspaceTransition(record.state, to);
    const entry: WorkspaceTransition = deepFreeze({ from: record.state, to, at: iso(now()), reason: recordedReason(reason) });
    return deepFreeze({ ...record, state: to, history: deepFreeze([...record.history, entry]) });
  }

  /** Every write goes through the store's compare-and-swap: `record` must be the stored revision; returns the new one. */
  function saveTransition(record: WorkspaceRecord, to: WorkspaceState, reason: string): WorkspaceRecord {
    return store.save(transition(record, to, reason));
  }

  function recordTimelineEvent(
    scope: "shard" | "canonical",
    record: WorkspaceRecord,
    description: string,
    outcome?: "succeeded" | "failed" | "cancelled",
  ): void {
    if (timeline === null) return;
    const ledger = scope === "shard" ? timeline.openShard(record.workspaceId) : timeline.openCanonical();
    try {
      ledger.appendEvent({
        eventId: generateId("workspace-event"),
        ledgerId: ledger.ledgerId,
        eventType: "agent",
        actor: deepFreeze({ kind: "harness", id: "workspace-manager" }),
        correlation: deepFreeze({ agentId: record.agentName, taskId: record.workspaceId }),
        description,
        wallTime: iso(now()),
        ...(outcome !== undefined ? { outcome } : {}),
      });
    } finally {
      ledger.close();
    }
  }

  function buildConflictReport(kind: ConflictReport["kind"], workspaceId: string, conflicts: readonly ConflictEntry[]): ConflictReport {
    return deepFreeze({ schemaVersion: WORKSPACE_SCHEMA_VERSION, kind, workspaceId, conflicts, detectedAt: iso(now()) });
  }

  function refuse(record: WorkspaceRecord, kind: ConflictReport["kind"], conflicts: readonly ConflictEntry[], reason: string): never {
    const conflictReport = buildConflictReport(kind, record.workspaceId, conflicts);
    saveTransition(deepFreeze({ ...record, conflictReport }), "active", reason);
    auditEvent("workspace-merge-refused", { workspaceId: record.workspaceId, kind, paths: conflicts.map((entry) => entry.path) });
    throw new WorkspaceConflictError(conflictReport);
  }

  function quarantineRecord(record: WorkspaceRecord, reason: string): WorkspaceRecord {
    const worktreePath = record.lease.worktreePath;
    if (existsSync(worktreePath)) {
      try {
        git.worktreeLock({ repoRoot: checkoutRoot, worktreePath, reason, timeoutMs: timeouts.worktreeMs });
      } catch (error) {
        // A worktree git can no longer lock (already locked, a broken .git
        // entry) is still preserved: quarantine only records the decision.
        if (!(error instanceof HarnessError)) throw error;
      }
    }
    const updated = saveTransition(deepFreeze({ ...record, abortReason: recordedReason(reason) }), "quarantined", reason);
    recordTimelineEvent("canonical", updated, `workspace-quarantined: ${reason}`, "failed");
    auditEvent("workspace-quarantined", { workspaceId: record.workspaceId, reason });
    return updated;
  }

  /** The prefix of a workspace's `snapshot` refs (`<namespace>/<id>.<label>`). */
  const snapshotRefPrefix = (workspaceId: string): string => `${ROOT_POLICY.verification.workingTreeSnapshot.refNamespace}/${workspaceId}.`;

  function removeWorktreeAndBranch(record: WorkspaceRecord): void {
    const worktreePath = record.lease.worktreePath;
    if (existsSync(worktreePath)) {
      removeGateLogs(worktreePath);
      git.worktreeRemove({ repoRoot: checkoutRoot, worktreePath, force: true, timeoutMs: timeouts.worktreeMs });
    } else {
      git.worktreePrune(checkoutRoot, timeouts.worktreeMs);
    }
    // Its recovery points go with it (A5-design L4: they outlived every merge
    // and abort); a quarantine keeps them, with the worktree, for inspection.
    for (const [ref, sha] of git.refsUnder(checkoutRoot, snapshotRefPrefix(record.workspaceId), timeouts.inspectMs)) {
      git.deleteRef(checkoutRoot, ref, sha, timeouts.inspectMs);
    }
    if (record.lease.branch === null) return;
    try {
      git.deleteBranch(checkoutRoot, record.lease.branch, true, timeouts.worktreeMs);
    } catch (error) {
      // A branch already gone (a create that failed before `worktree add`
      // made it) leaves nothing to delete.
      if (!(error instanceof HarnessError)) throw error;
    }
  }

  function abortInternal(record: WorkspaceRecord, quarantine: boolean, reason: string): WorkspaceRecord {
    if (isTerminalWorkspaceState(record.state)) return record;
    if (record.state === "merging") {
      throw new InputError(`workspace ${record.workspaceId} is merging; the integrator owns it`, "workspace_abort_denied");
    }
    if (quarantine) return quarantineRecord(record, reason);
    removeWorktreeAndBranch(record);
    const updated = saveTransition(deepFreeze({ ...record, abortReason: recordedReason(reason) }), "aborted", reason);
    recordTimelineEvent("canonical", updated, `workspace-aborted: ${reason}`, "cancelled");
    auditEvent("workspace-aborted", { workspaceId: record.workspaceId, reason });
    return updated;
  }

  function assertLeaseLive(record: WorkspaceRecord): void {
    if (leaseExpired(record, now().getTime())) {
      abortInternal(record, config.preserveOnFailure, "lease-expired");
      throw new WorkspaceLeaseExpiredError(record.workspaceId);
    }
  }

  function assertWorktreeIntact(record: WorkspaceRecord): void {
    if (!git.verifyWorktreeIntact(record.lease.worktreePath, timeouts.inspectMs)) {
      quarantineRecord(record, "worktree .git entry missing or gitdir unreadable");
      throw new WorkspaceIntegrityError(record.workspaceId, "worktree .git entry missing or gitdir unreadable");
    }
  }

  /** The tree of a commit, or null when the repository does not hold it (a row of a foreign checkout). */
  const commitTrees = new Map<string, string | null>();
  function treeOf(commit: string): string | null {
    if (!commitTrees.has(commit)) {
      let tree: string | null = null;
      try {
        tree = git.revParse(checkoutRoot, `${commit}^{tree}`, timeouts.inspectMs);
      } catch (error) {
        if (!(error instanceof HarnessError)) throw error;
      }
      commitTrees.set(commit, tree);
    }
    return commitTrees.get(commit)!;
  }

  /** The checkout a land writes into, if any: the overlay's own, else the one that has the target checked out (none: the land is a ref update). */
  function landingCheckout(record: WorkspaceRecord): string | null {
    if (record.lease.overlay !== null) return record.lease.overlay.checkout;
    const target = record.lease.targetBranch;
    if (target === null) return null;
    return branchCheckout(git, checkoutRoot, target, timeouts.inspectMs);
  }

  /** The ledger files a target baseline may sit in: the workspace's own and the landing checkout's (never an unrelated checkout's). */
  function baselineLedgers(record: WorkspaceRecord, cwd: string, ledger: SuiteLedgerName): readonly string[] {
    const relative = suiteLedgerPaths(options.engineRelative)[ledger];
    const holder = landingCheckout(record);
    return [...new Set([cwd, ...(holder === null ? [] : [holder])].map((root) => join(root, relative)))];
  }

  /**
   * THE BASELINE OF A TARGET: the latest row, recorded before `before`, of a
   * run that measured `targetTip`'s TREE — keyed by the tree, never by where
   * the run was taken: a row whose `treeId` is the target's tree (a
   * candidate's qualification of exactly the tree a commit later landed, a
   * workspace's, the landing checkout's own; `latestRunOfTree`). Never a
   * mutation run; a row of another tree, or one that names no tree, is never
   * a baseline.
   */
  function targetBaseline(paths: readonly string[], targetTip: string, before: number): JudgedRunRecord | undefined {
    const tree = treeOf(targetTip);
    if (tree === null) return undefined;
    return latestRunOfTree(paths.flatMap((path) => readRunHistory(path)), tree, before);
  }

  /** The runs of `tree` recorded before `before` INSIDE the host's one instrument lock: the only rows a budget is judged against. */
  function slottedRunsOfTree(paths: readonly string[], tree: string, before: number): readonly JudgedRunRecord[] {
    return runsOfTree(paths.flatMap((path) => readRunHistory(path)), tree)
      .filter((row) => row.heavySlot === "held" && Date.parse(row.timestamp ?? "") < before);
  }

  /**
   * The command that measures a ledger — its suite's gate: the merge phase's
   * command of that ledger, the one owner of "which command answers for a
   * ledger" for the baseline measurement ({@link ensureTargetBaselines}).
   */
  function ledgerSuiteCommand(ledger: SuiteLedgerName): string | undefined {
    return config.phases.merge.find((name) => config.commands[name]?.ledger === ledger);
  }

  /** What a ledger gate is judged against: the target's tip (null: a read-only workspace, which lands nothing). */
  type LedgerJudge = Readonly<{ record: WorkspaceRecord; targetTip: string | null }>;

  /**
   * A gate that declares its `ledger` is judged like a qualification: its
   * run's row (it must have recorded one: a cold, refused or crashed run
   * measures nothing) against the target's baseline ({@link targetBaseline},
   * measured like for like by {@link ensureTargetBaselines}). It passes iff it
   * fails nothing new, no persisting failure fails differently (a changed
   * digest: a new defect under an old identity), and every failure that
   * persists from the target is OWNED — an open task row names its test's
   * repository path (src/workflow/failure-owners.ts; UR-24). Nothing else decides: a new
   * failure is a regression even when its file would pass alone (a flaky test
   * is fixed at its cause, never re-run until it passes).
   */
  function currentTreeUnchanged(cwd: string, tree: string): boolean {
    return git.status(cwd, timeouts.inspectMs).length === 0 && git.revParse(cwd, "HEAD^{tree}", timeouts.inspectMs) === tree;
  }

  async function judgedByLedger(cwd: string, name: string, command: CheckoutCommand, judge: LedgerJudge): Promise<WorkspaceGateOutcome> {
    const ledger = command.ledger;
    if (ledger === undefined) return commands.run(cwd, name, command);
    // The current command must measure this clean committed tree, including
    // in read-only workspaces. Historical target lookup remains separate.
    if (git.status(cwd, timeouts.inspectMs).length > 0) return builtinGate(name, "fail", "current qualification requires a clean checkout before execution");
    const tree = git.revParse(cwd, "HEAD^{tree}", timeouts.inspectMs);
    const outcome = await commands.run(cwd, name, command);
    if (!currentTreeUnchanged(cwd, tree)) {
      return builtinGate(name, "fail", "current qualification tree changed during execution", outcome.details);
    }
    const invocationId = outcome.evidence?.invocationId;
    const terminal = outcome.evidence?.terminal;
    if (outcome.status === "skip" || invocationId === undefined || terminal === undefined) {
      return builtinGate(name, "fail", "current suite command has no invocation-bound terminal evidence", outcome.details);
    }
    const ledgerPath = suiteLedgerPaths(options.engineRelative)[ledger];
    const current = runForInvocation(join(cwd, ledgerPath), invocationId);
    let outer: RunQualificationTerminal;
    try { outer = qualificationTerminal(invocationId, tree, terminal); }
    catch (error) {
      if (!(error instanceof HarnessError) || error.code !== "qualification_terminal_invalid") throw error;
      return builtinGate(name, "fail", "current suite command has malformed invocation-bound terminal evidence", outcome.details);
    }
    const budgets: Readonly<Record<string, Readonly<{ budget: string; field: string }>>> = ROOT_POLICY.workflow.failureOwners.budgets[ledger];
    const completion = currentQualificationOutcome(current, { invocationId, treeId: tree, producer: ledger, outer, judgedBudgets: new Set(Object.keys(budgets)) });
    if (completion.kind !== "pass" || current === undefined) return builtinGate(name, "fail", completion.message, outcome.details);
    // A budget gate that did not PASS is a breach to judge: a "not-judged" there is no softer than a "fail"
    // (UR-24-BUDGETS; design M-A: unmeasured is never a pass). It passes only as owned and not worse.
    const breaches = (current.qualification?.outcomes ?? []).filter((gate) => gate.kind !== "pass" && budgets[gate.gate] !== undefined);
    if (judge.targetTip === null) {
      return builtinGate(name, (current.failures?.length ?? 0) === 0 && breaches.length === 0 ? "pass" : "fail",
        `${completion.message}; ${String(current.failures?.length ?? 0)} current test failure(s), ${String(breaches.length)} budget breach(es); read-only validation has no target comparison`, outcome.details);
    }
    const before = Date.parse(current.timestamp!);
    const measured = measuredBaselines.get(baselineKey(judge.targetTip, ledger));
    const reference = targetBaseline(baselineLedgers(judge.record, cwd, ledger), judge.targetTip, before);
    if (reference === undefined) {
      return builtinGate(name, "fail",
        `unmeasured: no run of the target's tree (${judge.targetTip}) in ${ledgerPath} to judge this run against${measured?.why === undefined ? "" : `: ${measured.why}`}`,
        [...(measured?.paths ?? []), ...outcome.details]);
    }
    const diff = diffRunFailures(reference, current);
    if (diff.verdict === "unmeasured") return builtinGate(name, "fail", `unmeasured against ${reference.timestamp ?? "the baseline"}: ${diff.reason}`, outcome.details);
    // OWNED, OR REFUSED: a failure that persists from the target's recorded
    // run is accepted only when an open task row of the owner tracker names
    // its test's repository path — the user's policy "zero new failures, and
    // every remaining failure owned by a named task". One judgement: nothing
    // is re-run, nothing else decides.
    const trackerPath = ROOT_POLICY.workflow.failureOwners.tracker;
    let tracker: string;
    try {
      tracker = readFileSync(join(cwd, trackerPath), "utf8");
    } catch (error) {
      return builtinGate(name, "fail", `the failure owners' tracker ${trackerPath} is unreadable (${(error as NodeJS.ErrnoException).code ?? "unknown"}), so no persisting failure can be judged owned`, outcome.details);
    }
    const rows = openTaskRows(tracker);
    const repositoryPath = (identity: string): string | null => {
      const file = failureIdentityFile(identity);
      return file === null ? null : ledger === "engine" ? `${options.engineRelative}/${file}` : file;
    };
    const persisting = diff.persisting.filter((identity) => !diff.changed.includes(identity)).map((identity) => {
      const path = repositoryPath(identity);
      return { identity, path, owners: path === null ? [] : ownersOf(rows, path) };
    });
    const owned = persisting.filter((entry) => entry.owners.length > 0);
    const unowned = persisting.filter((entry) => entry.owners.length === 0);
    const counts = `${diff.persisting.length} persisting (${owned.length} owned), ${diff.fixed.length} fixed, against the run of ${judge.targetTip} at ${reference.timestamp ?? "(unstamped)"}`;
    const regressions = [
      ...diff.new,
      ...diff.changed.map((identity) => `${identity} (fails differently now)`),
      ...unowned.map((entry) => `${entry.identity} (persists from the target, but no open task row of ${trackerPath} names ${entry.path ?? "its file"})`),
    ];
    const ownedDetails = owned.map((entry) => `${entry.identity} (an owned failure: persists on the target with the same digest; owner ${entry.owners.join(", ")})`);
    // THE BUDGETS, IN THE SAME JUDGEMENT (UR-24, the coordinator's budget
    // amendment): a breach passes only when it persists from the target NOT
    // WORSE — this change's value no higher than the LOWEST value the target's
    // tree recorded inside the host's one instrument lock — and an open task
    // row declares the budget. Only SLOTTED rows of the target count (an
    // unslotted one may have shared the cores); a target with none is
    // measured in the lock first ({@link ensureTargetBaselines}). A breach
    // with no slotted target value, a worse one, an unslotted measurement or
    // an unowned breach fails. No allowance, no re-run.
    const targetTree = treeOf(judge.targetTip);
    const baseRows = targetTree === null ? [] : slottedRunsOfTree(baselineLedgers(judge.record, cwd, ledger), targetTree, before);
    const budgetVerdicts = breaches.map((breach) => {
      const spec = budgets[breach.gate]!;
      const field = (row: unknown): number | undefined => budgetFieldOf(row, spec.field);
      const value = field(current);
      const baseValues = baseRows.map(field).filter((v): v is number => v !== undefined);
      const lowest = baseValues.length === 0 ? undefined : Math.min(...baseValues);
      const owners = ownersOf(rows, spec.budget);
      const base = lowest === undefined ? "the target recorded no slotted value"
        : `the target's lowest of ${String(baseValues.length)} slotted value(s) is ${lowest.toFixed(1)}`;
      const reason = current.heavySlot !== "held" ? "this measurement did not hold the instrument lock: refused, not judged"
        : value === undefined || lowest === undefined ? `unmeasured: ${value === undefined ? "this run" : "the target"} recorded no slotted ${spec.field}`
          : value > lowest ? `WORSE than the target: ${value.toFixed(1)} > ${lowest.toFixed(1)}`
            : owners.length === 0 ? `persists from the target not worse, but no open task row of ${trackerPath} declares ${spec.budget}`
              : undefined;
      const line = `${breach.gate} (${spec.budget}): ${value === undefined ? "no value" : value.toFixed(1)}; ${base}`;
      return { pass: reason === undefined, line: reason === undefined ? `${line}; persists from the target, not worse; owner ${owners.join(", ")}` : `${line}; ${reason}` };
    });
    const budgetFails = budgetVerdicts.filter((verdict) => !verdict.pass).map((verdict) => verdict.line);
    const budgetOwned = budgetVerdicts.filter((verdict) => verdict.pass).map((verdict) => verdict.line);
    return regressions.length === 0 && budgetFails.length === 0
      ? builtinGate(name, "pass", `${completion.message}; no new, changed or unowned failure (${counts}); ${String(budgetOwned.length)} owned budget breach(es), none worse`, [...ownedDetails, ...budgetOwned])
      : builtinGate(name, "fail", `${diff.new.length} new, ${diff.changed.length} changed and ${unowned.length} unowned failure(s), ${String(budgetFails.length)} refused budget breach(es) (${counts})`, [...regressions, ...budgetFails, ...ownedDetails, ...budgetOwned]);
  }

  /** A phase in `cwd`, fail-fast, through the commands port; ledger gates are judged by `judge`. */
  async function runPhase(cwd: string, phase: CheckoutPhase, judge: LedgerJudge): Promise<readonly WorkspaceGateResult[]> {
    const steps = await runCheckoutPhase(config, phase, (name, command) => {
      // A read-only workspace (a verifier's) runs no heavy setup instrument: it runs single files, its first run warms
      // the module cache, and its create never waits for the instrument lock a validate holds.
      if (command.holdsInstrumentLock === true && judge.record.lease.kind === "read-only") {
        return Promise.resolve(builtinGate(name, "skip", "a read-only workspace does not run a heavy setup instrument: its first run warms the cache, and its create never waits for the instrument lock"));
      }
      progress(`${phase}: ${name}`);
      return judgedByLedger(cwd, name, command, judge);
    });
    return deepFreeze(steps.map(persistedGate));
  }

  /**
   * The target tips THIS manager measured, by tip and ledger (each once per
   * process), and why a measurement yielded no {@link targetBaseline} when it
   * did not: the gate's "unmeasured" message names it. The baseline itself is
   * only ever the row found by the tree it measured — never a row adopted
   * because this manager ran it (WF-1b3c-FIX MED-3).
   */
  const measuredBaselines = new Map<string, Readonly<{ why?: string; paths?: readonly string[] }>>();
  const baselineKey = (targetTip: string, ledger: SuiteLedgerName): string => `${targetTip}\u0000${ledger}`;

  /**
   * EVERY MOVE OF A WORKTREE KEEPS ITS CHECKOUT FILES: a checkout or a merge
   * inside a workspace's worktree rewrites each file it changes with git's own
   * mode (0644, or 0664 under the usual umask), so the config document's
   * required 0600 is re-applied after every move, as at create
   * ({@link applyCheckoutFiles}). Without it the next harness command in the
   * worktree refuses the config (`config_mode_insecure`): measured, a target
   * baseline's checkout and the return to the branch left it 0664 and the
   * workspace's own harness-sync gate failed.
   */
  function moveWorktree(worktreePath: string, move: () => void): void {
    move();
    settleCheckout(worktreePath, options.engineRelative);
  }

  /**
   * LIKE FOR LIKE: before `phase`'s ledger gates judge the workspace, each
   * LEDGER they answer for must have a {@link targetBaseline} — a run of the
   * target's TREE recorded anywhere this repository keeps one (a candidate's
   * qualification of the tree a commit landed, imported by its copy-back; a
   * workspace's land). One that has none is measured HERE, in the same
   * worktree on the same machine: detached at the target's tip, the
   * `regenerate` phase (the target's own build outputs; a tip it rewrites is
   * not measurable as committed, and is said so), then each such ledger's
   * suite command ({@link ledgerSuiteCommand}), whose recorded row —
   * carrying the tree it measured — is then found as that tip's baseline like
   * any other (when it is not, {@link measuredBaselines} says why); then
   * `back` returns the worktree to where it was. Never a run of a live
   * checkout.
   */
  async function ensureTargetBaselines(record: WorkspaceRecord, cwd: string, phase: CheckoutPhase, targetTip: string, back: () => void): Promise<void> {
    const wanted = [...new Set(config.phases[phase].flatMap((name) => {
      const ledger = config.commands[name]?.ledger;
      return ledger === undefined ? [] : [ledger];
    }))];
    // A ledger whose budgets are judged needs a SLOTTED run of the target too:
    // an unslotted baseline judges the failures, never a budget.
    const targetTree = treeOf(targetTip);
    // A slotted target run must carry the value of every budget an open task
    // row OWNS (only an owned breach can pass, and only against the target's
    // slotted value; a perf budget's comes from the profile step its suite
    // requires). A target without one is measured here, in the lock.
    const trackerText = (() => {
      try {
        return readFileSync(join(cwd, ROOT_POLICY.workflow.failureOwners.tracker), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
      }
    })();
    const taskRows = openTaskRows(trackerText);
    const budgetFields = (ledger: SuiteLedgerName): readonly string[] => Object.values(ROOT_POLICY.workflow.failureOwners.budgets[ledger] as Readonly<Record<string, Readonly<{ budget: string; field: string }>>>)
      .filter((spec) => ownersOf(taskRows, spec.budget).length > 0).map((spec) => spec.field);
    const missing = wanted.filter((ledger) => !measuredBaselines.has(baselineKey(targetTip, ledger)) &&
      (targetBaseline(baselineLedgers(record, cwd, ledger), targetTip, Number.POSITIVE_INFINITY) === undefined ||
        (budgetFields(ledger).length > 0 && targetTree !== null &&
          !slottedRunsOfTree(baselineLedgers(record, cwd, ledger), targetTree, Number.POSITIVE_INFINITY)
            .some((row) => budgetFields(ledger).every((path) => budgetFieldOf(row, path) !== undefined)))));
    if (missing.length === 0) return;
    progress(`baseline: measuring ${missing.join(", ")} at the target's tip ${targetTip}`);
    moveWorktree(cwd, () => git.checkoutDetached(cwd, targetTip, timeouts.worktreeMs, true));
    try {
      await runCheckoutPhase(config, "regenerate", (name, command) => commands.run(cwd, name, command));
      const rewritten = statusPaths(git.status(cwd, timeouts.inspectMs));
      for (const ledger of missing) {
        const name = ledgerSuiteCommand(ledger);
        if (name === undefined) {
          measuredBaselines.set(baselineKey(targetTip, ledger), { why: `no suite command of the ${ledger} ledger exists to measure its baseline` });
          continue;
        }
        if (rewritten.length > 0) {
          measuredBaselines.set(baselineKey(targetTip, ledger), { why: `the regenerate phase rewrote ${String(rewritten.length)} path(s) at the target's tip: its committed tree is not converged, so no run there measures it`, paths: rewritten });
          continue;
        }
        const started = now().getTime();
        // Through the one sequencer: the suite's producers run first, as in its gate.
        const outcome = (await runDeclaredCommands(config, "baseline", [name], (step, command) => commands.run(cwd, step, command))).at(-1)!;
        const row = readRunHistory(join(cwd, suiteLedgerPaths(options.engineRelative)[ledger])).at(-1);
        const left = statusPaths(git.status(cwd, timeouts.inspectMs));
        measuredBaselines.set(baselineKey(targetTip, ledger),
          row === undefined || !(Date.parse(row.timestamp ?? "") >= started) || row.mutation === true
            ? { why: `the target's baseline run (${name}) recorded no judged run (${outcome.message})` }
            : left.length > 0
              ? { why: `the target's baseline run (${name}) left ${String(left.length)} path(s) changed: it did not measure the committed tree`, paths: left }
              : targetBaseline(baselineLedgers(record, cwd, ledger), targetTip, Number.POSITIVE_INFINITY) === undefined
                ? { why: `the target's baseline run (${name}) recorded a run that names no tree of the target (its runner records no tree id, or the tree changed while it ran)` }
                : {});
      }
    } finally {
      back();
    }
  }

  /** After a land: the workspace's judged runs of the landed tree (rows that name `measured`, the tree), imported into the landing checkout's ledgers (it holds that tree now). */
  function importQualifyingRuns(record: WorkspaceRecord, landedIn: string | null, measuredSince: string, measured: string): readonly string[] {
    if (landedIn === null) return [];
    const ledgers = [...new Set([...config.phases.validate, ...config.phases.merge].flatMap((name) => config.commands[name]?.ledger ?? []))];
    return ledgers.map((ledger) => {
      const relative = suiteLedgerPaths(options.engineRelative)[ledger];
      return `${ledger}: ${String(importJudgedRuns(join(record.lease.worktreePath, relative), join(landedIn, relative), `workspace ${record.workspaceId}`, measuredSince, measured))}`;
    });
  }

  /**
   * The changed paths whose change from `from` to `to` is REGENERATION ONLY
   * (`isGenerationOnlyChange`: a wholly generated output, or a generated
   * output whose authored part is unchanged): the only ones exempt from the
   * lease, the merged-since and the pending-lease checks.
   */
  function generationOnlyPaths(cwd: string, from: string, to: string, changed: readonly string[], generated: ReadonlySet<string>): ReadonlySet<string> {
    return new Set(changed.filter((path) => generated.has(path) &&
      isGenerationOnlyChange(path, git.blobAt(cwd, from, path, timeouts.inspectMs), git.blobAt(cwd, to, path, timeouts.inspectMs))));
  }

  /**
   * What a branch changes, as `git merge` will bring it: the diff from the
   * fork point with the target (`merge-base(targetTip, head)`, never the
   * recorded base, which a branch's history can leave behind), and the
   * subset of it that is regeneration only.
   */
  function branchChange(cwd: string, forkPoint: string, head: string): Readonly<{ changed: readonly string[]; exempt: ReadonlySet<string> }> {
    const changed = git.diffNameOnly({ cwd, refA: forkPoint, refB: head, threeDot: false, timeoutMs: timeouts.inspectMs });
    return { changed, exempt: generationOnlyPaths(cwd, forkPoint, head, changed, generatedOutputPaths(cwd)) };
  }

  function leaseIdentity(workspaceId: string, writeSet: readonly string[]): string | null {
    if (writeSet.length === 0) return null;
    const rootCapability = bindTransientWriteRootCapability(deepFreeze({ workspaceId }));
    const effects: ExactWriteEffect[] = writeSet.flatMap((path) =>
      EXACT_WRITE_LEASE_OPERATIONS.map((operation) => deepFreeze({ operation, relativePath: path })));
    return compileExactWriteLease(rootCapability, effects).writeSetIdentity;
  }

  /**
   * The unfinished feature workspaces but `workspaceId`'s own, split by
   * whether their lease still holds their paths: while it is live or its
   * merge is running. An EXPIRED lease holds nothing — every verb of its
   * workspace, `extend` included, ends it first ({@link assertLeaseLive}), so
   * it can never validate, merge or renew again — and counting it refused
   * every overlapping writer until a sweep ended it, the one door that also
   * retires the worktree and branch a successor may be landing the work
   * from. A merging record always counts: its integrator owns its paths until
   * the land, whatever the clock says.
   */
  function featureLeases(workspaceId: string): Readonly<{ pending: readonly WorkspaceRecord[]; expired: readonly WorkspaceRecord[] }> {
    const nowMs = now().getTime();
    const others = store.list().filter((record) => record.workspaceId !== workspaceId && !isTerminalWorkspaceState(record.state) && record.lease.kind === "feature");
    const holds = (record: WorkspaceRecord): boolean => record.state === "merging" || !leaseExpired(record, nowMs);
    return deepFreeze({ pending: others.filter(holds), expired: others.filter((record) => !holds(record)) });
  }

  /** The feature leases that still hold their paths ({@link featureLeases}). */
  function pendingFeatureLeases(workspaceId: string): readonly WorkspaceRecord[] {
    return featureLeases(workspaceId).pending;
  }

  /**
   * Static admission: the write set against every pending feature lease but
   * `workspaceId`'s own ({@link pendingFeatureLeases}). Admitting over an
   * EXPIRED lease's paths is an audit event naming that workspace and the
   * paths (`workspace-admitted-over-expired`), so its owner learns why its
   * next verb will end it, before a merge does.
   */
  function assertAdmissible(workspaceId: string, writeSet: readonly string[]): void {
    const { pending, expired } = featureLeases(workspaceId);
    for (const record of expired) {
      const paths = [...new Set(detectWriteSetConflictAmong([deepFreeze({ name: record.workspaceId, writeSet: record.lease.writeSet }), deepFreeze({ name: workspaceId, writeSet })])
        .conflicts.map((conflict) => conflict.path))].toSorted();
      if (paths.length > 0) auditEvent("workspace-admitted-over-expired", { workspaceId, expiredWorkspaceId: record.workspaceId, expiredAt: record.lease.expiresAt, paths });
    }
    const pendingOwners = pending
      .map((record) => deepFreeze({ name: record.workspaceId, writeSet: record.lease.writeSet }));
    const conflicts = detectWriteSetConflictAmong([...pendingOwners, deepFreeze({ name: workspaceId, writeSet })])
      .conflicts
      .filter((conflict) => conflict.agentA === workspaceId || conflict.agentB === workspaceId);
    if (conflicts.length > 0) {
      throw new WorkspaceConflictError(buildConflictReport("static-overlap", workspaceId, conflicts.map((conflict) => {
        const otherWorkspaceId = conflict.agentA === workspaceId ? conflict.agentB : conflict.agentA;
        return deepFreeze({ path: conflict.path, otherWorkspaceId, reason: `write set overlaps the pending workspace ${otherWorkspaceId}` });
      })));
    }
  }

  /** A workspace lands only on a declared land target (`workspaceIsolation.landTargets`). */
  function assertLandable(targetBranch: string): void {
    if (!config.landTargets.includes(targetBranch)) {
      throw new InputError(
        `${targetBranch} is not a land target: a workspace lands only on ${config.landTargets.join(", ")} (workspaceIsolation.landTargets); a product branch changes only through its promotion door`,
        "workspace_target_not_landable",
      );
    }
  }

  /** The workspace root exists on the repository home's filesystem (tmpfs roots fail here, not later in the harness). */
  function assertWorkspaceRootPlacement(): void {
    mkdirSync(workspaceRoot, { recursive: true });
    assertSameFilesystem(registry.home, workspaceRoot, "workspace_root_filesystem_mismatch");
  }

  function indexDigest(checkout: string): string {
    return sha256(git.lsFilesStage(checkout, timeouts.inspectMs));
  }

  /**
   * The overlay of the invoking checkout: refusals first (a staged blob the
   * snapshot cannot carry; a deletion whose bytes sit at an ignored path),
   * then the one snapshot. Its changed paths are the overlay's own lease.
   */
  function takeOverlay(head: string): Readonly<{ overlay: WorkspaceOverlay; changed: readonly string[] }> {
    const unstaged = new Set(git.diffNames(checkoutRoot, "index-to-worktree", timeouts.inspectMs));
    const divergent = git.diffNames(checkoutRoot, "head-to-index", timeouts.inspectMs).filter((path) => unstaged.has(path));
    // A staged deletion whose file is still on disk (`git rm --cached`): the
    // snapshot adds the file back, so the adoption would silently undo it.
    const keptDeletions = git.diffNames(checkoutRoot, "staged-deletions", timeouts.inspectMs).filter((path) => existsSync(join(checkoutRoot, path)));
    if (divergent.length > 0 || keptDeletions.length > 0) {
      throw new InputError(
        `the index stages ${[...divergent.map((path) => `a version of ${path} that neither HEAD nor the working tree holds`), ...keptDeletions.map((path) => `the deletion of ${path}, whose file is still on disk`)].join("; ")}; an overlay snapshots the working tree, so that staged state would be lost — commit it, or make the working tree match it, first`,
        "workspace_overlay_staged_divergent",
      );
    }
    const digest = indexDigest(checkoutRoot);
    const taken = snapshot(checkoutRoot, { message: `overlay: working tree of ${checkoutRoot} at ${iso(now())}`, ...snapshotIdentity });
    const deleted = git.deletedBlobs(checkoutRoot, head, taken.commit, timeouts.inspectMs);
    if (deleted.length > 0) {
      const sizes = blobSizes(checkoutRoot, deleted.map((entry) => entry.blob), "directory");
      const losses = ignoredCopies(checkoutRoot, deleted.map((entry) => ({ ...entry, size: sizes.get(entry.blob)! })), "directory");
      if (losses.length > 0) {
        throw new InputError(
          `the working tree deletes ${[...new Set(losses.map((loss) => loss.from))].join(", ")} while their bytes sit at ignored paths (${losses.map((loss) => loss.to).join(", ")}): a move into an ignored path loses the file — use git mv, or commit the deletion through the commit guard (declared) first`,
          "workspace_overlay_move_loss",
        );
      }
    }
    const changed = git.diffNameOnly({ cwd: checkoutRoot, refA: head, refB: taken.commit, threeDot: false, timeoutMs: timeouts.inspectMs });
    return deepFreeze({ overlay: deepFreeze({ commit: taken.commit, tree: taken.tree, checkout: checkoutRoot, indexDigest: digest }), changed });
  }

  async function create(request: WorkspaceCreateRequest): Promise<WorkspaceRecord> {
    assertWorkspaceAgentName(request.agentName);
    const readOnly = request.mode === "read-only";
    const nonce = generateId("nonce").replaceAll("-", "").slice(-12);
    const workspaceId = `${request.agentName}-${nonce}`;
    const worktreePath = join(workspaceRoot, workspaceId);
    assertWorkspaceRootPlacement();
    const invokingBranch = git.symbolicBranch(checkoutRoot, timeouts.inspectMs);
    const generated = generatedOutputPaths(checkoutRoot);

    let targetBranch: string | null = null;
    let baseSha: string;
    let overlay: WorkspaceOverlay | null = null;
    let writeSet: readonly string[] = [];
    if (readOnly) {
      if (request.writeSet.length > 0 || request.target !== undefined) {
        throw new InputError("a read-only workspace takes no write set and no target: it never merges", "workspace_read_only");
      }
      baseSha = git.revParse(checkoutRoot, request.base ?? "HEAD", timeouts.inspectMs);
    } else {
      targetBranch = request.target ?? invokingBranch;
      if (targetBranch === null) {
        throw new InputError("the checkout's HEAD is detached: name the branch the workspace lands on (--target <branch>)", "workspace_target_missing");
      }
      assertLandable(targetBranch);
      const tip = git.revParse(checkoutRoot, `refs/heads/${targetBranch}`, timeouts.inspectMs);
      if (request.mode === "overlay") {
        if (targetBranch !== invokingBranch || request.base !== undefined) {
          throw new InputError("an overlay lands into the checkout it snapshots: its target is that checkout's branch and its base that checkout's HEAD", "workspace_overlay_target");
        }
        const taken = takeOverlay(tip);
        overlay = taken.overlay;
        baseSha = tip;
        writeSet = [...new Set([...taken.changed.filter((path) => !generated.has(path)), ...request.writeSet].map(canonicalizeWriteSetPath))].toSorted();
        if (taken.changed.length === 0) {
          throw new InputError(`the checkout ${checkoutRoot} holds nothing HEAD does not: there is nothing to adopt`, "workspace_overlay_clean");
        }
      } else {
        baseSha = request.base === undefined ? tip : git.revParse(checkoutRoot, request.base, timeouts.inspectMs);
        // A base off the target's history would bring its own delta along
        // with the branch, and that delta was never leased.
        if (!git.isAncestor(checkoutRoot, baseSha, tip, timeouts.inspectMs)) {
          throw new InputError(`the base ${request.base ?? baseSha} is not in ${targetBranch}'s history: a workspace forks from its target (its tip, or a commit the tip contains)`, "workspace_base_not_on_target");
        }
        writeSet = [...new Set(request.writeSet.map(canonicalizeWriteSetPath))].toSorted();
      }
      assertLeasableWriteSet(writeSet);
    }

    const branch = readOnly ? null : `${config.branchNamespace}${request.agentName}/${nonce}`;
    const issued = now();
    let record: WorkspaceRecord = deepFreeze({
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      workspaceId,
      agentName: request.agentName,
      state: "admitted",
      lease: deepFreeze({
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        workspaceId,
        agentName: request.agentName,
        kind: readOnly ? "read-only" : "feature",
        nonce,
        branch,
        targetBranch,
        worktreePath,
        baseSha,
        overlay,
        writeSet: deepFreeze([...writeSet]),
        writeSetIdentity: leaseIdentity(workspaceId, writeSet),
        issuedAt: iso(issued),
        heartbeatAt: iso(issued),
        expiresAt: iso(new Date(issued.getTime() + config.leaseTtlMs)),
        generation: 1,
      }),
      changedPaths: deepFreeze([]),
      validationReport: null,
      conflictReport: null,
      mergeReceipt: null,
      abortReason: null,
      history: deepFreeze([]),
      revision: 0,
    });
    // ADMISSION: the static check and the reservation are one step under the
    // admission lock, so two creates can never both pass the check.
    record = await withRepositoryLock(config.admissionLock, `workspace-create:${workspaceId}`, () => {
      if (!readOnly) assertAdmissible(workspaceId, writeSet);
      return store.save(record);
    });

    try {
      progress(`create: worktree ${worktreePath}`);
      if (branch === null) {
        git.worktreeAddDetached({ repoRoot: checkoutRoot, worktreePath, commitSha: baseSha, timeoutMs: timeouts.worktreeMs });
      } else {
        git.worktreeAdd({ repoRoot: checkoutRoot, worktreePath, branch, baseSha: overlay?.commit ?? baseSha, timeoutMs: timeouts.worktreeMs });
      }
      applyCheckoutFiles(worktreePath, checkoutRoot, options.engineRelative, config);
      const setup = await runPhase(worktreePath, "setup", { record, targetTip: null });
      if (setup.some((gate) => gate.status === "fail")) throw new WorkspaceGateFailedError(workspaceId, "setup", setup, "workspace_setup_failed");
    } catch (error) {
      removeWorktreeAndBranch(record);
      saveTransition(deepFreeze({ ...record, abortReason: recordedReason(`create failed: ${error instanceof Error ? error.message : String(error)}`) }), "aborted", "create failed");
      throw error;
    }
    record = saveTransition(record, "active", overlay === null ? "workspace created" : `workspace created from the overlay ${overlay.commit}`);
    recordTimelineEvent("shard", record, `workspace-created base=${baseSha}`, "succeeded");
    auditEvent("workspace-created", { workspaceId, kind: record.lease.kind, targetBranch, baseSha, overlay: overlay?.commit ?? null, writeSet });
    return record;
  }

  async function extend(workspaceId: string, paths: readonly string[]): Promise<WorkspaceRecord> {
    return withRepositoryLock(config.admissionLock, `workspace-extend:${workspaceId}`, () => {
      const record = requireRecord(workspaceId);
      if (isTerminalWorkspaceState(record.state)) throw new InputError(`workspace ${workspaceId} is terminal (${record.state})`, "workspace_terminal");
      if (record.lease.kind === "read-only") throw new InputError("a read-only workspace has no lease to extend", "workspace_read_only");
      if (record.state === "merging") throw new InputError(`workspace ${workspaceId} is merging; the integrator owns it`, "workspace_precondition_failed");
      // An expired lease is never revived: extend ends it like every other verb.
      assertLeaseLive(record);
      const writeSet = [...new Set([...record.lease.writeSet, ...paths.map(canonicalizeWriteSetPath)])].toSorted();
      assertLeasableWriteSet(writeSet);
      assertAdmissible(workspaceId, writeSet);
      const renewed = now();
      const updated: WorkspaceRecord = deepFreeze({
        ...record,
        lease: deepFreeze({
          ...record.lease,
          writeSet: deepFreeze(writeSet),
          writeSetIdentity: leaseIdentity(workspaceId, writeSet),
          heartbeatAt: iso(renewed),
          expiresAt: iso(new Date(renewed.getTime() + config.leaseTtlMs)),
          generation: record.lease.generation + 1,
        }),
      });
      const saved = store.save(updated);
      auditEvent("workspace-extended", { workspaceId, writeSet, generation: saved.lease.generation });
      return saved;
    });
  }

  async function validate(workspaceId: string, validateOptions: Readonly<{ full?: boolean }> = {}): Promise<ValidationReport> {
    const full = validateOptions.full === true;
    let record = requireRecord(workspaceId);
    if (isTerminalWorkspaceState(record.state)) throw new InputError(`workspace ${workspaceId} is terminal (${record.state})`, "workspace_terminal");
    if (record.state !== "active" && record.state !== "validating") {
      throw new InputError(`workspace ${workspaceId} cannot be validated from ${record.state}`, "workspace_precondition_failed");
    }
    assertLeaseLive(record);
    assertWorktreeIntact(record);
    if (record.state === "active") record = saveTransition(record, "validating", full ? "full validation started" : "validation started");

    const worktreePath = record.lease.worktreePath;
    const startedAt = iso(now());
    const headSha = git.revParse(worktreePath, "HEAD", timeouts.inspectMs);
    const tree = git.revParse(worktreePath, `${headSha}^{tree}`, timeouts.inspectMs);
    const target = record.lease.targetBranch;
    const targetTip = target === null ? null : git.revParse(checkoutRoot, `refs/heads/${target}`, timeouts.inspectMs);
    const judge: LedgerJudge = { record, targetTip };
    // What `git merge` would bring: the change since the fork point with the
    // target (a read-only workspace: since its base).
    const { changed: changedPaths, exempt } = branchChange(worktreePath, targetTip === null ? record.lease.baseSha : git.mergeBase(checkoutRoot, targetTip, headSha, timeouts.inspectMs), headSha);
    const backToBranch = (): void => moveWorktree(worktreePath, () => git.checkoutBranch(worktreePath, record.lease.branch!, timeouts.worktreeMs, true));
    const gates: WorkspaceGateResult[] = [];
    if (record.lease.kind === "read-only") {
      gates.push(persistedGate(builtinGate("write-set-proof", "skip", "read-only: no lease to prove")));
    } else {
      const dirty = git.status(worktreePath, timeouts.inspectMs);
      const unleased = computeUnleasedPaths(changedPaths, record.lease.writeSet, exempt);
      gates.push(persistedGate(builtinGate(
        "write-set-proof",
        dirty.length === 0 && unleased.length === 0 ? "pass" : "fail",
        dirty.length > 0
          ? "the worktree has uncommitted changes: the gates judge commits"
          : unleased.length === 0
            ? `changed set (${changedPaths.length} paths) is inside the declared write set`
            : `${unleased.length} changed paths are outside the declared write set (extend the lease or revert them)`,
        [...statusPaths(dirty).map((path) => `uncommitted: ${path}`), ...unleased.map((path) => `unleased: ${path}`)],
      )));
    }
    const failedSoFar = (): boolean => gates.some((gate) => gate.status === "fail");
    if (!failedSoFar() && targetTip !== null) await ensureTargetBaselines(record, worktreePath, "validate", targetTip, backToBranch);
    if (!failedSoFar()) gates.push(...await runPhase(worktreePath, "validate", judge));
    if (full && !failedSoFar()) {
      if (targetTip !== null) await ensureTargetBaselines(record, worktreePath, "merge", targetTip, backToBranch);
      gates.push(...await runPhase(worktreePath, "regenerate", judge));
      if (!failedSoFar()) {
        const left = statusPaths(git.status(worktreePath, timeouts.inspectMs));
        gates.push(persistedGate(builtinGate(
          "converged",
          left.length === 0 ? "pass" : "fail",
          left.length === 0 ? "the regenerate phase left the tree as committed" : `the regenerate phase rewrote ${left.length} path(s): the commits are not converged — commit them`,
          left,
        )));
      }
      if (!failedSoFar()) gates.push(...await runPhase(worktreePath, "merge", judge));
    }

    const status: "pass" | "fail" = failedSoFar() ? "fail" : "pass";
    const report: ValidationReport = deepFreeze({
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      workspaceId,
      baseSha: record.lease.baseSha,
      headSha,
      tree,
      full,
      changedPaths,
      gates: deepFreeze(gates),
      startedAt,
      status,
      validatedAt: iso(now()),
    });
    const updated = deepFreeze({ ...record, validationReport: report, changedPaths });
    const saved = store.save(status === "pass" ? updated : transition(updated, "active", "validation failed"));
    recordTimelineEvent("shard", saved, `workspace-validated status=${status} full=${String(full)}`, status === "pass" ? "succeeded" : "failed");
    return report;
  }


  /** The overlay's checkout still holds exactly the snapshot and the same index, and its branch is still at the base. */
  function assertOverlayCurrent(record: WorkspaceRecord, overlay: WorkspaceOverlay, targetTip: string): void {
    const fresh = snapshot(overlay.checkout, { message: `overlay check of ${record.workspaceId}`, ...snapshotIdentity });
    const stale = [
      ...(targetTip === record.lease.baseSha ? [] : [`${record.lease.targetBranch} moved from ${record.lease.baseSha} to ${targetTip}`]),
      ...(fresh.tree === overlay.tree ? [] : ["the checkout's working tree changed since the overlay"]),
      ...(indexDigest(overlay.checkout) === overlay.indexDigest ? [] : ["the checkout's index changed since the overlay"]),
    ];
    if (stale.length > 0) {
      saveTransition(record, "active", `overlay stale: ${stale.join("; ")}`);
      throw new HarnessError(`the overlay of ${overlay.checkout} is stale (${stale.join("; ")}); the checkout was touched after the overlay was taken — abort this workspace and take a new overlay`, "workspace_overlay_stale", false, { workspaceId: record.workspaceId });
    }
  }

  /**
   * THE LAND (see the header). Throws `workspace_land_refused` with git's
   * words when git declines; nothing moved in that case.
   */
  function land(record: WorkspaceRecord, mergeCommit: string, targetTip: string): Readonly<{ landing: WorkspaceLanding; landedIn: string | null }> {
    const target = record.lease.targetBranch!;
    const overlay = record.lease.overlay;
    if (overlay !== null) {
      assertOverlayCurrent(record, overlay, git.revParse(overlay.checkout, `refs/heads/${target}`, timeouts.inspectMs));
      // The index becomes the snapshot's tree (the working tree already is
      // it), then a two-way switch to the merge touches only what the
      // workspace changed, then the branch moves by compare-and-swap. A step
      // that fails before the branch moved gives the checkout its own index
      // back, byte for byte (A5-correctness L1: it was left at the snapshot's
      // tree; the files are only rewritten by the switch, which git does all
      // or nothing).
      const index = indexFilePath(overlay.checkout, "directory");
      const ownIndex = readFileSync(index);
      try {
        git.readTree(overlay.checkout, overlay.commit, timeouts.worktreeMs);
        git.refreshIndex(overlay.checkout, timeouts.worktreeMs);
        git.readTreeSwitch(overlay.checkout, overlay.commit, mergeCommit, timeouts.worktreeMs);
        settleCheckout(overlay.checkout, options.engineRelative);
      } catch (error) {
        const restored = atomicWriteFile(index, ownIndex);
        if (!restored.success) throw new HarnessError(`the overlay's adoption failed and ${index} could not be given back (${restored.reason ?? "unknown"}): restore it with git read-tree ${overlay.commit}`, "workspace_overlay_index_unrestored", false, { workspaceId: record.workspaceId });
        throw error;
      }
      const moved = git.updateRef(overlay.checkout, `refs/heads/${target}`, mergeCommit, targetTip, timeouts.worktreeMs);
      if (moved.refusal !== null) {
        throw new HarnessError(
          `the overlay's files and index were adopted but ${target} moved during the land (${moved.refusal}); the checkout ${overlay.checkout} now holds the merge's tree on top of the new ${target}: inspect it with git status`,
          "workspace_overlay_adoption_incomplete",
          false,
          { workspaceId: record.workspaceId, mergeCommit },
        );
      }
      return { landing: "overlay-adoption", landedIn: overlay.checkout };
    }
    const outcome = landCommit(git, checkoutRoot, target, mergeCommit, targetTip, options.engineRelative, timeouts.worktreeMs);
    if (outcome.refusal !== null) {
      throw new HarnessError(
        `git refused to land ${record.workspaceId} on ${target}${outcome.landedIn === null ? "" : ` in ${outcome.landedIn}`}: ${outcome.refusal}`,
        "workspace_land_refused",
        false,
        { workspaceId: record.workspaceId },
      );
    }
    return { landing: outcome.landing, landedIn: outcome.landedIn };
  }

  async function merge(workspaceId: string): Promise<MergeReceipt> {
    return withRepositoryLock(config.mergeLock, `workspace-merge:${workspaceId}`, async () => {
      let record = requireRecord(workspaceId);
      if (record.lease.kind === "read-only") throw new InputError(`workspace ${workspaceId} is read-only: it never merges`, "workspace_read_only");
      const validated = record.validationReport;
      if (record.state !== "validating" || validated === null || validated.status !== "pass") {
        throw new InputError(`workspace ${workspaceId} is not validated (state=${record.state})`, "workspace_merge_precondition_failed");
      }
      assertLandable(record.lease.targetBranch!);
      assertLeaseLive(record);
      assertWorktreeIntact(record);
      record = saveTransition(record, "merging", "the integrator took the merge lock");

      const worktreePath = record.lease.worktreePath;
      const branch = record.lease.branch!;
      const target = record.lease.targetBranch!;
      const head = git.revParse(worktreePath, "HEAD", timeouts.inspectMs);
      if (head !== validated.headSha) {
        saveTransition(record, "active", "worktree HEAD moved after validation; re-validate");
        throw new InputError(`workspace ${workspaceId} validation is stale (HEAD moved)`, "workspace_validation_stale");
      }
      if (git.status(worktreePath, timeouts.inspectMs).length > 0) {
        saveTransition(record, "active", "worktree has uncommitted changes at merge");
        throw new InputError(`workspace ${workspaceId} worktree is dirty at merge`, "workspace_merge_precondition_failed");
      }
      const generated = generatedOutputPaths(worktreePath);
      const targetTip = git.revParse(checkoutRoot, `refs/heads/${target}`, timeouts.inspectMs);
      // The fork point with the target: what `git merge` brings is its diff to the head.
      const forkPoint = git.mergeBase(checkoutRoot, targetTip, head, timeouts.inspectMs);
      const { changed: changedPaths, exempt } = branchChange(worktreePath, forkPoint, head);
      const authored = changedPaths.filter((path) => !exempt.has(path));
      const unleased = computeUnleasedPaths(changedPaths, record.lease.writeSet, exempt);
      if (unleased.length > 0) {
        refuse(record, "dynamic-overlap", unleased.map((path) => deepFreeze({ path, otherWorkspaceId: null, reason: "changed path is outside the declared write set" })), "changed set escaped the write set at merge");
      }
      if (record.lease.overlay !== null) assertOverlayCurrent(record, record.lease.overlay, targetTip);
      if (forkPoint !== targetTip) {
        const staleness = git.revListCount(checkoutRoot, forkPoint, targetTip, timeouts.inspectMs);
        const merged = git.diffNameOnly({ cwd: checkoutRoot, refA: forkPoint, refB: targetTip, threeDot: false, timeoutMs: timeouts.inspectMs });
        const mergedExempt = generationOnlyPaths(checkoutRoot, forkPoint, targetTip, merged, generated);
        const mergedConflicts = computeMergedSinceConflicts(authored, merged.filter((path) => !mergedExempt.has(path)));
        if (mergedConflicts.length > 0) refuse(record, "dynamic-overlap", mergedConflicts, "a path merged since the base; rebase and re-validate");
        if (staleness > config.baseStalenessCommits) {
          refuse(record, "dynamic-overlap", [deepFreeze({ path: "(base)", otherWorkspaceId: null, reason: `${target} moved ${staleness} commits since the base (budget ${config.baseStalenessCommits}); rebase required` })], "base too stale; rebase and re-validate");
        }
      }
      const pending = pendingFeatureLeases(workspaceId)
        .map((other) => deepFreeze({ workspaceId: other.workspaceId, writeSet: other.lease.writeSet }));
      const pendingConflicts = computePendingWriteSetConflicts(authored, pending);
      if (pendingConflicts.length > 0) refuse(record, "dynamic-overlap", pendingConflicts, "a pending workspace leases a changed path; re-sequence and re-validate");

      // IN THE WORKSPACE: canonical is untouched until the land.
      const message = `merge: workspace ${workspaceId} (${record.agentName})`;
      const judge: LedgerJudge = { record, targetTip };
      let mergeInProgress = false;
      // Back to the branch, the record back to `active`: nothing landed. The
      // worktree was verified clean when the merge began, so what the merge
      // and its phases wrote to tracked files is discarded with it.
      const restore = (reason: string, conflictReport: ConflictReport | null = null): void => {
        if (mergeInProgress) git.mergeAbort(worktreePath, timeouts.worktreeMs);
        moveWorktree(worktreePath, () => git.checkoutBranch(worktreePath, branch, timeouts.worktreeMs, true));
        saveTransition(conflictReport === null ? record : deepFreeze({ ...record, conflictReport }), "active", reason);
      };
      let mergeCommit: string;
      let mergeTree: string;
      const gateResults: WorkspaceGateResult[] = [];
      const resolved: string[] = [];
      let regenerated: readonly string[];
      let qualifiedSince: string;
      try {
        progress(`merge: ${branch} into ${target} at ${targetTip}, in ${worktreePath}`);
        moveWorktree(worktreePath, () => git.checkoutDetached(worktreePath, targetTip, timeouts.worktreeMs));
        await ensureTargetBaselines(record, worktreePath, "merge", targetTip, () => moveWorktree(worktreePath, () => git.checkoutDetached(worktreePath, targetTip, timeouts.worktreeMs, true)));
        let merged!: ReturnType<typeof git.mergeNoCommit>;
        moveWorktree(worktreePath, () => { merged = git.mergeNoCommit({ cwd: worktreePath, branch, message, timeoutMs: timeouts.worktreeMs, ...(options.identity === undefined ? {} : { identity: options.identity }) }); });
        mergeInProgress = true;
        // A conflict on a generated output whose branch-side change is
        // regeneration only is resolved to the target's side; the regenerate
        // phase re-derives it from the merged sources. Any other is reported.
        const resolvable = generationOnlyPaths(worktreePath, forkPoint, head, merged.conflictPaths, generated);
        const unresolved = merged.conflictPaths.filter((path) => !resolvable.has(path));
        if (unresolved.length > 0) {
          const conflictReport = buildConflictReport("textual-conflict", workspaceId, unresolved.map((path) => deepFreeze({ path, otherWorkspaceId: null, reason: "textual merge conflict" })));
          restore("textual merge conflict; resolve it in the worktree (rebase) and re-validate", conflictReport);
          auditEvent("workspace-merge-refused", { workspaceId, kind: "textual-conflict", paths: unresolved });
          throw new WorkspaceConflictError(conflictReport);
        }
        resolved.push(...merged.conflictPaths);
        git.resolveToOurs(worktreePath, resolved, timeouts.worktreeMs);
        gateResults.push(...await runPhase(worktreePath, "regenerate", judge));
        if (gateResults.some((gate) => gate.status === "fail")) throw new WorkspaceGateFailedError(workspaceId, "regenerate", gateResults);
        // The merge staged the branch's changes; what the phase wrote is on the working-tree side.
        regenerated = unstagedStatusPaths(git.status(worktreePath, timeouts.inspectMs));
        try {
          refuseUndeclaredWrites(regenerated, generated, "regenerate", "the regenerate phase", worktreePath);
        } catch (error) {
          if (!(error instanceof LandingError) || error.failure !== "undeclared_write") throw error;
          throw new HarnessError(error.message, "workspace_regenerate_undeclared_write", false, { workspaceId, paths: (error.facts["paths"] as readonly string[]).join(", ") });
        }
        git.addPaths(worktreePath, regenerated, timeouts.worktreeMs);
        // THE LANDING'S COMMIT (tree-landing.ts): the hooks run, then its postconditions — the staged tree, the parents [target, branch], no missing object.
        mergeTree = git.stageAll(worktreePath, timeouts.worktreeMs);
        try {
          mergeCommit = commitCandidate({
            git, root: worktreePath, message, tree: mergeTree, parents: [targetTip, head], timeoutMs: timeouts.mergeMs,
            ...(options.identity === undefined ? {} : { identity: options.identity }),
          }).commit;
        } catch (error) {
          if (!(error instanceof LandingError) || error.failure !== "commit_refused") throw error;
          throw new HarnessError(error.message, "workspace_merge_commit_refused", false, { workspaceId });
        }
        mergeInProgress = false;
        if (validated.full && validated.tree === mergeTree) {
          qualifiedSince = validated.startedAt;
          gateResults.push(persistedGate(builtinGate("merge-gates", "skip", `the merge's tree ${mergeTree} is the tree validate --full qualified`)));
        } else {
          qualifiedSince = iso(now());
          const mergeGates = await runPhase(worktreePath, "merge", judge);
          gateResults.push(...mergeGates);
          if (mergeGates.some((gate) => gate.status === "fail")) throw new WorkspaceGateFailedError(workspaceId, "merge", gateResults);
        }
        const left = statusPaths(git.status(worktreePath, timeouts.inspectMs));
        gateResults.push(persistedGate(builtinGate("converged", left.length === 0 ? "pass" : "fail", left.length === 0 ? "the gates left the merge as committed" : "the gates rewrote tracked paths: the merge is not converged", left)));
        if (left.length > 0) {
          throw new HarnessError(`the merge gates rewrote ${left.join(", ")}: the merge is not converged`, "workspace_gates_not_converged", false, { workspaceId, paths: left.join(", ") });
        }
      } catch (error) {
        if (!(error instanceof WorkspaceConflictError)) {
          restore(`merge failed before the land: ${error instanceof Error ? error.message : String(error)}`);
          auditEvent("workspace-merge-refused", { workspaceId, code: (error as { code?: unknown }).code ?? "unknown" });
        }
        throw error;
      }

      let landed: Readonly<{ landing: WorkspaceLanding; landedIn: string | null }>;
      try {
        progress(`land: ${mergeCommit} on ${target}`);
        landed = land(record, mergeCommit, targetTip);
      } catch (error) {
        if ((error as { code?: unknown }).code !== "workspace_overlay_adoption_incomplete") {
          moveWorktree(worktreePath, () => git.checkoutBranch(worktreePath, branch, timeouts.worktreeMs, true));
          // A land git refused (a dirty overlap, the target moved) changed
          // nothing the validation judged: the workspace stays validated, and
          // the next merge rebuilds and gates its merge commit.
          const current = requireRecord(workspaceId);
          if (current.state === "merging") saveTransition(current, "validating", `land refused: ${error instanceof Error ? error.message : String(error)}`);
        }
        auditEvent("workspace-land-refused", { workspaceId, code: (error as { code?: unknown }).code ?? "unknown" });
        throw error;
      }
      return finishLanded(record, {
        mergeCommit, mergeTree, landing: landed.landing, landedIn: landed.landedIn, targetTip, changedPaths,
        regenerated, resolved, gateResults, imported: importQualifyingRuns(record, landed.landedIn, qualifiedSince, mergeTree),
      });
    });
  }

  /**
   * After the land: the timeline import, the teardown and the hashed
   * receipt; the record becomes `merged`. A failure here (the land already
   * happened) leaves the record `merging` with no integrator: `recover`
   * finishes it.
   */
  function finishLanded(record: WorkspaceRecord, landed: Readonly<{
    mergeCommit: string; mergeTree: string; landing: WorkspaceLanding; landedIn: string | null; targetTip: string;
    changedPaths: readonly string[]; regenerated: readonly string[]; resolved: readonly string[];
    gateResults: readonly WorkspaceGateResult[]; imported: readonly string[];
  }>): MergeReceipt {
    const { workspaceId } = record;
    const branch = record.lease.branch!;
    const target = record.lease.targetBranch!;
    auditEvent("workspace-landed", { workspaceId, targetBranch: target, mergeCommit: landed.mergeCommit, landing: landed.landing, importedRuns: landed.imported });

    let importedEvents = 0;
    let skippedEvents = 0;
    if (timeline !== null) {
      const shard = timeline.openShard(workspaceId);
      try {
        const canonicalStore = timeline.openCanonical();
        try {
          const importResult = importWorkspaceTimelineShard({ shard, canonical: canonicalStore, ...(timeline.queryDefaultLimit !== undefined ? { queryDefaultLimit: timeline.queryDefaultLimit } : {}) });
          importedEvents = importResult.imported;
          skippedEvents = importResult.skipped;
        } finally {
          canonicalStore.close();
        }
      } finally {
        shard.close();
      }
      // Appenders do not share the merge lock. Retain the source even after
      // a successful bounded import; a tip check cannot authorize deletion.
    }

    removeGateLogs(record.lease.worktreePath);
    git.worktreeRemove({ repoRoot: checkoutRoot, worktreePath: record.lease.worktreePath, force: true, timeoutMs: timeouts.worktreeMs });
    git.deleteBranch(checkoutRoot, branch, true, timeouts.worktreeMs);

    const receipt = finalizeMergeReceipt({
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      workspaceId,
      agentName: record.agentName,
      branch,
      targetBranch: target,
      baseSha: record.lease.baseSha,
      preMergeHeadSha: landed.targetTip,
      mergeCommitSha: landed.mergeCommit,
      mergeTree: landed.mergeTree,
      landing: landed.landing,
      landedIn: landed.landedIn,
      changedPaths: deepFreeze([...landed.changedPaths]),
      regeneratedPaths: deepFreeze([...landed.regenerated]),
      resolvedConflicts: deepFreeze([...landed.resolved]),
      importedRuns: deepFreeze([...landed.imported]),
      timelineImportedEvents: importedEvents,
      timelineSkippedEvents: skippedEvents,
      gateResults: deepFreeze([...landed.gateResults]),
      frozenAcceptances: frozenAcceptancesBetween(checkoutRoot, landed.targetTip, landed.mergeCommit),
      mergedAt: iso(now()),
    });
    const mergedRecord = saveTransition(deepFreeze({ ...record, mergeReceipt: receipt, changedPaths: deepFreeze([...landed.changedPaths]) }), "merged", "workspace landed and torn down");
    recordTimelineEvent("canonical", mergedRecord, `workspace-merged receipt=${receipt.receiptHash}`, "succeeded");
    return receipt;
  }

  /**
   * RECOVER a workspace whose integrator died mid-merge (killed, out of
   * memory, an agent tool timeout), leaving its record `merging` with nobody
   * to finish it. Under the merge lock, taken WITHOUT WAITING: an integrator
   * holds it for its whole merge, so a held lock means one is running
   * (`workspace_recover_denied`), and the lock owner reclaims a dead
   * holder's lock — holding it proves no integrator runs. Then: if the target
   * already contains the branch's work (or the teardown already removed the
   * branch), the land happened, so the teardown is finished and the record
   * is `merged` (its receipt died with the integrator); otherwise the
   * worktree goes back to its branch (`merge --abort`, `checkout -f`) and the
   * record to `active` (`quarantined` when the worktree is gone). Any other
   * state is returned as it is.
   */
  async function recover(workspaceId: string): Promise<WorkspaceRecord> {
    try {
      return await withRepositoryLock({ ...config.mergeLock, timeoutMs: 0 }, `workspace-recover:${workspaceId}`, () => recoverUnderMergeLock(requireRecord(workspaceId)));
    } catch (error) {
      if ((error as { code?: unknown }).code !== "lock_acquisition_timeout") throw error;
      throw new InputError(`an integrator holds the merge lock (it is running): workspace ${workspaceId} is not stuck`, "workspace_recover_denied");
    }
  }

  function recoverUnderMergeLock(record: WorkspaceRecord): WorkspaceRecord {
    if (record.state !== "merging") return record;
    const branch = record.lease.branch!;
    const target = record.lease.targetBranch!;
    const branchHead = git.branchTip(checkoutRoot, branch, timeouts.inspectMs);
    const targetTip = git.revParse(checkoutRoot, `refs/heads/${target}`, timeouts.inspectMs);
    const worktreePath = record.lease.worktreePath;
    if (branchHead === null || git.isAncestor(checkoutRoot, branchHead, targetTip, timeouts.inspectMs)) {
      removeWorktreeAndBranch(record);
      const merged = saveTransition(record, "merged", `recovered: the land on ${target} had happened (${targetTip}); the teardown is finished, the receipt was lost with the integrator`);
      auditEvent("workspace-recovered", { workspaceId: record.workspaceId, outcome: "merged", targetTip });
      return merged;
    }
    if (!git.verifyWorktreeIntact(worktreePath, timeouts.inspectMs)) {
      return quarantineRecord(record, "recovered: the integrator died before the land and the worktree is gone");
    }
    try {
      git.mergeAbort(worktreePath, timeouts.worktreeMs);
    } catch (error) {
      // No merge in progress (the integrator died before or after it).
      if (!(error instanceof HarnessError)) throw error;
    }
    moveWorktree(worktreePath, () => git.checkoutBranch(worktreePath, branch, timeouts.worktreeMs, true));
    const active = saveTransition(record, "active", "recovered: the integrator died before the land; nothing landed");
    auditEvent("workspace-recovered", { workspaceId: record.workspaceId, outcome: "active" });
    return active;
  }

  function abort(workspaceId: string, abortOptions: Readonly<{ quarantine?: boolean; reason?: string }> = {}): WorkspaceRecord {
    return abortInternal(requireRecord(workspaceId), abortOptions.quarantine ?? false, abortOptions.reason ?? "operator abort");
  }

  function snapshotWorkspace(workspaceId: string, label: string): WorkingTreeSnapshot {
    const record = requireRecord(workspaceId);
    if (isTerminalWorkspaceState(record.state)) throw new InputError(`workspace ${workspaceId} is terminal (${record.state})`, "workspace_terminal");
    return snapshot(record.lease.worktreePath, { message: `workspace ${workspaceId} snapshot ${label}`, name: `${workspaceId}.${label}`, ...snapshotIdentity });
  }

  async function sweep(): Promise<readonly string[]> {
    const swept: string[] = [];
    const nowMs = now().getTime();
    for (const record of store.list()) {
      if (record.state === "merging") {
        // A merging record whose integrator is gone (the merge lock is free)
        // is recovered; a running integrator's is left to it.
        try {
          if ((await recover(record.workspaceId)).state !== "merging") swept.push(record.workspaceId);
        } catch (error) {
          if ((error as { code?: unknown }).code !== "workspace_recover_denied") throw error;
        }
        continue;
      }
      if (!isTerminalWorkspaceState(record.state)) {
        if (leaseExpired(record, nowMs)) {
          abortInternal(record, config.preserveOnFailure, "lease-expired");
          swept.push(record.workspaceId);
        }
        continue;
      }
      if (record.state !== "quarantined") continue;
      const lastTransition = record.history.at(-1);
      const worktreePath = record.lease.worktreePath;
      if (lastTransition === undefined || !existsSync(worktreePath) || nowMs <= new Date(lastTransition.at).getTime() + config.quarantineTtlMs) continue;
      // A quarantined worktree is LOCKED (`worktree lock`): `remove --force`
      // refuses a locked one, so it is unlocked first.
      try {
        git.worktreeUnlock({ repoRoot: checkoutRoot, worktreePath, timeoutMs: timeouts.worktreeMs });
      } catch (error) {
        // Not locked (quarantined before it could be): nothing to unlock.
        if (!(error instanceof HarnessError)) throw error;
      }
      // Its branch and recovery points go with the worktree (A5-correctness
      // L2: the branch outlived the sweep); the record stays, the terminal
      // account of what was quarantined and why.
      removeWorktreeAndBranch(record);
      auditEvent("workspace-swept", { workspaceId: record.workspaceId, worktreePath });
      swept.push(record.workspaceId);
    }
    return deepFreeze(swept);
  }

  return deepFreeze({
    registry,
    create,
    extend,
    validate,
    merge,
    recover,
    abort,
    snapshot: snapshotWorkspace,
    list: (): readonly WorkspaceRecord[] => store.list(),
    status: requireRecord,
    sweep,
  });
}
