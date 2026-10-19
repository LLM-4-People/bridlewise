import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { InputError, SecurityError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import {
  type GitCheckoutResult,
  type GitConflictResult,
  type GitIdentity,
  type GitOperationContext,
  type GitPort,
  type GitRepositoryInfo,
  type GitWorkspacePlan,
  type GitWorkspaceState,
  type WorkspaceGitConfig,
} from "./git-port.ts";

/**
 * Workspace lifecycle — per delivery map item 10.
 *
 * "Interactively handle empty folders, existing data, existing repositories,
 * init/clone/pull, separate source and push remotes/forks, authentication
 * boundaries, exclusions that can never be pushed, sync conflicts, branches,
 * per-feature tags/checkpoints, tests, testing promotion, and rollback."
 *
 * Per the root-policy `workspaceGitArchitecture`:
 * workspaceStates: empty, nonempty-unversioned, repository, linked-worktree,
 * bare, nested, corrupt-or-ambiguous
 * plans: init-empty, clone, import-and-init, attach, reconcile, fork
 * remoteModel: fetch-upstream-and-push-origin-fork-urls-branches-refspecs-are-independent
 * integration: fetch-and-graph-analysis-then-explicit-fast-forward-only-rebase-or-merge-never-opaque-pull
 * destructiveDefaultsAllowed: false
 * forcePushDefaultAllowed: false
 *
 * The lifecycle module wraps the GitPort to provide higher-level workspace
 * operations: onboarding, remote management, conflict detection, promotion,
 * and rollback.
 */

export type WorkspaceOnboardingRequest = Readonly<{
  path: string;
  plan: GitWorkspacePlan;
  identity: GitIdentity;
  remoteUrl?: string;
  remoteName?: string;
  bare?: boolean;
  initialBranch?: string;
  depth?: number;
}>;

export type WorkspaceOnboardingResult = Readonly<{
  path: string;
  state: GitWorkspaceState;
  plan: GitWorkspacePlan;
  repositoryInfo: GitRepositoryInfo | null;
  action: string;
}>;

export type RemoteManagementRequest = Readonly<{
  path: string;
  fetchRemoteName: string;
  fetchUrl: string;
  pushRemoteName?: string;
  pushUrl?: string;
  fetchRefspecs?: readonly string[];
  pushRefspecs?: readonly string[];
}>;

export type RemoteManagementResult = Readonly<{
  fetchRemote: Readonly<{ name: string; urlIdentity: string; refspecs: readonly string[] }>;
  pushRemote: Readonly<{ name: string; urlIdentity: string; refspecs: readonly string[] }>;
  separate: boolean;
}>;

export type SyncRequest = Readonly<{
  path: string;
  remote: string;
  branch: string;
  identity: GitIdentity;
  reconciliation: "fast-forward-only" | "merge" | "rebase";
}>;

export type SyncResult = Readonly<{
  pulled: boolean;
  fastForward: boolean;
  upToDate: boolean;
  conflicts: readonly string[];
  repositoryInfo: GitRepositoryInfo;
}>;

export type FeatureBranchRequest = Readonly<{
  path: string;
  branchName: string;
  startPoint?: string;
  identity: GitIdentity;
}>;

export type FeatureBranchResult = Readonly<{
  branchName: string;
  sha: string;
  created: boolean;
  checkedOut: boolean;
}>;

export type CheckpointRequest = Readonly<{
  path: string;
  name: string;
  message: string;
  identity: GitIdentity;
  target?: string;
}>;

export type CheckpointResult = Readonly<{
  name: string;
  sha: string;
  annotated: boolean;
}>;

export type PromotionRequest = Readonly<{
  path: string;
  sourceBranch: string;
  targetBranch: string;
  identity: GitIdentity;
}>;

export type PromotionResult = Readonly<{
  promoted: boolean;
  fastForward: boolean;
  targetSha: string;
  sourceSha: string;
  clean: boolean;
}>;

export type RollbackRequest = Readonly<{
  path: string;
  target: string;
  identity: GitIdentity;
  mode: "revert" | "reset-soft" | "reset-mixed";
}>;

export type RollbackResult = Readonly<{
  reverted: boolean;
  reset: boolean;
  newHead: string;
  commitSha: string | null;
}>;

export type WorkspaceLifecycle = Readonly<{
  onboarding: Readonly<{
    detect(path: string, context: GitOperationContext): GitWorkspaceState;
    recommend(path: string, state: GitWorkspaceState): GitWorkspacePlan;
    execute(request: WorkspaceOnboardingRequest, context: GitOperationContext): WorkspaceOnboardingResult;
  }>;
  remotes: Readonly<{
    configure(request: RemoteManagementRequest, context: GitOperationContext): RemoteManagementResult;
    list(path: string, context: GitOperationContext): readonly GitRepositoryInfo["remotes"][number][];
  }>;
  sync: Readonly<{
    pull(request: SyncRequest, context: GitOperationContext): SyncResult;
    detectConflicts(path: string, context: GitOperationContext): GitConflictResult;
  }>;
  branches: Readonly<{
    createFeatureBranch(request: FeatureBranchRequest, context: GitOperationContext): FeatureBranchResult;
    list(path: string, context: GitOperationContext): readonly string[];
    switch(path: string, branch: string, context: GitOperationContext): GitCheckoutResult;
  }>;
  checkpoints: Readonly<{
    create(request: CheckpointRequest, context: GitOperationContext): CheckpointResult;
    list(path: string, namespace: string, context: GitOperationContext): readonly CheckpointResult[];
  }>;
  promotion: Readonly<{
    promote(request: PromotionRequest, context: GitOperationContext): PromotionResult;
    verifyClean(path: string, context: GitOperationContext): boolean;
  }>;
  rollback: Readonly<{
    execute(request: RollbackRequest, context: GitOperationContext): RollbackResult;
  }>;
}>;

export function createWorkspaceLifecycle(
  git: GitPort,
  config: WorkspaceGitConfig,
): WorkspaceLifecycle {
  function detectWorkspaceState(path: string, context: GitOperationContext): GitWorkspaceState {
    if (!isAbsolute(path)) {
      throw new InputError("Workspace path must be absolute", "workspace_path_invalid");
    }
    if (!existsSync(path)) return "corrupt-or-ambiguous";
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return "corrupt-or-ambiguous";
    }
    if (!stat.isDirectory()) return "corrupt-or-ambiguous";

    try {
      const info = git.inspectRepository(path, context);
      if (info.bare) return "bare";
      if (info.gitDir !== resolve(path, ".git")) return "linked-worktree";
      if (info.workTree !== null && info.workTree !== path) return "nested";
      return "repository";
    } catch {
      const entries = readdirSync(path);
      if (entries.length === 0) return "empty";
      return "nonempty-unversioned";
    }
  }

  function recommendPlan(path: string, state: GitWorkspaceState): GitWorkspacePlan {
    void path;
    switch (state) {
      case "empty": return "init-empty";
      case "nonempty-unversioned": return "import-and-init";
      case "repository": return "reconcile";
      case "linked-worktree": return "attach";
      case "bare": return "fork";
      case "nested": return "attach";
      case "corrupt-or-ambiguous": return "reconcile";
    }
  }

  function executeOnboarding(
    request: WorkspaceOnboardingRequest,
    context: GitOperationContext,
  ): WorkspaceOnboardingResult {
    const state = detectWorkspaceState(request.path, context);
    const plan = request.plan;
    const identity = request.identity;

    if (plan === "init-empty") {
      if (state !== "empty") {
        throw new SecurityError(
          `Cannot init on non-empty path: ${request.path}`,
          "workspace_init_non_empty",
        );
      }
      git.init(
        deepFreeze({
          path: request.path,
          bare: request.bare ?? false,
          initialBranch: request.initialBranch ?? config.defaultBranch,
          identity,
        }),
        { ...context, workingDirectory: "/" },
      );
      const repoInfo = git.inspectRepository(request.path, { ...context, workingDirectory: request.path });
      return deepFreeze({
        path: request.path,
        state: "repository",
        plan: "init-empty",
        repositoryInfo: repoInfo,
        action: "init",
      });
    }

    if (plan === "clone") {
      if (request.remoteUrl === undefined) {
        throw new InputError("Clone requires remoteUrl", "workspace_clone_no_url");
      }
      if (state !== "empty") {
        throw new SecurityError(
          `Cannot clone into non-empty path: ${request.path}`,
          "workspace_clone_non_empty",
        );
      }
      git.clone(
        deepFreeze({
          url: request.remoteUrl,
          destination: request.path,
          bare: request.bare ?? false,
          ...(request.initialBranch !== undefined ? { branch: request.initialBranch } : {}),
          ...(request.depth !== undefined ? { depth: request.depth } : {}),
          identity,
        }),
        { ...context, workingDirectory: "/" },
      );
      const repoInfo = git.inspectRepository(request.path, { ...context, workingDirectory: request.path });
      return deepFreeze({
        path: request.path,
        state: "repository",
        plan: "clone",
        repositoryInfo: repoInfo,
        action: "clone",
      });
    }

    if (plan === "import-and-init") {
      if (state !== "nonempty-unversioned") {
        throw new SecurityError(
          `Import-and-init requires nonempty-unversioned: ${request.path}`,
          "workspace_import_wrong_state",
        );
      }
      git.init(
        deepFreeze({
          path: request.path,
          bare: false,
          initialBranch: request.initialBranch ?? config.defaultBranch,
          identity,
        }),
        { ...context, workingDirectory: "/" },
      );
      git.commit(
        deepFreeze({
          path: request.path,
          message: "Import existing data",
          identity,
          allowEmpty: false,
          stageAll: true,
        }),
        { ...context, workingDirectory: request.path },
      );
      const repoInfo = git.inspectRepository(request.path, { ...context, workingDirectory: request.path });
      return deepFreeze({
        path: request.path,
        state: "repository",
        plan: "import-and-init",
        repositoryInfo: repoInfo,
        action: "import",
      });
    }

    if (plan === "attach") {
      if (state !== "linked-worktree" && state !== "nested") {
        throw new SecurityError(
          `Attach requires linked-worktree or nested: ${request.path}`,
          "workspace_attach_wrong_state",
        );
      }
      const repoInfo = git.inspectRepository(request.path, { ...context, workingDirectory: request.path });
      return deepFreeze({
        path: request.path,
        state,
        plan: "attach",
        repositoryInfo: repoInfo,
        action: "attach",
      });
    }

    if (plan === "reconcile") {
      if (state !== "repository" && state !== "corrupt-or-ambiguous") {
        throw new SecurityError(
          `Reconcile requires repository: ${request.path}`,
          "workspace_reconcile_wrong_state",
        );
      }
      const repoInfo = git.inspectRepository(request.path, { ...context, workingDirectory: request.path });
      return deepFreeze({
        path: request.path,
        state: "repository",
        plan: "reconcile",
        repositoryInfo: repoInfo,
        action: "reconcile",
      });
    }

    if (plan === "fork") {
      if (state !== "bare") {
        throw new SecurityError(
          `Fork requires bare: ${request.path}`,
          "workspace_fork_wrong_state",
        );
      }
      if (request.remoteUrl === undefined) {
        throw new InputError("Fork requires remoteUrl", "workspace_fork_no_url");
      }
      const repoInfo = git.inspectRepository(request.path, { ...context, workingDirectory: request.path });
      return deepFreeze({
        path: request.path,
        state: "bare",
        plan: "fork",
        repositoryInfo: repoInfo,
        action: "fork",
      });
    }

    throw new InputError("Unknown workspace plan", "workspace_plan_unknown");
  }

  function configureRemotes(
    request: RemoteManagementRequest,
    context: GitOperationContext,
  ): RemoteManagementResult {
    void context;
    if (!isAbsolute(request.path)) {
      throw new InputError("Remote config path must be absolute", "workspace_remote_path_invalid");
    }
    const fetchUrl = sanitizeUrl(request.fetchUrl);
    const pushUrl = request.pushUrl !== undefined ? sanitizeUrl(request.pushUrl) : fetchUrl;
    const fetchRefspecs = request.fetchRefspecs ?? [`+refs/heads/*:refs/remotes/${request.fetchRemoteName}/*`];
    const pushRefspecs = request.pushRefspecs ?? [];
    const separate = request.pushRemoteName !== undefined && request.pushRemoteName !== request.fetchRemoteName;

    if (separate && request.pushRemoteName !== undefined) {
      return deepFreeze({
        fetchRemote: deepFreeze({
          name: request.fetchRemoteName,
          urlIdentity: fetchUrl,
          refspecs: fetchRefspecs,
        }),
        pushRemote: deepFreeze({
          name: request.pushRemoteName,
          urlIdentity: pushUrl,
          refspecs: pushRefspecs,
        }),
        separate: true,
      });
    }

    return deepFreeze({
      fetchRemote: deepFreeze({
        name: request.fetchRemoteName,
        urlIdentity: fetchUrl,
        refspecs: fetchRefspecs,
      }),
      pushRemote: deepFreeze({
        name: request.fetchRemoteName,
        urlIdentity: pushUrl,
        refspecs: pushRefspecs,
      }),
      separate: false,
    });
  }

  function listRemotes(
    path: string,
    context: GitOperationContext,
  ): readonly GitRepositoryInfo["remotes"][number][] {
    const info = git.inspectRepository(path, context);
    return info.remotes;
  }

  function pullSync(request: SyncRequest, context: GitOperationContext): SyncResult {
    const pullResult = git.pull(
      deepFreeze({
        path: request.path,
        remote: request.remote,
        branch: request.branch,
        reconciliation: request.reconciliation,
        identity: request.identity,
      }),
      { ...context, workingDirectory: request.path },
    );
    const repoInfo = git.inspectRepository(request.path, { ...context, workingDirectory: request.path });
    return deepFreeze({
      pulled: !pullResult.upToDate,
      fastForward: pullResult.fastForward,
      upToDate: pullResult.upToDate,
      conflicts: pullResult.conflicts,
      repositoryInfo: repoInfo,
    });
  }

  function detectConflicts(path: string, context: GitOperationContext): GitConflictResult {
    return git.checkConflicts(path, { ...context, workingDirectory: path });
  }

  function createFeatureBranch(
    request: FeatureBranchRequest,
    context: GitOperationContext,
  ): FeatureBranchResult {
    const branchResult = git.branch(
      deepFreeze({
        path: request.path,
        name: request.branchName,
        ...(request.startPoint !== undefined ? { startPoint: request.startPoint } : {}),
        checkout: true,
      }),
      { ...context, workingDirectory: request.path },
    );
    return deepFreeze({
      branchName: branchResult.name,
      sha: branchResult.sha,
      created: true,
      checkedOut: branchResult.checkedOut,
    });
  }

  function listBranches(path: string, context: GitOperationContext): readonly string[] {
    const info = git.inspectRepository(path, { ...context, workingDirectory: path });
    return info.refs.filter((ref) => ref.isBranch).map((ref) => ref.name);
  }

  function switchBranch(
    path: string,
    branch: string,
    context: GitOperationContext,
  ): GitCheckoutResult {
    return git.checkout(
      deepFreeze({ path, ref: branch }),
      { ...context, workingDirectory: path },
    );
  }

  function createCheckpoint(
    request: CheckpointRequest,
    context: GitOperationContext,
  ): CheckpointResult {
    const tagName = `${config.checkpoint.namespace}/${request.name}`;
    const tagResult = git.tag(
      deepFreeze({
        path: request.path,
        name: tagName,
        ...(request.target !== undefined ? { target: request.target } : {}),
        annotated: true,
        message: request.message,
        identity: request.identity,
      }),
      { ...context, workingDirectory: request.path },
    );
    return deepFreeze({
      name: tagResult.name,
      sha: tagResult.sha,
      annotated: tagResult.annotated,
    });
  }

  function listCheckpoints(
    path: string,
    namespace: string,
    context: GitOperationContext,
  ): readonly CheckpointResult[] {
    const info = git.inspectRepository(path, { ...context, workingDirectory: path });
    const prefix = `${namespace}/`;
    return info.refs
      .filter((ref) => ref.isTag && ref.name.startsWith(`refs/tags/${prefix}`))
      .map((ref) => deepFreeze({
        name: ref.name,
        sha: ref.sha,
        annotated: ref.annotated,
      }));
  }

  function promoteBranch(
    request: PromotionRequest,
    context: GitOperationContext,
  ): PromotionResult {
    const neverPushScan = git.scanNeverPush(
      request.path,
      config.neverPush,
      { ...context, workingDirectory: request.path },
    );
    if (!neverPushScan.clean) {
      throw new SecurityError(
        `Cannot promote: never-push violations detected: ${neverPushScan.violations.length}`,
        "workspace_promote_never_push_violation",
      );
    }
    const status = git.status(
      deepFreeze({ path: request.path, porcelain: 2, showIgnored: false }),
      { ...context, workingDirectory: request.path },
    );
    if (!status.clean) {
      throw new SecurityError(
        "Cannot promote: working tree is not clean",
        "workspace_promote_not_clean",
      );
    }
    const promotionResult = git.promote(
      deepFreeze({
        path: request.path,
        sourceBranch: request.sourceBranch,
        targetBranch: request.targetBranch,
        identity: request.identity,
        fastForwardOnly: true,
      }),
      { ...context, workingDirectory: request.path },
    );
    return deepFreeze({
      promoted: promotionResult.promoted,
      fastForward: promotionResult.fastForward,
      targetSha: promotionResult.targetSha,
      sourceSha: promotionResult.sourceSha,
      clean: true,
    });
  }

  function verifyClean(path: string, context: GitOperationContext): boolean {
    const status = git.status(
      deepFreeze({ path, porcelain: 2, showIgnored: false }),
      { ...context, workingDirectory: path },
    );
    return status.clean;
  }

  function executeRollback(
    request: RollbackRequest,
    context: GitOperationContext,
  ): RollbackResult {
    const result = git.rollback(
      deepFreeze({
        path: request.path,
        target: request.target,
        identity: request.identity,
        mode: request.mode,
      }),
      { ...context, workingDirectory: request.path },
    );
    return deepFreeze({
      reverted: result.reverted,
      reset: result.reset,
      newHead: result.newHead,
      commitSha: result.commitSha,
    });
  }

  return deepFreeze({
    onboarding: deepFreeze({
      detect: detectWorkspaceState,
      recommend: recommendPlan,
      execute: executeOnboarding,
    }),
    remotes: deepFreeze({
      configure: configureRemotes,
      list: listRemotes,
    }),
    sync: deepFreeze({
      pull: pullSync,
      detectConflicts: detectConflicts,
    }),
    branches: deepFreeze({
      createFeatureBranch: createFeatureBranch,
      list: listBranches,
      switch: switchBranch,
    }),
    checkpoints: deepFreeze({
      create: createCheckpoint,
      list: listCheckpoints,
    }),
    promotion: deepFreeze({
      promote: promoteBranch,
      verifyClean: verifyClean,
    }),
    rollback: deepFreeze({
      execute: executeRollback,
    }),
  });
}

function sanitizeUrl(url: string): string {
  const credentialPattern = /^[^@]*@/u;
  return url.replace(credentialPattern, "");
}

export type {
  GitWorkspaceState,
  GitWorkspacePlan,
  WorkspaceGitConfig,
};
