import {
  type BandaidConfig,
  type BandaidPattern,
  type BandaidSeverity,
  type BandaidPatternCategory,
} from "./bandaid-config.ts";
import { detectStructuralBandaids, type StructuralFinding } from "./bandaid-ast-detector.ts";

/**
 * Bandaid detector — the fix does not address the root cause.
 *
 * EXP432 (2026-07-21) replaces EXP408's static-keyword regex list with a
 * three-layer keyword-free detector (user directive: "static values like
 * that are prohibited app-wide"):
 *
 * L1 — STRUCTURAL (AST, keyword-free, `bandaid-ast-detector.ts`):
 * empty/comment-only catch, `as any` / `<any>x` type assertion, null
 * guard at the symptom, unused catch binding. Detected by AST node
 * TYPE, not by string matching. No hardcoded patterns.
 * L2 — LEARNED (codebase-mined, keyword-free, `bandaid-pattern-learner.ts`):
 * suppression pragmas + deferred-fix markers are MINED from the
 * codebase and passed to the detector via `learnedSuppressionPragmas`
 * / `learnedDeferredMarkers` in the config. The detector compiles the
 * learned regexes and matches them against comments in the edit. No
 * static keyword list.
 * L3 — ROOT-CAUSE CONTAINMENT (keyword-free, PRIMARY): when a
 * `knownRootCauseFix` is provided with an edit, the detector compares
 * the edit's tokens to the root-cause-fix tokens (containment); if
 * the overlap is below `bandaidMinRootCauseOverlap`, the edit is
 * flagged as a bandaid (root cause not addressed) even if no
 * structural/learned pattern matches.
 *
 * Optional user-config patterns (`bandaidPatterns`) are still honored (a
 * user may add project-specific bandaid signatures via config — that is
 * CONFIG, not a hardcoded source list). The DEFAULT config has none.
 *
 * Integration: `recordEdit` wraps every model edit. The editor rejects
 * bandaids by reading the `BandaidFinding[]` from `detect`.
 */
export type EditEvent = Readonly<{
  turn: number;
  filePath: string;
  /** Lines added by the edit (the LLM's inserted code). */
  addedLines: readonly string[];
  /** Lines removed by the edit (for context; not scanned). */
  removedLines: readonly string[];
  /** Optional root-cause hint supplied by the quality pack or the harness. */
  rootCauseHint?: string | undefined;
  /** Optional canonical root-cause fix. When provided, the edit must address it. */
  knownRootCauseFix?: string | undefined;
}>;

export type BandaidFinding = Readonly<{
  family: "bandaid";
  turn: number;
  filePath: string;
  severity: BandaidSeverity;
  /** Which shape matched (structural shape id, learned pragma, user pattern label, or "root-cause-not-addressed"). */
  patternLabel: string;
  category: BandaidPatternCategory | "root-cause-not-addressed";
  /** The matched line (first match) — for evidence. */
  evidenceLine: string;
  /** Jaccard/containment overlap with the known root-cause fix (1.0 when no fix was provided). */
  rootCauseOverlap: number;
  recommendation: string;
}>;

export type BandaidDetectionReport = Readonly<{
  findings: readonly BandaidFinding[];
  detectedCount: number;
}>;

export type BandaidDetector = Readonly<{
  recordEdit(event: EditEvent): void;
  detect(): BandaidDetectionReport;
  snapshot(): Readonly<{ edits: readonly EditEvent[] }>;
}>;

export type BandaidDetectorOptions = Readonly<{ config: BandaidConfig }>;

function tokenize(text: string): readonly string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .filter((t) => t.length > 0);
}

/**
 * Containment: the fraction of the FIX's distinctive tokens present in the
 * EDIT. Unlike Jaccard, this is not diluted by the edit's boilerplate. This
 * is the PRIMARY keyword-free signal — it asks "did the edit include the
 * root-cause fix's key tokens?".
 */
function containment(haystack: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0 || haystack.length === 0) return 0;
  const setHay = new Set(haystack);
  let covered = 0;
  for (const t of needle) if (setHay.has(t)) covered += 1;
  return covered / needle.length;
}

/**
 * Compiled user-config bandaid pattern (regex pre-compiled at detector
 * construction so detection never throws; the config already validated
 * compilation, this is a defensive re-compile so a stale config object
 * can't crash the detector).
 */
type CompiledPattern = Readonly<{
  label: string;
  re: RegExp;
  severity: BandaidSeverity;
  category: BandaidPatternCategory;
}>;

function structuralFindingToBandaid(
  edit: EditEvent,
  s: StructuralFinding,
): BandaidFinding {
  return {
    family: "bandaid",
    turn: edit.turn,
    filePath: edit.filePath,
    severity: s.severity,
    patternLabel: s.shape,
    category: s.category,
    evidenceLine: s.evidenceLine,
    rootCauseOverlap: 1,
    recommendation: s.recommendation,
  };
}

