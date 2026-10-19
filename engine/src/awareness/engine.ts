/**
 * Dynamic awareness engine — the orchestrator.
 *
 * Walks the codebase, dispatches each file to its language adapter,
 * caches per-file analyses by (mtime, size), and feeds the analyses to
 * every signal module. The engine is the only module that touches the
 * filesystem; signal modules are pure.
 *
 * Per the user directive ("dynamically updated in real time"), the
 * engine's `compute` method is called BEFORE each LLM turn. It
 * re-walks the tree, checks each file's mtime, and re-analyzes only
 * the files that changed. This makes the awareness block reflect the
 * CURRENT state of the codebase — if the LLM edited a file in turn 5,
 * turn 6's awareness block reflects the edit.
 *
 * The engine has no static state other than the cache. All
 * thresholds, toggles, and limits come from `AwarenessConfig`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { InputError, extractErrorMessage } from "../kernel/errors.ts";
import { sha256 as integritySha256 } from "../kernel/integrity.ts";
import { join, relative, sep, extname } from "node:path";
// NO `node:child_process` HERE, AND THAT IS THE POINT. This module used to run
// git through a shell; see `GitCommandRunner` in `./types.ts` for the escape
// that made it a capability the engine must not hold. Every host now supplies
// the runner, so a host that cannot confine git cannot silently get one.

import { bestEffort } from "../shared/best-effort.ts";

import type { AwarenessConfig } from "./config.ts";
import { EXPENSIVE_SIGNAL_IDS } from "./config.ts";
import type {
  AwarenessSnapshot,
  FileAnalysis,
  GitCommandRunner,
  ModuleRecord,
  GitCommit,
  SignalContext,
} from "./types.ts";
import { SNAPSHOT_SCHEMA_VERSION } from "./types.ts";
import { ADAPTERS, GENERIC_ADAPTER, adapterForExtension, languageConfigMap } from "./languages/index.ts";
import type { LanguageAdapter } from "./languages/index.ts";
import { GENERIC_TEXT_EXTENSIONS } from "./languages/generic.ts";

import { computeTypeLevel } from "./signals/type-level.ts";
import { computeComplexity } from "./signals/complexity.ts";
import { computeArchitecture } from "./signals/architecture.ts";
import { computeClones } from "./signals/clones.ts";
import { computeEntropy } from "./signals/entropy.ts";
import { computeDependencies } from "./signals/dependencies.ts";
import { computeHealth } from "./signals/health.ts";
import { computeQuality } from "./signals/quality.ts";
import { computeDrift } from "./signals/drift.ts";
import { computeDebt } from "./signals/debt.ts";
import { computeModuleRoles } from "./signals/module-roles.ts";
import { computeHotspots } from "./signals/hotspots.ts";
import { computeTrending } from "./signals/trending.ts";
import { computeRisk } from "./signals/risk.ts";
// EXP372 new signal imports (16).
import { computeBellClones } from "./signals/bell-clones.ts";
import { computeBanachContraction } from "./signals/banach-contraction.ts";
import { computeQecDistance } from "./signals/qec-distance.ts";
import { computeAgSpectrum } from "./signals/ag-spectrum.ts";
import { computeWaveletClones } from "./signals/wavelet-clones.ts";
import { computeRicciCurvature } from "./signals/ricci-curvature.ts";
import { computeFiberBundle } from "./signals/fiber-bundle.ts";
import { computeTopos } from "./signals/topos.ts";
import { computeFunctionStats } from "./signals/function-stats.ts";
import { computePersistenceLandscapes } from "./signals/persistence-landscapes.ts";
import { computeTestCoverage } from "./signals/test-coverage.ts";
import { computeErgodicDrift } from "./signals/ergodic-drift.ts";
import { computeQuantumStability } from "./signals/quantum-stability.ts";
import { computeEditPredictability } from "./signals/edit-predictability.ts";
import { computeRecursionHierarchy } from "./signals/recursion-hierarchy.ts";
import { computeHubStress } from "./signals/hub-stress.ts";
// EXP387 new signal imports (14) — sourced from EXPERIMENTS-SURVEY.md findings.
import { computeThermodynamics } from "./signals/thermodynamics.ts";
import { computeBenford } from "./signals/benford.ts";
import { computeFiedlerBisection } from "./signals/fiedler-bisection.ts";
import { computeHomology } from "./signals/homology.ts";
import { computeShapeDna } from "./signals/shape-dna.ts";
import { computeChromaticNumber } from "./signals/chromatic-number.ts";
import { computeMartingaleDebt } from "./signals/martingale-debt.ts";
import { computeFreeProbability } from "./signals/free-probability.ts";
import { computeMaxwellDemon } from "./signals/maxwell-demon.ts";
import { computeFunctionClassification } from "./signals/function-classification.ts";
import { computeLinguisticTypology } from "./signals/linguistic-typology.ts";
import { computeTuringTreadmills } from "./signals/turing-treadmills.ts";
import { computeMechanismDesign } from "./signals/mechanism-design.ts";
import { computeSheafCohomology } from "./signals/sheaf-cohomology.ts";
// The extended signal set, grouped into thematic files.
import {
  computeAl2Fitness, computeLeChatelier, computeObafgkm, computePeierlsSymmetry, computeBornHaber,
} from "./signals/fitness.ts";
import {
  computeKolmogorovComplexity, computeRenyiEntropy, computeTsallisEntropy, computeKlDivergence,
  computeJsDivergence, computeFisherInformation, computeMutualInformation, computeHartleyEntropy,
} from "./signals/info-theory.ts";
import {
  computeBetweennessCentrality, computeClosenessCentrality, computeEigenvectorCentrality,
  computeKatzCentrality, computeClusteringCoefficient, computeModularity,
  computeKirchhoffIndex, computeCheegerConstant, computeSpectralGap, computeLovaszTheta,
  computeGirth, computeGraphDiameter, computeAssortativity,
} from "./signals/network.ts";
import {
  computeHalsteadComplexity, computeMaintainabilityIndex, computeCyclomaticDebt,
  computeLcomCohesion, computeCoupling,
} from "./signals/code-metrics.ts";
import {
  computeSorensenDice, computeSimpsonDiversity, computeShannonEvenness,
  computeGiniCoefficient, computeBergerParker,
} from "./signals/diversity.ts";
import {
  computeLagrangian, computeHamiltonian, computeEntropyProduction, computeFreeEnergy,
} from "./signals/physics.ts";
import {
  computePolyaEnumeration, computeBurnsideLemma, computeCatalanNumber, computeStirlingNumber,
} from "./signals/combinatorics.ts";
import { composeCompactBlock } from "./compact.ts";
import { handleError } from "../shared/debug/debug-system.ts";

/** Cache entry for one file. */
type CacheEntry = {
  mtimeMs: number;
  sizeBytes: number;
  analysis: FileAnalysis;
};

