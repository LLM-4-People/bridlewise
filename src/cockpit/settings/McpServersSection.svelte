<script lang="ts">
  /**
   * CONNECTED TOOL SERVERS: the servers list inside the settings room's MCP
   * category. The category's four registry rows adjust how CALLS to servers
   * behave (retries, wait growth, time limits); this section is the missing
   * other half: the door that registers the servers those calls go to —
   * add, edit, test, remove. Before it, the only way to add a server was
   * hand-editing the config file.
   *
   * WHY A SECTION AND NOT A REGISTRY ROW: a server registration is an
   * ENTITY (a name, a transport, a command or address, credentials), not a
   * scalar knob: the same reason providers are a section. The writes go
   * through the client wrappers to the MCP route owner, which persists them
   * through the ONE config gate into `tools.mcpServers`. The config file
   * stays the single source of truth; a config edit is picked up HOT (the
   * runtime fingerprint moves and the next use rebuilds the registry).
   *
   * CREDENTIALS ARE WRITE-ONLY (the provider apiKey contract): environment
   * values, header values and the auth token are never shown and never
   * round-tripped: the list speaks names and `hasToken` only, and a blank
   * field keeps the saved one.
   *
   * THE FACE FOLLOWS THE WIRE. The row-status face is a live-served fact
   * (measured by the registry per request), so every read this surface owes —
   * a room reveal, the completion of any write verb: re-reads the list, and
   * when the read lands on the registry's unmeasured snapshot (every enabled
   * row "stopped": the runtime never started, or a write's hot rebuild took
   * the published registry down), the list follows at the settle cadence
   * until a row is measured, bounded by a wall clock. While that follow is
   * live, a "stopped" row renders the connecting word: the client itself
   * kicked the rebuild that will measure it: never "not connected", which
   * is a settled-negative claim the wire does not make mid-rebuild.
   */
  import {
    listMcpServers,
    saveMcpServer,
    deleteMcpServer,
    testMcpServer,
    type McpServerView,
  } from "../../client.ts";
  import { SvelteMap } from "svelte/reactivity";
  import { assertLiveForWrite } from "../../data/asof.ts";
  import { refusalReason, UNREADABLE_SHAPE } from "../../data/absence.ts";
  import Answer from "../response/Answer.svelte";
  import { VERB_MARK, VERB_MARK_WORD } from "../shell/verb-marks.ts";
  import { failed, pending } from "../response/grammar.ts";
  import { onMount, tick } from "svelte";
  import { whileRoomVisible } from "../shell/room-visibility.ts";
  import { MCP_TRANSPORT_IDS, type McpConfinementState, type McpTransportId } from "../../../shared/wire-types.ts";
  import { MCP_SETTLE_FOLLOW_MAX_MS, MCP_SETTLE_FOLLOW_POLL_MS } from "./settings-config.ts";

  /**
   * WHAT THE ONE TEST CONNECTION MET, in words: the class half of the
   * probe's answer, so the sentence names what happened instead of
   * presuming: a command that never spawned never "refused" anything, and a
   * server that answered and then failed the handshake is not "down".
   */
  const TEST_FAILURE_WORDS = {
    "no-answer": "the server did not answer",
    unexpected: "the attempt did not complete",
  } satisfies Record<"no-answer" | "unexpected", string>;

  /** The live registry state, in the room's own voice: a total map over
   * the wire's own status vocabulary, so a status the wire adds is a
   * compile error to leave wordless rather than a silent fallback. */
  /** How a local server runs, in the reader's words (the wire's confinement signal). */
  const CONFINEMENT_WORDS = {
    confined: "runs confined: it can write only its own folder",
    unconfined: "runs UNCONFINED: it can read and write anywhere this server can",
    refused: "not started: confinement refused it",
  } satisfies Record<Exclude<McpConfinementState, "remote">, string>;

  /** What to do about a failure, keyed by its typed code (the wire's `lastErrorCode`). */
  const ERROR_GUIDANCE: Readonly<Record<string, string>> = {
    mcp_credential_missing: "Set the named environment variable where the harness runs, then test again.",
    mcp_spawn_refused: "The sandbox did not start it; the reason follows.",
    mcp_config_invalid: "Edit or remove this entry; the other servers are unaffected.",
    outbound_cleartext_refused: "Use the server's https:// address.",
    outbound_redirect_refused: "Configure the address the server redirects to.",
    mcp_transport_closed: "The server stopped; its last words follow.",
  };

  const STATUS_WORDS = {
    stopped: "not connected",
    connecting: "connecting…",
    connected: "connected",
    reconnecting: "reconnecting…",
    error: "connection failed",
  } satisfies Record<McpServerView["status"], string>;

  let load = $state<"pending" | "failed" | "ok">("pending");
  let loadReason = $state<string | null>(null);
  let servers = $state<readonly McpServerView[]>([]);
  let formOpen = $state(false);
  /** Null = adding; a server id = editing that row. */
  let editingId = $state<string | null>(null);
  let formGeneration = $state(0);
  let draftRevision = $state(0);
  let pendingSave = $state<{ token: symbol; generation: number; revision: number; id: string } | null>(null);
  const busy = $derived(pendingSave?.generation === formGeneration);
  // Request ownership is per entity; independent rows remain usable.
  const probeRuns = new SvelteMap<string, { current: boolean }>();
  function invalidateProbe(id: string): void {
    const run = probeRuns.get(id);
    if (run) run.current = false;
    notes.delete(id);
  }
  function changedDraft(): void {
    draftRevision += 1;
    formNote = null;
  }
  /** server id → its last write's or probe's sentence. */
  const notes = new SvelteMap<string, string>();
  /** The armed two-press delete, if any. */
  let armedDelete = $state<string | null>(null);

  // ── the one form (add and edit are the same write: upsert by id) ────────
  let fId = $state("");
  let fTransport = $state<McpTransportId>("stdio");
  let fEnabled = $state(true);
  let fCommand = $state("");
  /** One argument per line: arguments can contain spaces, so a single
   * comma-split would be a lie about real argument lists. */
  let fArgs = $state("");
  /** One absolute path per line: what the confined local server may read
   * and run (its installation). */
  let fReadPaths = $state("");
  let fUrl = $state("");
  let fSubprotocol = $state("");
  type PairRow = { name: string; value: string };
  let fEnvRows = $state<PairRow[]>([]);
  let fHeaderRows = $state<PairRow[]>([]);
  let fAuthType = $state<"none" | "api-key" | "bearer" | "oauth">("none");
  let fAuthToken = $state("");
  let fAuthHeader = $state("");
  let fAuthEnvName = $state("");
  let fRetryCount = $state("");
  let fRetryBackoffMs = $state("");
  let fTimeoutMs = $state("");
  let formNote = $state<{ kind: "saved" | "failed"; text: string } | null>(null);

  async function refresh(): Promise<void> {
    load = "pending";
    try {
      servers = await listMcpServers();
      load = "ok";
    } catch (err) {
      loadReason = refusalReason(err) ?? (err instanceof Error ? err.message : String(err));
      load = "failed";
    }
  }

  /** Whether a registry settle this surface is following is still in flight.
   * While true, a row the wire reports as "stopped" (no published
   * measurement) renders the connecting word. */
  let followLive = $state(false);
  /** The follow chain's fencing token: every revalidation and every
   * visibility release bumps it, so a superseded or disarmed chain's next
   * tick exits without reading: the reconcile cancel shape. */
  let followEpoch = 0;

  /**
   * The list's ONE revalidation door. Every read this surface owes: a room
   * reveal, the completion of any write verb: goes through here: it reads
   * the wire, then, when the read observed the registry's unmeasured
   * snapshot, follows at the settle cadence until a row is measured, so the
   * face always ends at the wire's own answer without a reload.
   */
  async function revalidate(): Promise<void> {
    followEpoch += 1;
    const mine = followEpoch;
    // The read below re-decides the flight: a superseded chain's live flag
    // dies here, never by the superseded chain itself.
    followLive = false;
    await refresh();
    if (mine !== followEpoch) return;
    armFollowIfUnmeasured(mine, Date.now());
  }

  /** Arm the follow when the read landed on the registry's unmeasured
   * snapshot: at least one enabled row exists and every enabled row reads
   * "stopped". An all-disabled list has nothing to measure and never arms;
   * any measured row (connected, error, reconnecting) means the registry has
   * published and the snapshot is settled, not in flight. */
  function armFollowIfUnmeasured(mine: number, startedAt: number): void {
    const enabled = servers.filter((s) => s.enabled);
    if (enabled.length === 0 || enabled.some((s) => s.status !== "stopped")) return;
    followLive = true;
    setTimeout(() => {
      void followTick(mine, startedAt);
    }, MCP_SETTLE_FOLLOW_POLL_MS);
  }

  /** One follow pass; reschedules itself while the unmeasured snapshot
   * stands and the wall-clock bound has not passed. A failed read or a
   * superseding revalidation ends the chain: the next reveal or verb
   * re-arms it against the wire as it then stands. */
  async function followTick(mine: number, startedAt: number): Promise<void> {
    if (mine !== followEpoch) return;
    await refresh();
    if (mine !== followEpoch) return;
    const enabled = servers.filter((s) => s.enabled);
    const measured = enabled.length === 0 || enabled.some((s) => s.status !== "stopped");
    if (measured || load === "failed" || Date.now() - startedAt >= MCP_SETTLE_FOLLOW_MAX_MS) {
      followLive = false;
      return;
    }
    setTimeout(() => {
      void followTick(mine, startedAt);
    }, MCP_SETTLE_FOLLOW_POLL_MS);
  }

  /**
   * The row's status word. "stopped" is the wire's word for "the registry
   * has no published measurement for this row": while a settle this surface
   * kicked is in flight, that word is the connecting one: the client asked
   * for the connect: and once the follow ends, the wire's own word stands,
   * whatever it is.
   */
  function statusWord(s: McpServerView): string {
    if (!s.enabled) return "off";
    if (followLive && s.status === "stopped") return STATUS_WORDS.connecting;
    return STATUS_WORDS[s.status] ?? s.status;
  }

  // KEPT ALIVE (the room host): mounted once, then shown/hidden. So every
  // read hangs off visibility: the room's own law (quiet when hidden, warm
  // when shown, never blank in between): a reveal re-reads so a revisit never
  // serves a cached face for a live-served fact, a hide stops the follow, and
  // the rows themselves never blank.
  onMount(() =>
    whileRoomVisible("settings", () => {
      void revalidate();
      return () => {
        followEpoch += 1;
        followLive = false;
      };
    }),
  );

  let formOrigin: HTMLButtonElement | null = null;
  function openAdd(): void {
    formGeneration += 1;
    draftRevision = 0;
    formOrigin = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
    formOpen = true;
    editingId = null;
    formNote = null;
    fId = "";
    fTransport = "stdio";
    fEnabled = true;
    fCommand = "";
    fArgs = "";
    fReadPaths = "";
    fUrl = "";
    fSubprotocol = "";
    fEnvRows = [];
    fHeaderRows = [];
    fAuthType = "none";
    fAuthToken = "";
    fAuthHeader = "";
    fAuthEnvName = "";
    fRetryCount = "";
    fRetryBackoffMs = "";
    fTimeoutMs = "";
  }

  function openEdit(s: McpServerView): void {
    formGeneration += 1;
    draftRevision = 0;
    formOrigin = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
    formOpen = true;
    editingId = s.id;
    formNote = null;
    fId = s.id;
    fTransport = (MCP_TRANSPORT_IDS as readonly string[]).includes(s.transport)
      ? (s.transport as McpTransportId)
      : "stdio";
    fEnabled = s.enabled;
    fCommand = s.command ?? "";
    fArgs = s.args.join("\n");
    fReadPaths = s.readPaths.join("\n");
    fUrl = s.url ?? "";
    // Credential values are NEVER shown: each saved name opens as a row
    // with a BLANK value, and a blank value keeps the saved one (the wire
    // contract). Typing over replaces; removing the row removes the name.
    fEnvRows = s.envNames.map((name) => ({ name, value: "" }));
    fHeaderRows = s.headerNames.map((name) => ({ name, value: "" }));
    fAuthType = s.auth?.type ?? "none";
    fAuthToken = "";
    fAuthHeader = s.auth?.header ?? "";
    fAuthEnvName = s.auth?.envName ?? "";
    fRetryCount = s.retry === null ? "" : String(s.retry.count);
    fRetryBackoffMs = s.retry === null ? "" : String(s.retry.backoffMs);
    fTimeoutMs = s.timeoutMs === null ? "" : String(s.timeoutMs);
  }

  let sectionElement: HTMLElement | undefined;
  let formElement = $state<HTMLFormElement | undefined>(undefined);
  function closeForm(): void {
    formGeneration += 1;
    const focused = document.activeElement;
    const ownsFocus = focused instanceof HTMLElement && formElement?.contains(focused);
    const origin = formOrigin;
    formOpen = false;
    editingId = null;
    formNote = null;
    void tick().then(() => {
      if (!ownsFocus || focused.isConnected || document.activeElement !== document.body) return;
      (origin?.isConnected ? origin : sectionElement?.querySelector<HTMLButtonElement>('[data-verb-id="mcp.server/add"]'))?.focus();
    });
  }

  /**
   * Parse the pair rows (environment variables, request headers). A row with
   * no name is an abandoned one: not an error, dropped. A NEW name with a
   * blank value is refused HERE in the form's own words, because the server
   * would refuse it one step later and the sentence should arrive at the
   * field the user is looking at. A blank value for an already-saved name
   * means "keep the saved one" (the wire contract).
   */
  function parsePairRows(rows: readonly PairRow[], label: string): { map: Record<string, string> } | { error: string } {
    const map: Record<string, string> = {};
    const saved = savedNames(label);
    for (const row of rows) {
      const name = row.name.trim();
      if (name.length === 0) continue;
      const value = row.value;
      if (value.length === 0 && !saved.includes(name)) {
        return { error: `the ${label} "${name}" needs a value: a blank field only keeps an already-saved one` };
      }
      map[name] = value;
    }
    return { map };
  }

  /** The names the saved server already carries, so a blank value can mean
   * "keep" for exactly those. Derived from the loaded list, never guessed. */
  function savedNames(label: string): readonly string[] {
    const saved = servers.find((s) => s.id === editingId);
    if (saved === undefined) return [];
    return label === "environment variable" ? saved.envNames : saved.headerNames;
  }

  async function submit(ev: SubmitEvent): Promise<void> {
    ev.preventDefault();
    if (busy) return;
    const id = fId.trim();
    if (id.length === 0) {
      formNote = { kind: "failed", text: "a server needs a name" };
      return;
    }
    const envParsed = parsePairRows(fEnvRows, "environment variable");
    if ("error" in envParsed) {
      formNote = { kind: "failed", text: envParsed.error };
      return;
    }
    const headerParsed = parsePairRows(fHeaderRows, "request header");
    if ("error" in headerParsed) {
      formNote = { kind: "failed", text: headerParsed.error };
      return;
    }
    const lines = (text: string): string[] => text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const args = lines(fArgs);
    const body: Record<string, unknown> = {
      id,
      transport: fTransport,
      enabled: fEnabled,
    };
    if (fTransport === "stdio") {
      const command = fCommand.trim();
      if (command.length === 0) {
        formNote = { kind: "failed", text: "a local server needs the command that starts it" };
        return;
      }
      body["command"] = command;
      body["args"] = args;
      body["readPaths"] = lines(fReadPaths);
      if (Object.keys(envParsed.map).length > 0) body["env"] = envParsed.map;
    } else {
      const url = fUrl.trim();
      if (url.length === 0) {
        formNote = { kind: "failed", text: "a remote server needs its address" };
        return;
      }
      body["url"] = url;
      if (Object.keys(headerParsed.map).length > 0) body["headers"] = headerParsed.map;
      if (fTransport === "websocket") {
        const subprotocol = fSubprotocol.trim();
        if (subprotocol.length > 0) body["subprotocol"] = subprotocol;
      }
    }
    if (fAuthType !== "none") {
      const token = fAuthToken;
      body["auth"] = {
        type: fAuthType,
        token,
        ...(fAuthType === "api-key" && fAuthHeader.trim().length > 0 ? { header: fAuthHeader.trim() } : {}),
        ...(fAuthType !== "oauth" && fAuthEnvName.trim().length > 0 ? { envName: fAuthEnvName.trim() } : {}),
      };
    } else if (editingId !== null && servers.find((s) => s.id === editingId)?.auth != null) {
      // "No authentication" on a server that HAD credentials removes them —
      // an explicit null, never a silent keep.
      body["auth"] = null;
    }
    if (fRetryCount.trim().length > 0 || fRetryBackoffMs.trim().length > 0) {
      const count = Number(fRetryCount.trim());
      const backoffMs = Number(fRetryBackoffMs.trim());
      if (!Number.isInteger(count) || count < 1) {
        formNote = { kind: "failed", text: "the retry count is a whole number of at least 1" };
        return;
      }
      if (!Number.isFinite(backoffMs) || backoffMs < 0) {
        formNote = { kind: "failed", text: "the wait between retries is a number of milliseconds, zero or more" };
        return;
      }
      body["retry"] = { count, backoffMs };
    } else {
      body["retry"] = null;
    }
    if (fTimeoutMs.trim().length > 0) {
      const timeoutMs = Number(fTimeoutMs.trim());
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
        formNote = { kind: "failed", text: "the time limit per call is a whole number of milliseconds" };
        return;
      }
      body["timeoutMs"] = timeoutMs;
    } else {
      body["timeoutMs"] = null;
    }
    const operation = { token: Symbol(), generation: formGeneration, revision: draftRevision, id };
    pendingSave = operation;
    formNote = null;
    invalidateProbe(id);
    try {
      // A PAST VIEW IS READ-ONLY: the write has no Broker door on it, so the
      // rule is asserted here, at the one place this surface fires it.
      assertLiveForWrite();
      const saved = await saveMcpServer(body as Parameters<typeof saveMcpServer>[0]);
      // Only this form opening and request may settle its draft or focus.
      if (pendingSave?.token === operation.token && formOpen && formGeneration === operation.generation) {
        if (draftRevision === operation.revision) closeForm();
        else {
          if (editingId === null && fId.trim() === id) editingId = id;
          formNote = { kind: "saved", text: `Saved ${id}. Newer changes are unsaved.` };
        }
      }
      notes.set(saved.id, "saved: the values shown are the server's own read-back");
      await revalidate();
    } catch (err) {
      if (pendingSave?.token === operation.token && formOpen && formGeneration === operation.generation) {
        formNote = { kind: "failed", text: refusalReason(err) ?? (err instanceof Error ? err.message : String(err)) };
      }
    } finally {
      if (pendingSave?.token === operation.token) pendingSave = null;
    }
  }

  async function probe(s: McpServerView): Promise<void> {
    if (probeRuns.has(s.id)) return;
    const operation = { current: true };
    probeRuns.set(s.id, operation);
    notes.set(s.id, "asking the server itself…");
    try {
      const result = await testMcpServer(s.id);
      if (probeRuns.get(s.id) !== operation || !operation.current) return;
      if (result.ok) {
        const names = result.toolNames ?? [];
        notes.set(s.id, `answers: ${names.length} ${names.length === 1 ? "tool" : "tools"} listed in ${result.elapsedMs}ms` +
            (names.length > 0 ? `: ${names.slice(0, 5).join(", ")}${names.length > 5 ? ", …" : ""}` : ""));
      } else {
        const words = result.failureKind !== undefined && result.failureKind in TEST_FAILURE_WORDS
          ? TEST_FAILURE_WORDS[result.failureKind as keyof typeof TEST_FAILURE_WORDS]
          : "the attempt did not complete";
        notes.set(s.id, result.detail !== undefined && result.detail.length > 0 ? `${words}: ${result.detail}` : words);
      }
    } catch (err) {
      if (probeRuns.get(s.id) !== operation || !operation.current) return;
      // The probe never reached the server: the refusal is the verb's own
      // answer and nothing on the wire changed; the face keeps its state.
      notes.set(s.id, refusalReason(err) ?? (err instanceof Error ? err.message : String(err)));
      return;
    } finally {
      if (probeRuns.get(s.id) === operation) probeRuns.delete(s.id);
    }
    // The probe answered: the list re-reads so the row's face agrees with the
    // wire beside the verdict the probe just printed.
    await revalidate();
  }

  async function remove(s: McpServerView): Promise<void> {
    if (armedDelete !== s.id) {
      // Two presses: the first arms and SAYS what the second will do.
      armedDelete = s.id;
      return;
    }
    armedDelete = null;
    invalidateProbe(s.id);
    try {
      assertLiveForWrite();
      await deleteMcpServer(s.id);
      if (editingId === s.id) closeForm();
      await revalidate();
    } catch (err) {
      notes.set(s.id, refusalReason(err) ?? (err instanceof Error ? err.message : String(err)));
    }
  }
