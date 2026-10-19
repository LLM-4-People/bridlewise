/**
 * Compact representation: a 200–500 token block summarizing the
 * codebase, suitable to feed to the LLM at the START of every turn.
 *
 * The block format is a compact, single-line-per-section text:
 *
 * CODEBASE AWARENESS (computed <ISO time>, <fileCount> files, <fnCount> fns, <moduleCount> mods, <LOC> LOC):
 * KEY INSIGHTS (3-5 actionable findings the LLM MUST use):
 * - <insight 1>
 * - <insight 2>
 *...
 * lang: <primary lang label> (X%); type: <level> (typedFileFrac=0.X, typedParamFrac=0.X)
 * modules (top by PageRank): <name>(<pr>)...5...
 * trending: <name>(<commits>)...5...
 * complexity: mean=<X> median=<X> p95=<X> max=<X> hotspots=<X> [bucket: 1/2-5/6-10/11-15/16-25/26+]
 * top-complex fns: <name>(c=X)...5...
 * clones: <families> families, <coverage>% coverage; top: <rep>(<members>)...3...
 * entropy: H=<X> bits, Rényi[0,0.5,1,2]=[...]; tokens=<X>
 * deps: <edges> edges, density=<X>, <X> circular, <X> missing
 * health: todo=<X>, emptyCatch=<X>, magicN=<X>, deadExport=<X>
 * quality: <X> issues/KLOC; top: <cat>=<X>...
 * drift: schema=<ver>, depDrift=<X> commits
 * debt: total=<X> (Ebbinghaus); top: <file>(<X>)
 * roles: <role>=<count>...5...
 * hotspots: topDep=<name>(<deg>)...3...
 * risk: <name>(c=X,n=X)...5...
 * recent: <file>...5...
 *
 * EXP387 CHANGE: a KEY INSIGHTS section is now the FIRST section of the
 * block (right after the header). It surfaces 3-5 of the MOST ACTIONABLE
 * signals, each phrased as a one-line actionable insight. This fixes
 * EXP372's 1/20 LLM failure where the LLM didn't notice the `topos:`
 * line buried in the block. The insights are selected by Fisher
 * information (EXP324) — the signals that carry the most information
 * about the codebase identity.
 */
import type { AwarenessSnapshot } from "./types.ts";

