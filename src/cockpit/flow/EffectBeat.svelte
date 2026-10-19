<script lang="ts">
  /**
   * An effect beat (spec §3.2): a file changed. Path from the producing tool
   * call's own recorded args; ±counts COUNTED from the real diff patch (the
   * existing /api/git/diff-patch route); micro-diff = the first hunk. This
   * beat is git status relocated to the moment it happened — and when the
   * diff wire itself measured the project as having NO repository, the
   * beat says so in the wire's own words instead (no patch, no counts).
   *
   * Verbs: `see what changed` (wired — folds the fetched diff open, or
   * answers with the wire's no-repository sentence when there is nothing
   * to fold), `undo this` / `keep this` (wired through the custody block's
   * declared actions; honest-disabled with the gap when no project owns
   * the beat).
   */
  import { fetchJson } from "../../data/broker.ts";
  import { NOT_A_REPOSITORY } from "../../state/git.ts";
  import PathChip from "./PathChip.svelte";
  import UnifiedDiff from "../render/UnifiedDiff.svelte";
  import { firstHunkOf, parseUnifiedDiff, summarizePatch } from "../render/diff.ts";
  import { MICRO_DIFF_LINES } from "../render/render-config.ts";
  import { updateBeat } from "./log.ts";
  import type { Beat } from "./types.ts";
  import Answer from "../response/Answer.svelte";
  import { absent, failed, pending, refused } from "../response/grammar.ts";

  let {
    beat,
    expanded,
    projectPath,
  }: { beat: Beat; expanded: boolean; projectPath: string | null } = $props();

  // NOT named `effect`: `$effect` is a rune, and a component-scope binding
  // called `effect` makes the `$effect(…)` just below ambiguous with a store
  // read of it — which is how the template checker read it.
  const fileEffect = $derived(beat.effect!);

  // Fetch the real diff once per beat; counts are COUNTED from the patch.
  $effect(() => {
    if (projectPath === null) return;
    if (
      fileEffect.patch !== undefined ||
      fileEffect.diffError !== undefined ||
      fileEffect.noRepositoryReason !== undefined
    ) {
      return;
    }
    const file = fileEffect.path;
    const beatId = beat.id;
    fetchJson<{ patch?: unknown; repository?: unknown; reason?: unknown }>(
      `/git/diff-patch?path=${encodeURIComponent(projectPath)}&file=${encodeURIComponent(file)}`,
    ).then(
      (res) => {
        updateBeat(beatId, (b) => {
          // A no-repository answer settles the beat WITHOUT a patch or
          // counts: there is no earlier version to diff against, so nothing
          // can be counted and a "+0 −0" would be a measured-looking zero
          // that measures nothing. The reason carries the wire's own words.
          if (res.repository === false) {
            const reason =
              typeof res.reason === "string" && res.reason.length > 0
                ? res.reason
                : NOT_A_REPOSITORY;
            return { ...b, effect: { ...b.effect!, noRepositoryReason: reason } };
          }
          const patch = typeof res.patch === "string" ? res.patch : "";
          const { added, removed, firstHunk } = summarizePatch(patch, MICRO_DIFF_LINES);
          return { ...b, effect: { ...b.effect!, patch, added, removed, firstHunk } };
        });
      },
      (err) => {
        updateBeat(beatId, (b) => ({
          ...b,
          effect: { ...b.effect!, diffError: err instanceof Error ? err.message : String(err) },
        }));
      },
    );
  });

  /* ± are COUNTED from the patch by render/diff.ts's summarizePatch — the
   * same parser that renders it, so the number in the header and the lines
   * on screen can never disagree, and no second counting implementation
   * exists to drift from it. `firstHunk` is kept in the beat for the "has a
   * preview" test the template makes; the RENDERED preview comes from
   * re-parsing the stored patch, so no second representation drifts. */

  /** The patch as structure, re-derived from the stored text. */
  const parsed = $derived(
    fileEffect.patch === undefined || fileEffect.patch.length === 0
      ? null
      : parseUnifiedDiff(fileEffect.patch),
  );

  /** The reader's own "show the rest" toggle, local to this beat's diff. */
  let showFull = $state(false);
  /** SCOPE opens the beat expanded; the local toggle opens it in place. */
  const full = $derived(expanded || showFull);

  /** Collapsed: the first hunk only, with the remainder NAMED (§3.2). */
  const view = $derived(
    parsed === null
      ? null
      : full
        ? { preview: parsed, hidden: 0 }
        : firstHunkOf(parsed, MICRO_DIFF_LINES),
  );
</script>

<div class="effect beat-card">
  <div class="head">
    <span class="glyph" aria-hidden="true">Δ</span>
    <span class="path"><PathChip path={fileEffect.path} /></span>
    {#if fileEffect.added !== undefined && fileEffect.removed !== undefined}
      <span class="counts"><span class="add">+{fileEffect.added}</span> <span class="del">−{fileEffect.removed}</span></span>
    <!-- THREE DIFFERENT FACTS, one ink until now: a read that BROKE, a read
         this cockpit REFUSED to attempt because nothing names the project, and
         a count still IN FLIGHT. A fourth joined them: a diff answered by a
         folder NO repository tracks — not a file that happens to match its
         last save, so the commit/revert story cannot be true there. -->
    {:else if fileEffect.noRepositoryReason !== undefined}
      <Answer as="inline" answer={absent(fileEffect.noRepositoryReason)} />
    {:else if fileEffect.diffError !== undefined}
      <Answer as="inline" answer={failed(`diff not readable — ${fileEffect.diffError}`)} />
    {:else if projectPath === null}
      <Answer as="inline" answer={refused("diff needs the project path — none selected")} />
    {:else}
      <Answer as="inline" answer={pending("counting from the diff")} />
    {/if}
  </div>

  {#if view !== null && !view.preview.empty}
    <div class="diff-slot" data-untrusted>
      <UnifiedDiff
        parsed={view.preview}
        patch={fileEffect.patch ?? ""}
        hidden={view.hidden}
        onExpand={() => (showFull = true)}
        showPaths={false}
      />
    </div>
  {:else if fileEffect.patch !== undefined && fileEffect.patch.length === 0}
    <!-- Only a repository-backed empty patch reaches here: a project with no
         repository settles the beat on `noRepositoryReason` above, where the
         commit/revert story this sentence tells would name operations that
         cannot exist. -->
    <Answer
      answer={absent(
        "no uncommitted difference for this file right now (it may have been committed or reverted since)",
      )}
    />
  {:else if parsed !== null && parsed.empty}
    <Answer
      answer={absent(
        "the difference came back without a readable hunk header — nothing to lay out",
      )}
    />
  {/if}
</div>

<style>
  /* Ground, hairline, radius, padding and the mono register come from the
   * shared `.beat-card` vocabulary (tokens.css); the leading edge is tinted
   * there from the beat's own `data-state`. */
  /* The row header's spine is owned by tokens.css (.cockpit .head). */
  .glyph { color: var(--ink-3); }
  .path { color: var(--ink-1); }
  .counts { font-variant-numeric: tabular-nums; }
  .add { color: var(--ok); }
  .del { color: var(--alarm); }
  .diff-slot {
    margin-top: var(--sp-2);
    min-width: 0;
  }
</style>
