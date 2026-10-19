<script lang="ts">
  /**
   * THE FILE — the right half of the room.
   *
   * Three views, and the room only ever offers the ones that are honestly
   * available for THIS file:
   *
   *   as it looks — markdown formatted, a picture shown, a patch read as a
   *     change, a page run inside a sealed frame. Offered only when the file
   *     has such a form; a `.ts` file has none and the control is not there
   *     to be pressed.
   *   as text — the exact characters, syntax-coloured, read-only.
   *   edit — the same characters in a field you can change. NOTHING is
   *     written until `save`, and the draft survives every way out of here.
   *
   * The renderers are the cockpit's OWN owners, mounted rather than
   * re-implemented: `Prose` for markdown, `UnifiedDiff` for a patch,
   * `CodeBlock` for source, `ArtifactFrame` for a page. That last one is the
   * single place in the cockpit where a string is handed to an HTML parser,
   * behind a sandbox with no same-origin and a policy that blocks the network
   * — writing a second one here would be a second security policy that can be
   * weakened alone.
   *
   * HONEST STATES, each with the number that produced it:
   *   - a file that cannot be read says why;
   *   - a file that is not text says so and states the reason the SERVER
   *     measured, instead of painting its bytes as mojibake;
   *   - a large file states its size and what opening it will do, BEFORE it
   *     is opened;
   *   - a file past the write cap can be read and honestly cannot be saved,
   *     so `edit` is not offered rather than offered and then refused.
   */
  import ArtifactFrame from "../render/ArtifactFrame.svelte";
  import CodeBlock from "../render/CodeBlock.svelte";
  import Prose from "../render/Prose.svelte";
  import UnifiedDiff from "../render/UnifiedDiff.svelte";
  import Answer from "../response/Answer.svelte";
  import { absent, failed, pending } from "../response/grammar.ts";
  import { parseUnifiedDiff } from "../render/diff.ts";
  import DeleteConfirm from "./DeleteConfirm.svelte";
  import Popover from "../shell/Popover.svelte";
  import TextEditor from "./TextEditor.svelte";
  import type { DeleteArm } from "./destructive.ts";
  import type { MediaLoad, ProbeLoad, TextLoad } from "./feed.ts";
  import {
    externalReferences,
    fileSizeText,
    isEditable,
    isLargeRead,
    largeReadSentence,
    binarySentence,
    notEditableSentence,
    renderModeFor,
    renderModeExplanation,
    renderModeLabel,
    sealedFrameSentence,
    type PaneMode,
  } from "./file-kind.ts";

  let {
    relativePath,
    probeLoad,
    textLoad,
    mediaLoad,
    mode,
    draft,
    dirty,
    restored,
    saving,
    arm,
    confirmedLargeRead,
    onmode,
    onopenanyway,
    ondraft,
    onsave,
    onrevert,
    onarmdelete,
    oncanceldelete,
    onconfirmdelete,
    onreread,
  }: {
    /** The file's path relative to the project — the pane's own title. */
    relativePath: string | null;
    probeLoad: ProbeLoad | null;
    textLoad: TextLoad | null;
    mediaLoad: MediaLoad | null;
    mode: PaneMode;
    /** The unsaved text, or null when the buffer holds no draft. */
    draft: string | null;
    dirty: boolean;
    /** The draft came back from a park, so its preimage may be stale. */
    restored: boolean;
    saving: boolean;
    arm: DeleteArm | null;
    /** The reader has asked for this large file by name. */
    confirmedLargeRead: boolean;
    onmode: (next: PaneMode) => void;
    onopenanyway: () => void;
    ondraft: (next: string) => void;
    onsave: () => void;
    onrevert: () => void;
    onarmdelete: () => void;
    oncanceldelete: () => void;
    onconfirmdelete: () => void;
    onreread: () => void;
  } = $props();

  const probe = $derived(probeLoad?.kind === "measured" ? probeLoad.probe : null);
  const renderMode = $derived(probe === null ? "none" : renderModeFor(probe));
  const canEdit = $derived(probe !== null && isEditable(probe));
  const needsConfirm = $derived(probe !== null && isLargeRead(probe) && !confirmedLargeRead);
  let revertOpen = $state(false);

  /** The text on screen: the draft while editing, the file otherwise. */
  const shown = $derived(draft ?? (textLoad?.kind === "read" ? textLoad.content : ""));

  const parsedDiff = $derived(
    renderMode === "diff" && textLoad?.kind === "read" ? parseUnifiedDiff(textLoad.content) : null,
  );

  /**
   * Whether the parse found A CHANGE, not merely a document.
   *
   * `parseUnifiedDiff` never answers null — handed ordinary prose it answers
   * one file with zero hunks, and `UnifiedDiff` draws that as `+0 −0` and an
   * empty scroller. So a `.diff` that is not a diff used to render as an empty
   * rectangle under a control that said it was showing a change. The question
   * the view actually turns on is whether there is a hunk to read.
   */
  const diffHasHunks = $derived(
    parsedDiff !== null && parsedDiff.files.some((f) => f.hunks.length > 0),
  );

  /**
   * THE FRAME'S IDENTITY, and why it is not optional.
   *
   * `ArtifactFrame` requires a `frameKey`: it is what a runtime error inside
   * the frame is attributed to, and the frame's error owner refuses to watch a
   * frame that has none. This pane mounted the frame WITHOUT one, so
   * `frameKey.length` threw on every mount, `artifactErrors.watch` was never
   * reached, and a page that died on its first statement rendered as a blank
   * rectangle that nothing on this side could explain. The path is the right
   * identity here: one preview per file, stable while that file is on screen.
   */
  const pageFrameKey = $derived(
    textLoad?.kind === "read" ? `editor:${textLoad.path}` : "",
  );

  /** What the sealed frame will refuse to fetch for this page, measured from
   * the page's own text. Empty for a self-contained document. */
  const pageBlocked = $derived(
    renderMode === "page" ? sealedFrameSentence(externalReferences(shown)) : "",
  );

  /** Why `edit` is not offered, or null when it is. */
  const noEditBecause = $derived(probe === null ? null : notEditableSentence(probe));

  /** A file with no bytes renders as nothing in every view. Said, not shown. */
  const isEmptyFile = $derived(
    textLoad?.kind === "read" && textLoad.content.length === 0 && draft === null,
  );
