/**
 * THE PROJECTION — what a promotion would make of the target, computed
 * purely from the source commit S, the profile read from S, and the target
 * tip T (merge-door-final §6). No merge, so no conflict and nothing to
 * settle by hand: the target's tree is a function of the source's.
 *
 * {@link classifyTree} gives every path of a tree exactly one reason, in
 * order (§6.1): a transform's path is DERIVED; an excluded path is out (never
 * walked; an import into it is a refusal); a path the entry points reach is
 * in; an included path or prefix is in; a companion (e.g. a `README.md`) is
 * in when its folder holds a projected path; everything else is out (deny by
 * default). It runs over any {@link TreeReader}: a commit (the plan) or the
 * source's working tree (the source-side boundary guard).
 *
 * {@link planPromotion} adds the derived files (`transforms.ts`), writes the
 * projected tree P (objects only: no ref, index or checkout is touched), and
 * judges it against the target: the never-rule (the source was merged with
 * the target after a promotion), the target's direct edits since the last
 * promotion, the deletion budget, and the two short-circuits (`up_to_date`,
 * `unchanged` — never while the target holds edits of its own since its
 * last promotion: a source that now reproduces them is promoted, so the
 * promotion records it and the next plan measures the target's edits from
 * there, not from before them). Its answer is data: every refusal typed (`codes.ts`), every
 * path with its reason, every advisory.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, parse, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, deepFreeze, sha256 } from "../../kernel/integrity.ts";
import type { WorkspaceIsolationConfig } from "../../kernel/config-contracts.ts";
import { commandsRun } from "../checkout-setup.ts";
import { atomicWriteFile } from "../../filesystem/atomic-write.ts";
import { ensurePrivateStateDirectory, PRIVATE_STATE_FILE_MODE } from "../../filesystem/private-state.ts";
import { HarnessError } from "../../kernel/errors.ts";
import { GITLINK_MODE, SYMLINK_MODE, commitTreeReader, gitOutput, writeBlob, writeTree, type GitRepository, type TreeReader } from "../../git/tree-reader.ts";
import { generatedOutputPathsOf, isGenerationOnlyChange } from "../hash-binding-registry.ts";
import { directoryOf, isWalkableModule, normalizeRepositoryPath, packageNameOf, reachabilityChain, reachabilityClosure, type PathAlias, type Reachability } from "../reachability.ts";
import { PromotionError, mostSevereCode, type PromotionCode } from "./codes.ts";
import { excludedBy, pathMatchesEntry, profileCommandNames, type LoadedPromotionProfile, type PromotionProfile } from "./profile.ts";
import { deriveLockfile, deriveManifest, type LockfileRun, type ManifestExplanation } from "./transforms.ts";
import { profileHistory, type TrailerLine } from "./trailers.ts";

/** Why a path is, or is not, projected. */
export type PathReason = Readonly<{
  rule: "derived" | "entry" | "import" | "include" | "companion" | "excluded" | "unreachable" | "absent";
  /** The transform kind, the importer, the include or exclude entry, or the companion's folder. */
  detail: string;
}>;

/** One refusal: its code and the facts that name what was refused. */
export type Refusal = Readonly<{ code: PromotionCode; message: string; facts: Readonly<Record<string, unknown>> }>;

export type Classification = Readonly<{
  projected: ReadonlyMap<string, PathReason>;
  notProjected: ReadonlyMap<string, PathReason>;
  reachability: Reachability;
  /** The packages each projected manifest's modules import (manifest path → package names). */
  importedPackages: ReadonlyMap<string, ReadonlySet<string>>;
  refusals: readonly Refusal[];
}>;

function refusal(code: PromotionCode, message: string, facts: Readonly<Record<string, unknown>> = {}): Refusal {
  return deepFreeze({ code, message, facts });
}

function refusalOf(error: unknown): Refusal {
  if (error instanceof PromotionError) return refusal(error.promotionCode, error.message, error.facts);
  throw error;
}

