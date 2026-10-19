/**
 * Run pane — the live data projection behind the right-docked conversation
 * pane (RunPane.svelte). Eleven sections, one derivation each:
 *
 *   progress — the current run (state/run-state.ts: status, model, start
 *     instant) joined to the transcript's own measurements
 *     (state/chat-messages.ts: turns streamed, tokens used, tool calls made,
 *     how many are still running). Nothing is invented: a turn that has not
 *     reported usage contributes NOTHING to the token total, and a run with
 *     no assistant turn yet says "not measured yet" rather than showing a
 *     zero.
 *   runs — THE RECORD'S MAP: every run the causal bands hold over the
 *     sweep's streamed window, each with its span, its event count, its
 *     error count and a go that plants the head at the run's start. The
 *     banding is causal.ts's `buildCausalBands` — the same banding owner
 *     the band's a11y outline derives its runs from — but over a
 *     DIFFERENT input set: this list reads the streamed window while the
 *     outline reads the spectrum-measured coverage the server binned, so
 *     the two agree at rest and may disagree transiently while a run
 *     settles. The error counting reads the `isError` each event already
 *     carries (the projection applied `isErrorEvent`, the counting-policy
 *     owner); this module never re-spells either.
 *   turns — the DEPTH view of the same transcript: one row per model turn
 *     with the turn's own measured facts (the two first-token clocks, the
 *     producing window, tokens, rate, finish reason, responding model, the
 *     steered mark, the interrupted vocabulary). The live-session
 *     measurements (first token of any kind, producing window) are read
 *     through the flow's timing owner (cockpit/flow/turn-timing.ts) and the
 *     rate through its latency owner (`turnLatency`) — this module joins,
 *     it never re-derives. The pane's subscription is the COARSE timing
 *     signal only (`turnTimingVersion`), never the per-arrival one, so a
 *     streaming turn does not re-derive this projection per token.
 *   agents — the delegated-agent registry (state/run-state.ts), already fed
 *     by the SSE `agents` event; this module only narrows + orders it for
 *     the section.
 *   calls — every tool call of the conversation as its own row of facts:
 *     the ONE duration owner's raw terms (startedAt/endedAt/durationMs —
 *     the component calls `toolCallDurationMs` with its ticking clock),
 *     the attempt count, the refusal mark, the stranded-call
 *     incompleteness. The flow already renders causality; this is the
 *     measurement ledger.
 *   edits — the run's file-touching tool calls, derived from the transcript
 *     by the flow's own vocabulary (cockpit/flow/types.ts::FILE_EFFECT_TOOLS
 *     is the single owner of "which tools change a file"; `effectPathOf`
 *     owns "where the path lives in the input"). An edit whose input never
 *     carried a path is still shown, named by its tool — the absence of a
 *     path is a fact about the call, not a reason to drop the row.
 *   codebase — the project's measured state: the repository map summary
 *     (`code.map` block through the Broker) beside the working-tree status
 *     the shared git store already holds (state/git.ts — fed by the SAME
 *     `/git/status` fetch the custody surfaces use, never a second path).
 *     Each starts pending and only becomes measured from a real read; a
 *     failed read is an honest absence in plain words, never a zero.
 *   preparation — the chat-wide rollups of what the harness did to the
 *     input before it left the machine: the dedup layer's folding and the
 *     redaction choke point's masking, summed across the conversation's
 *     turns from the SAME per-turn records the flow's footers read
 *     (ChatMessage.dedupSummary / redactionNotice). The per-turn footers
 *     are the flow's surface; THIS is the aggregate, derived once here —
 *     never restated per row.
 *   record — THE RECORD'S CONTENTS: the events and the errors the sweep's
 *     window holds (the same two-number shape the band's own résumé
 *     reads), beside the interrupted/never-answered turns' own ending
 *     sentences (the reconcile's verdict, read from the SAME turns
 *     derivation the turns section renders) and the distinct error codes
 *     the window's failures carry. A compact diagnostic section; every
 *     figure names the window it was counted over.
 *   ledger — THE RUN-SCOPED EVENT LEDGER: the chat's recorded events from
 *     the canonical `/api/timeline/query` (chat scope resolved to runIds
 *     server-side), paged by the wire's own limit with the cursor honored
 *     and the truncation stated honestly (rows shown vs total recorded).
 *     A planted head BOUNDS the query (`toWallTime` — the store's own
 *     inclusive ranged-read convention), so a past view reads the past;
 *     the read is a route, not a block, so the asOf split governs it at
 *     THIS door rather than in the Broker's block list. Rows whose eventId
 *     maps to a transcript message render a reveal verb into the flow
 *     (the beat-request seam); ledger-only rows render as the facts they
 *     are.
 *   acts — THE ACT TRAIL: the operator interventions the Broker's own
 *     write door recorded (performedActions — the same log the flow mints
 *     its act beats from), each joined with its DECLARED words from the
 *     served manifest (the same join, exported from the flow's ingest).
 *     The who-did-what-when of steering the machine: block, action, the
 *     declared title and consequence, the state, the latency, the input,
 *     the error code.
 *
 * Plain .ts — Node-testable via Vitest. Reads live in this module (the
 * pane's component never fetches); the map + ledger readers are injectable
 * so tests run without a network.
 *
 * @global-store per-project, not per-chat: the map load is keyed by the
 * project path it was fetched for (a chat switch changes nothing about the
 * files on disk; the projection compares the fetch path to the current
 * project, so a stale path reads as pending rather than as the new
 * project's codebase). The progress/agents/edits/turns/calls/preparation
 * derivations hold no state of their own — they recompute from the
 * per-chat stores (run-state, chat-messages), which reset themselves.
 * Reset on logout only.
 */

import { computed, atom, type ReadableAtom } from "nanostores";

