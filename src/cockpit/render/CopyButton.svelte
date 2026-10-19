<script lang="ts">
  /**
   * The per-block copy affordance. Chrome is the owned `.verb`. Reveal is
   * the owned hover-reveal: this button ALWAYS emits `.reveal-item`; a
   * host that wants it hidden at rest marks itself `.reveal-on-hover`.
   * Without that ancestor (ArtifactFrame) the copy is visible at rest —
   * the Primer copy law, and the rest-state floor. Outcome colours are
   * the only local fact: "copied" / "can't copy" are this button's own
   * report, not the answer grammar.
   *
   * "copied" is shown only after the write resolved. The clipboard is
   * absent outside a secure context, and writeText can be refused; both
   * are ordinary outcomes, not exceptions.
   */

  let {
    text,
    what = "copy",
  }: {
    /** The exact recorded text to place on the clipboard. */
    text: string;
    /** What is being copied, for the accessible name ("copy the diff"). */
    what?: string;
  } = $props();

  import { COPY_CONFIRM_MS } from "./render-config.ts";
  import { onDestroy } from "svelte";
  import { VERB_MARK, VERB_MARK_WORD } from "../shell/verb-marks.ts";

  type Outcome = "idle" | "done" | "failed";
  let outcome = $state<Outcome>("idle");
  let timer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => { if (timer !== undefined) clearTimeout(timer); });

  async function copy(): Promise<void> {
    if (timer !== undefined) clearTimeout(timer);
    const clip = navigator.clipboard;
    if (clip === undefined) {
      outcome = "failed";
    } else {
      try {
        await clip.writeText(text);
        outcome = "done";
      } catch {
        outcome = "failed";
      }
    }
    timer = setTimeout(() => (outcome = "idle"), COPY_CONFIRM_MS);
  }

  const label = $derived(
    outcome === "done" ? "Copied" : outcome === "failed" ? "Copy failed" : VERB_MARK_WORD.copy,
  );
</script>

<button
  class="verb reveal-item copy"
  class:done={outcome === "done"}
  data-outcome={outcome === "idle" ? undefined : outcome}
  data-verb-id="copy"
  type="button"
  onclick={copy}
  aria-label={outcome === "idle" ? what : label}
  title={outcome === "idle" ? what : label}
>
  {VERB_MARK.copy}
</button>

<style>
  /* Outcome ink is this button's own report. Failed is NOT the answer
   * grammar's `failed` (a read this surface owes you broke) — it is a
   * press reporting what it did, so it is an outcome attribute. */
  .done {
    color: var(--ok);
  }
  [data-outcome="failed"] {
    color: var(--alarm);
  }
</style>
