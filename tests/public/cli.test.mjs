import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = join(ROOT, "bin/bridlewise.mjs");

function run(args, env = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 120_000,
  });
}

test("the CLI launcher is executable and prints top-level help", () => {
  assert.ok(statSync(BIN).mode & 0o111, "bin/bridlewise.mjs must be executable");
  const result = run(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: bridlewise <command>/);
  assert.match(result.stdout, /preflight/);
  assert.match(result.stdout, /harness/);
});

test("the CLI reports a version", () => {
  const result = run(["--version"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^bridlewise \d+\.\d+\.\d+/);
});

test("harness without a subcommand is a typed refusal that lists the verbs", () => {
  const result = run(["harness"]);
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stderr.trim());
  assert.equal(payload.error, "no_harness_subcommand");
  for (const verb of ["check", "test", "new-module", "sync", "timeline", "metrics"]) {
    assert.ok(payload.available.includes(verb), `missing ${verb}`);
  }
});

test("preflight is honest about readiness", () => {
  const state = mkdtempSync(join(tmpdir(), "bridlewise-cli-"));
  try {
    const config = join(state, "bridlewise.config.json");
    copyFileSync(join(ROOT, "engine/bridlewise.config.json"), config);
    // The production check is deliberately exact: 0600, not merely owner-only.
    chmodSync(config, 0o600);
    const result = run(["preflight"], { HARNESS_CONFIG_PATH: config });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.harnessReady, false);
    assert.equal(receipt.stage, "s1-preflight-only");
    const decisions = new Map(receipt.capabilities.map((entry) => [entry.capability, entry.decision]));
    assert.equal(decisions.get("preflight"), "allow");
    assert.equal(decisions.get("modelInvocation"), "deny");
    assert.equal(decisions.get("repositoryMutation"), "deny");
    assert.equal(decisions.get("networkEgress"), "deny");
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