/**
 * What the engine needs from the host that runs it.
 *
 * `runGit` HAS NO DEFAULT, deliberately. A default would be a second source of
 * the answer that only fires when the host forgot — and "the host forgot to
 * say how git may be run" is precisely the state in which running git is
 * dangerous. Making it required turns forgetting into a compile error (the
 * third rung of the strength ladder) rather than into a quiet subprocess with
 * the host's full authority.
 */
export type AwarenessEngineDependencies = Readonly<{
  /** How this host is willing to run git. See `GitCommandRunner`. */
  runGit: GitCommandRunner;
  /** Language adapters; the full registered set unless a caller narrows it. */
  adapters?: readonly LanguageAdapter[];
}>;

/** Construct a new engine. Multiple engines can coexist (e.g. one per codebase). */
export function createAwarenessEngine(config: AwarenessConfig, dependencies: AwarenessEngineDependencies): {
  compute: (rootPath: string) => AwarenessSnapshot;
  clearCache: () => void;
  cacheSize: () => number;
} {
  const adapters = dependencies.adapters ?? ADAPTERS;
  const runGit = dependencies.runGit;
  const cache = new Map<string, CacheEntry>();
  const langConfigMap = languageConfigMap(adapters);

  /** Walk the codebase and return file analyses (using cache). */
  function walkAndAnalyze(rootPath: string): { analyses: FileAnalysis[]; reanalyzed: number; cached: number } {
    const rawAnalyses: FileAnalysis[] = [];
    let reanalyzed = 0;
    let cached = 0;
    let entries = 0;
    const stack: Array<{ dir: string; depth: number }> = [{ dir: rootPath, depth: 0 }];
    const excluded = new Set(config.excludedDirectoryNames);
    // Workspace package map: package.json "name" → relative directory.
    const workspacePackages = new Map<string, string>();
    while (stack.length > 0 && entries < config.maximumEntries) {
      const { dir, depth } = stack.pop()!;
      if (depth > config.maximumDepth) continue;
      let entries_ls: string[] = [];
      try {
        entries_ls = readdirSync(dir);
      } catch (error) {
        // A root that could not be read is not an empty codebase. This read
        // is authoritative even if a host admitted the path before spawning.
        if (depth === 0) {
          throw new InputError(
            `Awareness root directory cannot be read: ${rootPath} (${extractErrorMessage(error)}).`,
            "awareness_root_unreadable",
          );
        }
        handleError(error, { module: "awareness-engine", operation: "catch" });
        continue;
      }
      for (const name of entries_ls) {
        if (excluded.has(name)) continue;
        const full = join(dir, name);
        let st;
        try { st = statSync(full); } catch (e) {handleError(e, { module: "awareness-engine", operation: "catch" }); continue; }
        if (st.isDirectory()) {
          stack.push({ dir: full, depth: depth + 1 });
          const pkgPath = join(dir, name, "package.json");
          bestEffort(() => {
            if (existsSyncFn(pkgPath)) {
              const pkgContent = readFileSync(pkgPath, "utf8");
              const pkg = JSON.parse(pkgContent) as { name?: string };
              if (typeof pkg.name === "string") {
                const rel = relative(rootPath, join(dir, name)).split(sep).join("/");
                workspacePackages.set(pkg.name, rel);
              }
            }
          });
        } else if (st.isFile()) {
          entries += 1;
          if (entries > config.maximumEntries) break;
          if (st.size > config.maximumFileBytes) continue;
          const ext = extname(name).toLowerCase();
          const adapter = adapterForExtension(ext, adapters) ?? GENERIC_ADAPTER;
          if (adapter === GENERIC_ADAPTER) {
            if (!GENERIC_TEXT_EXTENSIONS.includes(ext)) continue;
          }
          const rel = relative(rootPath, full).split(sep).join("/");
          const key = rel;
          const cached_entry = cache.get(key);
          if (cached_entry && cached_entry.mtimeMs === st.mtimeMs && cached_entry.sizeBytes === st.size) {
            rawAnalyses.push(cached_entry.analysis);
            cached += 1;
            continue;
          }
          let content: string;
          try { content = readFileSync(full, "utf8"); } catch (e) {handleError(e, { module: "awareness-engine", operation: "catch" }); continue; }
          let analysis: FileAnalysis;
          try {
            const a = adapter.analyze(rel, content);
            analysis = {
              ...a,
              filePath: rel,
              languageId: adapter.config.id,
              contentHash: sha256(content),
            };
          } catch (e) {handleError(e, { module: "awareness-engine", operation: "catch" });
            continue;
          }
          cache.set(key, { mtimeMs: st.mtimeMs, sizeBytes: st.size, analysis });
          rawAnalyses.push(analysis);
          reanalyzed += 1;
        }
      }
    }
    // Second pass: resolve intra-codebase imports using the FULL analysis set + workspace packages.
    const pathSet = new Set(rawAnalyses.map(a => a.filePath));
    const analyses = rawAnalyses.map(a => ({
      ...a,
      imports: a.imports.map(imp => {
        if (imp.resolvedPath) return imp;
        const resolved = resolveImport(imp.specifier, a.filePath, workspacePackages, pathSet);
        return { ...imp, resolvedPath: resolved };
      }),
    }));
    const currentPaths = new Set(analyses.map(a => a.filePath));
    for (const key of cache.keys()) {
      if (!currentPaths.has(key)) cache.delete(key);
    }
    return { analyses, reanalyzed, cached };
  }

  /** Compute modules (directories) from the file analyses. */
  function computeModules(analyses: readonly FileAnalysis[], mtimes: Map<string, number>): ModuleRecord[] {
    // Group by directory (the module = the directory of the file).
    const byDir = new Map<string, { files: number; fns: number; loc: number; latestMtimeMs: number; name: string }>();
    for (const a of analyses) {
      const dir = a.filePath.includes("/") ? a.filePath.split("/").slice(0, -1).join("/") : ".";
      const name = dir === "." ? "(root)" : dir.split("/").pop() ?? dir;
      const e = byDir.get(dir) ?? { files: 0, fns: 0, loc: 0, latestMtimeMs: 0, name };
      e.files += 1;
      e.fns += a.functions.length;
      e.loc += a.lineCount;
      e.latestMtimeMs = Math.max(e.latestMtimeMs, mtimes.get(a.filePath) ?? 0);
      byDir.set(dir, e);
    }
    // Also: if there are subdirectories that are themselves groups (e.g. "packages" → "packages/foo" → "packages/foo/src"), we want the SHALLOWEST module per chain.
    // For simplicity, use top-level directories (depth-1) as the modules.
    const modules: ModuleRecord[] = [];
    for (const [dir, e] of byDir) {
      // If a directory has only one child that's also a directory and there's no direct file, skip it.
      // Heuristic: collapse single-child chains.
      let finalDir = dir;
      let finalName = e.name;
      // Look for the "real" module — collapse to the topmost non-trivial directory.
      // For babel/packages/babel-parser/src → "babel-parser" (the part after "packages").
      // For tokio/tokio/src/io → "io".
      // For gin/binding → "binding".
      // Strategy: if the path contains "packages/" or "src/", take the segment AFTER it; else take the last segment.
      const path = dir.split("/");
      let effectiveName = finalName;
      for (let i = 0; i < path.length; i += 1) {
        const seg = path[i]!;
        if (seg === "packages" && i + 1 < path.length) {
          effectiveName = path[i + 1] ?? finalName;
          finalDir = path.slice(0, i + 2).join("/");
          break;
        }
        if (seg === "src") {
          // If src is followed by a sub-directory, that's the module name.
          if (i + 1 < path.length) {
            effectiveName = path[i + 1] ?? finalName;
            finalDir = path.slice(0, i + 2).join("/");
          } else if (i - 1 >= 0) {
            // File directly in src/ — use the previous segment (package name).
            effectiveName = path[i - 1] ?? finalName;
            finalDir = path.slice(0, i).join("/") || dir;
          }
          break;
        }
      }
      modules.push({
        path: finalDir,
        name: effectiveName,
        fileCount: e.files,
        functionCount: e.fns,
        lineCount: e.loc,
        pagerank: 0,
        inDegree: 0,
        outDegree: 0,
        latestMtimeMs: e.latestMtimeMs,
      });
    }
    // Merge modules with the same final path (after collapsing).
    const merged = new Map<string, ModuleRecord>();
    for (const m of modules) {
      const existing = merged.get(m.path);
      if (existing) {
        merged.set(m.path, {
          ...existing,
          fileCount: existing.fileCount + m.fileCount,
          functionCount: existing.functionCount + m.functionCount,
          lineCount: existing.lineCount + m.lineCount,
          latestMtimeMs: Math.max(existing.latestMtimeMs, m.latestMtimeMs),
        });
      } else {
        merged.set(m.path, m);
      }
    }
    return [...merged.values()];
  }

  /** Collect per-file mtimes (for trending fallback). */
  function collectMtimes(rootPath: string, analyses: readonly FileAnalysis[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const a of analyses) {
      const mtime = bestEffort(() => statSync(join(rootPath, a.filePath)).mtimeMs);
      if (mtime !== undefined) out.set(a.filePath, mtime);
    }
    return out;
  }

  /** Get recent git history (commit → changed files). */
  function getGitHistory(rootPath: string): GitCommit[] {
    if (!config.useGitHistory) return [];
    try {
      const depth = config.thresholds.gitHistoryDepth;
      const gitTimeoutMs = config.thresholds.gitTimeoutMs;
      // Get commit hashes + timestamps.
      const logFmt = "%H|%ct";
      // ARGUMENT VECTOR, NOT A COMMAND LINE. The old form built a shell string
      // and hand-quoted the interpolations; passing the arguments as a list
      // means there is no shell to quote for, so a project path containing a
      // quote or a `$` cannot become syntax.
      const log = runGit(rootPath, ["log", "-n", String(depth), "--no-merges", `--pretty=${logFmt}`], gitTimeoutMs);
      if (log === null) return [];
      const commits = log.split("\n").filter(Boolean).map(line => {
        const [hash, ts] = line.split("|");
        return { hash: hash!.slice(0, 8), timestampMs: Number(ts) * 1000 };
      });
      // For each commit, get changed files (use diff-tree to avoid show/--no-patch conflict).
      const out: GitCommit[] = [];
      for (const c of commits) {
        const changedFiles = bestEffort(() => {
          const files = runGit(rootPath, ["diff-tree", "--no-commit-id", "--name-only", "-r", c.hash], gitTimeoutMs);
          if (files === null) return undefined;
          return files.split("\n").map(f => f.trim().replace(/\\/g, "/")).filter(f => f);
        });
        out.push({ ...c, changedFiles: changedFiles ?? [] });
      }
      return out;
    } catch (e) {
      // R48: route through the debug owner so a git failure (missing repo,
      // permission denied, timeout) is visible when debug is on — was a
      // bare `catch { return []; }` that silently swallowed ALL errors.
      handleError(e, { module: "awareness-engine", operation: "git-history" });
      return [];
    }
  }

  /** Read a file's content (used by drift/debt; cached via the cache). */
  function makeFileReader(rootPath: string, analyses: readonly FileAnalysis[]): (filePath: string) => string | null {
    return (filePath: string) => {
      const fa = analyses.find(a => a.filePath === filePath);
      if (fa) {
        // Re-read the file content (we don't cache the raw content, just the analysis).
        try { return readFileSync(join(rootPath, filePath), "utf8"); } catch (e) { handleError(e, { module: "awareness-engine", operation: "file-reader-analysis" }); return null; }
      }
      // Manifest files not in analyses (e.g. package.json) — read directly.
      try { return readFileSync(join(rootPath, filePath), "utf8"); } catch (e) { handleError(e, { module: "awareness-engine", operation: "file-reader-manifest" }); return null; }
    };
  }

  /** Compute the full awareness snapshot for the codebase at `rootPath`. */
  function compute(rootPath: string): AwarenessSnapshot {
    const t0 = Date.now();
    const { analyses, reanalyzed, cached } = walkAndAnalyze(rootPath);
    const mtimes = collectMtimes(rootPath, analyses);
    const modules = computeModules(analyses, mtimes);
    const gitHistory = getGitHistory(rootPath);
    const readFile = makeFileReader(rootPath, analyses);

    // Language mix.
    const langByCount = new Map<string, { languageId: string; label: string; fileCount: number; lineCount: number }>();
    for (const a of analyses) {
      const cfg = langConfigMap.get(a.languageId);
      const label = cfg?.label ?? a.languageId;
      const e = langByCount.get(a.languageId) ?? { languageId: a.languageId, label, fileCount: 0, lineCount: 0 };
      e.fileCount += 1;
      e.lineCount += a.lineCount;
      langByCount.set(a.languageId, e);
    }
    const languageMix = [...langByCount.values()].sort((a, b) => b.fileCount - a.fileCount);
    const primaryLanguageId = languageMix[0]?.languageId ?? null;
    const fileCount = analyses.length;
    const functionCount = analyses.reduce((n, a) => n + a.functions.length, 0);
    const totalLoc = analyses.reduce((n, a) => n + a.lineCount, 0);
    const moduleCount = modules.length;

    // Build context.
    const ctx: SignalContext = {
      config,
      languageConfigs: langConfigMap,
      fileAnalyses: analyses,
      modules,
      rootPath,
      gitHistory,
      readFile,
      nowMs: Date.now(),
    };

    // Compute base signals (no inter-signal dependencies).
    // `expGate(id)` returns true iff the signal is cheap (not in
    // EXPENSIVE_SIGNAL_IDS) OR the caller opted into `expensiveSignals`.
    // Combined with the per-signal toggle at each call site, this gives a
    // two-level gate: coarse (expensiveSignals) + fine (signals.*).
    const expGate = (id: string): boolean => !EXPENSIVE_SIGNAL_IDS.has(id) || config.expensiveSignals;
    const typeLevel = config.signals.typeLevel ? computeTypeLevel(ctx).typeLevel : null;
    const complexity = config.signals.complexity ? computeComplexity(ctx).complexity : null;
    const architectureResult = config.signals.architecture ? computeArchitecture(ctx) : null;
    const architecture = architectureResult?.architecture ?? null;
    const clones = config.signals.clones ? computeClones(ctx).clones : null;
    const entropy = config.signals.entropy ? computeEntropy(ctx).entropy : null;
    const dependencies = config.signals.dependencies ? computeDependencies(ctx).dependencies : null;
    const health = config.signals.health ? computeHealth(ctx).health : null;
    const moduleRoles = config.signals.moduleRoles ? computeModuleRoles(ctx).moduleRoles : null;
    const drift = config.signals.drift ? computeDrift(ctx).drift : null;
    const debt = config.signals.debt ? computeDebt(ctx).debt : null;

    // Compute derived signals.
    const quality = config.signals.quality ? computeQuality(ctx, { health, complexity, dependencies, fileCount, totalLoc }).quality : null;
    const hotspots = config.signals.hotspots ? computeHotspots(ctx, { complexity, architecture }).hotspots : null;
    const trending = config.signals.trending ? computeTrending(ctx).trending : null;
    const risk = config.signals.risk ? computeRisk(ctx, { complexity }).risk : null;
    // EXP372 new signals (16). Each is independent; failures are isolated.
    // Every signal in EXPENSIVE_SIGNAL_IDS is additionally gated by
    // `config.expensiveSignals` — the coarse knob for large codebases. The
    // per-signal toggle remains the fine-grained authority.
    const bellClones = config.signals.bellClones && expGate("bellClones") ? safeSignal(() => computeBellClones(ctx).bellClones) : null;
    const banachContraction = config.signals.banachContraction && expGate("banachContraction") ? safeSignal(() => computeBanachContraction(ctx).banachContraction) : null;
    const qecDistance = config.signals.qecDistance && expGate("qecDistance") ? safeSignal(() => computeQecDistance(ctx).qecDistance) : null;
    const agSpectrum = config.signals.agSpectrum && expGate("agSpectrum") ? safeSignal(() => computeAgSpectrum(ctx).agSpectrum) : null;
    const waveletClones = config.signals.waveletClones && expGate("waveletClones") ? safeSignal(() => computeWaveletClones(ctx).waveletClones) : null;
    const ricciCurvature = config.signals.ricciCurvature && expGate("ricciCurvature") ? safeSignal(() => computeRicciCurvature(ctx).ricciCurvature) : null;
    const fiberBundle = config.signals.fiberBundle && expGate("fiberBundle") ? safeSignal(() => computeFiberBundle(ctx).fiberBundle) : null;
    const topos = config.signals.topos && expGate("topos") ? safeSignal(() => computeTopos(ctx).topos) : null;
    const functionStats = config.signals.functionStats ? safeSignal(() => computeFunctionStats(ctx).functionStats) : null;
    const persistenceLandscapes = config.signals.persistenceLandscapes && expGate("persistenceLandscapes") ? safeSignal(() => computePersistenceLandscapes(ctx).persistenceLandscapes) : null;
    const testCoverage = config.signals.testCoverage ? safeSignal(() => computeTestCoverage(ctx).testCoverage) : null;
    const ergodicDrift = config.signals.ergodicDrift && expGate("ergodicDrift") ? safeSignal(() => computeErgodicDrift(ctx).ergodicDrift) : null;
    const quantumStability = config.signals.quantumStability && expGate("quantumStability") ? safeSignal(() => computeQuantumStability(ctx).quantumStability) : null;
    const editPredictability = config.signals.editPredictability && expGate("editPredictability") ? safeSignal(() => computeEditPredictability(ctx).editPredictability) : null;
    const recursionHierarchy = config.signals.recursionHierarchy && expGate("recursionHierarchy") ? safeSignal(() => computeRecursionHierarchy(ctx).recursionHierarchy) : null;
    const hubStress = config.signals.hubStress && expGate("hubStress") ? safeSignal(() => computeHubStress(ctx).hubStress) : null;
    // EXP387 new signals (14). Each is independent; failures are isolated.
    const thermodynamics = config.signals.thermodynamics && expGate("thermodynamics") ? safeSignal(() => computeThermodynamics(ctx).thermodynamics) : null;
    const benford = config.signals.benford && expGate("benford") ? safeSignal(() => computeBenford(ctx).benford) : null;
    const fiedlerBisection = config.signals.fiedlerBisection && expGate("fiedlerBisection") ? safeSignal(() => computeFiedlerBisection(ctx).fiedlerBisection) : null;
    const homology = config.signals.homology && expGate("homology") ? safeSignal(() => computeHomology(ctx).homology) : null;
    const shapeDna = config.signals.shapeDna && expGate("shapeDna") ? safeSignal(() => computeShapeDna(ctx).shapeDna) : null;
    const chromaticNumber = config.signals.chromaticNumber && expGate("chromaticNumber") ? safeSignal(() => computeChromaticNumber(ctx).chromaticNumber) : null;
    const martingaleDebt = config.signals.martingaleDebt && expGate("martingaleDebt") ? safeSignal(() => computeMartingaleDebt(ctx).martingaleDebt) : null;
    const freeProbability = config.signals.freeProbability && expGate("freeProbability") ? safeSignal(() => computeFreeProbability(ctx).freeProbability) : null;
    const maxwellDemon = config.signals.maxwellDemon && expGate("maxwellDemon") ? safeSignal(() => computeMaxwellDemon(ctx).maxwellDemon) : null;
    const functionClassification = config.signals.functionClassification && expGate("functionClassification") ? safeSignal(() => computeFunctionClassification(ctx).functionClassification) : null;
    const linguisticTypology = config.signals.linguisticTypology && expGate("linguisticTypology") ? safeSignal(() => computeLinguisticTypology(ctx).linguisticTypology) : null;
    const turingTreadmills = config.signals.turingTreadmills && expGate("turingTreadmills") ? safeSignal(() => computeTuringTreadmills(ctx).turingTreadmills) : null;
    const mechanismDesign = config.signals.mechanismDesign && expGate("mechanismDesign") ? safeSignal(() => computeMechanismDesign(ctx).mechanismDesign) : null;
    const sheafCohomology = config.signals.sheafCohomology && expGate("sheafCohomology") ? safeSignal(() => computeSheafCohomology(ctx).sheafCohomology) : null;
    // The extended signal set (all gated by expensiveSignals via expGate).
    const al2Fitness = config.signals.al2Fitness && expGate("al2Fitness") ? safeSignal(() => computeAl2Fitness(ctx).al2Fitness) : null;
    const leChatelier = config.signals.leChatelier && expGate("leChatelier") ? safeSignal(() => computeLeChatelier(ctx).leChatelier) : null;
    const obafgkm = config.signals.obafgkm && expGate("obafgkm") ? safeSignal(() => computeObafgkm(ctx).obafgkm) : null;
    const peierlsSymmetry = config.signals.peierlsSymmetry && expGate("peierlsSymmetry") ? safeSignal(() => computePeierlsSymmetry(ctx).peierlsSymmetry) : null;
    const bornHaber = config.signals.bornHaber && expGate("bornHaber") ? safeSignal(() => computeBornHaber(ctx).bornHaber) : null;
    const kolmogorovComplexity = config.signals.kolmogorovComplexity && expGate("kolmogorovComplexity") ? safeSignal(() => computeKolmogorovComplexity(ctx).kolmogorovComplexity) : null;
    const renyiEntropy = config.signals.renyiEntropy && expGate("renyiEntropy") ? safeSignal(() => computeRenyiEntropy(ctx).renyiEntropy) : null;
    const tsallisEntropy = config.signals.tsallisEntropy && expGate("tsallisEntropy") ? safeSignal(() => computeTsallisEntropy(ctx).tsallisEntropy) : null;
    const klDivergence = config.signals.klDivergence && expGate("klDivergence") ? safeSignal(() => computeKlDivergence(ctx).klDivergence) : null;
    const jsDivergence = config.signals.jsDivergence && expGate("jsDivergence") ? safeSignal(() => computeJsDivergence(ctx).jsDivergence) : null;
    const fisherInformation = config.signals.fisherInformation && expGate("fisherInformation") ? safeSignal(() => computeFisherInformation(ctx).fisherInformation) : null;
    const mutualInformation = config.signals.mutualInformation && expGate("mutualInformation") ? safeSignal(() => computeMutualInformation(ctx).mutualInformation) : null;
    const hartleyEntropy = config.signals.hartleyEntropy && expGate("hartleyEntropy") ? safeSignal(() => computeHartleyEntropy(ctx).hartleyEntropy) : null;
    const betweennessCentrality = config.signals.betweennessCentrality && expGate("betweennessCentrality") ? safeSignal(() => computeBetweennessCentrality(ctx).betweennessCentrality) : null;
    const closenessCentrality = config.signals.closenessCentrality && expGate("closenessCentrality") ? safeSignal(() => computeClosenessCentrality(ctx).closenessCentrality) : null;
    const eigenvectorCentrality = config.signals.eigenvectorCentrality && expGate("eigenvectorCentrality") ? safeSignal(() => computeEigenvectorCentrality(ctx).eigenvectorCentrality) : null;
    const katzCentrality = config.signals.katzCentrality && expGate("katzCentrality") ? safeSignal(() => computeKatzCentrality(ctx).katzCentrality) : null;
    const clusteringCoefficient = config.signals.clusteringCoefficient && expGate("clusteringCoefficient") ? safeSignal(() => computeClusteringCoefficient(ctx).clusteringCoefficient) : null;
    const modularity = config.signals.modularity && expGate("modularity") ? safeSignal(() => computeModularity(ctx).modularity) : null;
    const kirchhoffIndex = config.signals.kirchhoffIndex && expGate("kirchhoffIndex") ? safeSignal(() => computeKirchhoffIndex(ctx).kirchhoffIndex) : null;
    const cheegerConstant = config.signals.cheegerConstant && expGate("cheegerConstant") ? safeSignal(() => computeCheegerConstant(ctx).cheegerConstant) : null;
    const spectralGap = config.signals.spectralGap && expGate("spectralGap") ? safeSignal(() => computeSpectralGap(ctx).spectralGap) : null;
    const lovaszTheta = config.signals.lovaszTheta && expGate("lovaszTheta") ? safeSignal(() => computeLovaszTheta(ctx).lovaszTheta) : null;
    const girth = config.signals.girth && expGate("girth") ? safeSignal(() => computeGirth(ctx).girth) : null;
    const graphDiameter = config.signals.graphDiameter && expGate("graphDiameter") ? safeSignal(() => computeGraphDiameter(ctx).graphDiameter) : null;
    const halsteadComplexity = config.signals.halsteadComplexity && expGate("halsteadComplexity") ? safeSignal(() => computeHalsteadComplexity(ctx).halsteadComplexity) : null;
    const maintainabilityIndex = config.signals.maintainabilityIndex && expGate("maintainabilityIndex") ? safeSignal(() => computeMaintainabilityIndex(ctx).maintainabilityIndex) : null;
    const cyclomaticDebt = config.signals.cyclomaticDebt && expGate("cyclomaticDebt") ? safeSignal(() => computeCyclomaticDebt(ctx).cyclomaticDebt) : null;
    const lcomCohesion = config.signals.lcomCohesion && expGate("lcomCohesion") ? safeSignal(() => computeLcomCohesion(ctx).lcomCohesion) : null;
    const coupling = config.signals.coupling && expGate("coupling") ? safeSignal(() => computeCoupling(ctx).coupling) : null;
    const sorensenDice = config.signals.sorensenDice && expGate("sorensenDice") ? safeSignal(() => computeSorensenDice(ctx).sorensenDice) : null;
    const simpsonDiversity = config.signals.simpsonDiversity && expGate("simpsonDiversity") ? safeSignal(() => computeSimpsonDiversity(ctx).simpsonDiversity) : null;
    const shannonEvenness = config.signals.shannonEvenness && expGate("shannonEvenness") ? safeSignal(() => computeShannonEvenness(ctx).shannonEvenness) : null;
    const giniCoefficient = config.signals.giniCoefficient && expGate("giniCoefficient") ? safeSignal(() => computeGiniCoefficient(ctx).giniCoefficient) : null;
    const bergerParker = config.signals.bergerParker && expGate("bergerParker") ? safeSignal(() => computeBergerParker(ctx).bergerParker) : null;
    const lagrangian = config.signals.lagrangian && expGate("lagrangian") ? safeSignal(() => computeLagrangian(ctx).lagrangian) : null;
    const hamiltonian = config.signals.hamiltonian && expGate("hamiltonian") ? safeSignal(() => computeHamiltonian(ctx).hamiltonian) : null;
    const entropyProduction = config.signals.entropyProduction && expGate("entropyProduction") ? safeSignal(() => computeEntropyProduction(ctx).entropyProduction) : null;
    const freeEnergy = config.signals.freeEnergy && expGate("freeEnergy") ? safeSignal(() => computeFreeEnergy(ctx).freeEnergy) : null;
    const polyaEnumeration = config.signals.polyaEnumeration && expGate("polyaEnumeration") ? safeSignal(() => computePolyaEnumeration(ctx).polyaEnumeration) : null;
    const burnsideLemma = config.signals.burnsideLemma && expGate("burnsideLemma") ? safeSignal(() => computeBurnsideLemma(ctx).burnsideLemma) : null;
    const catalanNumber = config.signals.catalanNumber && expGate("catalanNumber") ? safeSignal(() => computeCatalanNumber(ctx).catalanNumber) : null;
    const stirlingNumber = config.signals.stirlingNumber && expGate("stirlingNumber") ? safeSignal(() => computeStirlingNumber(ctx).stirlingNumber) : null;
    const assortativity = config.signals.assortativity && expGate("assortativity") ? safeSignal(() => computeAssortativity(ctx).assortativity) : null;

    // Compose the snapshot (compact block filled below).
    const partial: Omit<AwarenessSnapshot, "compactBlock" | "compactTokens" | "computeTimeMs" | "reanalyzedFiles" | "cachedFiles"> = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      computedAt: new Date(ctx.nowMs).toISOString(),
      rootPath,
      languageMix,
      primaryLanguageId,
      fileCount,
      functionCount,
      moduleCount,
      totalLoc,
      modules,
      fileAnalyses: analyses,
      typeLevel,
      quality,
      drift,
      complexity,
      architecture,
      clones,
      entropy,
      dependencies,
      health,
      debt,
      moduleRoles,
      hotspots,
      trending,
      risk,
      // EXP372 new signals.
      bellClones,
      banachContraction,
      qecDistance,
      agSpectrum,
      waveletClones,
      ricciCurvature,
      fiberBundle,
      topos,
      functionStats,
      persistenceLandscapes,
      testCoverage,
      ergodicDrift,
      quantumStability,
      editPredictability,
      recursionHierarchy,
      hubStress,
      // EXP387 new signals (14).
      thermodynamics,
      benford,
      fiedlerBisection,
      homology,
      shapeDna,
      chromaticNumber,
      martingaleDebt,
      freeProbability,
      maxwellDemon,
      functionClassification,
      linguisticTypology,
      turingTreadmills,
      mechanismDesign,
      sheafCohomology,
      // The extended signal set.
      al2Fitness,
      leChatelier,
      obafgkm,
      peierlsSymmetry,
      bornHaber,
      kolmogorovComplexity,
      renyiEntropy,
      tsallisEntropy,
      klDivergence,
      jsDivergence,
      fisherInformation,
      mutualInformation,
      hartleyEntropy,
      betweennessCentrality,
      closenessCentrality,
      eigenvectorCentrality,
      katzCentrality,
      clusteringCoefficient,
      modularity,
      kirchhoffIndex,
      cheegerConstant,
      spectralGap,
      lovaszTheta,
      girth,
      graphDiameter,
      halsteadComplexity,
      maintainabilityIndex,
      cyclomaticDebt,
      lcomCohesion,
      coupling,
      sorensenDice,
      simpsonDiversity,
      shannonEvenness,
      giniCoefficient,
      bergerParker,
      lagrangian,
      hamiltonian,
      entropyProduction,
      freeEnergy,
      polyaEnumeration,
      burnsideLemma,
      catalanNumber,
      stirlingNumber,
      assortativity,
    };
    // Compose compact block.
    const { text, tokens } = composeCompactBlock({ ...partial, compactBlock: "", compactTokens: 0, computeTimeMs: 0, reanalyzedFiles: 0, cachedFiles: 0 } as AwarenessSnapshot, config.compactTokenBudget);

    return Object.freeze({
      ...partial,
      compactBlock: text,
      compactTokens: tokens,
      computeTimeMs: Date.now() - t0,
      reanalyzedFiles: reanalyzed,
      cachedFiles: cached,
    } as AwarenessSnapshot);
  }

  return {
    compute,
    clearCache: () => cache.clear(),
    cacheSize: () => cache.size,
  };
}

