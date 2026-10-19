<script lang="ts">
  /**
   * THE CONNECTION BLOCK — what the whole cockpit does when the API is gone.
   *
   * THE USER'S INSTRUCTIONS, VERBATIM:
   *   "the entire ux must be instantly blocked when api is offline unhealthy
   *    or not responding and show a proper message. it must also reconnect by
   *    itself and clear error/blocking state"
   *   "we must show a big error with everything else underneith it"
   *   "blank is good yeah" / "as long as we dont see ux elements otherwise
   *    its confusing"
   *
   * So: a large, unmissable statement of the failure on an OPAQUE ground,
   * with no cockpit chrome showing through it.
   *
   * ── THE SCREEN IS HIDDEN; THE DATA IS NOT DISCARDED ──────────────────────
   *
   * An earlier draft of this component dimmed the cockpit to 70% and left it
   * readable underneath, on the reasoning that losing the connection does not
   * un-measure what the server already said. The user overruled it, and the
   * reason they gave is the better one: half-visible controls behind a modal
   * read as operable, and a control that looks live while doing nothing is
   * more confusing than no control at all.
   *
   * WHAT THAT DOES AND DOES NOT MEAN. It hides the SCREEN. It does not throw
   * anything away: the nanostores keep their values, the Broker deliberately
   * keeps its cached entries through a failed read (`broker.ts::issue`), and
   * nothing here calls a reset. So the recovery is not a reload — when the
   * API answers, this panel unmounts and the cockpit underneath is the
   * cockpit that was there, at its scroll position, with its rooms still
   * mounted, revalidating in place. Blanking the VIEW while keeping the
   * KNOWLEDGE is what makes "it clears by itself" instant rather than a boot.
   *
   * ── WHY `slow` DOES NOT BLOCK ────────────────────────────────────────────
   *
   * A DESIGN DECISION, mine, not a user quote. `slow` means a request has
   * been open past the patience threshold and NOTHING HAS FAILED. Blocking
   * there would freeze the cockpit every time a genuinely large read took two
   * seconds — unusable on exactly the conversations DESIGN-PERFORMANCE §1 L2
   * measures at tens of seconds. So `slow` gets a thin bar with its plain
   * words and its ticking clock and no block: it states the condition without
   * pretending the app has stopped. The big panel arrives when the API has
   * actually failed to answer — refused, or timed out — which is when acting
   * is genuinely futile.
   *
   * ── RECOVERY ─────────────────────────────────────────────────────────────
   *
   * Automatic and visible, and owned entirely by `connection.ts`: it re-probes
   * on a timer and on tab focus, and the moment the API answers it flips the
   * state and revalidates every standing read. This component has no timer for
   * retrying, no retry logic and no memory of its own — it renders the state
   * and offers the one verb that skips the wait. That is why "it clears by
   * itself" is a property of the system rather than a promise made here.
   */
  import {
    connection,
    connectionMessage,
    probeConnectionNow,
  } from "../../data/connection.ts";
  import { focusSurface } from "./Popover.svelte";

  // NOT named `state`: `$state` is a rune, and a component-scope binding called
  // `state` makes every `$state(…)` in this file ambiguous with a store read of
  // it — which is exactly how the template checker read line 72 below.
  const conn = $derived($connection);
  const blocking = $derived(conn.kind === "unreachable");
  const say = $derived(connectionMessage(conn));
  let panel = $state<HTMLElement | null>(null);
  let opener: Element | null = null;
  // Capture before the shell applies inert; native inert moves focus to BODY.
  $effect.pre(() => { if (blocking) opener = document.activeElement; });
  $effect(() => {
    if (panel !== null) return focusSurface(panel, true, opener);
    return undefined;
  });

  /**
   * HOW LONG IT HAS BEEN, ticking. The only moving pixel while the app is
   * blocked, and it is honest motion: it asserts that time passed — true, and
   * measured from a real timestamp — never that anything arrived. A spinner
   * asserts activity that may not exist, which is precisely the claim that
   * cannot be made here.
   */
  let nowMs = $state(Date.now());
  $effect(() => {
    if (conn.kind === "reachable") return;
    const id = setInterval(() => {
      nowMs = Date.now();
    }, 500);
    return () => clearInterval(id);
  });
  const heldSeconds = $derived(
    conn.kind === "reachable" ? 0 : Math.max(0, Math.round((nowMs - conn.since) / 1000)),
  );

  /** What the reader can DO about it, in plain words. Never "try again
   *  later" — it names the actual remedy for the actual cause. */
  const remedy = $derived.by<string>(() => {
    if (conn.kind !== "unreachable") return "";
    return conn.cause === "refused"
      ? "Start the harness API server, then this screen clears on its own — there is nothing to click and no reload to do."
      : "The server is reachable but stopped answering in time. It may be busy; this screen clears on its own the moment it answers.";
  });
