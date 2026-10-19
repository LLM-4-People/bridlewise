/**
 * COCKPIT FLOW — beat model (spec: DESIGN-COCKPIT-V2.md §3).
 *
 * A beat is ONE causal fact rendered in the flow: your words, the model's
 * words, a tool call, a file effect, an inline event, a check delta, a
 * finding, or a turn seam. Beats live in the flow log (log.ts) — a plain
 * module array OUTSIDE any reactive proxy — and carry their causal parentage
 * (`parentId`) so the fisheye (fisheye.ts) and the causal ribbons can be
 * computed from the beats' own record, never from layout.
 *
 * Every number carried here is MEASURED (from the envelope, the store, or a
 * counted diff). Absence is `undefined`, rendered as absence — never zero,
 * never a stand-in (§1.1 honest-data law).
 */

import type { EventKind } from "../../../shared/event-types.ts";
import type { Derivation } from "../computer/derivation.ts";
import type { VERB_MARK } from "../shell/verb-marks.ts";
// The dedup summary's one shape owner (state/dedup.ts) — the beat carries
// the wire's own object, never a restated copy of its fields.
import type { DedupSummary } from "../../state/dedup.ts";
import type { RedactionSummary } from "../../state/redaction.ts";

export type BeatKind =
  | "turn"
  | "tool"
  | "effect"
  | "check-delta"
  | "event"
  | "finding"
  | "seam"
  | "act";

/**
 * A verb on a beat (§1.2 no-verb-no-pixels).
 *
 * `wired: true` verbs carry `run` — a real client call. `wired: false` verbs
 * MUST carry `reason` — the honest sentence for why the verb cannot act yet
 * ("undo waits on the custody actions — not wired yet"). Rendering a disabled
 * verb without its reason is forbidden by the Verb component (it throws) and
 * by tests/cockpit/verb-owner.test.ts.
 */
export type BeatVerb = Readonly<{
  /** Stable id naming the wired endpoint or the gap, e.g. "chat.rollback". */
  id: string;
  /** Plain-language label, e.g. "rewind here". */
  label: string;
  /** Optional shared control icon; the full label remains its accessible name. */
  mark?: keyof typeof VERB_MARK;
  wired: boolean;
  /** Mandatory when `wired` is false: the honest reason ON the verb. */
  reason?: string;
  /** The real effect. Present exactly when `wired` is true. */
  run?: () => void | Promise<void>;
  /**
   * TRUE when running this verb CHANGES THE WORLD (§6.2: a past view is
   * read-only).
   *
   * Declared, not inferred. Verbs are built at ingest time and their ids are
   * bound at runtime, so no source scan can reach inside `run` to see that a
   * rollback or a re-run writes — which is exactly how two writes came to
   * bypass the Broker's write door and stayed fireable during a past view. A
   * declared flag gives the guard something to scan, and gives the CONTROL
   * something to say: `Verb.svelte` renders a writing verb disabled, with
   * the past-view reason on it, BEFORE the click rather than failing at the
   * door. The door assertion stays as the guarantee — the flag is the
   * courtesy — because a courtesy that is also the guarantee is no
   * guarantee at all.
   */
  writes?: boolean;
}>;

// ── Kind payloads ────────────────────────────────────────────────────────────

