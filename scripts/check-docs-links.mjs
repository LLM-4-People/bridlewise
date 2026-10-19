#!/usr/bin/env node
/**
 * Check relative Markdown links without a network request.
 *
 * Absolute site URLs and http(s) links are the Pages deployment's concern; this
 * gate catches the common, local failure: a repository-relative link to a file
 * that no longer exists. Run it from the repository root.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = process.cwd();
const files = execFileSync("git", ["ls-files", "*.md"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);
const missing = [];
const linkPattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

for (const file of files) {
  const text = readFileSync(resolve(root, file), "utf8");
  for (const match of text.matchAll(linkPattern)) {
    const target = match[1];
    if (["http://", "https://", "mailto:", "#", "/", "{"].some((prefix) => target.startsWith(prefix))) continue;
    const path = target.split("#")[0].split("?")[0];
    if (path.length === 0) continue;
    const absolute = resolve(dirname(resolve(root, file)), path);
    if (!existsSync(absolute)) missing.push(`${file}: ${target}`);
  }
}

if (missing.length === 0) {
  console.log(`docs links: clean (${files.length} Markdown files)`);
  process.exit(0);
}
console.error(`docs links: ${missing.length} missing target(s)`);
for (const entry of missing) console.error(`  ${entry}`);
process.exit(1);
