/**
 * FAILURE OWNERS — which named task owns a test that fails on the target.
 *
 * The user's standing policy for a land: zero NEW failures, and every
 * remaining failure owned by a named task. The workspace's ledger judge
 * (src/workflow/workspace-manager.ts) reads this answer for every failure that
 * persists from the target's recorded run: a persisting failure an OPEN task
 * row owns is accepted (named in the gate's output), one no open row owns is
 * refused. Nothing is re-run and nothing else decides (UR-17: one judgement).
 *
 * THE ROW GRAMMAR (the tracker `ROOT_POLICY.workflow.failureOwners.tracker`;
 * this module is its ONE parser): a task is a list item `- [ ] **<TASK-ID>**`
 * (open) or `- [x] **<TASK-ID>**` (closed) at any indentation; its text runs
 * on over every following line indented deeper than its dash. An open row
 * OWNS what it DECLARES: the names its text carries as whole tokens
 * (`declaredNames`: split at whitespace, quotes, backticks, brackets and
 * list punctuation; a trailing `.`/`:` and a `:<line>` suffix dropped) —
 * a failing test's REPOSITORY path (`engine/test/…`, `tests/…`), a budget's
 * config key. Never a fragment: `tests/unit/a.test.tsx` does not own
 * `tests/unit/a.test.ts`, and a closed row or a prose mention owns nothing.
 */
import { deepFreeze } from "../kernel/integrity.ts";

/** One task row: its id, whether it is closed, and its whole text (the first line and its continuation lines). */
export type TaskRow = Readonly<{ id: string; done: boolean; text: string }>;

/** One open task row. */
export type OpenTaskRow = TaskRow;

const ROW = /^(\s*)- \[([ xX])\] \*\*([^*\n]+?)\*\*/u;

/** Every task row of a tracker's text, open and closed, in order. */
export function taskRows(trackerText: string): readonly TaskRow[] {
  const lines = trackerText.split("\n");
  const rows: TaskRow[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = ROW.exec(lines[index]!);
    if (match === null) continue;
    const indent = match[1]!.length;
    const text = [lines[index]!];
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next]!;
      const lineIndent = line.length - line.trimStart().length;
      if (line.trim().length === 0 || lineIndent <= indent) break;
      text.push(line);
    }
    rows.push({ id: match[3]!, done: match[2] !== " ", text: text.join("\n") });
  }
  return deepFreeze(rows);
}

/** Every OPEN task row of a tracker's text, in order. */
export function openTaskRows(trackerText: string): readonly OpenTaskRow[] {
  return deepFreeze(taskRows(trackerText).filter((row) => !row.done));
}

/** The names a row declares: its text's whole tokens (see the header). */
export function declaredNames(row: TaskRow): ReadonlySet<string> {
  return new Set(row.text.split(/[\s`'"()[\]{}<>,;|*]+/u)
    .map((token) => token.replace(/:\d+(?:-\d+)?$/u, "").replace(/[.:!?]+$/u, ""))
    .filter((token) => token.length > 0));
}

/** The ids of the open rows that declare EVERY one of `names` (a test's repository path, a budget key; empty: nobody owns it). */
export function ownersOf(rows: readonly TaskRow[], ...names: readonly string[]): readonly string[] {
  return deepFreeze(rows.filter((row) => !row.done).filter((row) => {
    const declared = declaredNames(row);
    return names.every((name) => declared.has(name));
  }).map((row) => row.id));
}