/** The JSON at `path` of `reader`, or a refusal naming it. */
function readJson(reader: TreeReader, path: string, code: PromotionCode): Readonly<{ value: Readonly<Record<string, unknown>> } | { refusal: Refusal }> {
  try {
    return { value: JSON.parse(reader.text(path) ?? "null") as Readonly<Record<string, unknown>> };
  } catch (error) {
    return { refusal: refusal(code, `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { path }) };
  }
}

const TSCONFIG = /(?:^|\/)tsconfig[^/]*\.json$/u;
const MANIFEST = /(?:^|\/)package\.json$/u;

/** The path aliases (`compilerOptions.paths`) of the tree's tsconfigs the walk may read, each scoped to its directory. */
function pathAliases(reader: TreeReader, profile: PromotionProfile, refusals: Refusal[]): readonly PathAlias[] {
  const aliases: PathAlias[] = [];
  const tsconfigs = reader.paths().filter((path) => TSCONFIG.test(path) && excludedBy(profile, path) === null);
  reader.prefetch(tsconfigs);
  for (const path of tsconfigs) {
    const parsed = readJson(reader, path, "promotion_source_json_invalid");
    if ("refusal" in parsed) {
      refusals.push(parsed.refusal);
      continue;
    }
    const options = (parsed.value["compilerOptions"] ?? {}) as Readonly<{ paths?: Readonly<Record<string, readonly string[]>>; baseUrl?: string }>;
    const base = options.baseUrl === undefined ? directoryOf(path) : `${normalizeRepositoryPath(directoryOf(path), options.baseUrl)}/`.replace(/^\/$/u, "");
    for (const [pattern, targets] of Object.entries(options.paths ?? {})) {
      aliases.push({ directory: directoryOf(path), pattern, targets: targets.map((target) => normalizeRepositoryPath(base, target)) });
    }
  }
  return aliases;
}

/** The manifest that owns `path`: the nearest `package.json` at or above its folder among `manifests`. */
function owningManifest(path: string, manifests: readonly string[]): string | null {
  let best: string | null = null;
  for (const manifest of manifests) {
    if (path.startsWith(directoryOf(manifest)) && (best === null || manifest.length > best.length)) best = manifest;
  }
  return best;
}

/**
 * Every path of `reader` with its one reason (see the header), and the
 * refusals of the source: a missing entry point, an unresolved edge, an edge
 * into an excluded path, an undeclared package, an unreadable JSON file, a
 * gitlink in the projection.
 *
 * Every module that SHIPS is walked, not only what the entry points reach: an
 * included module (`boundary.include`) seeds the walk too, so its edges are
 * judged, its packages count, and what it imports ships with it.
 */
export function classifyTree(reader: TreeReader, profile: PromotionProfile): Classification {
  const refusals: Refusal[] = [];
  const paths = reader.paths();
  const isExcluded = (path: string): boolean => excludedBy(profile, path) !== null;
  const includedBy = (path: string): string | undefined => profile.boundary.include.find((entry) => pathMatchesEntry(path, entry));
  const transformPaths = new Set(profile.transforms.map((transform) => transform.path));
  const reachability = reachabilityClosure({
    entryPoints: profile.boundary.entryPoints,
    seeds: paths.filter((path) => isWalkableModule(path) && !transformPaths.has(path) && !isExcluded(path) && includedBy(path) !== undefined),
    files: paths,
    linkTarget: (path) => (reader.entry(path)?.mode === SYMLINK_MODE ? reader.text(path) : null),
    readTexts: (round) => {
      reader.prefetch(round);
      return new Map(round.map((path) => [path, reader.text(path)]));
    },
    isExcluded,
    spawnCalls: profile.boundary.spawnCalls,
    aliases: pathAliases(reader, profile, refusals),
  });
  for (const entry of reachability.missingEntries) refusals.push(refusal("promotion_entry_missing", `the entry point ${entry} is not in ${reader.label}${isExcluded(entry) ? " (it is excluded)" : ""}`, { entry }));
  for (const edge of reachability.unresolved) refusals.push(refusal("promotion_unresolved_import", `${edge.importer} imports ${edge.specifier}, which names nothing in ${reader.label}`, edge));
  for (const edge of reachability.intoExcluded) refusals.push(refusal("promotion_import_into_excluded", `${edge.importer} imports ${edge.specifier} (${edge.target}), which the profile excludes (by ${excludedBy(profile, edge.target) ?? "?"})`, edge));

  const manifests = paths.filter((path) => MANIFEST.test(path) && !isExcluded(path));
  reader.prefetch(manifests);
  const declared = new Map<string, ReadonlySet<string>>();
  for (const manifest of manifests) {
    const parsed = readJson(reader, manifest, "promotion_source_json_invalid");
    if ("refusal" in parsed) {
      refusals.push(parsed.refusal);
      continue;
    }
    declared.set(manifest, new Set([...Object.keys((parsed.value["dependencies"] ?? {}) as object), ...Object.keys((parsed.value["devDependencies"] ?? {}) as object)]));
  }
  const importedPackages = new Map<string, Set<string>>();
  for (const edge of reachability.bareImports) {
    const name = packageNameOf(edge.specifier);
    const owner = owningManifest(edge.importer, manifests);
    if (owner === null || declared.get(owner)?.has(name) !== true) {
      refusals.push(refusal("promotion_dependency_undeclared", `${edge.importer} imports the package ${name}, which ${owner ?? "no package.json above it"} does not declare`, { importer: edge.importer, package: name, manifest: owner }));
      continue;
    }
    importedPackages.set(owner, (importedPackages.get(owner) ?? new Set()).add(name));
  }

  const transformKinds = new Map(profile.transforms.map((transform) => [transform.path, transform.kind]));
  const entryPoints = new Set(profile.boundary.entryPoints);
  const projected = new Map<string, PathReason>();
  const notProjected = new Map<string, PathReason>();
  const pending: string[] = [];
  for (const path of paths) {
    const kind = transformKinds.get(path);
    const by = excludedBy(profile, path);
    const include = includedBy(path);
    if (kind !== undefined) projected.set(path, { rule: "derived", detail: kind });
    else if (by !== null) notProjected.set(path, { rule: "excluded", detail: by });
    else if (reachability.reachedFrom.has(path)) projected.set(path, { rule: "import", detail: reachability.reachedFrom.get(path)! });
    else if (entryPoints.has(path)) projected.set(path, { rule: "entry", detail: path });
    else if (include !== undefined) projected.set(path, { rule: "include", detail: include });
    else pending.push(path);
  }
  const projectedFolders = new Set<string>();
  for (const path of projected.keys()) {
    for (let folder = directoryOf(path); ; folder = directoryOf(folder.slice(0, -1))) {
      projectedFolders.add(folder);
      if (folder === "") break;
    }
  }
  for (const path of pending) {
    const basename = path.slice(path.lastIndexOf("/") + 1);
    if (profile.boundary.companions.includes(basename) && projectedFolders.has(directoryOf(path))) projected.set(path, { rule: "companion", detail: directoryOf(path) || "/" });
    else notProjected.set(path, { rule: "unreachable", detail: "no entry point reaches it and no include or companion rule names it" });
  }
  for (const path of projected.keys()) {
    if (reader.entry(path)?.mode === GITLINK_MODE) refusals.push(refusal("promotion_gitlink_unsupported", `${path} is a gitlink (a submodule) in the projection`, { path }));
  }
  return deepFreeze({ projected, notProjected, reachability, importedPackages, refusals: deepFreeze(refusals) });
}

/** The derived manifests of a classification: each package-manifest transform the tree holds (no command runs). */
export function deriveManifests(
  reader: TreeReader,
  profile: PromotionProfile,
  classification: Classification,
): Readonly<{ texts: ReadonlyMap<string, string>; explanations: readonly ManifestExplanation[]; refusals: readonly Refusal[] }> {
  const texts = new Map<string, string>();
  const explanations: ManifestExplanation[] = [];
  const refusals: Refusal[] = [];
  const tsconfigs = [...classification.projected.keys()].filter((path) => TSCONFIG.test(path));
  const manifests = [...classification.projected.keys()].filter((path) => MANIFEST.test(path));
  for (const transform of profile.transforms) {
    if (transform.kind !== "package-manifest" || reader.text(transform.path) === null) continue;
    const lockPath = profile.transforms.find((candidate) => candidate.kind === "lockfile" && candidate.manifest === transform.path)?.path ?? `${directoryOf(transform.path)}package-lock.json`;
    const lock = reader.text(lockPath) === null ? null : readJson(reader, lockPath, "promotion_source_json_invalid");
    if (lock !== null && "refusal" in lock) {
      refusals.push(lock.refusal);
      continue;
    }
    const types = new Set<string>();
    for (const tsconfig of tsconfigs.filter((path) => owningManifest(path, manifests) === transform.path)) {
      const parsed = readJson(reader, tsconfig, "promotion_source_json_invalid");
      if ("refusal" in parsed) continue;
      for (const type of ((parsed.value["compilerOptions"] as Readonly<{ types?: readonly string[] }> | undefined)?.types ?? [])) types.add(type);
    }
    try {
      const derived = deriveManifest(reader.text(transform.path)!, transform.scripts, {
        path: transform.path,
        isProjected: (path) => classification.projected.has(path),
        importedPackages: classification.importedPackages.get(transform.path) ?? new Set(),
        tsconfigTypes: types,
        lockPackages: lock === null ? {} : ((lock.value as { packages?: ManifestLockPackages }).packages ?? {}),
      });
      texts.set(transform.path, derived.text);
      explanations.push(derived.explanation);
    } catch (error) {
      refusals.push(refusalOf(error));
    }
  }
  return deepFreeze({ texts, explanations, refusals });
}

type ManifestLockPackages = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/**
 * Shared source-side advisories; the plan keeps them advisory (§6.4 #6).
 * Document coverage is literal `npm run `, optionally `-s `, followed by the
 * script-name grammar below, in projected Markdown. Package context comes
 * from the document's path, not an interpreted shell cwd or workspace flag.
 * This is rung-5 source analysis: free prose is neither an OS-protected
 * operation nor a typed invocation through a mandatory constructor. A runtime
 * refusal would change the advisory contract. Source guards consume this owner
 * for that bounded language; this is not a shell parser or proof of all commands.
 */
export function projectionAdvisories(
  reader: TreeReader,
  classification: Classification,
  manifestTexts: ReadonlyMap<string, string>,
  addedSinceLastPromotion: readonly string[],
): readonly Readonly<{ kind: string; path: string; detail: string }>[] {
  const found: { kind: string; path: string; detail: string }[] = [];
  for (const path of addedSinceLastPromotion) {
    if (classification.notProjected.get(path)?.rule === "unreachable") found.push({ kind: "new_unprojected_paths", path, detail: "added on the source since the last promotion and not projected (deny by default): reach it from an entry point or include it if it ships" });
  }
  const derivedScripts = new Map([...manifestTexts].map(([path, text]) => [path, new Set(Object.keys((JSON.parse(text) as { scripts?: object }).scripts ?? {}))]));
  const projected = [...classification.projected.keys()];
  const manifests = [...derivedScripts.keys()];
  const documents = projected.filter((path) => path.endsWith(".md"));
  const makefiles = projected.filter((path) => path === "Makefile" || path.endsWith("/Makefile"));
  reader.prefetch([...documents, ...makefiles]);
  for (const path of documents) {
    const owner = owningManifest(path, manifests);
    if (owner === null) continue;
    for (const match of (reader.text(path) ?? "").matchAll(/npm run (?:-s )?([a-z0-9][a-z0-9:_-]*)/gu)) {
      if (!derivedScripts.get(owner)!.has(match[1]!)) found.push({ kind: "dangling_script_reference", path, detail: `names \`npm run ${match[1]!}\`, which the derived ${owner} does not carry` });
    }
  }
  const tree = new Set(reader.paths());
  for (const path of makefiles) {
    for (const word of (reader.text(path) ?? "").split(/\s+/u)) {
      if (!word.includes("/") || word.includes("$(")) continue;
      const target = normalizeRepositoryPath(directoryOf(path), word.replace(/^[|:]+|[|:]+$/gu, ""));
      if (tree.has(target) && !classification.projected.has(target)) found.push({ kind: "dangling_recipe_path", path, detail: `names ${target}, which the projection does not carry` });
    }
  }
  for (const edge of classification.reachability.opaque) {
    if (classification.projected.has(edge.importer)) found.push({ kind: "opaque_edge", path: edge.importer, detail: `${edge.detail}: no literal names what it loads, so the projection cannot follow it — ship its targets by an entry point or an include` });
  }
  const seen = new Set<string>();
  return deepFreeze(found.filter((advisory) => {
    const key = canonicalJson(advisory);
    return seen.has(key) ? false : (seen.add(key), true);
  }));
}