</script>

<section class="pane" aria-label="the file">
  {#if relativePath === null}
    <p class="resting">
      pick a file on the left to read it — nothing is opened until you ask for it
    </p>
  {:else}
    <header class="bar">
      <span class="path trunc" title={relativePath}>{relativePath}</span>
      {#if probe !== null && probe.kind === "file"}
        <span class="fact">{fileSizeText(probe.size)}</span>
      {/if}
      {#if textLoad?.kind === "read"}
        <span class="fact">{textLoad.lineCount.toLocaleString("en-US")} lines</span>
      {/if}
      {#if dirty}
        <span class="fact unsaved engraved-ctl">unsaved</span>
      {/if}
      <span class="grow"></span>

      <!-- THE VIEWS. Only the ones this file honestly has. -->
      {#if renderMode !== "none"}
        <button
          class="verb "
          data-verb-id="editor.view-rendered"
          type="button"
          aria-pressed={mode === "rendered"}
          class:on={mode === "rendered"}
          title={renderModeExplanation(renderMode)}
          onclick={() => onmode("rendered")}>{renderModeLabel(renderMode)}</button>
      {/if}
      <button
        class="verb "
        data-verb-id="editor.view-source"
        type="button"
        aria-pressed={mode === "source"}
        class:on={mode === "source"}
        title="Shows the exact characters in this file, coloured but not changed."
        onclick={() => onmode("source")}>As text</button>
      {#if canEdit}
        <button
          class="verb "
          data-verb-id="editor.view-edit"
          type="button"
          aria-pressed={mode === "edit"}
          class:on={mode === "edit"}
          title="Lets you change this file. Nothing is written to disk until you press save."
          onclick={() => onmode("edit")}>Edit</button>
      {/if}

      <button
        class="verb "
        data-verb-id="editor.reread"
        type="button"
        title="Reads this file from disk again. An unsaved edit is kept, not replaced."
        onclick={onreread}>Reload</button>
      <button
        class="verb "
        data-verb-id="editor.delete"
        type="button"
        title="Asks to delete this file. It will not delete anything until you type its name."
        onclick={onarmdelete}>Delete…</button>
    </header>

    <!-- A file this server will not accept in one write has no `edit`
         control. The reason is stated HERE rather than left as a missing
         button, because a capability that is silently absent reads as broken.
    -->
    {#if noEditBecause !== null}
      <p class="note warn">{noEditBecause}</p>
    {/if}

    {#if restored}
      <p class="note warn">
        this is an edit you had not saved, brought back from before. It was written against the file
        as it was THEN, so if the file has changed since, saving will be refused rather than
        overwrite it. Reload keeps your edit rather than replacing it — to read the current file,
        copy your text out and discard the changes first.
      </p>
    {/if}

    {#if arm !== null}
      <Popover title={`delete ${arm.name}`} kind="alertdialog" onclose={oncanceldelete}>
        <DeleteConfirm
          {arm}
          size={probe !== null && probe.kind === "file" ? probe.size : null}
          oncancel={oncanceldelete}
          onconfirm={onconfirmdelete}
        />
      </Popover>
    {/if}

    {#if revertOpen}
      <Popover title="restore last saved" kind="alertdialog" onclose={() => (revertOpen = false)}>
        <p class="note">
          restores this file to the last saved copy on disk — your unsaved edits leave the draft
        </p>
        <div class="acts">
          <button
            class="verb "
            data-verb-id="editor.revert-confirm"
            type="button"
            title="Restores the last saved file from disk."
            onclick={() => {
              revertOpen = false;
              onrevert();
            }}>Restore last saved</button>
          <button
            class="verb cancel "
            data-verb-id="editor.revert-cancel"
            type="button"
            title="Keeps your unsaved edits."
            onclick={() => (revertOpen = false)}>Keep editing</button>
        </div>
      </Popover>
    {/if}

    {#if mode === "edit"}
      <div class="acts">
        <button
          class="verb strong primary"
          data-verb-id="editor.save"
          type="button"
          disabled={!dirty || saving}
          aria-busy={saving}
          title={dirty
            ? "Writes your changes to this exact file, and refuses if it changed on disk since you opened it."
            : "Nothing has changed, so there is nothing to write."}
          onclick={onsave}>{saving ? "Saving…" : "Save file"}</button>
        <button
          class="verb "
          data-verb-id="editor.revert"
          type="button"
          disabled={!dirty}
          title="Restores the last saved file from disk. Your unsaved edits leave the draft."
          onclick={() => (revertOpen = true)}>Restore last saved</button>
        <span class="hint">nothing is written to disk until you press save</span>
      </div>
    {/if}

    <div class="body">
      {#if probeLoad === null}
        <Answer answer={pending("looking at this file")} />
      {:else if probeLoad.kind === "absent"}
        <!-- A load-level "absent" is built from a CAUGHT ERROR (feed.ts wraps
             the throw in a reason), so in the grammar it is a read that broke,
             not a measured emptiness. -->
        <Answer answer={failed(`this file — ${probeLoad.reason}`)} />
      {:else if probe !== null && probe.kind === "absent"}
        <!-- The probe SUCCEEDED and answered "nothing there" — a measured
             emptiness, which is the grammar's absent. -->
        <Answer answer={absent("there is nothing at this path any more")} />
      {:else if probe !== null && probe.kind === "directory"}
        <Answer answer={absent("this is a folder — open it on the left to see what is inside it")} />
      {:else if probe !== null && !probe.text && probe.mediaType === null}
        <Answer answer={absent(binarySentence(probe))} />
      {:else if needsConfirm}
        <div class="gate">
          <!-- The null guard is load-bearing: absent("") throws at the door,
               so the old ternary's empty-string arm must not survive into a
               factory. `needsConfirm` already implies a probe, but the
               template must not lean on that implication to feed the gate. -->
          {#if probe !== null}
            <Answer answer={absent(largeReadSentence(probe))} />
          {/if}
          <button
            class="verb strong"
            data-verb-id="editor.open-large"
            type="button"
            title="Loads this file now, at the size stated above."
            onclick={onopenanyway}>Open it anyway</button>
        </div>
      {:else if renderMode === "image"}
        {#if mediaLoad === null}
          <Answer answer={pending("loading this picture")} />
        {:else if mediaLoad.kind === "absent"}
          <Answer answer={failed(`this picture — ${mediaLoad.reason}`)} />
        {:else if mode === "rendered"}
          <figure class="media">
            <img class="image" src={mediaLoad.media.dataUrl} alt={relativePath} />
            <figcaption class="fact">
              {mediaLoad.media.mediaType} · {fileSizeText(mediaLoad.media.size)}
            </figcaption>
          </figure>
        {:else}
          <!-- Same empty-string guard as the large-read gate above. -->
          {#if probe !== null}
            <Answer answer={absent(binarySentence(probe))} />
          {/if}
        {/if}
      {:else if textLoad === null}
        <Answer answer={pending("reading this file")} />
      {:else if textLoad.kind === "absent"}
        <Answer answer={failed(`this file — ${textLoad.reason}`)} />
      {:else}
        {#if textLoad.truncated}
          <p class="note warn">
            showing the first {fileSizeText(textLoad.content.length)} of {fileSizeText(textLoad.size)}
            — the rest was not sent, so this file cannot be saved from here without losing it
          </p>
        {/if}
        {#if mode === "edit"}
          <TextEditor
            value={shown}
            label={`the text of ${relativePath}`}
            onchange={ondraft}
          />
        {:else if isEmptyFile}
          <!-- A file with no bytes draws nothing in every view, so every view
               would be an empty box. The measured fact is said instead. -->
          <Answer answer={absent("this file is empty — 0 bytes on disk, and nothing to show in any view")} />
        {:else if mode === "rendered" && renderMode === "markdown"}
          <div class="rendered"><Prose text={shown} /></div>
        {:else if mode === "rendered" && renderMode === "diff"}
          <div class="rendered">
            {#if diffHasHunks && parsedDiff !== null}
              <UnifiedDiff parsed={parsedDiff} patch={shown} showCounts={true} />
            {:else}
              <!-- NAMED AS A PATCH, HOLDING NO CHANGE. The parser answers a
                   document for any text at all, so this is the only place the
                   difference can be stated; drawing `+0 −0` over an empty
                   scroller would say a change was read and found to be nothing.
              -->
              <Answer
                answer={absent(
                  `this file is named as a patch but holds no change a diff can be read from — ` +
                    `no hunk header (@@) was found in its ` +
                    `${textLoad.lineCount.toLocaleString("en-US")} lines. Its characters are below.`,
                )}
              />
              <CodeBlock code={shown} lang={textLoad.language} startLine={1} />
            {/if}
          </div>
        {:else if mode === "rendered" && renderMode === "page"}
          <div class="rendered">
            <p class="note">
              this page runs inside a sealed frame: it cannot reach this page, your session, or the
              network
            </p>
            {#if pageBlocked.length > 0}
              <!-- WHY THE FRAME MAY LOOK EMPTY, from the page's own text. The
                   policy blocks every file beside this one, which is most of
                   what an `.html` file on a disk is made of. -->
              <p class="note warn">{pageBlocked}</p>
            {/if}
            <ArtifactFrame
              frameKey={pageFrameKey}
              view={{
                kind: "document",
                type: "page",
                title: relativePath,
                content: shown,
                bytes: textLoad.size,
              }}
            />
          </div>
        {:else}
          <CodeBlock code={shown} lang={textLoad.language} startLine={1} />
        {/if}
      {/if}
    </div>
  {/if}
</section>

<style>
  .pane {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    padding: var(--sp-3) var(--sp-4) var(--sp-6);
    overflow-y: auto;
    position: relative;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-wrap: wrap;
    min-height: var(--editor-toolbar-h);
    padding-bottom: var(--sp-2);
    border-bottom: var(--hairline-w) solid var(--line-1);
  }
  .path {
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--ink-1);
    min-width: 0;
  }
  .fact {
    font-family: var(--face-mono);
    font-size: var(--f-nano-size);
    color: var(--ink-4);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  /* The unsaved marker spends the warn ink over the owned engraved register
   * (the track and case are the register's, carried by `.engraved-ctl`). */
  .unsaved {
    color: var(--warn);
  }
  .grow {
    flex: 1;
  }
  .acts {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-wrap: wrap;
  }
  .hint {
    font-family: var(--face-mono);
    font-size: var(--f-nano-size);
    color: var(--ink-4);
  }
  /* The verb recipe is owned by tokens.css (.cockpit .verb); this
   * room's verbs keep the smaller engraved register (.engraved-ctl,
   * carried as a marker class) and its own ink/pad. */
  /* The view you are ON is a state of the control, not a colour: the same
   * chip, filled. Colour in this system belongs to facts, not to chrome. */
  .verb.on {
    background: var(--layer-select);
    color: var(--ink-1);
    border-color: var(--line-2);
  }
  .body {
    flex: 1;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .rendered {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .media {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    align-items: flex-start;
  }
  /* The picture's box is bounded by the ROOM, never by the picture: an image
   * that sized the pane would move everything beside it as it loaded. */
  .image {
    max-width: 100%;
    max-height: var(--editor-media-max-h);
    object-fit: contain;
    background: var(--ground-1);
    border: var(--hairline-w) solid var(--line-1);
    border-radius: var(--radius-1);
  }
  .gate {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--sp-2);
  }
  .note {
    margin: 0;
    font-family: var(--face-mono);
    font-size: var(--f-nano-size);
    color: var(--ink-2);
  }
  .note.warn {
    color: var(--warn);
  }
  .resting {
    margin: 0;
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    /* An absence sentence — the pane has nothing yet and says why. It wears
     * the owned answer treatment: never italic (the slant was retired), in
     * the absence ink, so it reads as one register with every other "there
     * is nothing here" in the cockpit. */
    color: var(--state-absent-ink);
  }
</style>
