import type { AstNode } from "../quality-packs/prevention/ast-helpers.ts";

export function commentLengthReducer(sum: number, c: unknown): number {
  const cn = c as { value?: string };
  return sum + (typeof cn.value === "string" ? cn.value.trim().length : 0);
}

/**
 * Whether a node is a statement or declaration (used by the bandaid
 * detectors + pattern learner to walk only statement-shaped nodes).
 *
 * Single owner (R45: previously duplicated as `isStatementLike` in
 * `bandaid-ast-detector.ts` and `isStatement` in `bandaid-pattern-learner.ts`
 * near-identical bodies, No Scattered Helpers).
 */
export function isStatementLike(node: AstNode): boolean {
  return /Statement$|Declaration$/.test(node.type);
}

/**
 * Average characters per source line — a rough multiplier for the
 * best-effort statement-size shape filter below. Named (not a bare literal)
 * so the heuristic is self-documenting. This is
 * a SHAPE filter only — exact char counting is not needed, so a fixed
 * average is appropriate (not a configurable).
 */
const AVG_CHARS_PER_LINE = 40;

/**
 * Best-effort length of the source text covered by a statement (in chars).
 * Prefers exact byte offsets (babel provides `start`/`end`); falls back to
 * line span × average chars per line when offsets are unavailable.
 *
 * Single owner (R45: previously duplicated in `bandaid-ast-detector.ts` and
 * `bandaid-pattern-learner.ts` — identical bodies with the same `* 40`
 * magic number, No Scattered Helpers + ).
 */
export function statementTextLength(stmt: AstNode): number {
  const start = (stmt as unknown as { start?: number }).start;
  const end = (stmt as unknown as { end?: number }).end;
  if (typeof start === "number" && typeof end === "number" && end >= start) {
    return Math.max(1, end - start);
  }
  const loc = (stmt as unknown as { loc?: { start?: { line?: number }; end?: { line?: number } } }).loc;
  if (!loc || !loc.start || !loc.end) return 0;
  const startLine = loc.start.line ?? 0;
  const endLine = loc.end.line ?? 0;
  if (startLine <= 0 || endLine <= 0) return 0;
  return Math.max(1, (endLine - startLine + 1) * AVG_CHARS_PER_LINE);
}