/**
 * SHA-256 hex digest of a string.
 *
 * R44: delegates to the canonical `sha256` owner in `src/integrity.ts`
 * (was a private near-duplicate body — "No Scattered Helpers" violation).
 * Kept as a local no-arg-binding wrapper so existing `sha256(content)`
 * call sites see the same single-arg signature.
 */
function sha256(s: string): string {
  return integritySha256(s);
}

/**
 * Safely compute a signal — catch any error and return null so one
 * broken signal does not break the whole snapshot. The engine is
 * designed for graceful degradation: every signal is independent.
 *
 * R48: routes the swallowed error through the debug owner (`handleError`)
 * so a broken signal is visible when debug is on (zero-overhead when off)
 * was a bare `catch { return null; }` that silently hid signal failures
 *.
 */
function safeSignal<T>(compute: () => T): T | null {
  try {
    return compute();
  } catch (e) {
    handleError(e, { module: "awareness-engine", operation: "signal-compute" });
    return null;
  }
}

/** Tiny wrapper to avoid `existsSync` import (used only in the walker). */
function existsSyncFn(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (e) {
    handleError(e, { module: "awareness-engine", operation: "exists-sync" });
    return false;
  }
}

/**
 * Resolve an import specifier to a workspace-relative source file path.
 * Handles:
 * relative imports (`./foo`, `../foo`) — with.ts/.tsx/.js/.jsx inference.
 * workspace package imports (`@babel/parser` → `packages/babel-parser/src/index.ts`).
 * subpath imports (`@babel/parser/lib/foo` → `packages/babel-parser/src/foo.ts`).
 * Returns null if the import is external or cannot be resolved.
 */
