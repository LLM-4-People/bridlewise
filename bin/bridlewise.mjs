#!/usr/bin/env node
/**
 * Bridlewise CLI launcher.
 *
 * The CLI itself is TypeScript and runs directly on Node 24's type stripping.
 * This wrapper exists so `npm link`, `npx bridlewise`, and a checked-out
 * `./bin/bridlewise.mjs` all reach the same entry point without a build step.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../engine/src/cli.ts");
const result = spawnSync(
  process.execPath,
  ["--experimental-strip-types", entry, ...process.argv.slice(2)],
  { stdio: "inherit", env: process.env },
);

if (result.error) {
  process.stderr.write(`bridlewise: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