export function composeCompactBlock(s: AwarenessSnapshot, targetTokens: number): { text: string; tokens: number } {
  const lines: string[] = [];
  lines.push(`CODEBASE AWARENESS (computed ${s.computedAt}, ${s.fileCount} files, ${s.functionCount} fns, ${s.moduleCount} mods, ${s.totalLoc} LOC):`);

  // EXP387 — KEY INSIGHTS section. 3-5 actionable insights, surfaced at the TOP
  // of the block so the LLM sees them first. Each insight is phrased as a
  // decision-relevant statement (the LLM can act on it directly).
  const insights = computeKeyInsights(s);
  if (insights.length > 0) {
    lines.push(`KEY INSIGHTS (${insights.length} actionable — USE THESE in your answer):`);
    for (const ins of insights) lines.push(`- ${ins}`);
  }

  const lang = s.languageMix[0];
  if (lang) lines.push(`lang: ${lang.label} (${pct(lang.fileCount, s.fileCount)}%); type: ${s.typeLevel?.level ?? "?"} (typedFileFrac=${s.typeLevel?.typedFileFraction ?? 0}, typedParamFrac=${s.typeLevel?.typedParameterFraction ?? 0})`);
  if (s.architecture) {
    const hubs = s.architecture.hubModules.slice(0, 5).map(m => `${shortName(m.name)}(${m.pagerank.toFixed(3)},in=${m.inDegree})`).join(", ");
    lines.push(`arch: ${s.architecture.type}, edges=${s.architecture.edgeCount}, density=${s.architecture.density}; hub: ${hubs}`);
  }
  if (s.trending && s.trending.topTrendingModules.length > 0) {
    const t = s.trending.topTrendingModules.slice(0, 5).map(m => `${shortName(m.name)}(${(m as { recentCommits?: number }).recentCommits ?? 0})`).join(", ");
    lines.push(`trending: ${t}`);
  }
  if (s.complexity) {
    const d = s.complexity;
    lines.push(`complexity: mean=${d.mean} median=${d.median} p95=${d.p95} max=${d.max} hot=${d.hotspotCount} [${d.distribution.join("/")}]`);
    if (d.topFunctions.length > 0) {
      const f = d.topFunctions.slice(0, 3).map(fn => `${shortFnName(fn.filePath)}:${fn.name}(c=${fn.complexity})`).join(", ");
      lines.push(`topComplex: ${f}`);
    }
  }
  if (s.clones) {
    const t = s.clones.topFamilies.slice(0, 3).map(f => `${shortFnName(f.representative)}(${f.members})`).join(", ");
    lines.push(`clones: ${s.clones.familyCount} fams, ${pct(s.clones.cloneCoverage, 1)}% coverage; top: ${t}`);
  }
  if (s.entropy) {
    const orders = s.entropy.renyiSpectrum.map(r => r.entropy).join(",");
    lines.push(`entropy: H=${s.entropy.shannon} bits, Rényi[${s.entropy.renyiSpectrum.map(r => r.order).join(",")}]=[${orders}]; tokens=${s.entropy.tokenCount}`);
  }
  if (s.dependencies) {
    lines.push(`deps: ${s.dependencies.graphDensity} density, ${s.dependencies.circularCount} circular, ${s.dependencies.missingSymbolCount} missing`);
  }
  if (s.health) {
    lines.push(`health: todo=${s.health.todoCount}, emptyCatch=${s.health.emptyCatchCount}, magicN=${s.health.magicNumberCount}, deadExp=${s.health.deadExportCount}`);
  }
  if (s.quality) {
    const t = s.quality.topCategories.slice(0, 3).map(c => `${c.category}=${c.count}`).join(", ");
    lines.push(`quality: ${s.quality.issuesPerKloc} issues/KLOC; top: ${t}`);
  }
  if (s.drift) {
    lines.push(`drift: schema=${s.drift.schemaVersion ?? "?"}, depDrift=${s.drift.dependencyDrift} commits`);
  }
  if (s.debt && s.debt.totalDebt > 0) {
    const t = s.debt.topDebts.slice(0, 3).map(d => `${shortFnName(d.filePath)}(${d.debt.toFixed(1)}d,${d.kind})`).join(", ");
    lines.push(`debt: total=${s.debt.totalDebt.toFixed(2)}; top: ${t}`);
  }
  if (s.moduleRoles) {
    const r = s.moduleRoles.roles.slice(0, 5).map(r => `${r.role}=${r.moduleCount}`).join(", ");
    lines.push(`roles: ${r}`);
  }
  if (s.hotspots) {
    const t = s.hotspots.topDependedOn.slice(0, 3).map(m => `${shortName(m.name)}(in=${m.inDegree})`).join(", ");
    lines.push(`hubDep: ${t}`);
  }
  if (s.risk && s.risk.topRisks.length > 0) {
    const r = s.risk.topRisks.slice(0, 5).map(r => `${shortFnName(r.filePath)}:${r.name}(c=${r.complexity},n=${r.callCount})`).join(", ");
    lines.push(`risk: ${r}`);
  }
  if (s.trending && s.trending.topRecentFiles.length > 0) {
    const r = s.trending.topRecentFiles.slice(0, 5).map(f => `${shortFnName(f.filePath)}`).join(", ");
    lines.push(`recent: ${r}`);
  }
  // EXP372 new signals — compact one-liners.
  if (s.testCoverage) lines.push(`testCov: ${s.testCoverage.testFileCount}/${s.testCoverage.sourceFileCount} (${(s.testCoverage.ratio * 100).toFixed(0)}% ratio, ${(s.testCoverage.testDensity * 100).toFixed(0)}% density)`);
  if (s.functionStats) lines.push(`fnStats: mean=${s.functionStats.meanLength} LOC, max=${s.functionStats.maxLength}, arity=[${s.functionStats.arityDistribution.join("/")}], idNum=${s.functionStats.idNumArity}(${s.functionStats.idNumHubCount}), lie=${s.functionStats.lieCommutativity}`);
  if (s.bellClones && s.bellClones.totalPairs > 0) lines.push(`bellClones: ${s.bellClones.isolatedPairs}/${s.bellClones.totalPairs} isolated (${(s.bellClones.isolatedFraction * 100).toFixed(0)}%)`);
  if (s.banachContraction && s.banachContraction.familyCount > 0) lines.push(`banach: q=${s.banachContraction.meanContraction} (${s.banachContraction.isContraction ? "contraction" : "not-contraction"}, ${s.banachContraction.familyCount} fams)`);
  if (s.qecDistance && s.qecDistance.familyCount > 0) lines.push(`qec: meanD=${s.qecDistance.meanDistance}, maxD=${s.qecDistance.maxDistance}, fragile=${s.qecDistance.fragileCount}, prot=${s.qecDistance.protectedCount}`);
  if (s.agSpectrum && s.agSpectrum.familyCount > 0) lines.push(`agSpectrum: ${s.agSpectrum.spectrumSize}/${s.agSpectrum.totalRules} rules, gen=${s.agSpectrum.mostGenericRule}, red=${s.agSpectrum.reducibleCount}`);
  if (s.waveletClones && s.waveletClones.waveletFamilyCount > 0) lines.push(`wavelet: ${s.waveletClones.waveletFamilyCount} fams, cov=${(s.waveletClones.waveletCloneCoverage * 100).toFixed(0)}%, E=${s.waveletClones.meanCoeffEnergy}`);
  if (s.ricciCurvature && s.ricciCurvature.edgeCount > 0) lines.push(`ricci: κ=${s.ricciCurvature.meanCurvature}, min=${s.ricciCurvature.minCurvature}, bridges=${s.ricciCurvature.bridgeCount}, hubs=${s.ricciCurvature.hubCount}`);
  if (s.fiberBundle) lines.push(`fiber: ${s.fiberBundle.nonTrivial ? "non-trivial" : "trivial"}, div=${s.fiberBundle.meanDivergence}, top=${s.fiberBundle.topDistinctModule}`);
  if (s.topos) lines.push(`topos: ${s.topos.isIntuitionistic ? "intuitionistic" : "boolean"}, LEM fails=${s.topos.lemFailsCount}/${s.topos.lemHoldsCount + s.topos.lemFailsCount}`);
  if (s.persistenceLandscapes) lines.push(`persistence: mean=${s.persistenceLandscapes.meanPersistence}, max=${s.persistenceLandscapes.maxPersistence}, peak=${s.persistenceLandscapes.landscapePeak}, β=[${s.persistenceLandscapes.bettiNumbers.join(",")}]`);
  if (s.ergodicDrift && (s.ergodicDrift.commitCount ?? 0) > 0) lines.push(`ergodic: ${s.ergodicDrift.driftDirection}, growth=${s.ergodicDrift.growthRate}`);
  if (s.quantumStability && s.quantumStability.commitCount > 0) lines.push(`quantum: coherence=${s.quantumStability.coherenceScore}, ${s.quantumStability.isStable ? "stable" : "decohering"}, mean=${s.quantumStability.meanCommitSize}`);
  if (s.editPredictability && s.editPredictability.aliveCellCount > 0) lines.push(`editPred: ${s.editPredictability.predictability} (${s.editPredictability.isPredictable ? "predictable" : "unpredictable"}, alive=${s.editPredictability.aliveCellCount})`);
  if (s.recursionHierarchy) lines.push(`recursion: Δ₀₁=${s.recursionHierarchy.decidableCount}, Σ₀₁=${s.recursionHierarchy.reCount}, Π₀₁=${s.recursionHierarchy.coreCount}, Π₀₂=${s.recursionHierarchy.undecidableCount}, decid=${s.recursionHierarchy.decidabilityRatio}`);
  // EXP387 new signals (14) — compact one-liners.
  if (s.thermodynamics) lines.push(`thermo: T=${s.thermodynamics.temperature}, S=${s.thermodynamics.entropy}, U=${s.thermodynamics.internalEnergy}, F=${s.thermodynamics.freeEnergy}`);
  if (s.benford && s.benford.totalNumbers > 0) lines.push(`benford: χ²=${s.benford.chiSquareDeviation}, dom=${s.benford.dominantDigit}, n=${s.benford.totalNumbers}`);
  if (s.fiedlerBisection) lines.push(`fiedler: λ2=${s.fiedlerBisection.fiedlerValue}, ${s.fiedlerBisection.isBottleneck ? "BOTTLENECK" : "no-bottleneck"}, bisect=${s.fiedlerBisection.bisectionSize}, bridge=${s.fiedlerBisection.topBridgeModule}`);
  if (s.homology) lines.push(`homology: H0=${s.homology.h0}, H1=${s.homology.h1} (hidden DRY candidates)`);
  if (s.shapeDna) lines.push(`shapeDna: ${s.shapeDna.distinctShapes} shapes, diversity=${s.shapeDna.shapeDiversity}, top=${s.shapeDna.largestShape}(${s.shapeDna.largestShapeCount})`);
  if (s.chromaticNumber) lines.push(`chromatic: χ=${s.chromaticNumber.chromaticNumber}, ω=${s.chromaticNumber.cliqueNumber}, ${s.chromaticNumber.isPerfectGraph ? "perfect" : "imperfect"}, refactorOps=${s.chromaticNumber.refactorOpportunities}`);
  if (s.martingaleDebt) lines.push(`martingale: μ=${s.martingaleDebt.drift} (${s.martingaleDebt.debtTrajectory}), σ²=${s.martingaleDebt.variance}, p=${s.martingaleDebt.driftPValue}`);
  if (s.freeProbability) lines.push(`freeProb: ${s.freeProbability.coupledPairs} coupled pairs (${(s.freeProbability.noncommutingFraction * 100).toFixed(0)}%), ${s.freeProbability.freeIndependent ? "free-indep" : "coupled"})`);
  if (s.maxwellDemon) lines.push(`demon: eff=${s.maxwellDemon.meanDemonEfficiency}, ${s.maxwellDemon.isThermodynamicallyValid ? "valid" : "invalid"}, top=${s.maxwellDemon.topDemon}`);
  if (s.functionClassification) lines.push(`classify: pathFrac=${s.functionClassification.pathologicalFraction}, roles={util=${s.functionClassification.roleBuckets.utility}, data=${s.functionClassification.roleBuckets.dataTransform}, err=${s.functionClassification.roleBuckets.errorHandler}, val=${s.functionClassification.roleBuckets.validator}}`);
  if (s.linguisticTypology) lines.push(`typology: ${s.linguisticTypology.dominantFamily} (${(s.linguisticTypology.functionalFraction * 100).toFixed(0)}% func, ${(s.linguisticTypology.asyncFraction * 100).toFixed(0)}% async), ${s.linguisticTypology.multiParadigm ? "multi-paradigm" : "single-paradigm"}`);
  if (s.turingTreadmills) lines.push(`treadmill: ${s.turingTreadmills.treadmillCount} files (max=${s.turingTreadmills.maxTreadmillCount}), ${s.turingTreadmills.hasActiveTreadmills ? "ACTIVE" : "settled"}`);
  if (s.mechanismDesign) lines.push(`mechanism: IC=${s.mechanismDesign.icRatio} (${s.mechanismDesign.mechanismStrength}), uncaught=${s.mechanismDesign.uncaughtCandidates}`);
  if (s.sheafCohomology) lines.push(`sheaf: H⁰=${s.sheafCohomology.h0Dimension}, H¹=${s.sheafCohomology.h1Obstructions} (${s.sheafCohomology.isSheaf ? "valid-sheaf" : "BROKEN"}), top=${s.sheafCohomology.topUniversalSymbol}`);
  // Trim to target tokens. If we're over budget, drop the lower-priority lines.
  let text = lines.join("\n");
  let tokens = estimateTokens(text);
  if (tokens > targetTokens) {
    // Drop from the END (lowest-priority signals first). Keep the header,
    // KEY INSIGHTS, and the first 8 signal lines.
    while (lines.length > 14 && tokens > targetTokens) {
      lines.splice(lines.length - 2, 1); // keep the last "recent:" line; drop second-to-last
      text = lines.join("\n");
      tokens = estimateTokens(text);
    }
  }
  return { text, tokens };
}

