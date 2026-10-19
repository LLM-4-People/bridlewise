#!/usr/bin/env node
// EXP422 LongTaskRunner CLI — bash-friendly interface.
//
// Usage:
// node src/cli.mjs start <command...> # start a long task
// node src/cli.mjs check <unitName> # JSON status
// node src/cli.mjs status <unitName> # one-word status
// node src/cli.mjs kill <unitName> # stop the task
// node src/cli.mjs list # list active LTR units
// node src/cli.mjs probe # check systemd availability
//
// Options for `start`:
// --name=<suffix> unit name suffix (default random)
// --heartbeat=<ms> heartbeat interval (default 10000)
// --timeout=<ms> timeout, 0 = none (default 0)
// --cwd=<path> working directory (default cwd)
// --state-dir=<path> state directory (REQUIRED: a folder of yours that outlives this
// process — `check`/`status`/`kill` read it later; never a shared /tmp default)
// --env=KEY=VAL extra env (repeatable)
//
// The `start` command prints JSON to stdout:
// {"unitName":"long-task-<suffix>.service","pidFile":...,"resultFile":...,"heartbeatFile":...}
//
// The agent saves that JSON, returns from the bash tool, then polls with
// `check` until `done` is true. No shell-detach hack needed.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const cmd = process.argv[2];
if (!cmd) { process.stderr.write("usage: cli.mjs <start|check|status|kill|list|probe> [args]\n"); process.exit(2); }

async function main() {
  const { LongTaskRunner } = await import("./tools/concurrent/long-task-runner.ts");
  const args = process.argv.slice(3);
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = a.slice(2, eq === -1 ? undefined : eq);
      const val = eq === -1 ? "true" : a.slice(eq + 1);
      if (key === "env") { (opts.env ||= {})[val.split("=")[0]] = val.slice(val.indexOf("=") + 1); }
      else opts[key] = val;
    } else positional.push(a);
  }
  const stateDir = opts["state-dir"];
  if (typeof stateDir !== "string" || stateDir.length === 0 || stateDir === "true") {
    process.stderr.write("--state-dir=<path> is required: the folder that holds the task's state between commands (never a shared /tmp default)\n");
    process.exit(2);
  }
  const runner = new LongTaskRunner({ stateDir });

  switch (cmd) {
    case "probe": {
      const r = LongTaskRunner.checkSystemd();
      process.stdout.write(JSON.stringify(r) + "\n");
      process.exit(r.ok ? 0 : 1);
    }
    case "start": {
      if (positional.length === 0) { process.stderr.write("start: a command is required\n"); process.exit(2); }
      // The command is the rest of the positional args joined (so the agent can pass a complex command).
      const command = positional.join(" ");
      const t = runner.start(command, {
        name: opts.name,
        heartbeatMs: opts.heartbeat ? parseInt(opts.heartbeat, 10) : undefined,
        timeoutMs: opts.timeout ? parseInt(opts.timeout, 10) : undefined,
        cwd: opts.cwd,
        env: opts.env,
      });
      process.stdout.write(JSON.stringify(t) + "\n");
      break;
    }
    case "check": {
      const unit = positional[0];
      if (!unit) { process.stderr.write("check: unitName required\n"); process.exit(2); }
      const s = runner.check(unit);
      process.stdout.write(JSON.stringify(s, null, 2) + "\n");
      break;
    }
    case "status": {
      const unit = positional[0];
      if (!unit) { process.stderr.write("status: unitName required\n"); process.exit(2); }
      process.stdout.write(runner.statusOf(unit) + "\n");
      break;
    }
    case "kill": {
      const unit = positional[0];
      if (!unit) { process.stderr.write("kill: unitName required\n"); process.exit(2); }
      const r = runner.kill(unit);
      process.stdout.write(JSON.stringify(r) + "\n");
      break;
    }
    case "list": {
      process.stdout.write(JSON.stringify(runner.list(), null, 2) + "\n");
      break;
    }
    default:
      process.stderr.write(`unknown command: ${cmd}\n`);
      process.exit(2);
  }
}
main().catch((e) => { process.stderr.write(`error: ${e.message}\n`); process.exit(1); });
