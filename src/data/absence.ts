/**
 * FAILURE → PLAIN WORDS. The single owner of "why is there nothing here".
 *
 * Extracted from `src/cockpit/rooms/switch-feed.ts` for the same reason
 * `errors.ts` was extracted from `client.ts`: the mapping is needed BELOW the
 * cockpit (the history load in `client.ts` states its own absence now — see
 * DESIGN-PERFORMANCE §1 L3), and a cockpit room importing `client.ts` while
 * `client.ts` imported that room back would be a cycle through the very
 * module the cockpit is replacing. The rule the extraction preserves is the
 * one that mattered: ONE mapping, so a surface cannot invent its own wording
 * for a refusal one sentence at a time.
 */

import { PAST_VIEW_UNSUPPORTED_CODE, PAST_VIEW_UNSUPPORTED_SENTENCE } from "./asof.ts";
import { ClientError } from "./errors.ts";
// The refusal status family (428/503) — the taxonomy owns the pair; this
// module owns the refused-vs-failed JUDGEMENT over it, never the family.
import { PRINCIPLED_REFUSAL_STATUSES } from "../../shared/errors.ts";

/**
 * The answer ARRIVED but was not the shape the surface can read.
 *
 * Lives beside `absenceReason` because it is the other half of the same
 * mapping — "why is there nothing here" — and a feed that invents its own
 * wording for it is the scattered-helper pattern one sentence at a time. A
 * surface with something MORE specific to say (the desk names the
 * composition it could not measure) says that instead; this is the default,
 * not a ceiling.
 */
export const UNREADABLE_SHAPE = "the answer did not carry the expected shape";

/**
 * The statuses that mean "the server DECLINED, on purpose, and said why".
 *
 * 428 is the guided-state family (something the USER must do first — the
 * server names the remedy and will keep answering the same way until it is
 * done); 503 with a typed code is the server's own self-protection (it chose
 * not to perform the operation — `git_not_run` is the canonical case). Both
 * carry the server's own sentence in the message, and both are the grammar's
 * REFUSED state, never its FAILED one: a refusal is a decision this system
 * made, and blaming the network for it is a lie.
 *
 * The pair itself is the taxonomy's (shared/errors.ts): a refusal also
 * travels in a 200 block envelope now (the browser logs the status itself,
 * before any page code runs — a designed refusal must not be a standing
 * console error), so both sides must agree about what counts as one.
 */
const REFUSAL_STATUSES: readonly number[] = PRINCIPLED_REFUSAL_STATUSES;

/**
 * The server's own sentence for a PRINCIPLED refusal, or null when the
 * failure is not one. The single owner of the refused-vs-failed distinction
 * on the client, beside `absenceReason` because it is the same mapping's
 * other half — "why is there nothing here", answered with the state that
 * earns it.
 *
 * The typed code is the discriminator: a bare gateway 503 (proxy, outage)
 * arrives with only the `http_<status>` fallback code and no server
 * sentence, and that is a transport failure, not a decision.
 */
export function refusalReason(err: unknown): string | null {
  if (!(err instanceof ClientError)) return null;
  if (err.statusCode === undefined || !REFUSAL_STATUSES.includes(err.statusCode)) return null;
  if (err.code === `http_${err.statusCode}` || err.code === "network") return null;
  return err.message.length > 0 ? err.message : null;
}

/** Failure → plain-words absence. The SINGLE owner of this mapping (No
 * Scattered Helpers) — every feed and the history load import it. */
export function absenceReason(err: unknown): string {
  if (err instanceof ClientError) {
    // A head is planted and this block cannot answer for a past instant. The
    // Broker refused the read rather than fetch NOW and let it be read as
    // THEN — so the honest sentence, not "not available right now", which
    // would blame the network for a decision the app made deliberately.
    if (err.code === PAST_VIEW_UNSUPPORTED_CODE) return PAST_VIEW_UNSUPPORTED_SENTENCE;
    if (err.statusCode === 401 || err.statusCode === 403) return "not available to this session";
    if (err.statusCode === 404) return "no recorded history";
    if (err.code === "timeout") return "not answering right now";
    // A PRINCIPLED refusal carries the server's own sentence, and dropping
    // it for the generic line below was a real defect: "The <thing> could
    // not be read because this server would not run git: <why>" rendered as
    // "not available right now" — a deliberate decision re-dressed as a
    // network shrug. Feeds that can carry the STATE should prefer
    // `refusalReason` and render REFUSED; this branch is the floor that
    // keeps the sentence for every consumer of the words alone.
    const refusal = refusalReason(err);
    if (refusal !== null) return refusal;
  }
  return "not available right now";
}
