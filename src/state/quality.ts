/**
 * nanostores shared state: the latest codebase quality snapshot.
 *
 * Fed ONLY by client.ts (setQualitySnapshot) from the "quality" SSE event
 * the server emits after each LLM run. Any panel can read
 * `qualitySnapshot` to show real-time quality feedback without a manual
 * refresh. Plain.ts — Node-testable via Vitest.
 */

import { atom, type WritableAtom } from "nanostores";

import { registerReset, registerContextReset } from "./store-registry";

/** Per-category issue counts the server ranks highest. */
export type QualityCategoryCount = Readonly<{ category: string; count: number }>;

/** Cyclomatic-complexity distribution across the project's functions. */
export type QualityComplexity = Readonly<{
  mean: number;
  median: number;
  p95: number;
  max: number;
  hotspotCount: number;
}>;

/** How much of the project carries type annotations. */
export type QualityTypeLevel = Readonly<{
  level: string;
  typedFileFraction: number;
  typedParameterFraction: number;
}>;

/** Duplicate-code family statistics. */
export type QualityCloneStats = Readonly<{
  cloneGroupCount: number;
  clonedFunctionCount: number;
  cloneRatio: number;
}>;

/**
 * Which sub-metrics the server ACTUALLY measured for this snapshot. A
 * `false` flag means the corresponding numeric fields are placeholders —
 * panels must show "not measured" (never a fabricated figure) for them.
 */
export type QualityMeasuredFlags = Readonly<{
  quality: boolean;
  complexity: boolean;
  clones: boolean;
  typeLevel: boolean;
}>;

/**
 * The codebase quality snapshot the server emits on the `quality` SSE
 * event.
 *
 * This type mirrors the server's `QualityIndicator` (server/quality-bridge
 * .ts) in FULL. It used to declare only five of the fourteen fields the
 * server sends, so the client's ingest silently discarded the other nine —
 * the server computed complexity, clone, type-level and size figures on
 * every run and they died at the wire. The fields are optional here only
 * because the failure payload (`error`/`message`) carries none of them;
 * a successful snapshot carries them all.
 */
export type QualitySnapshot = Readonly<{
  readonly runId?: string;
  readonly overallScore: number;
  readonly grade: string;
  readonly totalIssues: number;
  readonly issuesPerKloc: number;
  readonly recommendations: readonly string[];
  /** Issues per source file (the server's raw density figure). */
  readonly issueDensity?: number;
  /** The issue categories with the highest counts, server-ranked. */
  readonly topCategories?: readonly QualityCategoryCount[];
  /** Complexity distribution; `null` when the analyzer produced none. */
  readonly complexity?: QualityComplexity | null;
  /** Type-annotation coverage; `null` when not measured. */
  readonly typeLevel?: QualityTypeLevel | null;
  /** Clone/duplication statistics; `null` when not measured. */
  readonly cloneStats?: QualityCloneStats | null;
  /** Files in the repository map. */
  readonly fileCount?: number;
  /** Functions the awareness pass found. */
  readonly functionCount?: number;
  /** Total lines of code. */
  readonly totalLoc?: number;
  /** Modules the awareness pass found. */
  readonly moduleCount?: number;
  /** Which sub-metrics were actually measured (absent on failure payloads). */
  readonly measured?: QualityMeasuredFlags;
  readonly error?: string;
  readonly message?: string;
}>;

export const qualitySnapshot: WritableAtom<QualitySnapshot | null> = atom<QualitySnapshot | null>(null);

export function setQualitySnapshot(snapshot: QualitySnapshot | null): void {
  qualitySnapshot.set(snapshot);
}

/**
 * Reset the quality store to null. Called by the single store-reset owner
 * (`resetAllStores`) on logout so a re-login as a DIFFERENT user does not
 * briefly see the previous user's quality snapshot (SPO).
 */
export function resetQuality(): void {
  qualitySnapshot.set(null);
}

registerReset("quality", resetQuality);
// Auto-reset on chat switch: the store self-registers so the chat-change
// signal resets it automatically (no manual call in the chat-switch
// handler). Adding this line = the store resets on chat switch without
// any handler code — the DYNAMIC "forgetting is impossible" pattern.
registerContextReset("quality", resetQuality);
