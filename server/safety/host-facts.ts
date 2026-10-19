/**
 * THE HOST'S FACTS ABOUT ITSELF — where the harness is, which folders of this
 * repository are the harness's own code, and which files are this server's
 * own state — fed into the ONE keep-out list
 * (`engine/src/filesystem/self-protection/keep-out.ts`) by every consumer:
 * the spawn runner (`landlock-runner.ts`: every compiled spec), and the file
 * gate (`server/filesystem/fs-gate.ts`: the project door, the folder picker
 * and every project file the server opens). One owner, below both, so the
 * file gate does not depend on the spawn runner.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { keepOutPolicyFor, type KeepOutFacts, type KeepOutPolicy } from "../kernel/canonical.ts";
import { serverConfig } from "../kernel/config.ts";
import { serverStoreRegistry } from "../db/bootstrap-key.ts";
import { getSelfProtectionConfig } from "../kernel/harness-config.ts";

/**
 * The harness root the guardian binary and the protected `src/` live under.
 * Derived from the ONE path the server already owns for the config file, so
 * pointing the server at a different harness moves both together and there is
 * no second env var to keep in step.
 */
export function harnessRoot(): string {
  const configPath = serverConfig.harnessConfigPath;
  const lastSlash = configPath.lastIndexOf("/");
  return lastSlash <= 0 ? configPath : configPath.slice(0, lastSlash);
}

/**
 * THIS SERVER'S OWN SOURCE DIRECTORY — protected like the harness's, because
 * it is the harness.
 *
 * The floor protects `<harnessRoot>/src`, and that was named more broadly than
 * it was: `server/` in THIS repository holds `landlock-runner.ts` and
 * `tool-executor.ts` themselves, and it was in no protected subtree. It was
 * denied in practice only because it was in no allow-rule either — which is
 * deny-by-omission, and omission stops protecting the moment somebody selects
 * this repository as the project. Then it is fully writable, and the next
 * server start runs whatever was written. Self-protection that does not cover
 * half of the harness's own code is a claim wider than the measurement.
 *
 * DERIVED FROM THE RUNNING MODULE, never typed: this file lives in the
 * directory it protects, so moving the file moves the protection with it and
 * there is no second path to keep in step.
 *
 * The consequence is deliberate and worth stating plainly: this repository can
 * no longer be selected as a project for confined commands — the compiler
 * refuses a project root that contains a protected subtree. That is the same
 * answer the harness repository already gives, and it is the intended meaning
 * of "the harness's own code is protected", not a side effect.
 */
export function webServerSourceRoot(): string {
  // This file lives in a domain subfolder of server/ (safety/), so the module
  // directory is not the server root. Walk up to the directory that holds the
  // server's entry point (index.ts) — that is the server root regardless of
  // which domain subfolder this module lives in.
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "index.ts"))) {
    const parent = dirname(dir);
    if (parent === dir) return dirname(fileURLToPath(import.meta.url));
    dir = parent;
  }
  return dir;
}

