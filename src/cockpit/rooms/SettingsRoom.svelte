<script lang="ts">
  /**
   * THE SETTINGS INDEX (DESIGN-COCKPIT-V2 §9.3, ⌘,): one searchable room
   * over every served customization plus the cockpit's device preferences.
   *
   * ── WHAT CHANGED, AND WHY IT IS NOT A CATEGORIES-AS-PAGES REGRESSION ────
   *
   * §9.3 forbids "categories-as-pages": a settings surface where finding a
   * setting means guessing which page it is behind. It does not forbid
   * structure: a flat wall of eighty-two rows in a 76ch column on a 2560px
   * screen is its own way of hiding everything, which is what the user
   * reported ("settings menu should be much more easy to navigate, separate
   * things by category, take advantage of the width of the screen").
   *
   * So: categories, but never as pages. Every setting of every category is in
   * ONE continuous scroll; the rail is a map of that scroll, not a set of
   * doors. Pressing a category moves the reading position: nothing is hidden
   * by pressing it, and nothing was hidden before pressing it. At wide width
   * the map and the content are on screen at the same time, which is what the
   * width is spent on.
   *
   * ── THE CATEGORIES ARE DERIVED, NOT AUTHORED ───────────────────────────
   *
   * There is no namespace→name table in this file, and there must never be
   * one. The words come from the registry's own module declarations
   * (`shared/exposure/registrations/*.ts` → `registerExposureModule`, served
   * as `UiSchema.exposureModules`) joined to each setting's DECLARED owning
   * module, plus `local-prefs.ts::LOCAL_MODULES` for the rows this client
   * owns. That is the property that makes this surface survive the next
   * capability: a module registered tomorrow appears here, with its own
   * words, with no edit to this component. A hand-written map here would
   * break it silently: the twelfth module would simply never show up under
   * a name anyone chose.
   *
   * A namespace that owns settings but declares no category still renders,
   * spelled out, and SAYS its category is underived (`declared: false`).
   * Rows are never unreachable because their words are missing.
   *
   * Every row: label · plain description · the value the server read back ·
   * where that value came from (a change, or the built-in default) · when a
   * change takes effect · the SAME SettingSheet component inline (§9.3: the
   * index rows and the in-place sheets are one component bound to one
   * action) · the surface it manifests on, where a real built one exists.
   *
   * Search is by behavior words and spans EVERY category at once: browsing
   * and finding are both first-class, and neither hides the other.
   */
  import { onMount, tick } from "svelte";

  import { uiSchema, uiSchemaValues } from "../../state/schema-store.ts";
  import { ClientError } from "../../data/errors.ts";
  import type { OutletProps, RoomId } from "../shell/contract.ts";
  import { roomExists } from "../shell/outlets.ts";
  import { whileRoomVisible } from "../shell/room-visibility.ts";
  import {
    categorize,
    effectLine,
    formatSetting,
    humanizeModule,
    labelViolation,
    provenanceOf,
    searchRows,
    servedRows,
    servedValue,
    surfaceFor,
    surfaceForModule,
    undeclaredCategories,
    type SettingRow,
  } from "../settings/settings-data.ts";
  import {
    LOCAL_MODULES,
    LOCAL_ROWS,
    cockpitLocalEpoch,
    localValue,
  } from "../settings/local-prefs.ts";
  import {
    bindSettingsReadback,
    consumeIndexQuery,
    requestSettingsData,
    settingsLoadState,
  } from "../settings/settings-feed.ts";
  import {
    CATEGORY_FOLD_MIN_ROWS,
    SETTINGS_SPLIT_MIN_PX,
  } from "../settings/settings-config.ts";
  import SettingSheet from "../settings/SettingSheet.svelte";
  // MODEL PROVIDERS (settings/ProvidersSection.svelte): not a registry
  // category: a per-account encrypted row with a write-only key, consumed
  // through the surviving /api/models routes. Mounted here because this
  // room is where the guided provider_not_configured remedy sends people.
  import ProvidersSection from "../settings/ProvidersSection.svelte";
  // THE TOOL SERVER LIST (settings/McpServersSection.svelte): the entity
  // half of the "Connected tool servers" category: the registry rows below
  // it adjust how CALLS behave, and this section is the door that registers
  // the servers those calls go to (add / edit / test / remove, through the
  // MCP route owner into the config's tools.mcpServers). Mounted INSIDE the
  // mcp category so the rail jump lands on the servers and the call knobs
  // as one area: the same entity-vs-knob split providers take.
  import McpServersSection from "../settings/McpServersSection.svelte";
  // THE DIAGNOSTIC MODES LIST (settings/DiagnosticModesSection.svelte): the
  // array door: `performance.diagnosticModes.excludedModes` holds an array
  // the served-row grammar cannot write (the sheet refuses array JSON by
  // design), so it renders as a checkbox-list section inside the performance
  // category, above the rows, writing through its own block door into the
  // ONE config gate: the McpServersSection precedent for a value shape the
  // row grammar could not express.
  import DiagnosticModesSection from "../settings/DiagnosticModesSection.svelte";
  import Answer from "../response/Answer.svelte";
  import { absent, failed, pending } from "../response/grammar.ts";

  let { shell }: OutletProps = $props();

  let query = $state("");
  let openId = $state<string | null>(null);
  let searchField = $state<HTMLInputElement | undefined>(undefined);
  let scroller = $state<HTMLElement | undefined>(undefined);

  /** The open setting's inline sheet is a LAYER on the shell's dismissal
   * ladder (UIE-033). Before it registered, Esc with a sheet open closed
   * the whole of Settings: the search, the scroll position, the folded
   * categories and the sheet went in one keystroke, having asked to close
   * one thing. Registered here (the CustodyRoom shape) the first press
   * closes the sheet and the room keeps its place; the second closes the
   * room. Stamped with the room it was pushed in, so it goes quiet while
   * Settings is hidden and speaks again the moment it is back.
   */
  $effect(() => {
    if (openId === null) return;
    return shell.pushDismiss({ label: "the setting sheet", dismiss: () => (openId = null) });
  });

  /** The room's OWN width, measured: the split is decided by the box this
   * surface actually occupies, not by the viewport, so it is right inside any
   * host (a narrow shell, a test harness). Mirrors CustodyRoom. */
  let roomW = $state(0);
  const split = $derived(roomW >= SETTINGS_SPLIT_MIN_PX);

  const load = $derived($settingsLoadState);
  const served = $derived(servedRows($uiSchema));
  const allRows = $derived([...LOCAL_ROWS, ...served]);

  /**
   * The joined declaration list: the server's module declarations plus this
   * client's own. Both are registries declaring their categories beside their
   * rows; the room does not know which is which, it only groups by what it is
   * handed.
   */
  const declarations = $derived([...LOCAL_MODULES, ...($uiSchema?.exposureModules ?? [])]);

  /** Whether a search is narrowing the list: the one owner of that question,
   * so the rail, the counts and the empty state can never disagree. */
  const searching = $derived(query.trim().length > 0);
  const matched = $derived(searchRows(allRows, query));
  const categories = $derived(categorize(matched, declarations));
  /** The full shape, ignoring the search: what the rail counts against. */
  const allCategories = $derived(categorize(allRows, declarations));

  /**
   * Declared categories that hold no settings at all.
   *
   * A real answer to "what does a category with nothing in it say": a module
   * can declare itself and expose only readings and verbs. It is named here,
   * greyed, saying exactly that: so the reader learns the area exists and
   * that there is nothing in it to turn, rather than wondering whether the
   * list is complete.
   */
  const emptyDeclared = $derived(
    declarations.filter((d) => !allCategories.some((c) => c.id === d.id)),
  );

  /**
   * Namespaces that own settings but declare no category: the gap, NAMED on
   * screen. A reader who sees a spelled-out namespace should be told it is a
   * missing declaration rather than left to wonder whether it is a real name.
   */
  const undeclared = $derived(undeclaredCategories(allRows, declarations));

  /** How many rows of a category the current search passed over. */
  function matchCount(id: string): number {
    return categories.find((c) => c.id === id)?.rows.length ?? 0;
  }
  function totalCount(id: string): number {
    return allCategories.find((c) => c.id === id)?.rows.length ?? 0;
  }

  // Folding is a GESTURE, never a default and never the system's idea: the
  // room opens with everything shown. A folded category still states how many
  // settings it is holding, so folding hides rows, never their existence.
  let folded = $state<Record<string, boolean>>({});
  function toggleFold(id: string): void {
    folded = { ...folded, [id]: !folded[id] };
  }

  // The raw-key law at the render boundary (mutation-tested): a row whose
  // label is a raw registry key must never paint as a name.
  function rowLabel(row: SettingRow): string {
    const violation = labelViolation(row.label, row.id);
    if (violation !== null) {
      throw new ClientError("cockpit_contract", `${violation}: the index speaks behavior words, never raw keys (§9.3)`);
    }
    return row.label;
  }

  function currentOf(row: SettingRow) {
    if (row.kind === "local") {
      // One epoch so a new local declaration cannot paint stale.
      void $cockpitLocalEpoch;
      return localValue(row.id) ?? undefined;
    }
    return servedValue($uiSchemaValues, row.id);
  }

  /** The row's standing value IN THIS ROW'S WORDS. The index used to ask the
   * type-only reader, so every enum row in the list printed its server token
   * (`round-robin`, `next-run`): this is the most-seen of the four sites the
   * raw tokens reached, because it renders once per row rather than once per
   * opened sheet. */
  function valueOf(row: SettingRow): string {
    return formatSetting(row, currentOf(row));
  }

  function surfaceOf(row: SettingRow) {
    return surfaceFor($uiSchema, row, roomExists);
  }

  function goTo(room: string): void {
    shell.closeRoom();
    shell.openRoom(room as RoomId);
  }

  /**
   * The rail's one job: move the reading position. It does NOT filter: every
   * category stays in the scroll, so pressing one can never be the reason a
   * setting stopped being visible.
   */
  let focusedCategory = $state<string | null>(null);
  async function jumpTo(id: string): Promise<void> {
    focusedCategory = id;
    // Providers stay mounted while searching, retaining exact form drafts.
    // Choosing their category restores the group before moving to it.
    if (id === "model-providers" && searching) { query = ""; await tick(); }
    // Found by walking the sections rather than by an interpolated attribute
    // selector: a namespace is a plain token today, and building a selector
    // out of one is the shape that breaks the day a registry id is not.
    for (const el of scroller?.querySelectorAll<HTMLElement>("[data-category]") ?? []) {
      if (el.dataset["category"] === id) {
        // `behavior: "auto"` deliberately: the jump is a position change, not
        // an animation, so `prefers-reduced-motion` has nothing to suppress.
        el.scrollIntoView({ block: "start", behavior: "auto" });
        return;
      }
    }
  }

  function clearSearch(): void {
    focusedCategory = null;
    query = "";
    searchField?.focus();
  }

  onMount(() => {
    // KEPT ALIVE (shell/RoomHost.svelte): mounted once, then shown/hidden. So
    // per-OPEN work hangs off visibility.
    //
    // The rows themselves never blank: they render from the schema store,
    // which the boot batch filled and which nothing here clears. What each
    // open does is RE-READ the values so a row shows the server's current
    // answer rather than the one from the last visit; that read patches the
    // values in place under rows that are already on screen (§9.3 honest
    // read-back), so nothing moves. The read-back subscription is held for the
    // same window: a hidden room does not need to follow other surfaces'
    // saves, it will re-read when it is shown.
    return whileRoomVisible("settings", () => {
      // A pre-search handed over by the LENS callout (several candidate
      // settings for one fact): consumed once, then the field is the user's.
      const handed = consumeIndexQuery();
      if (handed !== null) { query = handed; focusedCategory = null; }
      void requestSettingsData();
      searchField?.focus();
      return bindSettingsReadback();
    });
  });