export type TurnBody = Readonly<{
  who: "you" | "model";
  /**
   * The transcript message this turn was rendered from.
   *
   * The join key for facts that are measured PER FRAME and therefore cannot
   * live on the beat: the rail's observed character count moves hundreds of
   * times while a tool call's arguments stream, and rebuilding the beat for
   * each one would re-derive the flow's whole visible window per token (§3.8
   * — the log array is never rewritten per token; `flow/turn-timing.ts` states
   * the same split). The beat carries the key; the live counts stay outside.
   *
   * INTERNAL, never rendered — `flow-no-internal-ids-rendered.test.ts` is the
   * standing guard that no beat prints an id at a reader.
   */
  sourceId?: string;
  /** Committed prose. The in-flight tail streams via the streamingTail atom
   * and is rendered by the tail beat only — it is NOT copied here per token. */
  text: string;
  /** True while this is the model turn currently streaming. */
  streaming: boolean;
  /**
   * TRUE when YOUR message here was sent while this conversation's run was
   * live — it queued for the run's next turn rather than starting a run of
   * its own (the composer's steer routing). Live-session state from the
   * transcript message (`ChatMessage.steered`); absent on a reloaded
   * conversation, where the recorded `steering` event beat carries the same
   * fact durably.
   */
  steered?: boolean;
  /** The model's thinking stream. Measured text, exactly as received. */
  reasoning?: string;
  /**
   * TRUE once a `text_delta` frame has been received for this turn — the
   * observed instant the ANSWER began, as opposed to the thinking that may
   * have preceded it. Set from the received frame (flow/turn-timing.ts) and
   * never inferred from content shape or from a delay: it is the boundary the
   * thinking fold collapses at (flow/thinking-fold.ts), and a guessed boundary
   * would be fabricated data.
   *
   * Absent for a turn whose frames this session did not see (a conversation
   * re-read from the database); `answerBegun` falls back to the committed
   * text, which is the same fact recorded rather than observed.
   */
  answerStarted?: boolean;
  /** Measured footer numbers — from the envelope, or absent. */
  inputTokens?: number;
  outputTokens?: number;
  /**
   * TIME TO THE FIRST TOKEN OF ANY KIND — thinking or answer — in ms.
   *
   * THE USER'S RULING, VERBATIM: "for thinking models, ttft is from the time
   * it starts thinking". This is that number, and it is a DIFFERENT quantity
   * from `firstWordMs` below rather than a redefinition of it —
   * flow/turn-timing.ts states why in full. Measured live from received
   * frames, absent for a turn re-read from the database.
   */
  firstOutputMs?: number;
  /**
   * First ANSWER word latency in ms (the recorded `ttftMs`). Unchanged in
   * meaning: it has always been the clock to the first `text_delta`, and every
   * latency already in the database means exactly that. See `firstOutputMs`.
   */
  firstWordMs?: number;
  /**
   * MEASURED PRODUCING WINDOW — first token of any kind to the finish frame.
   *
   * Exists because the recorded tokens-per-second is permanently absent on
   * this provider: `usage` arrives AFTER `finish`, so the writer that computes
   * the rate runs while the token counts are still undefined and never runs
   * again (flow/turn-timing.ts states it in full). Holding the WINDOW and
   * doing the division at render time makes the arrival order irrelevant —
   * late token counts simply complete the number.
   */
  generationMs?: number;
  /** Tokens per second (measured). */
  tokPerSec?: number;
  finishReason?: string;
  /**
   * Why this turn never reported an answer — the reconcile's verdict for a
   * turn whose run ended before any word was kept. Carried from the
   * transcript message (`ChatMessage.incompleteReason`) so the turn's own
   * row speaks its own ending; rendered as the quiet line, never as prose.
   */
  incompleteReason?: string;
  responseModel?: string;
  /**
   * How much of THIS call's input the dedup layer folded before the
   * request (chars before/after, pct, blocks removed) — the wire's own
   * numbers, from the turn's record (the message metadata), so the live
   * and reloaded views of the same turn agree. Absent when the call
   * removed nothing: absence, never a zero.
   */
  dedupSummary?: DedupSummary;
  /**
   * What THIS call's input had masked before the request left the
   * machine (how many values, split by confidence, the already-hidden
   * upstream count, a value-free reason per span) — the wire's own
   * numbers, from the turn's record, so the live and reloaded views of
   * the same turn agree. Absent when the call masked nothing: absence,
   * never a zero — and no field of it could carry the masked value
   * itself.
   */
  redactionNotice?: RedactionSummary;
}>;

export type ToolStatus = "running" | "done" | "error";

export type ToolBody = Readonly<{
  /** The tool's registry name, e.g. "edit". */
  name: string;
  /** Plain-words label derived from the name ("edit file — apply patch"). */
  label: string;
  status: ToolStatus;
  /** Input as received (streamed via append patches while running). */
  input: unknown;
  /** Output as received. Only what the tool returned — never synthesized. */
  output: unknown;
  /** Client observation for a call that never reported a result. */
  incompleteReason?: string;
  /**
   * TRUE when the recorded result is a REFUSAL record — the call was
   * refused before dispatch (the safety gate) or the tool returned a
   * failure. The artifact decision keys "was the document accepted" on
   * this typed fact (a gate-refused create_artifact holds the refusal,
   * never a live frame of the document the gate declined to create).
   * Absent for in-flight calls and for a stranded call's client-observed
   * incompleteness.
   */
  refused?: true;
  startedAt: number;
  /** Measured duration, or undefined (see toolCallDurationMs authority). */
  durationMs?: number;
  attemptCount?: number;
}>;

