import { fileURLToPath } from "node:url";

import { InputError } from "../kernel/errors.ts";
import { canonicalJson, deepFreeze } from "../kernel/integrity.ts";
import { loadPinnedConfigSnapshot } from "../kernel/config.ts";
import { configuredWorktreeGitPort } from "../git/worktree-port.ts";
import { configuredGitIdentity } from "../git/repository-ownership.ts";
import type { WorkingTreeSnapshot } from "../git/working-copy.ts";
import { testProcessSupervisorBinary } from "../../guardian/build.ts";
import { holdInstrumentLock } from "../process/instrument-lock.ts";
import { readTestExecutionConfig } from "./test-result-collector.ts";
import { resolveRepositoryRegistry } from "./repository-registry.ts";
import { worktreeOperationTimeouts } from "./workflow-config.ts";
import { configuredCheckoutCommandRunner, engineRelativePath, runCheckoutCommand, type CheckoutCommandRunner } from "./checkout-setup.ts";
import {
  createWorkspaceManager,
  createWorkspaceTimelineHooks,
  WorkspaceConflictError,
  type WorkspaceCreateRequest,
  type WorkspaceManager,
  type WorkspaceManagerTimeouts,
} from "./workspace-manager.ts";
import { wrapResult, type HarnessCommandResult } from "./command-result.ts";
import type { ConflictReport, MergeReceipt, ValidationReport, WorkspaceRecord } from "./workspace-contracts.ts";

/**
 * Workspace CLI — `harness workspace <subcommand>` (root alias:
 * `npm run ws -- <subcommand>`), the composition root of isolated work.
 *
 *   create --agent <name> --write-set <path…> [--target <branch>] [--base <ref>]   a feature workspace
 *   create --agent <name> --overlay [--write-set <path…>]                          adopt THIS dirty checkout
 *   create --agent <name> --read-only [--base <ref>]                               a verifier's checkout
 *   extend <id> --write-set <path…>          widen and renew the lease (admission-checked)
 *   validate <id> [--full]                   the gates; --full adds regenerate, converged and the merge gates
 *   merge <id>                               integrate in the workspace, gate, land on the target
 *   recover <id>                             finish or roll back a merge whose integrator died
 *   abort <id> [--quarantine]                remove (or preserve) the worktree and branch
 *   snapshot <id> --label <label>            record the worktree's tree (a recovery point, never the commit of record)
 *   list | status <id> | sweep
 *
 * The CLI resolves the central `workspaceIsolation` section (a typed blocker
 * when absent), builds the pinned-git worktree port, the supervised command
 * runner (the engine's native supervisor, built on the first command it runs:
 * `list`, `status`, `sweep` and `recover` compile nothing) and the registry's
 * timeline, and
 * delegates to the workspace manager (`workspace-manager.ts`, whose header
 * states the flow). The invoking checkout is the one the command runs in; the
 * registry is the repository's (its git common dir), whichever checkout that
 * is. Conflicts are returned as structured fail results carrying the
 * ConflictReport; every other refusal is typed and reaches the harness CLI's
 * error wrapper. Progress goes to stderr, one JSON line per step.
 */

const ENGINE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SUBCOMMANDS = ["create", "extend", "validate", "merge", "recover", "abort", "snapshot", "list", "status", "sweep"] as const;

export type WorkspaceCliOutput =
  | Readonly<{ action: "create" | "extend" | "recover" | "abort" | "status"; record: WorkspaceRecord }>
  | Readonly<{ action: "validate"; report: ValidationReport }>
  | Readonly<{ action: "merge"; receipt: MergeReceipt }>
  | Readonly<{ action: "snapshot"; snapshot: WorkingTreeSnapshot }>
  | Readonly<{ action: "list"; records: readonly WorkspaceRecord[] }>
  | Readonly<{ action: "sweep"; swept: readonly string[] }>
  | Readonly<{ conflict: ConflictReport }>;

function progress(line: string): void {
  process.stderr.write(`${canonicalJson({ workspace: line })}\n`);
}

