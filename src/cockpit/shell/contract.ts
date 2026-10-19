/**
 * The shell contract — the ONLY seam between the cockpit shell and the
 * surfaces that mount into it (FLOW, SWEEP, DESK, rooms, scope bodies).
 *
 * DESIGN-COCKPIT-V2 §2. The shell owns geometry and the keyboard grammar;
 * surface agents own their content. Integration is file-convention + this
 * type module — a sibling NEVER edits a shell file to mount:
 *
 *   FLOW outlet   → create `src/cockpit/flow/Flow.svelte`
 *   SWEEP outlet  → create `src/cockpit/sweep/Sweep.svelte`
 *   DESK outlet   → create `src/cockpit/desk/DeskPanel.svelte` (open desk,
 *                   280px: channel strips + breaker panel)
 *                 → create `src/cockpit/desk/Gauge.svelte` (closed-desk
 *                   gauge slot, right of the composer)
 *   ROOMS         → create `src/cockpit/rooms/<Id>Room.svelte` where <Id> is
 *                   the capitalized RoomId, AND add that id to the `RoomId`
 *                   union below. A room is the one outlet whose two halves
 *                   must land together: a file with no id is unreachable, and
 *                   an id with no file is a summonable surface that can never
 *                   open. The other outlets above are single components with
 *                   no second declaration, so the convention alone carries
 *                   them.
 *
 * The shell discovers these with `import.meta.glob` (see outlets.ts): when
 * the file does not exist the outlet renders its honest "not built yet"
 * state; when it lands, the shell mounts it at the one-reveal frame (§10)
 * with the props below. No shell file changes either way.
 *
 * EVERY outlet component receives exactly these props:
 *   - `shell: ShellApi` — the imperative surface below.
 * The same object is also available via Svelte context:
 *   `getContext<ShellApi>(SHELL_CONTEXT_KEY)`.
 */

export const SHELL_CONTEXT_KEY = "cockpit-shell";

/** Mounted inspector bodies expose sections through the shared Disclosure.
 * Registration is metadata only; opening uses the section's existing action
 * and therefore its existing on-demand data acquisition. */
export const INSPECTOR_SECTIONS_CONTEXT_KEY = "cockpit-inspector-sections";
export type InspectorSection = Readonly<{
  id: string; label: string; keywords: string; open: () => void;
}>;
export type InspectorSections = Readonly<{
  register: (section: InspectorSection) => () => void;
}>;

/**
 * Rooms are summoned full-screen, one at a time, Esc closes (§2.5).
 *
 * ── EVERY MEMBER HERE HAS A DOOR ──────────────────────────────────────────
 *
 * This union used to carry `"memory"` and `"tools"`, and neither
 * `MemoryRoom.svelte` nor `ToolsRoom.svelte` had ever been written. Nothing
 * failed: the glob simply did not match them, `roomExists` answered false, and
 * every consumer test stubbed `roomExists`, so the suite was green over two
 * rooms that could never open. Two of seven declared rooms were permanently
 * dead and no instrument in the repository said so.
 *
 * A declared id with no component is not harmless. `openRoom(id: RoomId)`
 * accepts it, so the type SAID a caller could summon a surface that can only
 * ever render "not built yet" — the empty state was representable, which is
 * the one thing a type is able to prevent. Two live modules had already
 * written workarounds around the fact in prose: the warm plans table notes
 * that warming a room that cannot open would be "speculation about a surface
 * that does not exist".
 *
 * So the members are exactly the rooms that exist. Adding a room is still the
 * file convention — create `src/cockpit/rooms/<Id>Room.svelte` — plus this one
 * line, and the two halves are held together mechanically rather than by
 * memory: `tests/cockpit/room-door-owner.test.ts` refuses a declared id with
 * no component AND a component with no declared id, judged against the REAL
 * glob rather than a stub.
 */
export type RoomId =
  | "switch"
  | "instruments"
  | "custody"
  | "settings"
  | "editor";

/**
 * A HORIZON annunciator — at most 3, priority-ordered, dark when healthy.
 * A lit slot is a fact in an ABNORMAL state plus its verb (§2.4), and every
 * prominence change must carry its plain-words reason (§1.5 F1 — the
 * salience law: unexplained salience is a bug).
 */
export type Annunciator = Readonly<{
  id: string;
  /** Plain words, e.g. "1 check failing". */
  label: string;
  /** The operable verb, adjacent — no verb, no pixels (§1.2). */
  verb: Readonly<{ label: string; run: () => void }>;
  /** Higher wins one of the ≤3 slots. */
  priority: number;
  /** Why this is lit, in plain words with its inputs (§1.5 F1). */
  reason: string;
}>;

