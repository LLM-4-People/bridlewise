/**
 * Drift signal: schema-version drift and dependency drift.
 *
 * Computed from the actual manifest files present in the codebase:
 * - `package.json` (Node): schema version (the `"version"` field),
 * dependency drift = number of dependencies changed in the last
 * `gitHistoryDepth` commits.
 * - `Cargo.toml` (Rust), `go.mod` (Go), `pyproject.toml`/`setup.py`
 * (Python): same idea.
 *
 * If git is unavailable, dependency drift is computed from the manifest
 * file's mtime age (older = more drift, linearly).
 *
 * No hardcoded "expected" schema versions — the schema version is
 * whatever the manifest declares. Drift is measured in DEPENDENCY
 * CHANGES, not version-string distance.
 */
import type { SignalContext } from "../types.ts";
import { bestEffort } from "../../shared/best-effort.ts";

const MANIFEST_FILES = ["package.json", "Cargo.toml", "go.mod", "pyproject.toml", "setup.py", "requirements.txt", "Gemfile", "mix.exs"] as const;

export function computeDrift(ctx: SignalContext) {
  let schemaVersion: string | null = null;
  let manifestPath: string | null = null;
  for (const name of MANIFEST_FILES) {
    const content = ctx.readFile(name);
    if (content === null) continue;
    manifestPath = name;
    schemaVersion = extractVersion(content, name) ?? schemaVersion;
    if (schemaVersion) break;
  }
  if (manifestPath === null) {
    return { drift: { schemaVersion: null, dependencyDrift: 0, changedDependencyFiles: [] } };
  }
  // Dependency drift from git history: count of commits in the last
  // `gitHistoryDepth` commits that touched any manifest file.
  const recentCommits = ctx.gitHistory.slice(0, ctx.config.thresholds.gitHistoryDepth);
  const changed = recentCommits.filter(c => c.changedFiles.some(f => MANIFEST_FILES.includes(f.replace(/^.*\//, "") as typeof MANIFEST_FILES[number])));
  const dependencyDrift = changed.length;
  const changedDependencyFiles = unique(changed.flatMap(c => c.changedFiles.filter(f => MANIFEST_FILES.includes(f.replace(/^.*\//, "") as typeof MANIFEST_FILES[number]))));
  return {
    drift: {
      schemaVersion,
      dependencyDrift,
      changedDependencyFiles,
    },
  };
}

function extractVersion(content: string, name: string): string | null {
  if (name === "package.json") {
    const j = bestEffort(() => JSON.parse(content) as { version?: unknown });
    if (j !== undefined && typeof j.version === "string") return j.version;
    return null;
  }
  if (name === "Cargo.toml") {
    const m = /^version\s*=\s*"([^"]+)"/m.exec(content);
    if (m) return m[1]!;
    return null;
  }
  if (name === "go.mod") {
    const m = /^module\s+(\S+)/m.exec(content);
    if (m) return m[1]!;
    return null;
  }
  if (name === "pyproject.toml") {
    const m = /^version\s*=\s*"([^"]+)"/m.exec(content);
    if (m) return m[1]!;
    return null;
  }
  if (name === "setup.py") {
    const m = /version\s*=\s*"([^"]+)"/m.exec(content);
    if (m) return m[1]!;
    return null;
  }
  return null;
}

function unique<T>(arr: readonly T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of arr) { if (!seen.has(x)) { seen.add(x); out.push(x); } }
  return out;
}