export type EffectBody = Readonly<{
  /** Project-relative path of the changed file. */
  path: string;
  /** Which tool produced it (beat id of the tool beat — the causal parent). */
  producedBy: string;
  /** Counted from the real diff patch once fetched; absent until measured. */
  added?: number;
  removed?: number;
  /** First hunk of the real unified diff (micro-preview), absent until fetched. */
  firstHunk?: string;
  /** Full patch when fetched (for the expanded view). */
  patch?: string;
  /** Set when the diff read failed — rendered as honest absence with cause. */
  diffError?: string;
  /**
   * The server's own sentence for a diff read on a project with NO
   * repository, set INSTEAD of the patch and the counts: without a
   * repository there is no earlier version to diff against, so a ± count
   * would be a zero that measures nothing — the counts stay absent and the
   * reason names the real cause (never the commit/revert story, which
   * cannot be true where no repository exists).
   */
  noRepositoryReason?: string;
}>;

export type CheckDeltaBody = Readonly<{
  checkId: string;
  checkName: string;
  from: string;
  to: string;
  /** Measured error count from the check output, when the output carries one. */
  errorCount?: number;
}>;

export type EventBody = Readonly<{
  eventKind: EventKind | "client-error";
  text: string;
  /**
   * The CANONICAL ledger event this beat IS (the eventId the recording run
   * returned), when there is one. INTERNAL — a ledger address for the
   * documents door, never rendered text (the no-internal-ids guard bans
   * addresses from prose). Absent honestly: client-side errors were never
   * recorded in a ledger, and gate-block SSE frames carry no eventId.
   */
  eventId?: string;
}>;

/**
 * AN OPERATOR INTERVENTION — something YOU did to the run itself.
 *
 * THE USER'S REQUIREMENT, VERBATIM: "show when we steer, manipulate context,
 * trim, etc".
 *
 * The flow recorded what you SAID, what the model said, and what the model
 * DID. It did not record what you did to the machine: pinning a memory,
 * muting a channel, moving the trim point, flipping a breaker, arming an
 * auto-trip, saving a setting. Each of those changes what the model receives
 * or what it is allowed to do on the very next turn — so a reader scrubbing
 * back through the run could see the model's behaviour change and find no
 * cause for it anywhere in the record. That is the gap this closes.
 *
 * EVERY FIELD IS TRANSCRIBED, NONE IS AUTHORED. `title` and `consequence` are
 * the words the action DECLARED at registration (server/blocks/define.ts
 * requires both, non-blank, or the server refuses to start), served in the UI
 * schema's `blockActions` manifest and copied here verbatim. The log and the
 * control therefore cannot disagree about what a control does — they are
 * reading the same sentence. When the manifest has not loaded, or names no
 * such action, the words are ABSENT and render as absent (§1.1); nothing is
 * written to fill the hole.
 */
export type ActBody = Readonly<{
  /** The block the action belongs to, e.g. "run.compose". */
  block: string;
  /** The action within it, e.g. "pin". */
  action: string;
  /** The DECLARED title, verbatim from the served manifest. Absent when the
   *  manifest has not loaded or does not name this action. */
  title?: string;
  /** The DECLARED consequence — what it will affect — verbatim. Absent for
   *  the same reasons, and never substituted. */
  consequence?: string;
  /** Did the act settle, or did it fail? Read from the Broker's record. */
  state: "done" | "failed";
  /** The input the act was issued with, as the Broker sent it. Renders
   *  through the same reader a tool call's arguments use. */
  input?: unknown;
  /** Measured wall-clock cost of the act. */
  latencyMs: number;
  /** The typed error code the Broker recorded, when it failed. */
  errorCode?: string;
}>;

