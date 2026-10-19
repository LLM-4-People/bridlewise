#!/usr/bin/env -S node --experimental-strip-types
/**
 * Point a repository's git at its own tracked hooks.
 *
 * `core.hooksPath` is per-clone local config and cannot be tracked — a
 * repository able to ship executable hooks to everyone who clones it would run
 * arbitrary code on `git clone`, so git deliberately does not allow it. The
 * hook is therefore tracked and the pointer to it is not, and this script is
 * the one command that closes the gap.
 *
 * Running it twice is the same as running it once. Say which repositories to
 * bootstrap, or say nothing and get every repository reachable from the tree
 * this script lives in — itself and the trees it is a submodule of or declares
 * as submodules.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { GUARDED_HOOKS, HOOKS_DIRECTORY, SHIPPED_HOOKS } from "./verification/staged-move-loss.ts";
import { PROMOTION_TRIGGER_HOOK } from "../src/workflow/promotion/trigger-hook.ts";
import { submoduleRoots } from "./verification/gitignore-anchoring.ts";

const INTEGRATION_ROOT = resolve(import.meta.dirname, "..");
const HARNESS_ROOT = dirname(INTEGRATION_ROOT);

/**
 * The repositories this script bootstraps when told nothing.
 *
 * Discovery rather than a list: the parent tree, plus whatever `.gitmodules`
 * declares inside it, which is git's own statement of the relationship and
 * extends by itself when a submodule is added. A sibling repository is NOT
 * discoverable this way — nothing in git records it — so a sibling bootstraps
 * itself by naming its own root, and its own suite refuses until it has.
 */
function defaultRoots(): readonly string[] {
  return [...new Set([HARNESS_ROOT, ...submoduleRoots(HARNESS_ROOT)])];
}

function bootstrap(root: string): void {
  const missing = SHIPPED_HOOKS.filter((hook) => !existsSync(resolve(root, HOOKS_DIRECTORY, hook)));
  if (missing.length > 0) {
    throw new Error(
      `${root} has no ${missing.map((hook) => `${HOOKS_DIRECTORY}/${hook}`).join(", ")}. The hooks are tracked in each repository ` +
        `that wants them; pointing git at a directory that does not hold them would report success ` +
        `and install nothing.`,
    );
  }
  execFileSync("git", ["config", "core.hooksPath", HOOKS_DIRECTORY], { cwd: root, stdio: "pipe" });
  const observed = execFileSync("git", ["config", "--get", "core.hooksPath"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (observed !== HOOKS_DIRECTORY) {
    throw new Error(
      `${root}: core.hooksPath reads back as ${JSON.stringify(observed)} after being set. ` +
        `Something else in this repository's config chain is overriding it.`,
    );
  }
  process.stdout.write(`${root}: git will run ${GUARDED_HOOKS.map((hook) => `${HOOKS_DIRECTORY}/${hook}`).join(" and ")} before every commit it makes through a hook, and ${HOOKS_DIRECTORY}/${PROMOTION_TRIGGER_HOOK} after every ref update (the promotion trigger)\n`);
}

const requested = process.argv.slice(2);
const roots = requested.length > 0 ? requested.map((path) => resolve(path)) : defaultRoots();
for (const root of roots) bootstrap(root);
