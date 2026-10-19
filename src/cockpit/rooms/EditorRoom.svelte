<script lang="ts">
  /**
   * THE EDITOR ROOM — the project's files, and what you can do to them.
   *
   * THE USER'S REQUEST, VERBATIM: "alongside the options at the top right, we
   * should have an editor so we can navigate the files/folders in the project,
   * view/edit/delete/render them too. folder structure on the left, editor on
   * the right".
   *
   * So: the folder structure on the left, the file on the right, full screen,
   * using the width it is given — the two panes are shares of the ROOM, and
   * the tree's share is fixed with respect to the file beside it, so opening
   * or rendering a file cannot move a single row of the tree.
   *
   * ── WHAT THIS ROOM IS BUILT AROUND ────────────────────────────────────────
   *
   * AN EDIT IN PROGRESS IS NEVER SILENTLY DISCARDED. Not by clicking another
   * file, not by opening a folder, not by closing the room, not by switching
   * project or workspace, not by signing out, and not by a reload. The buffer
   * (`editor/buffer.ts`) is the single owner of that promise and it keeps it
   * structurally: every path that could take the buffer away from a live draft
   * must say what happens to that draft, and every one of them here says
   * `"park"` — which keeps it. Only two controls in this room say `"discard"`,
   * and both of them are the user deciding to throw the work away.
   *
   * A SAVE WRITES TO THE FILE THAT WAS OPENED. The path is captured at open
   * and travels with the draft; nothing looks it up again. And the write is
   * VERIFIED against the path the server says it wrote, so a response about
   * another file can never retire the user's text (`editor/save.ts`).
   *
   * EVERY WRITE IS RECORDED. Not because this room remembers to record —
   * because it cannot write any other way. Saves, creates and deletes all go
   * to routes that reach disk through `server/editor-bridge.ts`, the single
   * in-process owner of file write/mkdir/delete, which records the effect AT
   * the mutation. So an edit made here appears in the ledger, on the sweep and
   * in the custody room exactly like an edit made by an agent.
   *
   * DELETING IS THE ONE IRREVERSIBLE ACT and it is guarded by a rule rather
   * than a dialog (`editor/destructive.ts`): armed for one path, unpressable
   * until the pointer has deliberately arrived on it, and refused until the
   * file's own name has been typed. No sequence of stray clicks types a word.
   */
  import { untrack } from "svelte";
  import { currentProject } from "../../state/projects.ts";
  import type { OutletProps } from "../shell/contract.ts";
  import { chordLabel } from "../shell/keyboard.ts";
  import { whileRoomVisible } from "../shell/room-visibility.ts";
  import FilePane from "../editor/FilePane.svelte";
  import FileTree from "../editor/FileTree.svelte";
  import Answer from "../response/Answer.svelte";
  import { absent } from "../response/grammar.ts";
  import {
    closeBufferFile,
    discardParkedDraft,
    fileBuffer,
    endBufferEdit,
    beginBufferEdit,
    bufferIsDirty,
    markBufferSaved,
    openBufferFile,
    parkedDrafts,
    parkedPaths,
    bufferPendingSave,
    setBufferDraft,
    type OpenFile,
  } from "../editor/buffer.ts";
  import type { DeleteArm } from "../editor/destructive.ts";
  import { EDITOR_SPLIT_MIN_PX } from "../editor/editor-config.ts";
  import {
    createFileAt,
    createFolderAt,
    loadDir,
    probePath,
    readMedia,
    readText,
    removePath,
    saveWriter,
    type MediaLoad,
    type ProbeLoad,
    type TextLoad,
  } from "../editor/feed.ts";
  import { baseNameOf, isLargeRead, renderModeFor, type PaneMode } from "../editor/file-kind.ts";
  // The tree/file split is the operator's to set: the hairline between the
  // panes drags it, the settings row spells it, and both go through the one
  // local write path (settings/local-prefs.ts owns the number, the bounds,
  // the persistence and the :root token override).
  import Splitter from "../shell/Splitter.svelte";
  import {
    applyEditorSplit,
    cockpitEditorSplit,
    EDITOR_SPLIT_DEFAULT,
    EDITOR_SPLIT_ID,
    EDITOR_SPLIT_MAX,
    EDITOR_SPLIT_MIN,
    setLocalPref,
  } from "../settings/local-prefs.ts";
  import { performSave } from "../editor/save.ts";
  import { ancestorsOf, buildRows, parentOf, type DirLoad, type TreeEntry } from "../editor/tree.ts";
  import { consumeEditorOpenRequest, pendingEditorOpen } from "../editor/open-request.ts";

  let { shell }: OutletProps = $props();

  const project = $derived($currentProject);
  const buffer = $derived($fileBuffer);
  const dirty = $derived(bufferIsDirty(buffer));

  // ── the tree ────────────────────────────────────────────────────────────
  // One load per directory, keyed by its path relative to the project root
  // ("" is the root itself). A record rather than a Map so Svelte's fine
  // -grained reactivity sees the replacement.
  let loads = $state<Record<string, DirLoad>>({});
  let opened = $state<Record<string, boolean>>({});
  let treeSeq = $state(0);

  const rootLoad = $derived<DirLoad>(loads[""] ?? { kind: "unread" });
  const rows = $derived(
    buildRows(
      new Map(Object.entries(loads)),
      new Set(Object.keys(opened).filter((k) => opened[k] === true)),
    ),
  );

  // ── what the pane is showing ────────────────────────────────────────────
  let selected = $state<TreeEntry | null>(null);
  let probeLoad = $state<ProbeLoad | null>(null);
  let textLoad = $state<TextLoad | null>(null);
  let mediaLoad = $state<MediaLoad | null>(null);
  let mode = $state<PaneMode>("source");
  let confirmedLargeRead = $state(false);
  let saving = $state(false);
  let notice = $state<Readonly<{ tone: "ok" | "warn" | "alarm"; text: string }> | null>(null);
  let arm = $state<DeleteArm | null>(null);

  /** The keyboard's row, and the pulse that moves real focus to it. */
  let focusRel = $state<string | null>(null);
  let focusSeq = $state(0);

  /** New-file / new-folder field. */
  let newName = $state("");
  let newKind = $state<"file" | "folder">("file");

  let roomW = $state(0);
  const split = $derived(roomW >= EDITOR_SPLIT_MIN_PX);
  /** Below the split width the two panes take TURNS rather than being clipped
   * — the same answer the room rail gives at the same breakpoint. */
  const treeVisible = $derived(split || selected === null);
  const paneVisible = $derived(split || selected !== null);

  /** Drafts waiting for this project, so a restored edit is discoverable
   * rather than merely present. Recomputed on every buffer change. */
  const drafts = $derived.by(() => {
    buffer;
    treeSeq;
    const id = project?.id ?? null;
    if (id === null) return [];
    return parkedDrafts().filter((d) => d.file.projectId === id);
  });
  const draftKeys = $derived.by(() => {
    buffer;
    treeSeq;
    return parkedPaths();
  });

  function draftKeyOf(absolutePath: string): string {
    return `${project?.id ?? ""}\u0000${absolutePath}`;
  }

  // ── acquisition, held by the room's visibility ──────────────────────────

  async function readDir(dir: string): Promise<void> {
    const p = project;
    if (p === null) return;
    loads = { ...loads, [dir]: { kind: "reading" } };
    const load = await loadDir(p.path, dir);
    // The project may have changed while this was in flight; a load that
    // arrives for a project nobody is looking at is dropped rather than
    // painted over the one that is.
    if (project?.id !== p.id) return;
    loads = { ...loads, [dir]: load };
  }

  // A project change RESETS the tree and PARKS whatever was unsaved. Parking
  // is the whole point: switching project is navigation, and navigation is
  // not a decision to destroy an edit.
  let lastProjectId = $state<string | null>(null);
  $effect(() => {
    const id = project?.id ?? null;
    if (id === lastProjectId) return;
    lastProjectId = id;
    closeBufferFile("park");
    loads = {};
    opened = {};
    selected = null;
    probeLoad = null;
    textLoad = null;
    mediaLoad = null;
    arm = null;
    notice = null;
    // The previous sequence is read UNTRACKED: `treeSeq += 1` would read
    // `treeSeq` as a dependency of the very effect that writes it — a
    // self-dependency (the shape Svelte's effect_update_depth_exceeded
    // guard exists for). The other increments below are event-driven, not
    // effect-driven, so they need no untracking.
    treeSeq = untrack(() => treeSeq) + 1;
  });

  $effect(() =>
    whileRoomVisible("editor", () => {
      if (project !== null && loads[""] === undefined) void readDir("");
      return () => undefined;
    }),
  );

  // ── A FILE ASKED FOR FROM OUTSIDE ───────────────────────────────────────
  //
  // The one-shot open seam (editor/open-request.ts): a path chip on a tool
  // beat, or a shell view request carrying a path, lands here — and opens
  // through the SAME `openFile` a tree click uses, so probe-first reading,
  // large-file gating and draft parking apply identically. Consumed only
  // while this room is on screen and a project is resolved: a request that
  // cannot be honored yet stays pending rather than being half-consumed.
  $effect(() =>
    whileRoomVisible("editor", () =>
      pendingEditorOpen.subscribe((path) => {
        if (path === null || project === null) return;
        consumeEditorOpenRequest();
        void openExternalPath(path);
      }),
    ),
  );

  /**
   * Resolve an externally-asked path (absolute or project-relative) against
   * THIS project and open it in the pane. A path outside the project is
   * refused in plain words — the server's own path gate would refuse the
   * read anyway, and saying so here beats a doomed round-trip.
   */
  async function openExternalPath(raw: string): Promise<void> {
    const p = project;
    if (p === null) return;
    const root = p.path.endsWith("/") ? p.path.slice(0, -1) : p.path;
    const absolute = raw.startsWith("/") ? raw : `${root}/${raw}`;
    if (!absolute.startsWith(`${root}/`)) {
      notice = {
        tone: "warn",
        text: `${raw} is outside this project, so it can't be opened here`,
      };
      return;
    }
    const rel = absolute.slice(root.length + 1);
    const dot = baseNameOf(rel).lastIndexOf(".");
    await openFile({
      name: baseNameOf(rel),
      path: absolute,
      relativePath: rel,
      type: "file",
      // The probe is the authority for every measured fact about the file;
      // these two are the tree's fields, unread on this path, and 0 / null
      // are their honest "not measured by the tree" values.
      size: 0,
      lineCount: null,
      extension: dot > 0 ? baseNameOf(rel).slice(dot + 1) : null,
    });
    // Walk the tree open to where the file lives, so the left pane agrees
    // with the right about where the reader is.
    for (const ancestor of ancestorsOf(rel)) {
      if (opened[ancestor] !== true) {
        opened = { ...opened, [ancestor]: true };
        if (loads[ancestor] === undefined) void readDir(ancestor);
      }
    }
  }

  // ── THE KEYBOARD, claimed only while this room is on screen ─────────────
  //
  // The shell registers the complete grammar on day one and PREVENTS THE
  // DEFAULT for every chord it matches — so ↑ ↓ ← → and Enter do not reach a
  // focused tree row unless this room claims them. Claiming them transiently
  // is the documented way (contract.ts): the claim sits on top of the flow's
  // permanent one while the room is visible and pops when it is not.
  $effect(() =>
    whileRoomVisible("editor", () => {
      const owner = "the editor's file tree";
      const releases = [
        shell.claimKey("focus-next", () => moveFocus(1), { transient: true, owner }),
        shell.claimKey("focus-prev", () => moveFocus(-1), { transient: true, owner }),
        shell.claimKey("expand", () => openFocused(), { transient: true, owner }),
        shell.claimKey("collapse", () => collapseFocused(), { transient: true, owner }),
        shell.claimKey("open-scope", () => activateFocused(), { transient: true, owner }),
      ];
      return () => {
        for (const release of releases) release();
      };
    }),
  );

  // The delete confirmation is a layer INSIDE this room, so Esc closes it
  // before it closes the room (shell/routing.ts dismissal ladder).
  // Delete lives in Popover (FilePane) — Esc is that surface's dismissal
  // layer, not a second one here (two owners for one key is the defect).

  function rowIndex(rel: string | null): number {
    if (rel === null) return -1;
    return rows.findIndex((r) => r.entry.relativePath === rel);
  }

  function moveFocus(step: number): void {
    if (rows.length === 0) return;
    const at = rowIndex(focusRel);
    const next = at === -1 ? (step > 0 ? 0 : rows.length - 1) : at + step;
    if (next < 0 || next >= rows.length) return;
    focusRel = rows[next]!.entry.relativePath;
    focusSeq += 1;
  }

  function focusedRow(): TreeEntry | null {
    const at = rowIndex(focusRel);
    return at === -1 ? null : rows[at]!.entry;
  }

  function openFocused(): void {
    const entry = focusedRow();
    if (entry === null || entry.type !== "directory") return;
    if (opened[entry.relativePath] !== true) toggleFolder(entry);
  }

  function collapseFocused(): void {
    const entry = focusedRow();
    if (entry === null) return;
    if (entry.type === "directory" && opened[entry.relativePath] === true) {
      toggleFolder(entry);
      return;
    }
    // Already closed (or a file): step OUT to the folder that holds it —
    // the move every tree makes, and the only one left to make here.
    const parent = parentOf(entry.relativePath);
    if (parent.length === 0) return;
    focusRel = parent;
    focusSeq += 1;
  }

  function activateFocused(): void {
    const entry = focusedRow();
    if (entry === null) return;
    if (entry.type === "directory") toggleFolder(entry);
    else void openFile(entry);
  }

  // ── the tree's two gestures ─────────────────────────────────────────────

  function toggleFolder(entry: TreeEntry): void {
    const rel = entry.relativePath;
    const nowOpen = opened[rel] !== true;
    opened = { ...opened, [rel]: nowOpen };
    focusRel = rel;
    if (nowOpen && loads[rel] === undefined) void readDir(rel);
  }

  /**
   * Open a file in the pane.
   *
   * The buffer is closed with `"park"` FIRST, so whatever was unsaved is kept
   * before anything else happens — including before any read that might fail.
   * There is no ordering here in which an edit can be lost.
   */
  async function openFile(entry: TreeEntry): Promise<void> {
    const p = project;
    if (p === null) return;
    closeBufferFile("park");
    selected = entry;
    focusRel = entry.relativePath;
    arm = null;
    notice = null;
    probeLoad = null;
    textLoad = null;
    mediaLoad = null;
    confirmedLargeRead = false;
    const probed = await probePath(entry.path, p.path);
    if (selected?.path !== entry.path) return;
    probeLoad = probed;
    if (probed.kind !== "measured") return;
    // A large file is NOT read on a click: the room states its size and what
    // opening it will do, and waits to be asked.
    if (isLargeRead(probed.probe)) return;
    await loadBody(entry);
  }

  /** Read the body of the selected file, once the room is allowed to. */
  async function loadBody(entry: TreeEntry): Promise<void> {
    const p = project;
    if (p === null || probeLoad?.kind !== "measured") return;
    const probe = probeLoad.probe;
    if (probe.kind !== "file") return;
    if (probe.mediaType !== null) {
      mode = "rendered";
      const load = await readMedia(entry.path, p.path);
      if (selected?.path !== entry.path) return;
      mediaLoad = load;
      return;
    }
    if (!probe.text) return; // binary: the pane states why, and reads nothing
    const load = await readText(entry.path, p.path);
    if (selected?.path !== entry.path) return;
    textLoad = load;
    if (load.kind !== "read") return;
    const file: OpenFile = {
      projectId: p.id,
      projectPath: p.path,
      apiPath: load.path,
      relativePath: load.relativePath,
      name: baseNameOf(load.path),
      language: load.language,
      size: load.size,
    };
    // The buffer decides whether a parked draft comes back — this call cannot
    // lose one either way, because the previous draft was parked at click.
    openBufferFile(file, load.content, "park");
    const rendered = renderModeFor(probe);
    mode = rendered === "none" ? "source" : "rendered";
    if (bufferIsDirty(fileBuffer.get())) mode = "edit";
  }

  function openAnyway(): void {
    const entry = selected;
    if (entry === null) return;
    confirmedLargeRead = true;
    void loadBody(entry);
  }

  function reread(): void {
    const entry = selected;
    if (entry === null) return;
    void openFile(entry);
  }

  // ── editing ─────────────────────────────────────────────────────────────

  function setMode(next: PaneMode): void {
    mode = next;
    // Entering `edit` starts a draft against the bytes the buffer was opened
    // with. It cannot lose anything — it only ADDS a draft where there was
    // none, and a draft that already exists is left exactly as it is.
    if (next === "edit") beginBufferEdit();
  }

  function onDraft(next: string): void {
    setBufferDraft(next);
  }

  /**
   * `discard changes` — one of the only two places in this room that destroy
   * unsaved work, and the place where the user's act IS that decision.
   *
   * The edit SESSION survives: the pane is still in edit mode, so after the
   * old draft is discarded a fresh one is begun against the saved bytes. A
   * draft-less buffer under a live textarea is the silent data-entry loss
   * (keystrokes changed the DOM and registered nothing), and leaving the
   * session live is also the honest next state — the user pressed "restore
   * last saved" mid-edit, and the textarea now shows exactly what is on disk.
   */
  function revert(): void {
    endBufferEdit("discard");
    beginBufferEdit();
    notice = { tone: "warn", text: "your unsaved changes to this file were thrown away" };
  }

  /**
   * READ THE FILE BACK AFTER IT CHANGED ON DISK.
   *
   * The pane's header and its two READING views are drawn from `textLoad` and
   * `probeLoad` — the read taken when the file was opened — while only the
   * `edit` view is drawn from the buffer. A save retires the draft, so `shown`
   * falls back to `textLoad.content`, and without this the room went back to
   * displaying the file AS IT WAS BEFORE THE EDIT: the header still quoting the
   * old size and line count, `as text` and the rendered view still showing the
   * old characters, and only `edit` showing the text that had just been
   * written. Seen in the browser: saving a page into an empty file left the
   * pane saying "this file is empty — 0 bytes on disk".
   *
   * The bytes are re-read rather than assumed, because the numbers the header
   * quotes are the SERVER'S measurements — a byte count computed here from a
   * JavaScript string length would be wrong for every file that is not ASCII,
   * and a wrong measured number is worse than an old one.
   *
   * A failed read-back does NOT replace a good read with an absence: the write
   * succeeded, and blanking the pane would report the write as a failure. It
   * says so instead.
   */
  async function readBackAfterWrite(entry: TreeEntry): Promise<boolean> {
    const p = project;
    if (p === null) return false;
    const probed = await probePath(entry.path, p.path);
    if (selected?.path !== entry.path) return true;
    if (probed.kind !== "measured" || probed.probe.kind !== "file") return false;
    probeLoad = probed;
    if (!probed.probe.text) return true;
    const load = await readText(entry.path, p.path);
    if (selected?.path !== entry.path) return true;
    if (load.kind !== "read") return false;
    textLoad = load;
    return true;
  }

  async function save(): Promise<void> {
    const request = bufferPendingSave(fileBuffer.get());
    if (request === null || saving) return;
    saving = true;
    notice = null;
    const outcome = await performSave(request, saveWriter);
    saving = false;
    if (outcome.kind === "written") {
      // ONLY here is the draft retired, and only after the write was verified
      // to have landed on the file that was opened.
      markBufferSaved(outcome.content);
      notice = { tone: "ok", text: `saved to ${request.apiPath} — recorded as a file effect` };
      const entry = selected;
      treeSeq += 1;
      if (entry !== null) {
        // The tree's own size column was measured before the write too.
        void readDir(parentOf(entry.relativePath));
        const reread = await readBackAfterWrite(entry);
        if (!reread) {
          notice = {
            tone: "warn",
            text:
              `saved to ${request.apiPath} — recorded as a file effect. Reading it back did not answer, ` +
              `so what is shown here is still the version this room read when it opened the file.`,
          };
        }
      }
      return;
    }
    if (outcome.kind === "unchanged") {
      notice = { tone: "ok", text: "nothing had changed, so nothing was written" };
      return;
    }
    notice = {
      tone: outcome.kind === "wrong-path" ? "alarm" : "warn",
      text: outcome.reason,
    };
  }

  // ── creating ────────────────────────────────────────────────────────────

  /** Where a new entry would go: the focused folder, else the folder holding
   * the focused row, else the project root. Stated on the control. */
  const newParent = $derived.by(() => {
    const entry = focusedRow();
    if (entry === null) return "";
    return entry.type === "directory" ? entry.relativePath : parentOf(entry.relativePath);
  });

  async function createEntry(): Promise<void> {
    const p = project;
    const name = newName.trim();
    if (p === null || name.length === 0) return;
    if (name.includes("/") || name.includes("\\")) {
      notice = { tone: "warn", text: "a name cannot contain a slash — open the folder you want it in first" };
      return;
    }
    const rel = newParent.length === 0 ? name : `${newParent}/${name}`;
    const outcome =
      newKind === "file" ? await createFileAt(rel, p.path) : await createFolderAt(rel, p.path);
    if (outcome.kind === "refused") {
      notice = { tone: "warn", text: outcome.reason };
      return;
    }
    newName = "";
    notice = {
      tone: "ok",
      text: `created ${rel} — the change is recorded like any other file effect`,
    };
    // THE NEW ENTRY MUST BE VISIBLE. The tree only walks into folders that are
    // OPEN, so creating into a closed folder used to report success and show
    // nothing — a true sentence about a change the reader could not see, which
    // reads exactly like a failure. Opening the folder it went into is what
    // makes the notice checkable against the tree beside it.
    if (newParent.length > 0 && opened[newParent] !== true) {
      opened = { ...opened, [newParent]: true };
    }
    await readDir(newParent);
    treeSeq += 1;
  }

  // ── deleting ────────────────────────────────────────────────────────────

  /**
   * Arm the delete, against a MEASUREMENT TAKEN NOW.
   *
   * The pane's probe is the read from when the file was OPENED, and everything
   * else can change a file on disk without this room watching (custody undo,
   * an agent, another tab). A confirm dialog quoting a stale byte count is a
   * dialog asking the user to agree to a fact that stopped being true —
   * observed live: "130 bytes" for a file that was 84 after a custody undo.
   * The probe is re-run at the arm, so the loss line the user reads — and the
   * header beside it — is measured at the moment of the decision. A probe
   * that cannot answer leaves the old measurement standing: refusing to arm
   * because the disk could not be re-read would block deleting a file whose
   * stale read is the only thing left of it.
   */
  async function armDelete(): Promise<void> {
    const entry = selected;
    const p = project;
    if (entry === null || p === null) return;
    const probed = await probePath(entry.path, p.path);
    if (selected?.path === entry.path && probed.kind === "measured") probeLoad = probed;
    arm = {
      path: entry.path,
      name: entry.name,
      isDirectory: entry.type === "directory",
      armedAt: Date.now(),
    };
  }

  function cancelDelete(): void {
    arm = null;
  }

  /**
   * The delete itself. `DeleteConfirm` has already re-judged the rule against
   * the clock at the instant of the press; this is reached only through it.
   *
   * The buffer is closed with `"discard"` — the second and last place in this
   * room that destroys unsaved work, and it is correct here: keeping a draft
   * for a file the user just deleted would offer to write it back.
   */
  async function confirmDelete(): Promise<void> {
    const p = project;
    const armed = arm;
    if (p === null || armed === null) return;
    const outcome = await removePath(armed.path, p.path);
    arm = null;
    if (outcome.kind === "refused") {
      notice = { tone: "alarm", text: outcome.reason };
      return;
    }
    const parent = selected === null ? "" : parentOf(selected.relativePath);
    closeBufferFile("discard");
    selected = null;
    probeLoad = null;
    textLoad = null;
    mediaLoad = null;
    notice = {
      tone: "warn",
      text: `moved ${armed.name} to the recycle bin — restore from there`,
    };
    await readDir(parent);
    treeSeq += 1;
  }

  // ── the drafts waiting ──────────────────────────────────────────────────

  async function reopenDraft(file: OpenFile): Promise<void> {
    const entry: TreeEntry = {
      name: file.name,
      path: file.apiPath,
      relativePath: file.relativePath,
      type: "file",
      size: file.size,
      extension: null,
      lineCount: null,
    };
    // Open the tree down to it, so the file is where the reader expects it.
    const next = { ...opened };
    for (const dir of ancestorsOf(file.relativePath)) {
      next[dir] = true;
      if (loads[dir] === undefined) void readDir(dir);
    }
    opened = next;
    await openFile(entry);
    if (bufferIsDirty(fileBuffer.get())) mode = "edit";
  }

  function dropDraft(file: OpenFile): void {
    discardParkedDraft(file);
    treeSeq += 1;
    notice = { tone: "warn", text: `the unsaved edit to ${file.name} was thrown away` };
  }

  // ── the tree/file splitter ──────────────────────────────────────────────
  //
  // The number is a SHARE of the room (the tree's width is already declared
  // as one, so nothing the file pane does can move it) — the splitter
  // converts pointer pixels to share points against the measured room width.
  // Previews apply the token override only; the ONE commit per gesture goes
  // through the local write path, which persists and re-applies.
  function onSplitAdjust(next: number, commit: boolean): void {
    if (!commit) {
      applyEditorSplit(next);
      return;
    }
    setLocalPref(EDITOR_SPLIT_ID, String(next));
  }

  function onSplitReset(): void {
    setLocalPref(EDITOR_SPLIT_ID, String(EDITOR_SPLIT_DEFAULT));
  }
