import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCANNER = join(ROOT, "scripts/check-secrets.mjs");

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "bridlewise-secret-scan-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function scan(dir) {
  return spawnSync(process.execPath, [SCANNER], { cwd: dir, encoding: "utf8" });
}

test("the scanner passes a clean tracked tree", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "README.md"), "# clean\n");
    execFileSync("git", ["add", "README.md"], { cwd: dir });
    const result = scan(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /secret scan: clean/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the scanner fails on a provider-shaped key outside a fixture path", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "config.txt"), `api_key = "sk-${"A".repeat(24)}"\n`);
    execFileSync("git", ["add", "config.txt"], { cwd: dir });
    const result = scan(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /provider-token-shape/);
    assert.doesNotMatch(result.stderr, /A{24}/, "the scanner must not print the candidate value");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the scanner fails on an internal absolute path", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "notes.md"), "see /home/private-user/secret\n");
    execFileSync("git", ["add", "notes.md"], { cwd: dir });
    const result = scan(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /forbidden-path/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
