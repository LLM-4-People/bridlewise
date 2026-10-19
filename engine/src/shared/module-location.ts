/**
 * THE SINGLE OWNER OF "WHERE DOES AN ENGINE MODULE LIVE".
 *
 * ── THE DEFECT THIS OWNER ENDS ────────────────────────────────────────────
 *
 * The kernel/config/forensics fold moved dozens of modules from
 * `src/<name>.ts` into domain folders (`src/kernel/<name>.ts`,
 * `src/forensics/<name>ts`, …). Every consumer that read or mutated a module
 * by its pre-fold path — a prevention guard's `readFileSync("src/root-policy.ts")`,
 * an s1-scenario's `appendCandidateSource(root, "src/errors.ts", …)`, a slice
 * verifier's `join(root, "src", name)` over a basename list — then pointed at
 * a path that no longer exists, and the engine suite reded 95 files at once.
 * Each of those literals is a location answered by a call site instead of by
 * an owner that can SEE the tree — the two-paths defect applied to file paths,
 * and the same class the web estate's module resolver killed for the vitest
 * suite.
 *
 * This module is the single owner, living at the `src/shared` layer so BOTH
 * the verification scripts (`scripts/`) and the test estate (`test/`) import
 * the one implementation. A guard that needs `root-policy.ts` asks for it by
 * NAME and receives the path wherever the module currently lives; a script
 * that reads a slice's source list resolves each basename to its current
 * `src/`-relative path. A fold then touches nothing here — the resolver
 * re-walks the tree and hands back the new location, and the consumer's
 * source does not change.
 *
 * ── STRENGTH LADDER (§0 / §3) ─────────────────────────────────────────────
 *
 * Rung 1 (physically impossible) is unavailable: the filesystem will create a
 * module at any path. Rung 2 (unrepresentable) is unavailable: a consumer must
 * be able to NAME "the file that owns X"; a stale path is a fact about the
 * tree, not a type. Rung 3 (unreachable by shape) is PARTIALLY reached:
 * {@link engineModuleRef} returns a branded `EngineModuleRef`, mintable ONLY
 * here, so a consumer typed to take the brand cannot be handed a hand-spelled
 * path — forgetting is a compile error. Rung 4 (runtime choke point) is the
 * core: ONE function walks the engine source tree and every consumer gets the
 * location answer from it, so the location is decided in exactly one place.
 * Rung 5 (a source scan refusing a raw `src/…` literal) is the floor.
 *
 * ── DENY BY DEFAULT ───────────────────────────────────────────────────────
 *
 * The name→path index is DISCOVERED by walking the engine source tree, never
 * declared. A module that does not exist resolves to a REFUSAL, not a guess.
 * Two modules with the same basename resolve to a REFUSAL that names every
 * collision — the resolver never picks one. A path fragment that stops being
 * unique throws. The default answer to anything ambiguous or absent is a
 * thrown `EngineModuleResolutionError`, so a consumer can never be handed a
 * wrong path silently.
 */

import { readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { bestEffort } from "./best-effort.ts";

/**
 * The engine source root this resolver owns. Derived from this module's own
 * location (`src/shared/module-location.ts` → the engine root is two levels
 * up), never from `process.cwd()`, so a consumer run from any directory gets
 * the same answer. Only `src/` is indexed: it is the engine's product source,
 * the tree the fold reorganized and the tree every stale literal pointed into.
 */
const ENGINE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ENGINE_SOURCE_ROOT = join(ENGINE_ROOT, "src");

/** The executable source extensions the resolver indexes. */
const MODULE_EXTS: ReadonlySet<string> = new Set([".ts", ".mts", ".cts", ".mjs"]);

/**
 * An engine module's location as handed out by the resolver. The brand makes
 * the resolver the ONLY honest source: a value of this type cannot be
 * constructed by a caller writing a string, only returned by
 * {@link engineModuleRef}. Consumers typed to take an `EngineModuleRef`
 * therefore cannot be handed a hand-spelled path.
 */
declare const ENGINE_MODULE_REF_BRAND: unique symbol;
export type EngineModuleRef = { readonly [ENGINE_MODULE_REF_BRAND]: true } & string;

/** The refusal raised for an absent, ambiguous, or out-of-scope name. */
export class EngineModuleResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineModuleResolutionError";
  }
}