function resolveImport(specifier: string, fromPath: string, workspacePackages: ReadonlyMap<string, string>, pathSet: ReadonlySet<string>): string | null {
  // Relative import.
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const base = fromPath.split("/").slice(0, -1).join("/");
    const joined = (base + "/" + specifier).replace(/\/+/g, "/");
    const parts = joined.split("/");
    const out: string[] = [];
    for (const p of parts) {
      if (p === ".") continue;
      if (p === "..") { out.pop(); continue; }
      out.push(p);
    }
    const clean = out.join("/");
    return resolveSourcePath(clean, pathSet);
  }
  // Workspace package import.
  if (workspacePackages.has(specifier)) {
    const pkgDir = workspacePackages.get(specifier)!;
    return resolveSourcePath(pkgDir + "/src/index", pathSet) ?? resolveSourcePath(pkgDir + "/src", pathSet);
  }
  // Workspace package subpath: `@scope/name/sub` → packages/<scope>-<name>/src/<sub>.
  const slashIdx = specifier.indexOf("/");
  if (slashIdx > 0 && specifier.startsWith("@")) {
    const pkgName = specifier.slice(0, slashIdx);
    const subpath = specifier.slice(slashIdx + 1);
    if (workspacePackages.has(pkgName)) {
      const pkgDir = workspacePackages.get(pkgName)!;
      return resolveSourcePath(pkgDir + "/src/" + subpath, pathSet);
    }
  }
  return null;
}

/** Try a few extensions + index files to find the source path. */
function resolveSourcePath(basePath: string, pathSet: ReadonlySet<string>): string | null {
  // TS-conv: a specifier ending in.js/.jsx/.mjs/.cjs refers to a.ts/.tsx/.mts/.cts source file.
  let base = basePath;
  if (base.endsWith(".js")) base = base.slice(0, -3);
  else if (base.endsWith(".jsx")) base = base.slice(0, -4);
  else if (base.endsWith(".mjs")) base = base.slice(0, -4);
  else if (base.endsWith(".cjs")) base = base.slice(0, -4);
  const candidates = [
    base + ".ts", base + ".tsx", base + ".mts", base + ".cts",
    base + ".js", base + ".jsx", base + ".mjs", base + ".cjs",
    base + ".py", base + ".rs", base + ".go",
    base + "/index.ts", base + "/index.tsx", base + "/index.js", base + "/index.jsx",
    base + "/index.py", base + "/index.rs", base + "/index.go",
    base + "/mod.rs", base + "/lib.rs",
    // Also try the original basePath (in case the specifier already had.ts/.py/.rs/.go).
    basePath,
  ];
  for (const c of candidates) {
    if (pathSet.has(c)) return c;
  }
  return null;
}
