<script lang="ts">
  /**
   * MODEL PROVIDERS: the settings room's provider section (the path out of
   * the guided `provider_not_configured` state).
   *
   * WHY THIS EXISTS AS ITS OWN SECTION AND NOT AS REGISTRY ROWS. The room's
   * categories are DERIVED from the served settings registry, and providers
   * are not a registry setting: they are a per-account encrypted database
   * row with a write-only credential (`apiKey` travels one way: sent when
   * typed, never returned; the catalog carries `hasApiKey` instead). The
   * cutover deleted the old tree's provider panel and ported nothing, so
   * the refused run's own remedy: "Open Settings and add a model
   * provider": pointed at a room with no such control. This section is the
   * missing consumer of the surviving server routes, not a second path:
   * list/add/edit go through PUT `/api/models/prefs` (merge by name),
   * delete through DELETE `/api/models/providers/:id`, the connection
   * probe through POST `/api/models/providers/:id/test`: all via the
   * client wrappers, which feed the models store so the desk's picker and
   * this list can never disagree about what the server holds.
   */
  import {
    discoverModelProvider,
    deleteModelProvider,
    getModels,
    saveModelPrefs,
    testModelProvider,
  } from "../../client.ts";
  import { modelsCatalog, type ProviderInfo } from "../../state/models.ts";
  import type { DiscoveredProviderModel, ProviderTestFailureKind } from "../../../shared/wire-types.ts";
  import { SvelteMap } from "svelte/reactivity";
  import { assertLiveForWrite } from "../../data/asof.ts";
  import { refusalReason, UNREADABLE_SHAPE } from "../../data/absence.ts";
  import Answer from "../response/Answer.svelte";
  import { VERB_MARK, VERB_MARK_WORD } from "../shell/verb-marks.ts";
  import { failed, pending } from "../response/grammar.ts";
  import { onDestroy, tick } from "svelte";
  import { parseTokenQuantity } from "./settings-data.ts";
  import { PROVIDER_DISCOVERY_PAGE_SIZE } from "./settings-config.ts";

  /**
   * WHAT THE ONE TEST REQUEST MET, in words: the class half of the probe's
   * answer, so the sentence names what happened instead of presuming
   * refusal: a dead address never "refused" anything, and a live endpoint
   * that said no is not "down". TOTAL over the wire's closed vocabulary;
   * an answer carrying a class this build does not know falls back to the
   * honest floor rather than guessing.
   */
  const TEST_FAILURE_WORDS = {
    "no-answer": "the endpoint did not answer",
    "refused-key": "the saved key was refused",
    "refused-request": "the endpoint did not accept the request",
    "output-limit": "the test reached its output limit before an answer",
    "invalid-response": "the endpoint returned an unusable response",
    unexpected: "the request did not complete",
  } satisfies Record<ProviderTestFailureKind, string>;

  const catalog = $derived($modelsCatalog);
  /** The provider list, or null when the catalog in the store does not carry
   * one (a stubbed or legacy answer): rendered as the honest shape failure,
   * never a crash that takes the whole room with it. */
  const providers = $derived(
    catalog !== null && Array.isArray(catalog.providers)
      ? (catalog.providers as readonly ProviderInfo[])
      : null,
  );

  // The catalog is filled by the boot and by every provider write; a room
  // opened before either simply asks once.
  $effect(() => {
    if ($modelsCatalog === null) void getModels().catch(() => undefined);
  });

  // ── the one form (add and edit are the same write: merge by name) ────────
  let formOpen = $state(false);
  /** Null = adding; a provider id = editing that row. */
  let editingId = $state<string | null>(null);
  let fName = $state("");
  let fBaseUrl = $state("");
  /**
   * The models this provider serves, as editable rows: one row per model,
   * each carrying its own stored settings. Fields hold INPUT STRINGS (a
   * blank string is "not set"), parsed at submit so a half-typed number is
   * a form error naming its row, never a silent 0 or NaN on the wire.
   */
  type ModelRowForm = {
    id: string;
    contextWindow: string;
    maxTokens: string;
    temperature: string;
  };
  let fModelRows = $state<ModelRowForm[]>([]);
  function limitsSummary(row: ModelRowForm): string {
    const parts: string[] = [];
    if (row.contextWindow) parts.push(`Context ${row.contextWindow}`);
    if (row.maxTokens) parts.push(`Reply ${row.maxTokens}`);
    if (row.temperature) parts.push(`Temperature ${row.temperature}`);
    return parts.join(" · ");
  }
  let modelRowsElement = $state<HTMLDivElement>();
  let fApiKey = $state("");
  let fHeaders = $state("");
  let headersCleared = $state(false);
  let formNote = $state<{ kind: "saved" | "failed"; text: string } | null>(null);
  let formGeneration = $state(0);
  let draftRevision = $state(0);
  let pendingSave = $state<{ token: symbol; generation: number; revision: number; id: string } | null>(null);
  const busy = $derived(pendingSave?.generation === formGeneration);
  // Request ownership is per entity; independent rows remain usable.
  const probeRuns = new SvelteMap<string, { current: boolean }>();
  function invalidateProbe(id: string): void {
    const run = probeRuns.get(id);
    if (run) run.current = false;
    testNotes.delete(id);
  }
  function changedDraft(event?: Event): void {
    const name = (event?.target as HTMLInputElement | undefined)?.name;
    if (name === "provider-discovery-query" || name === "provider-discovered-model") return;
    if (name === "provider-base-url" || name === "provider-api-key" || name === "provider-headers") clearDiscovery();
    draftRevision += 1;
    formNote = null;
  }
  /** provider id → its last probe's sentence. */
  const testNotes = new SvelteMap<string, string>();
  /** The armed two-press delete, if any. */
  let armedDelete = $state<string | null>(null);
  /** The model id whose default-change write is in flight, if any. */
  let defaultBusy = $state<string | null>(null);
  let defaultNote = $state<string | null>(null);
  const defaultChoices = $derived(providers?.flatMap(p => p.models.map(m => ({key:JSON.stringify([p.id,m.id]),providerId:p.id,modelId:m.id}))) ?? []);
  const selectedDefault = $derived(JSON.stringify([catalog?.defaultProvider,catalog?.defaultModel]));

  /** A fresh, empty model row. */
  function blankModelRow(): ModelRowForm {
    return { id: "", contextWindow: "", maxTokens: "", temperature: "" };
  }

  type Discovery =
    | { kind: "idle" }
    | { kind: "pending"; token: symbol; controller: AbortController }
    | { kind: "ready"; models: readonly DiscoveredProviderModel[] }
    | { kind: "failed"; text: string };
  let discovery = $state<Discovery>({ kind: "idle" });
  let discoveryQuery = $state("");
  let discoveryPage = $state(0);
  const selectedModelIds = $derived(new Set(fModelRows.map(row => row.id.trim())));
  const normalizedDiscoveryQuery = $derived(discoveryQuery.trim().toLocaleLowerCase());
  const discoveryMatches = $derived(discovery.kind === "ready"
    ? discovery.models.filter(model => model.id.toLocaleLowerCase().includes(normalizedDiscoveryQuery)) : []);
  const discoveryRows = $derived(discoveryMatches.slice(discoveryPage * PROVIDER_DISCOVERY_PAGE_SIZE, (discoveryPage + 1) * PROVIDER_DISCOVERY_PAGE_SIZE));
  function clearDiscovery(): void {
    if (discovery.kind === "pending") discovery.controller.abort();
    discovery = { kind: "idle" };
    discoveryQuery = "";
    discoveryPage = 0;
  }
  onDestroy(clearDiscovery);
  async function findModels(): Promise<void> {
    if (discovery.kind === "pending") return;
    const parsedHeaders = parseHeaders(fHeaders);
    if ("error" in parsedHeaders) { discovery = { kind: "failed", text: parsedHeaders.error }; return; }
    const token = Symbol("provider discovery");
    const controller = new AbortController();
    discovery = { kind: "pending", token, controller };
    try {
      const result = await discoverModelProvider({ baseUrl: fBaseUrl.trim(),
        ...(editingId === null ? {} : { savedProviderId: editingId }),
        ...(fApiKey.trim() === "" ? {} : { apiKey: fApiKey.trim() }),
        ...(fHeaders.trim() === "" && !headersCleared ? {} : { headers: parsedHeaders.headers }) }, controller.signal);
      if (discovery.kind !== "pending" || discovery.token !== token) return;
      discovery = result.ok ? { kind: "ready", models: result.models }
        : { kind: "failed", text: TEST_FAILURE_WORDS[result.failureKind] + ": " + result.detail };
    } catch (error) {
      if (discovery.kind === "pending" && discovery.token === token) discovery = { kind: "failed", text: refusalReason(error) ?? UNREADABLE_SHAPE };
    }
  }
  async function addDiscoveredModel(id: string): Promise<void> {
    if (discovery.kind !== "ready" || fModelRows.some(row => row.id.trim() === id)) return;
    const model = discovery.models.find(row => row.id === id);
    if (model === undefined) return;
    changedDraft();
    const row: ModelRowForm = { id: model.id, contextWindow: model.contextWindow === undefined ? "" : String(model.contextWindow),
      maxTokens: model.maxTokens === undefined ? "" : String(model.maxTokens), temperature: "" };
    const blank = fModelRows.findIndex(item => item.id === "" && item.contextWindow === "" && item.maxTokens === "" && item.temperature === "");
    if (blank < 0) fModelRows.push(row); else fModelRows[blank] = row;
    const generation = formGeneration;
    await tick();
    if (formOpen && formGeneration === generation) {
      const index = fModelRows.findIndex(item => item.id === id);
      modelRowsElement?.querySelector<HTMLInputElement>('[data-model-row="' + index + '"] input[name="provider-model-id"]')?.focus();
    }
  }

  let formOrigin: HTMLButtonElement | null = null;
  function openAdd(): void {
    clearDiscovery();
    formGeneration += 1;
    draftRevision = 0;
    formOrigin = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
    formOpen = true;
    editingId = null;
    fName = "";
    fBaseUrl = "";
    fModelRows = [blankModelRow()];
    fApiKey = "";
    fHeaders = "";
    headersCleared = false;
    formNote = null;
  }

  function openEdit(p: ProviderInfo): void {
    clearDiscovery();
    formGeneration += 1;
    draftRevision = 0;
    formOrigin = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
    formOpen = true;
    editingId = p.id;
    fName = p.id;
    fBaseUrl = p.baseUrl;
    // Every stored model opens as its own row: a bare id (a model stored
    // before per-model settings existed) is a row with blank fields, so what
    // was saved surfaces without loss and saving it back changes nothing.
    fModelRows = p.models.map((m) => ({
      id: m.id,
      contextWindow: m.contextWindow !== undefined ? String(m.contextWindow) : "",
      maxTokens: m.maxTokens !== undefined ? String(m.maxTokens) : "",
      temperature: m.temperature !== undefined ? String(m.temperature) : "",
    }));
    // The key is never shown and never round-tripped: blank means "keep the
    // saved one" (the wire contract: an omitted apiKey preserves it).
    fApiKey = "";
    // Saved names are read-only context, never incomplete draft lines.
    // An untouched blank field preserves the saved header set.
    fHeaders = "";
    headersCleared = false;
    formNote = null;
  }

  async function addModelRow(): Promise<void> {
    changedDraft();
    fModelRows = [...fModelRows, blankModelRow()];
    const inserted = fModelRows;
    await tick();
    if (formOpen && fModelRows === inserted && modelRowsElement?.isConnected) {
      const field = modelRowsElement.querySelector<HTMLInputElement>('.model-row:last-of-type input[name="provider-model-id"]');
      field?.focus();
      field?.closest('.model-row')?.scrollIntoView?.({ block: "nearest" });
    }
  }

  function removeModelRow(index: number): void {
    changedDraft();
    fModelRows = fModelRows.filter((_, i) => i !== index);
  }

  let sectionElement: HTMLElement | undefined;
  let formElement = $state<HTMLFormElement | undefined>(undefined);
  function closeForm(): void {
    clearDiscovery();
    formGeneration += 1;
    const focused = document.activeElement;
    const ownsFocus = focused instanceof HTMLElement && formElement?.contains(focused);
    const origin = formOrigin;
    formOpen = false;
    editingId = null;
    formNote = null;
    void tick().then(() => {
      if (!ownsFocus || focused.isConnected || document.activeElement !== document.body) return;
      (origin?.isConnected ? origin : sectionElement?.querySelector<HTMLButtonElement>('[data-verb-id="models.provider/add"]'))?.focus();
    });
  }

  /**
   * Parse the headers textarea: one `Name: value` per line. A line with no
   * colon is a syntax error reported in the form's own words; a header the
   * key catalogue would refuse is left for the SERVER to refuse, because the
   * catalogue lives there and duplicating its judgement here is the two-lists
   * defect. Blank lines and trailing whitespace are ignored.
   */
  function parseHeaders(raw: string): { headers: Record<string, string> } | { error: string } {
    const headers: Record<string, string> = {};
    const lines = raw.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    for (const line of lines) {
      const colon = line.indexOf(":");
      if (colon <= 0) {
        return { error: `the header line "${line}" needs a colon: one "Name: value" per line` };
      }
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (name.length === 0 || value.length === 0) {
        return { error: `the header line "${line}" needs both a name and a value` };
      }
      headers[name] = value;
    }
    return { headers };
  }

  /**
   * Parse one model row's number fields. Blank means "let the provider
   * decide" and is OMITTED (the same honesty the stored schema uses); a
   * typed value must be a real one: the context window is a whole number
   * of tokens, the reply cap a positive number, the temperature 0–2: and
   * anything else is a form error naming the row's model, because a
   * half-typed number silently coerced (0, NaN) would store a lie the
   * provider would then honour.
   */
  function parseModelRow(
    row: ModelRowForm,
    id: string,
  ): { fields: { contextWindow?: number; maxTokens?: number; temperature?: number } } | { error: string } {
    const fields: { contextWindow?: number; maxTokens?: number; temperature?: number } = {};
    const contextWindow = parseTokenQuantity(row.contextWindow);
    if (contextWindow === null || contextWindow !== undefined && !Number.isSafeInteger(contextWindow.value)) {
      return {error: `The context window for "${id}" must be a positive whole number of tokens. Use a number, k or m, such as 32k or 1.5m.`};
    }
    if (contextWindow !== undefined) fields.contextWindow = contextWindow.value;
    const maxTokens = parseTokenQuantity(row.maxTokens);
    if (maxTokens === null) return {error: `The max tokens for "${id}" must be a number greater than zero that can be saved exactly. Use a number, k or m.`};
    if (maxTokens !== undefined) fields.maxTokens = maxTokens.value;
    const temperature = row.temperature.trim();
    if (temperature.length > 0) {
      const n = Number(temperature);
      if (!Number.isFinite(n) || n < 0 || n > 2) {
        return { error: `the temperature for "${id}" must be between 0 and 2` };
      }
      fields.temperature = n;
    }
    return { fields };
  }

  async function submit(ev: SubmitEvent): Promise<void> {
    ev.preventDefault();
    if (busy) return;
    const id = fName.trim();
    const baseUrl = fBaseUrl.trim();
    const models: {
      id: string;
      contextWindow?: number;
      maxTokens?: number;
      temperature?: number;
    }[] = [];
    for (const row of fModelRows) {
      const modelId = row.id.trim();
      const numbersBlank =
        row.contextWindow.trim() === "" && row.maxTokens.trim() === "" && row.temperature.trim() === "";
      // An entirely blank row is an abandoned one: it is not a model and
      // not an error. A row with numbers but no name cannot be saved and
      // says so, because dropping it would silently discard typed values.
      if (modelId.length === 0) {
        if (numbersBlank) continue;
        formNote = { kind: "failed", text: "a model row needs its model name" };
        return;
      }
      const parsed = parseModelRow(row, modelId);
      if ("error" in parsed) {
        formNote = { kind: "failed", text: parsed.error };
        return;
      }
      models.push({ id: modelId, ...parsed.fields });
    }
    if (id.length === 0 || baseUrl.length === 0 || models.length === 0) {
      formNote = { kind: "failed", text: "a provider needs a name, the address of its API, and at least one model name" };
      return;
    }
    const parsed = parseHeaders(fHeaders);
    if ("error" in parsed) {
      formNote = { kind: "failed", text: parsed.error };
      return;
    }
    const operation = { token: Symbol(), generation: formGeneration, revision: draftRevision, id };
    pendingSave = operation;
    formNote = null;
    invalidateProbe(id);
    try {
      // A PAST VIEW IS READ-ONLY (§6.2): `saveModelPrefs` is a client-side
      // write with no Broker door on it, so the rule is asserted here, at
      // the one place this surface fires it.
      assertLiveForWrite();
      const key = fApiKey.trim();
      const typedHeaders = headersCleared || Object.keys(parsed.headers).length > 0;
      await saveModelPrefs({
        providers: [{
          id,
          baseUrl,
          models,
          ...(key.length > 0 ? { apiKey: key } : {}),
          ...(typedHeaders ? { headers: parsed.headers } : {}),
        }],
      });
      // The wrapper already fed the store from the server's own answer.
      // Only this form opening and request may settle its draft or focus.
      if (pendingSave?.token === operation.token && formOpen && formGeneration === operation.generation) {
        if (draftRevision === operation.revision) closeForm();
        else {
          if (editingId === null && fName.trim() === id) editingId = id;
          formNote = { kind: "saved", text: `Saved ${id}. Newer changes are unsaved.` };
        }
      }
    } catch (err) {
      if (pendingSave?.token === operation.token && formOpen && formGeneration === operation.generation) {
        formNote = { kind: "failed", text: refusalReason(err) ?? (err instanceof Error ? err.message : String(err)) };
      }
    } finally {
      if (pendingSave?.token === operation.token) pendingSave = null;
    }
  }

  /** One explicit provider/model pair, through the existing preference door. */
  async function makeDefault(providerId: string, modelId: string): Promise<void> {
    if (defaultBusy !== null) return;
    defaultBusy = JSON.stringify([providerId,modelId]); defaultNote = null;
    try {
      assertLiveForWrite();
      await saveModelPrefs({providers:[],defaultProvider:providerId,defaultModel:modelId});
    } catch (err) {
      defaultNote = refusalReason(err) ?? (err instanceof Error ? err.message : String(err));
    } finally { defaultBusy = null; }
  }

  async function probe(p: ProviderInfo): Promise<void> {
    if (probeRuns.has(p.id)) return;
    const operation = { current: true };
    probeRuns.set(p.id, operation);
    testNotes.set(p.id, "asking the provider itself…");
    try {
      const result = await testModelProvider(p.id);
      if (probeRuns.get(p.id) !== operation || !operation.current) return;
      if (result.ok) {
        testNotes.set(p.id, `answers: a real request came back in ${result.elapsedMs}ms`);
        return;
      }
      const words =
        result.failureKind !== undefined && result.failureKind in TEST_FAILURE_WORDS
          ? TEST_FAILURE_WORDS[result.failureKind]
          : "the request did not complete";
      testNotes.set(p.id, result.detail !== undefined && result.detail.length > 0
            ? `${words}: ${result.detail}`
            : words);
    } catch (err) {
      if (probeRuns.get(p.id) !== operation || !operation.current) return;
      testNotes.set(p.id, refusalReason(err) ?? (err instanceof Error ? err.message : String(err)));
    } finally {
      if (probeRuns.get(p.id) === operation) probeRuns.delete(p.id);
    }
  }

  async function remove(p: ProviderInfo): Promise<void> {
    if (armedDelete !== p.id) {
      // Two presses: the first arms and SAYS what the second will do.
      armedDelete = p.id;
      return;
    }
    armedDelete = null;
    invalidateProbe(p.id);
    try {
      // Same write-door rule as the save: no Broker on this path.
      assertLiveForWrite();
      await deleteModelProvider(p.id);
      if (editingId === p.id) closeForm();
    } catch (err) {
      testNotes.set(p.id, refusalReason(err) ?? (err instanceof Error ? err.message : String(err)));
    }
  }