import type { AgentState, TimelineEventSummariesResult } from "../../shared/types";
import { TIMELINE_QUERY_LIMIT } from "../../shared/constants.ts";
import { currentRun, agents, isRunActive } from "./run-state.ts";
import {
  messages,
  conversationSummary,
  isStreaming,
  type ToolCallStatus,
} from "./chat-messages.ts";
import { projects, currentProject } from "./projects.ts";
import { currentChatId } from "./chats.ts";
import { gitStatus, gitRefusal, type GitStatusView } from "./git.ts";
import { effectPathOf } from "../cockpit/flow/types.ts";
import {
  turnLatency,
  turnTimingFor,
  turnTimingVersion,
} from "../cockpit/flow/turn-timing.ts";
import { declaredWords } from "../cockpit/flow/ingest.ts";
import { fileEffectToolNames } from "./tools.ts";
import { fetchJson, blockRequestPath } from "../data/broker.ts";
import { asOfHead } from "../data/asof.ts";
import { absenceReason, refusalReason, UNREADABLE_SHAPE } from "../data/absence.ts";
import { registerReset } from "./store-registry.ts";
import { sweepWindowEvents } from "../cockpit/sweep/sweep-data.ts";
import { buildCausalBands } from "../cockpit/sweep/causal.ts";
import { sweepCategoryFor, isErrorEvent } from "../cockpit/sweep/categories.ts";
import type { SweepCategoryId } from "../cockpit/sweep/types.ts";
import { uiSchema } from "./schema-store.ts";
import { performedActions } from "./lens.ts";

// ── Progress ──

export type RunProgressView = Readonly<{
  /** "starting" | "running" | "done" | "error" | null when no run exists. */
  status: string | null;
  modelLabel: string | null;
  /** Epoch ms the run started; null when no run. */
  startedAt: number | null;
  /** Assistant turns streamed this chat (measured from the transcript). */
  turns: number;
  /** Tool calls recorded this chat, and how many are still running. */
  toolCalls: number;
  toolCallsRunning: number;
  /** Tokens the transcript's usage frames reported; null when no turn has
   * reported usage yet (the honest "not measured"). */
  totalTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /**
   * The trace id of the latest run that produced an assistant turn — the
   * address of every ledger event that request recorded, read from the
   * transcript (the message's own persisted fact), NOT the live run view:
   * the run view retires moments after the run ends, which is exactly when
   * an incident gets investigated, and a re-read conversation carries the
   * id from the persisted metadata. Null when no recorded turn carries one.
   */
  traceId: string | null;
}>;

/**
 * The live progress derivation. Joins the run store (the run's own facts)
 * with the transcript summary (the conversation's measured aggregates).
 * Recomputed only when either source changes — nanostores computed.
 */
export const runProgress: ReadableAtom<RunProgressView> = computed(
  [currentRun, messages, conversationSummary],
  (run, list, summary) => {
    let runningTools = 0;
    for (const msg of list) {
      if (msg.role === "tool" && msg.toolCall !== undefined && msg.toolCall.status === "running") {
        runningTools += 1;
      }
    }
    // Token honesty: the summary totals are 0 both when nothing was
    // measured and when every measured turn reported 0 — and those are
    // different facts. A total is only claimed once at least one turn's
    // usage frame has landed (input + output tokens above zero).
    const measured = summary.totalInputTokens + summary.totalOutputTokens > 0;
    // The latest run's trace id, read from the transcript's own record —
    // the newest assistant message that carries one, because a trace is a
    // request-scoped fact stamped on every turn that request produced and
    // the newest one names the run the pane is showing facts about.
    let traceId: string | null = null;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const candidate = list[i]!;
      if (candidate.role === "assistant" && candidate.traceId !== undefined) {
        traceId = candidate.traceId;
        break;
      }
    }
    return {
      status: run?.status ?? null,
      modelLabel: run?.modelLabel ?? null,
      startedAt: run?.startedAt ?? null,
      turns: summary.assistantMessageCount,
      toolCalls: summary.toolCallCount,
      toolCallsRunning: runningTools,
      totalTokens: measured ? summary.totalTokens : null,
      inputTokens: measured ? summary.totalInputTokens : null,
      outputTokens: measured ? summary.totalOutputTokens : null,
      traceId,
    };
  },
);

// ── Agents ──

/** The delegated agents, newest-updated first. The registry is the SSE-fed
 * owner; this is only the ordering the section renders. */
export const runAgents: ReadableAtom<readonly AgentState[]> = computed(
  agents,
  (all) =>
    Object.values(all).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
);

// ── Edits ──

/** One FILE the run touched: the tool that touched it, the path it named,
 * its status and when. The path is REQUIRED — a call that names no file is
 * not an edit and never becomes one of these (see `runEdits`). */
export type RunEditView = Readonly<{
  id: string;
  toolName: string;
  path: string;
  status: "running" | "done" | "error";
  at: number;
}>;

/**
 * The transcript's file-effect calls, oldest first (the order the run made
 * them). The tool vocabulary + path extraction come from the flow's own
 * owner — a new edit tool registered there appears here without an edit to
 * this file.
 *
 * A write-capable call whose input names NO file is NOT an edit (UIE-037):
 * `create_artifact` declares the write capability, so it reaches this
 * filter — but it writes an artifact, not a file in the tree, and it has no
 * path to show. Listing it produced an ERROR-shaped row ("no path in the
 * call") for a call that succeeded. Skipped here, the call still lives
 * where it always did — its own tool beat in the flow — and this section
 * stays what its heading says: the FILES the run touched. The same guard
 * the safety runtime's boundary uses (`editFilePath(args) !== null`) — the
 * fact "which calls edit a file" has one shape everywhere.
 */
export const runEdits: ReadableAtom<readonly RunEditView[]> = computed(
  messages,
  (list) => {
    const out: RunEditView[] = [];
    for (const msg of list) {
      if (msg.role !== "tool" || msg.toolCall === undefined) continue;
      const tc = msg.toolCall;
      if (!fileEffectToolNames().has(tc.name)) continue;
      const path = effectPathOf(tc.input);
      if (path === null) continue;
      out.push({
        id: msg.id,
        toolName: tc.name,
        path,
        status: tc.status,
        at: msg.timestamp,
      });
    }
    return out;
  },
);

// ── Identity ────────────────────────────────────────────────────────────────

/**
 * Which run this pane is inspecting, joined to the project it belongs to.
 *
 * The run id is the RUN VIEW's own fact (run-state.ts `RunView.runId`) — the
 * address the stop verb posts to and the sweep's run bins live under. It
 * deliberately does NOT survive the run view's retirement: the live
 * transcript never stamps it on assistant rows (only the persisted record
 * does, on a re-read), so a "latest recorded run id" would name a PREVIOUS
 * session's run while a live one streams — the trace-id row reads the
 * transcript for exactly this reason and keeps the recorded address
 * standing. When the view retires, this row goes with it, like the status
 * fact does.
 *
 * The project label joins the run's OWN projectId against the projects
 * store — never "whatever project is open" — so a run started under a
 * project the user has since switched away from still names its true
 * binding, and a project id the list no longer holds renders its absence
 * rather than a guess.
 */
