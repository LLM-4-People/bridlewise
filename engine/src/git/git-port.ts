import { deepFreeze } from "../kernel/integrity.ts";
import { schemaId } from "../kernel/product-identity.ts";

/**
 * Git port — typed interface for governed Git operations.
 *
 * Per delivery map item 10: "Interactively handle empty folders,
 * existing data, existing repositories, init/clone/pull, separate source
 * and push remotes/forks, authentication boundaries, exclusions that can
 * never be pushed, sync conflicts, branches, per-feature tags/checkpoints,
 * tests, testing promotion, and rollback. Use local bare/disposable remotes
 * for hostile qualification before real remotes."
 *
 * Per the canonical requirements (REQ-018): "Enforce declared feature work,
 * a Git-backed checkpoint/tag for every modification, automatic completion
 * gates/testing, and guarded promotion/push to testing."
 *
 * The immutable root floor lives in
 * `ROOT_POLICY.workspaceGitArchitecture` and is not copied here. Project
 * configuration may only tighten the root floor (per CONFIG-ADDITIONS.md).
 *
 * All operations:
 * Go through the admitted-node-runtime authority.
 * Are recorded in the timeline.
 * Respect `GIT_OPTIONAL_LOCKS=0` per.
 * Never expose credentials in logs, errors, or remote URLs.
 * Enforce never-push exclusions before any push effect.
 */

export const GIT_PORT_SCHEMA_VERSION = schemaId("git-port", 1);

/**
 * A full git object name: SHA-1 (40 hex) or SHA-256 (64 hex). The one
 * spelling of the pattern; {@link GIT_OBJECT_NAME} anchors it, and a reader
 * that matches an object name inside a longer record embeds the pattern.
 */
export const GIT_OBJECT_NAME_PATTERN = "[0-9a-f]{40}(?:[0-9a-f]{24})?";
export const GIT_OBJECT_NAME = new RegExp(`^${GIT_OBJECT_NAME_PATTERN}$`, "u");

export const GIT_TRANSPORTS = deepFreeze(["file", "ssh", "https"] as const);
export type GitTransport = typeof GIT_TRANSPORTS[number];

export const GIT_RECONCILIATION_MODES = deepFreeze([
  "fast-forward-only",
  "merge",
  "rebase",
] as const);
export type GitReconciliationMode = typeof GIT_RECONCILIATION_MODES[number];

export const GIT_WORKSPACE_STATES = deepFreeze([
  "empty",
  "nonempty-unversioned",
  "repository",
  "linked-worktree",
  "bare",
  "nested",
  "corrupt-or-ambiguous",
] as const);
export type GitWorkspaceState = typeof GIT_WORKSPACE_STATES[number];

export const GIT_WORKSPACE_PLANS = deepFreeze([
  "init-empty",
  "clone",
  "import-and-init",
  "attach",
  "reconcile",
  "fork",
] as const);
export type GitWorkspacePlan = typeof GIT_WORKSPACE_PLANS[number];

export const GIT_AUTH_METHODS = deepFreeze([
  "credential-helper",
  "ssh-agent",
  "oauth-device-flow",
  "opaque-fd-secret-handle",
] as const);
export type GitAuthMethod = typeof GIT_AUTH_METHODS[number];

export const GIT_CHECKOUT_POLICIES = deepFreeze([
  "checkout",
  "no-checkout",
] as const);
export type GitCheckoutPolicy = typeof GIT_CHECKOUT_POLICIES[number];

export const GIT_SUBMODULE_MODES = deepFreeze([
  "none",
  "default",
  "recursive",
] as const);
export type GitSubmoduleMode = typeof GIT_SUBMODULE_MODES[number];

export const GIT_LFS_MODES = deepFreeze([
  "none",
  "fetch",
  "fetch-and-checkout",
] as const);
export type GitLfsMode = typeof GIT_LFS_MODES[number];

export type GitRemoteRole = Readonly<{
  name: string;
  urlIdentity: string;
  refspecs: readonly string[];
  branch?: string;
}>;

export type GitRemoteRoles = Readonly<{
  fetch: GitRemoteRole;
  push?: GitRemoteRole;
}>;

export type GitCloneOptions = Readonly<{
  depth?: number;
  filter?: string;
  rejectShallow: boolean;
  checkoutPolicy: GitCheckoutPolicy;
  submoduleMode: GitSubmoduleMode;
  lfsMode: GitLfsMode;
}>;

export type GitPushOptions = Readonly<{
  refspecs: readonly string[];
  atomic: boolean;
  signed: boolean;
  force: false;
  protectedRefs: readonly string[];
  leaseCapabilityRef?: string;
}>;

export type GitReconciliationOptions = Readonly<{
  mode: GitReconciliationMode;
  unrelatedHistory: "reject" | "allow-merge" | "allow-rebase";
}>;