let promoterDigestMemo: string | null = null;

/**
 * The digest of the promoter's own code: every module this one reaches, found
 * by the walk itself over the files on disk (in a bundle, the bundle is that
 * whole closure), each named relative to this module and digested. One input
 * of the plan id: two promoters that could plan differently never share one.
 */
function promoterDigest(): string {
  if (promoterDigestMemo !== null) return promoterDigestMemo;
  const self = fileURLToPath(import.meta.url);
  const fileRoot = parse(self).root;
  const absolute = (path: string): string => `${fileRoot}${path.split("/").join(sep)}`;
  const isFile = (path: string): boolean => existsSync(absolute(path)) && statSync(absolute(path)).isFile();
  const closure = reachabilityClosure({
    entryPoints: [self.slice(fileRoot.length).split(sep).join("/")],
    files: [],
    exists: isFile,
    readTexts: (round) => new Map(round.map((path) => [path, readFileSync(absolute(path), "utf8")])),
  }).closure;
  promoterDigestMemo = sha256(canonicalJson([...closure].sort().map((path) => [relative(dirname(self), absolute(path)).split(sep).join("/"), sha256(readFileSync(absolute(path)))])));
  return promoterDigestMemo;
}

function isAncestor(repository: GitRepository, ancestor: string, descendant: string): boolean {
  return gitOutput(repository, ["merge-base", "--is-ancestor", ancestor, descendant], { allowed: [0, 1] }).status === 0;
}