/**
 * The basename→paths index for the engine source tree, built once and cached.
 * A module move DURING a run is not a supported scenario (a run is a single
 * judgement of a fixed tree), so the index is built on first use and reused.
 * Deny-by-default lives here: the index maps a basename to EVERY path that
 * bears it, so an ambiguous name is visible as a multi-entry list and refused
 * at lookup.
 */
let INDEX: ReadonlyMap<string, readonly string[]> | undefined;
let ALL_PATHS: readonly string[] | undefined;

function collectModules(root: string): readonly string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    // A directory that cannot be read (permissions, a race with a delete)
    // contributes nothing; the resolver refuses an unfindable name regardless.
    const entries = bestEffort(() => readdirSync(dir));
    if (entries === undefined) return;
    for (const entry of entries) {
      if (entry === "node_modules" || entry === "dist") continue;
      const full = join(dir, entry);
      const isDir = bestEffort(() => statSync(full).isDirectory()) ?? false;
      if (isDir) visit(full);
      else if (MODULE_EXTS.has(extname(entry))) out.push(full);
    }
  };
  // An absent source root contributes no modules; every lookup under it then
  // refuses. `bestEffort` (not a comment-only catch) keeps the scan honest —
  // a walk failure is recorded, never silently swallowed.
  bestEffort(() => {
    statSync(root);
    visit(root);
  });
  return out;
}

function indexFor(): ReadonlyMap<string, readonly string[]> {
  if (INDEX !== undefined) return INDEX;
  const byName = new Map<string, string[]>();
  for (const file of collectModules(ENGINE_SOURCE_ROOT)) {
    const name = basename(file);
    const existing = byName.get(name);
    if (existing === undefined) byName.set(name, [file]);
    else existing.push(file);
  }
  INDEX = byName;
  return byName;
}

function allPaths(): readonly string[] {
  if (ALL_PATHS !== undefined) return ALL_PATHS;
  ALL_PATHS = collectModules(ENGINE_SOURCE_ROOT).map((p) => p.split("\\").join("/"));
  return ALL_PATHS;
}

/**
 * Resolve an engine module by NAME to its current absolute location.
 *
 * `name` is the module's basename (`"root-policy.ts"`) — the identity that
 * does not change when the file moves. The resolver walks the engine source
 * tree, finds the file bearing that name, and returns its absolute location
 * as a branded {@link EngineModuleRef}.
 *
 * REFUSALS (deny-by-default):
 *   - the name is found NOWHERE → throw, naming the name and the root walked;
 *   - the name is found in MORE THAN ONE place → throw, naming every
 *     collision. The resolver never guesses between two same-named modules;
 *     the caller disambiguates with a path fragment (see
 *     {@link engineModuleRefMatching}).
 */
export function engineModuleRef(name: string): EngineModuleRef {
  const clean = basename(name);
  const found = indexFor().get(clean) ?? [];
  if (found.length === 0) {
    throw new EngineModuleResolutionError(
      `engineModuleRef(): no engine module named "${clean}" exists under ${ENGINE_SOURCE_ROOT}. ` +
        `The resolver discovers the tree, so this means the module does not exist — not that it ` +
        `moved. Check the name.`,
    );
  }
  if (found.length > 1) {
    throw new EngineModuleResolutionError(
      `engineModuleRef(): "${clean}" is ambiguous — it lives at ${found
        .map((f) => `"${f}"`)
        .join(", ")}. The resolver refuses to guess between same-named modules. ` +
        `Disambiguate with a path fragment (e.g. engineModulePathMatching("kernel/${clean}")).`,
    );
  }
  return found[0] as EngineModuleRef;
}

