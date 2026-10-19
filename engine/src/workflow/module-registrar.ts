import { existsSync, readdirSync, readFileSync } from "node:fs";
import { atomicWriteFile } from "../filesystem/atomic-write.ts";
import { join, relative, resolve } from "node:path";

import { ARCHITECTURE_MANIFEST, type ArchitectureLayer, type ArchitectureManifest, type ArchitectureModule, type ArchitectureRealm } from "../architecture-manifest.ts";
import { ARCHITECTURE_SOURCE_EXTENSIONS } from "../shared/source-extensions.ts";
import { canonicalHash, canonicalJson, deepFreeze, sha256 } from "../kernel/integrity.ts";
import { InputError } from "../kernel/errors.ts";
import { parseSignedReport } from "./command-result.ts";
import { getExtension } from "../shared/path-utils.ts";
import { shouldExcludeExperiment } from "../shared/source-scan.ts";
import { analyzeArchitectureSource } from "../../scripts/verification/architecture.ts";
import { analyzeStaticModuleShape } from "../../scripts/verification/static-source.ts";
import { schemaId } from "../kernel/product-identity.ts";
import { declaredModuleContracts } from "./module-contract-blocks.ts";

export const MODULE_REGISTRAR_SCHEMA_VERSION = schemaId("module-registrar", 2);

export type ModuleRegistration = Readonly<{
  path: string;
  exportCount: number;
  namesSha256: string;
  dependencies: readonly string[];
  registered: boolean;
  /** True when the module is a direct-execution entrypoint (an
   *  `import.meta.url`/`process.argv` guard), so the auto-registered manifest
   *  block declares it a composition root instead of defaulting to a plain
   *  module the architecture verifier then flags as an unregistered command.
   *  Optional: only the block formatter consumes it, so existing constructors
   *  that predate the field default to a plain module. */
  compositionRoot?: boolean;
}>;

export type ManifestCorrection = Readonly<{
  path: string;
  reason: string;
}>;

export type ManifestUpdateOutcome = Readonly<{
  corrected: readonly string[];
  uncorrectable: readonly ManifestCorrection[];
  added: readonly string[];
  removed: readonly string[];
}>;

export type ModuleRegistrarPostWrite = Readonly<{
  addedModules: number;
  removedModules: number;
  driftedModules: number;
  unregisteredModules: number;
  clean: boolean;
}>;

export type ModuleRegistrarReport = Readonly<{
  schemaVersion: typeof MODULE_REGISTRAR_SCHEMA_VERSION;
  root: string;
  totalSourceModules: number;
  totalRegisteredModules: number;
  registeredModules: number;
  unregisteredModules: number;
  driftedModules: number;
  /** Whether the manifest's `compositionRoots` lists equal the ones its module blocks derive. */
  compositionRootsCurrent: boolean;
  drift: readonly ModuleRegistration[];
  unregistered: readonly ModuleRegistration[];
  postWrite: ModuleRegistrarPostWrite | null;
  generatedAt: string;
  integrityHash: string;
}>;

export type ModuleRegistrarOptions = Readonly<{
  write?: boolean;
}>;