export const runIdentity: ReadableAtom<
  Readonly<{ runId: string | null; projectLabel: string | null }>
> = computed([currentRun, projects], (run, list) => {
  if (run === null) return { runId: null, projectLabel: null };
  const bound = list.find((p) => p.id === run.projectId);
  return { runId: run.runId, projectLabel: bound?.name ?? null };
});

// ── Turns (the per-turn drilldown) ─────────────────────────────────────────

/**
 * One model turn's measured facts, joined from every owner that holds one:
 *
 *   - the transcript row (ChatMessage) — the persisted facts: the recorded
 *     first-WORD latency (`timingMetrics.ttftMs`), the token counts, the
 *     finish reason, the responding model, the reconcile's incompleteness
 *     verdict, the dedup/redaction records (read by the preparation
 *     rollup, not restated here);
 *   - the flow's timing owner (turn-timing.ts) — the live-session
 *     measurements this session's frames earned: the first token of ANY
 *     kind (`firstOutputMs`) and the producing window (`generationMs`).
 *     Absent for a conversation re-read from the database — nobody
 *     measured one, and absence renders as absence;
 *   - the latency owner (`turnLatency`) — the rate, derived by the ONE
 *     owner of "which recorded number may wear the ttft name" so this
 *     projection never restates that arithmetic.
 *
 * The `steered` mark reads the user message that preceded the turn: a
 * steered instruction queues for the run's next turn, so the turn it
 * precedes is the one that consumed it. Live-session state, exactly as the
 * flow renders it (the durable trace is the recorded `steering` event,
 * which the flow owns).
 *
 * `live` is the streaming turn only while the run streams — the partial
 * face that says "not measured yet" for facts still being earned, against
 * the settled face that says "not recorded" for facts nobody measured.
 */
export type RunTurnView = Readonly<{
  id: string;
  /** 1-based, over the conversation's model turns, oldest first. */
  index: number;
  /** True while this is the turn currently streaming. */
  live: boolean;
  /** True when the instruction this turn answered was steered into the run. */
  steered: boolean;
  /** First token of ANY kind (thinking or answer) — live-session only. */
  firstOutputMs?: number;
  /** First ANSWER word (the recorded `timingMetrics.ttftMs`). */
  firstWordMs?: number;
  /** Producing window: first token of any kind → finish — live-session only. */
  generationMs?: number;
  /** The rate, from the latency owner (live window first, recorded stamp next). */
  tokPerSec?: number;
  inputTokens?: number;
  outputTokens?: number;
  finishReason?: string;
  responseModel?: string;
  /** Why this turn never reported an answer (the reconcile's verdict). */
  incompleteReason?: string;
}>;

/**
 * The turns projection. Subscribes the COARSE timing signal
 * (`turnTimingVersion` — first token landed, answer began, window closed;
 * at most a few fires per turn) and never the per-arrival one, so a
 * streaming turn costs this projection a handful of re-derivations, not
 * one per token — the same two-signal split the rail hosts use.
 */
export const runTurns: ReadableAtom<readonly RunTurnView[]> = computed(
  [messages, isStreaming, turnTimingVersion],
  (list, streaming) => {
    // The in-flight turn is the newest assistant row while the run streams.
    let lastAssistantId: string | null = null;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i]!.role === "assistant") {
        lastAssistantId = list[i]!.id;
        break;
      }
    }
    const out: RunTurnView[] = [];
    let index = 0;
    let steeredPending = false;
    for (const msg of list) {
      if (msg.role === "user") {
        // A steered send queues for the next turn; a fresh send starts a run
        // whose turns answer it directly. Either way the NEXT assistant turn
        // is the one this message belongs to.
        steeredPending = msg.steered === true;
        continue;
      }
      if (msg.role !== "assistant") continue;
      index += 1;
      const timing = turnTimingFor(msg.id);
      const recorded = msg.timingMetrics;
      const latency = turnLatency({
        ...(msg.reasoning !== undefined ? { reasoning: msg.reasoning } : {}),
        ...(timing?.firstOutputMs !== undefined ? { firstOutputMs: timing.firstOutputMs } : {}),
        ...(recorded?.ttftMs !== undefined ? { firstWordMs: recorded.ttftMs } : {}),
        ...(timing?.generationMs !== undefined ? { generationMs: timing.generationMs } : {}),
        ...(msg.tokenMetrics !== undefined ? { outputTokens: msg.tokenMetrics.outputTokens } : {}),
        ...(recorded?.tps !== undefined ? { tokPerSec: recorded.tps } : {}),
      });
      out.push({
        id: msg.id,
        index,
        live: streaming && msg.id === lastAssistantId,
        steered: steeredPending,
        ...(timing?.firstOutputMs !== undefined ? { firstOutputMs: timing.firstOutputMs } : {}),
        ...(recorded?.ttftMs !== undefined ? { firstWordMs: recorded.ttftMs } : {}),
        ...(timing?.generationMs !== undefined ? { generationMs: timing.generationMs } : {}),
        ...(latency.tokPerSec !== undefined ? { tokPerSec: latency.tokPerSec } : {}),
        ...(msg.tokenMetrics !== undefined
          ? { inputTokens: msg.tokenMetrics.inputTokens, outputTokens: msg.tokenMetrics.outputTokens }
          : {}),
        ...(msg.finishReason !== undefined ? { finishReason: msg.finishReason } : {}),
        ...(msg.responseModel !== undefined ? { responseModel: msg.responseModel } : {}),
        ...(msg.incompleteReason !== undefined ? { incompleteReason: msg.incompleteReason } : {}),
      });
      steeredPending = false;
    }
    return out;
  },
);

// ── Calls (the per-call drilldown) ──────────────────────────────────────────

/**
 * One tool call's measured facts. The duration TERMS are carried raw —
 * `startedAt`, `endedAt`, `durationMs` — because the ONE duration owner
 * (`toolCallDurationMs`) needs the reader's clock for a running call's
 * live elapsed; the component calls it with its ticking `now`, the same
 * way the flow's tool beat does. Everything else is the call's own record:
 * the attempt count (retries on the same card, the flow's own idiom), the
 * REFUSAL mark (typed — a gate-refused or failed call, never a stranded
 * one), and the client-observed incompleteness of a call that never
 * reported a result.
 */
