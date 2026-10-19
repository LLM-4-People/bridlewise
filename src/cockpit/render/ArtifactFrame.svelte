<script lang="ts">
  /**
   * THE COCKPIT'S ARTIFACT RENDERER — the one place a model-built document is
   * mounted, and the boundary it is mounted behind.
   *
   * A `create_artifact` call carries a complete HTML document in its
   * arguments. This puts it on screen, live, inside the beat, so the user can
   * play the game and edit the table rather than read the source of one.
   *
   * ── WHAT KEEPS IT IN ──────────────────────────────────────────────────────
   *
   * THE USER'S REPORT, VERBATIM: "it seems like artifacts are breaking the
   * page, we should make sure they are contained properly so it cannot
   * happen."
   *
   * Five things, each measured in a live frame before it was relied on. The
   * measurements and their exact numbers are recorded in `artifact.ts`; what
   * follows is what THIS component does about them.
   *
   *   THE SANDBOX. `sandbox` comes from the config owner
   *   (`artifactSandboxToken`), which reads the configured token and strips
   *   `allow-same-origin` through the shared security owner. This component
   *   never reads the config and never names a token, so there is no path by
   *   which one could be widened here. Probed: the parent's DOM, cookies,
   *   localStorage, sessionStorage and IndexedDB all throw SecurityError from
   *   inside; top-level navigation throws; `window.open` returns null;
   *   `requestFullscreen` does not take.
   *
   *   THE POLICY. `srcdoc` is composed by the shared CSP owner
   *   (`sandboxedSrcdoc`), the same one the editor's HTML preview uses, so
   *   there is one policy and not two. It blocks all network
   *   (`connect-src 'none'`) and every external resource — probed: an
   *   `<img src="https://…">` inside a frame stays at zero width.
   *
   *   THE SIZE. The frame's height is DECLARED, from the artifact's kind
   *   and the beat's expand gesture (`frameHeight`) — a compact box at
   *   rest, a taller one when the reader asked for more, both constants of
   *   the kind — and set as an inline custom property rather than left
   *   to the content. The artifact scrolls inside it. Probed: an artifact
   *   that appended 20,000 rows and set its document to 9,999,999px moved the
   *   host's scroll extent by zero pixels. This is what protects the flow's
   *   height index, which measures each beat once.
   *
   *   THE SILENCE, NARROWED TO ONE SENTENCE. A sandboxed frame can still
   *   `postMessage` at its parent — that is not blockable — and the cockpit
   *   used to answer by having NOTHING on this side that could act on it.
   *   That silence also meant a `null` dereference on line 1 produced a dead
   *   rectangle with no explanation to anyone, which is the fabricated-absence
   *   failure (DESIGN-PERFORMANCE §1 L3) arriving through the security door.
   *   The silence is now narrowed rather than broken: EXACTLY ONE listener
   *   exists in the cockpit, it lives in `artifact-errors.ts`, it accepts one
   *   message shape from a window it registered itself, and it does nothing
   *   with it but record it. THIS COMPONENT STILL DOES NOT LISTEN, does not
   *   post, and never touches `contentWindow` — it hands the owner the frame
   *   ELEMENT and reads back a state. Guarded in
   *   tests/cockpit/artifact-containment.test.ts §F.
   *
   *   THE LIFETIME. The frame exists only while this component is mounted,
   *   and the flow only mounts beats inside its scroll window. An artifact far
   *   back in a long conversation is not a throttled animation loop, it is
   *   absent. `remount` (the "restart" verb) is the same mechanism turned into
   *   a control: it destroys the frame and builds a new one, which is the only
   *   honest way to restart a document we cannot reach into.
   *
   *   WHAT IS NOT CLAIMED: that a hostile artifact cannot burn CPU or memory
   *   in its own process. Chrome gave the frame its own renderer when
   *   measured, and a three-second synchronous block inside it left the host's
   *   timers within 10ms of their idle baseline — but that is one browser's
   *   behaviour observed once, not a guarantee this code can make.
   *
   * ── AND WHEN THERE IS NOTHING TO SHOW ─────────────────────────────────────
   *
   * The frame slot is rendered for every artifact beat, whichever way the call
   * went — that is the symmetric-detail rule, and it is why this component
   * takes a `view` that is either a document or a REASON, never a status. A
   * refused artifact shows the refusal, in the tool's own words where it has
   * them, labelled as the tool's. It never shows an empty rectangle.
   *
   * ── AND WHEN IT SHOWED SOMETHING, THEN BROKE ──────────────────────────────
   *
   * There are now THREE honest states, not two, and the reader must be able to
   * tell them apart:
   *
   *   NEVER RAN    — the absence branch. No frame, a sentence saying why.
   *   RUNNING      — a live frame, nothing else.
   *   RAN, THEN THREW — a live frame AND the fault strip over its lower edge.
   *
   * The third does NOT blank the frame. A game whose title screen drew and
   * whose engine died is still worth looking at, and blanking it would destroy
   * the one piece of evidence that distinguishes "ran and broke" from "never
   * ran". The strip is ABSOLUTELY POSITIONED inside the declared box, so the
   * beat's height when it appears is the beat's height before it appeared —
   * which is not cosmetic here: the flow measures each beat once and indexes
   * it, so a strip that pushed layout would move the scroll position of every
   * beat below it, seconds after the user had settled on one.
   */
  import { artifactSandboxToken } from "../../state/web-ui-config.ts";
  import { sandboxedSrcdoc } from "./html-preview.ts";
  import CopyButton from "./CopyButton.svelte";
  import Answer from "../response/Answer.svelte";
  import { absent } from "../response/grammar.ts";
  import { frameHeight, type ArtifactView } from "./artifact.ts";
  import {
    artifactErrors,
    EMPTY_STATE,
    REPORTER_SCRIPT,
    sayError,
    sayFault,
    saySuppressed,
    type ArtifactErrorState,
  } from "./artifact-errors.ts";

  /**
   * `frameKey` is the beat's id, and it is what a runtime error is ATTRIBUTED
   * to. It is required rather than defaulted: a frame with no key is a frame
   * whose failures would land nowhere, and a silent default is how that
   * becomes true by accident.
   *
   * `expanded` is the beat's expand gesture. It grows the stage VERTICALLY
   * (the taller declared height for the kind) and nothing else — the frame's
   * width is the column it sits in, which the gesture does not touch. False
   * by default so every mount that did not ask (the editor's page preview)
   * keeps the compact box.
   */
  let {
    view,
    frameKey,
    expanded = false,
  }: { view: ArtifactView; frameKey: string; expanded?: boolean } = $props();

  /**
   * The sandbox token, from the single config owner. The owner applies the
   * hardening (`allow-same-origin` can never survive it); this component only
   * consumes the result, so there is nothing to forget here.
   */
  const sandboxToken = $derived($artifactSandboxToken);

  const doc = $derived(view.kind === "document" ? view : null);

  /**
   * The composed frame document — the CSP meta from the shared owner, then the
   * error reporter, then the artifact, verbatim. Never interpolated into this
   * page.
   *
   * The reporter goes in through the SAME `sandboxedSrcdoc` call, not beside
   * it: the CSP must stay the document's first policy, and the owner of the
   * line arithmetic (`ARTIFACT_LINE_OFFSET`) measures this exact composition,
   * so the artifact-relative line numbers cannot drift from what is actually
   * sent.
   */
  const srcdoc = $derived(doc === null ? "" : sandboxedSrcdoc(REPORTER_SCRIPT + doc.content));

  /**
   * The declared height, from the kind and the expand gesture alone. Never
   * from the content.
   */
  const heightPx = $derived(doc === null ? 0 : frameHeight(doc.type, expanded));

  /**
   * Bumping this rebuilds the iframe element (it is the keyed identity), which
   * is the only way to restart a document whose scripts we cannot reach.
   */
  let generation = $state(0);

  /** The live frame element, handed to the error owner. Never read into. */
  let frameEl: HTMLIFrameElement | undefined = $state();

  /** What this frame has reported about its own failures. */
  let fault = $state<ArtifactErrorState>(EMPTY_STATE);

  // THE OWNER LEARNS WHICH WINDOW IS THIS FRAME'S. It is given the ELEMENT,
  // not the window: a frame's `contentWindow` is replaced on remount, and the
  // owner reading it fresh at message time is what stops a stale window being
  // accepted as the live one. It also keeps `contentWindow` out of this file
  // entirely, which the containment test still forbids here.
  $effect(() => {
    const el = frameEl;
    if (el === undefined || frameKey.length === 0) return;
    return artifactErrors.watch(frameKey, el);
  });

  $effect(() => {
    if (frameKey.length === 0) {
      fault = EMPTY_STATE;
      return;
    }
    return artifactErrors.subscribe(frameKey, (s) => {
      fault = s;
    });
  });

  const faulted = $derived(fault.errors.length > 0 || fault.suppressed > 0);
  const suppressedSay = $derived(saySuppressed(fault));

  /**
   * Restart destroys the document AND its record of failure. A fresh document
   * has not thrown yet; leaving the old one's errors over it would be stale by
   * construction, and stale is the same defect as fabricated.
   */
  function restart(): void {
    generation += 1;
    artifactErrors.reset(frameKey);
  }
