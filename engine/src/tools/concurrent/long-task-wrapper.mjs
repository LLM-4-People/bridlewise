// EXP422 LongTaskRunner — in-unit wrapper.
//
// Runs as the ExecStart of a transient systemd user unit (created by
// `systemd-run --user --collect --unit=<name> --working-directory=...`).
// Writes a heartbeat every `heartbeatMs` so the agent can observe liveness
// between chunks, and writes the result to `resultFile` when the task
// finishes. The heartbeat interval is REFFED (keeps the process alive
// while the task runs) and is CLEARED in the task's completion callback —
// so the process exits naturally when done. This fixes the two user
// complaints:
//
// 1. "The nohup'd process was killed when the bash tool's shell was
// cleaned up" — the systemd unit lives in its own cgroup
// (app.slice/<unit>.service), NOT the session scope, so session
// cleanup (SIGKILL to session-c4.scope) does not reach it.
//
// 2. "The heartbeat prevents it from finishing when its done" — the
// heartbeat interval is cleared in the completion callback, not
// only on process exit, so the event loop has no more refs and
// Node exits naturally. `systemd-run --collect` then removes the
// unit. No manual kill needed.
//
// Signals: SIGTERM (from `systemctl --user stop`) is trapped and triggers
// a clean shutdown (kill the child, write a "killed" result, exit).

import { spawn } from "node:child_process";
import { writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

// The unit's process is a top-level program: the one process bootstrap first
// (a worker fails closed on a lost fault), and every callback the event loop
// runs is guarded (SCALE-CR1 C2/C3, SCALE-CR1-FIX H2).
import { guarded } from "../../process/fault-policy.ts";
import { bootstrapProcess } from "../../runtime/cli-debug.ts";

bootstrapProcess({ role: "worker" });

const STATE_DIR = process.env.LTR_STATE_DIR;
const COMMAND = process.env.LTR_COMMAND;
const HEARTBEAT_MS = parseInt(process.env.LTR_HEARTBEAT_MS || "10000", 10);
const TIMEOUT_MS = parseInt(process.env.LTR_TIMEOUT_MS || "0", 10); // 0 = no timeout
const SHELL = process.env.LTR_SHELL || "/bin/bash";

if (!STATE_DIR || !COMMAND) {
  process.stderr.write("wrapper: LTR_STATE_DIR and LTR_COMMAND are required\n");
  process.exit(2);
}
mkdirSync(STATE_DIR, { recursive: true });
const pidFile = `${STATE_DIR}/pid`;
const hbFile = `${STATE_DIR}/heartbeat`;
const resultFile = `${STATE_DIR}/result`;
const logFile = `${STATE_DIR}/runner.log`;

function log(msg) { try { appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`); } catch { /* log file not writable — skip */ } }
function writeHeartbeat(reason) {
  try {
    appendFileSync(hbFile, `${Date.now()} pid=${process.pid} reason=${reason}\n`);
  } catch { /* heartbeat file not writable — skip */ }
}

writeFileSync(pidFile, String(process.pid));
log(`wrapper start pid=${process.pid} heartbeatMs=${HEARTBEAT_MS} timeoutMs=${TIMEOUT_MS}`);
writeHeartbeat("start");

// REFFED heartbeat interval — keeps the event loop alive while the task
// runs. Cleared in the completion handler so the process exits naturally.
const hb = setInterval(guarded("long-task.heartbeat", () => writeHeartbeat("tick")), HEARTBEAT_MS);

// REFFED timeout. When it fires, kill the child and write a timeout result.
let timeoutTimer = null;
if (TIMEOUT_MS > 0) {
  timeoutTimer = setTimeout(guarded("long-task.timeout", () => finish({ ok: false, timedOut: true, exitCode: null, reason: "timeout" }, "timeout")), TIMEOUT_MS);
}

// Spawn the actual task. The wrapper is the unit's ExecStart; the child is
// the task. We use `spawn` (not exec) so we can forward signals.
const child = spawn(SHELL, ["-c", COMMAND], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env },
});
let stdout = "";
let stderr = "";
child.stdout.on("data", guarded("long-task.stdout", (d) => { stdout += d; }));
child.stderr.on("data", guarded("long-task.stderr", (d) => { stderr += d; }));

log(`child spawned pid=${child.pid} cmd=${COMMAND.slice(0, 80)}`);

let finished = false;
function finish(result, reason) {
  if (finished) return;
  finished = true;
  clearInterval(hb);
  if (timeoutTimer) clearTimeout(timeoutTimer);
  const payload = {
    ...result,
    pid: process.pid,
    childPid: child.pid,
    stdoutLen: stdout.length,
    stderrLen: stderr.length,
    stdout: stdout.length <= 200000 ? stdout : stdout.slice(0, 200000) + "\n[truncated]",
    stderr: stderr.length <= 200000 ? stderr : stderr.slice(0, 200000) + "\n[truncated]",
    finishedAt: Date.now(),
  };
  try {
    writeFileSync(resultFile, JSON.stringify(payload));
  } catch (e) {
    log(`ERROR writing result: ${e.message}`);
  }
  writeHeartbeat(reason);
  log(`finish reason=${reason} exitCode=${result.exitCode}`);
  // Kill the child if still alive (timeout / signal path).
  if (child.exitCode === null && !child.killed) {
    try { child.kill("SIGKILL"); } catch { /* child already dead — ESRCH */ }
  }
  process.exit(result.exitCode ?? 0);
}

child.on("exit", guarded("long-task.child-exit", (code, signal) => {
  if (finished) return;
  finish({
    ok: code === 0,
    exitCode: code,
    signal,
    reason: signal ? `signal:${signal}` : "exit",
  }, "done");
}));
child.on("error", guarded("long-task.child-error", (err) => {
  if (finished) return;
  finish({ ok: false, exitCode: null, error: String(err), reason: "spawn-error" }, "error");
}));

// Trap SIGTERM (from `systemctl --user stop`) — clean shutdown.
process.on("SIGTERM", guarded("long-task.sigterm", () => {
  log("SIGTERM received — killing child and finishing");
  if (!finished && child.exitCode === null) {
    try { child.kill("SIGTERM"); } catch { /* child already dead — ESRCH */ }
    // Give the child 2s to exit, then force.
    setTimeout(guarded("long-task.kill-grace", () => {
      if (!finished) finish({ ok: false, exitCode: null, reason: "killed", killed: true }, "killed");
    }), 2000).unref();
  }
}));
process.on("SIGINT", guarded("long-task.sigint", () => process.emit("SIGTERM")));
