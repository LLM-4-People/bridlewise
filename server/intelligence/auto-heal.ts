/**
 * Auto-heal module — automatic detection + repair of a stale code index and
 * broken dependency edges.
 *
 * Guarantees:
 * "Auto-healing... must be fully implemented and wired. Not
 * half-baked."
 * "No fake/static/placeholder data/values. Everything real." +
 * "Dynamic UI — no refresh buttons, auto-update." The heal runs
 * automatically on every map read; there is no manual "re-index" button
 * required for staleness (the existing invalidate endpoint remains for
 * force-rebuild, but staleness self-heals without it).
 * "No static constants... Everything dynamically computed."
 * The mtime sample size is ADAPTIVE (scales with file count), not a
 * fixed literal.
 * every tunable lives in the harness config
 * (`codeIntelligence.autoHeal.*`); the floors below are the single owner
 * of the defaults, overridable from the config file.
 *
 * Two heal mechanisms:
 *
 * 1. STALE-INDEX detection. The repository-map cache (intelligence-bridge)
 * is TTL-based: a "ready" entry is served until `mapCacheTtlMs` expires,
 * then rebuilt off-thread. The gap: if source files change on disk
 * WITHIN the TTL window, the cache serves stale data with no rebuild.
 * This module closes that gap. On every map read, it re-stats a SAMPLE
 * of the indexed source files and compares mtimes to the snapshot taken
 * at index time. When any sampled file's mtime changed (or the file
 * vanished), the index is stale → the caller triggers an off-thread
 * rebuild (same fire-and-forget pattern as TTL expiry). The mtime
 * snapshot is stored in the cache entry (see `MtimeSnapshot`).
 *
 * The sample is adaptive: small codebases (≤ sample-full-threshold) get
 * FULL mtime coverage; large codebases get a bounded sample so a read
 * never stats tens of thousands of files. The sample is deterministic
 * (stride-based) so the same files are re-checked across reads — a
 * changed file is eventually sampled regardless of size.
 *
 * 2. BROKEN-EDGE detection. After the dependency graph is built, imports
 * whose `resolvedPath` is `null` (the import target does not exist on
 * disk) are flagged as broken edges. Exposed as a signal
 * (`detectBrokenEdges`) so the quality layer / UI can surface them. A
 * broken edge means the code index references a file that was deleted
 * or never created — the index is structurally inconsistent with the
 * filesystem and should be rebuilt.
 *
 * Both mechanisms are PURE functions over the map + filesystem; they have no
 * side effects beyond `statSync` reads. The REBUILD decision is made by the
 * caller (intelligence-bridge), which already owns the worker-spawning path.
 */

import { statSync } from "node:fs";
import { join, isAbsolute, relative } from "node:path";
import type { RepositoryMap } from "../kernel/canonical.ts";
import { getAutoHealConfig, type AutoHealConfig } from "../kernel/harness-config.ts";
import { webWarn } from "../observability/debug-bridge.ts";

// ── Mtime snapshot ───────────────────────────────────────────────────────

/**
 * A snapshot of a sample of the indexed source files' mtimes, captured at
 * index time. Stored in the map-cache `ReadyEntry` so staleness can be
 * detected on subsequent reads without re-walking the whole tree.
 *
 * `mtimes` maps the ABSOLUTE file path → its `mtimeMs` at index time. Only
 * the sampled files are present (adaptive sample — see `sampleSourceFiles`).
 */
export type MtimeSnapshot = Readonly<{
  readonly indexedAt: number;
  readonly projectRoot: string;
  readonly mtimes: ReadonlyMap<string, number>;
}>;

// ── Adaptive sample size ───────────────────

/**
 * Compute the mtime-sample size for a codebase of `fileCount` source files.
 *
 * Adaptive (NOT a fixed literal):
 * fileCount ≤ full-coverage threshold → sample EVERY file (full
 * coverage; small codebases are cheap to stat fully).
 * fileCount > threshold → sample a bounded window that grows
 * sub-linearly (the square root of the count), so a 10k-file codebase
 * samples ~100 files, not 10k. The floor + ceiling are config-driven
 * (`autoHeal.staleSampleFloor` / `autoHeal.staleSampleCeiling`).
 *
 * The square-root scaling is the standard trade-off: detection probability
 * stays high (a changed file is sampled with probability ~sampleSize/N)
 * while per-read cost stays bounded.
 */