</script>

{#if doc !== null}
  <div class="artifact" data-field="artifact-frame">
    <div class="head">
      <span class="title trunc" data-artifact="title">{doc.title}</span>
      <span class="kind engraved" data-artifact="kind">{doc.type}</span>
      <span class="bytes" data-artifact="bytes"
        >{doc.bytes.toLocaleString("en-US")} bytes</span
      >
      <span class="grow"></span>
      <!-- The document is COPYABLE but never rendered into this page as text.
           A 55KB artifact laid out as a code block is 1,177 lines the reader
           did not ask for and the virtualizer has to measure; the clipboard
           carries it at no cost to the flow. -->
      <CopyButton text={doc.content} what="copy this artifact's HTML" />
      <button
        class="live-word restart"
        type="button"
        title="destroy this frame and build a fresh one"
        onclick={(e) => {
          e.stopPropagation();
          restart();
        }}>Restart</button
      >
    </div>
    <!-- THE STAGE holds the declared box and nothing else. The fault strip is
         its absolutely-positioned child, so the strip's arrival changes no
         height the flow has already measured. -->
    <div class="stage" data-artifact="stage">
      {#key generation}
        <!-- svelte-ignore a11y_missing_attribute (title is set below) -->
        <iframe
          bind:this={frameEl}
          class="frame"
          data-artifact="frame"
          style="height: {heightPx}px"
          title={doc.title}
          srcdoc={srcdoc}
          sandbox={sandboxToken}
          referrerpolicy="no-referrer"
          loading="lazy"
        ></iframe>
      {/key}
      {#if faulted}
        <!-- THE ARTIFACT'S OWN ACCOUNT OF ITS FAILURE, said as the artifact's
             and never as our measurement — the same attribution rule the
             refusal branch below obeys for the tool's words. Locations are
             artifact-relative (the line the model wrote), matching how
             server/artifact-check.ts reports a parse fault. When the browser
             withheld a location, that is stated; none is invented. -->
        <div class="fault" data-artifact="runtime-error" role="status">
          <span class="fault-label engraved" data-artifact="runtime-headline">{sayFault(fault)}</span>
          <ul class="fault-list">
            {#each fault.errors as err, i (i)}
              <li class="fault-line" data-artifact="runtime-detail">{sayError(err)}</li>
            {/each}
          </ul>
          {#if suppressedSay.length > 0}
            <!-- THE CAP, STATED. A hostile artifact can post without end; the
                 host keeps a bounded number and says how many it did not. A
                 suppressed error the reader cannot see the existence of is the
                 same lie as an empty rectangle. -->
            <div class="fault-suppressed" data-artifact="runtime-suppressed">{suppressedSay}</div>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{:else if view.kind === "absence"}
  <!-- NOTHING IS FABRICATED. The reason is ours and reads as ours; the tool's
       own words are quoted and attributed, never merged into our sentence.

       The branch tests `view.kind` rather than being a bare `{:else}`, and the
       difference is not stylistic: `doc` is a SEPARATE derived, so narrowing on
       it tells the checker nothing about `view`, and `view.reason` /
       `view.detail` were being read off a union that might have been the
       document arm. The union has exactly these two arms, so this covers
       everything a bare `{:else}` did. -->
  <div class="artifact stacked" data-field="artifact-frame">
    <div data-artifact="absence"><Answer answer={absent(view.reason)} /></div>
    {#if view.detail !== undefined}
      <div class="detail" data-artifact="detail">
        <span class="detail-label engraved">what the tool reported</span>
        <pre class="detail-text">{view.detail}</pre>
      </div>
    {/if}
  </div>
{/if}

<style>
  .artifact {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    min-width: 0;
  }
  /* The row-header spine is owned by tokens.css (.cockpit .head); this rule
   * keeps only the frame's own additions (the hit-floor min-height and the
   * wrap a long title earns). The engraved WORDS inside wear the owned
   * `.engraved` marker — the container does not restate the register. */
  .head {
    min-height: var(--hit-min);
    flex-wrap: wrap;
  }
  .title {
    color: var(--ink-1);
    font-family: var(--face-mono);
    font-size: var(--f-micro-size);
    min-width: 0;
    max-width: 100%;
  }
  /* A mono data readout, not an engraved label: micro-size + the quiet ink,
   * tabular figures for the byte count. */
  .bytes {
    font-family: var(--face-mono);
    font-size: var(--f-micro-size);
    font-variant-numeric: tabular-nums;
    color: var(--ink-3);
  }
  .grow {
    flex: 1;
  }
  /* The restart grip consumes the owned live-word recipe (tokens.css
   * `.cockpit .live-word` — the dotted-underline "this word is live"
   * affordance that recipe owns since three surfaces needed it); this rule
   * keeps only the frame's own TYPE REGISTER (micro mono, the quiet ink a
   * chrome word wears here) — the affordance is not restated. */
  .restart {
    font-family: var(--face-mono);
    font-size: var(--f-micro-size);
    letter-spacing: var(--f-micro-track);
    color: var(--ink-3);
  }
  /* THE DECLARED BOX. The height is written straight onto the element from
   * `frameHeight(kind)` — one hop, nothing between the declaration and the
   * box, nothing for a stylesheet to override. An artifact that lays itself
   * out larger scrolls INSIDE its own document and cannot push on ours.
   * Nothing here reads the content. */
  .frame {
    display: block;
    width: 100%;
    border: var(--hairline-w) solid var(--line-1);
    border-radius: var(--radius-1);
    background: var(--ground-2);
    overflow: hidden;
    /* An artifact cannot be allowed to hand itself a pointer gesture the
     * flow needs; scrolling inside the frame stays inside the frame. */
    overscroll-behavior: contain;
  }
  /* THE STAGE. Its height IS the frame's declared height and nothing else —
   * it exists only to give the fault strip a containing block, so the strip
   * can appear without moving one pixel the flow has already measured. */
  .stage {
    position: relative;
    min-width: 0;
  }
  /* THE THIRD HONEST STATE. Over the frame's lower edge, never in place of
   * the frame: the reader must be able to tell "never ran" (no frame at all,
   * the .absent branch) from "ran and broke" (a frame, plus this).
   *
   * NO MOTION. Nothing here transitions or animates: this strip is a STATE,
   * not a transition, and §11.8's no-fake-motion law only licenses motion that
   * traces a recorded event. That also makes prefers-reduced-motion satisfied
   * by construction rather than by an override that could be forgotten. */
  .fault {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    max-height: var(--artifact-fault-max-h);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: var(--sp-1) var(--sp-2);
    background: var(--ground-1);
    border-top: var(--hairline-w) solid var(--alarm);
    display: flex;
    flex-direction: column;
    gap: var(--sp-0);
  }
  /* The engraved recipe is owned by tokens.css (.cockpit .engraved); the
   * fault label spends the alarm ink over it. */
  .fault-label {
    color: var(--alarm);
  }
  .fault-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--sp-0);
  }
  .fault-line,
  .fault-suppressed {
    font-family: var(--face-mono);
    font-size: var(--f-code-size);
    line-height: var(--f-code-lh);
    color: var(--ink-2);
    overflow-wrap: anywhere;
  }
  .fault-suppressed {
    color: var(--ink-3);
    font-style: italic;
  }
  /* LAYOUT ONLY. The rule that used to live here decided what an absence
   * LOOKS like — ink-4, italic — which is the one thing a room may not decide
   * for itself; the response grammar owns it now. What remains is the gutter
   * between the sentence and the tool's quoted detail, which is this frame's
   * own business. */
  .stacked {
    gap: var(--sp-1);
  }
  /* The engraved recipe is owned by tokens.css (.cockpit .engraved). */
  .detail-label {
    display: block;
  }
  .detail-text {
    margin: 0;
    font-family: var(--face-mono);
    font-size: var(--f-code-size);
    line-height: var(--f-code-lh);
    color: var(--ink-2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: var(--cell-max-h);
    overflow-y: auto;
  }
</style>