function mergeBase(repository: GitRepository, a: string, b: string): string | null {
  const answer = gitOutput(repository, ["merge-base", a, b], { allowed: [0, 1] });
  return answer.status === 0 ? answer.stdout.toString("utf8").trim() : null;
}

function changedPaths(repository: GitRepository, from: string | null, to: string, filter?: string): readonly string[] {
  const empty = gitOutput(repository, ["hash-object", "-t", "tree", "--stdin"], { input: Buffer.alloc(0) }).stdout.toString("utf8").trim();
  return gitOutput(repository, ["diff", "--name-only", "-z", "--no-renames", ...(filter === undefined ? [] : [`--diff-filter=${filter}`]), from ?? empty, to]).stdout.toString("utf8").split("\0").filter((path) => path.length > 0);
}

export type PromotionPlanInput = Readonly<{
  /** The repository (any directory inside a checkout of it) and the git that answers. */
  repository: GitRepository;
  loaded: LoadedPromotionProfile;
  /** The source commit S (a full id). */
  source: string;
  /** The target tip T (a full id), or `null` when the target does not exist yet. */
  target: string | null;
  commands: WorkspaceIsolationConfig["commands"];
  /** How the lockfiles are derived; `null`: they are not (a light plan: the lockfile paths keep the source's bytes and are marked underived). */
  lockfiles: LockfileRun | null;
  /** The promotion's private directory for this profile (the registry's promotion area). */
  workDirectory: string;
}>;

