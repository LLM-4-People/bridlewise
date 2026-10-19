<script lang="ts">
  /**
   * SCOPE diff body (§7.2 "see what changed" / §7.3 DiffSheet): the real
   * unified diff from the diff-patch route, ± counted from the patch itself
   * — the same measurement discipline the flow's effect beat applies, in a
   * sheet the Custody room can open for any file or any saved commit
   * (`ref`, e.g. `<hash>^!`). Nothing is synthesized: an empty patch renders
   * as the honest "no difference" sentence, a failed read as its reason.
   */
  import { fetchJson } from "../../data/broker.ts";
  import { NOT_A_REPOSITORY } from "../../state/git.ts";
  import UnifiedDiff from "../render/UnifiedDiff.svelte";
  import { parseUnifiedDiff } from "../render/diff.ts";
  import { countPatch, emptyPatchLine } from "./custody-data.ts";
  import Answer from "../response/Answer.svelte";
  import { absent, failed, pending } from "../response/grammar.ts";

  let {
    projectPath,
    file,
    ref,
    fileState,
  }: {
    projectPath: string;
    file?: string;
    ref?: string;
    /** The room's own measured word for this file ("changed" / "new" /
     * "deleted" / "moved"). An EMPTY patch means something different for
     * each, so the absence sentence is chosen from it rather than asserting
     * one story for all of them. Absent when the sheet was opened for a
     * saved commit rather than a file. */
    fileState?: string;
  } = $props();

  let patch = $state<string | null>(null);
  let error = $state<string | null>(null);
  /** The wire's own sentence when the project has NO repository — a
   * different fact from an empty patch, which this sheet must not dress in
   * the "matches its last saved state" story (no save exists to match). */
  let noRepository = $state<string | null>(null);

  $effect(() => {
    patch = null;
    error = null;
    noRepository = null;
    const qs = new URLSearchParams({ path: projectPath });
    if (file !== undefined) qs.set("file", file);
    if (ref !== undefined) qs.set("ref", ref);
    fetchJson<{ patch?: unknown; repository?: unknown; reason?: unknown }>(`/git/diff-patch?${qs.toString()}`).then(
      (res) => {
        if (res.repository === false) {
          noRepository =
            typeof res.reason === "string" && res.reason.length > 0 ? res.reason : NOT_A_REPOSITORY;
          return;
        }
        patch = typeof res.patch === "string" ? res.patch : "";
      },
      (err) => {
        error = err instanceof Error ? err.message : String(err);
      },
    );
  });

  /** Custody's own counting owner keeps the header numbers (§7.2). */
  const counted = $derived(patch === null ? null : countPatch(patch));
  /** The shared renderer's structure — the SAME patch text, laid out. */
  const parsed = $derived(patch === null ? null : parseUnifiedDiff(patch));
</script>

<div class="diff-sheet">
  {#if error !== null}
    <!-- FOUR SENTENCES THAT WERE ONE INK. A read that broke, a read still in
         flight, and a read that came back with no difference are three
         different facts; this sheet typeset them identically. -->
    <Answer answer={failed(`difference not readable — ${error}`)} />
  {:else if noRepository !== null}
    <Answer answer={absent(noRepository)} />
  {:else if patch === null}
    <Answer answer={pending("reading the difference")} />
  {:else if patch.length === 0}
    <Answer answer={absent(emptyPatchLine(fileState))} />
  {:else}
    <div class="head">
      {#if file !== undefined}<span class="path">{file}</span>{/if}
      {#if counted !== null}
        <span class="counts"><span class="add">+{counted.added}</span> <span class="del">−{counted.removed}</span></span>
      {/if}
    </div>
    {#if parsed !== null && !parsed.empty}
      <div data-untrusted>
        <UnifiedDiff {parsed} {patch} showPaths={file === undefined} />
      </div>
    {:else}
      <Answer
        answer={absent(
          "the difference came back without a readable hunk header — nothing to lay out",
        )}
      />
    {/if}
  {/if}
</div>

<style>
  .diff-sheet {
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--ink-2);
  }
  /* The row header's spine is owned by tokens.css (.cockpit .head). */
  .head {
    margin-bottom: var(--sp-1);
  }
  .path {
    color: var(--ink-1);
  }
  .counts {
    font-variant-numeric: tabular-nums;
  }
  .add {
    color: var(--ok);
  }
  .del {
    color: var(--alarm);
  }
</style>