export type RunCallView = Readonly<{
  id: string;
  toolName: string;
  status: ToolCallStatus;
  startedAt: number;
  endedAt?: number;
  /** Measured server-side and persisted; absent when only the client saw it. */
  durationMs?: number;
  /** How many attempts this call has made in the current run. */
  attemptCount?: number;
  /** TRUE when the recorded result is a refusal record (the typed fact). */
  refused?: true;
  /** Why this call never reported a result — the stranded-call face. */
  incompleteReason?: string;
}>;

/** The calls projection: every tool call of the conversation, oldest first. */
export const runCalls: ReadableAtom<readonly RunCallView[]> = computed(
  messages,
  (list) => {
    const out: RunCallView[] = [];
    for (const msg of list) {
      if (msg.role !== "tool" || msg.toolCall === undefined) continue;
      const tc = msg.toolCall;
      out.push({
        id: msg.id,
        toolName: tc.name,
        status: tc.status,
        startedAt: tc.startedAt,
        ...(tc.endedAt !== undefined ? { endedAt: tc.endedAt } : {}),
        ...(tc.durationMs !== undefined ? { durationMs: tc.durationMs } : {}),
        ...(tc.attemptCount !== undefined ? { attemptCount: tc.attemptCount } : {}),
        ...(tc.refused !== undefined ? { refused: tc.refused } : {}),
        ...(tc.incompleteReason !== undefined ? { incompleteReason: tc.incompleteReason } : {}),
      });
    }
    return out;
  },
);

// ── Preparation (the chat-wide rollups) ─────────────────────────────────────

/** The dedup layer's folding, summed across the conversation's turns.
 * `savedPct` is the saved share of the ORIGINAL chars as a fraction — the
 * rollup's own honest percentage, derived from the sums (a per-turn
 * percentage cannot be summed). Null when no turn folded anything. */
export type DedupRollupView = Readonly<{
  framesApplied: number;
  charsBefore: number;
  charsAfter: number;
  charsSaved: number;
  savedPct: number;
  blocksRemoved: number;
}>;

/** The redaction choke point's masking, summed across the conversation's
 * turns. `maskedUpstream` is reported beside the count, never inside it —
 * this pass cannot know why those spans were masked. `byTier` sums the
 * privacy registry's own tier ids. Null when no turn masked anything. */
export type RedactionRollupView = Readonly<{
  maskedCount: number;
  proven: number;
  format: number;
  inferred: number;
  maskedUpstream: number;
  byTier: Readonly<Record<string, number>>;
}>;

/**
 * The input-preparation rollups. The per-turn footers in the flow read each
 * turn's own record; THIS derivation aggregates the SAME records once, so
 * the aggregate and the per-turn faces can never disagree about what was
 * folded or masked. Absence is the honest nothing in both directions: no
 * turn with an applied summary → `dedup: null`; no turn with a notice →
 * `redaction: null` — the server emits neither event when there was
 * nothing to report, and a zero would measure nothing.
 */
export const inputPreparation: ReadableAtom<
  Readonly<{ dedup: DedupRollupView | null; redaction: RedactionRollupView | null }>
> = computed(messages, (list) => {
  let framesApplied = 0;
  let charsBefore = 0;
  let charsAfter = 0;
  let blocksRemoved = 0;
  let anyDedup = false;
  let maskedCount = 0;
  let proven = 0;
  let format = 0;
  let inferred = 0;
  let maskedUpstream = 0;
  const byTier: Record<string, number> = {};
  let anyRedaction = false;
  for (const msg of list) {
    if (msg.role !== "assistant") continue;
    const d = msg.dedupSummary;
    if (d !== undefined && d.applied) {
      anyDedup = true;
      framesApplied += 1;
      charsBefore += d.originalChars;
      charsAfter += d.dedupedChars;
      blocksRemoved += d.removedBlocks;
    }
    const r = msg.redactionNotice;
    if (r !== undefined) {
      anyRedaction = true;
      maskedCount += r.maskedCount;
      proven += r.proven;
      format += r.format;
      inferred += r.inferred;
      maskedUpstream += r.maskedUpstream;
      for (const [tier, n] of Object.entries(r.byTier)) {
        byTier[tier] = (byTier[tier] ?? 0) + n;
      }
    }
  }
  const charsSaved = charsBefore - charsAfter;
  return {
    dedup: !anyDedup
      ? null
      : {
          framesApplied,
          charsBefore,
          charsAfter,
          charsSaved,
          savedPct: charsBefore > 0 ? charsSaved / charsBefore : 0,
          blocksRemoved,
        },
    redaction: !anyRedaction
      ? null
      : { maskedCount, proven, format, inferred, maskedUpstream, byTier },
  };
});

// ── Codebase ──

/** The repository map summary, as the `code.map` block answers it. */
export type CodebaseMapView = Readonly<{
  fileCount: number;
  moduleCount: number;
  symbolCount: number;
  totalLines: number;
  languages: readonly Readonly<{ extension: string; fileCount: number }>[];
}>;

export type CodebaseMapLoad =
  | Readonly<{ kind: "pending" }>
  /** The server is still reading the code (the router's 202 contract:
   * `{ status: "indexing", message }` — the pane renders the grammar's
   * pending with the server's own sentence). */
  | Readonly<{ kind: "indexing"; reason: string }>
  | Readonly<{ kind: "measured"; map: CodebaseMapView }>
  | Readonly<{ kind: "refused"; reason: string }>
  | Readonly<{ kind: "absent"; reason: string }>;

/** The map read's state. One atom — the pane shows the open project only,
 * so a per-project cache would buy nothing. The path it was fetched FOR is
 * carried so a late answer for a project the user has since left is never
 * shown as the current project's codebase (staleness by data, not timing —
 * the same rule state/git.ts documents). */
export const codebaseMapLoad = atom<Readonly<{ path: string; load: CodebaseMapLoad }> | null>(null);

/** The router's 202 "indexing" body (router.ts owns the contract: the block
 * read resolves with `{ status: "indexing", message }` as its data). Returns
 * the server's sentence when the payload is that shape, else null. */
