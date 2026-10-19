import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");

test("the safety expectation is impossible to miss", () => {
  const readme = read("README.md");
  assert.match(readme, /developer preview/i);
  assert.match(readme, /not production-ready/i);
  assert.match(readme, /sensitive/i);
  assert.match(readme, /AGPL-3\.0/);
});

test("the shipped surfaces are documented", () => {
  for (const path of [
    "docs/cli.md",
    "docs/testing.md",
    "docs/extending.md",
    "docs/quickstart.md",
    "docs/architecture.md",
    "docs/security.md",
  ]) {
    assert.ok(read(path).length > 500, `${path} must contain real documentation`);
  }
});

test("the CLI reference names every top-level command and the harness verbs", () => {
  const cli = read("docs/cli.md");
  for (const token of ["preflight", "quality", "harness", "check", "new-module", "sync", "timeline", "metrics"]) {
    assert.ok(cli.includes(token), `docs/cli.md must mention ${token}`);
  }
});

test("the licence and community files exist", () => {
  assert.match(read("LICENSE"), /GNU AFFERO GENERAL PUBLIC LICENSE/);
  for (const path of ["SECURITY.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "SUPPORT.md"]) {
    assert.ok(read(path).length > 200, `${path} must be substantive`);
  }
});