</script>

<div class="index" class:split bind:clientWidth={roomW}>
  <header class="bar">
    <div class="find">
      <input
        bind:this={searchField}
        class="field search"
        type="text"
        name="settings-search"
        placeholder="Find a setting…"
        aria-label="search settings by behavior words"
        bind:value={query}
        oninput={() => { focusedCategory = null; }}
      />
      {#if searching}
        <button
          data-verb-id="settings.index/clear-search"
          class="verb clear"
          title="show every setting again"
          onclick={clearSearch}
        >Clear</button>
      {/if}
    </div>
    <span class="counts" title={`${LOCAL_ROWS.length} kept on this device · ${served.length} served by this install`}>
      {matched.length}{searching ? ` of ${allRows.length}` : ""} settings
      {#if searching}
        · {categories.length} of {allCategories.length} categories match
      {:else}
        · {allCategories.length} categories
      {/if}
    </span>
  </header>

  <div class="settings-body">
    <!-- THE MAP. Present at every width; at the split width it stands beside
         the settings so category and content are read at once, below it it
         rides above them in the same scroll. It never hides a row. -->
    <nav class="index-rail settings-rail" data-settings-rail aria-label="settings categories">
      {#if !split}
        <select class="field category-picker" aria-label="Go to a settings category" value={focusedCategory === null ? "" : `category:${focusedCategory}`}
          onchange={event => { const value = event.currentTarget.value; if (value.startsWith("category:")) jumpTo(value.slice(9)); else if (value.startsWith("room:")) goTo(value.slice(5)); }}>
          <option value="" disabled>Go to a category…</option>
          <option value="category:model-providers">Model providers</option>
          {#each allCategories as cat (cat.id)}<option value={`category:${cat.id}`}>{cat.title} · {searching ? `${matchCount(cat.id)}/` : ""}{totalCount(cat.id)}</option>{/each}
          {#each emptyDeclared as decl (decl.id)}
            {@const surface = surfaceForModule($uiSchema, decl.id, roomExists)}
            <option value={surface === null ? `empty:${decl.id}` : `room:${surface.room}`} disabled={surface === null}>{decl.title} · {surface === null ? "Nothing to adjust" : surface.label}</option>
          {/each}
        </select>
      {/if}
      <span class="engraved rail-cap" hidden={!split}>Categories</span>
      <ul class="rail-list" hidden={!split}>
        <li>
          <!-- The provider section rides the same map as every category so
               the guided remedy's "Open Settings" lands somewhere findable. -->
          <button
            data-verb-id="settings.index/go-to-category"
            class="rail-entry"
            data-category-link="model-providers"
            title="The model providers this account can run against: add, edit, test or remove them."
            onclick={() => jumpTo("model-providers")}
          >
            <span class="rail-title">Model providers</span>
          </button>
        </li>
        {#each allCategories as cat (cat.id)}
          {@const shown = matchCount(cat.id)}
          {@const passed = searching && shown === 0}
          <li>
            <button
              data-verb-id="settings.index/go-to-category"
              class="rail-entry"
              class:focused={focusedCategory === cat.id}
              class:passed={passed}
              data-category-link={cat.id}
              title={cat.purpose ?? `settings owned by "${cat.id}": this area declares no description`}
              onclick={() => jumpTo(cat.id)}
            >
              <span class="rail-title">{cat.title}</span>
              <span class="rail-count">
                {#if searching}{shown}/{totalCount(cat.id)}{:else}{cat.rows.length}{/if}
              </span>
            </button>
          </li>
        {/each}
        {#each emptyDeclared as decl (decl.id)}
          {@const surface = surfaceForModule($uiSchema, decl.id, roomExists)}
          <li>
            <!-- An area that exists and holds nothing to turn. Named, not
                 omitted: a missing category reads as a missing feature.
                 The tile is this area's ONLY settings-side surface (no
                 section renders for a category with no rows), so when its
                 readings live in another room the tile carries the room's
                 own cross-link grammar: without it, the area's readings
                 hang on prior knowledge of where readings render. The tile
                 itself stays a non-link: it is information, and a greyed
                 span that looked clickable would promise a verb it does
                 not have. -->
            <span class="rail-empty" title={decl.purpose}>
              <span class="rail-title">{decl.title}</span>
              <span class="rail-count">nothing to adjust</span>
              {#if surface !== null}
                <button
                  data-verb-id="settings.index/go-to-surface"
                  class="surface-link"
                  title="leave settings and open the room where these readings live"
                  onclick={() => goTo(surface.room)}
                >{surface.label} →</button>
              {/if}
            </span>
          </li>
        {/each}
      </ul>
      {#if load.kind === "failed"}
        <p class="rail-note">the install's own settings could not be read: only this device's are listed</p>
      {/if}
      {#if undeclared.length > 0}
        <p class="rail-note gap">
          {undeclared.length}
          {undeclared.length === 1 ? "area has" : "areas have"} not declared what they are —
          their settings are listed under their internal name
        </p>
      {/if}
    </nav>

    <div class="settings-scroll" data-settings-scroll bind:this={scroller}>
      <!-- ABOVE the registry branches, deliberately: the guided
           provider_not_configured remedy sends people here, and the way
           out of that state must not depend on the settings registry
           having loaded. Search narrows the REGISTRY; providers stay
           mounted so a rail jump to "Model providers" still finds them
           (they are not registry rows, so they do not pretend to match
           the query). -->
      <div class="provider-group" hidden={searching}><ProvidersSection /></div>
      {#if load.kind === "pending" && served.length === 0}
        <Answer answer={pending("reading the served settings")} />
      {:else if load.kind === "failed" && served.length === 0}
        <Answer answer={failed(`served settings not readable: ${load.reason}`)} />
      {:else if categories.length === 0}
        <Answer
          answer={absent(
            `no setting's behavior matches “${query}”: clear the search to see all ${allRows.length}`,
          )}
        />
      {:else}
        {#if load.kind === "failed"}
          <p class="stale-note">
            the last read of the install's settings failed: {load.reason}. The values below are
            the previous answer, not a fresh one.
          </p>
        {/if}
        {#each categories as cat (cat.id)}
          {@const surface = surfaceOf(cat.rows[0]!)}
          <section class="category" data-category={cat.id}>
            <header class="cat-head">
              <h2 class="cat-title engraved">{cat.title}</h2>
              <span class="cat-count">
                {cat.rows.length}
                {cat.rows.length === 1 ? "setting" : "settings"}
                {#if searching && totalCount(cat.id) !== cat.rows.length}
                  of {totalCount(cat.id)} matching
                {/if}
              </span>
              {#if cat.rows.length >= CATEGORY_FOLD_MIN_ROWS}
              <button
                data-verb-id="settings.index/fold-category"
                class="verb fold"
                aria-expanded={folded[cat.id] !== true}
                title={folded[cat.id] === true
                  ? `Show the ${cat.rows.length} settings in ${cat.title}`
                  : `Hide the ${cat.rows.length} settings in ${cat.title}`}
                onclick={() => toggleFold(cat.id)}
              >{folded[cat.id] === true ? "Show" : "Hide"}</button>
              {/if}
            </header>
            {#if surface !== null}
              <!-- WHERE THIS CATEGORY'S BEHAVIOR SHOWS UP. Derived per MODULE
                   (settings-data.surfaceFor reads only the row's module), so
                   it is a fact about the category, not about each row: put on
                   every row it would be the same sentence eighty times. -->
              <button
                data-verb-id="settings.index/go-to-surface"
                class="surface-link"
                title="leave settings and open the surface these change"
                onclick={() => goTo(surface.room)}
              >{surface.label} →</button>
            {/if}
            {#if searching}
              <!-- The matching setting explains itself; the category remains in the map. -->
            {:else if cat.purpose !== null}
              <p class="cat-purpose">{cat.purpose}</p>
            {:else}
              <!-- Honest absence: nobody declared what this area is. The rows
                   are all here; only the words above them are missing. -->
              <p class="cat-purpose undeclared">
                “{humanizeModule(cat.id)}” has not declared what this area does: its settings are
                listed in full below.
              </p>
            {/if}

            {#if cat.id === "mcp"}
              <McpServersSection />
            {/if}

            {#if cat.id === "performance"}
              <DiagnosticModesSection />
            {/if}

            {#if folded[cat.id] !== true}
              <ul class="rows" class:setting-tracks={split}>
                {#each cat.rows as row (row.id)}
                  {@const value = currentOf(row)}
                  {@const provenance = provenanceOf(row, value)}
                  <!-- LENS: the row IS a setting, so it declares itself with the
                       setting vocabulary (`data-setting`) rather than a read key —
                       the value beside the label is the registry's own read-back,
                       not a Broker-cached block response. -->
                  <li class="setting-row" class:open={openId === row.id} data-setting={row.id}>
                    <button
                      data-verb-id="settings.index/adjust"
                      class="row-face"
                      aria-expanded={openId === row.id}
                      title={openId === row.id ? "Close this setting" : "Open this setting to change it"}
                      onclick={() => (openId = openId === row.id ? null : row.id)}
                    >
                      <span class="row-identity">
                        <span class="label">{rowLabel(row)}</span>
                      </span>
                      {#if openId !== row.id}<span class="description">{row.description}</span>{/if}
                      <span class="row-reading">
                        {#if openId !== row.id}
                          <span class="value" data-provenance={provenance}>{valueOf(row)}</span>
                          {#if provenance === "changed"}<span class="provenance">Custom</span>{/if}
                          {#if row.kind === "served" && row.effect !== "immediate"}<span class="timing">{effectLine(row)}</span>{/if}
                        {/if}
                      </span>
                      <span class="disclosure-mark" aria-hidden="true"></span>
                    </button>
                    {#if openId === row.id}
                      <div class="inline-sheet">
                        <SettingSheet settingId={row.id} inline={true} />
                      </div>
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
          </section>
        {/each}
      {/if}
    </div>
  </div>
</div>

<style>
  .index {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    justify-self: stretch;
    align-self: stretch;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: var(--sp-4);
    padding: var(--sp-2) var(--sp-4);
    border-bottom: var(--hairline-w) solid var(--line-1);
    flex: none;
    flex-wrap: wrap;
  }
  .find {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex: 1;
    min-width: 0;
    flex-basis: var(--switch-field-w);
  }
  .search {
    flex: 1;
    min-width: 0;
    min-height: var(--hit-min);
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--ink-1);
    background: var(--ground-2);
    border: var(--hairline-w) solid var(--line-2);
    border-radius: var(--radius-1);
    padding: var(--sp-1) var(--sp-2);
  }
  /* Chrome is `.verb`. Layout: sit at the end of the search row. */
  .counts {
    margin-left: auto;
    font-family: var(--face-mono);
    font-size: var(--f-micro-size);
    color: var(--ink-2);
  }

  /* ── The body: map beside content at width, map above it below ────────── */
  .settings-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .index:not(.split) .settings-rail {
    width: 100%;
    min-width: 0;
    max-width: 100%;
    max-height: calc(var(--hit-min) * 2 + var(--sp-5));
  }
  .category-picker { width: 100%; }
  .rail-list[hidden], .rail-cap[hidden] { display: none; }
  .index.split .settings-body {
    flex-direction: row;
  }

  .settings-rail {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    padding: var(--sp-3) var(--sp-4);
    border-bottom: var(--hairline-w) solid var(--line-1);
    overflow-y: auto;
    min-height: 0;
  }
  .index.split .settings-rail {
    border-bottom: none;
    border-right: var(--hairline-w) solid var(--line-1);
  }
  .rail-cap {
    padding-bottom: var(--sp-1);
  }
  .rail-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-1);
  }
  .index.split .rail-list {
    flex-direction: column;
    flex-wrap: nowrap;
  }
  /* Layout (2-column title|count grid, nowrap, width) is `.index-rail`
   * in tokens.css. Chrome stays local. */
  .rail-entry,
  .rail-empty {
    min-height: var(--hit-min);
    padding: var(--sp-1) var(--sp-2);
    background: none;
    border: none;
    border-radius: var(--radius-1);
    text-align: left;
    font-size: var(--f-ui-size);
    color: var(--ink-2);
  }
  .rail-entry {
    cursor: pointer;
  }
  .rail-entry:hover {
    background: var(--layer-hover);
    color: var(--ink-1);
  }
  .rail-entry.focused {
    background: var(--layer-select);
    color: var(--ink-1);
  }
  /* A category the search passed over: dimmed, still listed, still pressable.
   * Hiding it would make the reader wonder what the search removed. */
  .rail-entry.passed {
    color: var(--ink-4);
  }
  .rail-empty {
    color: var(--ink-4);
  }
  /* Title nowrap + min-width live on `.cockpit .index-rail .rail-title`.
   * min-width: 0 here was the wrap fight against that recipe. */
  .rail-count {
    font-family: var(--face-mono);
    font-size: var(--f-nano-size);
    font-variant-numeric: tabular-nums slashed-zero;
    color: var(--ink-4);
  }
  .rail-note {
    margin: 0;
    font-family: var(--face-mono);
    font-size: var(--f-nano-size);
    color: var(--warn);
  }
  /* A missing DECLARATION is not an abnormal state: it is an incomplete one.
   * Ink, not alarm (§12.2: colour is spent on facts in a declared state). */
  .rail-note.gap {
    color: var(--ink-4);
  }

  .settings-scroll {
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow-y: auto;
    padding: var(--sp-4) var(--sp-5) var(--sp-7);
    display: flex;
    flex-direction: column;
    gap: var(--sp-5);
  }
  .settings-scroll > :global(*) { flex-shrink: 0; }
  .provider-group[hidden] { display: none; }
  .stale-note {
    margin: 0 0 var(--sp-4);
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--warn);
    max-width: var(--measure);
  }

  .category {
    padding-bottom: var(--sp-5);
    /* The jump target lands the heading under the scroller's own top edge
     * rather than flush against it. */
    scroll-margin-top: var(--sp-3);
  }
  .cat-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--sp-3);
    padding-bottom: var(--sp-1);
    border-bottom: var(--hairline-w) solid var(--line-2);
  }
  /* The engraved recipe is owned by tokens.css (.cockpit .engraved); a
   * category title is the register's word at the brighter ink. */
  .cat-title {
    margin: 0;
    color: var(--ink-1);
  }
  .cat-count {
    font-family: var(--face-sans);
    font-size: var(--f-data-size);
    color: var(--ink-2);
    white-space: normal;
  }
  .fold {
    margin-left: auto;
  }
  .cat-purpose {
    margin: var(--sp-2) 0 var(--sp-2);
    color: var(--ink-2);
    font-size: var(--f-ui-size);
    max-width: var(--measure);
  }
  .cat-purpose.undeclared {
    /* An honest absence (no declared purpose) wears the absence ink, never
     * the retired italic slant. */
    color: var(--state-absent-ink);
  }

  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .index.split .rows {
    display: grid;
  }
  /* Chrome (hairline, hover, hit floor) is `.setting-row` in tokens.css.
   * Shared tracks live on `.setting-tracks` (tokens.css). Narrow: one
   * column so the index still stacks. */
  .row-face {
    width: 100%;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) minmax(0, 1fr) auto;
    gap: var(--sp-0) var(--sp-3);
    align-items: center;
    background: none;
    border: none;
    padding: var(--sp-3) var(--sp-2);
    cursor: pointer;
    text-align: left;
    color: var(--ink-1);
    font-size: var(--f-ui-size);
  }
  .setting-row.open .row-face,
  .setting-row.open {
    background: transparent;
  }
  .setting-row.open { border-color: var(--accent); }
  .row-identity { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; }
  .row-reading { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: baseline; gap: var(--sp-1) var(--sp-2); min-width: 0; }
  .row-reading .provenance { grid-column: 2; }
  .row-reading .timing { grid-column: 1 / -1; }
  .setting-row.open .row-identity { grid-column: 1 / -2; }
  .row-reading:empty { display: none; }
  .label {
    min-width: 0;
    font-weight: var(--f-heading-weight);
  }
  .description {
    min-width: 0;
    color: var(--ink-2);
    font-size: var(--f-data-size);
  }
  .value {
    min-width: 0;
    /* `anywhere`, not `break-word`: it also lowers the cell's min-content,
     * so the value track can sink to its floor under width pressure and a
     * long identifier breaks instead of painting over the next column. */
    overflow-wrap: anywhere;
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    font-variant-numeric: tabular-nums slashed-zero;
    color: var(--ink-2);
  }
  /* A value that DIFFERS from the built-in default is the one fact on the row
   * that says somebody made a decision here. It reads at full ink; a default
   * stays quiet. No colour: a changed setting is not an abnormal one. */
  .value[data-provenance="changed"] {
    color: var(--accent);
  }
  .provenance,
  .timing {
    min-width: 0;
    overflow-wrap: anywhere;
    font-family: var(--face-mono);
    font-size: var(--f-nano-size);
    color: var(--ink-2);
  }
  .inline-sheet {
    /* In the split grid the parent row is a subgrid; without an explicit
     * span the sheet auto-places into the label track and is squeezed to
     * one column's width. Narrow rows are not a grid, where this is inert. */
    grid-column: 1 / -1;
    padding: 0 var(--sp-2) var(--sp-3);
  }
  .index:not(.split) .bar { gap: var(--sp-1); padding: var(--sp-2) var(--sp-3); }
  .index:not(.split) .counts { font-family: var(--face-sans); margin: 0; }
  .index:not(.split) .settings-rail { padding: var(--sp-1) var(--sp-3) var(--sp-2); }
  .index:not(.split) .settings-scroll { padding: var(--sp-3); }
  .index:not(.split) .row-face { grid-template-columns: minmax(0, 1fr) auto; }
  .index:not(.split) .description { grid-row: 2; grid-column: 1 / -1; margin-top: var(--sp-2); }
  .index:not(.split) .row-reading { grid-row: 3; grid-column: 1 / -1; grid-template-columns: auto minmax(0, 1fr) auto; margin-top: var(--sp-2); }
  .index:not(.split) .row-reading .provenance { grid-row: 1; grid-column: 3; }
  .index:not(.split) .disclosure-mark { grid-row: 1; grid-column: 2; }
  .surface-link {
    min-height: var(--hit-min);
    font-family: var(--face-mono);
    font-size: var(--f-nano-size);
    color: var(--ink-3);
    background: none;
    border: none;
    padding: var(--sp-1) 0;
    cursor: pointer;
  }
  /* Inside the rail-empty grid the link is a third cell on the title's own
   * column (row 2, column 1). A grid cell justifies stretch by default,
   * which would widen the link's hit box to the whole column: the local
   * fact; the tile grid itself is the token recipe's. */
  .rail-empty .surface-link {
    justify-self: start;
  }
  .surface-link:hover {
    color: var(--ink-1);
  }
</style>
