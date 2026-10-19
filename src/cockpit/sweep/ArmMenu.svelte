<script lang="ts">
  /**
   * THE ARM MENU, STANDALONE HOST — the arm grammar raised over the band
   * (§6.4), for the mounts with no shell above them: the sweep's dev
   * harness, the standalone tests. Under the cockpit shell the arm menu is
   * the RIGHT-MENU column instead (shell/RightMenuHost.svelte) — the same
   * body (ArmMenuBody.svelte), the shell's own chrome — so exactly one arm
   * surface is ever on screen per mount.
   *
   * The content lives in the BODY component (one body, two hosts — the
   * desk/ChannelScope.svelte shape); this file owns only the raised
   * surface: the shared Popover (cap, close verb, Esc through the shell's
   * dismissal ladder when there is one, focus trap, outside-press).
   */
  import Popover from "../shell/Popover.svelte";
  import type { Component } from "svelte";
  import { inspectorGroupComponent, loadInspectorGroup } from "../shell/outlets.ts";
  import Answer from "../response/Answer.svelte";
  import { failed, pending } from "../response/grammar.ts";

  let {
    open = false,
    onClose,
  }: {
    open?: boolean;
    onClose?: () => void;
  } = $props();
  let Body = $state.raw<Component | null>(null);
  let error = $state<string | null>(null);
  let attempt = $state(0);
  $effect(() => {
    if (!open) return;
    void attempt;
    Body = inspectorGroupComponent("arm");
    error = null;
    let live = true;
    void loadInspectorGroup("arm").then(component => {
      if (live) Body = component;
    }, reason => { if (live) error = reason instanceof Error ? reason.message : String(reason); });
    return () => { live = false; };
  });
</script>

{#if open}
  <Popover
    title="Watches and captures"
    onclose={() => onClose?.()}
    style="left: var(--sp-2); bottom: calc(100% + var(--sp-2)); min-width: var(--arm-menu-min-w);"
  >
    {#if Body !== null}<Body />
    {:else if error !== null}
      <Answer answer={failed(error)} />
      <button type="button" class="verb" data-verb-id="arm.menu-retry" title="Retry opening watches and captures" onclick={() => attempt += 1}>Try again</button>
    {:else}<Answer answer={pending("Watches and captures")} />{/if}
  </Popover>
{/if}
