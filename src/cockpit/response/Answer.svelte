<script lang="ts">
  /**
   * THE ONE ELEMENT that renders a surface's answer when the answer is not
   * its content. Every "there is nothing here", "still measuring", "the
   * system declined" and "the read broke" in the cockpit comes through here.
   *
   * WHAT IT REPLACES. Twenty-nine style rules across twenty-four components,
   * spelling the same four ideas four different ways: `.absent` in eighteen
   * files, `.absence` in six, `.empty` in four, `.error` in one. They
   * disagreed on ink (four different inks), face (mono or sans), and slant
   * (italic or not) — and in three files absence was styled identically to
   * real content, which is the one outcome this product must never produce.
   *
   * WHY A COMPONENT AND NOT A CLASS. A class would have been enough for the
   * ink, and would have left every surface to write its own markup and pick
   * its own field name out of the union. The reason this is a component is
   * the THROW below: it is the only place that can refuse to paint an answer
   * whose evidence is missing, and refusing centrally is what makes the
   * requirement inescapable rather than customary.
   *
   * NO MOTION LIVES HERE, DELIBERATELY. An absence did not "happen" — it is
   * the standing condition of a surface with nothing to show, and animating
   * it would be motion with no event behind it. Under the motion law that is
   * decoration, so there is none. The arrival of the CONTENT that ends the
   * absence is a real event and it sparks at the content, not here.
   */
  import { ANSWER_STATES, wordsOf, type Answer, type UnansweredState } from "./grammar.ts";
  import { ClientError } from "../../data/errors.ts";

  let {
    answer,
    /** `block` for a paragraph of its own, `inline` inside a row of content.
     * Layout only — never ink, face or slant, which the owner fixes so two
     * surfaces cannot disagree about what absence looks like. */
    as = "block",
  }: {
    answer: Answer<unknown>;
    as?: "block" | "inline";
  } = $props();

  /**
   * Render-boundary contract. A `present` answer has content to render and
   * the surface must render it — routing it here would paint the words of a
   * state that has none, which is how a surface ends up showing an empty
   * absence line while holding a perfectly good value.
   *
   * Re-validated on every value, not only the first, for the same reason the
   * verb contract is: an answer that becomes `present` while this element is
   * still mounted is a caller bug that must not paint.
   */
  const shown = $derived.by((): Readonly<{ state: UnansweredState; words: string }> => {
    if (answer.state === "present") {
      throw new ClientError(
        "cockpit_contract",
        "a present answer carries content and must be rendered by its surface, not as an absence",
      );
    }
    const words = wordsOf(answer);
    if (words.length === 0) {
      throw new ClientError(
        "cockpit_contract",
        `a "${answer.state}" answer reached the surface with no plain words`,
      );
    }
    return { state: answer.state, words };
  });

  /** The plain-language meaning of this state, from the declaration — carried
   * to assistive technology so the state is not conveyed by ink alone. */
  const means = $derived(ANSWER_STATES[shown.state].means);
</script>

<!-- `data-answer` is the grammar's attribute. The token owner dresses it; no
     surface may. A `failed` answer is announced, because a read that broke
     while someone was looking at it is news; the other three are standing
     conditions and announcing them would interrupt for no event. -->
{#if as === "inline"}
  <span
    class="answer"
    data-answer={shown.state}
    data-as="inline"
    title={means}
    role={shown.state === "failed" ? "alert" : undefined}>{shown.words}</span>
{:else}
  <p
    class="answer"
    data-answer={shown.state}
    data-as="block"
    title={means}
    role={shown.state === "failed" ? "alert" : undefined}>{shown.words}</p>
{/if}

<style>
  /* LAYOUT ONLY. Every visual property of every answer state — ink, face,
   * slant, size — is declared once by the token owner against
   * `[data-answer]`, because a child's scoped CSS cannot be reached by the
   * owner's state rules and the alternative is a `:global()` escape hatch
   * here plus a private opinion in every consuming room. That is precisely
   * the arrangement this component exists to end. */
  .answer {
    margin: 0;
    min-width: 0;
  }
</style>