</script>

<div class="editor" bind:clientWidth={roomW}>
  {#if project === null}
    <!-- Position only; the engraved cap face is deliberately dropped — the
         grammar owns what absence looks like. -->
    <div class="room-empty">
      <Answer answer={absent(`no project open — ${chordLabel({ key: "j", primary: true })} picks one`)} />
    </div>
  {:else}
    <header class="bar">
      <span class="engraved">files in “{project.name}”</span>
      <span class="root trunc" title={project.path}>{project.path}</span>
      <span class="grow"></span>
      {#if drafts.length > 0}
        <span class="drafts-count"
          >{drafts.length} unsaved edit{drafts.length === 1 ? "" : "s"} kept</span>
      {/if}
    </header>

    <!-- WHAT JUST HAPPENED, WHERE IT CAN ALWAYS BE READ.
         The pane renders this too, beside the verbs that set most of it — but
         the pane renders NOTHING AT ALL until a file is open, and `create` is
         the one verb whose whole normal use is with no file open. So creating
         a file, and every refusal `create` can return ("something already
         exists at that name"), reported to an empty rectangle. Observed in the
         browser: the file appeared in the tree and the room said nothing.
         This row is outside the pane, so no verb in this room can report into
         a surface that is not on screen. -->
    {#if notice !== null}
      <p
        class="room-notice"
        class:warn={notice.tone === "warn"}
        class:alarm={notice.tone === "alarm"}
        aria-live="polite">{notice.text}</p>
    {/if}

    {#if drafts.length > 0}
      <section class="drafts" aria-label="unsaved edits kept from before">
        {#each drafts as d (d.file.apiPath)}
          <div class="draft-row">
            <span class="draft-path trunc" title={d.file.apiPath}>{d.file.relativePath}</span>
            <button
              class="verb "
              data-verb-id="editor.reopen-draft"
              type="button"
              title="Opens this file with your unsaved edit in it, exactly as you left it."
              onclick={() => void reopenDraft(d.file)}>Open it</button>
            <button
              class="verb "
              data-verb-id="editor.drop-draft"
              type="button"
              title="Removes this unsaved draft. The last saved file on disk stays."
              onclick={() => dropDraft(d.file)}>Throw it away</button>
          </div>
        {/each}
      </section>
    {/if}

    <div class="split" class:stacked={!split}>
      {#if treeVisible}
        <div class="tree-pane">
          <div class="make">
            <label class="field">
              <span class="engraved"
                >New {newKind}{#if newParent.length > 0} in {newParent}{/if}</span>
              <input
                class="new-name"
                type="text"
                name="new-entry-name"
                autocomplete="off"
                spellcheck="false"
                placeholder="Name"
                aria-label={`name for the new ${newKind}`}
                bind:value={newName}
                onkeydown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void createEntry();
                  }
                }}
              />
            </label>
            <button
              class="verb "
              data-verb-id="editor.new-kind"
              type="button"
              title="Switches between making a file and making a folder."
              onclick={() => (newKind = newKind === "file" ? "folder" : "file")}
              >{newKind === "file" ? "→ folder" : "→ file"}</button>
            <button
              class="verb strong primary"
              data-verb-id="editor.create"
              type="button"
              disabled={newName.trim().length === 0}
              title={newName.trim().length === 0
                ? "Type a name first."
                : `Creates ${newName.trim()} on disk. The change is recorded like any other file effect.`}
              onclick={() => void createEntry()}>Create</button>
          </div>
          <FileTree
            {rows}
            {rootLoad}
            selectedPath={selected?.path ?? null}
            draftPaths={draftKeys}
            {focusRel}
            {focusSeq}
            {draftKeyOf}
            onopenfile={(entry) => void openFile(entry)}
            ontogglefolder={toggleFolder}
            onfocusrow={(rel) => (focusRel = rel)}
            onreadagain={(dir) => void readDir(dir)}
          />
        </div>
      {/if}

      {#if treeVisible && paneVisible}
        <!-- Only when BOTH panes are up: stacked mode has no split to drag,
             and a lone pane has no neighbour. Drag right to widen the tree,
             ← → step it when focused, double-click returns to the built-in
             share. -->
        <Splitter
          label="the folder tree's share of the room"
          orientation="vertical"
          value={$cockpitEditorSplit}
          min={EDITOR_SPLIT_MIN}
          max={EDITOR_SPLIT_MAX}
          step={2}
          unitPerPx={roomW > 0 ? 100 / roomW : 0}
          defaultWords={`the built-in ${EDITOR_SPLIT_DEFAULT}% share`}
          onadjust={onSplitAdjust}
          onreset={onSplitReset}
        />
      {/if}

      {#if paneVisible}
        {#if !split && selected !== null}
          <button
            class="verb back"
            data-verb-id="editor.back-to-tree"
            type="button"
            title="Returns to the folder structure. Your unsaved edit is kept."
            onclick={() => (selected = null)}>‹ the folders</button>
        {/if}
        <FilePane
          relativePath={selected?.relativePath ?? null}
          {probeLoad}
          {textLoad}
          {mediaLoad}
          {mode}
          draft={buffer.draft}
          {dirty}
          restored={buffer.restored}
          {saving}
          {arm}
          {confirmedLargeRead}
          onmode={setMode}
          onopenanyway={openAnyway}
          ondraft={onDraft}
          onsave={() => void save()}
          onrevert={revert}
          onarmdelete={() => void armDelete()}
          oncanceldelete={cancelDelete}
          onconfirmdelete={() => void confirmDelete()}
          onreread={reread}
        />
      {/if}
    </div>
  {/if}
</div>

<style>
  .editor {
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
    gap: var(--sp-3);
    padding: var(--sp-3) var(--sp-5);
    border-bottom: var(--hairline-w) solid var(--line-1);
    flex: none;
  }
  .root {
    font-family: var(--face-mono);
    font-size: var(--f-nano-size);
    color: var(--ink-4);
    min-width: 0;
  }
  .grow {
    flex: 1;
  }
  .drafts-count {
    font-family: var(--face-mono);
    font-size: var(--f-nano-size);
    color: var(--warn);
    white-space: nowrap;
  }
  /* WHAT JUST HAPPENED — one place, always on screen while the room is. */
  .room-notice {
    flex: none;
    margin: 0;
    padding: var(--sp-2) var(--sp-5);
    border-bottom: var(--hairline-w) solid var(--line-1);
    font-family: var(--face-mono);
    font-size: var(--f-nano-size);
    color: var(--ink-2);
  }
  .room-notice.warn {
    color: var(--warn);
  }
  .room-notice.alarm {
    color: var(--alarm);
  }
  /* WORK THAT SURVIVED, made visible. A draft that is merely kept is a draft
   * nobody knows about; this row is how it is discoverable. */
  .drafts {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: var(--sp-0);
    padding: var(--sp-2) var(--sp-5);
    border-bottom: var(--hairline-w) solid var(--line-1);
    background: var(--ground-1);
  }
  .draft-row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-width: 0;
  }
  .draft-path {
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--ink-2);
    min-width: 0;
  }
  .split {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: stretch;
  }
  /* BELOW THE SPLIT WIDTH the two panes take turns, and the only thing beside
   * the file is the control that goes back to the folders. A ROW put that one
   * 105px button in a full-height column of its own: measured at a 900px room,
   * 117px — 13% of the width — was permanently spent on an empty strip beside
   * the text, which is precisely the width the narrow layout exists to
   * reclaim. Stacked, the control is one row and the file has all of it. */
  .split.stacked {
    flex-direction: column;
  }
  /* The tree's width is a share of the ROOM, not of what is left over, so
   * nothing the file pane does can move it. */
  .tree-pane {
    flex: 0 0 var(--editor-tree-w);
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    padding: var(--sp-2) var(--sp-3) var(--sp-6);
    border-right: var(--hairline-w) solid var(--line-2);
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  /* With no pane beside it the tree has the whole room — a column sized for a
   * neighbour it does not have would leave a strip of nothing. */
  .split > .tree-pane:only-child {
    flex: 1 1 auto;
    border-right: none;
  }
  /* The splitter straddles the tree's own hairline: its grab area is wider
   * than the line, so half of it overlaps each pane and the layout keeps the
   * two panes' declared widths. */
  .split > :global(.splitter) {
    margin-left: calc(var(--sp-2) / -2);
    margin-right: calc(var(--sp-2) / -2);
  }
  .make {
    display: flex;
    align-items: flex-end;
    gap: var(--sp-1);
    flex-wrap: wrap;
  }
  /* The labelled-field recipe is owned by tokens.css (.cockpit .field);
   * the editor's new-entry field grows into the make row. */
  .field {
    flex: 1;
  }
  .new-name {
    min-width: var(--hit-min);
    min-height: var(--hit-min);
    padding: 0 var(--sp-2);
    background: var(--ground-1);
    border: var(--hairline-w) solid var(--line-2);
    border-radius: var(--radius-1);
    color: var(--ink-1);
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
  }
  /* The verb recipe is owned by tokens.css (.cockpit .verb); this room's
   * verbs keep the smaller engraved register (.engraved-ctl, a marker
   * class). */
  .back {
    align-self: flex-start;
    margin: var(--sp-2) 0 0 var(--sp-3);
  }
  .room-empty {
    margin: var(--sp-6) auto;
  }
</style>
