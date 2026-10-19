/**
 * THE RESPONSE GRAMMAR — the one vocabulary every cockpit surface answers in.
 *
 * WHY THIS FILE EXISTS. Before it, one attribute name (`data-state`) carried
 * five disjoint value sets and the word `absent` meant two different things
 * depending on which surface you were reading: "there is no reasoning here"
 * in one vocabulary, "the read refused" in another. A reader learning what a
 * colour means learned it five times. Meanwhile the treatment for "there is
 * nothing here" — the most honesty-critical thing this product renders — was
 * typed out independently in 29 component style blocks across 24 files, in
 * four different inks, two faces, italic-or-not, and three of them made
 * absence visually identical to real content.
 *
 * THE COLLAPSE, AND WHY IT IS TWO AXES AND NOT ONE. Flattening those five
 * vocabularies into one list is what CAUSED the collisions, so the fix is to
 * separate the two questions they were conflating:
 *
 *   ANSWER  — what a surface has to say about its own content. Does it have
 *             the thing, is it still being measured, is there nothing, was it
 *             refused, did the read fail. This axis is about the SURFACE.
 *   OUTCOME — how a measured thing turned out: ok / warn / alarm, plus the
 *             live one. This axis is about the SUBJECT.
 *
 * Once split, every collision dissolves mechanically. A boot probe was
 * `ok | absent | failed`, which is one value from each axis in one list; it
 * becomes `answer=present, outcome=ok` and `answer=absent(reason)` and
 * `answer=failed(reason)`. The beat vocabulary's `neutral` was always an
 * ANSWER wearing an OUTCOME's clothes, which `beat-state.ts` already says out
 * loud — "it remains an ABSENCE and renders as one — never a green tick
 * asserting a success nobody measured". This module is that sentence made
 * structural.
 *
 * THERE IS NO `loading` STATE, DELIBERATELY, AND THIS IS THE LOAD-BEARING
 * OMISSION. A spinner is a claim that work is happening, made by a surface
 * that does not know whether it is. This system never has to make that claim,
 * because it either knows what it is waiting for or it knows why there is
 * nothing — so `pending` DEMANDS THE SUBJECT it is waiting for, in plain
 * words, and there is no way to spell an anonymous wait. That is what makes a
 * hand-rolled spinner not merely discouraged but unspellable: it has nothing
 * to bind to. An unmeasured quantity is reported absent, never spun at.
 *
 * HOW THE BAD STATE IS MADE UNREPRESENTABLE, rather than merely discouraged:
 *
 *   1. The state SET is `keyof typeof ANSWER_STATES`. It is not written twice.
 *      A surface cannot answer `{ kind: "loading" }` because `loading` is not
 *      a key, and the compiler says so.
 *   2. `Answer<T>` carries a brand no object literal can produce, so the
 *      factories below are the ONLY door. That is what stops the evidence
 *      requirement being routed around by hand-writing the shape — which is
 *      exactly how the thirteen independent copies of
 *      `{kind:"absent"; reason:string}` came to exist.
 *   3. Each factory demands the evidence its state is defined by and refuses
 *      an empty one at the door. `absent("")` throws; it does not paint a
 *      blank apology.
 *
 * WHAT THIS FILE DOES NOT STOP, said plainly so nobody believes otherwise: a
 * component that ignores the grammar and hand-writes its own markup and its
 * own style block. Nothing in a type system reaches that, because the bypass
 * is not a bad VALUE, it is the absence of a call. That case is caught one
 * rung lower, by a source guard that derives its universe from the
 * declaration in this file — see `OWNED_CLASS_NAMES` and the guard that
 * consumes it. The guard is the floor, not the design.
 */

import { ClientError } from "../../data/errors.ts";

