/**
 * DB row → client view mappers. The single owner of the snake_case →
 * camelCase boundary mapping. Routes call these to convert database
 * results before sending to the client.
 *
 * The client-side types live in `src/state/*.ts` (the client-side
 * authority); the DB row types live in `server/db/schema.ts` (the
 * server-side authority). This module is the contract between them.
 *
 * Anything not present in the client view (e.g. `config_overlay`) is
 * dropped intentionally — the client doesn't need it yet. When it does,
 * extend the client view type AND this mapper together.
 */

import { PUBLIC_MESSAGE_METADATA } from "../db/schema.ts";
import type {
  ProjectRow,
  ChatRow,
  MessageRow,
  ToolCallRow,
  MetricsSnapshotRow,
  AutoCheckRow,
  TimelineRefRow,
  ChatHistory,
  ChatHistoryPage,
  ChatMessagePage,
  HistoryPageFacts,
} from "../db/client.ts";
// SPO: the view mappers are the chat-history REST egress choke point —
// every DB row returned to the browser passes through them. PII is redacted
// HERE, at the lowest level, by reusing the single redaction owner
// (server/redaction.ts — NOT a rebuild). The LLM history rebuild
// (chat-history.ts) reads RAW DB rows directly (it does NOT use these
// mappers), so redacting here only affects the user-facing REST response —
// never the LLM-bound context. Secrets in message content, tool-call
// input/output, and metadata (response headers, reasoning, context) are
// masked; variable/const/env names + structure are preserved.
import { redactContent, redactStringValues, redactToolCallArguments } from "../llm/redaction.ts";
// The presence of a project's folder is measured by the filesystem access
// owner (fs-gate.ts) — never re-derived here, never remembered.
import { projectFolderPresence, type ProjectFolderPresence } from "../filesystem/fs-gate.ts";

// SPO: the pure wire view types `MessageView` + `MetricsSnapshotView`
// are owned by `shared/wire-types.ts` (single wire-shape owner, imported
// by both server + client — no drift). Re-exported here so existing
// `import { type MessageView } from "./views.ts"` paths are unchanged.
// `ChatHistoryView` stays server-local (it composes server-local view
// types: ChatSummaryView / ToolCallRowView / TimelineRefView).
import type { MessageView, MetricsSnapshotView, HistoryPageView } from "../../shared/wire-types.ts";
export type { MessageView, MetricsSnapshotView, HistoryPageView };

// ── Client-facing view types (mirrored in src/state/*.ts) ──

export type ProjectView = Readonly<{
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * Whether the project's folder is on the server's disk right now,
   * measured when the view was built (fs-gate.ts owns the probe). A
   * project whose folder was wiped is a real state with a way out (relink),
   * not a guess the client has to make from a failed tool call.
   */
  readonly folder: ProjectFolderPresence;
  readonly git?: Readonly<{ branch: string | null; dirtyFiles: number; head: string | null }> | null;
}>;

export type ChatSummaryView = Readonly<{
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly modelId: string | null;
  readonly pinned: boolean;
}>;

export type ToolCallRowView = Readonly<{
  readonly id: string;
  readonly messageId: string;
  /**
   * The provider's stable callId — the identity the client's LIVE tool
   * cards carry from `tool_call_start`. The run-end read-back joins on it
   * to heal a card whose result frame never reached the client (the feed
   * evicted it, or the connection dropped). NULL on rows recorded before
   * the column existed: those cards predate the heal and keep the honest
   * placeholder.
   */
  readonly callId: string | null;
  readonly toolName: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly status: "running" | "done" | "error";
  readonly durationMs: number | null;
  /** How many times this tool was attempted in its run (1 = first; N =
   * Nth retry). Persisted so the "attempt N" badge survives a page
   * refresh. Always present after migration v11. */
  readonly attemptCount: number;
  readonly createdAt: string;
}>;

// `MetricsSnapshotView` is owned by `shared/wire-types.ts` (imported above).

export type AutoCheckView = Readonly<{
  readonly id: string;
  readonly projectId: string | null;
  readonly chatId: string | null;
  readonly checkName: string;
  readonly status: "running" | "passed" | "failed" | "warning";
  readonly output: unknown;
  readonly createdAt: string;
}>;

export type TimelineRefView = Readonly<{
  readonly id: string;
  readonly chatId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly timestamp: string;
  readonly metadata: unknown;
}>;

