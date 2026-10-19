import { isAbsolute } from "node:path";

import { InputError, SecurityError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import {
  createGitAdapter,
  defaultOperationContext,
  resolveGitExecutable,
  withGitRuntime,
  type GitAdapterOptions,
  type GitIoLimits,
  type GitRuntime,
} from "../git/git-adapter.ts";
import {
  type GitEffectRecorder,
  type GitIdentity,
  type GitOperationContext,
  type GitPort,
  type GitRemoteRole,
  type WorkspaceGitConfig as RuntimeWorkspaceGitConfig,
} from "../git/git-port.ts";
import type { WorkspaceGitConfig } from "../kernel/config-contracts.ts";
import type { RegisteredTool, ToolContext } from "./tool-registry.ts";
import { redactText } from "../privacy/redaction-engine.ts";
import type { PrivacyPolicy } from "../privacy/privacy-policy.ts";
import { DEFAULT_TOOL_RESOURCE_BOUNDS } from "../tools/tool-manifest.ts";
import { DEFAULT_MAXIMUM_OUTPUT_BYTES } from "../git/git-config.ts";
import {
  assertString,
  optionalString,
  resolveBoolean,
  resolvePositiveInt,
} from "./tool-args.ts";

/**
 * Git tools for the interactive chat runtime (delivery-map item 10).
 *
 * Exposes governed Git operations to the model:
 * - git_status: porcelain v2 status (read-only)
 * - git_diff: diff with optional refs and context lines (read-only)
 * - git_log: commit log (read-only)
 * - git_branch: create a branch (optionally check it out)
 * - git_commit: stage-all and commit (mutation)
 *
 * The tools are registered only when the central configuration document
 * declares a `workspaceGit` section. The GitPort enforces
 * `GIT_OPTIONAL_LOCKS=0`, rejects credentials in remote URLs, and rejects
 * force push (the config schema pins `push.force` to `false`).
 *
 * Per root-policy `workspaceGitArchitecture.runtimeEnforcementAvailable:
 * false`, the OS-enforced privileged broker is a future slice; these tools
 * call the implemented GitPort directly. All operations are recorded in the
 * timeline via the optional {@link GitEffectRecorder}.
 *
 * The `WorkspaceGitConfig` schema has no Git identity field, so a default
 * harness identity is used unless one is supplied via {@link
 * GitToolsOptions.identity}. This is a documented gap pending a config
 * identity field.
 */

export type GitToolsOptions = Readonly<{
  repositoryRoot: string;
  /** The central config document's `workspaceGit` section. */
  config: WorkspaceGitConfig;
  identity?: GitIdentity;
  recorder?: GitEffectRecorder;
  correlation?: Readonly<{ runId?: string; turnId?: string }>;
  gitExecutablePath?: string;
  gitIoLimits?: GitIoLimits;
  /**
   * Optional privacy policy used to redact commit messages (and other
   * operation descriptions) before they reach the durable timeline. When
   * provided, the recorder is wrapped so secret-like spans in the commit
   * message are redacted (MINOR-8).
   */
  privacyPolicy?: PrivacyPolicy;
  /**
   * Injectable adapter factory for tests. Production leaves this undefined
   * so the real {@link createGitAdapter} is used.
   */
  adapterFactory?: (runtime: GitRuntime, options: GitAdapterOptions) => GitPort;
  /**
   * Maximum UTF-8 bytes of patch content git_diff returns (G-1). When the
   * patch exceeds the cap the result carries stats, a bounded per-file
   * summary, and a truncated patch; when it exceeds the cap by the
   * stats-only factor the patch is omitted entirely. Defaults to
   * `tools.defaultBounds.maxOutputBytes` (threaded by the chat runtime) or
   * {@link DEFAULT_TOOL_RESOURCE_BOUNDS.maxOutputBytes} when absent.
   */
  maxOutputBytes?: number;
}>;

const DEFAULT_IDENTITY: GitIdentity = deepFreeze({ name: "Code Harness", email: "bridlewise@local" });

import {
  DEFAULT_CONTEXT_LINES,
  GIT_MAX_LOG_ENTRIES as MAX_LOG_ENTRIES,
  GIT_DEFAULT_LOG_COUNT,
  GIT_MAX_MESSAGE_LENGTH as MAX_MESSAGE_LENGTH,
  GIT_STATS_ONLY_FACTOR as STATS_ONLY_FACTOR,
  GIT_MAX_SUMMARY_FILES as MAX_SUMMARY_FILES,
  GIT_REF_MAX_LENGTH,
  GIT_CONTEXT_LINES_MAX,
} from "./runtime-config.ts";

/**
 * G-1: a patch larger than maxOutputBytes × STATS_ONLY_FACTOR returns stats
 * only (no patch content) — even a truncated patch would be too large to be
 * useful and would still overflow the model's context. (STATS_ONLY_FACTOR is
 * imported from the canonical runtime-config owner.)
 */
// MAX_SUMMARY_FILES caps per-file summary entries (imported from runtime-config).

type DiffFileSummary = Readonly<{
  path: string;
  insertions: number;
  deletions: number;
}>;

/**
 * Build a per-file insertion/deletion summary from a unified-diff patch.
 * Pure parsing over the already-computed patch; no additional git calls.
 */
function summarizePatchFiles(patch: string): readonly DiffFileSummary[] {
  const files: DiffFileSummary[] = [];
  let currentPath: string | null = null;
  let insertions = 0;
  let deletions = 0;
  const flush = (): void => {
    if (currentPath !== null && files.length < MAX_SUMMARY_FILES) {
      files.push(deepFreeze({ path: currentPath, insertions, deletions }));
    }
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      // `diff --git a/<path> b/<path>`; the b/ side is the postimage path.
      const bIndex = line.lastIndexOf(" b/");
      currentPath = bIndex !== -1 ? line.slice(bIndex + 3) : line.slice("diff --git ".length);
      insertions = 0;
      deletions = 0;
    } else if (currentPath !== null) {
      if (line.startsWith("+") && !line.startsWith("+++")) insertions += 1;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
    }
  }
  flush();
  return deepFreeze(files);
}

