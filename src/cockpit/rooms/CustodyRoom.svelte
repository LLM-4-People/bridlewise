<script lang="ts">
  /**
   * THE CUSTODY ROOM (DESIGN-COCKPIT-V2 §7.2, ⌘G) — status as verbs.
   *
   * One column of WORK PARCELS: the project's uncommitted changes grouped by
   * the producing conversation (the server's ledger join), the honest "not
   * from a recorded conversation" bucket last, and SAVED WORK below — each
   * save joined to its producing conversation or honestly unjoined. Git
   * nouns never lead; the verbs are keep / undo / see.
   *
   * Opens INSTANTLY from the feed (<200ms law) and fills absence-first; all
   * numbers come measured off the wire (git's own counts, the store's own
   * denominators). Actions go through the custody block's declared verbs via
   * the Broker — recorded server-side, cache-invalidated client-side.
   */
  import { currentProject } from "../../state/projects.ts";
  import { selectProject } from "../../state/projects.ts";
  import { NOT_A_REPOSITORY } from "../../state/git.ts";
  import { selectChat } from "../../state/chats.ts";
  import { loadChatHistory } from "../../client.ts";
  import { action } from "../../data/broker.ts";
  import { isPastView } from "../../data/asof.ts";
  import type { OutletProps } from "../shell/contract.ts";
  import { chordLabel } from "../shell/keyboard.ts";
  import { relativeTime } from "./switch-data.ts";
  import {
    custodyHistories,
    custodyHistoryProvKey,
    custodyStateProvKey,
    custodyStates,
    requestCustody,
    requestCustodyHistory,
    revalidateCustody,
  } from "./custody-feed.ts";
  import { countsLine, type SavedWorkWire } from "./custody-data.ts";
  import { CUSTODY_SPLIT_MIN_PX } from "./custody-config.ts";
  import Parcel from "./Parcel.svelte";
  import DiffSheet from "./DiffSheet.svelte";
  import Answer from "../response/Answer.svelte";
  import { absent, failed, pending, refused } from "../response/grammar.ts";

  /**
   * The wire's `reason` is optional beside `repository: false`; the words
   * for that branch come from the git state's single owner
   * (`NOT_A_REPOSITORY`) so every surface that names the fact uses one
   * sentence — see state/git.ts for why a missing reason needs words at
   * all (an empty absence line is a blank where an explanation belongs,
   * exactly what the grammar's evidence gate refuses to paint).
   */
  import type { ComponentProps } from "svelte";
  import { whileRoomVisible } from "../shell/room-visibility.ts";

  let { shell }: OutletProps = $props();

  /** The open instant — every relative time on screen measures against one
   * real clock read. */
  // Re-read each time the room becomes visible. Under keep-alive the first
  // open would otherwise anchor every relative time for the session, so
  // "2m ago" would drift further from the truth the longer the app runs.
  let openedAt = $state(Date.now());
  $effect(() => whileRoomVisible("custody", () => { openedAt = Date.now(); return () => undefined; }));

  const project = $derived($currentProject);

  // Held by the room's visibility: under keep-alive the room stays mounted
  // when hidden, so acquisition must stop while it is not on screen — and
  // clear nothing, so reopening paints the last-known parcels instantly.
  // Each SHOW also REVALIDATES what is measured (custody changes under this
  // client with no act to invalidate on — a git init in a terminal kept
  // this room saying "not under version control" forever): the last-known
  // parcels paint in frame one and the fresh read lands underneath.
  $effect(() =>
    whileRoomVisible("custody", () => {
      if (project !== null) {
        requestCustody(project.id);
        requestCustodyHistory(project.id);
        revalidateCustody(project.id);
      }
      return () => undefined;
    }),
  );

  // THE OPEN DIFFERENCE BELONGS TO ONE PROJECT'S FILES. The room is kept
  // alive across project switches, so without this the pane kept showing
  // the PREVIOUS project's difference beside the new project's parcels — a
  // stale sheet wearing the new room's frame.
  $effect(() => {
    void project?.id;
    look = null;
  });

  const stateLoad = $derived(project === null ? undefined : $custodyStates[project.id]);
  const historyLoad = $derived(project === null ? undefined : $custodyHistories[project.id]);

  // ── the real verbs (the block's declared actions, via the Broker) ───────

  async function keep(files: readonly string[], message: string): Promise<void> {
    // PAST VIEW (§6.2): the writing verbs do not run from a view of an
    // earlier instant. The controls in the parcel already say so
    // (`isPastView` disables them with the reason on the control); this is
    // the same rule on the path the click would take, so no future caller of
    // these functions can reach the Broker's refusal by accident.
    if (project === null || $isPastView) return;
    await action(
      "custody.state",
      "keep",
      { projectId: project.id, files, message },
      { invalidates: ["custody:changed"] },
    );
  }

  async function undo(files: readonly string[]): Promise<void> {
    if (project === null || $isPastView) return;
    await action(
      "custody.state",
      "undo",
      { projectId: project.id, files },
      { invalidates: ["custody:changed"] },
    );
  }

  // ── `see` — the difference, IN the room, beside the work ───────────────
  /**
   * WHY NOT `shell.openScope`.
   *
   * The SCOPE is an inspector that ARRIVES OVER something: raised ground,
   * a shadow, its own panel edge. Opening a difference that way put a grey
   * sheet on top of the file list the difference belongs to — so the one
   * thing you needed beside it was the one thing you could no longer read.
   *
   * A difference and its file list are two halves of ONE view, so this is
   * one continuous surface: the same ground, the same type, divided by a
   * single hairline. The parcels keep a width of their own
   * (`--custody-board-w`, a share of the ROOM), so opening or closing a
   * difference cannot move them by a pixel — the pane to their right is
   * always there, holding its resting sentence when nothing is selected.
   */
  type Look = Readonly<{
    /** Identity of what is showing — the pane remounts when it changes, so
     * one difference never paints over the tail of another. */
    key: string;
    title: string;
    /**
     * The sheet's OWN props, typed as the sheet declares them.
     *
     * This was `Record<string, unknown>`, and `<DiffSheet {...look.props} />`
     * spreads it — so the mount was unchecked: a required prop could go
     * missing here and nothing would say so until the sheet threw. That is
     * the same shape as the `frameKey` defect, one component over. Both
     * construction sites do pass `projectPath`; now the type is what says so.
     */
    props: ComponentProps<typeof DiffSheet>;
  }>;
  let look = $state<Look | null>(null);

  function seeFile(file: string, fileState: string): void {
    if (project === null) return;
    look = {
      key: `file:${file}`,
      title: `${file} — what changed`,
      // The measured state rides along: an empty patch means something
      // different for a changed file than for one that has never been
      // saved, and the sheet must not tell one story for both.
      props: { projectPath: project.path, file, fileState },
    };
  }

  function seeCommit(commit: SavedWorkWire): void {
    if (project === null) return;
    look = {
      key: `save:${commit.hash}`,
      title: `saved: ${commit.message}`,
      // `<hash>^!` = this save against what came before it — the real patch.
      props: { projectPath: project.path, ref: `${commit.hash}^!` },
    };
  }

  function closeLook(): void {
    look = null;
  }

  /**
   * THE DIFFERENCE IS INSIDE THE ROOM, and Esc must say so.
   *
   * Before the shell had a dismissal ladder its escape order was
   * `room → scope → claimed`, so pressing Esc with a difference open closed
   * the whole of Custody — the reader lost the file list, the scroll position
   * and the difference in one keystroke, having asked to close one thing.
   * Registering the open difference as a layer (shell/routing.ts) makes the
   * first press close the difference and the second close the room.
   *
   * The layer is stamped with the room it was pushed in, so it goes quiet
   * while Custody is hidden (rooms are kept alive: a difference left open in
   * a closed room is still open, it is simply not on screen) and speaks again
   * the moment Custody is back — with no re-registration here.
   */
  $effect(() => {
    if (look === null) return;
    return shell.pushDismiss({ label: "the difference", dismiss: closeLook });
  });

  /** The room's OWN width, measured — the split is decided by the box this
   * room actually got, not by the viewport, so it is right inside any host
   * (a narrow shell, a future split, a test harness). */
  let roomW = $state(0);
  const split = $derived(roomW >= CUSTODY_SPLIT_MIN_PX);
  /** Under the split width the two panes take turns: the list, or the
   * difference with the way back. Neither is ever rendered beside something
   * there is no room for. */
  const listVisible = $derived(split || look === null);
  const lookVisible = $derived(split || look !== null);

  function openConversation(chatId: string): void {
    if (project === null) return;
    selectProject(project.id);
    selectChat(chatId);
    shell.closeRoom();
    void loadChatHistory(chatId);
  }

  function whenOf(iso: string): string {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? relativeTime(ms, openedAt) : "";
  }