export function scanSourceModules(root: string): readonly ModuleRegistration[] {
  const sourceRoots = ARCHITECTURE_MANIFEST.sourceRoots;
  const extensions = new Set<string>(ARCHITECTURE_SOURCE_EXTENSIONS);
  const modules: ModuleRegistration[] = [];
  const manifestPaths = new Set(ARCHITECTURE_MANIFEST.modules.map((entry) => entry.path));
  const scannedPaths = new Set<string>();

  for (const sourceRoot of sourceRoots) {
    const absoluteRoot = resolve(root, sourceRoot);
    if (!existsSync(absoluteRoot)) continue;
    for (const file of walkDirectory(absoluteRoot, root)) {
      const relativePath = relative(root, file).replaceAll("\\", "/");
      if (!extensions.has(getExtension(relativePath))) continue;
      const baseName = relativePath.slice(relativePath.lastIndexOf("/") + 1);
      if (baseName.startsWith(".")) continue;
      if (shouldExcludeExperiment(relativePath)) continue;
      const registered = manifestPaths.has(relativePath);
      modules.push(computeModuleRegistration(root, relativePath, registered));
      scannedPaths.add(relativePath);
    }
  }

  for (const manifestModule of ARCHITECTURE_MANIFEST.modules) {
    if (scannedPaths.has(manifestModule.path)) continue;
    // Experiment modules pruned from the walk must not be re-added from the
    // manifest fallback. Without this guard the fallback (which re-includes
    // any on-disk manifest entry) would defeat the experiment exclusion and
    // keep experiment modules registered.
    if (shouldExcludeExperiment(manifestModule.path)) continue;
    const absolutePath = resolve(root, manifestModule.path);
    if (!existsSync(absolutePath)) continue;
    modules.push(computeModuleRegistration(root, manifestModule.path, true));
    scannedPaths.add(manifestModule.path);
  }

  return deepFreeze(modules.toSorted((left, right) => left.path.localeCompare(right.path)));
}

export function compareModuleRegistrations(
  root: string,
  manifest: ArchitectureManifest = ARCHITECTURE_MANIFEST,
  computed?: readonly ModuleRegistration[],
): { drift: readonly ModuleRegistration[]; unregistered: readonly ModuleRegistration[] } {
  // Accept an optional pre-computed scan result so callers that already
  // called `scanSourceModules` can reuse it instead of re-scanning the tree
  // (RES-12: the previous implementation always re-scanned, doubling the
  // filesystem walk and source analysis cost for every report generation).
  const computedModules = computed ?? scanSourceModules(root);
  const manifestByPath = new Map(manifest.modules.map((entry) => [entry.path, entry]));
  const computedByPath = new Map(computedModules.map((entry) => [entry.path, entry]));
  const drift: ModuleRegistration[] = [];
  const unregistered: ModuleRegistration[] = [];

  for (const computedModule of computedModules) {
    const manifestModule = manifestByPath.get(computedModule.path);
    if (!manifestModule) {
      unregistered.push(computedModule);
      continue;
    }
    if (computedModule.exportCount !== manifestModule.publicApi.exportCount ||
      computedModule.namesSha256 !== manifestModule.publicApi.namesSha256 ||
      !sameSortedArray(computedModule.dependencies, [...manifestModule.dependencies].toSorted()) ||
      // A DETECTED direct-execution entrypoint is a composition root, whenever
      // it became one: the flag used to be derived at first registration only,
      // so a program that gained its entry guard later stayed unmarked and no
      // generator could fix it. One direction only: the declared roots the
      // detector cannot see (top-level programs, worker entries) are kept.
      (computedModule.compositionRoot === true && manifestModule.compositionRoot !== true)) {
      drift.push(computedModule);
    }
  }

  for (const manifestModule of manifest.modules) {
    if (!computedByPath.has(manifestModule.path)) {
      drift.push(deepFreeze({
        path: manifestModule.path,
        exportCount: manifestModule.publicApi.exportCount,
        namesSha256: manifestModule.publicApi.namesSha256,
        dependencies: [...manifestModule.dependencies].toSorted(),
        registered: true,
        compositionRoot: manifestModule.compositionRoot,
      }));
    }
  }

  return { drift: deepFreeze(drift.toSorted((left, right) => left.path.localeCompare(right.path))),
           unregistered: deepFreeze(unregistered.toSorted((left, right) => left.path.localeCompare(right.path))) };
}