/** Truncate a UTF-8 string to a byte budget without splitting a code point. */
function truncateUtf8(text: string, maxBytes: number): string {
  return Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
}

/**
 * Wrap a GitEffectRecorder so every recorded description is redacted through
 * the privacy policy before reaching the durable timeline (MINOR-8). The
 * commit message appears in the recorded description as
 * `git commit: <message>`; secret-like spans (API keys, tokens,...) are
 * replaced while surrounding structure is preserved.
 */
function createRedactingRecorder(recorder: GitEffectRecorder, policy: PrivacyPolicy): GitEffectRecorder {
  return deepFreeze({
    recordGitOperation(input) {
      return recorder.recordGitOperation({
        ...input,
        description: redactText(input.description, policy).redactedText,
      });
    },
    recordCommit(input) {
      return recorder.recordCommit({
        ...input,
        description: redactText(input.description, policy).redactedText,
      });
    },
  });
}

export function createGitTools(options: GitToolsOptions): readonly RegisteredTool[] {
  const repositoryRoot = options.repositoryRoot;
  if (!isAbsolute(repositoryRoot)) {
    throw new InputError("repositoryRoot must be an absolute path", "tool_arguments_invalid");
  }
  const identity = options.identity ?? DEFAULT_IDENTITY;
  const runtimeConfig = resolveRuntimeWorkspaceGitConfig(options.config);
  const config = runtimeConfig;
  const gitExecutablePath = options.gitExecutablePath ?? options.config.gitExecutablePath ?? resolveGitExecutable();
  const ioLimits = options.gitIoLimits ?? options.config.gitIoLimits;
  const maxBytes = ioLimits?.maxOutputBytes ?? DEFAULT_MAXIMUM_OUTPUT_BYTES;
  const maxDiffOutputBytes = options.maxOutputBytes ?? DEFAULT_TOOL_RESOURCE_BOUNDS.maxOutputBytes;
  const adapterFactory = options.adapterFactory ?? createGitAdapter;
  // MINOR-8: redact recorded descriptions (notably the commit message) when a
  // privacy policy is configured. The wrapped recorder is what the adapter
  // records through, so redaction happens at the egress boundary.
  const recorder = options.recorder !== undefined && options.privacyPolicy !== undefined
    ? createRedactingRecorder(options.recorder, options.privacyPolicy)
    : options.recorder;

  function runGit<Result>(operation: (git: GitPort, context: GitOperationContext) => Result, opKind: string): Result {
    return withGitRuntime(gitExecutablePath, maxBytes, (runtime) => {
      const git = adapterFactory(runtime, deepFreeze({
        config,
        ...(recorder !== undefined ? { recorder } : {}),
        ...(options.correlation !== undefined ? { correlation: options.correlation } : {}),
        ...(ioLimits !== undefined ? { gitIoLimits: ioLimits } : {}),
      }));
      const context = defaultOperationContext(repositoryRoot, identity, opKind, config.timeouts.inspectMs);
      return operation(git, context);
    });
  }

  const gitStatus: RegisteredTool = deepFreeze({
    definition: deepFreeze({
      type: "function",
      function: deepFreeze({
        name: "git_status",
        description: "Return the Git porcelain v2 status of the repository: branch, head, and per-file entries (staged, conflict, untracked, ignored). Read-only. Respects GIT_OPTIONAL_LOCKS=0.",
        parameters: deepFreeze({
          type: "object",
          properties: deepFreeze({}),
          required: [],
          additionalProperties: false,
        }),
      }),
    }),
    handler(_args: Readonly<Record<string, unknown>>, _context: ToolContext): string {
      const result = runGit((git, ctx) => git.status(deepFreeze({ path: repositoryRoot, porcelain: 2, showIgnored: false }), ctx), "status");
      return JSON.stringify(deepFreeze({
        branch: result.branch,
        head: result.head,
        detached: result.detached,
        unborn: result.unborn,
        clean: result.clean,
        entries: result.entries,
      }));
    },
  });

  const gitDiff: RegisteredTool = deepFreeze({
    definition: deepFreeze({
      type: "function",
      function: deepFreeze({
        name: "git_diff",
        description: "Return a Git diff for the repository. Optionally compare two refs, or show staged changes. Returns the patch plus insertion/deletion counts. Output is bounded: oversized diffs return stats, a per-file summary, and a truncated patch (stats only for extremely large diffs). Read-only.",
        parameters: deepFreeze({
          type: "object",
          properties: deepFreeze({
            staged: { type: "boolean", description: "Show staged (cached) changes (default false)" },
            refA: { type: "string", description: "Start ref for a ref-range diff" },
            refB: { type: "string", description: "End ref for a ref-range diff (requires refA)" },
            contextLines: { type: "integer", minimum: 0, maximum: 64, description: "Context lines (default 3)" },
          }),
          required: [],
          additionalProperties: false,
        }),
      }),
    }),
    handler(args: Readonly<Record<string, unknown>>, _context: ToolContext): string {
      const staged = resolveBoolean(args, "staged", false);
      const refA = optionalString(args, "refA", { maxLength: GIT_REF_MAX_LENGTH });
      const refB = optionalString(args, "refB", { maxLength: GIT_REF_MAX_LENGTH });
      const contextLines = resolvePositiveInt(args, "contextLines", { defaultValue: DEFAULT_CONTEXT_LINES, max: GIT_CONTEXT_LINES_MAX });
      if ((refA !== undefined) !== (refB !== undefined)) {
        throw new InputError("refA and refB must both be provided or both omitted", "tool_arguments_invalid");
      }
      const result = runGit((git, ctx) => git.diff(deepFreeze({
        path: repositoryRoot,
        staged,
        contextLines,
        ...(refA !== undefined ? { refA } : {}),
        ...(refB !== undefined ? { refB } : {}),
      }), ctx), "diff");
      // G-1: bound the returned patch so a large diff cannot overflow the
      // model's context and kill the session. Within the cap the result
      // shape is unchanged; over the cap it carries stats, a bounded
      // per-file summary, and a truncated patch; over the stats-only
      // threshold the patch is omitted entirely.
      const patchBytes = Buffer.byteLength(result.patch, "utf8");
      if (patchBytes <= maxDiffOutputBytes) {
        return JSON.stringify(deepFreeze({
          patch: result.patch,
          filesChanged: result.filesChanged,
          insertions: result.insertions,
          deletions: result.deletions,
        }));
      }
      const statsOnly = patchBytes > maxDiffOutputBytes * STATS_ONLY_FACTOR;
      return JSON.stringify(deepFreeze({
        truncated: true,
        statsOnly,
        patchBytes,
        maxOutputBytes: maxDiffOutputBytes,
        filesChanged: result.filesChanged,
        insertions: result.insertions,
        deletions: result.deletions,
        files: summarizePatchFiles(result.patch),
        patch: statsOnly ? null : truncateUtf8(result.patch, maxDiffOutputBytes),
        message: statsOnly
          ? `diff is ${patchBytes} bytes (limit ${maxDiffOutputBytes}); returning stats only — use git_diff on individual files or a narrower ref range for full output`
          : `diff truncated at ${maxDiffOutputBytes} bytes (of ${patchBytes}) — use git_diff on individual files or a narrower ref range for full output`,
      }));
    },
  });

  const gitLog: RegisteredTool = deepFreeze({
    definition: deepFreeze({
      type: "function",
      function: deepFreeze({
        name: "git_log",
        description: "Return the Git commit log for the repository (sha, author, date, message). Read-only. Bounded by maxCount (default 20, max 100).",
        parameters: deepFreeze({
          type: "object",
          properties: deepFreeze({
            maxCount: { type: "integer", minimum: 1, maximum: 100, description: "Maximum entries (default 20)" },
            ref: { type: "string", description: "Optional ref/revision to log" },
          }),
          required: [],
          additionalProperties: false,
        }),
      }),
    }),
    handler(args: Readonly<Record<string, unknown>>, _context: ToolContext): string {
      const maxCount = resolvePositiveInt(args, "maxCount", { defaultValue: GIT_DEFAULT_LOG_COUNT, max: MAX_LOG_ENTRIES });
      const ref = optionalString(args, "ref", { maxLength: GIT_REF_MAX_LENGTH });
      const result = runGit((git, ctx) => git.log(deepFreeze({
        path: repositoryRoot,
        maxCount,
        format: "full",
        ...(ref !== undefined ? { ref } : {}),
      }), ctx), "log");
      return JSON.stringify(deepFreeze({
        total: result.total,
        entries: result.entries.map((e) => deepFreeze({
          sha: e.sha,
          author: e.author,
          authorDate: e.authorDate,
          message: e.message,
        })),
      }));
    },
  });

  const gitBranch: RegisteredTool = deepFreeze({
    definition: deepFreeze({
      type: "function",
      function: deepFreeze({
        name: "git_branch",
        description: "Create a new Git branch in the repository, optionally checking it out. Returns the branch name and sha. Mutation: changes repository refs.",
        parameters: deepFreeze({
          type: "object",
          properties: deepFreeze({
            name: { type: "string", description: "Branch name to create" },
            startPoint: { type: "string", description: "Optional start point (ref or sha)" },
            checkout: { type: "boolean", description: "Check out the new branch (default false)" },
          }),
          required: ["name"],
          additionalProperties: false,
        }),
      }),
    }),
    handler(args: Readonly<Record<string, unknown>>, _context: ToolContext): string {
      const name = assertString(args, "name", { maxLength: GIT_REF_MAX_LENGTH });
      const startPoint = optionalString(args, "startPoint", { maxLength: GIT_REF_MAX_LENGTH });
      const checkout = resolveBoolean(args, "checkout", false);
      const result = runGit((git, ctx) => git.branch(deepFreeze({
        path: repositoryRoot,
        name,
        checkout,
        ...(startPoint !== undefined ? { startPoint } : {}),
      }), ctx), "branch");
      return JSON.stringify(deepFreeze({
        name: result.name,
        sha: result.sha,
        checkedOut: result.checkedOut,
      }));
    },
  });

  const gitCommit: RegisteredTool = deepFreeze({
    definition: deepFreeze({
      type: "function",
      function: deepFreeze({
        name: "git_commit",
        description: "Create a Git commit. When stageAll is true (default), stages all changes before committing. Returns the commit sha, tree sha, and parent shas. Mutation: creates a new commit.",
        parameters: deepFreeze({
          type: "object",
          properties: deepFreeze({
            message: { type: "string", description: "Commit message" },
            allowEmpty: { type: "boolean", description: "Allow an empty commit (default false)" },
            stageAll: { type: "boolean", description: "Stage all changes before committing (default true)" },
          }),
          required: ["message"],
          additionalProperties: false,
        }),
      }),
    }),
    handler(args: Readonly<Record<string, unknown>>, _context: ToolContext): string {
      const message = assertString(args, "message", { maxLength: MAX_MESSAGE_LENGTH });
      const allowEmpty = resolveBoolean(args, "allowEmpty", false);
      const stageAll = resolveBoolean(args, "stageAll", true);
      const result = runGit((git, ctx) => {
        // MINOR-8: when staging all changes, refuse the commit if never-push
        // files are present so `git add -A` cannot stage secrets/private state
        // that must never be pushed. The GitPort.scanNeverPush is the canonical
        // never-push scanner; it is always available on the runtime GitPort.
        if (stageAll) {
          const scan = git.scanNeverPush(repositoryRoot, config.neverPush, ctx);
          if (!scan.clean) {
            const offending = scan.violations.map((v) => v.path).join(", ");
            throw new SecurityError(
              `git_commit refused: never-push files would be staged by 'git add -A': ${offending}`,
              "git_never_push_violation",
            );
          }
        }
        return git.commit(deepFreeze({
          path: repositoryRoot,
          message,
          identity,
          allowEmpty,
          stageAll,
        }), ctx);
      }, "commit");
      return JSON.stringify(deepFreeze({
        commitSha: result.commitSha,
        treeSha: result.treeSha,
        parentShas: result.parentShas,
      }));
    },
  });

  return deepFreeze([gitStatus, gitDiff, gitLog, gitBranch, gitCommit]);
}

