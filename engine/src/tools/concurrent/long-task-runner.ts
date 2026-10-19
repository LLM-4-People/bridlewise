/**
 * Long-task runner — runs long tasks (minutes to hours) from the agent's
 * bash tool without being killed by shell/session cleanup, without a
 * heartbeat that prevents finishing, and with full liveness/done/kill
 * observability.
 *
 * Root-cause design (EXP422):
 *
 * 1. "The nohup'd process was killed when the bash tool's shell was
 * cleaned up" — the root cause is the cgroup, not SIGHUP. `nohup`
 * ignores SIGHUP; `setsid` creates a new session. BOTH leave the
 * process in the same systemd session scope (`session-*.scope`),
 * which is destroyed (SIGKILL, uncatchable) when the agent session
 * ends. The fix: `systemd-run --user --collect --unit=<name>` puts
 * the task in a SEPARATE cgroup (`app.slice/<name>.service`) owned
 * by the user manager, which survives session cleanup.
 *
 * 2. "The heartbeat prevents it from finishing when its done" — the
 * root cause is `setInterval` keeping the Node event loop alive after
 * the task completes. The fix: the wrapper clears the heartbeat
 * interval IN the task's completion callback, so the event loop has
 * no refs and Node exits naturally. `--collect` removes the unit.
 *
 * REQUIREMENTS: Linux + systemd user manager (`systemd-run --user`). The
 * {@link LongTaskRunner.checkSystemd} method probes availability; if
 * unavailable, {@link LongTaskRunner.start} throws a typed {@link
 * LongTaskUnavailableError} (do NOT silently fall back to setsid —
 * setsid does not survive session cleanup and is the bug we are fixing).
 *
 * No hardcoded paths or thresholds: the unit-name prefix, state dir,
 * shell, binary paths, and heartbeat/timeout defaults all come from the
 * caller. The canonical owner of runtime limits is ROOT_POLICY; the
 * caller sources them and passes them in.
 */

import { execFileSync } from "node:child_process";
import { COMMAND_ENVIRONMENT, projectEnvironment, SYSTEMD_RUN_ENVIRONMENT } from "../../process/environment-projection.ts";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { HarnessError, InputError } from "../../kernel/errors.ts";
import { deepFreeze, randomBytes } from "../../kernel/integrity.ts";
import { readLastHeartbeatMs, readElapsedMs } from "../../shared/long-task-timing.ts";
import { handleError } from "../../shared/debug/debug-system.ts";
import {
  DEFAULT_LONG_TASK_HEARTBEAT_MS,
  DEFAULT_LONG_TASK_PROBE_TIMEOUT_MS,
  DEFAULT_LONG_TASK_SPAWN_TIMEOUT_MS,
  DEFAULT_LONG_TASK_KILL_TIMEOUT_MS,
  DEFAULT_LONG_TASK_LIST_TIMEOUT_MS,
} from "../../kernel/config-contracts.ts";
import { ROOT_POLICY } from "../../kernel/root-policy.ts";
import { ensurePrivateStateDirectory } from "../../filesystem/private-state.ts";

export class LongTaskUnavailableError extends HarnessError {
  constructor(message: string) {
    super(message, "long_task_unavailable");
  }
}

export class LongTaskStartError extends HarnessError {
  constructor(message: string) {
    super(message, "long_task_start_failed");
  }
}

export type LongTaskRunnerOptions = Readonly<{
  stateDir: string;
  shell?: string;
  systemdRunPath?: string;
  systemctlPath?: string;
  /** Unit-name prefix (caller-derived; no hardcoded prefix here). */
  unitPrefix?: string;
  /** Default heartbeat interval in ms (caller-derived). */
  defaultHeartbeatMs?: number;
}>;

export type StartOptions = Readonly<{
  name?: string;
  heartbeatMs?: number;
  timeoutMs?: number;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
}>;

export type StartedTask = Readonly<{
  unitName: string;
  pidFile: string;
  heartbeatFile: string;
  resultFile: string;
  logFile: string;
  stateDir: string;
}>;

export type CheckResult = Readonly<{
  alive: boolean;
  starting: boolean;
  done: boolean;
  failed: boolean;
  result?: unknown;
  pid: number | null;
  lastHeartbeatMs: number | null;
  elapsedMs: number;
  timedOut: boolean;
  stdout?: string;
  stderr?: string;
  exitCode: number | null;
}>;

export type CheckStatus =
  | "running"
  | "done-ok"
  | "done-fail"
  | "killed"
  | "timed-out"
  | "failed"
  | "unknown";