/** A pinned HORIZON monitor — uniform 96×28, a REFERENCE to its single
 * source (§1.4): clicking opens the source, never a second rendering. */
export type Monitor = Readonly<{
  id: string;
  label: string;
  /** Measured value, already formatted. Honest absence allowed. */
  value: string;
  /** Epoch ms of the measurement (§1.1 — every number has an asOf). */
  asOf: number;
  openSource: () => void;
}>;

/** Scope sheet request — right sheet min(560px,42vw); side-docks ≥1900px. */
export type ScopeRequest = Readonly<{
  /** Engraved title (rendered --f-micro). */
  title: string;
  /** A Svelte component to render as the sheet body (optional in phase 0 —
   * without one the sheet renders its honest empty state). */
  component?: unknown;
  props?: Readonly<Record<string, unknown>>;
}>;

/**
 * DESK-LINE slot request (§4.3) — the ONE findings row. Findings and the live
 * grammar menu dock here (not into the flow's bottom padding); the docked
 * component is the requester's own (the shell renders, never interprets).
 * `null` clears the slot.
 *
 * WHERE THE ROW SITS IS THE SHELL'S DECISION, NOT THE REQUESTER'S, and it
 * changed: the row used to ride the desk's top edge, which put the computer's
 * sentences below the timeline; the user asked for them above it, so
 * Cockpit.svelte now declares the row between the FLOW and the SWEEP. Nothing
 * on this seam changed — which is the point of the seam. The name is kept
 * because it is the §4.3 vocabulary and is spelled into the computer's own
 * admission controller (`computer/admission.ts::deskLine`).
 */
export type DeskLineRequest = Readonly<{
  component: unknown;
  props?: Readonly<Record<string, unknown>>;
}>;

/**
 * Keyboard grammar targets a surface can claim (§2.7). The shell registers
 * the COMPLETE grammar on day one; a chord whose target is unclaimed shows
 * the grammar hint ("not built yet") — a pressed key never silently does
 * nothing. Claiming a target routes the chord to the surface.
 */
export type GrammarTarget =
  | "command" /* ⌘K — command grammar in the composer */
  | "switch" /* ⌘J */
  | "desk" /* ⌘. — handled by the shell itself */
  | "instruments" /* ⌘' */
  | "settings" /* ⌘, */
  | "custody" /* ⌘G */
  | "editor" /* ⌘E — files and folders of the project */
  | "chat" /* the conversation — close any room, show the flow */
  | "scrub-back" /* [   (⇧: by run) */
  | "scrub-forward" /* ]   (⇧: by run) */
  | "focus-prev" /* ↑ — beat focus by causal order */
  | "focus-next" /* ↓ */
  | "collapse" /* ← */
  | "expand" /* → */
  | "open-scope" /* Enter on a beat */
  | "escape" /* Esc — NOT claimable: the shell's dismissal ladder owns it (shell/routing.ts) */
  /* `verb-menu` (. on a focused fact) was retired with the `⋯` beat menu it
   * opened — the user found every one of that menu's entries duplicated by a
   * control already on the row or by a more direct gesture. See the note in
   * shell/keyboard.ts and the inventory in flow/Flow.svelte. */
  | "setting" /* , on a focused fact */
  | "lens" /* ⌘L */
  | "arm" /* ⌘⇧A */
  | "run" /* ⌘R — the run pane (conversation's right-side inspector) */
  | "send"; /* ⌘⏎ */

/**
 * How a chord claim is held (see `ShellApi.claimKey`). The mechanics live in
 * shell/routing.ts; the vocabulary lives here, because it is part of what the
 * shell publishes to every surface.
 */
export type ClaimOptions = Readonly<{
  /** Only while a surface is open — may stack over the permanent owner. */
  transient?: boolean;
  /** Plain words naming the claimant; the conflict message says who. */
  owner?: string;
}>;

/** A dismissible surface, registered while it is open (`pushDismiss`). */
export type DismissRequest = Readonly<{
  /** Plain words for what Esc would close here ("the beat menu"). */
  label: string;
  dismiss: () => void;
  /** A global condition (the planted head), not a nested surface. */
  floor?: boolean;
}>;

