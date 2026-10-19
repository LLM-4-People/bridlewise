<script lang="ts">
  /**
   * REGISTRATION (§10) — boot and sign-in as one continuous column: the
   * instruments checking in, truthfully. Every line is a real probe with
   * its measured ms (boot/probes.ts). No splash, no spinner, no form
   * floating in a void: the passphrase line is a line IN the column, on
   * the measure, and the beam caret is the only chromatic pixel on the
   * signed-out screen (§12.2).
   *
   * The auth FLOW survives (client.ts submitLogin/submitRegister — the
   * same recorded POSTs); the old login form does not (§13). Sign-in is a
   * recorded event server-side (webAuditEvent auth.login_success), and the
   * column says so: `signed in · recorded HH:MM:SS`.
   *
   * THE ACID TEST, passed through the grammar rather than beside it: the
   * fields consume the owned SPINE `.field` variant (tokens.css
   * `.cockpit .column .field` — labels on `--label-track`, beside the
   * inputs, sharing the probe lines), the controls are the owned verb
   * recipe, a refused sign-in is the one answer element (a `failed()`
   * answer — announced, because the refusal is news), and the probe lines
   * wear the grammar's own state inks via its `data-state` values. A
   * local `.field { display:grid }` that loses to `.cockpit .field` is
   * not a choke; the spine lives at the token owner.
   *
   * On a warm signed-in boot the whole column is 3 lines — that is the
   * correct experience, not a bug (§1.5 matrix, REGISTRATION row).
   *
   * Probe lines do not spark. `moves` stamps `data-motion*` and clears them
   * on `animationend`, which is a DOM mutation after the column has
   * settled — the signed-out boot must then hold still at the passphrase
   * (cockpit-boot-owner e2e). The line landing is the recorded probe; it
   * does not need a second motion on top of appearing.
   */
  import { submitLogin, submitRegister } from "../../client.ts";
  import { authState } from "../../state/auth.ts";
  import Answer from "../response/Answer.svelte";
  import Brand from "../shell/Brand.svelte";
  import { failed, type Answer as AnswerValue } from "../response/grammar.ts";
  import type { AuthGate, ProbeLine } from "./probes.ts";

  let {
    lines,
    gate,
    complete,
    flowNote,
    onAuthed,
    onRetry,
  }: {
    lines: readonly ProbeLine[];
    gate: AuthGate | null;
    /** All probes done (the column is finished — reveal fired). */
    complete: boolean;
    /** Honest terminal note when no flow surface exists to take over. */
    flowNote: string | null;
    onAuthed: (username: string, ms: number) => void;
    onRetry: () => void;
  } = $props();

  let username = $state("");
  let passphrase = $state("");
  let showPassphrase = $state(false);
  let userEl = $state<HTMLInputElement | null>(null);

  const auth = $derived($authState);
  const needsForm = $derived(gate === "signed-out" || gate === "setup");

  /** The server's refusal, as the one answer the grammar renders. */
  const refusal = $derived<AnswerValue<unknown> | null>(
    auth.error.length > 0 ? failed(auth.error) : null,
  );

  $effect(() => {
    if (needsForm) userEl?.focus();
  });

  async function submit(ev: SubmitEvent): Promise<void> {
    ev.preventDefault();
    if (auth.loading || username.length === 0 || passphrase.length === 0) return;
    const t0 = performance.now();
    const ok =
      gate === "setup"
        ? await submitRegister(username, passphrase)
        : await submitLogin(username, passphrase);
    if (ok) {
      const who = username;
      passphrase = "";
      onAuthed(who, Math.max(1, Math.round(performance.now() - t0)));
    }
  }
</script>