export function generateModuleRegistrarReport(
  root: string,
  options: ModuleRegistrarOptions = {},
): ModuleRegistrarReport {
  // Scan the source tree ONCE and reuse the result for both drift comparison
  // and the total-source-module count (RES-12: previously `scanSourceModules`
  // was invoked twice — once inside `compareModuleRegistrations` and once here
  // — doubling the filesystem walk and per-file source analysis).
  const computed = scanSourceModules(root);
  const { drift, unregistered } = compareModuleRegistrations(root, ARCHITECTURE_MANIFEST, computed);
  const totalSourceModules = computed.length;
  const totalRegisteredModules = ARCHITECTURE_MANIFEST.modules.length;
  const registeredModules = totalSourceModules - unregistered.length;
  const unregisteredCount = unregistered.length;
  const driftedCount = drift.length;
  const rootsCurrent = compositionRootsCurrent(root);

  // Drift/unregistered counts above describe the tree BEFORE any write. When
  // write=true, the report also carries the POST-WRITE outcome so callers
  // (harness register --write, harness regenerate) derive their status from
  // what the correction actually achieved instead of the pre-fix drift.
  let postWrite: ModuleRegistrarPostWrite | null = null;
  if (options.write) {
    const outcome = updateManifestFile(root, drift, unregistered);
    // Post-write unregisteredModules = unregistered count minus successfully
    // added entries. When every unregistered source file was added, this is 0.
    const postUnregistered = Math.max(0, unregisteredCount - outcome.added.length);
    // Post-write driftedModules = drift that could not be corrected (neither
    // field-corrected nor removed). Missing-source entries that were removed
    // are NOT counted as uncorrectable drift.
    const missingSourceCount = drift.filter((d) => !existsSync(resolve(root, d.path))).length;
    // Experiment-excluded entries are intentionally removed even though their
    // source still exists; they are clean (intentional) removals, not drift.
    const experimentRemovalCount = drift.filter((d) => shouldExcludeExperiment(d.path)).length;
    const intentionalRemovalCount = missingSourceCount + experimentRemovalCount;
    const postDrifted = outcome.uncorrectable.length;
    postWrite = deepFreeze({
      addedModules: outcome.added.length,
      removedModules: outcome.removed.length,
      driftedModules: postDrifted,
      unregisteredModules: postUnregistered,
      clean: outcome.uncorrectable.length === 0 &&
        postUnregistered === 0 &&
        outcome.removed.length === intentionalRemovalCount &&
        compositionRootsCurrent(root),
    });
  }

  const unsigned = {
    schemaVersion: MODULE_REGISTRAR_SCHEMA_VERSION,
    root,
    totalSourceModules,
    totalRegisteredModules,
    registeredModules,
    unregisteredModules: unregisteredCount,
    driftedModules: driftedCount,
    compositionRootsCurrent: rootsCurrent,
    drift,
    unregistered,
    postWrite,
    generatedAt: new Date().toISOString(),
  } as const;
  return deepFreeze({ ...unsigned, integrityHash: sha256(canonicalJson(unsigned)) } as ModuleRegistrarReport);
}

export function parseModuleRegistrarReport(value: unknown): ModuleRegistrarReport {
  return parseSignedReport<ModuleRegistrarReport>(value, MODULE_REGISTRAR_SCHEMA_VERSION, "module registrar report");
}

function computeModuleRegistration(root: string, relativePath: string, registered: boolean): ModuleRegistration {
  const absolutePath = resolve(root, relativePath);
  const source = readFileSync(absolutePath, "utf8");
  const facts = analyzeArchitectureSource(relativePath, source);
  const lexical = analyzeStaticModuleShape(source, relativePath);

  const exportedNames = facts.exportedNames;
  const lexicalNames = lexical.exportedNames;
  if (!sameSortedArray(exportedNames, lexicalNames)) {
    throw new InputError(
      `export name disagreement for ${relativePath}: babel=${JSON.stringify(exportedNames)} lexical=${JSON.stringify(lexicalNames)}`,
      "input_error",
    );
  }

  const dependencies = [...new Set(facts.dependencies)].toSorted();

  return deepFreeze({
    path: relativePath,
    exportCount: exportedNames.length,
    namesSha256: canonicalHash(exportedNames),
    dependencies: deepFreeze(dependencies),
    registered,
    compositionRoot: facts.directExecutionEntrypoint,
  });
}

