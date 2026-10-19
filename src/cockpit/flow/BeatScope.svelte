<script lang="ts">
  /**
   * THE SCOPE SHEET for a beat — "we can still click to show maximum
   * details" (the user's own framing). This sheet has to EARN that click.
   *
   * WHAT IT USED TO SHOW, pasted verbatim by the user with the message
   * "what is this":
   *
   *     turn · turn 4
   *     close
   *     turn
   *     at 10:23:15
   *     turn 4
   *     caused by b-57bf9380-b910-47e9-a93d-7eb674e37942
   *     retry
   *     copy
   *
   * Four failures, all the same failure — the sheet described the RECORD
   * instead of showing the THING:
   *
   *   1. a raw internal id on screen. `b-57bf9380…` is an address, not a
   *      fact: it means nothing to a person and cannot be acted on;
   *   2. "turn" — internal vocabulary — used as the user-facing noun;
   *   3. that noun repeated three times (cap, field, value) for one idea;
   *   4. no substance: the maximum-detail view of a message showed no
   *      message.
   *
   * WHAT IT SHOWS NOW, in this order:
   *
   *   WHAT THIS IS — one plain sentence (types.ts `beatNoun`) with the time,
   *                  together, because a timestamp belongs to the thing it
   *                  stamps rather than to a list of fields;
   *   THE CONTENT  — the beat's real body, expanded. The reason the sheet
   *                  exists;
   *   CAUSALITY    — a plain-language reference to the THING it points at
   *                  ("in reply to your message at 10:23:12") and a BUTTON,
   *                  because following the causal chain is the whole point
   *                  of this recording;
   *   VERBS        — what can be done from here;
   *   THE PRECISE RECORD — one level deeper, behind a fold: the ids, for
   *                  when someone genuinely needs to address a row. They
   *                  are real and stay reachable; they are just not the body.
   */
  import TurnBeat from "./TurnBeat.svelte";
  import ToolBeat from "./ToolBeat.svelte";
  import EffectBeat from "./EffectBeat.svelte";
  import CheckDeltaBeat from "./CheckDeltaBeat.svelte";
  import EventBeat from "./EventBeat.svelte";
  import ActBeat from "./ActBeat.svelte";
  import Seam from "./Seam.svelte";
  import FindingNote from "../computer/FindingNote.svelte";
  import Verb from "./Verb.svelte";
  import JsonView from "../render/JsonView.svelte";
  import { beatById } from "./log.ts";
  import { beatNoun, causalPhrase, type Beat } from "./types.ts";
  import {
    eventDocumentsLoads,
    loadEventDocuments,
    type EventDocumentsLoad,
  } from "../../state/timeline-event-documents.ts";

  let {
    beat,
    projectPath = null,
    onfocusbeat = undefined,
  }: {
    beat: Beat;
    projectPath?: string | null;
    /** Focus a beat in the flow — the causal reference's click path. Absent
     * when the host cannot move the flow; the reference then renders as
     * plain text rather than as a button that would do nothing (§1.2). */
    onfocusbeat?: ((id: string) => void) | undefined;
  } = $props();

  const HHMMSS_LEN = 8; // "14:02:07"
  function clockOf(at: number): string {
    return new Date(at).toTimeString().slice(0, HHMMSS_LEN);
  }

  const when = $derived(clockOf(beat.at));
  const noun = $derived(beatNoun(beat));

  /** The beat this one was caused by, when the record names one we still hold. */
  const parent = $derived(beat.parentId !== null ? beatById(beat.parentId) : undefined);

  // ── THE RECORDED DOCUMENTS — the event beat's own payload, behind a
  // fold that costs nothing closed and reads NOTHING until opened. Only an
  // EVENT beat whose record carries a canonical address can have documents
  // (tool beats are message-backed transcripts, not ledger rows; a
  // client-side error was never recorded anywhere).
  const documentsEventId = $derived(
    beat.kind === "event" && beat.event?.eventId !== undefined ? beat.event.eventId : null,
  );
  // Subscribed through `$` — a `.get()` inside a $derived would evaluate
  // once and never re-run when the load settles (the wired-but-inert
  // class; the subscription IS the fold's liveness).
  const documentsLoad: EventDocumentsLoad | undefined = $derived(
    documentsEventId !== null ? $eventDocumentsLoads.get(documentsEventId) : undefined,
  );

  /**
   * The LAZY READ: the fetch happens when the fold is OPENED, never when
   * the sheet renders — an unopened fold is pure absence (the Jaeger
   * prior: fold, then read). Reopening after a failure is the honest
   * retry (`loadEventDocuments` re-reads only failed loads).
   */
  function onDocumentsToggle(open: boolean): void {
    if (open && documentsEventId !== null) {
      void loadEventDocuments(documentsEventId);
    }
  }
</script>

