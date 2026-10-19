/**
 * `harness promote` — the command door of the promotion primitive (root
 * alias `npm run promote`):
 *
 *   harness promote status       [--profile <name>] [--source <rev>]
 *   harness promote plan         [--profile <name>] [--source <rev>] [--diff] [--patch]
 *   harness promote explain      [--profile <name>] [--source <rev>] <path>…
 *   harness promote apply        [--profile <name>] [--source <rev>] [--no-publish] [--no-push] [--auto]
 *                                [--accept-target-edits <path>… --reason <text>] [--allow-deletions --reason <text>]
 *                                [--release-hold --reason <text>]
 *   harness promote rollback     [--profile <name>] --to <promotion commit> --reason <text>
 *   harness promote hold         [--profile <name>] --reason <text>
 *   harness promote release-hold [--profile <name>] --reason <text>
 *   harness promote auto         --refs <refs>            (the trigger hook's entry)
 *   (every verb: [--json|--text], the harness CLI's one output option)
 *
 * Every answer is one envelope, `{ok, code, class, message, remedy, data}`
 * (the code, class and remedy from `codes.ts`): printed as the harness's
 * JSON (the default, `--json`) or as its report (`--text`, rendered here;
 * the flag is the harness dispatch's, `takeOutputFormat`). The process
 * exits with the class's code (0 ok, 2 input, 3 precondition, 4 errored, 5
 * failed, 6 integrity, 7 parked); an unattended run (`apply --auto`, `auto`)
 * exits 0 for an answer that only says "not now" (locked, held, parked).
 * `auto`'s `--text` report is its notices alone, one line each (a profile
 * whose previous run did not end ok), and nothing when there is none: the
 * trigger hook prints it on the pusher's stderr (and sends the run's log
 * lines nowhere), so a push shows a blocked promotion and nothing else. This module renders and maps the exit code; the
 * grammar is `promote-arguments.ts`'s, the envelope `../command-result.ts`'s
 * (never the command table's: a door importing it back deadlocks it as an
 * entry), the verbs, which profile and which source `context.ts`'s.
 */
import { deepFreeze } from "../../kernel/integrity.ts";
import { wrapResult, type CommandAnswer } from "../command-result.ts";
import { PromotionError, answer, promotionExitCode, type PromotionAnswer } from "./codes.ts";
import { runPromotionVerb, type PromotionDocument } from "./context.ts";
import { parsePromoteArguments, type PromotionRequest } from "./promote-arguments.ts";
import type { UnattendedLaunch } from "./trigger.ts";

/** What the command door answers: the envelope, the class's exit code, and its `--text` report. */
export type PromoteCliOutcome = CommandAnswer<PromotionAnswer> & Readonly<{ exitCode: number }>;

/** The lines of `data`'s named list (each entry's message, or the entry itself). */
function listed(data: unknown, key: string): readonly string[] {
  const value = typeof data === "object" && data !== null ? (data as Record<string, unknown>)[key] : undefined;
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry === "string") return entry;
    const record = entry as Record<string, unknown>;
    return [record["code"] ?? record["kind"] ?? record["step"], record["path"], record["message"] ?? record["detail"] ?? record["status"]].filter((part) => part !== undefined).map(String).join(": ");
  });
}

/** The `--text` report of an answer: its code and class, the message and the remedy, then its refusals, target edits, advisories, steps and diff — `auto`'s is its notices alone (see the header). */
function renderPromotionText(result: PromotionAnswer, verb: PromotionRequest["verb"] | undefined): string {
  const data = result.data as Record<string, unknown> | null;
  if (verb === "auto" && result.class === "ok") return listed(data, "notices").map((notice) => `${notice}\n`).join("");
  const section = (title: string, lines: readonly string[]): string[] => (lines.length === 0 ? [] : [`${title}:`, ...lines.map((line) => `  - ${line}`)]);
  return [
    `${result.code} (${result.class}): ${result.message}`,
    `remedy: ${result.remedy}`,
    ...section("refusals", listed(data, "refusals")),
    ...section("target edits", listed(data, "targetEdits")),
    ...section("advisories", listed(data, "advisories")),
    ...section("steps", listed(data, "steps")),
    ...section("notices", listed(data, "notices")),
    ...(typeof data?.["diff"] === "string" ? [data["diff"]] : []),
  ].join("\n").concat("\n");
}

/** Runs one `harness promote` verb: its envelope, its exit code, and its `--text` report (a usage error or a refusal is an answer, not a crash); `document` replaces the checkout's configuration (a fixture's), `launch` the background launch of the unattended runs it owes (a test's spy). */
export async function runPromoteCli(root: string, argv: readonly string[], document?: PromotionDocument, launch?: UnattendedLaunch): Promise<PromoteCliOutcome> {
  let result: PromotionAnswer;
  let request: PromotionRequest | null = null;
  try {
    request = parsePromoteArguments(argv);
    result = await runPromotionVerb(root, request, document, launch);
  } catch (error) {
    if (!(error instanceof PromotionError)) throw error;
    result = answer(error.promotionCode, error.message, error.facts);
  }
  return deepFreeze({
    result: wrapResult(`promote ${argv[0] ?? ""}`.trim(), result, { status: result.ok ? "pass" : "fail" }),
    exitCode: promotionExitCode(result.code, request?.auto === true || request?.verb === "auto"),
    text: () => renderPromotionText(result, request?.verb),
  });
}
