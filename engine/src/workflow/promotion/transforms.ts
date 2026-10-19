/**
 * THE DERIVED FILES OF A PROMOTION — the target's copy of a file the source
 * cannot share verbatim, computed from the source by rule (merge-door-final
 * §6.2, J5/J6): never an overlay, never a hand-kept second copy.
 *
 * - `package-manifest` — the source manifest with its `scripts` narrowed to
 *   the profile's list (each value's `&&`-segments pruned when they run a
 *   dropped script or name a path the projection does not carry) and its
 *   `devDependencies` narrowed to the ones the projection uses: imported by a
 *   projected module the manifest owns, named in a projected tsconfig's
 *   `types` (`@types/<x>`), or providing the command a kept segment runs.
 *   `dependencies` cross verbatim. Pure.
 * - `lockfile` — the source lockfile re-resolved against the derived
 *   manifest by the registry command the transform names (npm's
 *   `--package-lock-only`), run in a private scratch directory of its own
 *   through the ONE command runner (an errored run is retried by the runner; a
 *   cache miss is the machine's, not the change's). Memoized by the digest of
 *   its inputs and the toolchain that ran it, so a re-plan of an unchanged
 *   manifest costs no install, and an upgraded tool re-derives.
 */
import { readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";

import { canonicalJson, deepFreeze, sha256 } from "../../kernel/integrity.ts";
import { assertNoDuplicateJsonObjectKeys } from "../../kernel/json-integrity.ts";
import { atomicWriteFile } from "../../filesystem/atomic-write.ts";
import { createOwnedTemporaryDirectory, ensurePrivateStateDirectory, removeOwnedTemporaryDirectory } from "../../filesystem/private-state.ts";
import { directoryOf, normalizeRepositoryPath } from "../reachability.ts";
import { runCheckoutCommand, type CheckoutCommand, type CheckoutCommandRunner } from "../checkout-setup.ts";
import { PromotionError } from "./codes.ts";

type Manifest = Readonly<Record<string, unknown>>;

/** Why a script, a segment or a devDependency was kept or dropped (rendered by `plan`, digested into the receipt). */
export type ManifestExplanation = Readonly<{
  path: string;
  keptScripts: readonly string[];
  droppedScripts: readonly Readonly<{ name: string; reason: string }>[];
  prunedSegments: readonly Readonly<{ script: string; segment: string; reason: string }>[];
  keptDevDependencies: readonly Readonly<{ name: string; reason: string }>[];
  droppedDevDependencies: readonly string[];
}>;

export type DerivedManifest = Readonly<{ text: string; explanation: ManifestExplanation }>;

/** What the manifest derivation reads of the projection, for the manifest at `path`. */
export type ManifestContext = Readonly<{
  /** The manifest's repository path (its directory resolves the segments' path tokens). */
  path: string;
  /** Whether the projection carries a repository path. */
  isProjected: (path: string) => boolean;
  /** The packages the projected modules this manifest owns import (bare names). */
  importedPackages: ReadonlySet<string>;
  /** The `compilerOptions.types` of the projected tsconfigs this manifest owns. */
  tsconfigTypes: ReadonlySet<string>;
  /** The source lockfile's `packages` map (`node_modules/<name>` → its entry), for the commands each package provides (its `bin`). */
  lockPackages: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}>;

/** What a kept segment (a script split on ` && `) may not hold: a sequence, a pipe, a background `&` or an unspaced `&&`, a substitution, a redirection, a second line. */
const SHELL_SYNTAX = /;|\||&|\$\(|`|>|<|\n/u;
/** A leading environment assignment (`NAME=value`) of a command line. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const PATH_TOKEN = /\/|\.(?:ts|mts|js|mjs|cjs|json)$/u;
const NPM_RUN = /^npm\s+run\s+(?:-s\s+|--silent\s+)?([^\s]+)/u;

/** The commands a package provides, from its lockfile entry's `bin` (a map, or the package's own name for a string). */
function binsOf(name: string, entry: Readonly<Record<string, unknown>> | undefined): readonly string[] {
  const bin = entry?.["bin"];
  if (typeof bin === "string") return [name.slice(name.lastIndexOf("/") + 1)];
  return typeof bin === "object" && bin !== null ? Object.keys(bin) : [];
}

/**
 * The command a segment runs: its first word after any `NAME=value`
 * assignments and an `npx` / `npm exec` launcher (with the launcher's flags),
 * e.g. `tsc` for `NODE_OPTIONS=--x npx --yes tsc -p .`.
 */
function commandWord(segment: string): string | undefined {
  const words = segment.trim().split(/\s+/u);
  let index = 0;
  while (index < words.length && ASSIGNMENT.test(words[index]!)) index += 1;
  const launcher = words[index] === "npx" ? 1 : words[index] === "npm" && words[index + 1] === "exec" ? 2 : 0;
  if (launcher > 0) {
    index += launcher;
    while (index < words.length && words[index]!.startsWith("-")) index += 1;
  }
  return words[index];
}

/**
 * The derived manifest (see the header). Refuses
 * `promotion_manifest_script_missing` (the profile keeps a script the source
 * does not declare), `promotion_manifest_script_unparseable` (a kept script
 * with shell syntax other than spaced `&&`), `promotion_manifest_script_emptied`
 * (every segment of a kept script pruned) and
 * `promotion_manifest_bin_ambiguous` (two devDependencies, neither an `npm:`
 * alias, provide one command).
 */
export function deriveManifest(sourceText: string, keepScripts: readonly string[], context: ManifestContext): DerivedManifest {
  assertNoDuplicateJsonObjectKeys(sourceText, `${context.path} repeats a key`, "promotion_transform_failed");
  const source = JSON.parse(sourceText) as Manifest;
  const directory = directoryOf(context.path);
  const scripts = (source["scripts"] ?? {}) as Readonly<Record<string, string>>;
  const devDependencies = (source["devDependencies"] ?? {}) as Readonly<Record<string, string>>;
  const missing = keepScripts.filter((name) => !(name in scripts));
  if (missing.length > 0) {
    throw new PromotionError("promotion_manifest_script_missing", `${context.path} declares no script ${missing.join(", ")}, which the profile keeps`, { manifest: context.path, scripts: missing });
  }
  const kept = Object.keys(scripts).filter((name) => keepScripts.includes(name));
  const keptSet = new Set(kept);
  const droppedScripts = Object.keys(scripts).filter((name) => !keptSet.has(name)).map((name) => ({ name, reason: "not in the profile's scripts list" }));
  const prunedSegments: { script: string; segment: string; reason: string }[] = [];
  const derivedScripts: Record<string, string> = {};
  const commandWords = new Set<string>();
  for (const name of kept) {
    const value = scripts[name]!;
    const segments = value.split(" && ");
    if (segments.some((segment) => SHELL_SYNTAX.test(segment))) {
      throw new PromotionError("promotion_manifest_script_unparseable", `${context.path} script ${name} uses shell syntax other than \` && \`: ${value}`, { manifest: context.path, script: name, value });
    }
    const keptSegments = segments.filter((segment) => {
      const run = NPM_RUN.exec(segment.trim());
      if (run !== null && !keptSet.has(run[1]!)) {
        prunedSegments.push({ script: name, segment, reason: `runs the dropped script ${run[1]!}` });
        return false;
      }
      const outside = segment.trim().split(/\s+/u).filter((word) => !word.startsWith("-") && PATH_TOKEN.test(word)).find((word) => !context.isProjected(normalizeRepositoryPath(directory, word)));
      if (outside !== undefined) {
        prunedSegments.push({ script: name, segment, reason: `names ${normalizeRepositoryPath(directory, outside)}, which the projection does not carry` });
        return false;
      }
      return true;
    });
    if (keptSegments.length === 0) {
      throw new PromotionError("promotion_manifest_script_emptied", `${context.path} script ${name} keeps no segment (${value}): its file is not projected — add it to boundary.entryPoints, or drop the script`, { manifest: context.path, script: name, value });
    }
    derivedScripts[name] = keptSegments.join(" && ");
    for (const segment of keptSegments) {
      const word = commandWord(segment);
      if (word !== undefined) commandWords.add(word);
    }
  }
  const aliases = new Set(Object.entries(devDependencies).filter(([, spec]) => spec.startsWith("npm:")).map(([name]) => name));
  const owners = new Map<string, string[]>();
  for (const name of Object.keys(devDependencies)) {
    if (aliases.has(name)) continue;
    for (const bin of binsOf(name, context.lockPackages[`node_modules/${name}`])) owners.set(bin, [...(owners.get(bin) ?? []), name]);
  }
  const keptDevDependencies: { name: string; reason: string }[] = [];
  for (const name of Object.keys(devDependencies)) {
    if (context.importedPackages.has(name)) keptDevDependencies.push({ name, reason: "imported by a projected module" });
    else if (name.startsWith("@types/") && context.tsconfigTypes.has(name.slice("@types/".length))) keptDevDependencies.push({ name, reason: `named in a projected tsconfig's types` });
    else {
      const command = [...commandWords].find((word) => owners.get(word)?.includes(name) === true);
      if (command !== undefined) {
        if (owners.get(command)!.length > 1) {
          throw new PromotionError("promotion_manifest_bin_ambiguous", `${context.path}: the command ${command} a kept script runs is provided by ${owners.get(command)!.join(" and ")}`, { manifest: context.path, command, owners: owners.get(command)! });
        }
        keptDevDependencies.push({ name, reason: `provides the command ${command} a kept script runs` });
      }
    }
  }
  const keptDev = new Set(keptDevDependencies.map((entry) => entry.name));
  const derived: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "scripts") derived[key] = derivedScripts;
    else if (key === "devDependencies") derived[key] = Object.fromEntries(Object.entries(devDependencies).filter(([name]) => keptDev.has(name)));
    else derived[key] = value;
  }
  return deepFreeze({
    text: `${JSON.stringify(derived, null, 2)}\n`,
    explanation: {
      path: context.path,
      keptScripts: kept,
      droppedScripts,
      prunedSegments,
      keptDevDependencies,
      droppedDevDependencies: Object.keys(devDependencies).filter((name) => !keptDev.has(name)),
    },
  });
}