</script>

{#if conn.kind === "slow"}
  <!-- NOT an error, so not the panel. A slow request is a condition to state,
       not a failure to announce — same location as the panel's own headline
       so a reader learns one place to look. -->
  <div class="bar" role="status" aria-live="polite" data-field="connection-bar" data-connection="slow">
    <span class="mark" aria-hidden="true">◈</span>
    <span class="say">{say}</span>
    <span class="held" data-field="connection-held">{heldSeconds}s</span>
  </div>
{/if}

{#if blocking}
  <!-- THE GROUND. Fully opaque, over everything: no cockpit element shows
       through, so there is nothing on screen that looks operable and is not.
       The shell also marks its own subtree `inert` while this is up, which
       is what actually removes those controls from the pointer, the tab
       order and the accessibility tree — this element is the visual half of
       the same statement, never the enforcement. -->
  <div class="scrim" data-field="connection-scrim"></div>

  <div
    class="cockpit panel"
    bind:this={panel}
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="connection-error-title"
    aria-describedby="connection-error-detail"
    data-field="connection-error"
    data-cause={conn.kind === "unreachable" ? conn.cause : undefined}
  >
    <p class="kicker engraved">Not connected</p>
    <h1 id="connection-error-title" class="title">{say}</h1>
    <p id="connection-error-detail" class="detail">{remedy}</p>
    <p class="meta">
      <span class="held" data-field="connection-held">{heldSeconds}s</span>
      <span class="sep" aria-hidden="true">·</span>
      <span>Retrying automatically</span>
    </p>
    <button class="verb primary" onclick={probeConnectionNow}>Try now</button>
  </div>
{/if}

<style>
  /* ── The slow bar (stated, not blocking) ── */
  .bar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 60;
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-1) var(--sp-3);
    background: var(--ground-3);
    border-bottom: var(--hairline-w) solid var(--warn);
    font-size: var(--f-micro-size);
    font-weight: var(--f-micro-weight);
    letter-spacing: var(--f-micro-track);
  }
  .mark {
    color: var(--warn);
    line-height: var(--lh-tight);
  }
  .say {
    color: var(--ink-1);
  }

  /* ── The block ── */
  .scrim {
    position: fixed;
    inset: 0;
    /* Over everything the shell can raise (rooms and the lens sit at 30),
     * under the panel it grounds. */
    z-index: 55;
    /* OPAQUE. No `opacity` — a translucent ground is exactly the "we see ux
     * elements" the user called confusing. */
    background: var(--ground-0);
  }
  /* BIG, and centred over the whole viewport — the user asked for an error
   * that cannot be missed. It sits on the opaque ground above, so what is
   * around it is ground and nothing else — no half-visible chrome. */
  .panel {
    position: fixed;
    z-index: 60;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    /* Token-derived, never a raw length: --sp-7 is the largest step, and
     * sixteen of them is the widest a sentence should run before it stops
     * being one line of thought. */
    width: min(calc(var(--sp-7) * 16), calc(100vw - 2 * var(--sp-5)));
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    padding: var(--sp-5);
    background: var(--ground-2);
    border: var(--hairline-w) solid var(--alarm);
  }
  /* The engraved recipe is owned by tokens.css (.cockpit .engraved); the
   * kicker spends the alarm ink over it. */
  .kicker {
    margin: 0;
    color: var(--alarm);
  }
  .title {
    margin: 0;
    color: var(--ink-1);
    /* The one place in the cockpit that shouts, and it uses the scale the
     * token file already reserves for "the one big thing on screen". It is
     * earned: the app cannot do anything at all until this resolves. */
    font-size: var(--f-value-size);
    font-weight: var(--f-heading-weight);
    line-height: var(--f-heading-lh);
  }
  .detail {
    margin: 0;
    max-width: 60ch;
    color: var(--ink-2);
    line-height: var(--lh-readout);
  }
  .meta {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin: 0;
    color: var(--ink-3);
    font-size: var(--f-micro-size);
    letter-spacing: var(--f-micro-track);
  }
  /* Reserved, tabular: the clock ticks once a second and must not reflow the
   * words beside it every time a digit changes. */
  .held {
    min-width: 4ch;
    font-variant-numeric: tabular-nums;
  }
  /* The verb recipe is owned by tokens.css (.cockpit .verb); the connection
   * block's verb keeps its dimmer resting bezel and wider pad. */
  .verb { align-self: flex-start; }
</style>