/**
 * Resolve the central config document's `workspaceGit` section into the
 * runtime {@link RuntimeWorkspaceGitConfig} expected by the GitPort adapter.
 *
 * This is the integration adapter between the zod-validated config type
 * (which uses `T | undefined` for optionals under `exactOptionalPropertyTypes`)
 * and the runtime type (which uses clean `T?` optionals). Optionals are
 * included only when defined so the assignment is exact-optional-safe.
 */
function resolveRuntimeWorkspaceGitConfig(config: WorkspaceGitConfig): RuntimeWorkspaceGitConfig {
  return deepFreeze({
    remoteRoles: deepFreeze({
      fetch: normalizeRemoteRole(config.remoteRoles.fetch),
      ...(config.remoteRoles.push !== undefined
        ? { push: normalizeRemoteRole(config.remoteRoles.push) }
        : {}),
    }),
    allowedTransports: [...config.allowedTransports],
    allowedHosts: [...config.allowedHosts],
    defaultBranch: config.defaultBranch,
    clone: normalizeCloneOptions(config.clone),
    reconciliation: deepFreeze({ ...config.reconciliation }),
    push: deepFreeze({
      refspecs: [...config.push.refspecs],
      atomic: config.push.atomic,
      signed: config.push.signed,
      force: config.push.force,
      protectedRefs: [...config.push.protectedRefs],
      ...(config.push.leaseCapabilityRef !== undefined
        ? { leaseCapabilityRef: config.push.leaseCapabilityRef }
        : {}),
    }),
    timeouts: deepFreeze({ ...config.timeouts }),
    retries: deepFreeze({ ...config.retries }),
    checkpoint: deepFreeze({ ...config.checkpoint }),
    credentials: deepFreeze({ ...config.credentials }),
    neverPush: deepFreeze({
      additiveRules: config.neverPush.additiveRules.map((rule) => deepFreeze({
        pattern: rule.pattern,
        classification: rule.classification,
        ...(rule.sizeCeilingBytes !== undefined ? { sizeCeilingBytes: rule.sizeCeilingBytes } : {}),
        ...(rule.lfsClassification !== undefined ? { lfsClassification: rule.lfsClassification } : {}),
        ...(rule.managedIgnore !== undefined ? { managedIgnore: rule.managedIgnore } : {}),
      })),
    }),
    capabilities: deepFreeze({ ...config.capabilities }),
    interaction: deepFreeze({ ...config.interaction }),
  });
}

function normalizeRemoteRole(role: Readonly<{ name: string; urlIdentity: string; refspecs: readonly string[]; branch?: string | undefined }>): GitRemoteRole {
  return deepFreeze({
    name: role.name,
    urlIdentity: role.urlIdentity,
    refspecs: [...role.refspecs],
    ...(role.branch !== undefined ? { branch: role.branch } : {}),
  });
}

function normalizeCloneOptions(clone: WorkspaceGitConfig["clone"]): RuntimeWorkspaceGitConfig["clone"] {
  return deepFreeze({
    rejectShallow: clone.rejectShallow,
    checkoutPolicy: clone.checkoutPolicy,
    submoduleMode: clone.submoduleMode,
    lfsMode: clone.lfsMode,
    ...(clone.depth !== undefined ? { depth: clone.depth } : {}),
    ...(clone.filter !== undefined ? { filter: clone.filter } : {}),
  });
}