/**
 * WHAT EVIDENCE A STATE IS DEFINED BY. Not decoration — this is the reason
 * each state cannot be asserted without earning it.
 *
 *   `value`   — the surface has the thing; the thing is the evidence.
 *   `subject` — plain words naming what is being measured. `pending` requires
 *               it, which is what abolishes the anonymous spinner.
 *   `reason`  — plain words for why there is nothing. Owned centrally by
 *               `src/data/absence.ts`, which already maps failure → sentence
 *               and is imported by every feed; this axis does not invent a
 *               second wording authority, it consumes that one.
 */
export type EvidenceKind = "value" | "subject" | "reason";

/**
 * THE ANSWER AXIS — declared ONCE. Every consumer (the type, the factories,
 * the rendered element, the token contract, the guard's universe) derives
 * from this object. Adding a state here is the whole edit; nothing else holds
 * a list to keep in step.
 */
export const ANSWER_STATES = {
  /** The surface has its content. The overwhelmingly common case, and the
   * only one that renders nothing of its own — content speaks for itself. */
  present: {
    evidence: "value",
    /** No ink of its own: present content wears the surface's normal ink. */
    ink: null,
    /** What a reader is being told, in plain words, for the guard's benefit
     * and for anyone reading this file to understand the axis. */
    means: "the surface has what it was asked for",
  },
  /** A measurement is genuinely in flight, and we can name what it is OF.
   * The subject is mandatory precisely so that this cannot degenerate into a
   * spinner. */
  pending: {
    evidence: "subject",
    ink: "--state-pending-ink",
    means: "a named measurement is in flight",
  },
  /** The read succeeded and there is honestly nothing. Distinct from
   * `pending` because "not measured yet" and "measured, and empty" are
   * different facts and the data layer has always distinguished them. */
  absent: {
    evidence: "reason",
    ink: "--state-absent-ink",
    means: "there is nothing, and here is why",
  },
  /** The system DECIDED not to answer — a planted head, a session without
   * the right, a write door that is closed. The distinction from `failed`
   * is the one users care about most: a refusal is a decision this product
   * made on purpose, and blaming the network for it is a lie. */
  refused: {
    evidence: "reason",
    ink: "--state-refused-ink",
    means: "the system declined, on purpose, and here is why",
  },
  /** The read was attempted and broke. Not a refusal, not an emptiness. */
  failed: {
    evidence: "reason",
    ink: "--state-failed-ink",
    means: "the attempt broke, and here is what broke",
  },
} as const;

/** The answer vocabulary, derived. Never written out a second time. */
export type AnswerStateId = keyof typeof ANSWER_STATES;

/** Every answer state id, at runtime, for consumers that must enumerate
 * (the guard's universe, the token contract). Derived from the declaration,
 * so a new state is covered because nobody had to remember. */
export const ANSWER_STATE_IDS = Object.keys(ANSWER_STATES) as readonly AnswerStateId[];

/**
 * THE OUTCOME AXIS — how a measured thing turned out. Deliberately NOT
 * merged with the answer axis (see the header): these compose, they do not
 * collide, and merging them is what produced five vocabularies.
 *
 * `working` is the fourth member and it is not a status. It is the one hue
 * this system reserves for "this is happening right now", and its rarity is
 * the meaning — which is why it is named for the thing it marks rather than
 * for a colour, and why nothing may wear it while at rest.
 *
 * ONE NAME, EVERYWHERE. The live member was once spelled three ways for one
 * idea — `pending` on the answer axis, `live` here, and `running` in the
 * beat's `data-state` — so a reader learned it three times and no guard could
 * hold the three spellings together. The canonical name is now `working`,
 * declared once in this object; the beat's attribute value, the token
 * owner's `[data-state="working"]` rule, and every consumer below DERIVE from
 * it. `data-state="live"` and `data-state="running"` are retired spellings
 * the source guard rejects on sight.
 */
export const OUTCOME_STATES = {
  ok: { ink: "--ok", means: "measured, and it went well" },
  warn: { ink: "--warn", means: "measured, and it needs a look" },
  alarm: { ink: "--alarm", means: "measured, and it went wrong" },
  working: { ink: "--beam", means: "happening right now" },
} as const;