export type FindingBody = Readonly<{
  /** The computed sentence. One sentence, plain words. */
  sentence: string;
  /** MANDATORY derivation (§4.4) — enforced by cockpit-derivation-owner. */
  derivation: Derivation;
  /** Finding kind for admission/dismissal learning (§4.6). */
  findingKind: string;
  /** The finding's own verbs, when it has them (the fired-trigger finding's
   * go + re-arm). Absent = the host's default verb set (the desk line's trim
   * placeholder for the context projection). */
  verbs?: readonly BeatVerb[];
}>;

export type SeamBody = Readonly<{
  /** Turn index this seam closes. */
  turnIndex: number;
  /** The one-line measured rollup sentence. */
  sentence: string;
  derivation: Derivation;
  /** Queued findings held behind the "+N more" fold (§4.3). */
  queued: number;
}>;

// ── The beat ────────────────────────────────────────────────────────────────

export type Beat = Readonly<{
  id: string;
  kind: BeatKind;
  /** Causal parent beat id (tool → turn, effect → tool, finding → seam host). */
  parentId: string | null;
  /** Turn ordinal this beat belongs to (0-based over user turns). */
  turnIndex: number;
  /** Wall-clock of the underlying fact (measured, from the source record). */
  at: number;
  /** Abnormal state by the fact's own thresholds (failed tool, failing check,
   * error event) — feeds DOI and earns default pixels (§1.2). */
  abnormal: boolean;
  /** Prose beats render at measure; instrumental beats bleed (§2.1). */
  bleed: boolean;
  verbs: readonly BeatVerb[];
  turn?: TurnBody;
  /** The tool call this beat records. A tool-kind beat may carry NO body
   * (the refusal path — the name never reached the record), so fixtures
   * spell the absence explicitly as `tool: undefined`. */
  tool?: ToolBody | undefined;
  effect?: EffectBody;
  checkDelta?: CheckDeltaBody;
  event?: EventBody;
  finding?: FindingBody;
  seam?: SeamBody;
  act?: ActBody;
}>;

/**
 * WHAT A BEAT IS, in the words a person would use — zero-knowledge language
 * (§1.1).
 *
 * "turn" is INTERNAL vocabulary. It is the noun this codebase uses for a
 * message exchange, and it leaked onto the SCOPE sheet, where a reader was
 * shown `turn · turn 4` above a field reading `turn` above a value reading
 * `turn 4` — three restatements of a word that means nothing to them. A
 * surface says what a thing IS, or says nothing and lets the content speak.
 */
export function beatNoun(beat: Beat): string {
  switch (beat.kind) {
    case "turn":
      return beat.turn?.who === "you" ? "your message" : "the assistant's reply";
    case "tool":
      return "a tool call";
    case "effect":
      return "a file change";
    case "check-delta":
      return "a check result";
    case "event":
      return "something the harness reported";
    case "finding":
      return "something the computer worked out";
    case "seam":
      return "the end of an exchange";
    case "act":
      return "something you changed about the run";
  }
}

/**
 * How one beat refers to the beat that caused it, in plain words.
 *
 * The SCOPE sheet used to print `caused by b-57bf9380-b910-47e9-a93d-…`. A
 * beat id is an internal address; it means nothing to a person and it is not
 * a thing they can act on. Causality is the point of this recording, so it
 * is stated as a reference to the THING — "in reply to your message" — and
 * the surface makes it clickable. The id itself belongs one level deeper,
 * with the rest of the precise record.
 */
export function causalPhrase(parent: Beat): string {
  switch (parent.kind) {
    case "turn":
      return parent.turn?.who === "you" ? "in reply to your message" : "following the assistant's reply";
    case "tool":
      return "produced by a tool call";
    case "effect":
      return "after a file change";
    case "check-delta":
      return "after a check result";
    case "event":
      return "after something the harness reported";
    case "finding":
      return "after something the computer worked out";
    case "seam":
      return "after the previous exchange";
    case "act":
      return "after you changed something about the run";
  }
}

/**
 * Extract the file path from a file-editing tool call's input, or null.
 * Only reads what the record carries — never guesses a path.
 */
export function effectPathOf(input: unknown): string | null {
  if (input === null || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const p = obj["path"] ?? obj["file"] ?? obj["filePath"];
  return typeof p === "string" && p.length > 0 ? p : null;
}