/**
 * THE COMPOSITION-ROOT LISTS ARE DERIVED, NOT HAND-KEPT.
 *
 * `compositionRoots.<realm>` restates, per realm, the modules whose block says
 * `compositionRoot: true` — and the architecture verifier refuses any
 * disagreement (`architecture-composition-root-drift` / `-missing`). The
 * registrar sets the flag on every block it writes, but the lists were edited
 * by hand, so deleting an entry-point script left a dangling root that no
 * generator repaired and `harness check` did not see. The lists are now
 * rewritten from the blocks on every registrar write, and the report says
 * whether the on-disk lists are current.
 */
const COMPOSITION_ROOTS_BLOCK = /\n {2}compositionRoots: \{\n([\s\S]*?)\n {2}\},\n/u;

/** `{ path, realm }` of every `moduleContract({...})` block declaring `compositionRoot: true` (the blocks' one reader). */
function declaredCompositionRootModules(content: string): readonly Readonly<{ path: string; realm: string }>[] {
  return declaredModuleContracts(content).flatMap(({ path, realm, compositionRoot }) =>
    compositionRoot && realm !== undefined ? [{ path, realm }] : []);
}

function derivedCompositionRootsBlock(content: string): string | undefined {
  const block = COMPOSITION_ROOTS_BLOCK.exec(content);
  if (block === null) return undefined;
  const realms = [...block[1]!.matchAll(/^ {4}([a-z]+): \[/gmu)].map((match) => match[1]!);
  const roots = new Map<string, string[]>(realms.map((realm) => [realm, []]));
  for (const { path, realm } of declaredCompositionRootModules(content)) {
    const list = roots.get(realm);
    if (list === undefined) return undefined;
    list.push(path);
  }
  const lines = realms.map((realm) => {
    const paths = roots.get(realm)!.toSorted();
    return paths.length === 0
      ? `    ${realm}: [],`
      : `    ${realm}: [\n${paths.map((path) => `      "${path}",`).join("\n")}\n    ],`;
  });
  return `\n  compositionRoots: {\n${lines.join("\n")}\n  },\n`;
}

/** The manifest text with its composition-root lists regenerated from the module blocks. */
function withDerivedCompositionRoots(content: string): string {
  const derived = derivedCompositionRootsBlock(content);
  return derived === undefined ? content : content.replace(COMPOSITION_ROOTS_BLOCK, derived);
}

/** Whether the on-disk manifest's composition-root lists equal the ones its module blocks derive. */
function compositionRootsCurrent(root: string): boolean {
  const manifestPath = resolve(root, "src/architecture-manifest.ts");
  if (!existsSync(manifestPath)) return true;
  const content = readFileSync(manifestPath, "utf8");
  return withDerivedCompositionRoots(content) === content;
}

function updateManifestFile(
  root: string,
  drift: readonly ModuleRegistration[],
  unregistered: readonly ModuleRegistration[],
): ManifestUpdateOutcome {
  const manifestPath = resolve(root, "src/architecture-manifest.ts");
  if (!existsSync(manifestPath)) {
    throw new InputError("architecture manifest file not found", "input_error");
  }
  let content = readFileSync(manifestPath, "utf8");
  const corrected: string[] = [];
  const uncorrectable: ManifestCorrection[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  // Phase 1: correct drifted entries (existing entries with mismatched
  // exportCount/namesSha256/dependencies) OR remove entries whose source
  // file no longer exists OR remove entries excluded from scanning as
  // experiment code (their source still exists but must not be registered).
  for (const drifted of drift) {
    if (shouldExcludeExperiment(drifted.path)) {
      const next = removeModuleContractBlock(content, drifted.path);
      if (next === null) {
        uncorrectable.push(deepFreeze({
          path: drifted.path,
          reason: "experiment-excluded module, but manifest block not found for removal",
        }));
      } else {
        content = next;
        removed.push(drifted.path);
      }
      continue;
    }
    if (!existsSync(resolve(root, drifted.path))) {
      const next = removeModuleContractBlock(content, drifted.path);
      if (next === null) {
        uncorrectable.push(deepFreeze({
          path: drifted.path,
          reason: "missing source file, but manifest block not found for removal",
        }));
      } else {
        content = next;
        removed.push(drifted.path);
      }
      continue;
    }
    const next = correctManifestEntry(content, drifted);
    if (next === null) {
      // Distinguish "entry not found" (real error) from "entry already
      // correct" (false drift from a stale in-memory ARCHITECTURE_MANIFEST
      // after an earlier in-process write corrected the on-disk manifest).
      // When the on-disk entry already matches the computed values, the
      // drift is stale — treat it as already corrected, not uncorrectable.
      if (manifestEntryMatches(content, drifted)) {
        corrected.push(drifted.path);
      } else {
        uncorrectable.push(deepFreeze({
          path: drifted.path,
          reason: "manifest entry not found or no drifted field could be corrected",
        }));
      }
      continue;
    }
    content = next;
    corrected.push(drifted.path);
  }

  // Phase 2: add new moduleContract({...}) blocks for unregistered source
  // files. The classification (realm/layer/owner) is inherited from the
  // nearest existing manifest entry by longest common directory prefix, with
  // a fallback to the most common classification in the same source root.
  for (const unreg of unregistered) {
    if (!existsSync(resolve(root, unreg.path))) continue;
    const block = formatModuleContractBlock(unreg, ARCHITECTURE_MANIFEST);
    const next = insertModuleContractBlock(content, block);
    if (next === null) {
      uncorrectable.push(deepFreeze({
        path: unreg.path,
        reason: "could not find the modules array close bracket to insert a new entry",
      }));
      continue;
    }
    content = next;
    added.push(unreg.path);
  }

  const rootsBefore = content;
  content = withDerivedCompositionRoots(content);
  const changed = corrected.length > 0 || removed.length > 0 || added.length > 0 || content !== rootsBefore;
  if (changed) {
    const writeResult = atomicWriteFile(manifestPath, content);
    if (!writeResult.success) {
      throw new InputError(
        `Failed to atomically write architecture manifest: ${writeResult.reason ?? "unknown error"}`,
        "input_error",
      );
    }
    // Verify the written bytes honestly: a corrected/added path only counts
    // when the on-disk manifest now carries exactly the computed registration
    // values.
    const written = readFileSync(manifestPath, "utf8");
    for (const drifted of drift) {
      if (!corrected.includes(drifted.path)) continue;
      if (!manifestEntryMatches(written, drifted)) {
        corrected.splice(corrected.indexOf(drifted.path), 1);
        uncorrectable.push(deepFreeze({ path: drifted.path, reason: "post-write verification failed" }));
      }
    }
    for (const unregPath of [...added]) {
      const unreg = unregistered.find((entry) => entry.path === unregPath);
      if (unreg && !manifestEntryMatches(written, unreg)) {
        added.splice(added.indexOf(unregPath), 1);
        uncorrectable.push(deepFreeze({ path: unregPath, reason: "post-write add verification failed" }));
      }
    }
    for (const removedPath of [...removed]) {
      if (findManifestValue(written, removedPath, "exportCount") !== null) {
        removed.splice(removed.indexOf(removedPath), 1);
        uncorrectable.push(deepFreeze({ path: removedPath, reason: "post-write removal verification failed" }));
      }
    }
  }

  const byPath = (left: ManifestCorrection, right: ManifestCorrection) => left.path.localeCompare(right.path);
  return deepFreeze({
    corrected: deepFreeze(corrected.toSorted()),
    uncorrectable: deepFreeze(uncorrectable.toSorted(byPath)),
    added: deepFreeze(added.toSorted()),
    removed: deepFreeze(removed.toSorted()),
  });
}

function correctManifestEntry(content: string, drifted: ModuleRegistration): string | null {
  let next = content;
  const oldExportCount = findManifestValue(next, drifted.path, "exportCount");
  if (oldExportCount !== null && oldExportCount !== String(drifted.exportCount)) {
    next = replaceManifestValue(next, drifted.path, "exportCount", oldExportCount, String(drifted.exportCount));
  }
  const oldNamesHash = findManifestValue(next, drifted.path, "namesSha256");
  if (oldNamesHash !== null && oldNamesHash !== `"${drifted.namesSha256}"`) {
    next = replaceManifestValue(next, drifted.path, "namesSha256", oldNamesHash, `"${drifted.namesSha256}"`);
  }
  const oldDependencies = findManifestDependencies(next, drifted.path);
  if (oldDependencies !== null) {
    const newDependencies = `[${drifted.dependencies.map((dep) => `"${dep}"`).join(",")}]`;
    if (oldDependencies !== newDependencies) {
      next = replaceManifestDependencies(next, drifted.path, oldDependencies, newDependencies);
    }
  }
  if (drifted.compositionRoot === true) next = withCompositionRootMark(next, drifted.path) ?? next;
  return next === content ? null : next;
}

function manifestEntryMatches(content: string, drifted: ModuleRegistration): boolean {
  const exportCount = findManifestValue(content, drifted.path, "exportCount");
  const namesHash = findManifestValue(content, drifted.path, "namesSha256");
  const dependencies = findManifestDependencies(content, drifted.path);
  const expectedDependencies = `[${drifted.dependencies.map((dep) => `"${dep}"`).join(",")}]`;
  return exportCount === String(drifted.exportCount) &&
    namesHash === `"${drifted.namesSha256}"` &&
    dependencies === expectedDependencies &&
    (drifted.compositionRoot !== true || blockDeclaresCompositionRoot(content, drifted.path));
}

/** The fields a composition root's block carries (written at registration, added by a correction). */
const COMPOSITION_ROOT_FIELDS = `executionBoundary: "composition-root", compositionRoot: true`;
/**
 * How every module block ends, whether it spans lines or is written on one
 * (`moduleContract({ … }),`): the first `}),` after its `path:`. A block
 * range must never reach into the NEXT block — a one-line block read up to
 * the next multi-line block's end would borrow that block's
 * `compositionRoot: true`, and the mark could never be written.
 */
const MODULE_BLOCK_END = "}),";

/** `modulePath`'s block, from its `path:` to (excluding) the whitespace before its closing `}),`, or `null`. */
function moduleBlockRange(content: string, modulePath: string): Readonly<{ start: number; end: number }> | null {
  const start = content.indexOf(`path: "${modulePath}"`);
  let end = start < 0 ? -1 : content.indexOf(MODULE_BLOCK_END, start);
  if (end < 0) return null;
  while (end > start && /\s/u.test(content[end - 1] ?? "")) end -= 1;
  return { start, end };
}

function blockDeclaresCompositionRoot(content: string, modulePath: string): boolean {
  const range = moduleBlockRange(content, modulePath);
  return range !== null && /compositionRoot:\s*true/u.test(content.slice(range.start, range.end));
}

/**
 * The manifest with `modulePath`'s block marked a composition root (its
 * execution boundary becomes `composition-root`), or `null` when the block is
 * missing or already marked.
 */
function withCompositionRootMark(content: string, modulePath: string): string | null {
  const range = moduleBlockRange(content, modulePath);
  if (range === null) return null;
  const block = content.slice(range.start, range.end);
  if (/compositionRoot:\s*true/u.test(block)) return null;
  const marked = /executionBoundary:\s*"[a-z-]+"/u.test(block)
    ? block.replace(/executionBoundary:\s*"[a-z-]+"/u, COMPOSITION_ROOT_FIELDS)
    : `${block}\n      ${COMPOSITION_ROOT_FIELDS},`;
  return `${content.slice(0, range.start)}${marked}${content.slice(range.end)}`;
}

function findManifestValue(content: string, modulePath: string, field: string): string | null {
  const escapedPath = modulePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `path:\\s*"${escapedPath}"[^}]*?${field}:\\s*([0-9]+|"[0-9a-f]+"|null)`,
    "us",
  );
  const match = regex.exec(content);
  return match && match.length > 1 ? match[1] ?? null : null;
}

function replaceManifestValue(
  content: string,
  modulePath: string,
  field: string,
  oldValue: string,
  newValue: string,
): string {
  const escapedPath = modulePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedOld = oldValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `(path:\\s*"${escapedPath}"[^}]*?${field}:\\s*)${escapedOld}`,
    "us",
  );
  return content.replace(regex, `$1${newValue}`);
}