export type PlannedPath = Readonly<{ path: string; reason: string }>;

export type PromotionPlan = Readonly<{
  planId: string;
  code: PromotionCode;
  profile: Readonly<{ name: string; blob: string | null; path: string }>;
  source: string;
  target: string | null;
  lastPromoted: Readonly<{ commit: string | null; source: string | null; bootstrap: boolean }>;
  projection: Readonly<{ tree: string; paths: number; underived: readonly string[] }>;
  summary: Readonly<{ added: number; modified: number; deleted: number; derived: number; generated: number }>;
  paths: Readonly<{ added: readonly PlannedPath[]; modified: readonly PlannedPath[]; deleted: readonly PlannedPath[] }>;
  transforms: readonly ManifestExplanation[];
  targetEdits: readonly string[];
  targetEditsPatch: string | null;
  refusals: readonly Refusal[];
  advisories: readonly Readonly<{ kind: string; path: string; detail: string }>[];
  next: string;
  timings: Readonly<{ classifyMs: number; totalMs: number }>;
}>;

function describe(reason: PathReason | undefined): string {
  if (reason === undefined) return "absent on the source";
  switch (reason.rule) {
    case "derived": return `derived (${reason.detail})`;
    case "entry": return "an entry point";
    case "import": return `reached from ${reason.detail}`;
    case "include": return `included (${reason.detail})`;
    case "companion": return `companion of ${reason.detail}`;
    case "excluded": return `excluded (${reason.detail})`;
    case "unreachable": return "unreachable (deny by default)";
    case "absent": return "absent on the source";
  }
}