export class LongTaskRunner {
  readonly stateDir: string;
  readonly shell: string;
  readonly unitPrefix: string;
  readonly defaultHeartbeatMs: number;
  private readonly systemdRun: string;
  private readonly systemctl: string;

  constructor(opts: LongTaskRunnerOptions) {
    if (typeof opts.stateDir !== "string" || opts.stateDir.length === 0) {
      throw new InputError("LongTaskRunner requires stateDir", "long_task_state_dir_required");
    }
    this.stateDir = resolve(opts.stateDir);
    this.shell = opts.shell ?? "/bin/bash";
    this.unitPrefix = opts.unitPrefix ?? "long-task";
    this.defaultHeartbeatMs = opts.defaultHeartbeatMs ?? DEFAULT_LONG_TASK_HEARTBEAT_MS;
    this.systemdRun = opts.systemdRunPath ?? "systemd-run";
    this.systemctl = opts.systemctlPath ?? "systemctl";
  }

  static checkSystemd(systemctlPath = "systemctl"): Readonly<{ ok: boolean; reason?: string }> {
    try {
      execFileSync(systemctlPath, ["--user", "is-system-running"], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: DEFAULT_LONG_TASK_PROBE_TIMEOUT_MS,
      });
      return { ok: true };
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: Buffer | string; code?: string; message?: string };
      const stdout = String(err.stdout ?? "").trim();
      if (["running", "degraded", "starting"].includes(stdout)) return { ok: true };
      if (err.code === "ENOENT") return { ok: false, reason: `${systemctlPath} not found` };
      return { ok: false, reason: `systemctl --user unavailable: ${stdout || (err.message ?? "unknown")}` };
    }
  }

  start(command: string, opts: StartOptions = {}): StartedTask {
    if (typeof command !== "string" || command.length === 0) {
      throw new InputError("LongTaskRunner.start requires a non-empty command", "long_task_command_required");
    }
    const probe = LongTaskRunner.checkSystemd(this.systemctl);
    if (!probe.ok) {
      throw new LongTaskUnavailableError(
        `systemd --user unavailable (${probe.reason}). setsid/nohup cannot survive session cleanup (cgroup kill); systemd-run is required.`,
      );
    }
    const suffix = opts.name || randomBytes(6).toString("hex");
    const unitName = `${this.unitPrefix}-${suffix}.service`;
    const taskDir = resolve(this.stateDir, unitName);
    ensurePrivateStateDirectory(taskDir);
    const wrapperPath = resolve(dirname(new URL(import.meta.url).pathname), "long-task-wrapper.mjs");

    const heartbeatMs = String(Math.max(ROOT_POLICY.tools.limits.minimumLongTaskHeartbeatMs, opts.heartbeatMs ?? this.defaultHeartbeatMs));
    const timeoutMs = String(Math.max(0, opts.timeoutMs ?? 0));
    const cwd = resolve(opts.cwd ?? process.cwd());

    // THE ONE ENVIRONMENT RULE (`process/environment-projection.ts`): what a
    // model's command may inherit, projected there (no second allowlist, and
    // an operator's `HARNESS_*` can never be named: secd-security SECD-V-B3),
    // plus the caller's own variables.
    const mergedEnv: Record<string, string> = { ...projectEnvironment(process.env, COMMAND_ENVIRONMENT), ...(opts.env ?? {}) };

    const args = [
      "--user", "--collect",
      `--unit=${unitName}`,
      `--working-directory=${cwd}`,
      `--setenv=LTR_STATE_DIR=${taskDir}`,
      `--setenv=LTR_COMMAND=${command}`,
      `--setenv=LTR_HEARTBEAT_MS=${heartbeatMs}`,
      `--setenv=LTR_TIMEOUT_MS=${timeoutMs}`,
      `--setenv=LTR_SHELL=${this.shell}`,
    ];
    // NAMES ONLY on the command line: systemd-run takes each value from its
    // own environment (below), so no value is readable in /proc/<pid>/cmdline.
    for (const k of Object.keys(mergedEnv)) args.push(`--setenv=${k}`);
    args.push("--");
    args.push(process.execPath);
    args.push(wrapperPath);

    try {
      execFileSync(this.systemdRun, args, {
        stdio: ["ignore", "pipe", "pipe"],
        cwd,
        // systemd-run itself needs only to find programs and its user
        // manager — never this process's keys and tokens.
        env: { ...projectEnvironment(process.env, SYSTEMD_RUN_ENVIRONMENT), ...mergedEnv },
        timeout: DEFAULT_LONG_TASK_SPAWN_TIMEOUT_MS,
      });
    } catch (e: unknown) {
      const err = e as { message?: string; stderr?: Buffer | string };
      throw new LongTaskStartError(
        `systemd-run failed: ${err.message ?? "unknown"}\nstderr: ${String(err.stderr ?? "")}`,
      );
    }

    return deepFreeze({
      unitName,
      pidFile: `${taskDir}/pid`,
      heartbeatFile: `${taskDir}/heartbeat`,
      resultFile: `${taskDir}/result`,
      logFile: `${taskDir}/runner.log`,
      stateDir: taskDir,
    });
  }

  check(unitName: string, opts: StartOptions = {}): CheckResult {
    const taskDir = resolve(this.stateDir, unitName);
    const pidFile = `${taskDir}/pid`;
    const hbFile = `${taskDir}/heartbeat`;
    const resultFile = `${taskDir}/result`;

    let activeState = "unknown";
    let mainPid: number | null = null;
    try {
      const out = execFileSync(this.systemctl, ["--user", "show", unitName, "-p", "ActiveState", "-p", "MainPID"], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: DEFAULT_LONG_TASK_PROBE_TIMEOUT_MS,
      }).toString();
      for (const line of out.trim().split("\n")) {
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        const k = line.slice(0, eq);
        const v = line.slice(eq + 1);
        if (k === "ActiveState") activeState = v;
        else if (k === "MainPID") mainPid = /^\d+$/.test(v) ? parseInt(v, 10) : null;
      }
    } catch (e) {handleError(e, { module: "tools-concurrent-long-task-runner", operation: "catch" });
      activeState = "unknown";
    }
    const alive = ["active", "activating", "reloading"].includes(activeState);
    const failed = activeState === "failed";

    let result: unknown = undefined;
    let done = false;
    let exitCode: number | null = null;
    let stdout: string | undefined;
    let stderr: string | undefined;
    if (existsSync(resultFile)) {
      try {
        result = JSON.parse(readFileSync(resultFile, "utf8"));
        done = true;
        const r = result as { exitCode?: number; stdout?: string; stderr?: string };
        exitCode = r.exitCode ?? null;
        if (typeof r.stdout === "string") stdout = r.stdout;
        if (typeof r.stderr === "string") stderr = r.stderr;
      } catch (e) {handleError(e, { module: "tools-concurrent-long-task-runner", operation: "catch" });
        done = true;
      }
    }

    const lastHeartbeatMs = readLastHeartbeatMs(hbFile);
    const elapsedMs = readElapsedMs(pidFile, taskDir);

    const timeoutMs = Math.max(0, opts.timeoutMs ?? 0);
    const timedOut = timeoutMs > 0 && elapsedMs > timeoutMs && !done;
    const starting = alive && !existsSync(pidFile) && !done;

    return deepFreeze({
      alive,
      starting,
      done,
      failed,
      ...(result !== undefined ? { result } : {}),
      pid: mainPid,
      lastHeartbeatMs,
      elapsedMs,
      timedOut,
      ...(stdout !== undefined ? { stdout } : {}),
      ...(stderr !== undefined ? { stderr } : {}),
      exitCode,
    });
  }

  statusOf(unitName: string, opts: StartOptions = {}): CheckStatus {
    const s = this.check(unitName, opts);
    if (s.done) return s.exitCode === 0 ? "done-ok" : "done-fail";
    if (s.timedOut) return "timed-out";
    if (s.failed) return "failed";
    if (s.alive) return "running";
    if (existsSync(resolve(this.stateDir, unitName, "result"))) return "done-fail";
    return "unknown";
  }

  kill(unitName: string): Readonly<{ killed: boolean }> {
    try {
      execFileSync(this.systemctl, ["--user", "stop", unitName], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: DEFAULT_LONG_TASK_KILL_TIMEOUT_MS,
      });
      return { killed: true };
    } catch (e) {
      handleError(e, { module: "tools-concurrent-long-task-runner", operation: "kill" });
      return { killed: false };
    }
  }

  list(): string[] {
    try {
      const out = execFileSync(this.systemctl, ["--user", "list-units", `${this.unitPrefix}-*.service`, "--no-legend", "--plain"], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: DEFAULT_LONG_TASK_LIST_TIMEOUT_MS,
      }).toString();
      return out.trim().split("\n").filter(Boolean).map((l) => l.split(/\s+/)[0]).filter(Boolean) as string[];
    } catch (e) {
      handleError(e, { module: "tools-concurrent-long-task-runner", operation: "list" });
      return [];
    }
  }
}
