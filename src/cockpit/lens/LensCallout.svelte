<script lang="ts">
  /**
   * THE LENS CALLOUT (DESIGN-COCKPIT-V2 §9.2) — ⌘L then hover: a single
   * hairline callout (NOT a panel) naming the pixel's source in plain words,
   * its derivation note when the pixel is computed, and the verbs
   * adjust · ask · open source. LENS is the universal answer to "why is this
   * here and how do I change it".
   *
   * DATA: the surviving LENS data layer, reached through the allowlisted
   * seam `src/state/lens.ts` (activate/point/answer over the Broker's own
   * read ledger — the Broker records every read at its choke point, so the
   * callout only ever SPEAKS records the choke point wrote; the no-invention
   * law is mutation-tested in tests/cockpit/lens-callout.test.ts).
   *
   * ZERO-COST WHEN CLOSED (the old LENS's proven pattern, re-expressed):
   * disarmed, this component renders nothing, holds no listeners beyond the
   * shell chord claim, and the provenance ledger has zero subscribers
   * (activateLens is called only on arm; provenanceListenerCount proves it).
   * Every listener below is added on arm and removed on disarm/unmount.
   */
  import { onMount } from "svelte";

  import type { OutletProps } from "../shell/contract.ts";
  import { chordLabel } from "../shell/keyboard.ts";
  import { roomExists } from "../shell/outlets.ts";
  import { uiSchema } from "../../state/schema-store.ts";
  import {
    activateLens,
    deactivateLens,
    lensActions,
    lensAnswer,
    lensNow,
    pointLensAt,
    tickLens,
  } from "../../state/lens.ts";
  import { LENS_TICK_MS } from "../../../shared/provenance.ts";
  import { openSettingSheet, openSettingForSignal } from "../settings/open.ts";
  import {
    actionClause,
    calloutVerbs,
    derivationNote,
    readTarget,
    sourceLine,
    type CalloutTarget,
  } from "./lens-callout-data.ts";

  let { shell }: OutletProps = $props();

  let armed = $state(false);
  let target = $state<CalloutTarget | null>(null);
  let x = $state(0);
  let y = $state(0);
  // `bind:this` writes null when the element is not mounted (the callout is
  // absent whenever LENS is disarmed or nothing is targeted), so the guard
  // below must test for null, not undefined.
  let rootEl = $state<HTMLElement | null>(null);
  let ticker: ReturnType<typeof setInterval> | null = null;

  const kLens = chordLabel({ key: "l", primary: true });

  const answer = $derived(target === null ? null : $lensAnswer);
  const line = $derived(
    target === null ? "" : sourceLine(target, answer, $lensNow),
  );
  const derivedNote = $derived(target === null ? null : derivationNote(target));
  // The write-side clause: rendered ONLY when the Broker recorded an action
  // on the same block this region's read came from (lens-callout-data owns
  // the matching rule and the words).
  const actedNote = $derived(target === null ? null : actionClause(answer, $lensActions));
  const verbs = $derived(
    target === null
      ? []
      : calloutVerbs(target, answer, {
          schema: $uiSchema,
          roomExists,
          openSheet: (id) => {
            disarm();
            openSettingSheet(shell, id);
          },
          openForSignal: (id) => {
            disarm();
            openSettingForSignal(shell, id);
          },
          prefill: (text) => {
            disarm();
            shell.prefillComposer(text);
          },
          openRoom: (room) => {
            disarm();
            shell.openRoom(room as Parameters<typeof shell.openRoom>[0]);
          },
        }),
  );

  function onPointerOver(ev: PointerEvent): void {
    const el = ev.target instanceof Element ? ev.target : null;
    // Hovering the callout itself must not retarget it onto itself.
    if (el !== null && rootEl !== null && rootEl.contains(el)) return;
    const next = readTarget(el);
    target = next;
    pointLensAt(next.provKey);
    // Anchor near the pointer, clamped so the hairline never leaves view.
    const CALLOUT_W = 360;
    const CALLOUT_H = 64;
    const px = Number.isFinite(ev.clientX) ? ev.clientX : 0;
    const py = Number.isFinite(ev.clientY) ? ev.clientY : 0;
    x = Math.max(0, Math.min(px + 12, window.innerWidth - CALLOUT_W));
    y = Math.max(0, Math.min(py + 16, window.innerHeight - CALLOUT_H));
  }

  function onScroll(): void {
    // A scrolled-away anchor would point at the wrong pixel — drop it.
    target = null;
    pointLensAt(null);
  }

  function arm(): void {
    if (armed) return;
    armed = true;
    activateLens();
    tickLens(Date.now());
    window.addEventListener("pointerover", onPointerOver, true);
    window.addEventListener("scroll", onScroll, true);
    ticker = setInterval(() => tickLens(Date.now()), LENS_TICK_MS);
    shell.hint(`LENS armed — hover any pixel to hear its source · Esc or ${kLens} closes`);
  }

  function disarm(): void {
    if (!armed) return;
    armed = false;
    target = null;
    window.removeEventListener("pointerover", onPointerOver, true);
    window.removeEventListener("scroll", onScroll, true);
    if (ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
    deactivateLens();
  }

  /**
   * ARMED IS A DISMISSIBLE STATE, declared to the shell.
   *
   * This used to be a capture-phase `keydown` listener added on arm, because
   * `claimKey` was last-claim-wins and the SWEEP had already taken `escape` —
   * so waiting for the shell would sometimes never disarm. The shell now owns
   * Esc and closes the innermost layer first (shell/routing.ts), and LENS is
   * exactly a layer: pushed on arm, released on disarm or unmount by this
   * effect's own cleanup. Zero-cost when closed still holds — a disarmed LENS
   * holds no layer, no listeners and no ledger subscribers.
   */
  $effect(() => {
    if (!armed) return;
    return shell.pushDismiss({ label: "LENS", dismiss: disarm });
  });

  onMount(() => {
    const unclaim = shell.claimKey("lens", () => (armed ? disarm() : arm()), {
      owner: "the LENS callout",
    });
    return () => {
      unclaim();
      disarm();
    };
  });
</script>

{#if armed && target !== null}
  <div
    bind:this={rootEl}
    class="callout"
    role="status"
    aria-label="lens — the pixel's source"
    style:left={`${x}px`}
    style:top={`${y}px`}
  >
    <p class="line">{line}</p>
    {#if actedNote !== null}
      <p class="line note">{actedNote}</p>
    {/if}
    {#if derivedNote !== null}
      <p class="line note">{derivedNote}</p>
    {/if}
    {#if verbs.length > 0}
      <div class="verbs">
        {#each verbs as verb (verb.id)}
          <button class="verb " data-verb-id={verb.id} onclick={verb.run}>{verb.label}</button>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .callout {
    position: fixed;
    z-index: 40;
    max-width: var(--switch-field-w);
    background: var(--ground-3);
    border: var(--hairline-w) solid var(--line-2);
    /* Achromatic on purpose: --beam is spent only on live event pixels
     * (§12.2); an inspection chrome edge is not one. */
    border-left: var(--rule-w) solid var(--line-2);
    border-radius: var(--radius-1);
    box-shadow: var(--shadow-sheet);
    padding: var(--sp-1) var(--sp-2);
    display: flex;
    flex-direction: column;
    gap: var(--sp-0);
    pointer-events: auto;
  }
  .line {
    margin: 0;
    font-family: var(--face-mono);
    font-size: var(--f-nano-size);
    color: var(--ink-1);
    overflow-wrap: anywhere;
  }
  .line.note {
    color: var(--ink-3);
    font-style: italic;
  }
  /* The verb row's recipe is owned by tokens.css (.cockpit .verbs). */
  .verbs {
    padding-top: var(--sp-0);
  }
  /* The verb recipe is owned by tokens.css (.cockpit .verb); this
   * room's verbs keep the smaller engraved register (.engraved-ctl,
   * carried as a marker class) and its own ink/pad. */
</style>