export async function runWorkspaceCli(
  root: string,
  argv: readonly string[],
): Promise<HarnessCommandResult<WorkspaceCliOutput>> {
  const action = argv[0];
  if (action === undefined || !(SUBCOMMANDS as readonly string[]).includes(action)) {
    throw new InputError(`workspace requires a subcommand (${SUBCOMMANDS.join(", ")})`, "input_error");
  }
  const snapshot = loadPinnedConfigSnapshot();
  const isolation = snapshot.document.workspaceIsolation;
  if (isolation === undefined) {
    throw new InputError("workspaceIsolation config section is required for workspace commands", "workspace_isolation_config_missing");
  }
  const timeouts: WorkspaceManagerTimeouts = worktreeOperationTimeouts(snapshot.document);
  // The merge path awaits its lock and its gates, so each git operation pins
  // the executable for the duration of that call.
  const git = configuredWorktreeGitPort(snapshot.document);
  const checkoutRoot = git.toplevel(root, timeouts.inspectMs);
  // Built on the first command run: a subcommand that runs none never compiles the supervisor.
  let runner: CheckoutCommandRunner | null = null;
  const commandRunner = (): CheckoutCommandRunner => runner ??= configuredCheckoutCommandRunner(snapshot.document, isolation, testProcessSupervisorBinary(),
    (step: string, commandArguments: readonly string[]) => progress(`run ${step}: ${commandArguments.join(" ")}`));
  // The integrator commits as the repository's user, resolved the way git
  // resolves it (the pinned git reads the repository's config alone): a
  // repository with no identity is refused before a workspace is made or a
  // merge begins, never at the merge commit (A5-design L8).
  const identity = configuredGitIdentity(checkoutRoot);
  if (identity === null && (action === "create" || action === "merge")) {
    throw new InputError(`${checkoutRoot} has no git identity (user.name and user.email): the integrator's merge commit would be refused — set them (git config user.name / user.email)`, "workspace_identity_missing");
  }
  const manager = createWorkspaceManager({
    checkoutRoot,
    engineRelative: engineRelativePath(checkoutRoot, ENGINE_ROOT),
    config: isolation,
    git,
    ...(identity === null ? {} : { identity }),
    commands: { run: (checkout, name, command) => runCheckoutCommand(checkout, name, command, commandRunner()) },
    timeouts,
    timeline: createWorkspaceTimelineHooks(resolveRepositoryRegistry(git, checkoutRoot, timeouts.inspectMs), snapshot.document.timeline),
    onProgress: progress,
  });
  return dispatch(manager, action, argv.slice(1));
}

async function dispatch(
  manager: WorkspaceManager,
  action: string,
  args: readonly string[],
): Promise<HarnessCommandResult<WorkspaceCliOutput>> {
  // Every status is EXPLICIT: a record carries an earlier failed validation
  // report, and the payload scan would call a successful abort or list "fail".
  const conflictAware = async (command: string, work: () => Promise<WorkspaceCliOutput>): Promise<HarnessCommandResult<WorkspaceCliOutput>> => {
    try {
      return wrapResult(command, await work(), { status: "pass" });
    } catch (error) {
      if (error instanceof WorkspaceConflictError) return wrapResult(command, deepFreeze({ conflict: error.report }), { status: "fail" });
      throw error;
    }
  };
  if (action === "create") {
    const request = parseCreateArgs(args);
    return conflictAware("workspace create", async () => deepFreeze({ action: "create", record: await manager.create(request) }));
  }
  if (action === "extend") {
    const [workspaceId, flags] = splitId(args, "extend");
    const writeSet = pathsAfter(flags, "--write-set", "extend");
    return conflictAware("workspace extend", async () => deepFreeze({ action: "extend", record: await manager.extend(workspaceId, writeSet) }));
  }
  if (action === "validate") {
    const [workspaceId, flags] = splitId(args, "validate");
    const unknown = flags.filter((flag) => flag !== "--full");
    if (unknown.length > 0) throw new InputError(`unknown workspace validate flag: ${unknown[0]!} (supported: --full)`, "unknown_flag");
    const report = await withInstrumentLock(`ws validate ${workspaceId}`, () => manager.validate(workspaceId, { full: flags.includes("--full") }));
    return wrapResult("workspace validate", deepFreeze({ action: "validate", report }), { status: report.status });
  }
  if (action === "merge") {
    const workspaceId = requireSingleId(args, "merge");
    return conflictAware("workspace merge", async () => deepFreeze({ action: "merge", receipt: await withInstrumentLock(`ws merge ${workspaceId}`, () => manager.merge(workspaceId)) }));
  }
  if (action === "recover") {
    const workspaceId = requireSingleId(args, "recover");
    return wrapResult("workspace recover", deepFreeze({ action: "recover", record: await manager.recover(workspaceId) }), { status: "pass" });
  }
  if (action === "abort") {
    const [workspaceId, flags] = splitId(args, "abort");
    const unknown = flags.filter((flag) => flag !== "--quarantine");
    if (unknown.length > 0) throw new InputError(`unknown workspace abort flag: ${unknown[0]!} (supported: --quarantine)`, "unknown_flag");
    const record = manager.abort(workspaceId, { quarantine: flags.includes("--quarantine"), reason: "operator abort" });
    return wrapResult("workspace abort", deepFreeze({ action: "abort", record }), { status: "pass" });
  }
  if (action === "snapshot") {
    const [workspaceId, flags] = splitId(args, "snapshot");
    if (flags.length !== 2 || flags[0] !== "--label") throw new InputError("workspace snapshot requires <id> --label <label>", "input_error");
    return wrapResult("workspace snapshot", deepFreeze({ action: "snapshot", snapshot: manager.snapshot(workspaceId, flags[1]!) }), { status: "pass" });
  }
  if (action === "status") {
    return wrapResult("workspace status", deepFreeze({ action: "status", record: manager.status(requireSingleId(args, "status")) }), { status: "pass" });
  }
  if (args.length > 0) throw new InputError(`unknown workspace ${action} flag: ${args[0]!}`, "unknown_flag");
  if (action === "list") return wrapResult("workspace list", deepFreeze({ action: "list", records: manager.list() }), { status: "pass" });
  return wrapResult("workspace sweep", deepFreeze({ action: "sweep", swept: await manager.sweep() }), { status: "pass" });
}