export type GitTimeouts = Readonly<{
  inspectMs: number;
  fetchMs: number;
  pushMs: number;
  verifyMs: number;
  addMs: number;
  commitMs: number;
}>;

export type GitRetries = Readonly<{
  inspectAttempts: number;
  fetchAttempts: number;
  pushAttempts: number;
  verifyAttempts: number;
}>;

export type GitCheckpointConfig = Readonly<{
  namespace: string;
  retention: number;
  compensation: "tag" | "ref" | "commit";
}>;

export type GitCredentialsConfig = Readonly<{
  providerRefs: readonly string[];
  allowedMethods: readonly GitAuthMethod[];
}>;

export type GitNeverPushAdditiveRule = Readonly<{
  pattern: string;
  classification: string;
  sizeCeilingBytes?: number;
  lfsClassification?: string;
  managedIgnore?: boolean;
}>;

export type GitNeverPushConfig = Readonly<{
  additiveRules: readonly GitNeverPushAdditiveRule[];
}>;

export type GitCapabilities = Readonly<{
  objectFormat: string;
  refStorage: string;
  credential: string;
  host: string;
  submodule: string;
  lfs: string;
  signer: string;
  filesystem: string;
}>;

export type GitInteractionConfig = Readonly<{
  safeRecommendation: boolean;
  approvalRequired: boolean;
}>;

export type GitTimedoutOptions = Readonly<{
  timeouts: GitTimeouts;
  retries: GitRetries;
}>;

export type WorkspaceGitConfig = Readonly<{
  remoteRoles: GitRemoteRoles;
  allowedTransports: readonly GitTransport[];
  allowedHosts: readonly string[];
  defaultBranch: string;
  clone: GitCloneOptions;
  reconciliation: GitReconciliationOptions;
  push: GitPushOptions;
  timeouts: GitTimeouts;
  retries: GitRetries;
  checkpoint: GitCheckpointConfig;
  credentials: GitCredentialsConfig;
  neverPush: GitNeverPushConfig;
  capabilities: GitCapabilities;
  interaction: GitInteractionConfig;
}>;

export type GitIdentity = Readonly<{
  name: string;
  email: string;
}>;

export type GitInitRequest = Readonly<{
  path: string;
  bare: boolean;
  initialBranch: string;
  identity: GitIdentity;
}>;

export type GitInitResult = Readonly<{
  gitDir: string;
  head: string;
  branch: string;
}>;

export type GitCloneRequest = Readonly<{
  url: string;
  destination: string;
  bare: boolean;
  branch?: string;
  depth?: number;
  identity: GitIdentity;
}>;

export type GitCloneResult = Readonly<{
  gitDir: string;
  head: string;
  branch: string;
  remoteUrl: string;
}>;

export type GitPullRequest = Readonly<{
  path: string;
  remote: string;
  branch: string;
  reconciliation: GitReconciliationMode;
  identity: GitIdentity;
}>;

export type GitPullResult = Readonly<{
  fastForward: boolean;
  upToDate: boolean;
  merged: boolean;
  rebased: boolean;
  conflicts: readonly string[];
}>;

export type GitPushRequest = Readonly<{
  path: string;
  remote: string;
  refspecs: readonly string[];
  atomic: boolean;
  force: false;
  identity: GitIdentity;
}>;

export type GitPushResult = Readonly<{
  pushed: readonly Readonly<{ refspec: string; remoteSha: string; forced: false }>[];
  rejected: readonly Readonly<{ refspec: string; reason: string }>[];
}>;

/** One ref of a push's `--porcelain` answer: git's flag (` ` updated, `*` new, `!` rejected, `=` up to date, …), its two sides and git's summary. */
export type PushedRef = Readonly<{ flag: string; source: string; destination: string; summary: string }>;

/**
 * THE ONE READING of `git push --porcelain` stdout (both push doors: the
 * worktree port's `pushAtomic` and the git adapter's `push`): each
 * `<flag>\t<src>:<dst>\t<summary>` line, exactly, never a search for a
 * refspec's text in git's prose (which read a ref named inside another's
 * rejection as rejected, and a remote's words as a sha: PROMO34-PUSH-DOORS).
 */
export function parsePushPorcelain(stdout: string): readonly PushedRef[] {
  const refs: PushedRef[] = [];
  for (const line of stdout.split("\n")) {
    const [flag, sides, summary] = line.split("\t");
    if (flag === undefined || flag.length !== 1 || sides === undefined || summary === undefined) continue;
    const [source, destination] = sides.split(":");
    refs.push(deepFreeze({ flag, source: source ?? "", destination: destination ?? "", summary: summary.trim() }));
  }
  return deepFreeze(refs);
}