/**
 * THE PLAN (see the header): pure toward every ref, index and checkout; it
 * writes objects (the derived blobs, the tree P), the lockfile memo and
 * scratch, and the target-edit patch under `workDirectory`.
 */
/** The source side of a plan: S's classification and derived manifests, the target's last promotion, and the advisories. Synchronous (no command runs). */
export type SourceProjection = Readonly<{
  reader: TreeReader;
  classification: Classification;
  manifests: ReturnType<typeof deriveManifests>;
  /** This profile's promotion (and rollback) commits on the target's first-parent line (newest first). */
  promotions: readonly TrailerLine[];
  lastPromoted: Readonly<{ commit: string | null; source: string | null; bootstrap: boolean }>;
  advisories: readonly Readonly<{ kind: string; path: string; detail: string }>[];
  classifyMs: number;
}>;

/** {@link SourceProjection} of `source` against `target` (see the type). */
export function projectSource(repository: GitRepository, loaded: LoadedPromotionProfile, source: string, target: string | null): SourceProjection {
  const { profile } = loaded;
  const promotions = target === null ? [] : profileHistory(repository, target, profile.name);
  const last = promotions[0] ?? null;
  const bootstrapBase = last === null && target !== null ? mergeBase(repository, target, source) : null;
  const lastPromoted = deepFreeze({ commit: last?.commit ?? bootstrapBase, source: last?.trailers.promotedFrom ?? bootstrapBase, bootstrap: last === null });
  const reader = commitTreeReader(repository, source);
  const classified = Date.now();
  const classification = classifyTree(reader, profile);
  const classifyMs = Date.now() - classified;
  const manifests = deriveManifests(reader, profile, classification);
  const addedOnSource = lastPromoted.source === null ? reader.paths() : changedPaths(repository, lastPromoted.source, source, "A");
  return deepFreeze({ reader, classification, manifests, promotions, lastPromoted, advisories: projectionAdvisories(reader, classification, manifests.texts, addedOnSource), classifyMs });
}

