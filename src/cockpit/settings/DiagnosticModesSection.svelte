<script lang="ts">
  /**
   * DIAGNOSTIC MODES — the settings room's array door, the section
   * half of the "What the harness measures about itself" category.
   *
   * WHY A SECTION AND NOT A REGISTRY ROW: the leaf this serves
   * (`performance.diagnosticModes.excludedModes`) holds an ARRAY, and the
   * served-row grammar is scalar-and-object by design (the sheet refuses
   * array JSON; the row types have no array face) — the same reason the tool
   * server list and the provider list are sections. A fixed vocabulary of
   * declared modes uses positive inclusion switches, so every
   * entry the face can produce is one the engine's own enum declares.
   *
   * THE FACE FOLLOWS THE WIRE: the mode vocabulary comes from the block's
   * read (the engine's own DIAGNOSTIC_MODE_IDS, never a client-side list),
   * the save words come from the served block manifest (the zero-knowledge
   * law), and the write goes through the settings feed's one door for this
   * leaf — the same validated block fabric the sheet's saves ride, so a
   * past view refuses before the wire (the read honestly cannot answer for a
   * past instant) and the timeline records the beat.
   */
  import { readDiagnosticModes, saveDiagnosticModes } from "./settings-feed.ts";
  import {
    diagnosticModesSaveDescriptor,
    type DiagnosticModesState,
  } from "./settings-data.ts";
  import { isPastView, PAST_VIEW_ACT_REASON } from "../../data/asof.ts";
  import { refusalReason, UNREADABLE_SHAPE } from "../../data/absence.ts";
  import Answer from "../response/Answer.svelte";
  import { failed, pending } from "../response/grammar.ts";
  import { onMount } from "svelte";
  import { whileRoomVisible } from "../shell/room-visibility.ts";
  import { uiSchema } from "../../state/schema-store.ts";

  let load = $state<"pending" | "failed" | "ok">("pending");
  let loadReason = $state<string | null>(null);
  /** The last read's whole answer — the vocabulary + what the file excludes. */
  let answer = $state<DiagnosticModesState | null>(null);
  /** The draft set of excluded modes; null until the first read answers. */
  let draft = $state<ReadonlySet<string> | null>(null);
  let busy = $state(false);
  let note = $state<{ kind: "saved" | "failed"; text: string } | null>(null);

  const past = $derived($isPastView);
  const saveWords = $derived(diagnosticModesSaveDescriptor($uiSchema));
  const dirty = $derived.by(() => {
    if (draft === null || answer === null) return false;
    const standing = answer.excluded;
    if (standing.length !== draft.size) return true;
    for (const mode of draft) {
      if (!standing.includes(mode)) return true;
    }
    return false;
  });

  async function revalidate(): Promise<void> {
    load = "pending";
    try {
      const next = await readDiagnosticModes();
      answer = next;
      // The draft re-derives from the read: a reveal never keeps a stale
      // draft against a list the server just answered.
      draft = new Set(next.excluded);
      load = "ok";
    } catch (err) {
      loadReason = refusalReason(err) ?? (err instanceof Error ? err.message : String(err));
      load = "failed";
    }
  }

  function toggle(mode: string): void {
    if (draft === null) return;
    const next = new Set(draft);
    if (next.has(mode)) next.delete(mode);
    else next.add(mode);
    draft = next;
    note = null;
  }

  async function save(): Promise<void> {
    if (draft === null || busy || past || !dirty || load !== "ok") return;
    busy = true;
    note = null;
    try {
      await saveDiagnosticModes([...draft]);
      note = { kind: "saved", text: "Saved. The list shows the confirmed configuration." };
      await revalidate();
    } catch (err) {
      // The server refused — the standing list stands; the sentence is the
      // server's own, rendered at the verb that earned it.
      note = {
        kind: "failed",
        text: refusalReason(err) ?? (err instanceof Error ? err.message : String(err)),
      };
    } finally {
      busy = false;
    }
  }

  // KEPT ALIVE (the room host): mounted once, shown/hidden with the
  // category. A reveal re-reads so a revisit never serves a cached face for
  // a config-file fact.
  onMount(() =>
    whileRoomVisible("settings", () => {
      void revalidate();
      return () => undefined;
    }),
  );
</script>

<div class="diag-modes" data-field="diagnostic-modes">
  {#if load === "pending" && answer === null}
    <Answer answer={pending("reading the diagnostic modes")} />
  {:else if load === "failed" && answer === null}
    <Answer answer={failed(`The diagnostic modes list: ${loadReason ?? UNREADABLE_SHAPE}`)} />
  {:else if answer !== null}
    <p class="lead" data-field="diagnostic-modes-lead">
      Choose which modes run. Changes take effect on the next diagnostic run.
    </p>
    <ul class="mode-list" data-field="diagnostic-mode-rows">
      {#each answer.modes as mode (mode)}
        <li class="mode-row setting-row" data-diagnostic-mode={mode} class:skipped={draft?.has(mode) ?? false}>
          <div class="m-check">
            <span class="m-name">{mode}</span>
            <button class="verb state-control" type="button" role="switch"
              data-verb-id="settings.diagnosticModes/draft"
              aria-label={`Run ${mode} on the next diagnostic run`}
              aria-checked={!(draft?.has(mode) ?? false)}
              disabled={busy || past || load !== "ok"}
              title={past ? PAST_VIEW_ACT_REASON : "Changes this draft; Save applies it to the next diagnostic run."}
              onclick={() => toggle(mode)}
            ><span class="state-path" aria-hidden="true"></span></button>
          </div>
        </li>
      {/each}
    </ul>
    <div class="m-verbs">
      <button
        class="verb primary commit"
        type="button"
        data-verb-id="settings.diagnosticModes/set"
        disabled={past}
        aria-disabled={busy || past || load !== "ok" || draft === null || !dirty}
        aria-busy={busy}
        title={past
          ? PAST_VIEW_ACT_REASON
          : (saveWords?.consequence ?? "Saves which modes run on the next diagnostic run.")}
        onclick={() => void save()}
      >{saveWords?.title ?? "Save"}</button>
      {#if dirty}<span class="m-note">Unsaved changes</span>{/if}
      {#if note !== null}
        <span class="m-note" role="status" class:not-saved={note.kind === "failed"} data-field="diagnostic-modes-note">
          {note.text}
        </span>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* The section rides INSIDE a room category, so it borrows the row and verb
   * vocabulary the room owns (.setting-row chrome comes from the room's own
   * stylesheet) and restyles only what Svelte's scoping cannot reach. */
  .diag-modes {
    margin: 0 0 var(--sp-4);
  }
  .lead {
    margin: 0 0 var(--sp-1);
  }
  .mode-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, var(--switch-field-w)), 1fr));
    gap: var(--sp-1);
  }
  .mode-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--sp-3);
    align-items: baseline;
  }
  .m-check {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--sp-2);
    align-items: center;
    width: 100%;
    cursor: pointer;
  }
  .m-name {
    color: var(--ink-1);
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
  }

  .mode-row.skipped { background: color-mix(in srgb, var(--warn) 8%, var(--ground-1)); }
  .m-verbs {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--sp-3);
    margin-top: var(--sp-2);
  }
  .verb { align-self: flex-start; flex-shrink: 0; }
  .m-note {
    color: var(--ink-2);
    font-size: var(--f-ui-size);
  }
  .m-note.not-saved {
    color: var(--alarm);
  }
</style>
