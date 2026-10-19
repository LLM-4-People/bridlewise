/**
 * THE PROMOTION TRAILERS — the one reader of what a promotion commit says
 * about itself (`ROOT_POLICY.workflow.promotion.trailers`): the profile and
 * its blob (`Promotion-Profile: <name>@<blob>`), the source commit it carries
 * (`Promoted-From`), the target edits it was told to overwrite
 * (`Promotion-Accepted-Target-Edits`) and, for a rollback, the promotion it
 * restores (`Promotion-Restores`). The durable state a rerun derives from:
 * the plan's last promotion and never-rule, a resumed pending commit, a
 * target checkout finding its profile, and a rollback's validation all read
 * it here, through one `git log` format.
 */
import { deepFreeze } from "../../kernel/integrity.ts";
import { ROOT_POLICY } from "../../kernel/root-policy.ts";
import { gitOutput, type GitRepository } from "../../git/tree-reader.ts";

type TrailerKey = keyof typeof ROOT_POLICY.workflow.promotion.trailers;

/** A commit's promotion trailers (each the first value, `null` when absent). */
export type PromotionTrailers = Readonly<Record<TrailerKey, string | null>>;

/** One commit of a history and its promotion trailers. */
export type TrailerLine = Readonly<{ commit: string; trailers: PromotionTrailers }>;

const TRAILER_KEYS = Object.freeze(Object.keys(ROOT_POLICY.workflow.promotion.trailers) as TrailerKey[]);

/** The `git log` format of a commit and each trailer's values (`%x01`-separated), NUL-separated, records `%x1e`-terminated. */
function trailerFormat(): string {
  const { trailers } = ROOT_POLICY.workflow.promotion;
  return `%H%x00${TRAILER_KEYS.map((key) => `%(trailers:key=${trailers[key]},valueonly,separator=%x01)`).join("%x00")}%x1e`;
}

/**
 * The commits of `rev`'s history, newest first, with their promotion
 * trailers: the first-parent line only when `firstParent` (a target's own
 * history: what its promotions and rollbacks are), at most `maxCount`.
 */
export function trailerHistory(repository: GitRepository, rev: string, options: Readonly<{ firstParent: boolean; maxCount?: number }>): readonly TrailerLine[] {
  const argv = ["log", ...(options.firstParent ? ["--first-parent"] : []), ...(options.maxCount === undefined ? [] : [`--max-count=${String(options.maxCount)}`]), `--format=${trailerFormat()}`, rev, "--"];
  return deepFreeze(gitOutput(repository, argv).stdout.toString("utf8").split("\x1e")
    .map((record) => record.replace(/^\n/u, ""))
    .filter((record) => record.length > 0)
    .map((record) => {
      const [commit, ...values] = record.split("\0");
      const first = (value: string | undefined): string | null => (value === undefined || value.trim() === "" ? null : value.split("\x01")[0]!.trim());
      return { commit: commit!, trailers: Object.fromEntries(TRAILER_KEYS.map((key, index) => [key, first(values[index])])) as PromotionTrailers };
    }));
}

/** The promotion trailers of `commit`. */
export function promotionTrailersOf(repository: GitRepository, commit: string): PromotionTrailers {
  return trailerHistory(repository, commit, { firstParent: true, maxCount: 1 })[0]!.trailers;
}

/** The profile name and blob a `Promotion-Profile` trailer names (`<name>@<blob>`), or `null`. */
export function profileOfTrailer(value: string | null): Readonly<{ name: string; blob: string }> | null {
  const [name, blob] = (value ?? "").split("@");
  return name === undefined || name === "" || blob === undefined || blob === "" ? null : deepFreeze({ name, blob });
}

/**
 * The commits of `profile` on `target`'s first-parent line (newest first):
 * each promotion and rollback its trailer names, its line kept.
 */
export function profileHistory(repository: GitRepository, target: string, profile: string): readonly TrailerLine[] {
  return deepFreeze(trailerHistory(repository, target, { firstParent: true }).filter((line) => profileOfTrailer(line.trailers.profile)?.name === profile));
}
