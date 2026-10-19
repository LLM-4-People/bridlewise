/**
 * THE `harness promote` GRAMMAR — the one owner of how a verb request is
 * spelled on a command line: {@link parsePromoteArguments} reads argv into a
 * {@link PromotionRequest} (or the typed usage refusal), and
 * {@link formatPromoteArguments} spells a request back (what the promoter
 * home and the trigger re-execute), so `parse(format(request))` is the
 * request.
 *
 *   status       [--profile <name>] [--source <rev>]
 *   plan         [--profile <name>] [--source <rev>] [--diff] [--patch]
 *   explain      [--profile <name>] [--source <rev>] <path>…
 *   apply        [--profile <name>] [--source <rev>] [--no-publish] [--no-push] [--auto]
 *                [--accept-target-edits <path>… --reason <text>] [--allow-deletions --reason <text>]
 *                [--release-hold --reason <text>]
 *   rollback     [--profile <name>] --to <promotion commit> --reason <text>
 *   hold         [--profile <name>] --reason <text>
 *   release-hold [--profile <name>] --reason <text>
 *   auto         --refs <refs>
 *
 * (`--json` / `--text` choose the rendering: the harness CLI's one output
 * option, taken out before a verb's arguments are read — never part of a
 * request.) A `--reason` is required exactly where a person decides
 * something the record must explain (an override, a rollback, a hold and its
 * release) and refused anywhere else. A leaf: the verbs (`context.ts`) and
 * the command door (`promote-cli.ts`) both import it.
 */
import { deepFreeze } from "../../kernel/integrity.ts";
import { PromotionError } from "./codes.ts";

const PROMOTION_VERBS = deepFreeze(["status", "plan", "explain", "apply", "rollback", "hold", "release-hold", "auto"] as const);
export type PromotionVerb = typeof PROMOTION_VERBS[number];

/**
 * One verb request (the CLI's parsed argv, or an exposure action's
 * arguments). `apply` takes `noPublish`, `noPush`, `auto` and the reasoned
 * overrides `acceptTargetEdits` / `allowDeletions` / `releaseHold` with
 * `reason`; `rollback` takes `to` and `reason`; `hold` and `release-hold`
 * take `reason`; `auto` takes the moved `refs`.
 */
export type PromotionRequest = Readonly<{
  verb: PromotionVerb;
  profile?: string;
  source?: string;
  diff?: boolean;
  patch?: boolean;
  paths?: readonly string[];
  noPublish?: boolean;
  noPush?: boolean;
  auto?: boolean;
  acceptTargetEdits?: readonly string[];
  allowDeletions?: boolean;
  releaseHold?: boolean;
  reason?: string;
  to?: string;
  refs?: string;
}>;

function isPromotionVerb(value: string | undefined): value is PromotionVerb {
  return value !== undefined && (PROMOTION_VERBS as readonly string[]).includes(value);
}

/** The flags (without a value) each verb takes. */
const VERB_FLAGS: Readonly<Partial<Record<PromotionVerb, readonly string[]>>> = deepFreeze({
  plan: ["--diff", "--patch"],
  apply: ["--no-publish", "--no-push", "--auto", "--allow-deletions", "--release-hold"],
});

/** The verbs a `--reason` always comes with (a person's decision the record explains). */
const REASONED_VERBS: ReadonlySet<PromotionVerb> = new Set(["rollback", "hold", "release-hold"]);

