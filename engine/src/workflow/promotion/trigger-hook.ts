/**
 * THE PROMOTION TRIGGER HOOK — the canonical text of the tracked
 * `.githooks/reference-transaction` (merge-door-final §11): after a push or a
 * fetch moves a remote-tracking ref, it starts `harness promote auto` in the
 * background (`trigger.ts`), which promotes each profile whose source that
 * ref is and whose trigger is `on-source-publish`.
 *
 * It must NEVER fail: git runs it in the `prepared` state of EVERY ref
 * transaction (a commit, a checkout, a fetch, a push), and a non-zero exit
 * there aborts the update ("ref updates aborted by hook") — one broken line
 * would block every git operation in the repository (merge-door-final J15).
 * So: no `set -e`; every step that can fail ends the hook with 0; only the
 * `committed` state of an update that moved a remote-tracking ref does
 * anything; the promoter's own fetches and pushes (which carry
 * `ROOT_POLICY.workflow.promotion.runEnvironmentVariable`) do nothing; the
 * background run's `--text` report — its notices alone, one line for each
 * blocked promotion, nothing otherwise — goes to the pusher's stderr, and its
 * log lines nowhere (each run it starts logs to a file of its own in the
 * profile's area, `last-run.ts` `openUnattendedLog`).
 *
 * The text is the code's (this leaf): the commit guard refuses a staged hook
 * whose code lines differ from {@link promotionTriggerHookBody}, and the
 * installation checks of both suites judge the working copy the same way
 * (`engine/scripts/verification/staged-move-loss.ts`). A leaf: the commit
 * guard imports it without the promotion's graph.
 */
import { ROOT_POLICY } from "../../kernel/root-policy.ts";
import { SHIPPED_HOOK_FILES } from "../../kernel/verification-paths.ts";

/** The hook's name (git's): it sees every ref transaction. Declared with the other shipped hooks (`SHIPPED_HOOK_FILES`). */
export const PROMOTION_TRIGGER_HOOK = SHIPPED_HOOK_FILES.trigger;

/** The interpreter line the hook starts with. */
const TRIGGER_SHEBANG = "#!/bin/sh";

/** The hook's code lines (see the header): what a staged or installed hook must run, in order. */
export function promotionTriggerHookBody(): readonly string[] {
  const run = ROOT_POLICY.workflow.promotion.runEnvironmentVariable;
  return Object.freeze([
    "[ \"$1\" = committed ] || { cat >/dev/null 2>&1; exit 0; }",
    `[ -z "$${run}" ] || { cat >/dev/null 2>&1; exit 0; }`,
    "refs=$(grep -o ' refs/remotes/[^ ]*$' 2>/dev/null) || exit 0",
    "root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0",
    "command -v node >/dev/null 2>&1 || exit 0",
    `( node --experimental-strip-types "$root/engine/src/cli.ts" ${ROOT_POLICY.protocol.harnessCommand} promote auto --refs "$refs" --text </dev/null >&2 2>/dev/null & )`,
    "exit 0",
  ]);
}

/** The whole hook as the repository tracks it: the interpreter line, its explanation, then {@link promotionTriggerHookBody}. */
export function promotionTriggerHookText(): string {
  return `${[
    TRIGGER_SHEBANG,
    "# THE PROMOTION TRIGGER (engine/src/workflow/promotion/trigger-hook.ts owns this",
    "# text; the commit guard refuses any other). After a push or a fetch moves a",
    "# remote-tracking ref, start `harness promote auto` in the background: it",
    "# promotes each profile whose source that ref is (`trigger: on-source-publish`).",
    "# It must NEVER fail: a non-zero exit in git's `prepared` state aborts every ref",
    "# update in the repository. No `set -e`; every step that can fail exits 0.",
    ...promotionTriggerHookBody(),
  ].join("\n")}\n`;
}

/** Whether `text` runs exactly the trigger's code lines (its first line the interpreter's; blank lines and comments aside). */
export function isPromotionTriggerHookText(text: string): boolean {
  const lines = text.split("\n");
  if (lines[0] !== TRIGGER_SHEBANG) return false;
  const code = lines.slice(1).filter((line) => {
    const text = line.replace(/^[ \t]+/u, "");
    return text !== "" && !text.startsWith("#");
  });
  const body = promotionTriggerHookBody();
  return code.length === body.length && code.every((line, index) => line === body[index]);
}