export type GitCommitRequest = Readonly<{
  path: string;
  message: string;
  identity: GitIdentity;
  allowEmpty: boolean;
  stageAll: boolean;
}>;

export type GitCommitResult = Readonly<{
  commitSha: string;
  treeSha: string;
  parentShas: readonly string[];
}>;

export type GitBranchRequest = Readonly<{
  path: string;
  name: string;
  startPoint?: string;
  checkout: boolean;
}>;

export type GitBranchResult = Readonly<{
  name: string;
  sha: string;
  checkedOut: boolean;
}>;

export type GitTagRequest = Readonly<{
  path: string;
  name: string;
  target?: string;
  annotated: boolean;
  message?: string;
  identity?: GitIdentity;
}>;

export type GitTagResult = Readonly<{
  name: string;
  sha: string;
  annotated: boolean;
}>;

export type GitCheckoutRequest = Readonly<{
  path: string;
  ref: string;
  createBranch?: string;
}>;

export type GitCheckoutResult = Readonly<{
  ref: string;
  head: string;
  branch: string | null;
}>;

export type GitMergeRequest = Readonly<{
  path: string;
  branch: string;
  identity: GitIdentity;
  noFastForward: boolean;
  noCommit: boolean;
}>;

export type GitMergeResult = Readonly<{
  fastForward: boolean;
  merged: boolean;
  conflicts: readonly string[];
  commitSha: string | null;
}>;

export type GitRebaseRequest = Readonly<{
  path: string;
  branch: string;
  identity: GitIdentity;
}>;

export type GitRebaseResult = Readonly<{
  rebased: boolean;
  conflicts: readonly string[];
  commitSha: string | null;
}>;

export type GitStatusEntry = Readonly<{
  path: string;
  statusCode: string;
  staged: boolean;
  conflict: boolean;
  untracked: boolean;
  ignored: boolean;
}>;

export type GitStatusRequest = Readonly<{
  path: string;
  porcelain: 1 | 2;
  showIgnored: boolean;
}>;

export type GitStatusResult = Readonly<{
  branch: string | null;
  head: string | null;
  detached: boolean;
  unborn: boolean;
  entries: readonly GitStatusEntry[];
  clean: boolean;
}>;

export type GitDiffRequest = Readonly<{
  path: string;
  refA?: string;
  refB?: string;
  staged: boolean;
  contextLines: number;
}>;

export type GitDiffResult = Readonly<{
  patch: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}>;

export type GitLogEntry = Readonly<{
  sha: string;
  parents: readonly string[];
  author: GitIdentity;
  authorDate: string;
  committer: GitIdentity;
  commitDate: string;
  message: string;
  treeSha: string;
}>;

export type GitLogRequest = Readonly<{
  path: string;
  maxCount: number;
  ref?: string;
  format: "oneline" | "full" | "raw";
}>;

export type GitLogResult = Readonly<{
  entries: readonly GitLogEntry[];
  total: number;
}>;

export type GitRemoteInfo = Readonly<{
  name: string;
  fetchUrl: string | null;
  pushUrl: string | null;
  fetchRefspecs: readonly string[];
  pushRefspecs: readonly string[];
}>;

export type GitRefInfo = Readonly<{
  name: string;
  sha: string;
  isBranch: boolean;
  isTag: boolean;
  isRemote: boolean;
  isHead: boolean;
  annotated: boolean;
  target?: string;
}>;

export type GitRepositoryInfo = Readonly<{
  path: string;
  bare: boolean;
  gitDir: string;
  workTree: string | null;
  head: string;
  headUnborn: boolean;
  headDetached: boolean;
  currentBranch: string | null;
  remotes: readonly GitRemoteInfo[];
  refs: readonly GitRefInfo[];
  objectFormat: string;
  refStorage: string;
}>;

export type GitConflictInfo = Readonly<{
  path: string;
  stage: number;
  ourSha: string | null;
  theirSha: string | null;
  baseSha: string | null;
}>;

export type GitConflictResult = Readonly<{
  conflicts: readonly GitConflictInfo[];
  hasConflicts: boolean;
}>;

export type GitNeverPushViolation = Readonly<{
  pattern: string;
  path: string;
  classification: string;
  reason: string;
}>;

export type GitNeverPushScanResult = Readonly<{
  violations: readonly GitNeverPushViolation[];
  clean: boolean;
}>;

export type GitPromotionRequest = Readonly<{
  path: string;
  sourceBranch: string;
  targetBranch: string;
  identity: GitIdentity;
  fastForwardOnly: boolean;
}>;

export type GitPromotionResult = Readonly<{
  promoted: boolean;
  fastForward: boolean;
  targetSha: string;
  sourceSha: string;
}>;

export type GitRollbackRequest = Readonly<{
  path: string;
  target: string;
  identity: GitIdentity;
  mode: "revert" | "reset-soft" | "reset-mixed";
}>;

