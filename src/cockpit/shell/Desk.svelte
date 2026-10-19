<script lang="ts">
  /** Immediate conversation actions. Detailed editors share the inspector. */
  import type { Component } from "svelte";
  import type { OutletProps, ShellApi } from "./contract.ts";
  import { mouseTitleFor } from "./keyboard.ts";
  import { isPastView, PAST_VIEW_ACT_REASON } from "../../data/asof.ts";
  import { COMPOSER_EMPTY_REASON } from "../flow/composer-router.ts";
  import { currentChat } from "../../state/chats.ts";
  import { modelsCatalog } from "../../state/models.ts";
  import { openInspectorSection, rightMenu, toggleRightMenu } from "./right-menu.ts";
  import { planForTarget, warmOnIntent } from "./room-warm.ts";

  let { shell, revealed, text = $bindable(), gauge, onSubmit, focusRequest }: {
    shell: ShellApi; revealed: boolean; text: string;
    gauge: Component<OutletProps> | null; onSubmit: () => void; focusRequest: number;
  } = $props();
  const past = $derived($isPastView);
  const sendTitle = $derived(past ? PAST_VIEW_ACT_REASON : text.length === 0 ? `${mouseTitleFor("send")}: ${COMPOSER_EMPTY_REASON}` : mouseTitleFor("send"));
  const model = $derived($currentChat?.modelId ?? $modelsCatalog?.defaultModel ?? "Model & provider");
  const mode = $derived(text.startsWith("?") ? "Ask" : text.startsWith("/") ? "Command" : "Message");
  let inputEl = $state<HTMLInputElement | null>(null);
  $effect(() => { if (focusRequest > 0) inputEl?.focus(); });
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) { event.preventDefault(); onSubmit(); }
  }
</script>

<div class="desk">
  <div class="bar">
    {#if mode !== "Message"}<span class="chip" data-active>{mode}</span>{/if}
    <input class="composer" type="text" name="composer" data-chord-target="command"
      title={mouseTitleFor("command")} bind:this={inputEl} bind:value={text} onkeydown={onKeydown}
      placeholder={revealed ? past ? PAST_VIEW_ACT_REASON : "What would you like to work on?" : "Getting ready. Your words are kept."}
      aria-label="composer" />
    <button type="button" class="verb send primary" data-verb-id="composer.send" data-chord-target="send"
      title={sendTitle} disabled={past || text.length === 0} onclick={onSubmit}>Send <span aria-hidden="true">↑</span></button>
  </div>
  <div class="conversation-controls">
    <button type="button" class="verb model-summary" data-verb-id="composer.model" title="Choose the model for this conversation"
      onclick={() => openInspectorSection("setup-sec-model")}><span class="model-name">{model}</span><span aria-hidden="true">⌄</span></button>
    <button type="button" class="verb grip" data-verb-id="desk.toggle" data-chord-target="desk"
      title={mouseTitleFor("desk")} aria-label="Conversation setup" aria-expanded={$rightMenu === "setup"}
      onclick={() => toggleRightMenu("setup")} use:warmOnIntent={revealed && $rightMenu !== "setup" ? planForTarget("desk") : null}>Context & tools</button>
    <div class="gauge-slot">
      {#if gauge !== null}{@const Gauge = gauge}<Gauge {shell} />{/if}
    </div>
  </div>
</div>

<style>
  .desk { background: var(--ground-1); border-top: var(--hairline-w) solid var(--line-1); padding: var(--sp-3) var(--gutter-bleed) var(--sp-2); }
  .bar { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; padding: var(--sp-2); border: var(--hairline-w) solid var(--line-2); border-radius: var(--radius-2); background: var(--ground-2); }
  .chip { flex: none; color: var(--ink-3); }
  .chip[data-active] { color: var(--accent); }
  .composer { flex: 1; min-width: var(--hit-min); min-height: var(--hit-min); border: 0; border-radius: var(--radius-1); padding: var(--sp-2); color: var(--ink-1); background: transparent; font: var(--f-ui-size) var(--face-sans); caret-color: var(--accent); }
  .composer::placeholder { color: var(--ink-3); }
  .composer:focus { border-color: var(--accent); }
  .conversation-controls { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1) var(--sp-3); margin-top: var(--sp-2); }
  .model-summary { justify-content: flex-start; color: var(--accent); min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
  .model-name { min-width: 0; overflow-wrap: anywhere; }
  .gauge-slot { flex: 1 1 var(--composer-summary-min); min-width: 0; }
</style>