</script>

<div class="custody" bind:clientWidth={roomW}>
  {#if project === null}
    <!-- The wrapper keeps the room-centring; the engraved cap face is
         deliberately dropped — the grammar owns what absence looks like, and
         a surface may keep position only. -->
    <div class="room-empty">
      <Answer answer={absent(`no project open — ${chordLabel({ key: "j", primary: true })} picks one`)} />
    </div>
  {:else}
    <header class="bar">
      <span class="engraved">work in “{project.name}”</span>
      {#if stateLoad?.kind === "measured" && stateLoad.state.repository && stateLoad.state.branch !== null}
        <span class="line-of-work" data-prov={custodyStateProvKey(project.id)}
          >on {stateLoad.state.branch}</span>
      {/if}
      {#if stateLoad?.kind === "measured" && stateLoad.state.repository}
        <span class="join-note" data-prov={custodyStateProvKey(project.id)}>
          {stateLoad.state.join.attributedFiles} of {stateLoad.state.join.changedFiles} changed
          file{stateLoad.state.join.changedFiles === 1 ? "" : "s"} traced to a conversation
          {#if stateLoad.state.join.withheldRuns > 0}
            · {stateLoad.state.join.withheldRuns} held by other people's work (counted only)
          {/if}
        </span>
      {/if}
    </header>

    <div class="split">
      {#if listVisible}
      <div class="board">
      {#if stateLoad === undefined || stateLoad.kind === "pending"}
        <div class="board-note"><Answer answer={pending("reading the current work")} /></div>
      {:else if stateLoad.kind === "refused"}
        <!-- The server DECLINED, on purpose, with its own sentence — the
             grammar's REFUSED, never re-dressed as a broken read. -->
        <div class="board-note"><Answer answer={refused(stateLoad.reason)} /></div>
      {:else if stateLoad.kind === "absent"}
        <!-- Load-level "absent" wraps a caught error — a read that broke. -->
        <div class="board-note"><Answer answer={failed(`current work — ${stateLoad.reason}`)} /></div>
      {:else if !stateLoad.state.repository}
        <!-- The read SUCCEEDED and measured "not a repository" — an honest
             emptiness with the server's own reason. -->
        <div class="board-note"><Answer answer={absent(stateLoad.state.reason ?? NOT_A_REPOSITORY)} /></div>
      {:else if stateLoad.state.parcels.length === 0}
        <div class="board-note"><Answer answer={absent("nothing changed since the last save")} /></div>
      {:else}
        {#each stateLoad.state.parcels as parcel (parcel.id)}
          <Parcel
            {parcel}
            provKey={custodyStateProvKey(project.id)}
            onKeep={keep}
            onUndo={undo}
            onSee={seeFile}
            whenText={parcel.attribution.kind === "conversation"
              ? whenOf(parcel.attribution.lastTouchedAt)
              : ""}
          />
        {/each}
      {/if}

      <section class="saved" aria-label="saved work">
        <header class="cap">
          <span class="engraved">saved work</span>
          {#if historyLoad?.kind === "measured" && historyLoad.history.remoteConfigured}
            <button
              class="verb plain unwired"
              data-verb-id="custody.share"
              disabled
              title="sending saved work out is not wired yet — no declared action serves it"
              >Share this work — not wired yet</button>
          {/if}
        </header>
        {#if historyLoad === undefined || historyLoad.kind === "pending"}
          <div class="board-note"><Answer answer={pending("reading the saved history")} /></div>
        {:else if historyLoad.kind === "refused"}
          <div class="board-note"><Answer answer={refused(historyLoad.reason)} /></div>
        {:else if historyLoad.kind === "absent"}
          <div class="board-note"><Answer answer={failed(`saved work — ${historyLoad.reason}`)} /></div>
        {:else if !historyLoad.history.repository}
          <div class="board-note"><Answer answer={absent(historyLoad.history.reason ?? NOT_A_REPOSITORY)} /></div>
        {:else if historyLoad.history.commits.length === 0}
          <div class="board-note"><Answer answer={absent("nothing saved yet")} /></div>
        {:else}
          <ul class="commits" data-prov={custodyHistoryProvKey(project.id)}>
            {#each historyLoad.history.commits as commit (commit.hash)}
              <li class="commit">
                <span class="mark">{commit.shortHash}</span>
                <span class="message trunc">{commit.message}</span>
                <span class="counts">{countsLine(commit.insertions, commit.deletions)}</span>
                <span class="when">{whenOf(commit.when)}</span>
                {#if commit.conversation !== null}
                  {@const conv = commit.conversation}
                  <button
                    class="verb plain chat"
                    data-verb-id="custody.open-conversation"
                    title={commit.derivation}
                    onclick={() => openConversation(conv.chatId)}
                    >∴ “{conv.chatTitle}”</button>
                {:else}
                  <span class="nochat" title={commit.derivation}>no recorded conversation</span>
                {/if}
                <button class="verb " data-verb-id="custody.see" onclick={() => seeCommit(commit)}
                  title="Shows exactly what this save changed, against what came before it.">See</button>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
      </div>
      {/if}

      <!--
        THE DIFFERENCE, beside the work it belongs to.

        Whenever the room is SPLIT this pane is rendered, empty or not: a
        pane that appeared on the first `see` would move the parcels, and the
        parcels must not move. Its resting sentence is the honest state of
        the pane, not a placeholder for one. Below the split width there is
        no room for two, so the panes take turns instead — and an empty one
        never takes a turn.
      -->
      {#if lookVisible}
      <section class="look" aria-label="what changed" aria-live="polite">
        {#if look === null}
          <p class="resting">select a file's SEE to read what changed in it</p>
        {:else}
          <header class="look-cap">
            {#if !split}
              <button
                class="verb "
                data-verb-id="custody.see-back"
                onclick={closeLook}
                title="Returns to the list of changed files."
                >‹ the list</button>
            {/if}
            <span class="engraved look-title trunc" title={look.title}>{look.title}</span>
            <button
              class="verb "
              data-verb-id="custody.see-close"
              onclick={closeLook}
              title="Stops showing this difference; the list keeps its place."
              >Close</button>
          </header>
          {#key look.key}
            <DiffSheet {...look.props} />
          {/key}
        {/if}
      </section>
      {/if}
    </div>
  {/if}
</div>

<style>
  .custody {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
    align-self: stretch;
  }
  .bar {
    display: flex;
    align-items: baseline;
    gap: var(--sp-4);
    padding: var(--sp-3) var(--sp-5);
    border-bottom: var(--hairline-w) solid var(--line-1);
    flex: none;
  }
  .line-of-work {
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--ink-2);
  }
  .join-note {
    margin-left: auto;
    font-family: var(--face-mono);
    font-size: var(--f-nano-size);
    color: var(--ink-4);
  }
  /**
   * THE BOARD — row-packing, the same move the SWITCH river makes (§5.2).
   *
   * This was ONE column capped at `--measure` (76ch), the PROSE rail. A
   * parcel is not prose: it is a header, a keep line, and a table of file
   * rows. On a 1536px viewport the rail resolved to 553px and left 983px
   * empty; at 2560px it left 2007px. The board now flows its parcels
   * left → right and wraps down, in DOM order — which IS the reading order
   * (most-relevant conversations first, the unattributed bucket last), so
   * packing changes where a parcel sits, never which parcel comes first.
   *
   * SAVED WORK is the board's LAST item, so it lands beside the parcels
   * when the row has room and below them when it does not — no media
   * query decides this; the row's own arithmetic does, which means it is
   * correct at any width the column is given.
   *
   * The board's own WIDTH is fixed with respect to the difference beside it
   * — see .split below; the packing happens inside that width.
   */
  /**
   * THE SPLIT — one continuous surface, divided by one hairline.
   *
   * The parcels take `--custody-board-w`, a share of the ROOM. That is the
   * whole no-shift guarantee, and it is structural rather than careful:
   * the column's width is not computed from what is left over, so there is
   * nothing for a difference to take away from it. The pane on the right is
   * mounted whether or not anything is selected, so it cannot arrive and
   * push either. Nothing here is a raised sheet — same ground, same type,
   * one `--line-2` rule between them, exactly the separator language the
   * HORIZON and the desk already speak.
   */
  .split {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: stretch;
  }
  .look {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: auto;
    border-left: var(--hairline-w) solid var(--line-2);
    padding: var(--sp-4) var(--sp-5) var(--sp-7);
  }
  /* Under the split width the panes take TURNS, and whichever has its turn
   * has the whole room: no rule to draw between them, and no fixed column to
   * hold — a list sized for a neighbour it does not have would leave a strip
   * of nothing beside it. (The fixed basis exists to survive a difference
   * opening; with no difference beside it there is nothing to survive.) */
  .split > .look:only-child {
    border-left: none;
  }
  .split > .board:only-child {
    flex: 1 1 auto;
  }
  .look-cap {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding-bottom: var(--sp-2);
    margin-bottom: var(--sp-2);
    border-bottom: var(--hairline-w) solid var(--line-1);
  }
  .look-title {
    flex: 1;
    min-width: 0;
  }
  /* The pane's honest resting state — what it IS when nothing is selected,
   * in the same absence ink every other "there is nothing here" in this room
   * uses, and never italic (the retired slant). */
  .resting {
    margin: 0;
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--state-absent-ink);
  }
  .board {
    flex: 0 0 var(--custody-board-w);
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    max-width: var(--custody-max-w);
    padding: var(--sp-4) var(--sp-5) var(--sp-7);
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    align-content: flex-start;
    gap: var(--sp-3) var(--sp-5);
  }
  /* Every direct child claims a whole row unless it is a packable item —
   * an absence sentence must never sit in a half-width column beside the
   * work it is describing. Position only: the words inside are the
   * grammar's, which owns their ink, face and slant. */
  .board > .board-note {
    flex: 1 1 100%;
  }
  .room-empty {
    margin: var(--sp-6) auto;
  }
  /* SAVED WORK packs on the same basis as a parcel, so it takes a column
   * beside the work when the row has one and falls below it when it does
   * not. The rule above it is its own section cap either way. */
  .saved {
    flex: 1 1 var(--custody-parcel-w);
    min-width: 0;
    max-width: 100%;
    border-top: var(--hairline-w) solid var(--line-1);
    padding-top: var(--sp-3);
  }
  /* The cap row's recipe is owned by tokens.css (.cockpit .cap). */
  .commits {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-0);
  }
  .commit {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-width: 0;
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
  }
  .mark {
    color: var(--ink-4);
    flex: none;
  }
  .message {
    color: var(--ink-1);
    min-width: 0;
  }
  .counts {
    font-variant-numeric: tabular-nums;
    color: var(--ink-2);
    white-space: nowrap;
  }
  .when {
    color: var(--ink-4);
    font-size: var(--f-nano-size);
    white-space: nowrap;
  }
  /* The pointer-target floor (§12.5, --hit-min is its one owner) — these
   * verbs were 19px tall chips, under the floor for the very clicks this
   * room exists for. */
  /* The verb recipe is owned by tokens.css (.cockpit .verb); this
   * room's verbs keep the smaller engraved register (.engraved-ctl,
   * carried as a marker class) and its own ink/pad. */
  .verb.chat {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .nochat {
    font-size: var(--f-nano-size);
    /* "no recorded conversation" is an absence, so it wears the absence ink
     * and no slant, not the retired italic-faint treatment. */
    color: var(--state-absent-ink);
    white-space: nowrap;
  }
</style>