/**
 * EVERY DIRECTORY IN THIS REPOSITORY THAT HOLDS THE HARNESS'S OWN CODE.
 *
 * `webServerSourceRoot()` protected `server/` and stopped, and the comment
 * above it — "self-protection that does not cover half of the harness's own
 * code is a claim wider than the measurement" — went on being true of the half
 * it did not take. `shared/` is imported by `server/` on every request;
 * `scripts/` runs against this repository; `src/` is the interface a person
 * looks at to decide whether to trust what they are being shown. A write into
 * any of them is a write into the harness.
 *
 * DERIVED FROM THE RUNNING MODULE, so moving this file moves the protection.
 * The names are the repository's own top-level layout.
 *
 * ── EVERY NAME HERE IS REQUIRED, AND A MISSING ONE IS A REFUSAL ───────────
 *
 * This list used to end in `.filter((path) => existsSync(path))`, justified as
 * "a directory that is not there cannot be protected, and naming a missing
 * path would make the guardian refuse every spec". Both halves were true and
 * the conclusion was backwards. Measured: rename `src/` and the protected set
 * drops from FOUR entries to THREE, with exit 0, no warning and no error — the
 * sandbox weakens itself, silently, at exactly the moment the layout moved
 * under it. A partial loss of the protected set is invisible; only a total
 * loss would have been noticed.
 *
 * The guardian's refusal is not an inconvenience to route around, it is the
 * enforcement: `landlock-guardian.c` exits 4 with
 * "protected_subtrees[i] does not exist" for any named path that is not there.
 * Driven on this tree: all four present → exit 0; one absent → exit 4. So the
 * names below are a DECLARATION of what this repository must contain, and a
 * layout change that invalidates the declaration stops the server loudly
 * instead of shrinking the sandbox quietly. Deny by default means the missing
 * case refuses; it does not mean the missing case is dropped.
 *
 * If a name here ever stops being a real directory, the fix is to correct the
 * declaration — never to make it optional again.
 *
 * ── WHAT IS DELIBERATELY LEFT OUT, AND THE PRECISE RESIDUAL ───────────────
 *
 * `node_modules/` is NOT here, and the reason is a genuine conflict rather
 * than an oversight. The typecheck's `tsc` lives in it and must be allow-listed
 * READ+EXECUTE for the check to run at all; the floor refuses any allow-rule
 * under a protected subtree, so protecting `node_modules` would mean the
 * typecheck cannot be confined — which is how the previous round arrived at
 * running it unconfined, and that was an escape. The exposure that remains is
 * therefore stated rather than implied: a confined command that acquires a
 * write rule reaching `node_modules` could alter a program this server later
 * runs. The rule that made that reachable is closed (a derived rule can no
 * longer be pointed out of the project), and nothing else in the allow-set
 * grants write outside the project.
 *
 * ── WHICH ROOT THESE NAMES ARE RESOLVED AGAINST, SAID OUT LOUD ────────────
 *
 * The REPOSITORY root — `dirname(webServerSourceRoot())` — so `"src"` here is
 * this repository's own `src/`, the web UI's source.
 *
 * That has to be stated because there is now a second declaration using the
 * same word. The engine's safety floor declares
 * `minimumProtectedSubtrees: ["src"]` (`engine/src/root-policy.ts`), and it is
 * resolved against the HARNESS root, which the monorepo assembly (2026-07-30)
 * moved to `engine/` INSIDE this tree. So two lists say `src` and mean
 * `<repo>/src` and `<repo>/engine/src` — two real directories, one level
 * apart. Before the assembly they were separate checkouts and the ambiguity
 * could not arise; it can now, and the answer is that neither list is
 * repository-relative by accident: each is relative to the root its own owner
 * already derives, and the two roots are pinned by different things (this one
 * by the module's own location, the floor's by the sha256-pinned guardian
 * binary and bundle that must sit under it).
 *
 * The two sets must therefore stay DISJOINT, and that is asserted rather than
 * assumed — see "the floor's bare subtree names and this repository's resolve
 * to different real directories" in
 * `tests/prevention/subprocess-confinement-owner.test.ts`. A merged set that
 * lost an entry to de-duplication would protect one `src` and quietly stop
 * protecting the other, which is the U-15 shape: a partial loss of the
 * protected set, invisible.
 */
export const WEB_HARNESS_PROTECTED_SUBTREE_NAMES: readonly string[] = ["shared", "scripts", "src"];

export function webHarnessProtectedSubtrees(
  names: readonly string[] = WEB_HARNESS_PROTECTED_SUBTREE_NAMES,
): readonly string[] {
  const serverDir = webServerSourceRoot();
  const repoRoot = dirname(serverDir);
  return [serverDir, ...names.map((name) => join(repoRoot, name))];
}

/** Who a spec is compiled for: the model's commands, or a local tool server. */
export type ConfinedSpawnPurpose = "command" | "mcp-server";

/**
 * THIS SERVER'S FACTS for the keep-out list: the harness it runs from, this
 * repository's own code (answered in the harness's vocabulary — "this folder
 * is the harness"), its own state — its databases (each one's whole family:
 * the rows, SQLite's companions, the pre-migration, pre-re-key and staging
 * copies) and the config document (it can carry MCP credentials) — and the
 * registry of the key home it admitted (the key home and every registered
 * harness store join inside the list). An MCP server serves every user's
 * chats, so it is also kept out of the declared project roots
 * (`HARNESS_WEB_ALLOWED_ROOTS`): a read grant there would hand one user's
 * files to another's model. Absolute; derived from where they ARE.
 */
export function serverKeepOutFacts(purpose: ConfinedSpawnPurpose = "command"): KeepOutFacts {
  return {
    harnessRoot: harnessRoot(),
    harnessPaths: webHarnessProtectedSubtrees(),
    hostStores: [serverConfig.dbPath, serverConfig.timelineDbPath],
    hostPaths: [
      resolve(serverConfig.harnessConfigPath),
      ...(purpose === "mcp-server" ? serverConfig.allowedProjectRoots.map((root) => resolve(root)) : []),
    ],
    registry: serverStoreRegistry(),
  };
}

/**
 * The keep-out policy in force for this server now: the list is rebuilt only
 * when something it is built from moved (`keepOutPolicyFor`); a caller that
 * asks about many places (a search walk, one request) takes ONE
 * `operation()` of it and asks per place.
 */
export function serverKeepOutPolicy(purpose: ConfinedSpawnPurpose = "command"): KeepOutPolicy {
  return keepOutPolicyFor(getSelfProtectionConfig(), serverKeepOutFacts(purpose));
}

/** The list itself, as the `safety.keepOut` signal serves it (to admins; others see counts by source). */
export function serverKeepOutList(): readonly Readonly<{ path: string; source: string }>[] {
  return serverKeepOutPolicy("command").entries.map((entry) => ({ path: entry.prefix ? `${entry.path}*` : entry.path, source: entry.source }));
}