/**
 * EXP387 — KEY INSIGHTS: surface 3-5 actionable findings from the snapshot.
 *
 * Each insight is a one-line statement that the LLM can directly use to
 * make a decision. Insights are selected by:
 * 1. Severity (abnormal values: high complexity, high debt, broken sheaf,
 * sub-martingale drift, etc.).
 * 2. Fisher information (EXP324): signals that vary a lot across
 * codebases carry more information — they're more "actionable".
 * 3. Actionability: insights that suggest a concrete action
 * ("refactor X", "review Y", "fix Z").
 *
 * The user's directive: "the info we feed to the llm must be dynamically
 * updated in real time somehow, so that after many multi turns, it is
 * still relevant". The KEY INSIGHTS are the most-relevant subset, kept
 * in front of the LLM at every turn.
 */
function computeKeyInsights(s: AwarenessSnapshot): string[] {
  const insights: string[] = [];
  // Always include topos — it's the highest-Fisher signal (EXP324 + EXP344)
  // and the one the LLM missed in EXP372 (the 1/20 failure).
  if (s.topos) {
    const lem = s.topos.lemHoldsCount + s.topos.lemFailsCount;
    insights.push(`topos is ${s.topos.isIntuitionistic ? "INTUITIONISTIC (LEM fails for " + s.topos.lemFailsCount + "/" + lem + " modules — you CANNOT assume every property is provably true or false)" : "BOOLEAN (every module is decidable)"}`);
  }
  // Martingale debt — the codebase's debt trajectory is highly actionable.
  if (s.martingaleDebt && s.martingaleDebt.sampleCount >= 3) {
    const t = s.martingaleDebt;
    if (t.isSubMartingale) {
      insights.push(`debt is SUB-MARTINGALE (μ=${t.drift.toFixed(2)}/commit, p=${t.driftPValue}) — DRY violations are ACCUMULATING; schedule a refactor`);
    } else if (t.debtTrajectory === "paying-down") {
      insights.push(`debt is being PAID DOWN (μ=${t.drift.toFixed(2)}/commit) — refactoring is succeeding`);
    } else if (t.debtTrajectory === "steady") {
      insights.push(`debt is STEADY (μ=${t.drift.toFixed(2)}/commit, σ²=${t.variance.toFixed(2)}) — codebase is in maintenance mode`);
    }
  }
  // Fiedler bottleneck — the codebase has a clean bisection boundary.
  if (s.fiedlerBisection && s.fiedlerBisection.isBottleneck) {
    insights.push(`FIEDLER BOTTLENECK (λ2=${s.fiedlerBisection.fiedlerValue}) — clean bisection via ${s.fiedlerBisection.topBridgeModule} (${s.fiedlerBisection.bisectionSize} modules on one side)`);
  }
  // Chromatic number — the #1 refactor priority.
  if (s.chromaticNumber && s.chromaticNumber.cliqueNumber >= 4) {
    const top = s.chromaticNumber.topClique[0];
    if (top) {
      insights.push(`top clone clique size=${s.chromaticNumber.cliqueNumber} (start with ${shortFnName(top.filePath)}:${top.name}) — biggest "replace N functions with 1 factory" opportunity`);
    }
  }
  // Turing treadmills — stop refactoring these.
  if (s.turingTreadmills && s.turingTreadmills.hasActiveTreadmills) {
    const top = s.turingTreadmills.topTreadmills[0];
    if (top) {
      insights.push(`TREADMILL: ${shortFnName(top.filePath)} edited ${top.editCount}× in recent history — STOP refactoring it (TM model predicts it'll never settle)`);
    }
  }
  // Sheaf obstructions — broken imports.
  if (s.sheafCohomology && !s.sheafCohomology.isSheaf) {
    insights.push(`SHEAF BROKEN: ${s.sheafCohomology.h1Obstructions} unresolved intra-codebase imports — fix the broken gluings`);
  }
  // Pathological fraction — review top-complex.
  if (s.functionClassification && s.functionClassification.pathologicalFraction > 0.05) {
    insights.push(`pathological=${(s.functionClassification.pathologicalFraction * 100).toFixed(0)}% of functions (complexity >15) — review the topComplex list above`);
  }
  // Banach contraction — mathematical guarantee.
  if (s.banachContraction && s.banachContraction.isContraction) {
    insights.push(`banach contraction q=${s.banachContraction.meanContraction} — the canonical form EXISTS and is UNIQUE per clone family (${s.banachContraction.familyCount} families)`);
  }
  // Homology H1 — hidden DRY candidates.
  if (s.homology && s.homology.h1 > 0) {
    insights.push(`H₁=${s.homology.h1} hidden DRY candidates (triangles with a near-miss edge — Jaccard misses these)`);
  }
  // Function-stats idNum — the most-common parameter count (high Fisher, EXP324).
  // Include the mean function body length so the LLM can answer "what's the
  // average function size?" without finding the (often-trimmed) fnStats line.
  if (s.functionStats && (s.functionStats.idNumArity === 0 || s.functionStats.idNumArity === 1)) {
    insights.push(`fnStats: idNum arity=${s.functionStats.idNumArity} (most-common param count, ${s.functionStats.idNumHubCount} hub fns), mean length=${s.functionStats.meanLength} LOC, max=${s.functionStats.maxLength} LOC — use this when asked about function arity or body length`);
  }
  // Persistence β0 — the first Betti number (connected components in the
  // complexity point cloud). High β0 = many distinct complexity clusters.
  if (s.persistenceLandscapes && s.persistenceLandscapes.bettiNumbers.length > 0 && s.persistenceLandscapes.bettiNumbers[0]! > 0) {
    insights.push(`persistence β0=${s.persistenceLandscapes.bettiNumbers[0]} (first Betti number — the count of distinct complexity clusters; look at the \`persistence:\` line for β=[${s.persistenceLandscapes.bettiNumbers.join(",")}])`);
  }
  // Bell-clone isolated fraction (EXP340) — high Fisher signal, varies
  // significantly across codebases (0.43–0.84 in our 5 codebases).
  if (s.bellClones && s.bellClones.totalPairs > 5) {
    insights.push(`bellClones: ${s.bellClones.isolatedPairs}/${s.bellClones.totalPairs} isolated (${(s.bellClones.isolatedFraction * 100).toFixed(0)}%) — ${s.bellClones.isolatedFraction > 0.5 ? "MAJORITY are Bell-violated (pure copy-paste, no common witness)" : "minority are Bell-violated"}`);
  }
  // Cap at 8 insights (3-8 actionable findings — expanded to include the
  // high-Fisher signals the LLM missed when buried in the block: β0, idNum,
  // bellClones. The cap is 8 to keep the KEY INSIGHTS section scannable).
  return insights.slice(0, 8);
}

function estimateTokens(text: string): number {
  // GPT-style token estimate: chars / 4 (rounded up). Good enough for budget checks.
  return Math.ceil(text.length / 4);
}

function pct(num: number, denom: number): number {
  if (denom === 0) return 0;
  return Math.round((num / denom) * 100);
}

function shortName(name: string): string {
  // Take the last 2 path segments if the name is a path.
  const parts = name.split("/");
  if (parts.length <= 2) return name;
  return parts.slice(-2).join("/");
}

function shortFnName(name: string): string {
  // Take the last 2 path segments + name.
  const parts = name.split("/");
  if (parts.length <= 2) return name;
  return parts.slice(-2).join("/");
}