export type ShellApi = Readonly<{
  /** performance.now() of the one-reveal frame (§10.3). 0 until revealed. */
  revealAt: () => number;

  openRoom: (id: RoomId) => void;
  closeRoom: () => void;
  openScope: (req: ScopeRequest) => void;
  closeScope: () => void;

  /** Replace the annunciator set (shell enforces ≤3 by priority). */
  setAnnunciators: (list: readonly Annunciator[]) => void;
  /** Replace the pinned monitors (shell enforces ≤4). */
  setMonitors: (list: readonly Monitor[]) => void;

  /**
   * Claim a grammar target. Returns the release fn — call it on unmount.
   * `shift` is true for the ⇧-variant (scrub by run); unclaimed targets fall
   * back to the grammar hint.
   *
   * CLAIMS ARE A STACK, NOT AN ASSIGNMENT (shell/routing.ts). The top of the
   * stack wins and the release pops THAT entry, so the claim underneath comes
   * back. A claim is PERMANENT by default — one per target, for the
   * claimant's whole mounted life. A second permanent claim on the same
   * target is a DEFECT and is refused loudly (it throws in dev), because a
   * silent steal is decided by mount order and shows up as a dead key
   * somewhere else. A surface that is only open for a while passes
   * `{ transient: true }` and may sit on top of a permanent claim.
   *
   * `escape` CANNOT be claimed — see `pushDismiss`.
   */
  claimKey: (
    target: GrammarTarget,
    handler: (ev: Readonly<{ shift: boolean }>) => void,
    opts?: ClaimOptions,
  ) => () => void;

  /**
   * Register a surface as DISMISSIBLE while it is open (§2.7 Esc).
   *
   * Esc is the shell's, and it dismisses INNERMOST FIRST: the most recently
   * pushed layer active in the room on screen takes the key, one level per
   * press, before the shell closes the room, the scope, or returns to now.
   * Push when the surface opens, call the returned release when it closes —
   * in Svelte that is one `$effect` returning its own cleanup. Nothing needs
   * a capture-phase Esc listener to be correct.
   *
   * A layer is bound to the room that is on screen when it is pushed, so a
   * surface left open inside a kept-alive room is inactive while that room is
   * hidden and active again when it is shown.
   *
   * `floor: true` marks a global CONDITION rather than a nested surface (the
   * planted head): context-independent, and consulted only after the room and
   * the scope have been closed.
   */
  pushDismiss: (req: DismissRequest) => () => void;

  /** Show the transient grammar hint line (aria-live, auto-dismiss). */
  hint: (text: string) => void;

  /** Read the composer's buffered text (typing during boot buffers here and
   * is never lost — §10, F3) and subscribe to submissions. */
  composerText: () => string;
  onComposerSubmit: (handler: (text: string) => void) => () => void;

  /** Put text into the composer and focus it — the prefill seam the FLOW's
   * "edit & resend" verb needs (§1.2: without it the verb is honestly
   * disabled). Replaces the current text; typing continues from there. */
  prefillComposer: (text: string) => void;
  /**
   * The box consumes EXACTLY what was sent. `sent` is the submission's own
   * snapshot at send time: the clear removes that snapshot and nothing else,
   * so words typed into the box between the send and the clear (the commit
   * window) survive — the reader's later typing was never the send's to
   * take. If the field no longer holds the snapshot as its prefix (the
   * reader edited the sent words themselves during the window), nothing
   * provably belonging to the send is left to remove and the field stands.
   */
  clearComposer: (sent: string) => void;
  /**
   * A REFUSED SEND GIVES THE WORDS BACK. The server declined the run, so the
   * submission consumed nothing: the words return to the box (ahead of
   * whatever the reader typed meanwhile, which is the order they were
   * typed in) and the box takes focus for the correction. The refusal
   * contract's second half — `clearComposer` un-consumes on the one path
   * that already cleared: a send refused before the transcript was touched
   * never cleared at all.
   */
  restoreComposerText: (text: string) => void;
  /** Subscribe to composer text changes, fired per keystroke — the live
   * `/`-autocomplete seam. Returns the unsubscribe. */
  onComposerChange: (handler: (text: string) => void) => () => void;

  /** Dock a component into the findings row (§4.3 — between the flow and
   * the band). Last request wins; `null` clears. */
  setDeskLine: (req: DeskLineRequest | null) => void;
}>;

/** Props every outlet component receives. */
export type OutletProps = Readonly<{ shell: ShellApi }>;

/**
 * One KEPT-ALIVE room in the shell's room stack.
 *
 * A room enters the stack the first time the user opens it and never leaves:
 * closing hides it, it does not unmount (RoomHost.svelte). `comp` is null when
 * the `<Id>Room.svelte` file does not exist yet — an honest "not built yet"
 * state, kept alive like any other so the answer does not flicker either.
 */
export type VisitedRoom = Readonly<{
  id: RoomId;
  comp: import("svelte").Component<OutletProps> | null;
}>;