function findManifestDependencies(content: string, modulePath: string): string | null {
  const escapedPath = modulePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `path:\\s*"${escapedPath}"[\\s\\S]*?dependencies:\\s*(\\[[^\\]]*?\\])`,
    "us",
  );
  const match = regex.exec(content);
  return match && match.length > 1 ? match[1] ?? null : null;
}

function replaceManifestDependencies(
  content: string,
  modulePath: string,
  oldDependencies: string,
  newDependencies: string,
): string {
  const escapedPath = modulePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedOld = oldDependencies.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `(path:\\s*"${escapedPath}"[\\s\\S]*?dependencies:\\s*)${escapedOld}`,
    "us",
  );
  return content.replace(regex, `$1${newDependencies}`);
}

function walkDirectory(dir: string, root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Prune experiment subdirectories (and their entire subtree) at the
      // walk boundary unless HARNESS_INCLUDE_EXPERIMENTS opts back in. Pruning
      // here avoids recursing into experiment trees that the manifest must
      // never register.
      const rel = relative(root, fullPath).replaceAll("\\", "/");
      if (shouldExcludeExperiment(rel)) continue;
      files.push(...walkDirectory(fullPath, root));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function sameSortedArray(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

// --- Auto-registration helpers (EXP473) ------------------------------------
// These functions classify new source files, derive unique module ids,
// format moduleContract({...}) blocks, and insert/remove them in the
// manifest text. The classification is INHERITED from the nearest existing
// manifest entry by longest common directory prefix — no hardcoded path
// patterns. The fallback computes the most common (realm, layer, owner)
// among entries in the same source root, keeping the derivation dynamic.

function directoryPrefix(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index + 1);
}

function classifyModuleFromPath(
  path: string,
  manifest: ArchitectureManifest,
): { realm: ArchitectureRealm; layer: ArchitectureLayer; owner: string } {
  const dir = directoryPrefix(path);
  // Strategy 1: inherit from the nearest existing entry by longest common
  // directory prefix. This keeps sibling files consistent with their
  // directory's established realm/layer/owner.
  let best: ArchitectureModule | null = null;
  let bestLen = -1;
  for (const entry of manifest.modules) {
    const entryDir = directoryPrefix(entry.path);
    if (dir.startsWith(entryDir) && entryDir.length > bestLen) {
      best = entry;
      bestLen = entryDir.length;
    }
  }
  if (best) {
    return { realm: best.realm, layer: best.layer, owner: best.owner };
  }
  // Strategy 2: compute the most common (realm, layer) pair and the most
  // common owner among entries in the same source root. This is fully
  // dynamic — derived from the current manifest state, not hardcoded.
  const sourceRoot = manifest.sourceRoots.find((root) => path.startsWith(root));
  const sameRoot = sourceRoot
    ? manifest.modules.filter((entry) => entry.path.startsWith(sourceRoot))
    : manifest.modules;
  const pool = sameRoot.length > 0 ? sameRoot : manifest.modules;
  if (pool.length === 0) {
    return { realm: "runtime", layer: "domain", owner: "unified-harness" };
  }
  const realmLayerCounts = new Map<string, number>();
  const ownerCounts = new Map<string, number>();
  for (const entry of pool) {
    const key = `${entry.realm}:${entry.layer}`;
    realmLayerCounts.set(key, (realmLayerCounts.get(key) ?? 0) + 1);
    ownerCounts.set(entry.owner, (ownerCounts.get(entry.owner) ?? 0) + 1);
  }
  const bestRealmLayer = [...realmLayerCounts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const bestOwner = [...ownerCounts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const [realm, layer] = bestRealmLayer.split(":") as [ArchitectureRealm, ArchitectureLayer];
  return { realm, layer, owner: bestOwner };
}

function deriveModuleId(path: string, manifest: ArchitectureManifest): string {
  // Derive a deterministic id from the path: strip the extension, replace
  // path separators and non-alphanumeric chars with hyphens. Check for
  // collisions with existing ids; if a collision is found, append a short
  // hash of the full path to guarantee uniqueness.
  const dotIndex = path.lastIndexOf(".");
  const stem = dotIndex > 0 ? path.slice(0, dotIndex) : path;
  const baseId = stem.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const existingIds = new Set(manifest.modules.map((entry) => entry.id));
  if (!existingIds.has(baseId)) return baseId;
  return `${baseId}-${sha256(path).slice(0, 8)}`;
}

function formatModuleContractBlock(
  module: ModuleRegistration,
  manifest: ArchitectureManifest,
): string {
  const classification = classifyModuleFromPath(module.path, manifest);
  const id = deriveModuleId(module.path, manifest);
  const dependencies = `[${module.dependencies.map((dep) => `"${dep}"`).join(",")}]`;
  const compositionRoot = module.compositionRoot === true ? `\n      ${COMPOSITION_ROOT_FIELDS},` : "";
  return `    moduleContract({\n` +
    `      id: "${id}", path: "${module.path}", realm: "${classification.realm}", layer: "${classification.layer}",\n` +
    `      owner: "${classification.owner}", publicApi: { exportCount: ${module.exportCount}, namesSha256: "${module.namesSha256}" },\n` +
    `      dependencies: ${dependencies},${compositionRoot}\n` +
    `    }),`;
}

function insertModuleContractBlock(content: string, block: string): string | null {
  // The modules array is the LAST field in the ARCHITECTURE_MANIFEST object.
  // Its closing bracket + the deepFreeze close form the pattern:
  // \n ],\n});\n (at end of file)
  // Insert the new block before the closing " ],\n});" so it becomes the
  // last entry in the modules array.
  const closeRegex = /\n  \],\n\}\);\n?$/s;
  if (!closeRegex.test(content)) return null;
  return content.replace(closeRegex, `\n${block}\n  ],\n});\n`);
}

function removeModuleContractBlock(content: string, modulePath: string): string | null {
  // Iterate through each moduleContract({...}), block individually. The
  // \}\),\n (close-brace + close-paren + comma + newline) uniquely identifies
  // the end of a moduleContract call — it does NOT appear inside the block
  // content (inner braces are followed by ",", not "),"). This prevents the
  // regex from matching across multiple blocks when a target block is
  // preceded by a non-target block.
  const escapedPath = modulePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pathRegex = new RegExp(`path:\\s*"${escapedPath}"`, "u");
  const blockRegex = /^    moduleContract\(\{[\s\S]*?\}\),\n/gm;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(content)) !== null) {
    if (pathRegex.test(match[0])) {
      return content.slice(0, match.index) + content.slice(match.index + match[0].length);
    }
  }
  return null;
}