export type ChatHistoryView = Readonly<{
  readonly chat: ChatSummaryView;
  readonly messages: readonly MessageView[];
  readonly toolCalls: readonly ToolCallRowView[];
  readonly metricsSnapshots: readonly MetricsSnapshotView[];
  readonly timelineRefs: readonly TimelineRefView[];
}>;

// contract-drift-guard: ChatHistoryPageView
/** The conversation at its TAIL: the newest page plus the way further back. */
export type ChatHistoryPageView = ChatHistoryView & Readonly<{ readonly page: HistoryPageView }>;

// contract-drift-guard: ChatMessagePageView
/** One page of OLDER messages — a delta. It carries no metrics snapshots and
 * no timeline refs because it has nothing true to say about them. */
export type ChatMessagePageView = Readonly<{
  readonly chatId: string;
  readonly messages: readonly MessageView[];
  readonly toolCalls: readonly ToolCallRowView[];
  readonly page: HistoryPageView;
}>;

// ── Mappers ──

export function projectToView(row: ProjectRow): ProjectView {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    folder: projectFolderPresence(row.path),
  };
}

export function projectToViewWithGit(
  row: ProjectRow,
  git: Readonly<{ branch: string | null; dirtyFiles: number; head: string | null }> | null,
): ProjectView {
  return { ...projectToView(row), git };
}

export function chatToView(row: ChatRow): ChatSummaryView {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    modelId: row.model_id,
    pinned: (row.pinned ?? 0) !== 0,
  };
}

/**
 * `discarded` is passed in rather than looked up here because the fold is one
 * ledger read for a whole page, not one per row: a 200-message page would
 * otherwise take 200 identical scans of the same events. The routes read it
 * once and hand the set down.
 */
export function messageToView(
  row: MessageRow,
  discarded: ReadonlySet<string> = EMPTY_DISCARDED,
): MessageView {
  return {
    ...(discarded.has(row.id) ? { discarded: true } : {}),
    id: row.id,
    chatId: row.chat_id,
    role: row.role,
    // SPO: redact secrets in the message content before it reaches the
    // browser. The variable/const/env name is preserved (e.g.
    // `const API_KEY = "sk-..."` → `const API_KEY = "[REDACTED:credential]"`)
    // so the user still understands the code context while the secret
    // value never renders.
    content: redactContent(row.content),
    createdAt: row.created_at,
    modelEventType: row.model_event_type,
    runId: row.run_id,
    // Positive public projection: opaque provider evidence and observation
    // bindings never cross the API boundary.
    metadata: row.metadata === null ? null : redactStringValues(PUBLIC_MESSAGE_METADATA.parse(row.metadata)),
  };
}

export function toolCallToView(row: ToolCallRow): ToolCallRowView {
  return {
    id: row.id,
    messageId: row.message_id,
    callId: row.call_id,
    toolName: row.tool_name,
    // The LLM-generated arguments are a JSON STRING. Parse first (via
    // redactToolCallArguments) so JSON-escaped quotes (`\"`) don't break
    // credential detection — the same handling the LLM-bound path uses.
    // A non-string input (object/null from older rows) falls back to the
    // recursive walker.
    input: typeof row.input === "string" ? redactToolCallArguments(row.input) : redactStringValues(row.input),
    // The tool execution output (file contents, search results, etc.) is
    // the highest-risk PII surface — read_file can return a user's
    // .env with secrets. Redact recursively; structure is preserved.
    output: redactStringValues(row.output),
    status: row.status,
    durationMs: row.duration_ms,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
  };
}

export function metricsSnapshotToView(row: MetricsSnapshotRow): MetricsSnapshotView {
  return {
    id: row.id,
    chatId: row.chat_id,
    // A custom metrics snapshot could carry a label or context string
    // with a secret (defense-in-depth — PII redaction applies to every
    // user-facing surface, not just the obvious ones). Redact recursively.
    snapshot: redactStringValues(row.snapshot),
    createdAt: row.created_at,
  };
}

export function autoCheckToView(row: AutoCheckRow): AutoCheckView {
  return {
    id: row.id,
    projectId: row.project_id,
    chatId: row.chat_id,
    checkName: row.check_name,
    status: row.status,
    // Auto-check output (lint/test results) can quote source lines that
    // contain secrets (e.g. a lint error pointing at `api_key = "sk-..."`).
    // Redact recursively so the check output never leaks a secret.
    output: redactStringValues(row.output),
    createdAt: row.created_at,
  };
}