function indexingReason(wire: unknown): string | null {
  if (wire === null || typeof wire !== "object") return null;
  const body = wire as Record<string, unknown>;
  if (body["status"] !== "indexing") return null;
  const message = body["message"];
  return typeof message === "string" && message.length > 0 ? message : "still reading this project's code";
}

/** Narrow the block's unknown payload into the section's shape. Returns
 * null when the shape is unreadable — the caller renders absence, never a
 * zero. */
export function decodeCodebaseMap(wire: unknown): CodebaseMapView | null {
  if (wire === null || typeof wire !== "object") return null;
  const summary = (wire as Record<string, unknown>)["summary"];
  if (summary === null || typeof summary !== "object") return null;
  const s = summary as Record<string, unknown>;
  if (
    typeof s["fileCount"] !== "number" ||
    typeof s["moduleCount"] !== "number" ||
    typeof s["symbolCount"] !== "number" ||
    typeof s["totalLines"] !== "number" ||
    !Array.isArray(s["languages"])
  ) {
    return null;
  }
  const languages: { extension: string; fileCount: number }[] = [];
  for (const lang of s["languages"] as unknown[]) {
    if (lang === null || typeof lang !== "object") return null;
    const l = lang as Record<string, unknown>;
    if (typeof l["extension"] !== "string" || typeof l["fileCount"] !== "number") return null;
    languages.push({ extension: l["extension"], fileCount: l["fileCount"] });
  }
  return {
    fileCount: s["fileCount"],
    moduleCount: s["moduleCount"],
    symbolCount: s["symbolCount"],
    totalLines: s["totalLines"],
    languages,
  };
}

/** The map reader, injectable for tests (the custody-feed pattern). */
export type CodebaseMapReader = (path: string) => Promise<unknown>;

// The read goes through the Broker like every cockpit surface. NOTE: while
// the server is still indexing, the router answers the block with its 202
// contract body (`{ status: "indexing", message }`) WITHOUT the block
// envelope — so the Broker's `read()` resolves with `undefined` (the
// envelope's absent `data` field). The indexing contract is detected at the
// FETCH layer below, where the raw body is still intact.
const liveReader: CodebaseMapReader = async (path) => {
  // fetchJson on the block's own read path: same route, same CSRF choke
  // point, but the raw body — so the 202 indexing answer (no envelope) is
  // distinguishable from a measured one (envelope: `{ data, meta }`). The
  // pane's own idempotence (a measured load stands) provides the caching
  // this read needs. A principled refusal never returns from this call: the
  // fetch door reconstructs the typed error itself, so it surfaces as the
  // pane's REFUSED state below — swallowing it would trade the honest
  // refusal for the generic unreadable-shape line.
  const body = await fetchJson<unknown>(blockRequestPath("code.map", { path }));
  // Unwrap the block envelope when it is one; pass the 202 contract through
  // as-is (its `status: "indexing"` is read by `indexingReason`).
  if (body !== null && typeof body === "object" && "data" in (body as Record<string, unknown>)) {
    return (body as { data: unknown }).data;
  }
  return body;
};

let mapReader: CodebaseMapReader = liveReader;

/** Test seam. Returns the previous reader so a test can restore it
 * (pass it BACK: `setCodebaseMapReader(prev)` — the seam returns the
 * previous READER, not a thunk). */
export function setCodebaseMapReader(next: CodebaseMapReader): CodebaseMapReader {
  const prev = mapReader;
  mapReader = next;
  return prev;
}

/**
 * Load the repository map for a project path. Idempotent per path: a
 * measured load for the same path is left standing (the Broker's TTL +
 * `index:ready` invalidation govern freshness underneath); a failed load
 * retries on the next call (reopening the pane is the honest retry).
 */
export async function requestCodebaseMap(path: string, force = false): Promise<void> {
  const current = codebaseMapLoad.get();
  // A measured load stands (the Broker's TTL + `index:ready` invalidation
  // govern freshness underneath). An INDEXING load does NOT suppress the
  // re-ask — the pane polls it on its own interval until the server is
  // done reading; `force` is what lets the poll past the Broker's cache.
  if (
    !force &&
    current !== null &&
    current.path === path &&
    current.load.kind === "measured"
  ) {
    return;
  }
  codebaseMapLoad.set({ path, load: { kind: "pending" } });
  try {
    const wire = await mapReader(path);
    // A late answer for a project the user has since left must not paint
    // over the current project's (pending) state.
    if (codebaseMapLoad.get()?.path !== path) return;
    // The 202 "indexing" answer is a real state, not an unreadable shape:
    // the server is reading the code right now and said so in its own words.
    const indexing = indexingReason(wire);
    if (indexing !== null) {
      codebaseMapLoad.set({ path, load: { kind: "indexing", reason: indexing } });
      return;
    }
    const map = decodeCodebaseMap(wire);
    codebaseMapLoad.set({
      path,
      load: map === null
        ? { kind: "absent", reason: UNREADABLE_SHAPE }
        : { kind: "measured", map },
    });
  } catch (err) {
    if (codebaseMapLoad.get()?.path !== path) return;
    const refusal = refusalReason(err);
    codebaseMapLoad.set({
      path,
      load: refusal !== null
        ? { kind: "refused", reason: refusal }
        : { kind: "absent", reason: absenceReason(err) },
    });
  }
}

/** Reset to the unfetched state (logout — a different user must never see
 * the previous user's codebase reading). NOT registered for context-reset:
 * the load is keyed by project path (see the module header), and the
 * projection (codebaseView) already reads a wrong-path load as pending. */
export function resetCodebaseMapLoad(): void {
  codebaseMapLoad.set(null);
}

registerReset("codebaseMap", resetCodebaseMapLoad);

/**
 * The codebase projection the pane renders: joins the map load with the
 * CURRENT project's path (a load for a different path reads as pending) and
 * with the shared git store (which is itself keyed by the path it was
 * fetched for — state/git.ts owns that guard; a snapshot fetched for a
 * previous project reads as "not checked yet", not as this project's tree).
 */
export const codebaseView: ReadableAtom<
  Readonly<{
    map: CodebaseMapLoad;
    git: GitStatusView | null;
    /** The typed refusal a git read for the CURRENT project answered with
     * (its own sentence — a different fact from "not checked yet"), or null
     * when none is standing for this path. */
    gitRefusal: Readonly<{ path: string; reason: string }> | null;
    projectPath: string | null;
  }>