export type OutcomeStateId = keyof typeof OUTCOME_STATES;

export const OUTCOME_STATE_IDS = Object.keys(OUTCOME_STATES) as readonly OutcomeStateId[];

/**
 * Every token name the grammar requires the token owner to declare, derived
 * from both axes. The token contract asserts this set exists in
 * `tokens.css`; adding a state above therefore fails the suite until the
 * token is declared, which is the direction that keeps a declaration and its
 * dressing from drifting apart.
 */
export const REQUIRED_STATE_TOKENS: readonly string[] = [
  ...ANSWER_STATE_IDS.map<string | null>((id) => ANSWER_STATES[id].ink),
  ...OUTCOME_STATE_IDS.map<string | null>((id) => OUTCOME_STATES[id].ink),
].filter((name): name is string => name !== null);

/**
 * THE CLASS NAMES THE GRAMMAR OWNS, and which therefore no component may
 * declare in its own style block. Derived from the answer axis plus the two
 * historical spellings the tree used for the same idea (`absence` beside
 * `absent`, `empty` beside both) — those two are named explicitly because
 * they are the spellings being RETIRED, and a guard that only knew the new
 * names would let a room keep its old rule and quietly stay off-grammar.
 *
 * This is the universe of the source guard. It is derived rather than typed
 * out so that a state added to `ANSWER_STATES` is reserved automatically.
 */
export const OWNED_CLASS_NAMES: readonly string[] = [
  ...ANSWER_STATE_IDS.filter((id) => id !== "present"),
  "absence",
  "empty",
];

/**
 * THE `data-state` VALUES THE GRAMMAR ADMITS — the one set every
 * `data-state="…"` attribute and every `[data-state="…"]` style selector in
 * the cockpit must come from. Derived, never typed out:
 *
 *   - the outcome axis (`ok / warn / alarm / working`), published by the
 *     beat owner (flow/beat-state.ts computes it) and by any surface that
 *     reads an outcome;
 *   - the answer axis minus `present` — a surface in an answer state says so
 *     on its line (the boot probe lines are the live example);
 *   - `neutral` — a measured thing with no outcome to report (the beat's
 *     resting state; it publishes nothing, so the token owner paints no hue
 *     for it);
 *   - `empty` / `past` — the sweep band's two standing conditions, owned by
 *     sweep/band-scope.ts (whose domain axis is the band's TIME POSITION —
 *     "now"/"past" — mapped to this set at the one door, `bandDataState`)
 *     and styled beside the band;
 *   - `armed` — a destructive or live control held one deliberate gesture
 *     away from acting, or a surface mode that changes where the next choice
 *     lands (the delete confirmation's edge; the switch's armed landing). A
 *     state of the CONTROL or the MODE, never of content.
 *
 * WHAT IS NOT ADMITTED, and why the door is a MAPPING and not a wider axis.
 * A component's DOMAIN state is not a `data-state`: the breaker's
 * `on/off/tripped` and the switch feed's `measured`/`pending` are facts
 * about the SUBJECT (a tool, a read), not a presentation state the grammar
 * owns. Admitting them would re-merge the two questions the answer/outcome
 * split exists to keep apart, and hand a private vocabulary back to every
 * domain that wants one. So the grammar does not grow a member per domain;
 * each emitter MAPS its domain kind to an existing admitted state at the one
 * place it stamps the attribute (the breaker row maps `tripped→alarm`,
 * `on→ok`, `off`→the quiet fallback; the switch reel maps `measured` to no
 * hue — a measured line is content, not a state). The source guard
 * (arm I) covers the mapping by requiring every dynamic `data-state={…}`
 * emitter to be traceable to a grammar-derived type or an explicit map —
 * never a bare domain kind reaching the attribute.
 *
 * Anything else is a private vocabulary — the source guard (the tokens
 * owner's outcome-axis arm) rejects it, so a state cannot be invented by
 * writing markup. The retired spellings (`bad`, `live`, `running` as a
 * beat's `data-state`) are named in the guard's message, not here: this set
 * is what EXISTS, not a museum of what was renamed.
 */