<div class="beat-scope">
  <!-- WHAT THIS IS — one statement, once, with the time it belongs to. -->
  <p class="what">{noun} <span class="when">at {when}</span></p>

  <!-- THE CONTENT — the reason this sheet exists. -->
  <div class="body">
    {#if beat.kind === "turn"}
      <TurnBeat {beat} />
    {:else if beat.kind === "tool"}
      <ToolBeat {beat} expanded={true} />
    {:else if beat.kind === "effect"}
      <EffectBeat {beat} expanded={true} {projectPath} />
    {:else if beat.kind === "check-delta"}
      <CheckDeltaBeat {beat} />
    {:else if beat.kind === "event"}
      <EventBeat {beat} />
    {:else if beat.kind === "act"}
      <ActBeat {beat} />
    {:else if beat.kind === "seam"}
      <Seam {beat} />
    {:else if beat.kind === "finding" && beat.finding !== undefined}
      <FindingNote
        sentence={beat.finding.sentence}
        derivation={beat.finding.derivation}
        verbs={beat.verbs}
      />
    {/if}
  </div>

  <!-- CAUSALITY — the thing, not its address. -->
  {#if parent !== undefined}
    <p class="cause">
      {#if onfocusbeat !== undefined}
        <button
          class="cause-link"
          data-verb-id="flow.focus/cause"
          title="focus the beat this one was caused by"
          onclick={() => onfocusbeat(parent.id)}
        >
          {causalPhrase(parent)} at {clockOf(parent.at)}
        </button>
      {:else}
        <span class="cause-text">{causalPhrase(parent)} at {clockOf(parent.at)}</span>
      {/if}
    </p>
  {:else if beat.parentId !== null}
    <!-- The record names a cause this session no longer holds. Say that,
         rather than printing the address of something we cannot show. -->
    <p class="cause"><span class="cause-text">what caused this is not in the loaded history</span></p>
  {/if}

  {#if beat.kind !== "seam" && beat.kind !== "finding" && beat.verbs.length > 0}
    <div class="verbs">
      {#each beat.verbs as verb (verb.id)}
        <Verb {verb} />
      {/each}
    </div>
  {/if}

  <!-- THE RECORDED DOCUMENTS — the event's own recorded payload, one level
       deeper than the body, behind a fold that reads NOTHING until opened.
       Rendered name-agnostic (whatever documents the record holds), through
       the render layer's public JSON door — never prose-summarized here. -->
  {#if documentsEventId !== null}
    <details class="record" ontoggle={(e) => onDocumentsToggle((e.currentTarget as HTMLDetailsElement).open)}>
      <summary class="record-grip engraved">the recorded documents</summary>
      <div class="documents">
        {#if documentsLoad === undefined}
          <!-- Closed-then-opened this instant: the read is in flight. -->
          <p class="documents-state">reading the record…</p>
        {:else if documentsLoad.kind === "pending"}
          <p class="documents-state">reading the record…</p>
        {:else if documentsLoad.kind === "absent"}
          <!-- The door's own deny-by-default: a 404 is a stated absence on
               the record the reader is already reading, not an error. -->
          <p class="documents-state">{documentsLoad.reason}</p>
        {:else if documentsLoad.kind === "failed"}
          <p class="documents-state">{documentsLoad.reason} — close and reopen the fold to retry</p>
        {:else if documentsLoad.documents.length === 0}
          <p class="documents-state">this event recorded no documents</p>
        {:else}
          {#each documentsLoad.documents as doc (doc.name)}
            <div class="document">
              <p class="document-name mono">{doc.name}</p>
              {#if doc.contentJson === null && doc.orderedJson === null}
                <p class="documents-state">this document recorded no content</p>
              {:else}
                <JsonView value={doc.content} />
              {/if}
            </div>
          {/each}
        {/if}
      </div>
    </details>
  {/if}

  <!-- THE PRECISE RECORD — one level deeper. Real, reachable, not the body. -->
  <details class="record">
    <summary class="record-grip engraved">the precise record</summary>
    <dl class="record-rows">
      <dt>this row</dt>
      <dd>{beat.id}</dd>
      {#if beat.parentId !== null}
        <dt>caused by row</dt>
        <dd>{beat.parentId}</dd>
      {/if}
      <dt>exchange</dt>
      <dd>{beat.turnIndex + 1}</dd>
    </dl>
  </details>
</div>

<style>
  .beat-scope {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
  }
  /* The one statement of what this is. Reading face, sentence case — this is
   * a sentence to a person, not an engraved instrument label. */
  .what {
    margin: 0;
    font-size: var(--f-ui-size);
    color: var(--ink-1);
  }
  .when {
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
  }
  .cause {
    margin: 0;
  }
  .cause-link {
    appearance: none;
    background: none;
    border: none;
    border-radius: var(--radius-1);
    display: inline-flex;
    align-items: center;
    min-height: var(--hit-min);
    padding: 0 var(--sp-1);
    font: inherit;
    font-size: var(--f-ui-size);
    color: var(--ink-2);
    text-decoration: underline;
    text-underline-offset: var(--sp-0);
    cursor: pointer;
    text-align: left;
  }
  .cause-link:hover {
    background: var(--layer-hover);
    color: var(--ink-1);
  }
  .cause-text {
    font-size: var(--f-ui-size);
    color: var(--ink-3);
  }
  /* The verb row's recipe is owned by tokens.css (.cockpit .verbs). */
  .verbs {
    gap: var(--sp-2);
    flex-wrap: wrap;
  }
  .record {
    border-top: var(--hairline-w) solid var(--line-1);
    padding-top: var(--sp-2);
  }
  .record-grip {
    display: inline-flex;
    align-items: center;
    min-height: var(--hit-min);
    font-family: var(--face-mono);
    cursor: pointer;
  }
  .record-grip:hover {
    color: var(--ink-1);
  }
  .record-rows {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--sp-1) var(--sp-3);
    margin: var(--sp-2) 0 0;
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
  }
  .record-rows dt {
    color: var(--ink-3);
    white-space: nowrap;
  }
  .record-rows dd {
    margin: 0;
    color: var(--ink-2);
    overflow-wrap: anywhere;
  }
  /* The documents fold: the record's payload, stacked per document. The
   * states are sentences in the sheet's own register (absence/failure are
   * stated, never faked); the payload itself renders through JsonView. */
  .documents {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    margin: var(--sp-2) 0 0;
  }
  .documents-state {
    margin: 0;
    font-size: var(--f-ui-size);
    color: var(--ink-3);
  }
  .document {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }
  .document-name {
    margin: 0;
    font-size: var(--f-data-size);
    color: var(--ink-2);
  }
  .mono {
    font-family: var(--face-mono);
  }
</style>