export function createBandaidDetector(options: BandaidDetectorOptions): BandaidDetector {
  const cfg = options.config;
  const compiled: CompiledPattern[] = cfg.bandaidPatterns.map((p: BandaidPattern) => ({
    label: p.label,
    re: new RegExp(p.regex),
    severity: p.severity,
    category: p.category,
  }));
  const consequentialManual = cfg.workaroundManualApproachPatterns.map((p: string) => new RegExp(p));

  const edits: EditEvent[] = [];

  function recordEdit(event: EditEvent): void {
    edits.push(event);
  }

  function detect(): BandaidDetectionReport {
    const family = cfg.families.bandaid;
    if (!family.enabled) return { findings: [], detectedCount: 0 };
    if (edits.length < family.minEvents) return { findings: [], detectedCount: 0 };

    const findings: BandaidFinding[] = [];
    for (const edit of edits) {
      if (edit.addedLines.length < cfg.bandaidMinEditLines) continue;

      const joined = edit.addedLines.join("\n");
      let patternHit = false;

      // L1 — STRUCTURAL detection (AST, keyword-free). Parses the added
      // lines as a fragment and walks the AST for bandaid shapes. If the
      // fragment does not parse (a partial line), this layer is skipped —
      // the learned + root-cause layers still run.
      const structural = detectStructuralBandaids(joined, {
        filePath: edit.filePath,
        learnedSuppressionPragmas: cfg.learnedSuppressionPragmas,
        learnedDeferredMarkers: cfg.learnedDeferredMarkers,
        longCommentDeferredEnabled: cfg.longCommentDeferredEnabled,
        longCommentMinRatio: cfg.longCommentMinRatio,
        longCommentMinCommentLength: cfg.longCommentMinCommentLength,
      });
      for (const s of structural) {
        findings.push(structuralFindingToBandaid(edit, s));
        patternHit = true;
      }

      // L2 — User-config patterns (optional; empty by default). A user may
      // add project-specific bandaid signatures via config.
      for (const p of compiled) {
        if (p.re.test(joined)) {
          let evidenceLine = edit.addedLines[0] ?? "";
          for (const line of edit.addedLines) {
            if (typeof line === "string" && line.length > 0 && (p.re.test(line) || line.includes(p.label))) {
              evidenceLine = line;
              break;
            }
          }
          findings.push({
            family: "bandaid",
            turn: edit.turn,
            filePath: edit.filePath,
            severity: p.severity,
            patternLabel: p.label,
            category: p.category,
            evidenceLine,
            rootCauseOverlap: 1,
            recommendation: `Pattern "${p.label}" (${p.category}) detected. Fix the root cause instead of suppressing the symptom.`,
          });
          patternHit = true;
        }
      }

      // L3 — ROOT-CAUSE containment (keyword-free, PRIMARY). Independent of
      // the structural scan: an edit can match no shape AND still be a
      // bandaid (root cause not addressed), OR match a shape AND address
      // the root cause. Uses CONTAINMENT so the edit's boilerplate does
      // not dilute the score.
      const rootFix = edit.knownRootCauseFix;
      if (typeof rootFix === "string" && rootFix.length > 0) {
        const editTokens = tokenize(edit.addedLines.join(" "));
        const fixTokens = tokenize(rootFix);
        const overlap = containment(editTokens, fixTokens);
        if (overlap < cfg.bandaidMinRootCauseOverlap) {
          findings.push({
            family: "bandaid",
            turn: edit.turn,
            filePath: edit.filePath,
            severity: patternHit ? "high" : "medium",
            patternLabel: "root-cause-not-addressed",
            category: "root-cause-not-addressed",
            evidenceLine: edit.addedLines[0] ?? "",
            rootCauseOverlap: overlap,
            recommendation:
              `Edit does not address the known root cause (overlap ${overlap.toFixed(3)} < ${cfg.bandaidMinRootCauseOverlap}). ` +
              `Root cause: "${rootFix}". Fix the root cause instead of the symptom.`,
          });
        }
      }

      // Manual-approach-after-tool-failure smell (owned by the workaround
      // detector, but a hand-rolled reimplemented-tool edit is itself a
      // bandaid-shaped smell). Surface only when no other finding was
      // raised for this edit to avoid double-flagging.
      const alreadyFlagged = findings.some((f) => f.turn === edit.turn && f.filePath === edit.filePath);
      if (!alreadyFlagged) {
        for (const line of edit.addedLines) {
          if (typeof line !== "string" || line.length === 0) continue;
          let hit = false;
          for (const re of consequentialManual) {
            if (re.test(line)) {
              hit = true;
              break;
            }
          }
          if (hit) {
            findings.push({
              family: "bandaid",
              turn: edit.turn,
              filePath: edit.filePath,
              severity: "low",
              patternLabel: "manual-reimplementation",
              category: "root-cause-not-addressed",
              evidenceLine: line,
              rootCauseOverlap: 0,
              recommendation:
                "Edit reimplements a tool's job by hand. Prefer the harness tool; if the tool is unavailable, report it rather than working around it.",
            });
            break;
          }
        }
      }
    }

    return { findings, detectedCount: findings.length };
  }

  function snapshot(): Readonly<{ edits: readonly EditEvent[] }> {
    return { edits };
  }

  return { recordEdit, detect, snapshot };
}