function requireSingleId(args: readonly string[], action: string): string {
  const [workspaceId, flags] = splitId(args, action);
  if (flags.length > 0) throw new InputError(`workspace ${action} requires exactly one workspace id`, "input_error");
  return workspaceId;
}

/** The workspace id (the first argument) and the flags after it. */
/**
 * `run` holding the host's ONE instrument lock (src/process/instrument-lock.ts):
 * a validate or a merge runs whole suites, so it waits while another heavy run
 * holds the lock (saying who), and every suite it starts runs inside its hold.
 */
async function withInstrumentLock<T>(label: string, run: () => Promise<T>): Promise<T> {
  const engineRoot = fileURLToPath(new URL("../../", import.meta.url));
  // A whole instrument (it runs whole suites), heavy by kind.
  const lock = await holdInstrumentLock({
    config: readTestExecutionConfig(engineRoot).instrumentLock, harnessRoot: engineRoot, runner: label,
    testFileCount: Number.POSITIVE_INFINITY, onWait: (line) => process.stderr.write(`${line}\n`),
  });
  try {
    return await run();
  } finally {
    lock.release();
  }
}

function splitId(args: readonly string[], action: string): readonly [string, readonly string[]] {
  const [workspaceId, ...flags] = args;
  if (workspaceId === undefined || workspaceId.startsWith("--")) {
    throw new InputError(`workspace ${action} requires a workspace id`, "input_error");
  }
  return [workspaceId, flags];
}

/** The paths after `flag` (up to the next flag); the flag must be the only one. */
function pathsAfter(flags: readonly string[], flag: string, action: string): readonly string[] {
  if (flags[0] !== flag || flags.slice(1).some((value) => value.startsWith("--")) || flags.length < 2) {
    throw new InputError(`workspace ${action} requires ${flag} <path…>`, "input_error");
  }
  return flags.slice(1);
}

function parseCreateArgs(args: readonly string[]): WorkspaceCreateRequest {
  let agentName: string | undefined;
  let base: string | undefined;
  let target: string | undefined;
  let overlay = false;
  let readOnly = false;
  const writeSet: string[] = [];
  let index = 0;
  while (index < args.length) {
    const arg = args[index]!;
    const value = args[index + 1];
    if ((arg === "--agent" || arg === "--base" || arg === "--target") && value !== undefined && !value.startsWith("--")) {
      if (arg === "--agent") agentName = value;
      else if (arg === "--base") base = value;
      else target = value;
      index += 2;
      continue;
    }
    if (arg === "--overlay" || arg === "--read-only") {
      if (arg === "--overlay") overlay = true;
      else readOnly = true;
      index += 1;
      continue;
    }
    if (arg === "--write-set") {
      index += 1;
      while (index < args.length && !args[index]!.startsWith("--")) {
        writeSet.push(args[index]!);
        index += 1;
      }
      continue;
    }
    throw new InputError(
      `unknown workspace create flag: ${arg} (supported: --agent, --write-set, --overlay, --read-only, --base, --target)`,
      "unknown_flag",
    );
  }
  if (agentName === undefined) throw new InputError("workspace create requires --agent <name>", "input_error");
  if (overlay && readOnly) throw new InputError("workspace create takes --overlay or --read-only, not both", "input_error");
  if (!overlay && !readOnly && writeSet.length === 0) {
    throw new InputError("workspace create requires --write-set <path…> (or --overlay, or --read-only)", "input_error");
  }
  const mode: WorkspaceCreateRequest["mode"] = overlay ? "overlay" : readOnly ? "read-only" : "feature";
  return deepFreeze({
    agentName,
    mode,
    writeSet: deepFreeze(writeSet),
    ...(base !== undefined ? { base } : {}),
    ...(target !== undefined ? { target } : {}),
  });
}