export type GitRollbackResult = Readonly<{
  reverted: boolean;
  reset: boolean;
  newHead: string;
  commitSha: string | null;
}>;

export type GitOperationKind =
  | "init"
  | "clone"
  | "pull"
  | "push"
  | "commit"
  | "branch"
  | "tag"
  | "checkout"
  | "merge"
  | "rebase"
  | "status"
  | "diff"
  | "log"
  | "remote"
  | "ref"
  | "inspect"
  | "promote"
  | "rollback"
  | "never-push-scan"
  | "conflict-check";

export type GitError = Readonly<{
  code: string;
  message: string;
  retryable: boolean;
  stdout: string | null;
  stderr: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}>;

export type GitOperationContext = Readonly<{
  workingDirectory: string;
  identity: GitIdentity;
  environment: Readonly<Record<string, string>>;
  timeoutMs: number;
  operation: GitOperationKind;
  description: string;
}>;

export type GitEffectRecorder = Readonly<{
  recordGitOperation(input: Readonly<{
    operation: string;
    description: string;
    correlation?: Readonly<{ runId?: string; turnId?: string }>;
  }>): Readonly<{ eventId: string; sequence: string; chainHash: string }>;

  recordCommit(input: Readonly<{
    commitSha: string;
    description: string;
    correlation?: Readonly<{ runId?: string; turnId?: string }>;
  }>): Readonly<{ eventId: string; sequence: string; chainHash: string }>;
}>;

export type GitPort = Readonly<{
  readonly schemaVersion: typeof GIT_PORT_SCHEMA_VERSION;

  init(request: GitInitRequest, context: GitOperationContext): GitInitResult;
  clone(request: GitCloneRequest, context: GitOperationContext): GitCloneResult;
  pull(request: GitPullRequest, context: GitOperationContext): GitPullResult;
  push(request: GitPushRequest, context: GitOperationContext): GitPushResult;
  commit(request: GitCommitRequest, context: GitOperationContext): GitCommitResult;
  branch(request: GitBranchRequest, context: GitOperationContext): GitBranchResult;
  tag(request: GitTagRequest, context: GitOperationContext): GitTagResult;
  checkout(request: GitCheckoutRequest, context: GitOperationContext): GitCheckoutResult;
  merge(request: GitMergeRequest, context: GitOperationContext): GitMergeResult;
  rebase(request: GitRebaseRequest, context: GitOperationContext): GitRebaseResult;
  status(request: GitStatusRequest, context: GitOperationContext): GitStatusResult;
  diff(request: GitDiffRequest, context: GitOperationContext): GitDiffResult;
  log(request: GitLogRequest, context: GitOperationContext): GitLogResult;

  inspectRepository(path: string, context: GitOperationContext): GitRepositoryInfo;
  checkConflicts(path: string, context: GitOperationContext): GitConflictResult;
  scanNeverPush(
    path: string,
    config: GitNeverPushConfig,
    context: GitOperationContext,
  ): GitNeverPushScanResult;

  promote(request: GitPromotionRequest, context: GitOperationContext): GitPromotionResult;
  rollback(request: GitRollbackRequest, context: GitOperationContext): GitRollbackResult;
}>;

export const GIT_PORT_OPERATIONS = deepFreeze([
  "init",
  "clone",
  "pull",
  "push",
  "commit",
  "branch",
  "tag",
  "checkout",
  "merge",
  "rebase",
  "status",
  "diff",
  "log",
  "remote",
  "ref",
  "inspect",
  "promote",
  "rollback",
  "never-push-scan",
  "conflict-check",
] as const);

export function isValidGitOperation(value: unknown): value is GitOperationKind {
  return typeof value === "string" && (GIT_PORT_OPERATIONS as readonly string[]).includes(value);
}

export function isValidGitTransport(value: unknown): value is GitTransport {
  return typeof value === "string" && (GIT_TRANSPORTS as readonly string[]).includes(value);
}

export function isValidGitReconciliationMode(value: unknown): value is GitReconciliationMode {
  return typeof value === "string" && (GIT_RECONCILIATION_MODES as readonly string[]).includes(value);
}

export function isValidGitWorkspaceState(value: unknown): value is GitWorkspaceState {
  return typeof value === "string" && (GIT_WORKSPACE_STATES as readonly string[]).includes(value);
}

export function isValidGitWorkspacePlan(value: unknown): value is GitWorkspacePlan {
  return typeof value === "string" && (GIT_WORKSPACE_PLANS as readonly string[]).includes(value);
}

export function isValidGitAuthMethod(value: unknown): value is GitAuthMethod {
  return typeof value === "string" && (GIT_AUTH_METHODS as readonly string[]).includes(value);
}