/**
 * Resolve an engine module by a path FRAGMENT — the trailing `src/`-relative
 * segments that make it unique. A consumer that needs the kernel's `errors.ts`
 * and not mcp's asks for `"kernel/errors.ts"` and gets the one module whose
 * path ends with that fragment, wherever the folder moves. The fragment is a
 * SUFFIX the caller asserts is unique; the resolver still refuses when it is
 * not (zero matches, or two modules sharing the suffix), so it never guesses.
 *
 * This is the disambiguation door for same-basename modules AND the canonical
 * door for the fold-damaged call sites: a fragment like `"kernel/errors.ts"`
 * names the post-fold location by enough of its path to be unique, and a
 * FUTURE fold that keeps the trailing segments still resolves while one that
 * changes them fails loudly rather than silently pointing at the wrong file.
 */
export function engineModuleRefMatching(fragment: string): EngineModuleRef {
  const clean = fragment.replace(/^\/+/, "").replace(/^src\//, "");
  const sourceRoot = ENGINE_SOURCE_ROOT.split("\\").join("/");
  const found = allPaths().filter((abs) => {
    const sourceRel = abs.slice(sourceRoot.length).replace(/^\//, "");
    return sourceRel === clean || sourceRel.endsWith(`/${clean}`);
  });
  const unique = [...new Set(found)];
  if (unique.length === 0) {
    throw new EngineModuleResolutionError(
      `engineModuleRefMatching(): no engine module's path ends with "${clean}" under ` +
        `${ENGINE_SOURCE_ROOT}. The tree is discovered, so this means the fragment matches ` +
        `nothing — the module moved or the fragment is wrong.`,
    );
  }
  if (unique.length > 1) {
    throw new EngineModuleResolutionError(
      `engineModuleRefMatching(): "${clean}" is ambiguous — it matches ${unique
        .map((f) => `"${f}"`)
        .join(", ")}. Extend the fragment until it is unique.`,
    );
  }
  return unique[0] as EngineModuleRef;
}

/** The location of an engine module by unique basename, as an absolute path. */
export function engineModulePath(name: string): string {
  return engineModuleRef(name) as string;
}

/** The location of an engine module by unique path fragment, as a path. */
export function engineModulePathMatching(fragment: string): string {
  return engineModuleRefMatching(fragment) as string;
}

/**
 * The `src/`-relative path of an engine module, for consumers that read or
 * mutate a COPIED candidate tree or join against an arbitrary root.
 * `appendCandidateSource(root, "src/errors.ts", …)` and the slice verifiers'
 * `join(root, "src", name)` broke because the fold moved the modules; the
 * candidate copy mirrors the real tree, so the correct relative path is the
 * resolver's answer with the `src/` prefix re-applied (`src/kernel/errors.ts`).
 * A name or fragment goes in, the repo-relative `src/…` path comes out, so no
 * caller ever spells a path.
 */
export function engineModuleSourceRelative(fragmentOrName: string): string {
  const abs = (fragmentOrName.includes("/")
    ? engineModuleRefMatching(fragmentOrName)
    : engineModuleRef(fragmentOrName)) as string;
  const sourceRoot = ENGINE_SOURCE_ROOT.split("\\").join("/");
  const clean = abs.split("\\").join("/");
  if (!clean.startsWith(sourceRoot)) {
    throw new EngineModuleResolutionError(
      `engineModuleSourceRelative(): resolved path "${clean}" is outside the engine source root.`,
    );
  }
  return `src/${clean.slice(sourceRoot.length).replace(/^\//, "")}`;
}

/**
 * Resolve a list of module basenames to their `src/`-relative paths, in input
 * order. For the verification scripts that hold a list of module NAMES (a
 * slice's source set) and read each from a root — the fold moved those modules
 * into subfolders, so `join(root, "src", name)` broke. The list of names is
 * the semantic content (which modules the slice reads); their LOCATIONS are
 * the resolver's to know. Each name is resolved with the same deny-by-default
 * refusal (absent or ambiguous → throw).
 */
export function engineModuleSourceRelativeByNames(names: readonly string[]): readonly string[] {
  return names.map((name) => engineModuleSourceRelative(name));
}
