/**
 * Multi-language signals (EXP357).
 *
 * Each signal is a pure function `(files, config, findings) → SignalValue[]`.
 * Signals aggregate per-codebase metrics dynamically computed from the
 * actual codebase at analysis time — no static values.
 *
 * Signal list:
 * 1. codebase-type-level — typed / untyped / mixed (from file extensions)
 * 2. quality-indication — issue density, test coverage proxy, debt proxy
 * 3. drift — version drift from manifests (package.json, Cargo.toml, etc.)
 * 4. architecture — module/file/function counts, hub modules, graph density
 * 5. entropy — Shannon + Rényi entropy of token distribution
 * 6. clone-stats — from the duplicate-body findings
 * 7. code-health — TODO density, empty-catch density, magic-number density
 * 8. complexity-distribution — p50/p90/p99/max complexity, long-function rate
 */

import type { ParsedFile, QualityConfig, SignalValue } from "./base.ts";

// ---------------------------------------------------------------------------
// 1. Codebase type level
// ---------------------------------------------------------------------------

export function signalCodebaseTypeLevel(
  files: readonly ParsedFile[],
  config: QualityConfig,
  _findings: readonly unknown[],
): readonly SignalValue[] {
  const counts = new Map<string, number>();
  for (const f of files) counts.set(f.language, (counts.get(f.language) ?? 0) + 1);
  const total = files.length || 1;
  const typed = (counts.get("typescript") ?? 0) + (counts.get("java") ?? 0) + (counts.get("rust") ?? 0) + (counts.get("go") ?? 0);
  const untyped = (counts.get("javascript") ?? 0) + (counts.get("python") ?? 0) + (counts.get("c") ?? 0) + (counts.get("cpp") ?? 0);
  // R47: threshold moved to config (was a hardcoded 0.7 — a static value in
  // a module whose header claims "no static values").
  const typedFraction = config.thresholds.codebaseTypeLevelFraction;
  let level: string;
  if (typed / total > typedFraction) level = "typed";
  else if (untyped / total > typedFraction) level = "untyped";
  else level = "mixed";
  return [
    {
      id: "codebase-type-level",
      name: "codebase_type_level",
      value: level,
      unit: null,
      description: `Dominant language typing (${typed} typed, ${untyped} untyped, ${total} total)`,
    },
    {
      id: "codebase-type-level",
      name: "typed_file_fraction",
      value: Number((typed / total).toFixed(3)),
      unit: "ratio",
      description: "Fraction of files in a statically-typed language",
    },
  ];
}

// ---------------------------------------------------------------------------
// 2. Quality indication
// ---------------------------------------------------------------------------

export function signalQualityIndication(
  files: readonly ParsedFile[],
  _config: QualityConfig,
  findings: readonly { checkId: string }[],
): readonly SignalValue[] {
  const totalLoc = files.reduce((s, f) => s + f.loc, 0) || 1;
  const issueDensity = findings.length / (totalLoc / 1000);
  const testFiles = files.filter((f) => /test|spec|_test|tests|__tests__/.test(f.path)).length;
  const sourceFiles = files.length - testFiles || 1;
  const testToSourceRatio = testFiles / sourceFiles;
  // Debt proxy: complexity hotspots + dead code + duplicate bodies per KLOC
  const debtFindings = findings.filter((f) =>
    f.checkId === "complexity-hotspot" || f.checkId === "dead-code" || f.checkId === "duplicate-body",
  );
  const debtDensity = debtFindings.length / (totalLoc / 1000);
  return [
    {
      id: "quality-indication",
      name: "issue_density",
      value: Number(issueDensity.toFixed(2)),
      unit: "issues/KLOC",
      description: "Findings per KLOC across all enabled checks",
    },
    {
      id: "quality-indication",
      name: "test_to_source_ratio",
      value: Number(testToSourceRatio.toFixed(3)),
      unit: "ratio",
      description: "Test files / source files (test coverage proxy)",
    },
    {
      id: "quality-indication",
      name: "debt_density",
      value: Number(debtDensity.toFixed(2)),
      unit: "debt/KLOC",
      description: "Complexity + dead-code + duplicate-body findings per KLOC",
    },
  ];
}