<div class="column" class:welcome={needsForm} aria-label="registration">
  {#if needsForm}
    <Brand wordmark />
    <div class="welcome-copy"><p class="eyebrow">A place for your next idea</p><h2>Make room<br />for good work<span class="color-stop">.</span></h2><p>Conversations, code, and the moments worth keeping. Right where you left them.</p></div>
  {/if}
  {#if gate === "offline"}
    <p class="gate-note">
      The server is not answering.
      <button class="verb" onclick={onRetry}>Probe again</button>
    </p>
  {:else if needsForm}
    <form class="gate" onsubmit={submit}>
      <h1>{gate === "setup" ? "Create your account" : "Sign in"}</h1>
      {#if gate === "setup"}<p class="gate-note">This first account owns the harness.</p>{/if}
      <label class="field">
        <span class="engraved">Username</span>
        <input
          bind:this={userEl}
          bind:value={username}
          type="text"
          name="username"
          autocomplete="username"
          autocapitalize="none"
          spellcheck={false}
          required
          disabled={auth.loading}
        />
      </label>
      <div class="field">
        <label class="engraved" for="sign-in-password">Password</label>
        <span class="password-field">
        <input
          bind:value={passphrase}
          id="sign-in-password"
          type={showPassphrase ? "text" : "password"}
          name="passphrase"
          autocomplete={gate === "setup" ? "new-password" : "current-password"}
          required
          disabled={auth.loading}
        />
        <button type="button" class="verb" aria-label="show password" aria-pressed={showPassphrase} disabled={auth.loading} onclick={() => (showPassphrase = !showPassphrase)}>{showPassphrase ? "Hide" : "Show"}</button>
        </span>
      </div>
      {#if refusal !== null}
        <Answer answer={refusal} />
      {/if}
      <button class="verb enter primary" type="submit" disabled={auth.loading}>
        {auth.loading ? gate === "setup" ? "Creating account…" : "Signing in…" : gate === "setup" ? "Create account" : "Sign in"}
      </button>
    </form>
  {/if}

  {#if needsForm}
    <details class="boot-details">
      <summary>Connection details</summary>
      {@render probeLines()}
    </details>
  {:else}
    {@render probeLines()}
  {/if}

  {#if complete && flowNote !== null}
    <p class="flow-note">{flowNote}</p>
  {/if}
</div>

{#snippet probeLines()}
  <ol class="lines">
    {#each lines as line (line.id)}
      <li class="line" data-state={line.state}>
        <span class="label engraved">{line.label}</span>
        <span class="detail">{line.detail}</span>
        <span class="ms">{line.ms}ms</span>
      </li>
    {/each}
  </ol>
{/snippet}

<style>
  .welcome-copy { margin: var(--sp-7) 0; font-family: var(--face-sans); }
  .eyebrow { color: var(--accent-secondary); font-size: var(--f-data-size); }
  .welcome-copy h2 { font-size: var(--f-display-size); line-height: var(--lh-tight); letter-spacing: var(--f-display-track); margin: var(--sp-3) 0; font-weight: 500; }
  .welcome-copy > p:last-child { color: var(--ink-2); max-width: var(--measure); font-size: var(--f-prose-size); }
  .color-stop { color: var(--accent); }
  .column.welcome { max-width: var(--login-w); padding-top: var(--sp-7); }
  .welcome .gate { margin-top: var(--sp-6); padding: var(--sp-6); border: var(--hairline-w) solid var(--line-2); border-radius: var(--radius-2); background: var(--ground-1); }
  .welcome .enter { align-self: stretch; font-size: var(--f-prose-size); }
  .column {
    width: 100%;
    max-width: var(--measure);
    margin: 0 auto;
    padding: var(--sp-7) var(--gutter-bleed);
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
  }
  .lines {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .line {
    display: grid;
    grid-template-columns: var(--label-track) 1fr auto;
    column-gap: var(--sp-4);
    min-height: var(--row-h);
    align-items: center;
  }
  .detail {
    color: var(--ink-1);
  }
  /* The probe lines read the grammar's answer inks, not the raw ramp: the
   * `data-state` values ARE the answer axis (probes.ts derives them from
   * it), and the owned `[data-answer]`-style inks live at the token owner. */
  .line[data-state="absent"] .detail {
    color: var(--state-absent-ink);
  }
  .line[data-state="failed"] .detail {
    color: var(--state-failed-ink);
  }
  .ms {
    color: var(--ink-3);
  }
  .gate {
    margin-top: var(--sp-7);
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
  }
  .gate input { min-height: var(--horizon-h); }
  .gate .enter {
    margin-left: 0;
    min-height: var(--horizon-h);
    padding: 0 var(--sp-5);
    background: var(--beam);
    border-color: var(--beam);
    color: var(--ground-0);
  }
  h1 {
    margin: 0;
    color: var(--ink-1);
    font-family: var(--face-sans);
    font-size: var(--f-h1-size);
    font-weight: 500;
    line-height: var(--lh-tight);
  }
  .password-field {
    display: flex;
    min-width: 0;
    gap: var(--sp-2);
  }
  .password-field input { flex: 1; min-width: 0; }
  .boot-details { margin-top: var(--sp-7); color: var(--ink-3); }
  .boot-details summary { cursor: pointer; min-height: var(--hit-min); }
  .boot-details .lines { margin-top: var(--sp-3); }
  .gate-note {
    margin: 0 0 var(--sp-3);
    color: var(--ink-2);
    font-family: var(--face-sans);
    font-size: var(--f-ui-size);
  }
  /* The SPINE field recipe (label on --label-track, input beside it) is
   * owned by tokens.css (.cockpit .column .field). This host is `.column`,
   * so the gate consumes that variant; a local display restatement is
   * how the column recipe stacked the labels ON the inputs. */
  input {
    caret-color: var(--beam);
  }
  /* The verb recipe is owned by tokens.css (.cockpit .verb) — rest, hover
   * on the enabled control only, and the refused treatment while the check
   * is in flight, all from the owner. Enter sits on the input track of
   * the same spine the probe lines use. */
  .enter {
    align-self: start;
    margin-left: calc(var(--label-track) + var(--sp-4));
  }
  .flow-note {
    margin: var(--sp-6) 0 0;
    color: var(--ink-3);
    font-family: var(--face-sans);
    font-size: var(--f-ui-size);
  }
</style>