export const DATA_STATE_VALUES = [
  ...OUTCOME_STATE_IDS,
  ...ANSWER_STATE_IDS.filter((id) => id !== "present"),
  "neutral",
  "empty",
  "past",
  "armed",
] as const;

/** The one type a `data-state` attribute may carry — derived from the
 * admitted set, so a value the grammar does not admit is unrepresentable at
 * the door that maps to it. */
export type DataStateValue = (typeof DATA_STATE_VALUES)[number];

// ── The Answer value ──────────────────────────────────────────────────────

/**
 * The brand. An object literal cannot produce a `unique symbol` key, so
 * `Answer<T>` is not structurally satisfiable and the factories below are
 * the only way to obtain one. This is the mechanism that makes the evidence
 * requirement inescapable rather than customary: there is no shape to
 * hand-write.
 */
declare const ANSWER_BRAND: unique symbol;

type Branded = { readonly [ANSWER_BRAND]: true };

export type Answer<T> =
  | (Readonly<{ state: "present"; value: T }> & Branded)
  | (Readonly<{ state: "pending"; subject: string }> & Branded)
  | (Readonly<{ state: "absent"; reason: string }> & Branded)
  | (Readonly<{ state: "refused"; reason: string }> & Branded)
  | (Readonly<{ state: "failed"; reason: string }> & Branded);

/** Any answer that is not `present` — the set the shared element renders. */
export type UnansweredState = Exclude<AnswerStateId, "present">;

function brand<T>(shape: object): Answer<T> {
  return shape as Answer<T>;
}

/**
 * The evidence gate, at the one door. Every factory that carries plain words
 * comes through here, so "a state without its evidence" is refused in one
 * place rather than checked at five call sites.
 *
 * It throws rather than returning a fallback because a fallback would be a
 * second source of truth for the sentence, and the sentence is the entire
 * point of the state. A surface that cannot say why there is nothing has not
 * earned the right to say there is nothing.
 */
function requireWords(state: AnswerStateId, evidence: EvidenceKind, words: string): string {
  if (typeof words !== "string" || words.trim().length === 0) {
    throw new ClientError(
      "cockpit_contract",
      `a "${state}" answer needs its ${evidence} in plain words; it was given none`,
    );
  }
  return words;
}

/** The surface has its content. */
export function present<T>(value: T): Answer<T> {
  return brand<T>({ state: "present", value });
}

/**
 * A named measurement is in flight. The subject is what makes this honest —
 * "reading the words this carries" rather than a rotating shape.
 */
export function pending<T>(subject: string): Answer<T> {
  return brand<T>({
    state: "pending",
    subject: requireWords("pending", ANSWER_STATES.pending.evidence, subject),
  });
}

/** The read succeeded and there is honestly nothing. */
export function absent<T>(reason: string): Answer<T> {
  return brand<T>({
    state: "absent",
    reason: requireWords("absent", ANSWER_STATES.absent.evidence, reason),
  });
}

/** The system declined on purpose. */
export function refused<T>(reason: string): Answer<T> {
  return brand<T>({
    state: "refused",
    reason: requireWords("refused", ANSWER_STATES.refused.evidence, reason),
  });
}

/** The attempt broke. */
export function failed<T>(reason: string): Answer<T> {
  return brand<T>({
    state: "failed",
    reason: requireWords("failed", ANSWER_STATES.failed.evidence, reason),
  });
}

/**
 * The plain words an answer carries, whichever kind of evidence that is.
 * One reader for the rendered element, so the element does not re-open the
 * union and pick a field name per branch.
 */
export function wordsOf<T>(answer: Answer<T>): string {
  return answer.state === "pending" ? answer.subject : answer.state === "present" ? "" : answer.reason;
}