</script>

<div bind:this={sectionElement} class="mcp-servers" data-field="mcp-servers">
  {#if load === "pending" && servers.length === 0}
    <Answer answer={pending("reading the configured tool servers")} />
  {:else if load === "failed" && servers.length === 0}
    <Answer answer={failed(`the tool server list: ${loadReason ?? UNREADABLE_SHAPE}`)} />
  {:else}
    <ul class="server-list" data-field="mcp-server-list">
      {#each servers as s (s.id)}
        <li class="server-row setting-row" data-mcp-server={s.id}>
          <span class="s-name">{s.id}</span>
          <span class="s-transport engraved" data-field="mcp-server-transport">{s.transport}</span>
          <span class="s-target" title={s.command ?? s.url ?? ""}>
            {#if s.transport === "stdio"}
              {s.command}{s.args.length > 0 ? ` ${s.args.join(" ")}` : ""}
            {:else}
              {s.url}
            {/if}
          </span>
          <span
            class="s-status engraved"
            data-field="mcp-server-status"
            data-status={s.status}
            data-enabled={s.enabled}
          >
            {statusWord(s)}
          </span>
          <span class="s-creds engraved" data-field="mcp-server-credentials">
            {#if s.envNames.length > 0}
              {s.envNames.length} {s.envNames.length === 1 ? "environment variable" : "environment variables"}
             : values never shown
            {/if}
            {#if s.headerNames.length > 0}
              · {s.headerNames.length} {s.headerNames.length === 1 ? "header" : "headers"}: values never shown
            {/if}
            {#if s.auth !== null}
              · {s.auth.type} saved: token never shown
            {/if}
            {#if s.envNames.length === 0 && s.headerNames.length === 0 && s.auth === null}
              no credentials saved
            {/if}
          </span>
          <span class="s-verbs">
            <button
              class="verb edit"
              data-verb-id="mcp.server/edit"
              aria-label="Edit"
              title="Change this server's registration, transport or credentials; a blank credential field keeps the saved one."
              onclick={() => openEdit(s)}
            >{VERB_MARK.edit}</button>
            <button
              class="verb "
              data-verb-id="mcp.server/test"
              aria-disabled={probeRuns.has(s.id)} aria-busy={probeRuns.has(s.id)}
              title="Connects once and lists the tools this server offers, so a wrong address or command is found before a run depends on it."
              onclick={() => void probe(s)}
            >Test</button>
            <button
              class="verb danger"
              data-verb-id="mcp.server/delete"
              title="Removes this server's registration from the config; the config file keeps everything else."
              onclick={() => void remove(s)}
            >{armedDelete === s.id ? "Remove: press again to confirm" : "Remove"}</button>
          </span>
          {#if s.confinement !== null && s.confinement !== "remote"}
            <span class="s-note" data-field="mcp-server-confinement" data-confinement={s.confinement}>
              {CONFINEMENT_WORDS[s.confinement]}{s.confinementReason !== null ? `: ${s.confinementReason}` : ""}
            </span>
          {/if}
          {#if s.status === "error" && s.lastError !== null}
            <span class="s-note" data-field="mcp-server-last-error" data-code={s.lastErrorCode ?? ""}>
              {#if s.lastErrorCode !== null}<span class="engraved" data-field="mcp-server-last-error-code">{s.lastErrorCode}</span> {ERROR_GUIDANCE[s.lastErrorCode] ?? ""} {/if}{s.lastError}
            </span>
          {/if}
          {#if notes.get(s.id) !== undefined}
            <span class="s-note" data-field="mcp-server-note">{notes.get(s.id)}</span>
          {/if}
        </li>
      {/each}
    </ul>
    {#if servers.length === 0}
      <p class="none-yet engraved" data-field="mcp-server-empty">
        no tool servers configured yet: the call settings below adjust servers you add here
      </p>
    {/if}

    {#if !formOpen}
      <button class="verb add" data-verb-id="mcp.server/add" onclick={openAdd}>
        {VERB_MARK.add} Add tool server
      </button>
    {:else}
      <form bind:this={formElement}
        class="server-form connection-form"
        aria-label={editingId === null ? "add a tool server" : `edit tool server ${editingId}`}
        onsubmit={submit} oninput={changedDraft}
      >
        <label class="f-field">
          <span class="f-label engraved">Name</span>
          <input
            type="text"
            name="server-name"
            bind:value={fId}
            readonly={editingId !== null}
            placeholder="How the tool list names it, e.g. github"
          />
        </label>
        <label class="f-field">
          <span class="f-label engraved">Transport</span>
          <select name="server-transport" bind:value={fTransport}>
            {#each MCP_TRANSPORT_IDS as t (t)}
              <option value={t}>{t === "stdio" ? "stdio: a local command" : t === "http" ? "http: a remote address (Streamable HTTP)" : "websocket: a remote socket address"}</option>
            {/each}
          </select>
        </label>
        <div class="f-field form-wide">
          <span class="f-label">Server availability</span>
          <button class="verb state-control" type="button" name="server-enabled"
            role="switch" aria-checked={fEnabled} aria-label="Enable this tool server"
            data-verb-id="mcp.server/draft-enabled" onclick={() => { fEnabled = !fEnabled; changedDraft(); }}
          ><span class="state-path" aria-hidden="true"></span></button>
          <span class="f-label">Applies when saved. A disabled server stays disconnected and offers no tools.</span>
        </div>
        {#if fTransport === "stdio"}
          <label class="f-field">
            <span class="f-label engraved">Command that starts the server</span>
            <input type="text" name="server-command" bind:value={fCommand} placeholder="kagimcp" />
          </label>
          <label class="f-field">
            <span class="f-label engraved">Arguments: one per line, optional. A hidden credential shows as ‹keep:…›: leave the list as it is to keep the saved values; any change to the command or an argument needs every credential typed again</span>
            <textarea name="server-args" rows={2} bind:value={fArgs} spellcheck="false" placeholder={"--port\n8080"}></textarea>
          </label>
          <label class="f-field form-wide">
            <span class="f-label engraved">Folders the server may read and run: one per line. The server runs sandboxed in a folder of its own and can change nothing else, so install it first; it cannot download itself when it starts</span>
            <textarea name="server-read-paths" rows={2} bind:value={fReadPaths} spellcheck="false" placeholder={"/home/me/.local/share/uv/tools/kagimcp"}></textarea>
          </label>
        {:else}
          <label class="f-field">
            <span class="f-label engraved">
              Address: the {fTransport === "websocket" ? "websocket" : "web"} scheme the server speaks. A hidden credential shows as ‹keep:…›; any change to the address (host, port, path or query) needs every credential typed again
            </span>
            <input type="text" name="server-url" bind:value={fUrl} placeholder={fTransport === "websocket" ? "wss://example.com/mcp" : "https://example.com/mcp"} />
          </label>
          {#if fTransport === "websocket"}
            <label class="f-field">
              <span class="f-label engraved">Subprotocol, optional: the websocket protocol the server speaks</span>
              <input type="text" name="server-subprotocol" bind:value={fSubprotocol} placeholder="mcp" />
            </label>
          {/if}
        {/if}
        <div class="f-field form-wide">
          <span class="f-label engraved">
            Environment variables{fTransport === "stdio" ? "" : " (http-family servers usually need none)"}: values are never shown; a blank value keeps the saved one for the same {fTransport === "stdio" ? "command and arguments" : "address"}
          </span>
          <div class="pair-rows" data-field="server-env-rows">
            {#each fEnvRows as row, i (i)}
              <div class="pair-row" data-pair-row={i}>
                <input type="text" class="p-name" name="server-env-name" aria-label={`environment variable name ${i + 1}`} placeholder="NAME" bind:value={row.name} />
                <input type="password" class="p-value" name="server-env-value" aria-label={`environment variable value ${i + 1}, never shown`} title="sent once, never shown again; a blank field keeps the saved value" autocomplete="off" bind:value={row.value} />
                <button class="verb remove" type="button" data-verb-id="mcp.server/remove-env" aria-label={`remove environment variable ${i + 1}`} onclick={() => { fEnvRows = fEnvRows.filter((_, j) => j !== i); changedDraft(); }}>{VERB_MARK.remove}</button>
              </div>
            {/each}
            <button class="verb add " type="button" data-verb-id="mcp.server/add-env" onclick={() => { fEnvRows = [...fEnvRows, { name: "", value: "" }]; changedDraft(); }}>
              {VERB_MARK.add} Add variable
            </button>
          </div>
        </div>
        {#if fTransport !== "stdio"}
          <div class="f-field form-wide">
            <span class="f-label engraved">
              Request headers: one name per row; values are never shown, a blank value keeps the saved one
            </span>
            <div class="pair-rows" data-field="server-header-rows">
              {#each fHeaderRows as row, i (i)}
                <div class="pair-row" data-pair-row={i}>
                  <input type="text" class="p-name" name="server-header-name" aria-label={`header name ${i + 1}`} placeholder="X-Api-Key" bind:value={row.name} />
                  <input type="password" class="p-value" name="server-header-value" aria-label={`header value ${i + 1}, never shown`} title="sent once, never shown again; a blank field keeps the saved value" autocomplete="off" bind:value={row.value} />
                  <button class="verb remove" type="button" data-verb-id="mcp.server/remove-header" aria-label={`remove header ${i + 1}`} onclick={() => { fHeaderRows = fHeaderRows.filter((_, j) => j !== i); changedDraft(); }}>{VERB_MARK.remove}</button>
                </div>
              {/each}
              <button class="verb add " type="button" data-verb-id="mcp.server/add-header" onclick={() => { fHeaderRows = [...fHeaderRows, { name: "", value: "" }]; changedDraft(); }}>
                {VERB_MARK.add} Add header
              </button>
            </div>
          </div>
        {/if}
        <label class="f-field">
          <span class="f-label engraved">Authentication</span>
          <select name="server-auth-type" bind:value={fAuthType}>
            <option value="none">None</option>
            <option value="api-key">API key: a key sent in a header or set in the environment</option>
            <option value="bearer">Bearer: a token sent as the Authorization header</option>
            <option value="oauth">OAuth: a pre-obtained access token</option>
          </select>
        </label>
        {#if fAuthType !== "none"}
          <label class="f-field">
            <span class="f-label engraved">
              Token {editingId !== null ? "· Blank keeps the saved one" : "· Sent once, never shown again"}
            </span>
            <input type="password" name="server-auth-token" bind:value={fAuthToken} autocomplete="off" placeholder={'the credential itself, or ${ENV_VAR} to read it from the environment'} />
          </label>
        {/if}
        {#if fAuthType === "api-key"}
          <label class="f-field">
            <span class="f-label engraved">Header the key travels in, optional: the server's own default applies when blank</span>
            <input type="text" name="server-auth-header" bind:value={fAuthHeader} placeholder="X-Api-Key" />
          </label>
        {/if}
        {#if fAuthType === "api-key" || fAuthType === "bearer"}
          <label class="f-field">
            <span class="f-label engraved">
              Environment variable that carries the token, optional{fTransport === "stdio" ? ": required when the api-key must reach a local server through its environment" : ""}
            </span>
            <input type="text" name="server-auth-env" bind:value={fAuthEnvName} placeholder="API_KEY" />
          </label>
        {/if}
        <div class="f-field f-grid form-wide">
          <p class="f-label form-wide">Retry and timeout overrides are optional. Blank values use shared defaults.</p>
          <label class="f-field">
            <span class="f-label engraved">Retries per failed call</span>
            <input type="text" inputmode="numeric" name="server-retry-count" bind:value={fRetryCount} />
          </label>
          <label class="f-field">
            <span class="f-label engraved">Wait between retries (ms)</span>
            <input type="text" inputmode="numeric" name="server-retry-backoff" bind:value={fRetryBackoffMs} />
          </label>
          <label class="f-field">
            <span class="f-label engraved">Time limit per call (ms)</span>
            <input type="text" inputmode="numeric" name="server-timeout" bind:value={fTimeoutMs} />
          </label>
        </div>
        {#if formNote !== null}
          <p class="f-note form-wide" role="status" data-field="mcp-server-form-note" class:confirmed={formNote.kind === "saved"}>{formNote.text}</p>
        {/if}
        <div class="f-verbs form-wide">
          <button
            class="verb primary commit" aria-busy={busy}
            class:add={editingId === null}
            class:ok={editingId !== null}
            type="submit"
            aria-disabled={busy}
            data-verb-id="mcp.server/save"
          >
            <span class="commit-copy"><strong>{busy ? "Saving…" : "Save tool server"}</strong><span>{busy && pendingSave?.revision !== draftRevision ? "Saving the earlier edit; newer changes are unsaved" : "Apply to this install"}</span></span><span class="commit-mark" aria-hidden="true"></span>
          </button>
          <button
            class="verb cancel "
            type="button"
            onclick={closeForm}
            data-verb-id="mcp.server/cancel"
            aria-label={VERB_MARK_WORD.cancel}
            title={VERB_MARK_WORD.cancel}
          >
            {VERB_MARK_WORD.cancel}
          </button>
        </div>
      </form>
    {/if}
  {/if}
</div>

<style>
  /* The section rides INSIDE a room category, so it borrows the row and verb
   * vocabulary the room owns (.setting-row chrome comes from the room's own
   * stylesheet) and restyles only what Svelte's scoping cannot reach. */
  .mcp-servers {
    margin: 0 0 var(--sp-4);
  }
  .server-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }
  .server-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--sp-3);
    align-items: baseline;
  }
  .s-name {
    color: var(--ink-1);
    font-weight: var(--f-heading-weight);
    font-size: var(--f-ui-size);
  }
  .s-target { grid-column: 1 / -1; overflow-wrap: anywhere; white-space: normal; }
  .s-status { grid-column: 2; grid-row: 1; }
  .s-transport { grid-column: 1; grid-row: 2; }
  .s-verbs { grid-column: 1 / -1; }
  .s-transport,
  .s-status {
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--ink-3);
    white-space: nowrap;
  }
  .s-status[data-status="connected"],
  .s-status[data-status="connected"][data-enabled="true"] {
    color: var(--ink-1);
  }
  .s-status[data-enabled="false"] {
    color: var(--warn);
  }
  .s-target {
    color: var(--ink-3);
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
  }
  .s-creds {
    grid-column: 1 / -1;
    color: var(--ink-3);
    font-size: var(--f-data-size);
  }
  .s-verbs {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
  }
  .s-note {
    grid-column: 1 / -1;
    color: var(--ink-2);
    font-size: var(--f-ui-size);
  }
  .none-yet {
    margin: var(--sp-1) 0;
    color: var(--ink-3);
  }
  .verb.add {
    align-self: flex-start;
    margin-top: var(--sp-2);
  }
  .server-form { margin-top: var(--sp-5); }
  .f-field {
    display: flex;
    flex-direction: column;
    gap: var(--sp-0);
  }
  .f-field textarea {
    resize: vertical;
  }

  .f-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, var(--model-field-min)), 1fr));
    gap: var(--sp-2);
  }
  .f-label {
    color: var(--ink-3);
  }
  .pair-rows {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }
  .pair-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
    gap: var(--sp-1);
    align-items: baseline;
  }
  .f-note.confirmed { color: var(--ok); }
  .f-note {
    margin: 0;
    color: var(--alarm);
    font-size: var(--f-ui-size);
  }
  .f-verbs {
    display: flex;
    gap: var(--sp-2);
  }
</style>