/** The request `argv` spells, or the typed usage refusal. */
export function parsePromoteArguments(argv: readonly string[]): PromotionRequest {
  const verb = argv[0];
  if (!isPromotionVerb(verb)) throw new PromotionError("promotion_usage", `promote requires a verb (${PROMOTION_VERBS.join(", ")})`);
  let profile: string | undefined;
  let source: string | undefined;
  let reason: string | undefined;
  let to: string | undefined;
  let refs: string | undefined;
  let acceptTargetEdits: string[] | undefined;
  const flags = new Set<string>();
  const paths: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new PromotionError("promotion_usage", `${argument} needs a value`);
      index += 1;
      return next;
    };
    if (argument === "--profile" && verb !== "auto") profile = value();
    else if (argument === "--source" && ["status", "plan", "explain", "apply"].includes(verb)) source = value();
    else if (VERB_FLAGS[verb]?.includes(argument) === true) flags.add(argument);
    else if (argument === "--reason" && (verb === "apply" || REASONED_VERBS.has(verb))) reason = value();
    else if (argument === "--to" && verb === "rollback") to = value();
    else if (argument === "--refs" && verb === "auto") refs = value();
    else if (argument === "--accept-target-edits" && verb === "apply") {
      acceptTargetEdits = [];
      while (argv[index + 1] !== undefined && !argv[index + 1]!.startsWith("--")) acceptTargetEdits.push(argv[++index]!);
      if (acceptTargetEdits.length === 0) throw new PromotionError("promotion_usage", "--accept-target-edits needs the exact list of the plan's target edits");
    } else if (!argument.startsWith("-") && verb === "explain") paths.push(argument);
    else throw new PromotionError("promotion_usage", `unknown promote ${verb} argument: ${argument}`);
  }
  if (verb === "explain" && paths.length === 0) throw new PromotionError("promotion_usage", "explain needs at least one path");
  if (verb === "rollback" && to === undefined) throw new PromotionError("promotion_usage", "rollback needs --to <promotion commit>");
  if (verb === "auto" && refs === undefined) throw new PromotionError("promotion_usage", "auto needs --refs <the moved refs> (the trigger hook's entry)");
  if (flags.has("--auto") && (flags.has("--release-hold") || acceptTargetEdits !== undefined || flags.has("--allow-deletions"))) {
    throw new PromotionError("promotion_usage", "an unattended run (--auto) takes no override: overrides are a person's decision");
  }
  const overrides = acceptTargetEdits !== undefined || flags.has("--allow-deletions") || flags.has("--release-hold");
  const reasoned = overrides || REASONED_VERBS.has(verb);
  if (reasoned && (reason === undefined || reason.trim() === "")) {
    throw new PromotionError("promotion_usage", `${REASONED_VERBS.has(verb) ? verb : "an override (--accept-target-edits, --allow-deletions, --release-hold)"} needs --reason <text>: it is recorded in the receipt or the hold, and the log`);
  }
  if (!reasoned && reason !== undefined) throw new PromotionError("promotion_usage", "--reason explains an override (--accept-target-edits, --allow-deletions, --release-hold), a rollback or a hold; there is none");
  return deepFreeze({
    verb,
    ...(profile === undefined ? {} : { profile }),
    ...(source === undefined ? {} : { source }),
    diff: flags.has("--diff"),
    patch: flags.has("--patch"),
    paths,
    ...(verb === "apply" ? {
      noPublish: flags.has("--no-publish"),
      noPush: flags.has("--no-push"),
      auto: flags.has("--auto"),
      allowDeletions: flags.has("--allow-deletions"),
      releaseHold: flags.has("--release-hold"),
    } : {}),
    ...(acceptTargetEdits === undefined ? {} : { acceptTargetEdits }),
    ...(reason === undefined ? {} : { reason }),
    ...(to === undefined ? {} : { to }),
    ...(refs === undefined ? {} : { refs }),
  });
}

/** The argv that spells `request` (see the header): the verb, then its flags, an explain's paths last. */
export function formatPromoteArguments(request: PromotionRequest): readonly string[] {
  return deepFreeze([
    request.verb,
    ...(request.profile === undefined ? [] : ["--profile", request.profile]),
    ...(request.source === undefined ? [] : ["--source", request.source]),
    ...(request.diff === true ? ["--diff"] : []),
    ...(request.patch === true ? ["--patch"] : []),
    ...(request.noPublish === true ? ["--no-publish"] : []),
    ...(request.noPush === true ? ["--no-push"] : []),
    ...(request.auto === true ? ["--auto"] : []),
    ...(request.acceptTargetEdits === undefined ? [] : ["--accept-target-edits", ...request.acceptTargetEdits]),
    ...(request.allowDeletions === true ? ["--allow-deletions"] : []),
    ...(request.releaseHold === true ? ["--release-hold"] : []),
    ...(request.to === undefined ? [] : ["--to", request.to]),
    ...(request.refs === undefined ? [] : ["--refs", request.refs]),
    ...(request.reason === undefined ? [] : ["--reason", request.reason]),
    ...(request.paths ?? []),
  ]);
}
