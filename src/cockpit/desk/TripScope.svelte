<script lang="ts">
  /**
   * SCOPE body for a tripped breaker's [why] (§3.5): the RECORDED trip
   * event from the ledger — the `permission`/denied record the boundary
   * appended when it flipped the tool off. Nothing is reconstructed: the
   * scope shows the record or its honest absence.
   */
  import { fetchJson } from "../../data/broker.ts";
  import type { TimelineEventSummary, TimelineEventSummariesResult } from "../../../shared/types.ts";
  import Answer from "../response/Answer.svelte";
  import { absent, pending } from "../response/grammar.ts";
  import type { ShellApi } from "../shell/contract.ts";
  import { TRIP_EVENT_SEARCH_LIMIT } from "./desk-config.ts";

  let {
    shell = null,
    tool,
    lastError = null,
  }: {
    shell?: ShellApi | null;
    /** The tool id whose trip record to find. */
    tool: string;
    /** The row's recorded last error (from the same breaker read) — shown
     * alongside the trip record as the failing call's own words. */
    lastError?: string | null;
  } = $props();

  const hasShell = $derived(shell !== null);

  type TripLoad =
    | Readonly<{ kind: "pending" }>
    | Readonly<{ kind: "found"; event: TimelineEventSummary }>
    | Readonly<{ kind: "absent"; reason: string }>;

  let load = $state<TripLoad>({ kind: "pending" });

  $effect(() => {
    const forTool = tool;
    let cancelled = false;
    load = { kind: "pending" };
    void (async () => {
      try {
        const result = await fetchJson<TimelineEventSummariesResult>("/timeline/query", {
          method: "POST",
          body: JSON.stringify({
            eventType: "permission",
            ascending: false,
            limit: TRIP_EVENT_SEARCH_LIMIT,
          }),
        });
        if (cancelled) return;
        const hit = result.events.find((e) =>
          e.description.startsWith(`breaker:tripped:${forTool}`),
        );
        load =
          hit !== undefined
            ? { kind: "found", event: hit }
            : {
                kind: "absent",
                reason: `no trip record for this tool in the last ${TRIP_EVENT_SEARCH_LIMIT} recorded permission events`,
              };
      } catch {
        if (!cancelled) load = { kind: "absent", reason: "the record could not be read right now" };
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  function whenOf(wallTime: string): string {
    const d = new Date(wallTime);
    return Number.isNaN(d.getTime()) ? wallTime : d.toLocaleString("en-US", { hour12: false });
  }
</script>

<div class="trip-scope" data-shell={hasShell ? "yes" : "no"}>
  {#if load.kind === "pending"}
    <Answer answer={pending("reading the recorded trip")} />
  {:else if load.kind === "found"}
    <p class="sentence">{load.event.description.replace(`breaker:tripped:${tool} — `, "switched itself off: ")}</p>
    <dl class="facts">
      <dt class="engraved">recorded</dt>
      <dd>{whenOf(load.event.wallTime)}</dd>
      {#if load.event.runId !== null}
        <dt class="engraved">during run</dt>
        <dd class="mono">{load.event.runId}</dd>
      {/if}
      <dt class="engraved">outcome</dt>
      <dd>{load.event.outcome ?? "recorded"}</dd>
    </dl>
    {#if lastError !== null}
      <p class="err-label engraved">the failing call's own error</p>
      <p class="err">{lastError}</p>
    {/if}
  {:else}
    <Answer answer={absent(load.reason)} />
    {#if lastError !== null}
      <p class="err-label engraved">the last recorded error for this tool</p>
      <p class="err">{lastError}</p>
    {/if}
  {/if}
</div>

<style>
  /* The gutter belongs to the sheet (ScopeHost), not to each body: two
   * scope bodies that padded themselves differently is exactly why the
   * inspector felt like several products. Here: rhythm only. */
  .trip-scope {
    display: flex;
    flex-direction: column;
    gap: var(--sheet-gap);
    min-width: 0;
  }
  .sentence {
    margin: 0;
    color: var(--ink-1);
    font-size: var(--f-ui-size);
    max-width: var(--measure);
  }
  .facts {
    margin: 0;
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--sp-1) var(--sp-3);
  }
  dd {
    margin: 0;
    font-size: var(--f-data-size);
    color: var(--ink-2);
  }
  .mono {
    font-family: var(--face-mono);
    overflow-wrap: anywhere;
  }
  /* The engraved recipe is owned by tokens.css (.cockpit .engraved); the
   * facts' `dt` terms and the error labels carry the marker class. */
  .err-label {
    margin: 0;
  }
  .err {
    margin: 0;
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--alarm);
    overflow-wrap: anywhere;
  }
</style>