export async function planPromotion(input: PromotionPlanInput): Promise<PromotionPlan> {
  const started = Date.now();
  const { profile } = input.loaded;
  const { repository } = input;
  const { reader, classification, manifests, promotions, lastPromoted, advisories: advised, classifyMs } = projectSource(repository, input.loaded, input.source, input.target);
  const last = promotions[0] ?? null;
  // Every input the plan is a function of: the commits, the profile, the
  // registry commands it runs (their argv decide the derived lockfiles) and
  // the promoter's own code.
  const commands = Object.fromEntries([...commandsRun(input.commands, profileCommandNames(profile))].sort().map((name) => [name, input.commands[name] ?? null]));
  const planId = sha256(canonicalJson({ source: input.source, target: input.target, profile: input.loaded.blob, commands, promoter: promoterDigest() }));
  const profileInfo = deepFreeze({ name: profile.name, blob: input.loaded.blob, path: input.loaded.path });
  const refusals: Refusal[] = [...classification.refusals, ...manifests.refusals];
  const derived = new Map(manifests.texts);
  const underived: string[] = [];
  for (const transform of profile.transforms) {
    if (transform.kind !== "lockfile" || reader.text(transform.path) === null) continue;
    const manifestText = derived.get(transform.manifest);
    if (input.lockfiles === null || manifestText === undefined) {
      underived.push(transform.path);
      continue;
    }
    try {
      derived.set(transform.path, await deriveLockfile(transform.path, manifestText, reader.text(transform.path)!, transform.command, input.commands[transform.command]!, input.lockfiles));
    } catch (error) {
      refusals.push(refusalOf(error));
      underived.push(transform.path);
    }
  }
  for (const line of promotions) {
    if (isAncestor(repository, line.commit, input.source)) {
      refusals.push(refusal("promotion_never_rule", `the promotion ${line.commit} is an ancestor of the source ${input.source}: the source was merged with the target`, { promotion: line.commit }));
      break;
    }
  }

  const entries = new Map<string, Readonly<{ mode: string; oid: string }>>();
  for (const path of classification.projected.keys()) {
    const entry = reader.entry(path)!;
    const text = derived.get(path);
    entries.set(path, { mode: entry.mode, oid: text === undefined ? entry.oid! : writeBlob(repository, text) });
  }
  let tree: string;
  try {
    tree = writeTree(repository, entries, ensurePrivateStateDirectory(join(input.workDirectory, "scratch")));
  } catch (error) {
    if (error instanceof HarnessError && error.code === "tree_writer_mismatch") throw new PromotionError("promotion_projection_mismatch", error.message, { planId });
    throw error;
  }

  const targetReader = input.target === null ? null : commitTreeReader(repository, input.target);
  const targetPaths = targetReader?.paths() ?? [];
  const generated = generatedOutputPathsOf(reader.paths(), (path) => reader.text(path));
  const sameAsTarget = (path: string): boolean => {
    const mine = entries.get(path);
    const theirs = targetReader?.entry(path) ?? null;
    if (mine === undefined || theirs === null) return mine === undefined && theirs === null;
    if (mine.mode === theirs.mode && mine.oid === theirs.oid) return true;
    return generated.has(path) && mine.mode === theirs.mode && isGenerationOnlyChange(path, targetReader!.text(path), derived.get(path) ?? reader.text(path));
  };
  const added: PlannedPath[] = [];
  const modified: PlannedPath[] = [];
  const deleted: PlannedPath[] = [];
  for (const [path, entry] of entries) {
    const theirs = targetReader?.entry(path) ?? null;
    const reason = describe(classification.projected.get(path));
    if (theirs === null) added.push({ path, reason });
    else if (theirs.mode !== entry.mode || theirs.oid !== entry.oid) modified.push({ path, reason: generated.has(path) ? `${reason}; regenerated at build` : reason });
  }
  for (const path of targetPaths) {
    if (!entries.has(path)) deleted.push({ path, reason: describe(classification.notProjected.get(path)) });
  }

  // THE TARGET'S DIRECT EDITS since the last promotion (§9): what changed on
  // the target that this projection does not reproduce, a generated output's
  // regeneration aside.
  // Every path the target changed itself since then (a regeneration of a generated output is no edit); the edits
  // the projection does not reproduce are refused, the ones it does are absorbed (see `unchanged` below).
  let baseReader: TreeReader | null = null;
  const directEdits = input.target === null ? [] : changedPaths(repository, lastPromoted.commit, input.target).filter((path) => {
    if (!generated.has(path)) return true;
    baseReader ??= lastPromoted.commit === null ? null : commitTreeReader(repository, lastPromoted.commit);
    return !isGenerationOnlyChange(path, baseReader?.text(path) ?? null, targetReader!.text(path));
  });
  const targetEdits = directEdits.filter((path) => !sameAsTarget(path));
  let targetEditsPatch: string | null = null;
  if (targetEdits.length > 0) {
    targetEditsPatch = join(input.workDirectory, `target-edits-${input.target!}-${input.source}.patch`);
    const written = atomicWriteFile(targetEditsPatch, gitOutput(repository, ["diff", "--binary", tree, input.target!, "--", ...targetEdits]).stdout, { requiredMode: PRIVATE_STATE_FILE_MODE });
    if (!written.success) throw written.error;
    refusals.push(refusal("promotion_target_edits", `${String(targetEdits.length)} path(s) were edited on the target since ${lastPromoted.commit ?? "its repository"} and are not reproduced by the projection: ${targetEdits.join(", ")} (patch: ${targetEditsPatch})`, { paths: targetEdits, patch: targetEditsPatch }));
  }
  if (entries.size === 0 || (targetPaths.length > 0 && deleted.length / targetPaths.length > profile.safety.maxDeletedFraction)) {
    refusals.push(refusal("promotion_deletion_budget", `the projection deletes ${String(deleted.length)} of the target's ${String(targetPaths.length)} paths (budget ${String(profile.safety.maxDeletedFraction)}), or holds nothing`, { deleted: deleted.length, target: targetPaths.length, projected: entries.size }));
  }

  // A target holding edits of its own since its last promotion (a landed
  // hotfix, now reproduced by the source) is never `unchanged`: the promotion
  // commit records that the source reproduces them, else every later source
  // change to such a path would read as a target edit again.
  const unchanged = directEdits.length === 0 && targetReader !== null && underived.length === 0 && [...new Set([...entries.keys(), ...targetPaths])].every(sameAsTarget);
  const upToDate = last !== null && last.trailers.promotedFrom === input.source;
  const code: PromotionCode = mostSevereCode(refusals.map((entry) => entry.code)) ?? (upToDate ? "promotion_up_to_date" : unchanged ? "promotion_unchanged" : "promotion_planned");
  return deepFreeze({
    planId,
    code,
    profile: profileInfo,
    source: input.source,
    target: input.target,
    lastPromoted,
    projection: { tree, paths: entries.size, underived },
    summary: {
      added: added.length,
      modified: modified.length,
      deleted: deleted.length,
      derived: derived.size,
      generated: [...entries.keys()].filter((path) => generated.has(path)).length,
    },
    paths: { added, modified, deleted },
    transforms: manifests.explanations,
    targetEdits,
    targetEditsPatch,
    refusals,
    advisories: advised,
    next: refusals.length > 0 ? "fix the refusals (each names its remedy: `harness promote explain <path>`)" : upToDate || unchanged ? "nothing to promote" : "review the plan (--diff), then apply",
    timings: { classifyMs, totalMs: Date.now() - started },
  });
}

/** The reason chain of each of `paths` in `classification` (`harness promote explain`). */
export function explainPaths(classification: Classification, paths: readonly string[]): readonly Readonly<{ path: string; projected: boolean; reason: string; chain: readonly string[] }>[] {
  return deepFreeze(paths.map((path) => {
    const projected = classification.projected.get(path);
    const reason = projected ?? classification.notProjected.get(path);
    return {
      path,
      projected: projected !== undefined,
      reason: describe(reason),
      chain: projected?.rule === "import" || projected?.rule === "entry" ? reachabilityChain(classification.reachability, path) : [],
    };
  }));
}