export function timelineRefToView(row: TimelineRefRow): TimelineRefView {
  return {
    id: row.id,
    chatId: row.chat_id,
    eventId: row.event_id,
    eventType: row.event_type,
    timestamp: row.timestamp,
    // Timeline event metadata carries the event description (which can
    // quote a secret from a tool call or error). Redact recursively.
    metadata: redactStringValues(row.metadata),
  };
}

/** No rewind has withdrawn anything — the default for every caller that has
 * not read the fold. Frozen and shared so the default costs nothing. */
const EMPTY_DISCARDED: ReadonlySet<string> = new Set<string>();

/**
 * THE WITHDRAWN RUN'S TIMELINE REFS DO NOT REPLAY INTO THE LIVE VIEW.
 *
 * A rewind withdraws the message rows (flagged, never deleted) AND the
 * runs they belong to — the ledger record itself stays intact and stays
 * served everywhere the RECORD is the view (the timeline canvas, the
 * documents fold, the sweep). But the tail page's `timeline_refs` have a
 * second job: `hydrateChatFromHistory` replays them INLINE into the
 * transcript. A withdrawn run's refs replayed there re-create beats for a
 * region the reader just took back — orphaned error/steering events
 * lingering between the surviving reply and the replacement turn, with no
 * message row they belong to (UIE-013). So the inline-replay projection
 * filters by the RESTORE-AWARE withdrawn-run fold, exactly as the message
 * rows are filtered by the withdrawn-message fold.
 *
 * The ref's `metadata.runId` is server-written for run-recorded events.
 * It is deliberately NOT trusted for cross-user scoping (`runIdsForChat`
 * states why — the metadata is client-writable through the ref POST
 * route); here the only thing a forged runId can move is whether one of
 * the caller's OWN inline events replays, in the caller's own chat —
 * never whose data is served.
 */
function refBelongsToWithdrawnRun(
  row: TimelineRefRow,
  discardedRuns: ReadonlySet<string>,
): boolean {
  if (discardedRuns.size === 0) return false;
  const meta = row.metadata as Record<string, unknown> | null;
  const runId = meta?.["runId"];
  return typeof runId === "string" && discardedRuns.has(runId);
}

export function chatHistoryToView(
  history: ChatHistory,
  discarded: ReadonlySet<string> = EMPTY_DISCARDED,
  discardedRuns: ReadonlySet<string> = EMPTY_DISCARDED,
): ChatHistoryView {
  return {
    chat: chatToView(history.chat),
    messages: history.messages.map((m) => messageToView(m, discarded)),
    toolCalls: history.tool_calls.map(toolCallToView),
    metricsSnapshots: history.metrics_snapshots.map(metricsSnapshotToView),
    timelineRefs: history.timeline_refs
      .filter((r) => !refBelongsToWithdrawnRun(r, discardedRuns))
      .map(timelineRefToView),
  };
}

// ── The paged history views (DESIGN-PERFORMANCE §4) ──

/**
 * The page facts, wire-shaped. Copied field by field rather than spread, so
 * a field added to the DB-side shape has to be added HERE to reach the
 * browser — the same reason every other mapper in this file is explicit.
 */
export function historyPageToView(page: HistoryPageFacts): HistoryPageView {
  return {
    limit: page.limit,
    returned: page.returned,
    hasOlder: page.hasOlder,
    olderCursor: page.olderCursor,
    messageCount: page.messageCount,
    endedBy: page.endedBy,
  };
}

export function chatHistoryPageToView(
  page: ChatHistoryPage,
  discarded: ReadonlySet<string> = EMPTY_DISCARDED,
  discardedRuns: ReadonlySet<string> = EMPTY_DISCARDED,
): ChatHistoryPageView {
  return {
    ...chatHistoryToView(page, discarded, discardedRuns),
    page: historyPageToView(page.page),
  };
}

export function chatMessagePageToView(
  page: ChatMessagePage,
  discarded: ReadonlySet<string> = EMPTY_DISCARDED,
): ChatMessagePageView {
  return {
    chatId: page.chat_id,
    messages: page.messages.map((m) => messageToView(m, discarded)),
    toolCalls: page.tool_calls.map(toolCallToView),
    page: historyPageToView(page.page),
  };
}