// ---------------------------------------------------------------------------
// 3. Drift (from manifest files if present)
// ---------------------------------------------------------------------------

export function signalDrift(
  files: readonly ParsedFile[],
  _config: QualityConfig,
  _findings: readonly unknown[],
): readonly SignalValue[] {
  let packageJsonCount = 0;
  let cargoTomlCount = 0;
  let pyprojectCount = 0;
  let goModCount = 0;
  let versionRangeCount = 0;
  let caretRangeCount = 0;
  let tildeRangeCount = 0;
  let exactPinCount = 0;
  for (const f of files) {
    if (f.path.endsWith("package.json")) {
      packageJsonCount += 1;
      // Inspect dependencies for version ranges
      const m = f.content.match(/"dependencies"[\s\S]*?"}/);
      if (m) {
        const ranges = m[0].match(/"[^"]+"\s*:\s*"([^"]+)"/g) ?? [];
        for (const r of ranges) {
          const ver = r.match(/:\s*"([^"]+)"/)?.[1] ?? "";
          if (ver.startsWith("^")) caretRangeCount += 1;
          else if (ver.startsWith("~")) tildeRangeCount += 1;
          else if (ver.match(/^\d/)) exactPinCount += 1;
          versionRangeCount += 1;
        }
      }
    }
    if (f.path.endsWith("Cargo.toml")) cargoTomlCount += 1;
    if (f.path.endsWith("pyproject.toml")) pyprojectCount += 1;
    if (f.path.endsWith("go.mod")) goModCount += 1;
  }
  return [
    {
      id: "drift",
      name: "package_json_files",
      value: packageJsonCount,
      unit: "count",
      description: "Number of package.json manifest files (drift surface)",
    },
    {
      id: "drift",
      name: "cargo_toml_files",
      value: cargoTomlCount,
      unit: "count",
      description: "Number of Cargo.toml manifest files",
    },
    {
      id: "drift",
      name: "pyproject_files",
      value: pyprojectCount,
      unit: "count",
      description: "Number of pyproject.toml manifest files",
    },
    {
      id: "drift",
      name: "go_mod_files",
      value: goModCount,
      unit: "count",
      description: "Number of go.mod manifest files",
    },
    {
      id: "drift",
      name: "caret_range_count",
      value: caretRangeCount,
      unit: "count",
      description: "Dependencies pinned with ^ (semver-compatible range)",
    },
    {
      id: "drift",
      name: "exact_pin_count",
      value: exactPinCount,
      unit: "count",
      description: "Dependencies pinned exactly (no range)",
    },
  ];
}

// ---------------------------------------------------------------------------
// 4. Architecture signals
// ---------------------------------------------------------------------------

export function signalArchitecture(
  files: readonly ParsedFile[],
  config: QualityConfig,
  _findings: readonly unknown[],
): readonly SignalValue[] {
  const totalSymbols = files.reduce((s, f) => s + f.symbols.length, 0);
  const totalImports = files.reduce((s, f) => s + f.imports.length, 0);
  const totalExports = files.reduce((s, f) => s + f.exports.length, 0);
  // Hub modules: files most imported by others (in-degree in import graph)
  const importCounts = new Map<string, number>();
  for (const f of files) {
    // Approximate: each import edge contributes to its source's "imported-from" count.
    for (const imp of f.imports) {
      const lastSeg = imp.source.split(/[/.]/).pop() ?? imp.source;
      if (lastSeg) importCounts.set(lastSeg, (importCounts.get(lastSeg) ?? 0) + 1);
    }
  }
  // R47: top-hub count moved to config (was a hardcoded 5).
  const topHubCount = config.thresholds.topHubModuleCount;
  const topHubs = [...importCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, topHubCount);
  const graphDensity = files.length > 1 ? totalImports / (files.length * (files.length - 1)) : 0;
  const exportedFraction = totalSymbols > 0 ? totalExports / totalSymbols : 0;
  return [
    {
      id: "architecture",
      name: "file_count",
      value: files.length,
      unit: "count",
      description: "Total source files scanned",
    },
    {
      id: "architecture",
      name: "symbol_count",
      value: totalSymbols,
      unit: "count",
      description: "Total functions/classes/structs/etc. detected",
    },
    {
      id: "architecture",
      name: "import_count",
      value: totalImports,
      unit: "count",
      description: "Total import statements",
    },
    {
      id: "architecture",
      name: "export_count",
      value: totalExports,
      unit: "count",
      description: "Total exported symbols",
    },
    {
      id: "architecture",
      name: "graph_density",
      value: Number(graphDensity.toFixed(4)),
      unit: "ratio",
      description: "Import graph density (edges / possible edges)",
    },
    {
      id: "architecture",
      name: "exported_fraction",
      value: Number(exportedFraction.toFixed(3)),
      unit: "ratio",
      description: "Fraction of symbols marked exported",
    },
    {
      id: "architecture",
      name: "top_hub_modules",
      value: topHubs.map(([name, count]) => `${name}:${count}`),
      unit: null,
      description: "Top 5 modules by import in-degree (hub modules)",
    },
  ];
}

// ---------------------------------------------------------------------------
// 5. Entropy signals (Shannon + Rényi spectrum)
// ---------------------------------------------------------------------------

export function signalEntropy(
  files: readonly ParsedFile[],
  _config: QualityConfig,
  _findings: readonly unknown[],
): readonly SignalValue[] {
  // Token distribution: split all file content on whitespace + punctuation.
  const counts = new Map<string, number>();
  let total = 0;
  for (const f of files) {
    const tokens = f.content.split(/[\s{}()[\];,:.]+/);
    for (const t of tokens) {
      if (!t || t.length < 2) continue;
      counts.set(t, (counts.get(t) ?? 0) + 1);
      total += 1;
    }
  }
  if (total === 0) {
    return [
      {
        id: "entropy",
        name: "shannon_entropy",
        value: 0,
        unit: "bits",
        description: "Shannon entropy of token distribution (no tokens)",
      },
    ];
  }
  let shannon = 0;
  for (const c of counts.values()) {
    const p = c / total;
    shannon -= p * Math.log2(p);
  }
  // Rényi entropy of order α: H_α = (1/(1-α)) log_2( sum p^α )
  const renyi = (alpha: number): number => {
    let sum = 0;
    for (const c of counts.values()) {
      const p = c / total;
      sum += Math.pow(p, alpha);
    }
    return Math.log2(sum) / (1 - alpha);
  };
  return [
    {
      id: "entropy",
      name: "shannon_entropy",
      value: Number(shannon.toFixed(3)),
      unit: "bits",
      description: "Shannon entropy of token distribution",
    },
    {
      id: "entropy",
      name: "renyi_entropy_alpha_2",
      value: Number(renyi(2).toFixed(3)),
      unit: "bits",
      description: "Rényi entropy of order 2 (collision entropy)",
    },
    {
      id: "entropy",
      name: "renyi_entropy_alpha_inf",
      value: Number(renyi(Infinity).toFixed(3)),
      unit: "bits",
      description: "Rényi entropy of order ∞ (min-entropy)",
    },
    {
      id: "entropy",
      name: "unique_token_fraction",
      value: Number((counts.size / total).toFixed(4)),
      unit: "ratio",
      description: "Unique tokens / total tokens (lexical diversity)",
    },
  ];
}

// ---------------------------------------------------------------------------
// 6. Clone statistics (from duplicate-body findings)
// ---------------------------------------------------------------------------

export function signalCloneStats(
  _files: readonly ParsedFile[],
  _config: QualityConfig,
  findings: readonly { checkId: string; extra: Readonly<Record<string, string | number | string[] | null>> }[],
): readonly SignalValue[] {
  const clones = findings.filter((f) => f.checkId === "duplicate-body");
  // Group clones into families by otherFile
  const families = new Map<string, number>();
  for (const c of clones) {
    const otherFile = String(c.extra.otherFile ?? "");
    families.set(otherFile, (families.get(otherFile) ?? 0) + 1);
  }
  const largestFamily = families.size > 0 ? Math.max(...families.values()) : 0;
  return [
    {
      id: "clone-stats",
      name: "clone_pair_count",
      value: clones.length,
      unit: "count",
      description: "Number of duplicate-body finding pairs",
    },
    {
      id: "clone-stats",
      name: "clone_family_count",
      value: families.size,
      unit: "count",
      description: "Number of distinct clone families (by target file)",
    },
    {
      id: "clone-stats",
      name: "largest_clone_family",
      value: largestFamily,
      unit: "count",
      description: "Size of the largest clone family",
    },
  ];
}

// ---------------------------------------------------------------------------
// 7. Code-health summary
// ---------------------------------------------------------------------------

export function signalCodeHealth(
  files: readonly ParsedFile[],
  _config: QualityConfig,
  findings: readonly { checkId: string }[],
): readonly SignalValue[] {
  const totalLoc = files.reduce((s, f) => s + f.loc, 0) || 1;
  const todoCount = findings.filter((f) => f.checkId === "todo-comment").length;
  const emptyCatchCount = findings.filter((f) => f.checkId === "empty-catch").length;
  const magicCount = findings.filter((f) => f.checkId === "magic-number").length;
  const missingDefaultCount = findings.filter((f) => f.checkId === "missing-default-case").length;
  return [
    {
      id: "code-health",
      name: "todo_density",
      value: Number((todoCount / (totalLoc / 1000)).toFixed(2)),
      unit: "TODO/KLOC",
      description: "TODO/FIXME comments per KLOC",
    },
    {
      id: "code-health",
      name: "empty_catch_density",
      value: Number((emptyCatchCount / (totalLoc / 1000)).toFixed(2)),
      unit: "emptyCatch/KLOC",
      description: "Empty catch blocks per KLOC",
    },
    {
      id: "code-health",
      name: "magic_number_density",
      value: Number((magicCount / (totalLoc / 1000)).toFixed(2)),
      unit: "magicNum/KLOC",
      description: "Magic numbers per KLOC",
    },
    {
      id: "code-health",
      name: "missing_default_count",
      value: missingDefaultCount,
      unit: "count",
      description: "Switch/match statements missing a default arm",
    },
  ];
}

// ---------------------------------------------------------------------------
// 8. Complexity distribution
// ---------------------------------------------------------------------------

export function signalComplexityDistribution(
  files: readonly ParsedFile[],
  config: QualityConfig,
  _findings: readonly unknown[],
): readonly SignalValue[] {
  const all: number[] = [];
  for (const f of files) {
    for (const sym of f.symbols) all.push(sym.cyclomaticComplexity);
  }
  if (all.length === 0) {
    return [
      {
        id: "complexity-distribution",
        name: "mean_complexity",
        value: 0,
        unit: "score",
        description: "Mean cyclomatic complexity (no symbols)",
      },
    ];
  }
  all.sort((a, b) => a - b);
  const pct = (p: number): number => all[Math.min(all.length - 1, Math.floor(all.length * p))] ?? 0;
  const mean = all.reduce((s, v) => s + v, 0) / all.length;
  const hotspotThreshold = config.thresholds.complexityHotspot;
  const hotspotCount = all.filter((v) => v >= hotspotThreshold).length;
  return [
    {
      id: "complexity-distribution",
      name: "mean_complexity",
      value: Number(mean.toFixed(2)),
      unit: "score",
      description: "Mean cyclomatic complexity across all symbols",
    },
    {
      id: "complexity-distribution",
      name: "p50_complexity",
      value: pct(0.5),
      unit: "score",
      description: "50th percentile cyclomatic complexity",
    },
    {
      id: "complexity-distribution",
      name: "p90_complexity",
      value: pct(0.9),
      unit: "score",
      description: "90th percentile cyclomatic complexity",
    },
    {
      id: "complexity-distribution",
      name: "p99_complexity",
      value: pct(0.99),
      unit: "score",
      description: "99th percentile cyclomatic complexity",
    },
    {
      id: "complexity-distribution",
      name: "max_complexity",
      value: all[all.length - 1] ?? 0,
      unit: "score",
      description: "Maximum cyclomatic complexity",
    },
    {
      id: "complexity-distribution",
      name: "hotspot_fraction",
      value: Number((hotspotCount / all.length).toFixed(4)),
      unit: "ratio",
      description: `Fraction of symbols with complexity ≥ ${hotspotThreshold}`,
    },
  ];
}