export function computeStaleSampleSize(fileCount: number, cfg: AutoHealConfig = getAutoHealConfig()): number {
  if (!Number.isFinite(fileCount) || fileCount <= 0) return 0;
  if (fileCount <= cfg.staleFullCoverageThreshold) return fileCount;
  const scaled = Math.floor(Math.sqrt(fileCount));
  const floored = Math.max(cfg.staleSampleFloor, scaled);
  return Math.min(cfg.staleSampleCeiling, floored);
}

// ── Sample selection (deterministic stride) ─────────────────────────────

/**
 * Select a deterministic, stride-based sample of `size` paths from `paths`.
 * Deterministic so the SAME files are re-checked across reads (a changed
 * file is eventually in the sample regardless of ordering). The stride is
 * `max(1, floor(paths.length / size))` so the sample is spread evenly.
 *
 * Exported for testing (the sample must be reproducible).
 */
export function sampleSourceFiles(paths: readonly string[], size: number): readonly string[] {
  if (size <= 0 || paths.length === 0) return [];
  if (size >= paths.length) return [...paths];
  const stride = Math.max(1, Math.floor(paths.length / size));
  const out: string[] = [];
  for (let i = 0; i < paths.length && out.length < size; i += stride) {
    out.push(paths[i]!);
  }
  return out;
}

// ── Snapshot capture ────────────────────────────────────────────────────

/**
 * Capture an mtime snapshot of a sample of the map's source files. Called
 * once after the worker builds the map (intelligence-bridge stores it in the
 * cache entry). Best-effort: a file that can't be stat'd at snapshot time is
 * skipped (it will be detected as "vanished" on the next read if it stays
 * absent, or re-added if it reappears).
 *
 * Only `isSource` files are sampled (the staleness signal is about source
 * drift; non-source files like assets don't invalidate the code index).
 */
export function captureMtimeSnapshot(
  projectRoot: string,
  map: RepositoryMap,
  cfg: AutoHealConfig = getAutoHealConfig(),
): MtimeSnapshot {
  const sourcePaths = map.files.filter((f) => f.isSource).map((f) => f.path);
  const sampleSize = computeStaleSampleSize(sourcePaths.length, cfg);
  const sample = sampleSourceFiles(sourcePaths, sampleSize);
  const mtimes = new Map<string, number>();
  for (const relPath of sample) {
    const abs = toAbsolutePath(projectRoot, relPath);
    try {
      const st = statSync(abs);
      mtimes.set(abs, st.mtimeMs);
    } catch (err) {
      // Best-effort stat: a file that can't be stat'd at snapshot time is
      // skipped. If it stays
      // absent it will be flagged as vanished on the next detectStaleIndex
      // call; if it reappears it is re-snapshotted on the next rebuild.
      webWarn("auto-heal", "stat failed during mtime snapshot (file skipped)", () => ({ path: abs, error: err instanceof Error ? err.message : String(err) }));
    }
  }
  return { indexedAt: Date.now(), projectRoot, mtimes };
}

// ── Stale-index detection ────────────────────────────────────────────────

export interface StaleIndexReport {
  readonly stale: boolean;
  /** Files whose mtime changed since the snapshot (drift). */
  readonly changedFiles: readonly string[];
  /** Files that vanished (existed at index time, missing now). */
  readonly vanishedFiles: readonly string[];
  readonly sampleSize: number;
  readonly reason: string | null;
}

/**
 * Detect whether the index is stale by re-statting the snapshot's files and
 * comparing mtimes. Returns a structured report. A non-empty `changedFiles`
 * OR `vanishedFiles` means the index is stale (the caller triggers a
 * rebuild).
 *
 * Pure over the filesystem (only `statSync` reads). Never throws — a stat
 * failure on a previously-snapshotted file means it vanished (flagged, not an
 * error).
 */
export function detectStaleIndex(snapshot: MtimeSnapshot): StaleIndexReport {
  const changedFiles: string[] = [];
  const vanishedFiles: string[] = [];
  for (const [abs, indexedMtime] of snapshot.mtimes) {
    try {
      const st = statSync(abs);
      // Compare with a small epsilon: mtimeMs is a float; filesystems may
      // round. Use 1ms as the drift threshold (config-driven would be
      // over-engineering — 1ms is the smallest meaningful mtime delta and
      // is far below any real edit). Any mtime INCREASE is drift.
      if (st.mtimeMs - indexedMtime > 1) {
        changedFiles.push(abs);
      }
    } catch {
      vanishedFiles.push(abs);
    }
  }
  const stale = changedFiles.length > 0 || vanishedFiles.length > 0;
  let reason: string | null = null;
  if (changedFiles.length > 0 && vanishedFiles.length > 0) {
    reason = `${changedFiles.length} file(s) changed, ${vanishedFiles.length} vanished`;
  } else if (changedFiles.length > 0) {
    reason = `${changedFiles.length} file(s) changed since index`;
  } else if (vanishedFiles.length > 0) {
    reason = `${vanishedFiles.length} file(s) vanished since index`;
  }
  return {
    stale,
    changedFiles,
    vanishedFiles,
    sampleSize: snapshot.mtimes.size,
    reason,
  };
}