/**
 * A memoized lockfile, marked used now (its modification time: the retention
 * sweep keeps what the latest plan used), or `null` — absent, or swept by a
 * concurrent run between the check and the read.
 */
function readMemo(memo: string): string | null {
  try {
    const now = new Date();
    utimesSync(memo, now, now);
    return readFileSync(memo, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** How the lockfile derivation runs its command: the ONE runner (its retry policy included), the toolchain it runs, and where its scratch and memo live. */
export type LockfileRun = Readonly<{
  runner: CheckoutCommandRunner;
  /** The version line of each tool a lockfile command runs (`npm` → `11.0.0`): part of the memo key, so an upgraded tool re-derives. */
  toolchain: Readonly<Record<string, string | null>>;
  /** A private directory owned by the promotion (the registry's promotion area for the profile). */
  workDirectory: string;
}>;

/**
 * The derived lockfile: `sourceLock` re-resolved against `derivedManifest`
 * by `command`, in an owned temporary directory of this call's own under
 * `<workDirectory>/scratch/` (removed when the call ends — the output tail of
 * a failure is in the refusal; a crashed call's is swept by the next; a
 * concurrent plan of the same inputs never shares it), memoized under
 * `<workDirectory>/lockfiles/<input digest>` (a memo used is marked used: the
 * build stage keeps only what its plan used). An errored run exhausted its
 * retries → `promotion_transform_errored`; a failed one →
 * `promotion_transform_failed` (the output tail names why).
 */
export async function deriveLockfile(
  path: string,
  derivedManifest: string,
  sourceLock: string,
  commandName: string,
  command: CheckoutCommand,
  run: LockfileRun,
): Promise<string> {
  const digest = sha256(canonicalJson({ command: { argv: [...command.argv], cwd: command.cwd }, toolchain: run.toolchain, derivedManifest, sourceLock }));
  const memo = join(ensurePrivateStateDirectory(join(run.workDirectory, "lockfiles")), digest);
  const memoized = readMemo(memo);
  if (memoized !== null) return memoized;
  const scratch = createOwnedTemporaryDirectory(ensurePrivateStateDirectory(join(run.workDirectory, "scratch")), "lockfile-");
  try {
    for (const [name, text] of [["package.json", derivedManifest], ["package-lock.json", sourceLock]] as const) {
      const written = atomicWriteFile(join(scratch, name), text);
      if (!written.success) throw new PromotionError("promotion_transform_errored", `could not stage ${name} for ${path}: ${written.reason ?? "unknown"}`, { path });
    }
    const outcome = await runCheckoutCommand(scratch, commandName, command, run.runner);
    if (outcome.status !== "pass") {
      const code = outcome.failure === "errored" ? "promotion_transform_errored" : "promotion_transform_failed";
      throw new PromotionError(code, `deriving ${path} (${commandName}) ${outcome.message}${outcome.details.length === 0 ? "" : `:\n${outcome.details.join("\n")}`}`, { path, command: commandName });
    }
    const derived = readFileSync(join(scratch, command.cwd, "package-lock.json"), "utf8");
    const memoWritten = atomicWriteFile(memo, derived);
    if (!memoWritten.success) throw new PromotionError("promotion_transform_errored", `could not memoize the derived ${path}: ${memoWritten.reason ?? "unknown"}`, { path });
    return derived;
  } finally {
    removeOwnedTemporaryDirectory(scratch);
  }
}