> = computed(
  [codebaseMapLoad, currentProject, gitStatus, gitRefusal],
  (load, project, git, refusal) => {
    const projectPath = project?.path ?? null;
    const map: CodebaseMapLoad =
      projectPath === null
        ? { kind: "absent", reason: "no project open" }
        : load === null || load.path !== projectPath
          ? { kind: "pending" }
          : load.load;
    const gitView = git !== null && projectPath !== null && git.path === projectPath ? git : null;
    const refusalView =
      refusal !== null && projectPath !== null && refusal.path === projectPath ? refusal : null;
    return { map, git: gitView, gitRefusal: refusalView, projectPath };
  },
);

// ── The record's map: the runs of this chat ─────────────────────────────────

/** One run of the streamed window, as the record map's row. Every figure is
 * the causal band's own (causal.ts groups, the projection's `isError`
 * counts); nothing here re-spells either owner. */
export type RunRecordRunView = Readonly<{
  /** The runId, or null for the window's unattributed events — the honest
   * "not part of a run" row, never hidden. */
  runId: string | null;
  /** First → last event of the run, epoch ms (the band's own t0/t1). */
  t0: number;
  t1: number;
  eventCount: number;
  errorCount: number;
  /** True while this run is the live run of the open chat. */
  live: boolean;
  /** True when this run's opening record is not in view — the window-local
   * detection's own truth. A run OPENS with its `run` event (the lifecycle
   * vocabulary's own word), so a band whose earliest in-window event is any
   * other type did not begin here; WHY the opening record is absent (paged
   * out of the streamed window's newest page, streamed before this window
   * opened, or dropped by the projection as unparseable) the detection
   * cannot distinguish, and the row says only what it saw. Every figure
   * above is then a figure about the SLICE in view, not the run's whole
   * record, and the row must say so — a tail slice presented as
   * "17:35:52–17:35:53 · 38 events" would claim a 719ms run where a 33.8s
   * one is recorded. Never true for the unattributed band — it is not a
   * run, so it has no opening event to miss. */
  partial: boolean;
}>;

/**
 * THE RUN LIST — every run the sweep's streamed window holds, oldest first.
 * The derivation is `buildCausalBands` over `sweepWindowEvents` — the same
 * BANDING owner the band's a11y outline derives its runs from, but over a
 * different input set: this list reads the streamed window while the
 * outline reads the spectrum-measured coverage the server binned, which
 * settles a moment behind the stream. The two agree at rest; during
 * settling they may differ transiently (measured live: the outline's
 * coverage held 174 events while the streamed window held 200), and each
 * names the set it read. The live marking joins the band's runId against
 * the run view's own id while the run is active.
 */
export const runRecordRuns: ReadableAtom<readonly RunRecordRunView[]> = computed(
  [sweepWindowEvents, currentRun, isRunActive],
  (events, run, active) =>
    buildCausalBands(events).map((band) => {
      const first = band.turns[0]?.ticks[0];
      return {
        runId: band.runId,
        t0: band.t0,
        t1: band.t1,
        eventCount: band.eventCount,
        errorCount: band.turns.reduce(
          (n, turn) => n + turn.ticks.filter((tick) => tick.isError).length,
          0,
        ),
        live: active && run !== null && band.runId === run.runId,
        partial:
          band.runId !== null &&
          first !== undefined &&
          first.eventType !== "run",
      };
    }),
);

// ── The record's contents: the diagnostic roll-up ──────────────────────────

/**
 * THE RECORD'S CONTENTS — the same two-number résumé the band's own view
 * reads ({ events, errors }), counted here over the streamed window's own
 * events. The error count sums the `isError` each event already carries
 * (the projection applied the counting-policy owner's predicate); the
 * figure names the window it was counted over, and the section says so.
 */
export const runRecordContents: ReadableAtom<
  Readonly<{ events: number; errors: number }>
> = computed(sweepWindowEvents, (events) => ({
  events: events.length,
  errors: events.reduce((n, e) => n + (e.isError ? 1 : 0), 0),
}));

/**
 * The distinct error codes the window's failures carry, with counts — the
 * diagnostic roll-up's "by error code" face. A failure with no typed code
 * is counted under its own honest key (the outcome word), never invented.
 */
export const runRecordErrorCodes: ReadableAtom<
  readonly Readonly<{ code: string; count: number }>[]