</script>

<section bind:this={sectionElement} class="category providers" data-category="model-providers" data-field="providers-section">
  <header class="cat-head">
    <h2 class="cat-title engraved">Model providers</h2>
    <span class="cat-count engraved">
      {#if providers !== null}
        {providers.length}
        {providers.length === 1 ? "provider" : "providers"} saved
      {/if}
    </span>
  </header>

  {#if catalog === null}
    <Answer answer={pending("reading the saved providers")} />
  {:else if providers === null}
    <Answer answer={failed(`the provider list: ${UNREADABLE_SHAPE}`)} />
  {:else}
    {#if catalog.setupRequired === true}
      <!-- The guided state's own words: the SAME sentence a refused run
           shows (one owner, served), now standing beside its remedy. -->
      <p class="setup" data-field="provider-setup-remedy">{catalog.setupRemedy}</p>
    {/if}

    {#if defaultChoices.length > 0}
      <label class="f-field default-choice" data-field="provider-default-picker">
        <span class="f-label">Default for new conversations</span>
        <select name="provider-default-model" data-verb-id="models.default/set" aria-busy={defaultBusy !== null} aria-disabled={defaultBusy !== null} value={selectedDefault} onchange={event => {
          const choice=defaultChoices.find(c=>c.key===event.currentTarget.value);
          event.currentTarget.value=selectedDefault;
          if(choice&&choice.key!==selectedDefault)void makeDefault(choice.providerId,choice.modelId);
        }}>
          {#if !defaultChoices.some(c=>c.key===selectedDefault)}<option value={selectedDefault} disabled>Choose a model</option>{/if}
          {#each providers as p(p.id)}<optgroup label={p.id}>
            {#each p.models as m(m.id)}<option value={JSON.stringify([p.id,m.id])}>{m.id}</option>{/each}
          </optgroup>{/each}
        </select>
      </label>
      {#if defaultBusy !== null}<p role="status">Saving the default model…</p>{/if}
      {#if defaultNote !== null}<p class="f-note" role="status" data-field="provider-default-note">{defaultNote}</p>{/if}
    {/if}
    <ul class="provider-list">
      {#each providers as p (p.id)}
        <li class="provider-row setting-row" data-provider={p.id}>
          <span class="p-name">{p.id}</span>
          <span class="p-url" title={p.baseUrl}>{p.baseUrl}</span>
          <span class="p-key engraved" data-has-key={p.hasApiKey}>
            {p.hasApiKey ? "Key saved" : "Key needed"}
          </span>
          {#if (p.headerNames ?? []).length > 0}
            <span
              class="p-headers engraved"
              data-field="provider-headers"
              title={`extra request headers: ${(p.headerNames ?? []).join(", ")}: values are never shown`}
            >
              {p.headerNames!.length} extra {p.headerNames!.length === 1 ? "header" : "headers"}
            </span>
          {/if}
          <span class="p-verbs">
            <button
              class="verb edit"
              data-verb-id="models.provider/edit"
              aria-label="Edit"
              title="Change this provider's address, models or key; a blank key field keeps the saved one."
              onclick={() => openEdit(p)}
            >{VERB_MARK.edit}</button>
            <button
              class="verb "
              data-verb-id="models.provider/test"
              aria-disabled={probeRuns.has(p.id)} aria-busy={probeRuns.has(p.id)}
              title="Sends one real request to this provider's endpoint so a wrong key or address is found before a run depends on it."
              onclick={() => void probe(p)}
            >Test</button>
            <button
              class="verb danger"
              data-verb-id="models.provider/delete"
              title="Removes this provider from your account; conversations that used it keep their history."
              onclick={() => void remove(p)}
            >{armedDelete === p.id ? "Delete: press again to confirm" : "Delete"}</button>
          </span>
          {#if testNotes.get(p.id) !== undefined}
            <span class="p-note" data-field="provider-test-note">{testNotes.get(p.id)}</span>
          {/if}
          <span class="p-models">{p.models.map(m=>m.id).join(" · ")}</span>
        </li>
      {/each}
    </ul>

    {#if !formOpen}
      <button class="verb add insertion" data-verb-id="models.provider/add" onclick={openAdd}>
        {VERB_MARK.add} Add provider
      </button>
    {:else}
      <form bind:this={formElement} class="provider-form connection-form" aria-label={editingId === null ? "add a model provider" : `edit provider ${editingId}`} onsubmit={submit} oninput={changedDraft}>
        <label class="f-field">
          <span class="f-label engraved">Name</span>
          <input
            type="text"
            name="provider-name"
            bind:value={fName}
            readonly={editingId !== null}
            placeholder="how the picker names it"
          />
        </label>
        <label class="f-field">
          <span class="f-label engraved">API address</span>
          <input type="text" name="provider-base-url" bind:value={fBaseUrl} placeholder="https://…/v1" />
        </label>
        <label class="f-field">
          <span class="f-label engraved">
            API key {editingId !== null ? "· Blank keeps the saved one" : "· Sent once, never shown again"}
          </span>
          <input type="password" name="provider-api-key" bind:value={fApiKey} autocomplete="off" />
        </label>
        <details class="setting-details form-wide"><summary>Extra request headers</summary>
        <label class="f-field"><span class="f-label">One "Name: value" per line.{editingId !== null && !headersCleared ? " Blank keeps saved headers." : ""}</span>
          <textarea
            name="provider-headers"
            bind:value={fHeaders}
            rows={3}
            placeholder={"X-Org-Id: my-org\nX-Custom: value"}
            spellcheck="false"
          ></textarea>
          {#if editingId !== null}{@const saved = providers.find(p=>p.id===editingId)}{#if saved?.headerNames?.length}<span class="f-help">{headersCleared ? "Saved headers will be removed." : "Saved: " + saved.headerNames.join(", ")}</span>{/if}{/if}
        </label>
        {#if editingId !== null && providers.find(p=>p.id===editingId)?.headerNames?.length}
          <button type="button" class="verb" data-verb-id="models.provider/clear-headers" onclick={() => { headersCleared = !headersCleared; fHeaders = ""; changedDraft(); clearDiscovery(); }}>{headersCleared ? "Keep saved headers" : "Remove saved headers"}</button>
        {/if}
        </details>
        <div class="discovery form-wide">
          <div class="discovery-actions">
            <button class="verb" type="button" data-verb-id="models.provider/discover" aria-busy={discovery.kind === "pending"} aria-disabled={discovery.kind === "pending"} onclick={() => void findModels()}>{discovery.kind === "pending" ? "Finding models…" : "Find models"}</button>
            {#if discovery.kind === "pending"}<button class="verb" type="button" data-verb-id="models.provider/cancel-discovery" onclick={clearDiscovery}>Cancel</button>{/if}
          </div>
          <p class="discovery-note" role="status">{#if discovery.kind === "failed"}{discovery.text} You can still enter model IDs below.{:else if discovery.kind === "ready"}{discovery.models.length === 0 ? "No models were listed. Enter a model ID below." : discovery.models.length + " models found. Choose which to add."}{/if}</p>
          {#if discovery.kind === "ready" && discovery.models.length > 0}
            <label class="f-field"><span class="f-label">Filter discovered models</span><input name="provider-discovery-query" type="search" bind:value={discoveryQuery} oninput={() => discoveryPage = 0} /></label>
            <label class="f-field"><span class="f-label">Add a discovered model</span>
              <select name="provider-discovered-model" value="" onchange={event => { const id = event.currentTarget.value; event.currentTarget.value = ""; void addDiscoveredModel(id); }}>
                <option value="">Choose a model</option>
                {#each discoveryRows as model (model.id)}<option value={model.id} disabled={selectedModelIds.has(model.id)}>{model.id}{selectedModelIds.has(model.id) ? " · Added" : ""}</option>{/each}
              </select>
            </label>
            {#if discoveryMatches.length > PROVIDER_DISCOVERY_PAGE_SIZE}<div class="discovery-actions">
              <button class="verb" type="button" data-verb-id="models.provider/discovery-previous" disabled={discoveryPage === 0} onclick={() => discoveryPage -= 1}>Previous models</button>
              <span>{discoveryPage * PROVIDER_DISCOVERY_PAGE_SIZE + 1}–{Math.min(discoveryMatches.length, (discoveryPage + 1) * PROVIDER_DISCOVERY_PAGE_SIZE)} of {discoveryMatches.length}</span>
              <button class="verb" type="button" data-verb-id="models.provider/discovery-next" disabled={(discoveryPage + 1) * PROVIDER_DISCOVERY_PAGE_SIZE >= discoveryMatches.length} onclick={() => discoveryPage += 1}>Next models</button>
            </div>{:else if discoveryMatches.length === 0}<p>No model IDs match this filter.</p>{/if}
          {/if}
        </div>
        <div class="f-field form-wide">
          <span class="f-label engraved">
            Models · Enter an ID or choose one above
          </span>
          <div class="model-rows" data-field="provider-model-rows" bind:this={modelRowsElement}>
            {#each fModelRows as row, i (row)}
              {@const contextQuantity = parseTokenQuantity(row.contextWindow)}
              {@const replyQuantity = parseTokenQuantity(row.maxTokens)}
              <div class="model-row" data-model-row={i}>
                <label class="model-name-field">
                <span class="f-label">Model {i + 1}</span>
                <input
                  type="text"
                  name="provider-model-id"
                  class="m-id"
                  data-field="model-id"
                  aria-label={`model ${i + 1} name`}
                  placeholder="model-id"
                  bind:value={row.id}
                />
                </label>
                <button
                  class="verb remove"
                  type="button"
                  data-verb-id="models.provider/remove-model"
                  aria-label={`Remove model ${i + 1}`}
                  title="Remove this model from the provider."
                  onclick={() => removeModelRow(i)}
                >{VERB_MARK.remove}</button>
                <details class="model-options setting-details"><summary>Limits <span>{limitsSummary(row)}</span></summary>
                <div class="model-limits">
                <label><span class="f-label">Context window</span>
                <input
                  type="text"
                  name="provider-model-context-window"
                  inputmode="text"
                  class="m-num"
                  data-field="model-context-window"
                  aria-label={`context window for model ${i + 1}, in tokens`}
                  title="what one request to this model can hold, input and output together: the gauge and the trim honour it"
                  bind:value={row.contextWindow}
                />
                {#if contextQuantity && contextQuantity.expanded !== row.contextWindow.trim()}<span class="quantity-preview">{contextQuantity.expanded} tokens</span>{/if}
                </label>
                <label><span class="f-label">Max reply tokens</span>
                <input
                  type="text"
                  name="provider-model-max-tokens"
                  inputmode="text"
                  class="m-num"
                  data-field="model-max-tokens"
                  aria-label={`max tokens for model ${i + 1}`}
                  title="the cap on this model's reply length, sent with every request"
                  bind:value={row.maxTokens}
                />
                {#if replyQuantity && replyQuantity.expanded !== row.maxTokens.trim()}<span class="quantity-preview">{replyQuantity.expanded} tokens</span>{/if}
                </label>
                <label><span class="f-label">Temperature (0–2)</span>
                <input
                  type="text"
                  name="provider-model-temperature"
                  inputmode="decimal"
                  class="m-num"
                  data-field="model-temperature"
                  aria-label={`temperature for model ${i + 1}`}
                  title="this model's sampling default, from 0 (exact) to 2 (loose)"
                  bind:value={row.temperature}
                />
                </label>
                </div>
                </details>
              </div>
            {/each}
            <button
              class="verb add insertion"
              type="button"
              data-verb-id="models.provider/add-model"
              onclick={addModelRow}
            >{VERB_MARK.add} Add model</button>
          </div>
        </div>
        {#if formNote !== null}
          <p class="f-note form-wide" role="status" data-field="provider-form-note" class:confirmed={formNote.kind === "saved"}>{formNote.text}</p>
        {/if}
        <div class="f-verbs form-wide">
          <button
            class="verb primary commit" aria-busy={busy}
            data-commit-state={busy ? "pending" : "draft"}
            class:add={editingId === null}
            class:ok={editingId !== null}
            type="submit"
            aria-disabled={busy}
            data-verb-id="models.provider/save"
          >
            <span class="commit-copy"><strong>{busy ? "Saving…" : "Save provider"}</strong><span>{busy && pendingSave?.revision !== draftRevision ? "Saving the earlier edit; newer changes are unsaved" : editingId === null ? "Add to your account" : "Apply these provider details"}</span></span>
            <span class="commit-mark" aria-hidden="true"></span>
          </button>
          <button
            class="verb cancel "
            type="button"
            onclick={closeForm}
            data-verb-id="models.provider/cancel"
            aria-label={VERB_MARK_WORD.cancel}
            title={VERB_MARK_WORD.cancel}
          >
            {VERB_MARK_WORD.cancel}
          </button>
        </div>
      </form>
    {/if}
  {/if}
</section>

<style>
  /* The section wears the room's category vocabulary: restated here
   * because Svelte's scoping does not reach across the component seam. */
  .providers {
    margin-bottom: var(--sp-5);
  }
  .cat-head {
    display: flex;
    align-items: baseline;
    gap: var(--sp-3);
    border-bottom: var(--hairline-w) solid var(--line-1);
    padding-bottom: var(--sp-1);
    margin-bottom: var(--sp-2);
  }
  .cat-title {
    margin: 0;
    color: var(--ink-1);
  }
  .cat-count {
    color: var(--ink-3);
  }
  .provider-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }
  .provider-row {
    display: grid;
    /* The models cell is `.trunc`: its track must be able to sink under
     * width pressure (min 0) or the nowrap joined list holds the track at
     * its full min-content and the row overflows instead of ellipsing. */
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--sp-1) var(--sp-3);
    align-items: baseline;
    /* Chrome, hover and hit floor come from the owned `.setting-row`. */
  }
  .p-name {
    color: var(--ink-1);
    font-weight: var(--f-heading-weight);
    font-size: var(--f-ui-size);
  }
  .p-url,
  .p-headers {
    color: var(--ink-3);
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
  }
  .p-url { grid-column: 1; overflow-wrap: anywhere; }
  .p-key { grid-column: 1; }
  .p-verbs { grid-column: 2; grid-row: 1 / 4; align-self: start; }
  .p-key {
    color: var(--ink-3);
  }
  .p-key[data-has-key="false"] {
    color: var(--warn);
  }
  .p-headers {
    color: var(--ink-3);
  }
  .default-choice { margin-block: var(--sp-3); }
  .p-models { grid-column: 1 / -1; overflow-wrap: anywhere; color: var(--ink-2); font-size: var(--f-data-size); }
  .quantity-preview { color: var(--ink-2); font-size: var(--f-data-size); overflow-wrap: anywhere; }
  .p-verbs {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
  }
  .p-note {
    grid-column: 1 / -1;
    color: var(--ink-2);
    font-size: var(--f-ui-size);
  }
  .setup {
    margin: 0 0 var(--sp-2);
    color: var(--warn);
    font-size: var(--f-ui-size);
    max-width: 70ch;
  }
  /* The verb recipe is owned by tokens.css (.cockpit .verb); the providers
   * section's verbs keep the micro engraved register and the stronger bezel. */
  .verb.add {
    align-self: flex-start;
    margin-top: var(--sp-2);
  }
  .discovery { display: grid; gap: var(--sp-2); min-width: 0; }
  .discovery-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
  .discovery-note { margin: 0; overflow-wrap: anywhere; }
  .provider-form { margin-top: var(--sp-5); }
  .f-field {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    min-width: 0;
  }
  .f-label {
    color: var(--ink-2);
  }
  .f-field textarea {
    font: inherit;
    font-family: var(--face-sans);
    font-size: var(--f-data-size);
    color: var(--ink-1);
    background: var(--ground-1);
    border: var(--hairline-w) solid var(--line-2);
    border-radius: var(--radius-1);
    padding: var(--sp-2) var(--sp-3);
    min-height: var(--hit-min);
    min-width: 0;
    width: 100%;
  }
  .f-field textarea {
    resize: vertical;
    /* A three-line floor, expressed in the spacing scale rather than a font
       unit so the tokens owner stays the single source for lengths. */
    min-height: calc(var(--sp-5) + var(--sp-3));
  }
  /* One row per model: name, then its three stored settings. The name
   * column can grow; the number columns hold their labels' width and sink
   * under pressure (min 0) so the remove verb never leaves the row. */
  .model-rows {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .model-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--sp-1) var(--sp-2);
    align-items: end;
    min-width: 0;
    padding-block: var(--sp-2);
    border-block-start: var(--hairline-w) solid var(--line-1);
  }
  .model-row label { display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; }
  .model-options { grid-column: 1 / -1; min-width: 0; }
  .model-options summary span { color: var(--ink-2); }
  .model-limits {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, var(--model-field-min)), 1fr));
    gap: var(--sp-3);
    min-width: 0;
  }
  .model-row .m-num {
    text-align: right;
  }
  .f-note.confirmed { color: var(--ok); }
  .f-note {
    margin: 0;
    color: var(--alarm);
    font-size: var(--f-ui-size);
  }
  .f-verbs {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    padding-block: var(--sp-2);
    gap: var(--sp-2);
  }
</style>