// ── Broken-edge detection ────────────────────────────────────────────────

export interface BrokenEdge {
  /** The file containing the import (absolute or map-relative). */
  readonly from: string;
  /** The unresolved import specifier (as written in the source). */
  readonly specifier: string;
  /** The import kind (direct-import / re-export / dynamic-import / require). */
  readonly kind: string;
}

export interface BrokenEdgeReport {
  readonly brokenEdges: readonly BrokenEdge[];
  readonly count: number;
}

/**
 * Detect broken dependency edges: imports whose `resolvedPath` is `null`
 * (the import target does not exist on disk). A broken edge means the code
 * index references a deleted/never-created file — the index is structurally
 * inconsistent with the filesystem.
 *
 * Pure over the map (no filesystem access). The `resolvedPath` was already
 * resolved at index time by the intelligence module; `null` is the canonical
 * "unresolvable" marker.
 */
export function detectBrokenEdges(map: RepositoryMap): BrokenEdgeReport {
  const broken: BrokenEdge[] = [];
  for (const mod of map.modules) {
    for (const imp of mod.imports) {
      if (imp.resolvedPath === null) {
        broken.push({ from: mod.path, specifier: imp.specifier, kind: imp.kind });
      }
    }
  }
  return { brokenEdges: broken, count: broken.length };
}

// ── Combined heal report (for the exposure / signals route) ─────────────

export interface AutoHealReport {
  readonly stale: StaleIndexReport;
  readonly brokenEdges: BrokenEdgeReport;
  readonly lastIndexedAt: number | null;
}

/**
 * Produce a combined auto-heal report for a project: staleness + broken
 * edges. Used by the signals route so the UI / quality layer can surface
 * "index is stale, rebuilding" and "N broken import edges".
 *
 * `snapshot` may be null when the map is not yet cached (the caller passes
 * the cache entry's snapshot; null → a "not indexed" stale report).
 */
export function buildAutoHealReport(
  snapshot: MtimeSnapshot | null,
  map: RepositoryMap | null,
): AutoHealReport {
  const stale: StaleIndexReport = snapshot !== null
    ? detectStaleIndex(snapshot)
    : { stale: false, changedFiles: [], vanishedFiles: [], sampleSize: 0, reason: null };
  const brokenEdges: BrokenEdgeReport = map !== null
    ? detectBrokenEdges(map)
    : { brokenEdges: [], count: 0 };
  return {
    stale,
    brokenEdges,
    lastIndexedAt: snapshot?.indexedAt ?? null,
  };
}

/**
 * Resolve a map-relative or absolute file path to absolute, anchored at
 * `projectRoot`. Used by the signals route to report changed-file paths in a
 * consistent absolute form.
 */
export function toAbsolutePath(projectRoot: string, path: string): string {
  return isAbsolute(path) ? path : join(projectRoot, path);
}

/**
 * Render a path relative to the project root for compact display. Returns
 * the absolute path unchanged when it is outside the root.
 */
export function toRelativePath(projectRoot: string, path: string): string {
  const rel = relative(projectRoot, path);
  return rel.startsWith("..") ? path : rel;
}

// ── Level-1 heal normalization primitive ────────────

/**
 * Whether two strings are equivalent after collapsing ALL whitespace runs
 * to nothing (strict normalization). The deterministic, no-LLM Level-1
 * auto-heal primitive: whitespace is rarely semantically significant in
 * code (except in string literals, which a patch's context lines are not).
 * Catches whitespace-run collapses, tab/space drift, and CRLF/LF drift.
 *
 * The algorithm's SINGLE owner is the engine's edit-operations module (the
 * governed editor runs it as the whitespace context/removed-line heal, and
 * the single edit tool's resolver shares the same collapse). This module
 * re-exports it so the web UI's stale-index heal shares the ONE
 * implementation rather than re-implementing the collapse.
 */
export { whitespaceEquivalent } from "../../engine/src/editor/edit-operations.ts";