> = computed(sweepWindowEvents, (events) => {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (!e.isError) continue;
    const key = e.errorCode ?? e.outcome ?? "failed";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([code, count]) => Object.freeze({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
});

// ── The run-scoped event ledger ─────────────────────────────────────────────

/** One ledger row, narrowed from the wire's summary. */
export type RunLedgerRow = Readonly<{
  eventId: string;
  eventType: string;
  /** The sweep's category for the event type (the one mapping owner). */
  category: SweepCategoryId;
  wallTime: string;
  /** Epoch ms parsed once here, for the row's clock; null when the record's
   * wall time does not parse (the row still renders, unstamped — an
   * unparseable time is a fact about the row, not a reason to drop it). */
  timeMs: number | null;
  outcome: string | null;
  errorCode: string | null;
  runId: string | null;
  turnId: string | null;
  description: string;
}>;

export type RunLedgerLoad =
  | Readonly<{ kind: "pending" }>
  | Readonly<{
      kind: "measured";
      rows: readonly RunLedgerRow[];
      /** The server's count of ALL events matching the scope — the honest
       * denominator the truncation sentence names beside the rows shown. */
      total: number;
      hasMore: boolean;
      /** The keyset cursor the next page resumes from, or null at the end. */
      nextCursor: string | null;
      /** Why the LAST page load failed, when it did — stated beside the
       * load-more verb, never swallowed (the standing rows stay: they are
       * still the last true answer to the question). */
      moreError: string | null;
    }>
  | Readonly<{ kind: "refused"; reason: string }>
  | Readonly<{ kind: "absent"; reason: string }>;

/**
 * The ledger's standing load, keyed by the QUESTION it answers: the chat,
 * and the head the read was bounded by (null = live). A read under a
 * different head is a different question and re-fetches, exactly the way
 * the Broker's `until` rides the block cache key — a past answer can never
 * stand in for a live one or the other way round.
 */
export const runLedgerLoad = atom<
  Readonly<{ key: string; chatId: string | null; head: number | null; load: RunLedgerLoad }> | null
>(null);

/** The ledger's key: one question per chat + head pair. */
function runLedgerKey(chatId: string, head: number | null): string {
  return `${chatId}\u0000${head === null ? "live" : String(head)}`;
}

/** Narrow the wire's page into the section's rows. Returns null when the
 * payload's shape is unreadable — the caller renders absence, never a
 * partial page pretending to be one. */
export function decodeRunLedgerPage(
  wire: unknown,
): Readonly<{ rows: readonly RunLedgerRow[]; total: number; hasMore: boolean; nextCursor: string | null }> | null {
  if (wire === null || typeof wire !== "object") return null;
  const w = wire as Record<string, unknown>;
  if (!Array.isArray(w["events"]) || typeof w["total"] !== "number" || typeof w["hasMore"] !== "boolean") {
    return null;
  }
  const rows: RunLedgerRow[] = [];
  for (const raw of w["events"] as unknown[]) {
    if (raw === null || typeof raw !== "object") return null;
    const e = raw as Record<string, unknown>;
    if (
      typeof e["eventId"] !== "string" ||
      typeof e["eventType"] !== "string" ||
      typeof e["wallTime"] !== "string" ||
      typeof e["description"] !== "string"
    ) {
      return null;
    }
    const timeMs = Date.parse(e["wallTime"]);
    rows.push({
      eventId: e["eventId"],
      eventType: e["eventType"],
      category: sweepCategoryFor(e["eventType"]),
      wallTime: e["wallTime"],
      timeMs: Number.isFinite(timeMs) ? timeMs : null,
      outcome: typeof e["outcome"] === "string" ? e["outcome"] : null,
      errorCode: typeof e["errorCode"] === "string" ? e["errorCode"] : null,
      runId: typeof e["runId"] === "string" ? e["runId"] : null,
      turnId: typeof e["turnId"] === "string" ? e["turnId"] : null,
      description: e["description"],
    });
  }
  return {
    rows,
    total: w["total"],
    hasMore: w["hasMore"],
    nextCursor: typeof w["nextCursor"] === "string" ? w["nextCursor"] : null,
  };
}

/**
 * Build the ledger's wire request for a chat under a head. THE PAST-VIEW
 * RESOLUTION, in one place: the timeline route is a route read, not a
 * block, so the asOf split is honored HERE at this read's own door — a
 * planted head bounds the query by `toWallTime` (the store's own inclusive
 * ranged-read bound, so an event at the head's instant still shows), and a
 * live read carries no bound. The answer can therefore never contain an
 * event the head excludes.
 */
export function runLedgerRequestBody(
  chatId: string,
  head: number | null,
): Record<string, unknown> {
  return {
    chatId,
    limit: TIMELINE_QUERY_LIMIT,
    // NEWEST FIRST, judged on the live drive: a chat with a long record
    // must open on the run the reader just watched, not on the oldest
    // page of setup noise — the cursor then walks back in time and the
    // truncation sentence still names both numbers (Sentry's stream and
    // Grafana's logs both read newest first for the same reason).
    ascending: false,
    ...(head !== null ? { toWallTime: new Date(head).toISOString() } : {}),
  };
}

/** The ledger reader, injectable for tests. */
export type RunLedgerReader = (
  body: Record<string, unknown>,
) => Promise<unknown>;

const liveLedgerReader: RunLedgerReader = (body) =>
  fetchJson<TimelineEventSummariesResult>("/timeline/query", {
    method: "POST",
    body: JSON.stringify(body),
  });

let ledgerReader: RunLedgerReader = liveLedgerReader;

/** Test seam. Returns the previous reader so a test can restore it. */
export function setRunLedgerReader(next: RunLedgerReader): RunLedgerReader {
  const prev = ledgerReader;
  ledgerReader = next;
  return prev;
}

/**
 * Read the chat's ledger under the ambient head. Idempotent per question: a
 * measured load for the same chat + head stands unless `force` re-asks (the
 * run's settle). A late answer for a chat or head the reader has since left
 * is dropped, never painted.
 */
export async function requestRunLedger(force = false): Promise<void> {
  const chatId = currentChatId.get();
  if (chatId === null) {
    runLedgerLoad.set({ key: runLedgerKey("\u0000none", null), chatId: null, head: null, load: { kind: "absent", reason: "no conversation open" } });
    return;
  }
  const head = asOfHead.get();
  const key = runLedgerKey(chatId, head);
  const current = runLedgerLoad.get();
  if (
    !force &&
    current !== null &&
    current.key === key &&
    (current.load.kind === "measured" || current.load.kind === "pending")
  ) {
    // A measured answer stands, and a PENDING ask already in flight for the
    // same question is itself the answer being fetched — the section's open
    // and its mount effect both ask, and one wire read is enough.
    return;
  }
  runLedgerLoad.set({ key, chatId, head, load: { kind: "pending" } });
  try {
    const wire = await ledgerReader(runLedgerRequestBody(chatId, head));
    if (runLedgerLoad.get()?.key !== key) return;
    const page = decodeRunLedgerPage(wire);
    runLedgerLoad.set({
      key,
      chatId,
      head,
      load:
        page === null
          ? { kind: "absent", reason: UNREADABLE_SHAPE }
           : {
              kind: "measured",
              rows: page.rows,
              total: page.total,
              hasMore: page.hasMore,
              nextCursor: page.nextCursor,
              moreError: null,
            },
    });
  } catch (err) {
    if (runLedgerLoad.get()?.key !== key) return;
    const refusal = refusalReason(err);
    runLedgerLoad.set({
      key,
      chatId,
      head,
      load: refusal !== null
        ? { kind: "refused", reason: refusal }
        : { kind: "absent", reason: absenceReason(err) },
    });
  }
}

/**
 * Load the ledger's NEXT page, appending to the standing rows. The cursor is
 * only meaningful against the question it came from, so a load that was
 * superseded (a different chat or head answered meanwhile) is refused
 * rather than splicing one question's rows into another's page.
 */
export async function loadMoreRunLedger(): Promise<void> {
  const current = runLedgerLoad.get();
  if (current === null || current.load.kind !== "measured" || current.load.nextCursor === null) {
    return;
  }
  const { key, chatId, head } = current;
  const cursor = current.load.nextCursor;
  try {
    const wire = await ledgerReader({
      ...runLedgerRequestBody(chatId!, head),
      cursor,
    });
    if (runLedgerLoad.get()?.key !== key) return;
    const page = decodeRunLedgerPage(wire);
    if (page === null) return;
    const standing = runLedgerLoad.get();
    if (standing === null || standing.key !== key || standing.load.kind !== "measured") return;
    const seen = new Set(standing.load.rows.map((r) => r.eventId));
    const added = page.rows.filter((r) => !seen.has(r.eventId));
    runLedgerLoad.set({
      key,
      chatId,
      head,
      load: {
        kind: "measured",
        rows: added.length === 0 ? standing.load.rows : [...standing.load.rows, ...added],
        total: page.total,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
        moreError: null,
      },
    });
  } catch (err) {
    // A failed page load never blanks the standing rows — they are still
    // the last true answer to the question being asked — but the failure is
    // STATED beside the verb that hit it, never swallowed.
    const standing = runLedgerLoad.get();
    if (standing === null || standing.key !== key || standing.load.kind !== "measured") return;
    runLedgerLoad.set({
      key,
      chatId,
      head,
      load: {
        ...standing.load,
        moreError: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

/** Reset to the unfetched state (logout / context reset). */
export function resetRunLedgerLoad(): void {
  runLedgerLoad.set(null);
}

registerReset("runLedger", resetRunLedgerLoad);

// ── The ledger's filters (local to the mount, unpersisted) ──────────────────

/** The category chip: "all", or one sweep category. */
export const runLedgerCategoryFilter = atom<"all" | SweepCategoryId>("all");

/** The outcome chip. The three words are the counting vocabulary's own:
 * `failed` is the counting-policy owner's predicate (failed or error
 * coded), `denied` is the record's own outcome word, `ok` is the rest —
 * never a fabricated zero. */
export const runLedgerOutcomeFilter = atom<"all" | "failed" | "denied" | "ok">("all");

/** Does a row match the outcome chip's word? The failure predicate is
 * DELEGATED to the counting-policy owner (`isErrorEvent`) over the row's
 * own recorded columns — the same single spelling the spectrum and the
 * error counts read, never a second one here. */
function outcomeMatches(row: RunLedgerRow, want: "all" | "failed" | "denied" | "ok"): boolean {
  if (want === "all") return true;
  const failed = isErrorEvent({ outcome: row.outcome, errorCode: row.errorCode });
  if (want === "failed") return failed;
  if (want === "denied") return !failed && row.outcome === "denied";
  return !failed && row.outcome !== "denied";
}

/**
 * The rows the section shows: the standing page narrowed by the chips. The
 * chips narrow what is SHOWN; the truncation sentence still names the
 * server's total for the scope, so a filtered view never silently becomes
 * "everything".
 */
export const runLedgerRows: ReadableAtom<
  Readonly<{
    load: RunLedgerLoad;
    chatId: string | null;
    head: number | null;
    rows: readonly RunLedgerRow[];
  }>
> = computed(
  [runLedgerLoad, runLedgerCategoryFilter, runLedgerOutcomeFilter, currentChatId],
  (standing, category, outcome, chatId) => {
    if (standing === null || standing.chatId !== chatId) {
      // No standing load, or one answering a DIFFERENT chat's question
      // (the map load's same staleness-by-data rule: a load the current
      // chat did not ask for reads as pending, never as this chat's rows).
      return { load: { kind: "pending" } as RunLedgerLoad, chatId, head: null, rows: [] };
    }
    const rows =
      standing.load.kind !== "measured"
        ? []
        : standing.load.rows.filter(
            (r) =>
              (category === "all" || r.category === category) && outcomeMatches(r, outcome),
          );
    return { load: standing.load, chatId: standing.chatId, head: standing.head, rows };
  },
);

/**
 * The event id → transcript message id map: the ledger row's reveal address.
 * A message that IS a recorded event carries the ledger's own event id
 * (`timelineEventId`), and the flow resolves a bare message id to its beat
 * (beat-request's contract), so this is the whole mapping — no second
 * derivation of "which beat is which event".
 */
export const runLedgerBeatIds: ReadableAtom<ReadonlyMap<string, string>> = computed(
  messages,
  (list) => {
    const out = new Map<string, string>();
    for (const msg of list) {
      if (msg.timelineEventId !== undefined) out.set(msg.timelineEventId, msg.id);
    }
    return out;
  },
);

// ── The act trail ────────────────────────────────────────────────────────────

/** One recorded operator intervention, joined with its declared words. */
export type RunActView = Readonly<{
  key: string;
  block: string;
  action: string;
  /** The DECLARED title, verbatim from the served manifest; absent when the
   *  manifest has not loaded or names no such action. */
  title?: string;
  /** The DECLARED consequence sentence, verbatim; absent for the same
   *  reasons, and never substituted. */
  consequence?: string;
  state: "done" | "failed";
  latencyMs: number;
  input?: unknown;
  errorCode?: string;
  /** When the act settled, epoch ms. */
  at: number;
}>;

/**
 * THE ACT TRAIL — the operator interventions the Broker's write door
 * recorded (the same log the flow mints its act beats from), oldest first
 * (the order you performed them). The declared words come from the ONE
 * join (ingest's `declaredWords`), so the trail and the flow's act beats
 * can never disagree about what a control does. The log is the browser
 * session's own bounded record — the section says so, rather than claiming
 * a per-run attribution the record does not carry.
 */
export const runActs: ReadableAtom<readonly RunActView[]> = computed(
  [performedActions, uiSchema],
  (log) =>
    log.filter(record => record.origin === "operator").map((record) => {
      const words = declaredWords(record.block, record.action);
      return Object.freeze({
        key: record.key,
        block: record.block,
        action: record.action,
        ...(words !== undefined ? { title: words.title, consequence: words.consequence } : {}),
        state: record.state,
        latencyMs: record.latencyMs,
        ...(record.input !== undefined ? { input: record.input } : {}),
        ...(record.errorCode !== undefined ? { errorCode: record.errorCode } : {}),
        at: record.settledAt,
      });
    }),
);

/** Reset the ledger's filter chips (logout / context reset). */
export function resetRunLedgerFilters(): void {
  runLedgerCategoryFilter.set("all");
  runLedgerOutcomeFilter.set("all");
}

registerReset("runLedgerFilters", resetRunLedgerFilters);
