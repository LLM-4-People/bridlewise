/**
 * THE thin client module — the sole caller of fetch/EventSource in the
 * entire web slice. The sole writer to shared nanostores stores.
 *
 * Responsibilities:
 *   1. Wrap every backend call (REST + SSE) in a typed method.
 *   2. Validate inbound data with lightweight runtime sanity checks
 *      (full Zod validation happens server-side at the trust boundary).
 *   3. Manage SSE lifecycle: connect, reconnect (bounded), cancel, cleanup.
 *   4. Feed validated events into nanostores shared stores (sole writer).
 *   5. Attach correlation context (runId/turnId/agentId) to requests.
 *
 * What it does NOT do (per root-policy clientOwned...Allowed: false):
 *   - policy decisions, orchestration, durable storage, job state,
 *     command construction.
 *
 * Adding a new backend call: add a typed method here. Never call fetch
 * or EventSource from a component.
 */

import type {
  ModelEvent,
  TimelineEventRecord,
  TimelineEventSummariesResult,
  WebToolEntry,
  MetricsSnapshot,
  AgentState,
  UiControlAction,
} from "../shared/types";

import {
  setRun,
  updateRunStatus,
  upsertAgent,
  currentRun,
  isRunActive,
  setQueuedSteers,
  type RunView,
} from "./state/run-state";

import {
  setProjects,
  addProject,
  removeProject,
  renameProjectInStore,
  updateProjectInStore,
  selectProject,
  projects,
  currentProjectId,
  type ProjectSummary,
  type ProjectCreateInput,
} from "./state/projects";

import {
  addChat,
  selectChat,
  replaceChatsForProject,
  removeChatsForProject,
  updateChatInStore,
  removeChat,
  currentChatId,
  chatForId,
  projectChatsFor,
  chatsGeneration,
  type ChatSummary,
  type ChatCreateInput,
} from "./state/chats";

import {
  addAutoCheck,
  upsertAutoChecks,
  evictAutoChecksForOtherProjects,
  setAutoChecksScope,
  autoChecksProjectId,
  type AutoCheck,
  type AutoCheckCreateInput,
} from "./state/auto-checks";

import { setTools, setEnabledTools } from "./state/tools";
import { setMetrics, setSystemMetrics, setTokenThroughput, type SystemMetrics, type TokenThroughput } from "./state/metrics";
import {
  setQualitySnapshot,
  type QualityCategoryCount,
  type QualityComplexity,
  type QualityTypeLevel,
  type QualityCloneStats,
  type QualityMeasuredFlags,
} from "./state/quality";
import { setDedupSnapshot, type DedupSnapshot } from "./state/dedup";
import {
  setRedactionNotice,
  type RedactionNoticeSnapshot,
  type RedactionReason,
} from "./state/redaction";
import { setGitStatus, setGitRefusal, type GitStatusEntry } from "./state/git";
import { setExtensions, type ExtensionView } from "./state/extensions";
import { setFilter, ingestResults, appendResults, timelineFilter, timelineResults, type TimelineQueryRequest, type TimelineScope } from "./state/timeline-query";
import {
  setTimelineScope,
  timelineScope,
  GLOBAL_TIMELINE_SCOPE,
} from "./state/timeline-query";
import { TIMELINE_QUERY_LIMIT } from "../shared/constants";
import { gateBlockEventKind, type GateBlockKind } from "../shared/event-types";
import {
  setTimelineRefs,
  setCurrentTimelineChatId,
  type TimelineRef,
} from "./state/timeline-refs";
import { beginSchemaValuesRead, setUiSchema, setUiSchemaValues } from "./state/schema-store";
import type { UiSchema, UiSchemaValues } from "../shared/ui-schema";
// The browser's own observability — the run-feed measurement, the chat and
// trace latches, and the run-end ingest report all live in the one owner.
import {
  finishRunTelemetry,
  latchRunTrace,
  noteRunChat,
  noteRunFrameApplied,
} from "./state/telemetry";
import {
  API_IDENTITY_HEADER,
  GATEWAY_UNREACHED_STATUSES,
  LIVE_STREAM_PATH,
  LIVE_STREAM_REFUSED_RETRY_MS,
  SSE_EVENT_TYPES,
  isTerminalSseEventType,
} from "../shared/constants.ts";
import { resolveStatus } from "../shared/errors.ts";
import { fetchJson, fireInvalidation, onInvalidation } from "./data/broker.ts";
import { ClientError, ClientTimeoutError } from "./data/errors.ts";
import { absenceReason, refusalReason } from "./data/absence.ts";
import {
  noteChatHistoryPending,
  noteChatHistoryRead,
  noteChatHistoryUnread,
} from "./state/chat-history-load.ts";
import {
  historyReach,
  noteReachOpened,
  noteReachLoading,
  noteReachExtended,
  noteReachFailed,
} from "./state/chat-history-reach.ts";
import { setModels, selectModel, type ModelsCatalog } from "./state/models";
import { setMemoryEntries, type MemoryEntryView } from "./state/memory";
import { authState, initialAuth, type AuthStatus } from "./state/auth";
import { resetAllStores } from "./state/reset-all";
import {
  appendUserMessage,
  appendAssistantMessage,
  appendToolCall,
  appendErrorMessage as appendChatError,
  appendEventMessage,
  recordedMessageForEvent,
  classifyInlineEvent,
  updateLastAssistantMessage,
  acceptModelFrame,
  appendStreamingTail,
  commitStreamingTail,
  updateToolCallById,
  finalizeRunningToolCalls,
  healStrandedToolCallsFromLedger,
  settleHydratedRunningToolCalls,
  isUnansweredAssistantRow,
  applyReconciledAssistantRows,
  type ToolCallLedgerRow,
  setMessages,
  prependMessages,
  setStreaming,
  isStreaming,
  unmarkSteeredMessage,
  withdrawMessage,
  messages as messagesStore,
  type ChatMessage,
  type ToolCallView,
  type RunContext,
  type MessageMetadata,
} from "./state/chat-messages";
import {
  appendError,
} from "./state/errors";
import { applyUiControlAction } from "./state/ui-control";
import {
  DEFAULT_API_BASE,
  HYDRATED_TOOL_CALL_RECONCILE_MAX_MS,
  HYDRATED_TOOL_CALL_RECONCILE_POLL_MS,
} from "./client-config";
import { formatErrorMessage } from "./data/error-messages";
import { clientWarn } from "./client-debug";
import type { MessageView, MetricsSnapshotView, HistoryPageView, RecycledFile } from "../shared/wire-types";

// Re-export the project/chat/auto-check types so the public API stays on
// client.ts (components import types from here, not from state/).
export type { ProjectSummary, ProjectCreateInput } from "./state/projects";
export type { ChatSummary, ChatCreateInput } from "./state/chats";
export type {
  AutoCheck,
  AutoCheckCreateInput,
  AutoCheckStatus,
} from "./state/auto-checks";
export type { TimelineRef } from "./state/timeline-refs";
export type {
  ModelInfo,
  ProviderInfo,
  ModelsCatalog,
} from "./state/models";
export type { MemoryEntryView } from "./state/memory";
export type { AuthStatus } from "./state/auth";

// ── View types mirrored from server/routes/views.ts ──
// These are the API response shapes (camelCase). The server boundary
// converts DB rows to these. client.ts is the sole client-side owner
// of the wire shapes (single source of truth for fetch return types).

export type ToolCallViewRow = Readonly<{
  readonly id: string;
  readonly messageId: string;
  /** The provider's stable callId — the join key the run-end stranded-card
   *  heal uses (a live card's `toolCall.id` IS the callId). NULL on rows
   *  recorded before the server persisted it. */
  readonly callId: string | null;
  readonly toolName: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly status: "running" | "done" | "error";
  readonly durationMs: number | null;
  /** How many times this tool was attempted in its run (1 = first; N =
   *  Nth retry). Persisted so the "attempt N" badge survives a page
   *  refresh. */
  readonly attemptCount: number;
  readonly createdAt: string;
}>;

export type ChatHistoryView = Readonly<{
  readonly chat: ChatSummary;
  readonly messages: readonly MessageView[];
  readonly toolCalls: readonly ToolCallViewRow[];
  readonly metricsSnapshots: readonly MetricsSnapshotView[];
  readonly timelineRefs: readonly TimelineRef[];
}>;

// contract-drift-guard: ChatHistoryPageView
/** The conversation at its TAIL: the newest page plus the way further back
 * (DESIGN-PERFORMANCE §4). What `GET /api/chats/:id/history` now answers. */
export type ChatHistoryPageView = ChatHistoryView & Readonly<{ readonly page: HistoryPageView }>;

// contract-drift-guard: ChatMessagePageView
/** One page of OLDER messages — a delta. No metrics snapshots and no
 * timeline refs: this page has nothing true to say about them, and empty
 * arrays would read as "there are none" (§1 L3). */
export type ChatMessagePageView = Readonly<{
  readonly chatId: string;
  readonly messages: readonly MessageView[];
  readonly toolCalls: readonly ToolCallViewRow[];
  readonly page: HistoryPageView;
}>;

// ── Typed errors ──

// The error CLASSES moved to `src/data/errors.ts` so the Broker and this
// module share one definition. Re-exported here so all existing consumers
// (~20 components import ClientError from "./client") keep working while
// client.ts is drained.
export { ClientError, ClientTimeoutError };

// ── Base URL ──

const API_BASE = DEFAULT_API_BASE;

// ── Internal helpers ──
// `fetchJson` moved to the Broker (`src/data/broker.ts`), which is now the
// single owner of client I/O. Imported here so the 93 existing call sites are
// unchanged while they are migrated to `read(blockId, …)` one domain at a time.

/**
 * The per-tier counts off the wire, coerced.
 *
 * Keys are not validated against the tier list on purpose: the client would
 * then need its own copy of that list, which is the parallel table the whole
 * registry design exists to avoid. An unknown key renders as its own words
 * or not at all; a wrong NUMBER would be a lie, and that is what is checked.
 */
function coerceTierCounts(raw: unknown): Readonly<Record<string, number>> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return EMPTY_TIER_COUNTS;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return Object.freeze(out);
}

const EMPTY_TIER_COUNTS: Readonly<Record<string, number>> = Object.freeze({});

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new ClientError("malformed", `Expected string at ${field}`);
  return value;
}

function assertNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new ClientError("malformed", `Expected number at ${field}`);
  return value;
}

// ── Public API: Projects ──

export async function listProjects(): Promise<readonly ProjectSummary[]> {
  const data = await fetchJson<unknown>("/projects");
  if (!Array.isArray(data))
    throw new ClientError("malformed", "Expected array for projects list");
  const list = data as ProjectSummary[];
  setProjects(list);
  return list;
}

export async function createProject(
  input: ProjectCreateInput,
): Promise<ProjectSummary> {
  const project = await fetchJson<ProjectSummary>("/projects", {
    method: "POST",
    body: JSON.stringify(input),
  });
  addProject(project);
  selectProject(project.id);
  // FIX automatically create a default chat so the user can start
  // chatting immediately without clicking "New chat" first. If the chat
  // creation fails (e.g., server error), the project is still usable —
  // the user can manually create a chat.
  try {
    await createChat(project.id, { title: "Default Chat" });
  } catch (err) {
    clientWarn("project", "failed to create default chat:", err);
  }
  return project;
}

export async function getProject(
  id: string,
): Promise<ProjectSummary> {
  return fetchJson<ProjectSummary>(`/projects/${encodeURIComponent(id)}`);
}

/**
 * Move a project to the recycle bin (`trashed_at`). The row stays; live
 * lists hide it. On success, drops it from the in-memory store and
 * clears selection if it was active. Throws ClientError on failure
 * (404 if not found). Restore is `restoreProject`.
 *
 * (delete eviction): if the binned project was the active one,
 * auto-select the NEXT available project so the main content area never
 * shows a hidden project (content matches sidebar). The user
 * never sees a blank screen — the next project's chats load immediately.
 */
export async function deleteProject(id: string): Promise<void> {
  await fetchJson<{ deleted: boolean; id: string }>(
    `/projects/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  const wasActive = currentProjectId.get() === id;
  removeChatsForProject(id);
  setMessages([]);
  // Capture the position BEFORE removeProject so eviction targets the
  // nearest neighbor (next project, or previous if it was last).
  const evictIndex = projects.get().findIndex((p) => p.id === id);
  removeProject(id);
  // auto-select the nearest remaining project if the deleted one was
  // active (content matches sidebar; never show a deleted project).
  if (wasActive) {
    const remaining = projects.get();
    if (remaining.length > 0) {
      const idx = evictIndex >= 0 ? Math.min(evictIndex, remaining.length - 1) : 0;
      selectProject(remaining[idx]!.id);
    } else {
      selectProject(null);
    }
  }
}

// ── Public API: Chats ──

export async function listChats(projectId: string): Promise<readonly ChatSummary[]> {
  const generation = chatsGeneration();
  return loadLatestOnly(
    `project-chats:${projectId}`,
    async () => {
      const data = await fetchJson<unknown>(`/projects/${encodeURIComponent(projectId)}/chats`);
      if (!Array.isArray(data)) throw new ClientError("malformed", "Expected array for chats list");
      return data as ChatSummary[];
    },
    list => replaceChatsForProject(projectId, list),
    () => chatsGeneration() === generation,
  );
}

export async function createChat(
  projectId: string,
  input: ChatCreateInput,
): Promise<ChatSummary> {
  const chat = await fetchJson<ChatSummary>(
    `/projects/${encodeURIComponent(projectId)}/chats`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
  addChat(chat);
  selectChat(chat.id);
  return chat;
}

/**
 * Rename a project (sidebar rework). PATCHes the server and
 * updates the in-memory projects store. Does not touch files on disk.
 */
export async function renameProject(id: string, name: string): Promise<void> {
  const updated = await fetchJson<ProjectSummary>(
    `/projects/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify({ name }) },
  );
  renameProjectInStore(id, updated.name, updated.updatedAt);
}

/**
 * Re-point a project at a different folder (relink — the way out of a
 * wiped project folder). PATCHes the server and updates the in-memory
 * store. Touches the project RECORD only; nothing on disk moves.
 */
export async function updateProjectPath(id: string, path: string): Promise<ProjectSummary> {
  const updated = await fetchJson<ProjectSummary>(
    `/projects/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify({ path }) },
  );
  // The response re-measured the folder — carry it so the badge clears (or
  // the refusal's absence of a change stands) without a second fetch.
  updateProjectInStore(id, {
    path: updated.path,
    updatedAt: updated.updatedAt,
    ...(updated.folder !== undefined ? { folder: updated.folder } : {}),
  });
  return updated;
}

/**
 * Rename a chat (sidebar rework). PATCHes the server and updates
 * the in-memory chats store.
 */
export async function renameChat(chatId: string, title: string): Promise<ChatSummary> {
  const updated = await fetchJson<ChatSummary>(
    `/chats/${encodeURIComponent(chatId)}`,
    { method: "PATCH", body: JSON.stringify({ title }) },
  );
  updateChatInStore(chatId, { title: updated.title, updatedAt: updated.updatedAt });
  return updated;
}

/**
 * Persist the selected model to a chat (proactive: model selection
 * survives refresh — part of "everything persists"). The model picker
 * calls this when the user picks a model for the active chat. On chat
 * load, App.svelte restores selectedModelId from the chat's modelId.
 */
export async function setChatModel(chatId: string, modelId: string): Promise<void> {
  const updated = await fetchJson<ChatSummary>(
    `/chats/${encodeURIComponent(chatId)}`,
    { method: "PATCH", body: JSON.stringify({ modelId }) },
  );
  updateChatInStore(chatId, { modelId: updated.modelId });
}

/**
 * Move a conversation to the recycle bin (`trashed_at`). The row stays
 * (messages and tool calls with it) — NEVER files on disk. Updates the
 * in-memory store and clears the selection if the binned chat was active.
 * Restore is `restoreChat`.
 *
 * (delete eviction): if the binned chat was the active one,
 * auto-select the NEXT available chat in the same project so the main
 * content area never shows a hidden chat. If no chats remain,
 * clear the selection (the content area shows the "no chat" state).
 */
export type TrashList = Readonly<{
  readonly projects: readonly ProjectSummary[];
  readonly chats: readonly ChatSummary[];
}>;

/** Recycle bin — rows with trashed_at set. Never a hard-deleted list. */
export async function listTrash(): Promise<TrashList> {
  const data = await fetchJson<unknown>("/trash");
  if (data === null || typeof data !== "object") {
    throw new ClientError("malformed", "Expected trash list");
  }
  const rec = data as { projects?: unknown; chats?: unknown };
  if (!Array.isArray(rec.projects) || !Array.isArray(rec.chats)) {
    throw new ClientError("malformed", "Expected trash list");
  }
  return { projects: rec.projects as ProjectSummary[], chats: rec.chats as ChatSummary[] };
}

export async function restoreProject(id: string): Promise<ProjectSummary> {
  const row = await fetchJson<ProjectSummary>(
    `/projects/${encodeURIComponent(id)}/restore`,
    { method: "POST" },
  );
  addProject(row);
  // Live lists hid this project's conversations with the cap. Pull them
  // back so the river is not an empty header after restore.
  await listChats(id);
  return row;
}

export async function restoreChat(id: string): Promise<ChatSummary> {
  const row = await fetchJson<ChatSummary>(
    `/chats/${encodeURIComponent(id)}/restore`,
    { method: "POST" },
  );
  addChat(row);
  return row;
}

export async function deleteChat(chatId: string): Promise<void> {
  const deletedChat = chatForId(chatId);
  const wasActive = currentChatId.get() === chatId;
  // Capture the deleted chat's position in its project's sorted list BEFORE
  // removal, so we evict to the nearest neighbor (the next chat, or the
  // previous if the deleted chat was last) rather than always the first —
  // the user keeps their place in the list (responsive, not jarring).
  let evictIndex = -1;
  if (deletedChat !== null) {
    const before = projectChatsFor(deletedChat.projectId);
    evictIndex = before.findIndex((c) => c.id === chatId);
  }
  await fetchJson<{ deleted: boolean; id: string }>(
    `/chats/${encodeURIComponent(chatId)}`,
    { method: "DELETE" },
  );
  removeChat(chatId);
  // auto-select the nearest remaining chat if the deleted one was
  // active (content matches sidebar; never show a deleted chat).
  if (wasActive && deletedChat !== null) {
    const projectChats = projectChatsFor(deletedChat.projectId);
    if (projectChats.length > 0) {
      const idx = evictIndex >= 0 ? Math.min(evictIndex, projectChats.length - 1) : 0;
      selectChat(projectChats[idx]!.id);
    } else {
      selectChat(null);
      setMessages([]);
    }
  } else if (currentChatId.get() === null) {
    // Clear the message view if the deleted chat was active.
    setMessages([]);
  }
}

/**
 * Toggle the pinned flag on a chat (sidebar rework). Pinned chats
 * sort to the top of their project group in the sidebar.
 */
export async function setChatPinned(chatId: string, pinned: boolean): Promise<ChatSummary> {
  const updated = await fetchJson<ChatSummary>(
    `/chats/${encodeURIComponent(chatId)}/pin`,
    { method: "POST", body: JSON.stringify({ pinned }) },
  );
  updateChatInStore(chatId, { pinned: updated.pinned });
  return updated;
}

/**
 * Duplicate a chat (sidebar rework — context menu "Duplicate").
 * Creates a new chat under the same project with a "(copy)" title and
 * copies all messages + tool calls. Returns the new chat.
 */
export async function duplicateChat(chatId: string): Promise<ChatSummary> {
  const copy = await fetchJson<ChatSummary>(
    `/chats/${encodeURIComponent(chatId)}/duplicate`,
    { method: "POST" },
  );
  addChat(copy);
  return copy;
}

export async function getChat(id: string): Promise<ChatSummary> {
  return fetchJson<ChatSummary>(`/chats/${encodeURIComponent(id)}`);
}

export async function listMessages(chatId: string): Promise<readonly MessageView[]> {
  const data = await fetchJson<unknown>(`/chats/${encodeURIComponent(chatId)}/messages`);
  if (!Array.isArray(data))
    throw new ClientError("malformed", "Expected array for messages");
  return data as MessageView[];
}

export async function listMetricsSnapshots(
  chatId: string,
): Promise<readonly MetricsSnapshotView[]> {
  const data = await fetchJson<unknown>(`/chats/${encodeURIComponent(chatId)}/metrics`);
  if (!Array.isArray(data))
    throw new ClientError("malformed", "Expected array for metrics snapshots");
  return data as MetricsSnapshotView[];
}

export async function getChatHistory(chatId: string): Promise<ChatHistoryPageView> {
  return fetchJson<ChatHistoryPageView>(`/chats/${encodeURIComponent(chatId)}/history`);
}

/** The page of messages BEFORE `cursor`. The cursor is the server's own
 * position value, passed back verbatim — this side never reads inside it. */
export async function getChatMessagePage(
  chatId: string,
  cursor: string,
): Promise<ChatMessagePageView> {
  return fetchJson<ChatMessagePageView>(
    `/chats/${encodeURIComponent(chatId)}/history/older?before=${encodeURIComponent(cursor)}`,
  );
}

// ── Public API: Auto-checks ──

export async function runProjectAutoCheck(
  projectId: string,
  input: AutoCheckCreateInput,
): Promise<AutoCheck> {
  const check = await fetchJson<AutoCheck>(
    `/projects/${encodeURIComponent(projectId)}/auto-checks`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
  addAutoCheck(check);
  return check;
}

export async function listProjectAutoChecks(
  projectId: string,
): Promise<readonly AutoCheck[]> {
  const data = await fetchJson<unknown>(
    `/projects/${encodeURIComponent(projectId)}/auto-checks`,
  );
  if (!Array.isArray(data))
    throw new ClientError("malformed", "Expected array for project auto-checks");
  const list = data as AutoCheck[];
  // Evict checks from OTHER projects before upserting so the raw store
  // does not accumulate checks from every project ever visited (an
  // unbounded memory leak). The derived `checksForCurrentProject` filters
  // by the current project so the view was already correct, but the raw
  // list grew without bound.
  evictAutoChecksForOtherProjects(projectId);
  upsertAutoChecks(list);
  return list;
}

// The store's half of `invalidateOn`: the checks store lives outside the
// Broker (fed by the functions above), so when an ACTION declares that it
// falsified check data (`invalidates: ["check:complete"]` on
// `checks.auto/rerun`), this subscription is what makes the displayed list
// actually refresh — an action that changes state must refresh what displays
// it, and this file is the single feeder of that store. Standing
// subscription, installed once at module load; a failed refresh is reported,
// never swallowed silently.
onInvalidation("check:complete", () => {
  // The panel's own scope atom first, then the REAL selection: nothing in
  // the cockpit arms the panel scope, so keyed on it alone this refresher
  // silently no-oped there — a rerun's results landed in the database and
  // never on screen (the same unplugged class as the dark annunciators).
  const projectId = autoChecksProjectId.get() ?? currentProjectId.get();
  if (projectId === null) return;
  void listProjectAutoChecks(projectId).catch((err: unknown) =>
    clientWarn("auto-checks", "refresh after action failed:", err),
  );
});

// STANDING STATE MUST STAND AT BOOT. The annunciator derives "n checks
// failing" from this store, but the store only ever filled after a run
// completed or a rerun invalidated — so a check that failed yesterday was
// dark when the cockpit opened today, until the next run happened to
// refresh it. Selecting a project loads its recorded check state.
//
// TWO subscriptions feed one deduplicated loader, and both are needed:
// the kept selection is restored into the project atom at MODULE LOAD of
// the projects store — before this module evaluates and before auth — so
// a project-only listener never hears the boot restore (driven live: the
// reloaded cockpit stayed dark), and firing on it immediately would put a
// request into the boot's auth-alone first wave. Gating on the auth state
// makes the boot-restore load join the second wave, exactly where every
// other cookie-only read is issued (the boot-waves guard counts it there).
let lastCheckProjectLoaded: string | null = null;
let lastOpenedProjectId: string | null = null;
const loadChecksForSelection = (): void => {
  const id = currentProjectId.get();
  if (id === null) {
    lastCheckProjectLoaded = null;
    return;
  }
  if (!authState.get().authenticated) return;
  if (id === lastCheckProjectLoaded) return; // auth flaps must not re-fetch
  lastCheckProjectLoaded = id;
  void listProjectAutoChecks(id).catch((err: unknown) =>
    clientWarn("auto-checks", "project check load failed:", err),
  );
};
/**
 * THE TOOL MANIFEST, FED AT THE SAME MOMENT EVERY OTHER SESSION-SCOPED
 * READ FIRES. `getToolManifest` is the only writer of the manifest store,
 * and it had no caller at all — the store stayed empty for the whole
 * session, so every consumer that derives from it answered from absence:
 * the flow's file-effect fold appended no effect beats (no `see what
 * changed`, no keep/undo verbs, the pane's edits section forever "no
 * files touched yet") and `toolLabel` fell back for every tool. One
 * loader, the loadChecksForSelection family (auth-gated, once per
 * authenticated session, warned not swallowed on failure) — the fetch
 * itself still lives in its one owner.
 */
let toolManifestLoadedForSession = false;
const loadToolManifestForSession = (): void => {
  if (!authState.get().authenticated) {
    toolManifestLoadedForSession = false;
    return;
  }
  if (toolManifestLoadedForSession) return; // auth flaps must not re-fetch
  toolManifestLoadedForSession = true;
  void getToolManifest().catch((err: unknown) =>
    clientWarn("tools", "tool manifest load failed:", err),
  );
};
/** Opening a project is GET /projects/:id — the server starts mapping there. */
const openSelectedProject = (): void => {
  const id = currentProjectId.get();
  if (id === null) {
    lastOpenedProjectId = null;
    return;
  }
  if (!authState.get().authenticated) return;
  if (id === lastOpenedProjectId) return;
  lastOpenedProjectId = id;
  void getProject(id).catch((err: unknown) =>
    clientWarn("project", "open project failed:", err),
  );
};
currentProjectId.subscribe(loadChecksForSelection);
authState.subscribe(loadChecksForSelection);
authState.subscribe(loadToolManifestForSession);
currentProjectId.subscribe(openSelectedProject);
authState.subscribe(openSelectedProject);

export async function listChatAutoChecks(
  chatId: string,
): Promise<readonly AutoCheck[]> {
  const data = await fetchJson<unknown>(
    `/chats/${encodeURIComponent(chatId)}/auto-checks`,
  );
  if (!Array.isArray(data))
    throw new ClientError("malformed", "Expected array for chat auto-checks");
  const list = data as AutoCheck[];
  upsertAutoChecks(list);
  return list;
}

/**
 * Set the auto-checks scope (project + chat). The AutoCheckPanel reads
 * the derived `checksForCurrentProject` + `checksForCurrentChat` stores.
 * Components call this when the current project/chat changes.
 */
export function scopeAutoChecks(projectId: string | null, chatId: string | null): void {
  setAutoChecksScope(projectId, chatId);
}

// ── Public API: Config ──


// ── Public API: Models (schema-driven model picker + settings) ──

export async function getModels(): Promise<ModelsCatalog> {
  const catalog = await fetchJson<ModelsCatalog>("/models");
  setModels(catalog);
  return catalog;
}

// ── Public API: Memory ──

export type MemorySearchQuery = Readonly<{
  readonly text?: string;
  readonly source?: "tool" | "conversation" | "llm" | "user";
  readonly toolName?: string;
  readonly chatId?: string;
  readonly tier?: "present" | "short-term" | "long-term";
  readonly tags?: readonly string[];
  readonly fromTime?: string;
  readonly toTime?: string;
  readonly limit?: number;
}>;

/**
 * Shared memory-result ingestion: validate the `field` array on the payload,
 * cast to MemoryEntryView[], push into the store, and return. Used by both
 * listMemory and searchMemory so the two paths share one body (no duplicate
 * logic).
 */
function ingestMemoryList(payload: { [K in string]: unknown }, field: string): readonly MemoryEntryView[] {
  const arr = payload[field];
  if (!Array.isArray(arr))
    throw new ClientError("malformed", `Expected array for memory ${field}`);
  const list = arr as MemoryEntryView[];
  setMemoryEntries(list);
  return list;
}

export async function listMemory(tier?: string): Promise<readonly MemoryEntryView[]> {
  const query = tier !== undefined && tier.length > 0 ? `?tier=${encodeURIComponent(tier)}` : "";
  const data = await fetchJson<{ entries: unknown[]; count: number }>(`/memory${query}`);
  return ingestMemoryList(data, "entries");
}

/**
 * Search memory with rich provenance filters. Posts the query to
 * /api/memory/search and updates the memoryEntries store with the results.
 * The search runs server-side as decrypt-then-filter — text matches content/
 * topic/originalRequest/toolName; source/toolName/chatId/tier/tags/time
 * narrow the set. Session scoping is enforced server-side.
 */
export async function searchMemory(query: MemorySearchQuery): Promise<readonly MemoryEntryView[]> {
  const data = await fetchJson<{ results: unknown[]; count: number }>(`/memory/search`, {
    method: "POST",
    body: JSON.stringify(query),
  });
  return ingestMemoryList(data, "results");
}

/**
 * Store a memory entry with full provenance. The content is
 * encrypted at rest server-side (same key as web.db).
 */
export async function storeMemory(entry: Readonly<{
  content: string;
  source: "tool" | "conversation" | "llm" | "user";
  toolName?: string;
  originalRequest?: string;
  chatId?: string;
  how?: "automatic" | "manual";
  tier?: "present" | "short-term" | "long-term";
}>): Promise<string> {
  const data = await fetchJson<{ id: string }>(`/memory`, {
    method: "POST",
    body: JSON.stringify(entry),
  });
  return data.id;
}

// ── Public API: Filesystem (server-side directory browsing) ──

export type DirectoryEntry = Readonly<{
  readonly name: string;
  readonly path: string;
  readonly accessible: boolean;
  /** Why this folder cannot be a project (Landlock overlap), when set. */
  readonly restriction?: string;
}>;

export type DirectoryListing = Readonly<{
  readonly path: string;
  readonly parent: string | null;
  readonly entries: readonly DirectoryEntry[];
  readonly accessible: boolean;
  /** Why the folder the picker is standing on cannot be a project. */
  readonly restriction?: string;
}>;

export type DirectoryRoot = Readonly<{
  readonly label: string;
  readonly path: string;
  readonly restriction?: string;
}>;

export type DirectoryRoots = Readonly<{ readonly roots: readonly DirectoryRoot[] }>;

/**
 * List directories on the SERVER at the given path (server-side browsing).
 * Pass an empty path to start at the server's default root. Returns child
 * directories only (files are omitted) so the FolderPicker can render a
 * navigable tree without a browser `<input type="file">`.
 */
export async function listDirectories(path?: string): Promise<DirectoryListing> {
  const query = path !== undefined && path.length > 0 ? `?path=${encodeURIComponent(path)}` : "";
  return fetchJson<DirectoryListing>(`/filesystem/list${query}`);
}

/**
 * The roots the folder picker may browse (deny-by-default — nothing outside
 * these is listed or selectable). Answered by the server; the picker never
 * guesses a starting point.
 */
export async function listDirectoryRoots(): Promise<DirectoryRoots> {
  return fetchJson<DirectoryRoots>("/filesystem/roots");
}


/**
 * create a new folder on the server (in a chosen parent). Returns
 * the absolute path of the created directory. Used by the folder picker's
 * "Create new folder" action so the user can make a project folder inline.
 */
export async function createFolder(parent: string, name: string): Promise<{ path: string; name: string }> {
  return fetchJson<{ ok: boolean; path: string; name: string }>("/filesystem/mkdir", {
    method: "POST",
    body: JSON.stringify({ parent, name }),
  });
}

// ── Public API: Tools ──

export async function getToolManifest(): Promise<readonly WebToolEntry[]> {
  const data = await fetchJson<unknown>("/tools");
  if (!Array.isArray(data))
    throw new ClientError("malformed", "Expected array for tool manifest");
  const tools = data as WebToolEntry[];
  setTools(tools);
  // also load the per-session tool settings so the Tools panel
  // reflects the user's saved enable/disable overrides on boot.
  try {
    await getToolSettings();
  } catch (err) {
    clientWarn("tools", "getToolSettings failed:", err);
  }
  return tools;
}

/**
 * (tools per user): load the per-session tool settings (enabled
 * overrides) from the DB, with the effective enabled set the SERVER merged
 * (its one merge owner: overrides over the global default). The browser
 * never recomputes it — its own merge ignored the global list (CFG-0 B1).
 */
export async function getToolSettings(): Promise<readonly { toolName: string; enabled: boolean; config: unknown }[]> {
  const body = await fetchJson<{ settings?: unknown; enabledList?: unknown }>("/tools/settings");
  const rows = body.settings;
  if (!Array.isArray(rows) || !Array.isArray(body.enabledList) || body.enabledList.some((name) => typeof name !== "string"))
    throw new ClientError("malformed", "Expected tool settings with the effective enabled list");
  setEnabledTools(body.enabledList as readonly string[]);
  return rows as readonly { toolName: string; enabled: boolean; config: unknown }[];
}

/**
 * toggle a built-in tool's enabled state (writes the per-session
 * override to the DB — tools per user). Returns the new enabled
 * state + the full effective enabled list for this session. The server
 * invalidates its manifest cache so the next run uses the updated set.
 */
export async function toggleTool(toolName: string): Promise<{ ok: boolean; tool: string; enabled: boolean; enabledList: readonly string[] }> {
  const result = await fetchJson<{ ok: boolean; tool: string; enabled: boolean; enabledList: readonly string[] }>(`/tools/${encodeURIComponent(toolName)}/toggle`, {
    method: "POST",
  });
  if (result.ok) {
    setEnabledTools(result.enabledList);
  }
  return result;
}

// ── Public API: Timeline (canonical ledger query) ──

/**
 * Run a timeline query and replace the shown results with its page.
 *
 * Routed through the latest-load-wins gate (`loadLatestOnly`) for the same
 * reason `loadChatHistory` is: two filters applied in quick succession race,
 * and whichever RESPONSE lands last used to win regardless of which REQUEST
 * was newer — so the user could be shown the previous filter's events under
 * the filter they just picked.
 */
export async function queryTimeline(
  filter: TimelineQueryRequest,
): Promise<TimelineEventSummariesResult> {
  return loadLatestOnly(
    "timeline-query",
    () => fetchJson<TimelineEventSummariesResult>("/timeline/query", {
      method: "POST",
      body: JSON.stringify(filter),
    }),
    (result) => ingestResults(result),
  );
}

/**
 * Apply a new timeline filter: set it in the store (so UI reflects it) and
 * run the query. The sole path through which components change the filter.
 */
export async function applyTimelineFilter(
  filter: TimelineQueryRequest,
): Promise<TimelineEventSummariesResult> {
  setFilter(filter);
  return queryTimeline(filter);
}

/**
 * Refresh the timeline using the current filter (preserving any eventType /
 * recordKind the user applied), ensuring a sane default limit. Called after
 * a chat run finishes so the timeline reflects the newly-recorded run/turn/
 * message/token events without requiring a manual refresh click.
 *
 * THE SCOPE RIDES THE QUERY. The standing scope (a chat, a project, a
 * trace) carries the id the route resolves SERVER-SIDE — the authoritative
 * scoping the query route owns. Without it the refresh asked for the
 * global latest page and left the scoping to the client-side net, which
 * measured live as an empty window on a busy ledger: the global latest
 * page was all ambient recording from every other run, none of it this
 * chat's, so the net kept nothing and the streamed window (the band's
 * zoomed view, the a11y outline, the run list) went blank after every
 * run. The net stays as the safety net it always was; the question is
 * now asked of the right population.
 */
export async function refreshTimeline(): Promise<TimelineEventSummariesResult> {
  const current = timelineFilter.get();
  // A refresh starts a NEW walk, so any cursor from the previous walk is
  // dropped — resuming from it would return the page after the one the user
  // is looking at and call it a refresh. The page size comes from the single
  // owner (TIMELINE_QUERY_LIMIT), not a second hardcoded 200.
  const { cursor: _cursor, ...rest } = current;
  void _cursor;
  const scope = timelineScope.get();
  const filter: TimelineQueryRequest = {
    ...rest,
    ...(scope.kind === "chat" && scope.chatId !== undefined
      ? { chatId: scope.chatId }
      : scope.kind === "project" && scope.projectId !== undefined
        ? { projectId: scope.projectId }
        : scope.kind === "trace" && scope.traceId !== undefined
          ? { traceId: scope.traceId }
          : {}),
    limit: current.limit ?? TIMELINE_QUERY_LIMIT,
  };
  return applyTimelineFilter(filter);
}

/**
 * Load the NEXT page of timeline events, appending to what is already shown.
 *
 * Resolves to `null` when there is nothing further — the honest answer, rather
 * than a request that returns the same page again. Uses the keyset cursor from
 * the last response, so a page boundary stays exact while the ledger is being
 * appended to underneath a live run; an offset walk would re-show or skip
 * events every time an append landed between two pages.
 *
 * Shares the `timeline-query` lane with `queryTimeline` (see
 * `loadLatestOnly`): the cursor is only meaningful against the result set
 * it came from, so if a new filter is applied while this page is in flight,
 * appending it would splice the OLD filter's events into the NEW filter's
 * list. The page is still returned; it just no longer gets to write.
 */
export async function loadMoreTimeline(): Promise<TimelineEventSummariesResult | null> {
  const cursor = timelineResults.get().nextCursor;
  if (cursor === null) return null;
  const filter: TimelineQueryRequest = { ...timelineFilter.get(), cursor };
  return loadLatestOnly(
    "timeline-query",
    () => fetchJson<TimelineEventSummariesResult>("/timeline/query", {
      method: "POST",
      body: JSON.stringify(filter),
    }),
    (page) => appendResults(page),
  );
}


// ── Public API: Metrics ──

/** Combined metrics response from GET /api/metrics. */
export type CombinedMetricsView = Readonly<{
  snapshot: MetricsSnapshot;
  system: SystemMetrics;
  tokens: TokenThroughput;
}>;

export async function getMetrics(): Promise<MetricsSnapshot> {
  const data = await fetchJson<CombinedMetricsView>("/metrics");
  setMetrics(data.snapshot);
  setSystemMetrics(data.system);
  setTokenThroughput(data.tokens);
  return data.snapshot;
}

// ── Public API: Self-improving ──

export type SelfImprovementSuggestionView = Readonly<{
  severity: "high" | "medium" | "low";
  area: string;
  signal: string;
  suggestion: string;
  functionKey?: Readonly<{ module: string; function: string; scope: string }>;
}>;


// ── Public API: UI schema ──

/**
 * Fetch the schema-driven UI manifest (menus, panels, widgets, settings,
 * actions, signals) and store it. The frontend renders dynamically from this
 * schema — no hardcoded panel/widget lists. To add a menu or widget, add a
 * schema entry in `server/schema/ui-declarations.ts`.
 */
export async function getUiSchema(): Promise<UiSchema> {
  const schema = await fetchJson<UiSchema>("/schema/ui");
  setUiSchema(schema);
  return schema;
}

/**
 * Fetch current signal + customization values for schema-bound widgets. The
 * chat-bar signal widgets read from the values store populated here.
 */
export async function getUiSchemaValues(): Promise<UiSchemaValues> {
  const request = beginSchemaValuesRead();
  const values = await fetchJson<UiSchemaValues>("/schema/ui/values");
  setUiSchemaValues(values, request);
  return values;
}

/**
 * Execute a registered exposure action by id (POST /api/schema/ui/actions/:id).
 * The single client-side owner of the schema-action call. Returns the action
 * result (the server wraps it in `{ ok: true, result }`); this unwraps the
 * `result` so callers get the raw action output. Throws ClientError on
 * HTTP/network failure.
 */
export async function executeSchemaAction(
  actionId: string,
  args?: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const body = await fetchJson<{ ok?: boolean; result?: unknown; error?: string; message?: string }>(
    `/schema/ui/actions/${encodeURIComponent(actionId)}`,
    { method: "POST", body: JSON.stringify(args ?? {}) },
  );
  if (body.ok !== true) {
    const msg = typeof body.message === "string" ? body.message : `Action '${actionId}' failed`;
    throw new ClientError("action_failed", msg);
  }
  return body.result;
}

// ── Public API: Agents ──


// ── Public API: Run control ──

export type RunStartInput = {
  readonly projectId: string;
  readonly prompt: string;
  readonly modelId?: string;
  readonly chatId?: string;
};

export type RunStartResult = {
  readonly runId: string;
};

export async function startRun(input: RunStartInput): Promise<RunStartResult> {
  const ownerChatId = input.chatId ?? currentChatId.get();
  const result = await fetchJson<RunStartResult>("/run/start", {
    method: "POST",
    body: JSON.stringify(input),
  });
  assertString(result.runId, "runId");

  const runView: RunView = {
    runId: result.runId,
    status: "starting",
    startedAt: Date.now(),
    modelLabel: input.modelId ?? null,
    projectId: input.projectId,
  };
  if (currentChatId.get() === ownerChatId) setRun(runView);
  return result;
}

/**
 * Plant the run view for a run THIS CLIENT DID NOT START — the run a
 * `chat_run_live` refusal names as already live in the conversation (a
 * raw-API start, a second window, a raced door). Sole-writer path: the
 * send path (run-stream.ts) calls this when it adopts the refused run, so
 * the pane shows the live run and the composer's next send routes to the
 * steer door the refusal's own sentence promises. Status is `running` —
 * the gate that refused looked the run up in the live registry, so it is
 * past "starting"; the adopted stream's own frames settle it from here.
 */
export function adoptLiveRun(runId: string, projectId: string): void {
  setRun({
    runId,
    status: "running",
    startedAt: Date.now(),
    modelLabel: null,
    projectId,
  });
}

/**
 * Stop a live run (POST /api/run/:runId/cancel). The server aborts the run's
 * controller; the executor publishes the terminal `cancelled` frame, which
 * the stream handler below settles (the tail is committed, streaming ends,
 * stranded tool calls finalize with their own cancelled sentence).
 *
 * THE RUN VIEW SETTLES AS `cancelled` — never as `done`: a stop is a
 * person's own act, and dressing it as a completion would report an
 * interruption as success. The report settles the view and schedules its
 * retirement at the run-state owner, so the reader sees the outcome, then
 * the pane returns to its resting state.
 */
export async function cancelRun(runId: string): Promise<void> {
  await fetchJson<void>(`/run/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
  });
  updateRunStatus("cancelled");
  commitStreamingTail();
  setStreaming(false);
}

/**
 * Steer an active run: inject a new user message into the run's
 * conversation. The message is queued server-side; after the current
 * turn finishes, a new turn starts with the full conversation history +
 * the steering message. This enables bidirectional communication —
 * the user can redirect the agent mid-work.
 *
 * Returns the number of queued steering messages (including this one).
 */
export async function steerRun(runId: string, prompt: string): Promise<{ queued: number; steered: boolean }> {
  const result = await fetchJson<{ queued: number; steered: boolean }>(
    `/run/${encodeURIComponent(runId)}/steer`,
    { method: "POST", body: JSON.stringify({ prompt }) },
  );
  assertNumber(result.queued, "queued");
  return result;
}

/**
 * Track the active stream controller so steering/cancel can access it.
 * Only one stream is active at a time (the current chat's run).
 * Referenced by steerCurrentRun to know if a stream is open.
 */
let activeStreamController: StreamController | null = null;
void activeStreamController; // referenced for future cancel-during-steer use

/**
 * Steer the current active run: inject a user message into the active run's
 * conversation. The message is appended to the chat transcript and queued
 * server-side; after the current turn finishes, a new turn starts with the
 * full conversation history + the steering message.
 *
 * THE LIVENESS CHECK IS THE CLIENT'S OWN RUN STATE (`isRunActive` — the
 * run view this tab holds), checked HERE rather than in a caller: a run that
 * has settled (`done`/`error`/`cancelled`, or the view already retired) is
 * not steerable, and `false` is the caller's signal to fall back to starting
 * a new run. A `starting` view is steerable — the run exists server-side and
 * the queue is read at every turn boundary.
 *
 * A REFUSED steer is not a delivery: the beat and the streaming flag are
 * raised optimistically before the POST, and if the POST fails (the 404
 * window — a run that ended between the liveness check and the POST), both
 * are taken back HERE, at the door that raised them. The beat keeps the
 * reader's own words but loses its steered marking (the note it renders
 * would claim the route persisted an instruction it refused), the streaming
 * flag returns to what it was, and the failure RETHROWS so the composer's
 * answer path can speak it — this catch never swallows the sentence.
 *
 * Returns true if the steering message was queued, false if no run is
 * active (the caller should fall back to beginChatRun for a new run).
 */
export async function steerCurrentRun(
  prompt: string,
  opts: Readonly<{ onCommitted?: () => void }> = {},
): Promise<boolean> {
  const run = currentRun.get();
  if (run === null || (run.status !== "starting" && run.status !== "running")) return false;
  // The words land in the transcript FIRST (the beat appears in the same
  // frame), marked as steered so the flow renders the queued state — then
  // the composer may empty on exactly that fact, never on the server's
  // round trip (the same law `beginCockpitRun`'s `onCommitted` obeys).
  const beatId = appendUserMessage(prompt, true);
  opts.onCommitted?.();
  const wasStreaming = isStreaming.get();
  setStreaming(true);
  try {
    const { queued } = await steerRun(run.runId, prompt);
    setQueuedSteers(queued);
    return true;
  } catch (err) {
    // The route queued nothing, so both optimistic marks above are now
    // lies and are taken back at the door that raised them: the beat
    // stays as the reader's own visible words but WITHOUT the steered
    // marking (its note would claim a delivery the route never persisted
    // — and the marking is live-session state, so reload would drop it
    // while the live view kept claiming it), and the streaming flag
    // returns to its pre-call value (a still-live run keeps it raised —
    // the stream owns lowering it; a dead one comes back down). The
    // failure itself is RETHROWN for the composer's answer path, which
    // renders the server's sentence as the hint.
    unmarkSteeredMessage(beatId);
    setStreaming(wasStreaming);
    throw err;
  }
}

// ── Public API: Chat convenience ──

/**
 * Append a user message to the chat transcript. The sole writer path for
 * components; calls the chat-messages ingestion (store write) here so
 * components never touch shared stores directly. Returns the message id so
 * the send path can take the optimistic row back if the server refuses the
 * run it was sent with.
 */
export function sendUserMessage(text: string): string {
  return appendUserMessage(text);
}

/**
 * Take back a user message the client appended optimistically — the run it
 * was sent with was refused, so nothing was recorded and the row was never a
 * fact. The sole-writer path for the store's `withdrawMessage`; the send
 * path (run-stream.ts) calls this at its refusal door.
 */
export function withdrawUserMessage(id: string): void {
  withdrawMessage(id);
}

/**
 * Begin a chat run: append the user's prompt, start the run, and open the
 * SSE stream. Model events stream into the chat-messages store automatically
 * via openRunStream's ingestion. Returns the stream controller so the caller
 * can close it on cancel/unmount.
 *
 * If `chatId` is provided, the server persists events to that chat's DB
 * projection; if not, streaming works but nothing is persisted (legacy
 * callers).
 */
export async function beginChatRun(
  projectId: string,
  prompt: string,
  opts?: Readonly<{ readonly modelId?: string; readonly chatId?: string }>,
): Promise<StreamController> {
  // Append the user's prompt as a user message so the chat transcript
  // reflects what was sent. This is the canonical "send a prompt" path;
  // `startRun` is the lower-level API that does NOT append (callers
  // that want to manage the transcript themselves use it directly).
  appendUserMessage(prompt);
  setStreaming(true);
  try {
    const startInput: RunStartInput = {
      projectId,
      prompt,
      ...(opts?.modelId !== undefined ? { modelId: opts.modelId } : {}),
      ...(opts?.chatId !== undefined ? { chatId: opts.chatId } : {}),
    };
    const { runId } = await startRun(startInput);
    const controller = openRunStream(runId, {});
    activeStreamController = controller;
    return controller;
  } catch (err) {
    commitStreamingTail();
    setStreaming(false);
    const code = err instanceof ClientError ? err.code : null;
    const statusCode = err instanceof ClientError ? err.statusCode : undefined;
    const rawMsg =
      err instanceof Error ? err.message : String(err);
    const humanMsg = formatErrorMessage({
      code,
      message: rawMsg,
      statusCode,
    });
    appendChatError(humanMsg);
    appendError("run_start", rawMsg, code);
    throw err;
  }
}

/**
 * Hydrate the chat-messages store from a DB history payload. Maps the
 * wire views (camelCase) to the client ChatMessage view model, joining
 * tool calls to their parent messages by id and reconstructing the rich
 * chat-exposure fields (reasoning, tokens, timing, headers, model,
 * finish reason, context) from the persisted `metadata` blob.
 *
 * This is the single load path: the same metadata written by the run
 * stream's `updateMessageMetadata` is read back here so the full chat
 * exposure survives a page refresh.
 */
export function hydrateChatFromHistory(history: ChatHistoryView): readonly ChatMessage[] {
  const list = messagesFromRows(history.messages, history.toolCalls);
  return mergeTimelineEvents(list, history.timelineRefs, history.messages.filter((message) => message.discarded === true).map((message) => message.id));
}

/**
 * MESSAGE ROWS + THEIR TOOL CALLS → the client's ChatMessage view model.
 *
 * The single owner of that mapping, because there are now TWO callers: the
 * tail page (`hydrateChatFromHistory`) and every older page
 * (`loadOlderHistory`). Two copies would drift, and the drift would look
 * like "the messages you scrolled back to render differently from the ones
 * you opened on" — which is the same defect as a fabricated field.
 *
 * Reconstructs the rich exposure fields from the persisted metadata blob.
 * The blob is untrusted (model/tool output) — components render it with
 * Svelte's auto-escaping. Only known keys are spread; unknown keys are
 * dropped so a corrupt/extra blob cannot poison the view.
 */
function messagesFromRows(
  rows: readonly MessageView[],
  toolCallRows: readonly ToolCallViewRow[],
): ChatMessage[] {
  const toolsByMessage = new Map<string, ToolCallViewRow[]>();
  for (const tc of toolCallRows) {
    const bucket = toolsByMessage.get(tc.messageId) ?? [];
    bucket.push(tc);
    toolsByMessage.set(tc.messageId, bucket);
  }
  // WITHDRAWN TURNS DO NOT REPLAY. A rewind (`run.compose/rewind`) records
  // that a turn and everything after it was taken back; the server still
  // SERVES those rows — flagged, never deleted — because a rewind is a
  // recorded event and the record has to survive it. What must not happen is
  // the flow replaying them as accepted history beside their replacement,
  // which is exactly the doubling the user reported. Dropped here, in the
  // one mapper both the tail page and every older page pass through, so a
  // page scrolled back to cannot disagree with the page opened on.
  return rows.filter((m) => m.discarded !== true).map((m) => {
    const timestamp = Date.parse(m.createdAt);
    const toolCalls = toolsByMessage.get(m.id) ?? [];
    // Reconstruct the rich exposure fields from the persisted metadata
    // blob. The blob is untrusted (model/tool output) — components render
    // it with Svelte's auto-escaping. Only known keys are spread; unknown
    // keys are dropped so a corrupt/extra blob cannot poison the view.
    const meta = parseMessageMetadata(m.metadata);
    if (m.role === "tool") {
      // The DB stores tool calls linked to a tool-role message; we map
      // to the client's toolCall-bearing ChatMessage shape.
      const firstTool = toolCalls[0];
      const toolCall: ToolCallView | undefined = firstTool
        ? {
            id: firstTool.callId ?? firstTool.id,
            name: firstTool.toolName,
            input: firstTool.input,
            output: firstTool.output,
            status: firstTool.status,
            startedAt: timestamp,
            ...(firstTool.durationMs !== null ? { durationMs: firstTool.durationMs } : {}),
            // the "attempt N" badge survives a page refresh.
            // The UI hides attempt 1 (via `attemptCount > 1`), so a fresh
            // successful call shows no badge — same as the live stream.
            ...(firstTool.attemptCount > 1 ? { attemptCount: firstTool.attemptCount } : {}),
            // A persisted failure WITH its recorded output is a refusal
            // record (the gate's block or the tool's own error) — the same
            // typed fact the live result frame and the ledger heal set.
            // A failure with NO output is the stranded-call shape: the
            // honest placeholder, never dressed as a refusal.
            ...(firstTool.status === "error" &&
              firstTool.output !== null &&
              firstTool.output !== undefined &&
              firstTool.output !== ""
              ? { refused: true as const }
              : {}),
          }
        : undefined;
      return {
        id: m.id,
        role: "tool",
        content: m.content,
        timestamp,
        ...(m.runId !== null ? { runId: m.runId } : {}),
        ...(toolCall !== undefined ? { toolCall } : {}),
      };
    }
    if (m.role === "event") {
      // Inline event messages (hallucination, steering, bias, self-healing,
      // error). Reconstruct the eventKind from the persisted metadata so
      // the icon + color styling survive a page refresh.
      return {
        id: m.id,
        role: "event",
        content: m.content,
        timestamp,
        ...(m.runId !== null ? { runId: m.runId } : {}),
        ...(meta.eventKind !== undefined ? { eventKind: meta.eventKind } : {}),
        ...(meta.timelineEventId !== undefined ? { timelineEventId: meta.timelineEventId } : {}),
      };
    }
    // Live and saved failures share one display projection. The DB retains
    // the raw record; reconciliation uses its canonical ID, never its wording.
    const content =
      m.role === "error" && meta.errorCode !== undefined
        ? formatErrorMessage({ code: meta.errorCode, message: m.content, statusCode: undefined })
        : m.content;
    return {
      id: m.id,
      role: m.role,
      content,
      timestamp,
      ...(m.runId !== null ? { runId: m.runId } : {}),
      ...(meta.errorCode !== undefined ? { errorCode: meta.errorCode } : {}),
      ...(meta.reasoning !== undefined ? { reasoning: meta.reasoning } : {}),
      ...(meta.tokenMetrics !== undefined ? { tokenMetrics: meta.tokenMetrics } : {}),
      ...(meta.timingMetrics !== undefined ? { timingMetrics: meta.timingMetrics } : {}),
      ...(meta.responseHeaders !== undefined ? { responseHeaders: meta.responseHeaders } : {}),
      ...(meta.responseModel !== undefined ? { responseModel: meta.responseModel } : {}),
      ...(meta.traceId !== undefined ? { traceId: meta.traceId } : {}),
      ...(meta.finishReason !== undefined ? { finishReason: meta.finishReason } : {}),
      ...(meta.context !== undefined ? { context: meta.context } : {}),
      ...(meta.dedupSummary !== undefined ? { dedupSummary: meta.dedupSummary } : {}),
      ...(meta.redactionNotice !== undefined ? { redactionNotice: meta.redactionNotice } : {}),
      ...(meta.eventKind !== undefined ? { eventKind: meta.eventKind } : {}),
      ...(meta.timelineEventId !== undefined ? { timelineEventId: meta.timelineEventId } : {}),
    };
  });
}

/**
 * Merge the inline events reconstructed from persisted TIMELINE REFS into a
 * message list, and write the result to the transcript store.
 *
 * Only the TAIL page carries timeline refs — an older page of messages is a
 * delta about messages and says nothing about the ledger — so this runs once
 * per conversation open, not once per page.
 */
function mergeTimelineEvents(
  list: ChatMessage[],
  timelineRefs: readonly TimelineRef[],
  discardedIds: readonly string[],
): readonly ChatMessage[] {
  // The message is the primary projection. A ref fills an absent record,
  // while its canonical ID prevents replay from duplicating that projection.
  const eventMessages: ChatMessage[] = [];
  for (const ref of timelineRefs) {
    const meta = ref.metadata as Record<string, unknown> | null;
    const desc = typeof meta?.["description"] === "string" ? meta["description"] : "";
    const kind = classifyInlineEvent(ref.eventType, desc);
    if (kind === null) continue;
    if (recordedMessageForEvent(list, ref.eventId) !== undefined ||
        recordedMessageForEvent(eventMessages, ref.eventId) !== undefined) continue;
    eventMessages.push({
      id: `evt-${ref.id}`,
      role: "event",
      content: desc || kind,
      timestamp: Date.parse(ref.timestamp),
      eventKind: kind,
      // The ref's eventId is the CANONICAL ledger address of this event —
      // carried (never rendered) so the documents fold reaches the record.
      // NOT ref.id: that is the projection row's own surrogate key.
      timelineEventId: ref.eventId,
    });
  }
  // Merge event messages into the list, sorted by timestamp. Stable sort
  // preserves the relative order of messages with the same timestamp.
  if (eventMessages.length > 0) {
    const merged = [...list, ...eventMessages];
    merged.sort((a, b) => a.timestamp - b.timestamp);
    setMessages(merged, true, discardedIds);
    return messagesStore.get();
  }

  setMessages(list, true, discardedIds);
  return messagesStore.get();
}

/**
 * Parse the persisted metadata blob into a typed MessageMetadata, dropping
 * unknown keys. Returns an empty object when the blob is null/missing/not a
 * plain object so the caller's conditional spreads are no-ops.
 */
function parseMessageMetadata(raw: unknown): MessageMetadata {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const obj = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof obj["reasoning"] === "string") out["reasoning"] = obj["reasoning"];
  if (isPlainObject(obj["tokenMetrics"])) out["tokenMetrics"] = obj["tokenMetrics"];
  if (isPlainObject(obj["timingMetrics"])) out["timingMetrics"] = obj["timingMetrics"];
  if (isPlainObject(obj["responseHeaders"])) out["responseHeaders"] = obj["responseHeaders"];
  if (typeof obj["responseModel"] === "string") out["responseModel"] = obj["responseModel"];
  if (typeof obj["traceId"] === "string") out["traceId"] = obj["traceId"];
  if (typeof obj["finishReason"] === "string") out["finishReason"] = obj["finishReason"];
  if (isPlainObject(obj["context"])) out["context"] = obj["context"];
  if (isPlainObject(obj["dedupSummary"])) out["dedupSummary"] = obj["dedupSummary"];
  if (isPlainObject(obj["redactionNotice"])) out["redactionNotice"] = obj["redactionNotice"];
  if (typeof obj["eventKind"] === "string") out["eventKind"] = obj["eventKind"];
  if (typeof obj["timelineEventId"] === "string") out["timelineEventId"] = obj["timelineEventId"];
  if (typeof obj["errorCode"] === "string") out["errorCode"] = obj["errorCode"];
  return out as unknown as MessageMetadata;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// ── Latest-load-wins: the choke point for context-scoped store writes ──
//
// A `load*` function does `await fetch(...)` and then writes shared stores.
// Nothing about that shape stops a SUPERSEDED response from landing after a
// newer one: switch from chat A to chat B while A's history is in flight and
// A's transcript is written under B's header. That is not a cosmetic glitch
// — the user reads another conversation's messages attributed to the one
// they are looking at.
//
// The gate below makes the late write structurally impossible rather than
// unlikely. The store writes do not live in the caller at all; they live in
// an `applyToStores` callback that ONLY `loadLatestOnly` can invoke, and it
// invokes it only when the load is still the newest one on its lane.
// `applyToStores` returns `void`, so it cannot be an awaited async function:
// the currency check and every store write execute in ONE uninterrupted
// synchronous block, with no suspension point in between where a newer load
// could take over. There is therefore no window in which a stale response
// can write — not a small window, none.
//
// Lanes exist because "newest" is per subject: a timeline query does not
// supersede a chat-history load. Add a lane, not a second mechanism.
type StoreWriteLane = "chat-history" | "timeline-query" | `project-chats:${string}`;

const laneGenerations = new Map<StoreWriteLane, number>();

/**
 * Run a load and apply its result to the shared stores only if it is still
 * the newest load on its lane (and, when `isStillCurrent` is supplied, only
 * if the context it was loading for is still the one on screen).
 *
 * The value is ALWAYS returned to the caller — a superseded load is not an
 * error, and its awaiting caller still gets the data it asked for. What it
 * loses is the right to write shared state, which by then belongs to a
 * newer load.
 */
async function loadLatestOnly<T>(
  lane: StoreWriteLane,
  fetchLatest: () => Promise<T>,
  applyToStores: (value: T) => void,
  isStillCurrent?: () => boolean,
): Promise<T> {
  const generation = (laneGenerations.get(lane) ?? 0) + 1;
  laneGenerations.set(lane, generation);
  const value = await fetchLatest();
  // ── no `await` from here to the end of applyToStores ──
  if (laneGenerations.get(lane) !== generation) {
    clientWarn("load", `superseded ${lane} load discarded (generation ${generation})`);
    return value;
  }
  if (isStillCurrent !== undefined && !isStillCurrent()) {
    clientWarn("load", `${lane} load discarded — its context is no longer selected`);
    return value;
  }
  applyToStores(value);
  return value;
}

/**
 * In-flight history reads, keyed by chat id — the REQUEST-level dedup the
 * `loadLatestOnly` gate never provided.
 *
 * `loadLatestOnly` discards a superseded STORE WRITE; it has never stopped a
 * second REQUEST. Nine call sites load the same chat's history (the boot
 * restore, the Flow's self-heal effect, both Switch verbs, the Custody room's
 * open, the rollback control…), and several of them run in the same tick
 * because `selectChat` clears the transcript, which is exactly the condition
 * the Flow effect fires on. Measured consequence: opening the 21,405-message
 * conversation issued the 34,665ms request TWICE, and both aborted at the
 * 30,000ms timeout — the second attempt was guaranteed to fail the same way
 * before it was sent, and it doubled the server's work while it did.
 *
 * There can be at most ONE entry per chat id: a caller that finds one joins
 * it, and the entry is removed when it settles, so no overlap is possible.
 */
const inFlightChatHistory = new Map<string, Promise<ChatHistoryPageView>>();

/**
 * THE CHAT'S RECORD AS THIS TAB LAST CONFIRMED IT — the `updatedAt` of the
 * last history read that the flow on screen is built on (set in
 * `readChatHistory`'s hydrate callback, where `history.chat` is in hand).
 *
 * This is the baseline the FOCUS-TIME RECORD CHECK (UIE-052) compares
 * against: a follower tab that rendered a conversation and then sat in the
 * background is deliberately NOT synced (chat data does not converge
 * between tabs — by design), so the only honest moment to notice the record
 * moved on is when the reader comes BACK. A single-row `GET /api/chats/:id`
 * answers "did it move"; only when it did does the tab re-read through its
 * own existing door (`loadChatHistory` — the exact read a reload performs),
 * which heals the transcript in place: the ingest's `sameRecord` re-pointing
 * keeps every beat's identity, so nothing on screen re-mounts. The manual
 * alternative — a "reload to catch up" hint — is the resume-gap
 * anti-pattern this codebase already ruled out: a manual remedy for
 * something the client knows how to do.
 */
let confirmedChatRecord: Readonly<{ id: string; updatedAt: string }> | null = null;

/**
 * Load full chat history from the DB and hydrate the chat-messages,
 * timeline-refs, and metrics stores in one round-trip. Used on chat switch.
 * The metrics store is set from the latest snapshot for the chat (if any); if
 * there are no snapshots, the store is left untouched so the global metrics
 * (from getMetrics) remain visible.
 *
 * Two gates guard the store writes (see `loadLatestOnly`): this must be the
 * newest chat-history load, AND `chatId` must still be the selected chat. The
 * second gate matters because the chat can be deselected (or changed by a
 * path that does not itself load history) while this request is in flight —
 * the generation alone would not notice.
 *
 * The OUTCOME is stated either way, into `chat-history-load.ts`, because an
 * empty transcript and an unread transcript are different facts and the Flow
 * cannot tell them apart from the message count (L3).
 *
 * Private: `loadChatHistory` is the deduplicating door onto this.
 */
function readChatHistory(chatId: string): Promise<ChatHistoryPageView> {
  noteChatHistoryPending(chatId);
  return loadLatestOnly(
    "chat-history",
    () => getChatHistory(chatId),
    (history) => {
      // The flow on screen is now built on THIS read — the record-check
      // baseline (see `confirmedChatRecord`'s note).
      confirmedChatRecord = { id: chatId, updatedAt: history.chat.updatedAt };
      hydrateChatFromHistory(history);
      // THE RELOAD-ORPHAN RECONCILE (UIE-042): a hydrate that carried
      // "running" tool rows was rebuilt from a run this page cannot hear
      // (it never re-attaches to the live SSE), so those beats would spin
      // forever. The ledger read-back settles what the rows now say —
      // and keeps re-reading while the run is still genuinely live.
      if (hasWorkingToolCallBeats()) reconcileHydratedRunningToolCalls(chatId);
      // THE UNANSWERED-TURN HALF (UIE-076), the same door: an assistant row
      // that started and never ended renders as NOTHING at all (the flow
      // hides empty turns), which erases the turn. The run-status read-back
      // settles the row's honest ending — or heals the words that were kept
      // after all.
      if (hasUnansweredAssistantRows()) reconcileHydratedUnansweredTurns(chatId);
      setTimelineRefs(history.timelineRefs);
      setCurrentTimelineChatId(chatId);
      // FIX: scope the timeline to this chat. Extract the run IDs from
      // the persisted messages (each message has a runId from the run that
      // produced it) and the timeline refs (metadata.runId). The Timeline tab
      // uses `scopedTimelineEvents` to filter the queried events to only those
      // belonging to this chat's runs — instead of showing every event globally.
      const runIdSet = new Set<string>();
      for (const msg of history.messages) {
        if (msg.runId !== null) runIdSet.add(msg.runId);
      }
      for (const ref of history.timelineRefs) {
        const meta = ref.metadata as Record<string, unknown> | null;
        if (meta !== null && typeof meta["runId"] === "string") {
          runIdSet.add(meta["runId"]);
        }
      }
      const chatTitle = history.chat.title;
      scopeTimelineToChat(chatTitle, [...runIdSet], chatId);
      // Proactive: restore the per-chat model selection so the model picker
      // shows the chat's model after a refresh (part of "everything
      // persists"). If the chat has no model, fall back to the default
      // (selectModel(null) → currentModelId resolves to catalog.defaultModel).
      selectModel(history.chat.modelId);
      // Hydrate the metrics store from the latest per-chat snapshot, if any.
      // The MetricsDashboard reads from this store; without this, it would
      // show the global fixture metrics instead of the chat's own.
      const latest = history.metricsSnapshots[history.metricsSnapshots.length - 1];
      if (latest !== undefined) {
        setMetrics(latest.snapshot as MetricsSnapshot);
      }
      // HOW FAR BACK THIS IS. The conversation opened at its TAIL, so the
      // top of what the reader sees is either the start of the conversation
      // or the edge of one page — and only the server can say which
      // (chat-history-reach.ts spells out why the client must not infer it).
      noteReachOpened({
        chatId,
        hasOlder: history.page.hasOlder,
        olderCursor: history.page.olderCursor,
        messageCount: history.page.messageCount,
        loaded: history.messages.length,
      });
    },
    () => currentChatId.get() === chatId,
  ).then(
    (history) => {
      if (currentChatId.get() === chatId) noteChatHistoryRead(chatId);
      return history;
    },
    (error: unknown) => {
      // L3: a load that fails, times out or is truncated SAYS SO, in plain
      // words, with what it could not reach. The title is what the reader
      // calls this conversation; null only when the chat list itself is not
      // loaded, which is its own honest statement. The state is only written
      // for the conversation still on screen — announcing the absence of a
      // conversation the reader already left would be a lie about the one
      // they are looking at.
      if (currentChatId.get() === chatId) {
        const title = chatForId(chatId)?.title ?? null;
        noteChatHistoryUnread(chatId, absenceReason(error), title);
      }
      throw error;
    },
  );
}

/**
 * Load full chat history from the DB and hydrate the chat-messages,
 * timeline-refs, and metrics stores in one round-trip — at most ONCE per
 * chat at a time (see `inFlightChatHistory`). Concurrent callers join the
 * read that is already running instead of issuing a second identical one.
 */
export function loadChatHistory(chatId: string): Promise<ChatHistoryPageView> {
  const running = inFlightChatHistory.get(chatId);
  if (running !== undefined) return running;
  const started = readChatHistory(chatId).finally(() => {
    inFlightChatHistory.delete(chatId);
  });
  inFlightChatHistory.set(chatId, started);
  return started;
}

// ── The focus-time record check (UIE-052) ───────────────────────────────────

/**
 * THE FOLLOWER TAB'S STALENESS, HEALED AT ITS OWN DOOR.
 *
 * What happens on tab focus today, verified: NOTHING re-reads — the
 * follower's transcript stays at whatever it rendered until a reload or a
 * chat re-select, and no hint says so. Chat data deliberately does not
 * converge between tabs (cross-tab.ts adopts device state only), so the
 * honest fix is NOT background sync — it is a check at the one moment the
 * staleness can matter: the reader returning to the surface.
 *
 * The check is two-step and cheap: one row (`GET /api/chats/:id`) answers
 * "did the record move since the history I rendered"; only when it did does
 * the tab re-read through `loadChatHistory` — the SAME read a reload
 * performs, with all of its guards (freshness gates, in-flight dedup), and
 * with the in-place heal that read already owns (`sameRecord` keeps every
 * beat identity; a re-read of an unmoved-but-confirmed record is a no-op on
 * screen). The tab's OWN runs trigger the re-read once on the next focus —
 * harmless by the same `sameRecord` path, and the baseline refreshes so the
 * check stays quiet from there.
 *
 * A record that moved means a run recorded new data into this conversation,
 * so the re-read fires the declared `run:done` Broker invalidation: every
 * run-scoped surface holding the pre-move answer — the sweep band's spectrum
 * above all — re-reads through its own door, and the two surfaces of one
 * conversation converge together instead of the healed transcript standing
 * beside a stale spectrum until the band's own next trigger.
 *
 * Skipped while THIS tab's run is live (`isStreaming`): a re-read mid-run
 * would rebuild the log against a persisted row that lags the streaming
 * tail. A foreign run still live elsewhere adopts partially, exactly as a
 * reload does — the hydrate-time reconcile (UIE-042) settles its working
 * faces on its own cadence.
 *
 * Installed by the cockpit entry (`bootCockpit`), like the liveness watch:
 * "this page just became the one the reader is looking at" is an
 * entry-point fact. Failures are reported through `clientWarn` and change
 * nothing on screen — the surface keeps its beats; the flow's own unread
 * machinery owns read failures.
 */
export function startChatRecordWatch(): () => void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
    return () => {};
  }
  let checking = false;
  const check = (): void => {
    if (checking) return;
    const chatId = currentChatId.get();
    if (chatId === null || isStreaming.get()) return;
    checking = true;
    void (async () => {
      try {
        const row = await getChat(chatId);
        if (currentChatId.get() !== chatId) return; // switched while reading
        const confirmed = confirmedChatRecord;
        if (
          confirmed !== null &&
          confirmed.id === chatId &&
          row.updatedAt <= confirmed.updatedAt
        ) {
          return; // the record has not moved since what is on screen
        }
        await loadChatHistory(chatId); // the tab's own door; refreshes the baseline
        // THE OTHER SURFACES OF THE SAME CONVERSATION (UIE-053): the heal
        // above converged the transcript, but every run-scoped read the page
        // still holds — above all the sweep band's spectrum — answers the
        // record from BEFORE it moved, and none of the band's own triggers
        // (scope change, this tab's stream close) fired. The shared door is
        // the Broker invalidation the band's read already declared
        // (`invalidateOn: ["run:done"]`): firing it drops the moved-past
        // cached entry and wakes every surface that declared the event, each
        // through its own read — no second fetch path. A direct call to the
        // band's refetch would NOT do: inside the read's TTL the Broker
        // would serve the stale bytes back. Rides the SAME gate — an unmoved
        // record returns above, so focus alone never pays a spectrum read.
        fireInvalidation("run:done");
      } catch (err) {
        clientWarn("chat-record", "focus-time record check failed:", err);
      } finally {
        checking = false;
      }
    })();
  };
  const onVisibility = (): void => {
    if (document.visibilityState === "visible") check();
  };
  window.addEventListener("focus", check);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.removeEventListener("focus", check);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

/**
 * ── TRAVEL BACKWARDS: one page of OLDER messages, as a DELTA ─────────────
 *
 * The user's binding instruction is *"ui should only target specific updates
 * via sse, not full page, only update what changes"* and *"do lazy
 * loadings"*. A page of older beats is a delta: nothing already on screen is
 * refetched, nothing is re-hydrated, and the transcript is EXTENDED at the
 * front rather than replaced.
 *
 * Refuses, silently and by design, when there is nothing to do: no reach on
 * record, a reach for another conversation, nothing older, or a page already
 * in flight. Those are not errors — they are the reader asking for something
 * they already have — and reporting them would put a message on screen for a
 * scroll gesture.
 *
 * Returns how many messages were really added, so a caller (the flow, deciding
 * whether one page was enough to fill the viewport) reasons about what
 * happened rather than about what was requested.
 *
 * ONE PAGE AT A TIME, and the guard is the reach's own `loading` flag rather
 * than a second map: a scroll gesture fires many events, and the failure mode
 * this prevents is the same one `inFlightChatHistory` prevents for the open —
 * N identical requests, each of which will succeed, delivering the same page
 * N times.
 */
export async function loadOlderHistory(chatId: string): Promise<number> {
  const reach = historyReach.get();
  if (reach === null || reach.chatId !== chatId) return 0;
  if (!reach.hasOlder || reach.olderCursor === null || reach.loading) return 0;
  const cursor = reach.olderCursor;
  noteReachLoading(chatId);
  try {
    const page = await getChatMessagePage(chatId, cursor);
    // The conversation may have been left while the page was in flight.
    // Splicing it into whatever transcript is on screen now would insert one
    // conversation's messages into another's — the same class of failure
    // `loadLatestOnly` exists to prevent for the open, at the other end.
    if (currentChatId.get() !== chatId) return 0;
    const added = prependMessages(chatId, messagesFromRows(page.messages, page.toolCalls));
    noteReachExtended(chatId, added, page.page);
    return added;
  } catch (error: unknown) {
    // The messages are still there and the cursor still addresses them, so
    // `hasOlder` is deliberately NOT cleared. Rendering "this is the
    // beginning of the conversation" because a request failed would be a
    // fabricated absence (§1 L3) — the reader would be told the transcript
    // ends where the network did.
    if (currentChatId.get() === chatId) noteReachFailed(chatId, absenceReason(error));
    return 0;
  }
}

// ── Public API: SSE streams ──

export type StreamHandlers = {
  /** Fired on the `connected` event — the server's stream-open
   * acknowledgment carrying the runId, the harness-ready flag, + the
   * bound chatId. Wired (SPO) so the server-emitted `connected` event
   * has a client listener (completes the server↔client event contract —
   * previously the server emitted `connected` but the client dropped it,
   * a drift the sse-event-owner contract test now catches). */
  readonly onConnected?: (data: { runId: string; harnessReady: boolean; chatId: string | null }) => void;
  readonly onModelEvent?: (event: ModelEvent, applied?: boolean, replayed?: boolean) => void;
  readonly onTimelineEvent?: (event: TimelineEventRecord) => void;
  readonly onAgentState?: (agent: AgentState) => void;
  readonly onContextEvent?: (context: RunContext) => void;
  readonly onDedup?: (summary: unknown) => void;
  readonly onUiControl?: (action: UiControlAction) => void;
  readonly onError?: (error: ClientError) => void;
  /** The transport ended (terminal frame, permanent native close, or
   * rejected acknowledgment). Always called, including for a background
   * run; workspace callbacks are scoped separately. Carries no UI error. */
  readonly onRunSettled?: () => void;
};

export type StreamController = {
  readonly close: () => void;
};

/**
 * Shared error handler for the three SSE event listeners (model/timeline/
 * agent). They all parse a JSON event and surface a parse failure the same
 * way: log it to the structured errors store and forward to the caller's
 * onError. Extracted so the three listeners share one implementation
 * (prevention: no-duplicate-code).
 */
function handleStreamError(err: unknown, handlers: StreamHandlers): void {
  const msg = err instanceof ClientError ? err.message : String(err);
  const code = err instanceof ClientError ? err.code : "parse";
  // Route through the centralized client debug owner so a stream parse
  // failure is visible in the browser console when client debug is on
  // (zero-overhead when off).
  clientWarn("sse", "stream error", err);
  appendError("parse", msg, code);
  handlers.onError?.(err instanceof ClientError ? err : new ClientError("parse", msg));
}

/**
 * The server-reported failure carried on an SSE `error` frame: the run's
 * REAL taxonomy code (the same vocabulary `{ error: <code> }` carries over
 * REST) plus the server's message.
 */
type SseErrorFrame = Readonly<{
  code: string;
  message: string;
  /** Present when the run that failed ALSO reverted its gate auto-trips on
   * the way out (the terminal frame's side-effect fact — see
   * `announceAutoTripRevert`). */
  autoTripsReverted?: boolean;
  eventId?: string;
}>;

/**
 * THE RUN'S ENDING ANNOUNCES ITS BREAKER REVERT (UIE-041) — the one owner
 * of the flag→invalidation wire, crossed by every terminal frame listener.
 *
 * The gate auto-trip's REVERT is a server-side row write no verb of the
 * breaker panel fired, so without this the panel's cached rows keep the
 * ▲ TRIPPED face and the annunciator's reset offer for minutes after the
 * wire already reads "on". The server stamps `autoTripsReverted: true` on
 * the terminal frame (done/cancelled/error alike — every exit crosses the
 * one publish); this turns it into the SAME `tools:changed` invalidation
 * the panel's own verbs fire — the exact mirror of the trip's own
 * `autoTripped` flag on the hallucination frame (UIE-036). Absent/false
 * fires nothing: an invalidation nobody's data changed is the cry-wolf
 * shape.
 */
function announceAutoTripRevert(autoTripsReverted: unknown): void {
  if (autoTripsReverted === true) fireInvalidation("tools:changed");
}

/**
 * Read a server-sent `error` frame off the raw DOM event, or `null` when
 * there is no frame to read.
 *
 * `null` means the event was EventSource's NATIVE error — a bare `Event`
 * with no `data`, fired when the transport itself failed. In that case the
 * server sent nothing, so there is nothing the client can honestly say
 * about the cause; the caller falls back to describing the transport state
 * it can actually observe. It must NOT invent a reason.
 *
 * Deny-by-default on the frame contract: a frame that is unparseable, or
 * that arrives with no `code`, is reported as `malformed` — the truthful
 * statement that the server's own error report did not conform — rather
 * than being quietly given a plausible-looking code. The server side is
 * held to the contract mechanically (tests/prevention/sse-error-code-owner
 * .test.ts fails if any `error` frame is emitted without a code), so this
 * branch is a floor, not the expected path.
 */
function parseSseErrorFrame(e: Event): SseErrorFrame | null {
  const data = (e as Partial<MessageEvent>).data;
  if (typeof data !== "string" || data.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    clientWarn("sse", "error frame was not valid JSON", data);
    return { code: "malformed", message: "The server reported an error but the report could not be read." };
  }
  if (parsed === null || typeof parsed !== "object") {
    clientWarn("sse", "error frame was not an object", parsed);
    return { code: "malformed", message: "The server reported an error but the report could not be read." };
  }
  const obj = parsed as Record<string, unknown>;
  const message = typeof obj["message"] === "string" && obj["message"].length > 0
    ? obj["message"]
    : "The server reported an error but sent no message.";
  const code = obj["code"];
  const autoTripsReverted = obj["autoTripsReverted"] === true ? { autoTripsReverted: true as const } : {};
  if (typeof code !== "string" || code.length === 0) {
    clientWarn("sse", "error frame carried no code — the SSE error contract was violated", obj);
    return { code: "malformed", message, ...autoTripsReverted };
  }
  return { code, message, ...autoTripsReverted, ...(typeof obj["eventId"] === "string" ? { eventId: obj["eventId"] } : {}) };
}

/** What the standing liveness stream reports to its watcher. */
export type LivenessHandlers = Readonly<{
  /** The connection opened, or a beat arrived. Both mean the same thing —
   *  the server is there — and are reported the same way. */
  onAlive: () => void;
  /**
   * The stream dropped, or could not be opened.
   *
   * `retrying` is the browser's own answer, read off `readyState`, and the
   * caller MUST respect it. EventSource reconnects by itself after a plain
   * network error (`CONNECTING`), but the spec tells it to FAIL THE
   * CONNECTION PERMANENTLY (`CLOSED`) when the server answers with a non-2xx
   * status or the wrong content type — after which it never retries again.
   *
   * That is not a corner case here, it is the normal dev path: with the API
   * stopped, the Vite proxy answers `502 text/plain`, which is exactly the
   * "permanent failure" shape. Browser-measured — the block appeared in 33ms
   * and then never cleared, because the stream had been closed for good and
   * nothing was left to notice the server return.
   */
  onDown: (info: Readonly<{ retrying: boolean }>) => void;
}>;

/**
 * Open THE STANDING LIVENESS STREAM (`/api/live`) — the socket that tells the
 * page whether the API is there, without the page ever asking.
 *
 * Its handlers are deliberately tiny: this stream carries no application data
 * and must never grow any. The moment it carried something a surface rendered,
 * a reconnect would become a data event and the connection state would stop
 * being a fact about the CONNECTION.
 *
 * The browser owns the reconnect loop. The server writes SSE's `retry:` field
 * (`LIVE_STREAM_RETRY_MS`), so after a drop the browser reconnects on that
 * cadence by itself — including throughout an outage, using the value it was
 * given before the outage started. There is no timer on this side, in either
 * direction.
 *
 * Returns the stop function. Calling it closes the socket AND stops the
 * browser's reconnect loop, which is the only way to do so — an EventSource
 * left open retries forever by design.
 */
export function openLivenessStream(handlers: LivenessHandlers): () => void {
  const es = new EventSource(LIVE_STREAM_PATH);

  // THE PROTOCOL'S OWN OPEN EVENT. No hello frame is needed or sent: the
  // browser reports the established connection itself.
  es.onopen = () => {
    handlers.onAlive();
  };

  // The beat. Its ARRIVAL is the whole payload — the body is empty and is
  // never read. A server whose event loop has wedged holds this socket open
  // and stops beating, and that silence is the only symptom there is.
  es.addEventListener(SSE_EVENT_TYPES.ping, () => {
    handlers.onAlive();
  });

  // EventSource fires `error` both when the connection drops and when a
  // reconnect attempt fails. What separates them is `readyState`, and it is
  // the difference between "the browser is handling it" and "the browser has
  // given up and will never try again" — see `onDown`.
  es.onerror = () => {
    handlers.onDown({ retrying: es.readyState === EventSource.CONNECTING });
  };

  return () => {
    es.close();
  };
}

/**
 * WHY THE LIVENESS STREAM WOULD NOT OPEN — asked of the server, once.
 *
 * ── THE QUESTION EventSource CANNOT ANSWER ─────────────────────────────────
 *
 * `es.onerror` fires with no status, no headers and no body. Two completely
 * different situations arrive at it identically, and they call for opposite
 * responses:
 *
 *   AN OUTAGE   nothing is listening. Retry fast (LIVE_STREAM_RETRY_MS) —
 *               that is what makes recovery feel instant.
 *   A REFUSAL   the server answered and declined (429, its connection cap).
 *               Retrying fast CANNOT succeed, and the retries are what keep
 *               the condition alive: browser-observed, four `GET /api/live`
 *               429s a second, forever, with the cockpit blocked behind "The
 *               harness API is not answering" over a server answering
 *               everything else.
 *
 * So the cause is MEASURED rather than assumed, by the same rule the rest of
 * the connection instrument uses: a response carrying `API_IDENTITY_HEADER`
 * means the API itself answered (`src/data/connection.ts`), whatever the
 * status is. A 429 is therefore proof the server is REACHABLE — the opposite
 * of what the page used to conclude from it.
 *
 * ── WHY IT PROBES THE LIVENESS PATH ITSELF ─────────────────────────────────
 *
 * Any endpoint would prove the API is up. Only this one can say whether THIS
 * stream is being refused, and only it carries the server's own `Retry-After`
 * — so the backoff is the server's number, not one the client invented.
 *
 * IT MUST NOT HOLD THE SLOT IT IS ASKING ABOUT. A 200 here is a real event
 * stream, so the response is aborted the instant its headers arrive; the
 * server sees the disconnect and releases the slot. In the case that matters
 * — the budget already exhausted — no slot is taken at all, because the
 * request is refused before one is acquired.
 */
export type LivenessDiagnosis =
  /** The API answered and the stream may be opened. */
  | Readonly<{ outcome: "answered" }>
  /** The API answered and DECLINED. `retryAfterMs` is the server's own
   *  interval where it sent one. Reachable — just not admitted. */
  | Readonly<{ outcome: "refused"; retryAfterMs: number }>
  /** Nothing answered for the API. `elapsedMs` is MEASURED — how long the
   *  failure took to come back, never invented. */
  | Readonly<{ outcome: "unreached"; elapsedMs: number }>;

/** The status the server's own taxonomy gives the SSE connection cap —
 *  RESOLVED through the shared resolver rather than retyped as a literal, so
 *  the two sides cannot drift into disagreeing about what a refusal looks
 *  like on the wire. */
const SSE_REFUSED_STATUS = resolveStatus("sse_connection_limit");

export async function diagnoseLivenessConnection(): Promise<LivenessDiagnosis> {
  const startedAt = Date.now();
  const abort = new AbortController();
  let res: Response;
  try {
    res = await fetch(LIVE_STREAM_PATH, {
      signal: abort.signal,
      headers: { Accept: "text/event-stream" },
    });
  } catch {
    // No response at all: a refused socket, a DNS failure, an abort of our
    // own. Nothing answered, and that is the whole finding.
    return { outcome: "unreached", elapsedMs: Date.now() - startedAt };
  }
  // Release it immediately — see the header. `fetch` resolves on headers, so
  // this happens before any body is read.
  abort.abort();
  // The same conjunction the connection owner uses, for the same reason: the
  // header proves the API answered; a gateway-class status alone does not,
  // and the API itself answers 502 when a model provider fails. A response
  // with no readable headers is a test double, which is a response.
  const headers: Headers | undefined = res.headers;
  const signed =
    typeof headers?.get !== "function" ||
    headers.get(API_IDENTITY_HEADER) !== null;
  if (!signed && GATEWAY_UNREACHED_STATUSES.includes(res.status)) {
    return { outcome: "unreached", elapsedMs: Date.now() - startedAt };
  }
  if (res.status === SSE_REFUSED_STATUS) {
    return { outcome: "refused", retryAfterMs: retryAfterMsFrom(headers) };
  }
  return { outcome: "answered" };
}

/**
 * The server's `Retry-After`, in ms. RFC 9110 allows seconds or a date; the
 * router only ever sends seconds, so a value that does not parse as a
 * positive number of seconds falls back to the stated default rather than to
 * a guess. Never returns 0 — a zero backoff is the defect this exists to
 * prevent.
 */
function retryAfterMsFrom(headers: Headers | undefined): number {
  const raw = typeof headers?.get === "function" ? headers.get("Retry-After") : null;
  const seconds = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000
    : LIVE_STREAM_REFUSED_RETRY_MS;
}

export function openRunStream(
  runId: string,
  handlers: StreamHandlers,
): StreamController {
  const url = `${API_BASE}/run/${encodeURIComponent(runId)}/stream`;
  const es = new EventSource(url);

  /**
   * WHICH CONVERSATION THIS STREAM'S WORDS BELONG TO.
   *
   * The transcript store holds ONE chat's messages and is written with no
   * chat check at all, so a run streaming for chat B while chat A is on
   * screen commits B's text into A's last assistant message and appends B's
   * tool calls to A's list. The corruption happens below anything the caller
   * owns: by the time a beat could be attributed, two conversations have been
   * concatenated.
   *
   * IT DOES NOT HAVE TO BE THREADED THROUGH THE CALLERS. Every caller passing
   * a chatId down was rejected as too invasive, and correctly — but it was
   * also unnecessary: the chat id is ALREADY ON THE WIRE. The server's
   * `connected` frame carries it, that frame is always the first one, it
   * survives a reconnect after the run has ended (the feed keeps the owner
   * past the registry's forgetting), and this listener already parses it. So
   * the stream latches its own answer and no caller changes at all — not
   * `beginChatRun`, not the cockpit's send path, not the reopen closure.
   *
   * `null` means the run is bound to no chat (a legacy chat-less run), which
   * is not a mismatch and is not treated as one.
   */
  let streamChatId: string | null = null;
  let closed = false;
  let initialized = false;
  let protocolRejected = false;
  // The single write door for both transcript and second-consumer callbacks.
  // connected must first learn the server's owner; its callback uses this
  // same door after the latch. A late older run cannot settle a newer view.
  const claimScreen = (): boolean => {
    if (closed || (streamChatId !== null && currentChatId.get() !== streamChatId)) return false;
    const foreground = currentRun.get();
    if (foreground !== null && foreground.runId !== runId) return false;
    if (!initialized) {
      pendingDedup = null;
      pendingRedaction = null;
      initialized = true;
    }
    return true;
  };

  /**
   * ONE MEASURED WRAPPER for every listener this stream registers. The
   * dispatch-to-applied cost — from the event loop handing the page the
   * frame to the stores holding it — is the client's own latency fact
   * about the feed, and wrapping every registration through this one
   * local helper keeps the measurement at the single choke point all run
   * frames pass, with no listener able to register beside it. The
   * telemetry owner aggregates per run and reports at run end; its side
   * is guarded, so the measurement can never throw into a listener, and
   * the listener's own errors keep their existing path.
   */
  const measured = <E extends Event>(frame: string, listener: (e: E, errorFrame: SseErrorFrame | null) => void): (e: E) => void => {
    return (e: E) => {
      if (closed) return;
      const appliedAt = performance.now();
      // Transport errors reconnect unless the native source is CLOSED or
      // the server sent an actual error frame. Use the shared terminal
      // vocabulary; workspace isolation must never suppress this cleanup.
      const errorFrame = frame === SSE_EVENT_TYPES.error ? parseSseErrorFrame(e) : null;
      const terminal = isTerminalSseEventType(frame) && (frame !== SSE_EVENT_TYPES.error ||
        errorFrame !== null || es.readyState === EventSource.CLOSED);
      try {
        if (frame === SSE_EVENT_TYPES.connected || claimScreen()) listener(e, errorFrame);
      } finally {
        noteRunFrameApplied(runId, frame, performance.now() - appliedAt);
        if (terminal || protocolRejected) {
          closed = true;
          es.close();
          try { handlers.onRunSettled?.(); }
          finally { finishRunTelemetry(runId); }
        }
      }
    };
  };

  // The `connected` event is the server's stream-open acknowledgment. It
  // carries the runId (validated to match the requested run — catches a
  // server/proxy mismatch), the harness-ready flag, + the bound chatId.
  // Wired (SPO) so the server-emitted event has a client listener
  // (completes the server↔client event contract).
  es.addEventListener(SSE_EVENT_TYPES.connected, measured(SSE_EVENT_TYPES.connected, (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { runId: string; harnessReady: boolean; chatId: string | null };
      assertString(data.runId, "connected.runId");
      if (data.runId !== runId) {
        throw new ClientError("malformed", "The run stream acknowledged a different run.");
      }
      streamChatId = typeof data.chatId === "string" ? data.chatId : null;
      // The telemetry owner's own latch for the same fact: the chat this
      // run's client-side facts will be correlated with when they report.
      noteRunChat(runId, streamChatId);
      if (claimScreen()) handlers.onConnected?.(data);
    } catch (err) {
      protocolRejected = true;
      if (claimScreen()) handleStreamError(err, handlers);
    }
  }));

  es.addEventListener(SSE_EVENT_TYPES.model, measured(SSE_EVENT_TYPES.model, (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as ModelEvent & { eventId?: string; assistantMessageId?: string; messageId?: string; replayed?: boolean };
      assertString(data.type, "ModelEvent.type");
      const applied = acceptModelFrame(runId, data.assistantMessageId, data);
      if (applied) {
        ingestModelEvent(runId, streamChatId, data, data.eventId, data.messageId, data.replayed === true);
      }
      handlers.onModelEvent?.(data, applied, data.replayed === true);
      // After a "finish" event, do NOT close the EventSource — the server
      // may send more turns (steering) or a terminal "done" event. The
      // client closes on the "done" event (terminal) or "error" event.
      // FIX for H1: closing on "finish" was a race condition that dropped
      // the "steered" event.
      if (data.type === "error") {
        // A FAILED CALL IS A CALL-LEVEL BEAT, NOT THE RUN'S ENDING. The
        // server's turn loop treats the failed call exactly that way: the
        // call's stream ends, the failure is recorded as a CANDIDATE
        // ending, and a steer that arrived while the call streamed drives a
        // drain turn that runs on to the run's own terminal frame — every
        // frame after the failure is published to THIS socket, and closing
        // here is what made a steered continuation's answer unreachable
        // without a reload while the run honestly continued and ended
        // `done`. The stream now closes on the run's own terminal frames
        // (`done`/`cancelled`/`error` — the shared terminal vocabulary,
        // which a live client receives because it stayed open), and the
        // run-level acts — the view's settle already happened in the
        // ingest above, the ingest report's flush — belong to whichever
        // terminal door ends the run; a transport that dies before any
        // terminal arrives still ends at a flushing door (the CLOSED
        // branch). What IS settled here is per-call: a tool the failed
        // call left in flight will never receive its result, and the
        // continuation cannot unstrand it, so the safety net's observation
        // names the failed call now.
        finalizeStrandedToolCalls("the run's call failed before this tool returned a result");
      }
    } catch (err) {
      handleStreamError(err, handlers);
    }
  }));

  es.addEventListener(SSE_EVENT_TYPES.timeline, measured(SSE_EVENT_TYPES.timeline, (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as TimelineEventRecord;
      assertString(data.eventType, "TimelineEventRecord.eventType");
      // ingest relevant timeline events as inline chat messages so
      // hallucination, steering, bias, self-healing, and error events appear
      // in the chat when they happen. Only events that are meaningful to the
      // user inline are ingested; the full timeline still lives in the
      // Timeline tab. This runs BEFORE the handler callback so the inline
      // message is appended even if no handler is attached.
      ingestInlineTimelineEvent(data);
      handlers.onTimelineEvent?.(data);
    } catch (err) {
      handleStreamError(err, handlers);
    }
  }));

  es.addEventListener(SSE_EVENT_TYPES.agent, measured(SSE_EVENT_TYPES.agent, (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as AgentState;
      assertString(data.agentId, "AgentState.agentId");
      upsertAgent(data);
      handlers.onAgentState?.(data);
    } catch (err) {
      handleStreamError(err, handlers);
    }
  }));

  es.addEventListener(SSE_EVENT_TYPES.steered, measured(SSE_EVENT_TYPES.steered, (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as {
        runId: string;
        remaining: number;
        delivery?: "composed" | "drain";
        /** The ledger address of this announcement's own row — present
         * whenever the server persisted the event, so a re-attach's replay
         * joins the record instead of appending a twin. */
        eventId?: string;
      };
      assertString(data.runId, "steered.runId");
      // A steering message was consumed — delivered exactly once. The
      // delivery field says which shape happened, and the copy must not
      // blur the two: "drain" means the loop started a new turn FOR the
      // instruction (no further turn would otherwise run); "composed"
      // means a turn that was starting anyway (a tool-call continuation)
      // carries it. Set streaming true so the UI shows the "streaming"
      // state for the turn (it was set to false by the previous finish
      // event), and count the queue down to what the server says is
      // still waiting.
      const drainTurn = data.delivery !== "composed";
      setStreaming(true);
      setQueuedSteers(assertNumber(data.remaining, "steered.remaining"));
      // A TURN IS OPENING, SO THE RUN IS LIVE. The frame that says so is
      // the earliest wire evidence a run CONTINUES — on the drain path it
      // can arrive right after a failed call's model error settled the
      // view "error" and armed its retirement, and reporting the live
      // status here cancels that arm before it can retire a run whose
      // continuation is already streaming: the pane's clock and stop verb
      // return, and a send steers the live run instead of starting a new
      // one. On the composed path the status is already "running" and the
      // report is idempotent.
      updateRunStatus("running");
      // show an inline steering event so the user sees that their
      // mid-run message was consumed — in the words of the shape that
      // actually delivered it, never a copy that claims a new turn when
      // the instruction rode one that was already starting. The frame's
      // own ledger address rides along, so the run-end ledger replay (and
      // a re-attach's replay of this frame) joins this beat instead of
      // appending a same-words twin beside the record's row.
      appendEventMessage(
        "steering",
        drainTurn
          ? `Steered — new turn starting (${data.remaining} queued)`
          : `Steered — delivered in the turn that is starting (${data.remaining} queued)`,
        data.eventId,
      );
      handlers.onModelEvent?.({ type: "start" } as ModelEvent);
    } catch (err) {
      handleStreamError(err, handlers);
    }
  }));

  // "context" events expose the injected context (system prompt, available
  // tools, conversation history length, model id) so the user can inspect
  // exactly what was sent to the model. Attached to the current assistant
  // message and shown in a collapsible "Context" section (expose-everything).
  es.addEventListener(SSE_EVENT_TYPES.context, measured(SSE_EVENT_TYPES.context, (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as {
        runId: string;
        systemPrompt: string;
        toolCount: number;
        toolNames: string[];
        historyLength: number;
        modelId?: string;
        recalledMemoryCount?: number;
        contextTokens?: number;
        historyTokens?: number;
        contextTokenLimit?: number;
        contextTrimmed?: boolean;
      };
      assertString(data.runId, "context.runId");
      assertString(data.systemPrompt, "context.systemPrompt");
      // Preserve EVERY field the server sends (one
      // unified pipeline; no data dropped). Previously the
      // context manager fields (contextTokens/contextTokenLimit/
      // contextTrimmed/recalledMemoryCount) were dropped here, so the
      // Metrics → Context section showed empty on a live run even though
      // the server sent + persisted them. The RunContext type is the
      // contract authority; these fields are now declared on it.
      const ctx: RunContext = {
        systemPrompt: data.systemPrompt,
        toolNames: Object.freeze([...data.toolNames]),
        historyLength: data.historyLength,
        ...(data.modelId !== undefined ? { modelId: data.modelId } : {}),
        ...(typeof data.recalledMemoryCount === "number" ? { recalledMemoryCount: data.recalledMemoryCount } : {}),
        ...(typeof data.contextTokens === "number" ? { contextTokens: data.contextTokens } : {}),
        ...(typeof data.historyTokens === "number" ? { historyTokens: data.historyTokens } : {}),
        ...(typeof data.contextTokenLimit === "number" ? { contextTokenLimit: data.contextTokenLimit } : {}),
        ...(data.contextTrimmed === true ? { contextTrimmed: true } : {}),
      };
      // Buffer the context: the "context" event arrives BEFORE the "start"
      // model event creates the assistant message. Buffer it here and attach
      // on "start" so it lands on the assistant message, not the user's.
      pendingContext = ctx;
      handlers.onContextEvent?.(ctx);
    } catch (err) {
      handleStreamError(err, handlers);
    }
  }));

  // "metadata" events forward non-ModelEvent metadata (response headers,
  // actual model) out-of-band. The canonical ModelEvent schema is closed,
  // so headers/model arrive here instead of as model events. Attached to
  // the current assistant message and shown in a collapsible "Headers"
  // section + a model badge (expose-everything).
  es.addEventListener(SSE_EVENT_TYPES.metadata, measured(SSE_EVENT_TYPES.metadata, (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as {
        runId: string;
        headers?: Record<string, string>;
        model?: string;
        traceId?: string;
      };
      assertString(data.runId, "metadata.runId");
      // The run's request trace — the metadata-frame wiring's own id —
      // latched for the
      // telemetry correlation: the ingest report joins the ledger chain
      // this trace names.
      if (typeof data.traceId === "string") latchRunTrace(runId, data.traceId);
      // The assistant turn's metadata, wherever that message sits — after a
      // tool call the literal last message is a tool card, and stamping the
      // model badge onto it was the same dropped-frame class as the usage
      // case (ingestModelEvent's "usage" branch states it in full).
      updateLastAssistantMessage((m) => ({
        ...m,
        ...(data.headers !== undefined ? { responseHeaders: Object.freeze({ ...data.headers }) } : {}),
        ...(data.model !== undefined ? { responseModel: data.model } : {}),
        ...(data.traceId !== undefined ? { traceId: data.traceId } : {}),
      }));
    } catch (err) {
      handleStreamError(err, handlers);
    }
  }));

  // "dedup" events report per-turn input dedup/compression stats (char
  // reduction, removed blocks) for the LLM call that is about to stream —
  // the savings that apply to that call's input.
  es.addEventListener(SSE_EVENT_TYPES.dedup, measured(SSE_EVENT_TYPES.dedup, (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { runId: string } & Record<string, unknown>;
      assertString(data.runId, "dedup.runId");
      const { runId: _runId, ...summary } = data;
      // The snapshot is built ONCE — the live store and the turn's record
      // consume the same value, so the two can never disagree. Previously
      // the handler relied SOLELY on `handlers.onDedup?.()`, which no
      // caller wired — the summary was parsed then dropped (wired but
      // inert). The typed snapshot makes the signal available to every
      // consumer via the shared store.
      const snapshot: DedupSnapshot = {
        applied: typeof summary.applied === "boolean" ? summary.applied : true,
        originalChars: typeof summary.originalChars === "number" ? summary.originalChars : 0,
        dedupedChars: typeof summary.dedupedChars === "number" ? summary.dedupedChars : 0,
        charReductionPct: typeof summary.charReductionPct === "number" ? summary.charReductionPct : 0,
        removedBlocks: typeof summary.removedBlocks === "number" ? summary.removedBlocks : 0,
        removedLines: typeof summary.removedLines === "number" ? summary.removedLines : 0,
        messageCount: typeof summary.messageCount === "number" ? summary.messageCount : 0,
        ...(typeof summary.runId === "string" ? { runId: summary.runId } : {}),
      };
      setDedupSnapshot(snapshot);
      // Buffer for the turn this call is about to open. The event fires
      // before the request — hence before the "start" frame creates the
      // assistant message — which is exactly the "context" event's
      // arrival shape: held here, attached when the message exists. The
      // buffer is CONSUMED by that attach, so a later turn whose call
      // removed nothing (no event) attaches nothing and inherits the
      // previous turn's savings never.
      pendingDedup = snapshot;
      handlers.onDedup?.(summary);
    } catch (err) {
      handleStreamError(err, handlers);
    }
  }));

  // "redaction" events report that the server MASKED SOMETHING before the
  // model saw it: how many values, split by how confidently each was
  // identified, and a value-free reason for each. The server sends this only
  // when a turn actually masked something, so a received event always means
  // the model's input really was rewritten.
  //
  // The counts are kept SEPARATE all the way to the store. `proven` (the
  // value equalled a credential this server holds) and `inferred` (a
  // declaration phrase introduced it and its shape agreed) are different
  // claims, and collapsing them into one total would present a guess with
  // the authority of a fact.
  // PART OF THIS RUN IS MISSING FROM WHAT YOU CAN SEE, AND SAYING SO IS THE
  // WHOLE POINT.
  //
  // A run's frames live in a bounded replay buffer. Reconnecting from a
  // sequence older than the buffer still holds means the frames in between are
  // genuinely gone — not delayed, gone. The alternative to reporting it is a
  // transcript that silently skips, which reads as a complete answer and is
  // not one. An unreported gap is a fabricated continuity, and absence over
  // fabrication applies to a hole in a stream exactly as it applies to a
  // number nobody measured.
  //
  // It is deliberately NOT an error: the run is fine, and the client does not
  // close the stream. What follows the gap is real and still worth showing.
  es.addEventListener(SSE_EVENT_TYPES.replayGap, measured(SSE_EVENT_TYPES.replayGap, (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as {
        runId: string;
        droppedThroughSequence?: unknown;
        resumedFrom?: unknown;
        reason?: unknown;
      };
      assertString(data.runId, "replay_gap.runId");
      const through =
        typeof data.droppedThroughSequence === "number" ? data.droppedThroughSequence : 0;
      const from = typeof data.resumedFrom === "number" ? data.resumedFrom : 0;
      const missing = through > from ? through - from : 0;
      // TWO DISAGREEMENTS, TWO SENTENCES. The frame reports either that the
      // buffer no longer holds what was asked for, or that the position asked
      // from is one the run never reached. Telling a reader "updates were
      // dropped" in the second case would name a loss that did not happen —
      // the run produced everything it was going to; this connection's idea
      // of where it had got to is what is wrong.
      const ahead = data.reason === "resume_point_ahead_of_run";
      // THE THIRD REASON: the server withheld ONE frame it could not make
      // safe to show (nothing unredacted leaves it). Nothing was lost to the
      // connection and no replay buffer ran out: saying "dropped while the
      // connection was away" would name a loss that did not happen.
      const withheld = data.reason === "frame_unredactable";
      if (withheld) {
        appendChatError(
          "One update of this run could not be shown safely, so it was withheld. Everything else in this run is shown.",
        );
      } else if (ahead) {
        // THE GAP HEALS ITSELF IN PLACE. The run is complete and
        // saved; only this connection's idea of its position was wrong — so
        // the remedy is the SAME history read every other path uses
        // (`loadChatHistory` hydrates the transcript stores where they
        // stand), not an instruction to reload the page. The notice below is
        // written first and is honest at the moment it is written ("being
        // reloaded"); a successful hydrate replaces the transcript with the
        // saved conversation, which is the resolution, while a failed one
        // leaves the notice standing and adds the manual fallback —
        // chat-history-load.ts records the absence in its own words either
        // way. A stream bound to no open conversation has nothing to reload
        // into, and says so with the fallback sentence directly.
        const cid = currentChatId.get();
        if (cid !== null) {
          appendChatError(
            "This connection asked to continue this run from a point it never reached, so nothing could be replayed here. The saved conversation, which is complete, is being reloaded in place.",
          );
          void loadChatHistory(cid).catch(() => {
            appendChatError(
              "The saved conversation could not be reloaded here. Reload the page to see it — it is complete.",
            );
          });
        } else {
          appendChatError(
            "This connection asked to continue this run from a point it never reached, so nothing could be replayed here. Reload to see the saved conversation, which is complete.",
          );
        }
      } else {
        appendChatError(
          missing > 0
            ? `Part of this run is missing from the transcript: ${String(missing)} update${missing === 1 ? "" : "s"} were dropped while the connection was away. Everything after this point is complete, and the saved conversation is unaffected.`
            : "Part of this run could not be replayed after the connection came back. Everything after this point is complete, and the saved conversation is unaffected.",
        );
      }
      appendError(
        "stream",
        withheld
          ? "a frame the server could not redact was withheld"
          : ahead
            ? "the resume position was past everything the run published"
            : "replay buffer no longer held the requested frames",
        "replay_gap",
      );
    } catch (err) {
      handleStreamError(err, handlers);
    }
  }));

  es.addEventListener(SSE_EVENT_TYPES.redaction, measured(SSE_EVENT_TYPES.redaction, (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { runId: string } & Record<string, unknown>;
      assertString(data.runId, "redaction.runId");
      const rawReasons = Array.isArray(data.reasons) ? data.reasons : [];
      // The snapshot is built ONCE — the live store and the turn's record
      // consume the same value, so the two can never disagree (the same
      // one-snapshot-two-consumers shape the dedup handler uses).
      const snapshot: RedactionNoticeSnapshot = {
        maskedCount: typeof data.maskedCount === "number" ? data.maskedCount : 0,
        proven: typeof data.proven === "number" ? data.proven : 0,
        format: typeof data.format === "number" ? data.format : 0,
        inferred: typeof data.inferred === "number" ? data.inferred : 0,
        maskedUpstream: typeof data.maskedUpstream === "number" ? data.maskedUpstream : 0,
        byTier: coerceTierCounts(data.byTier),
        reasons: rawReasons.map((r) => {
          const row = r as Record<string, unknown>;
          const confidence = row.confidence;
          return {
            confidence:
              confidence === "proven" || confidence === "format" ? confidence : "inferred",
            category: typeof row.category === "string" ? row.category : "unknown-sensitive",
            maskedLength: typeof row.maskedLength === "number" ? row.maskedLength : 0,
            explanation: typeof row.explanation === "string" ? row.explanation : "",
          } satisfies RedactionReason;
        }),
        ...(typeof data.runId === "string" ? { runId: data.runId } : {}),
      };
      setRedactionNotice(snapshot);
      // Buffer for the turn this call is about to open — the same arrival
      // shape the context and dedup events have: the "redaction" event
      // fires before the request, hence before the "start" frame creates
      // the assistant message, so it is held here and attached when that
      // message exists. The buffer is CONSUMED by the attach, so a later
      // turn whose call masked nothing (no event) attaches nothing and
      // inherits the previous turn's masking never.
      pendingRedaction = snapshot;
    } catch (err) {
      handleStreamError(err, handlers);
    }
  }));

  // The "done" event is the terminal signal: ALL turns are complete (not
  // just one turn's "finish"). Close the EventSource here to prevent
  // auto-reconnect. FIX for H1: close on "done", not on "finish".
  // FIX refresh the timeline ONCE here (not on every finish event)
  // so newly-recorded run/turn/message/token events appear without a
  // manual refresh click, without causing a request storm.
  // PROACTIVE #1: also refresh the current chat's auto-checks so the
  // quality check the server auto-persists after a run appears
  // in the AutoCheckPanel without a manual refresh.
  es.addEventListener(SSE_EVENT_TYPES.done, measured(SSE_EVENT_TYPES.done, (e: MessageEvent) => {
    let autoTripsReverted: unknown;
    try {
      const data = JSON.parse(e.data) as { runId: string; autoTripsReverted?: boolean };
      assertString(data.runId, "done.runId");
      autoTripsReverted = data.autoTripsReverted;
    } catch (err) {
      // Even if the data is malformed, close the stream — "done" is terminal.
      // Log the parse error for diagnostics (not silently swallowed).
      clientWarn("stream", "done event parse error:", err);
    }
    announceAutoTripRevert(autoTripsReverted);
    // SAFETY NET (exp510): the run is complete. Any tool call still
    // "running" never received its tool_result (SSE disconnect, a
    // provider that did not return finish_reason "tool_calls", etc.).
    // Finalize them as "error" so the UI does not show them stuck at
    // "running" forever — the exact bug the user reported.
    finalizeStrandedToolCalls("the run completed without this tool returning a result");
    // THE RUN'S OWN TERMINAL FRAME. Reporting the terminal status settles
    // the view and schedules its retirement — both at the run-state owner
    // (updateRunStatus reads the terminal vocabulary), so every terminal
    // door gets the same settle by reporting, and no door can forget a
    // settle it never owned. The per-turn `finish` model event deliberately
    // reports nothing (a multi-turn run has several finishes before this
    // frame; settling there retired the view mid-run and the stop verb
    // vanished while the run still streamed).
    updateRunStatus("done");
    // THE STREAM ENDED WITH THE RUN — the socket is closed above, and the
    // close is a transport fact the sweep's second consumer must hear (the
    // natural-terminal counterpart of the error frame's own close). Without
    // it a healthy run's band kept the last epilogue event's "live" face
    // over a dead stream indefinitely (drive 18: "live · 2,726" beside
    // status done).
    // THE RUN ENDED — the client's own ingest report (per-run frame lag,
    // correlated with the run, its chat, and its trace) reports now, while
    // the page is alive to send it.
    void refreshTimeline().catch((err: unknown) => clientWarn("timeline", "post-run refresh failed:", err));
    const chatId = currentChatId.get();
    if (chatId !== null) {
      void listChatAutoChecks(chatId).catch((err: unknown) => clientWarn("auto-checks", "post-run refresh failed:", err));
    }
    // Refresh the memory store so newly-saved tool-result memory entries
    // (saveToMemory) appear in the Memory tab + the Metrics memory section
    // without a manual refresh. The MemoryPanel's tier filter is client-side
    // (it narrows the full set), so fetching all tiers is safe.
    void listMemory().catch((err: unknown) => clientWarn("memory", "post-run refresh failed:", err));
  }));

  // THE RUN WAS STOPPED ON PURPOSE — terminal, and neither a completion nor
  // a failure.
  //
  // A cancelled run used to publish nothing terminal at all: every publish on
  // the executor's way out is guarded by "has this run been stopped?", and
  // cancelling is what makes that true. The feed ended, the server closed the
  // socket, and this client — which closed only on `done` — treated that as a
  // reconnect. Each reconnect replayed the run's `model` `start`, which
  // appends an empty assistant message, so a cancelled run grew one empty
  // bubble per reconnect for the whole retention window. The previous
  // behaviour was a single 404; this was wrong AND repeating.
  //
  // Nothing is appended here. The reader is the person who pressed stop, and
  // the transcript already holds everything the run produced; announcing
  // their own action back to them is noise, and inventing a completion or a
  // failure would be a false statement about what happened.
  es.addEventListener(SSE_EVENT_TYPES.cancelled, measured(SSE_EVENT_TYPES.cancelled, (e: MessageEvent) => {
    let autoTripsReverted: unknown;
    try {
      const data = JSON.parse(e.data) as { runId: string; autoTripsReverted?: boolean };
      assertString(data.runId, "cancelled.runId");
      autoTripsReverted = data.autoTripsReverted;
    } catch (err) {
      // Terminal either way — a malformed payload does not make the run less
      // over, and staying open would restart the loop this frame exists to
      // end. Recorded rather than swallowed.
      clientWarn("stream", "cancelled event parse error:", err);
    }
    announceAutoTripRevert(autoTripsReverted);
    commitStreamingTail();
    setStreaming(false);
    // The run view settles as `cancelled` — the honest outcome, whatever
    // door the stop came through (this tab's stop verb already set it; a
    // cancel from ANOTHER tab reaches the run here and only here).
    // Idempotent with cancelRun's own settle; the retirement follows at
    // the run-state owner, on the same delay every terminal outcome gets.
    updateRunStatus("cancelled");
    finalizeStrandedToolCalls("the run was cancelled before this tool returned a result");
    // The done frame's sibling close: a deliberate stop ends the feed too,
    // and the sweep's stream state must hear the natural close, not the
    // last event's face.
    // Terminal here too — a cancelled run's frames were ingested and its
    // client-side report is as real as a completed run's.
  }));

  // "quality" events carry the codebase quality snapshot the server
  // computes automatically after each run. Store it in the
  // shared qualitySnapshot store so any panel can show real-time quality
  // feedback without a manual refresh.
  //
  // The server sends FOURTEEN fields (server/quality-bridge.ts
  // `QualityIndicator`); this handler used to copy five and drop the other
  // nine on the floor — issueDensity, topCategories, complexity, typeLevel,
  // cloneStats, fileCount, functionCount, totalLoc, moduleCount. They were
  // computed on every run (the expensive part) and then thrown away at the
  // last step. All fourteen are carried through now; whether a panel
  // renders them is the surface owner's call, not this layer's.
  es.addEventListener(SSE_EVENT_TYPES.quality, measured(SSE_EVENT_TYPES.quality, (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as {
        runId: string;
        overallScore: number;
        grade: string;
        totalIssues: number;
        issuesPerKloc: number;
        recommendations?: string[];
        issueDensity?: number;
        topCategories?: QualityCategoryCount[];
        complexity?: QualityComplexity | null;
        typeLevel?: QualityTypeLevel | null;
        cloneStats?: QualityCloneStats | null;
        fileCount?: number;
        functionCount?: number;
        totalLoc?: number;
        moduleCount?: number;
        measured?: QualityMeasuredFlags;
        error?: string;
        message?: string;
      };
      assertString(data.runId, "quality.runId");
      setQualitySnapshot({
        runId: data.runId,
        overallScore: data.overallScore,
        grade: data.grade,
        totalIssues: data.totalIssues,
        issuesPerKloc: data.issuesPerKloc,
        recommendations: Object.freeze([...(data.recommendations ?? [])]),
        // Absent stays absent: the failure payload (`error`/`message`)
        // carries none of these, and inventing a 0/empty for a figure the
        // server never sent would be fabricated data on a quality report.
        ...(data.issueDensity !== undefined ? { issueDensity: data.issueDensity } : {}),
        ...(data.topCategories !== undefined
          ? { topCategories: Object.freeze([...data.topCategories]) }
          : {}),
        ...(data.complexity !== undefined ? { complexity: data.complexity } : {}),
        ...(data.typeLevel !== undefined ? { typeLevel: data.typeLevel } : {}),
        ...(data.cloneStats !== undefined ? { cloneStats: data.cloneStats } : {}),
        ...(data.fileCount !== undefined ? { fileCount: data.fileCount } : {}),
        ...(data.functionCount !== undefined ? { functionCount: data.functionCount } : {}),
        ...(data.totalLoc !== undefined ? { totalLoc: data.totalLoc } : {}),
        ...(data.moduleCount !== undefined ? { moduleCount: data.moduleCount } : {}),
        ...(data.measured !== undefined ? { measured: data.measured } : {}),
        ...(data.error !== undefined ? { error: data.error } : {}),
        ...(data.message !== undefined ? { message: data.message } : {}),
      });
    } catch (err) {
      handleStreamError(err, handlers);
    }
  }));

  // "tool_result" events carry the server-side tool execution result.
  // FIX when the model calls a tool, the server executes it and
  // streams the result. The client updates the existing "running" tool
  // call message with the output and final status.
  es.addEventListener(SSE_EVENT_TYPES.toolResult, measured(SSE_EVENT_TYPES.toolResult, (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as {
        runId: string;
        callId: string;
        toolName: string;
        arguments: Record<string, unknown>;
        result: string;
        success: boolean;
        attemptCount?: number;
      };
      assertString(data.runId, "tool_result.runId");
      assertString(data.callId, "tool_result.callId");
      // Update the SPECIFIC tool call by callId (not "last message") so
      // concurrent tool calls each get their own result (exp510 fix). The
      // frame's `arguments` are the DISPATCHED whole (merged when the gate
      // repaired a retained partial) — the live card's input must become
      // exactly what the frame carries, or the surface renders the raw
      // delta the model sent while the tool ran the merge (UIE-040: the
      // beat claimed "the recorded arguments carry no document to render"
      // over an artifact that was rendering live).
      ingestToolResult(data.callId, data.result, data.success, data.attemptCount, data.arguments, runId);
    } catch (err) {
      handleStreamError(err, handlers);
    }
  }));

  // safety gate — when the gate blocks a tool call BEFORE dispatch (ghost
  // tool, schema mismatch, loop), the server emits a "hallucination" SSE
  // event (the wire frame) carrying the block's actual `kind`. The label the
  // chat shows is DERIVED from that kind via the shared owner's map
  // (`gateBlockEventKind`), so a schema-validation block is labeled
  // "validation" and a loop "loop" — never flattened to "hallucination".
  // Rendered as an inline event in the chat (same path as steering/bias/…).
  es.addEventListener(SSE_EVENT_TYPES.hallucination, measured(SSE_EVENT_TYPES.hallucination, (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as {
        runId: string;
        eventId?: string;
        callId?: string;
        kind: GateBlockKind;
        toolName?: string;
        suggestion?: string;
        message: string;
        /** Present when this block ALSO tripped the tool's breaker (the row
         * flipped server-side mid-run — UIE-036). */
        autoTripped?: boolean;
      };
      assertString(data.runId, "hallucination.runId");
      assertString(data.message, "hallucination.message");
      // The kind arrives over the wire; assert it is a real gate-block kind
      // before mapping (deny-by-default — an unknown kind is a wiring bug,
      // not a silent "hallucination").
      appendEventMessage(gateBlockEventKind(data.kind), data.message, data.eventId);
      // A block that tripped the breaker changed the panel's rows server-
      // side (the row flip above is not a client write, so no invalidation
      // fired). Announce it under the same event the panel's own verbs use,
      // so the cached breaker rows re-read and the trip shows as it happens
      // (UIE-036) — not when the next unrelated event stumbles into a
      // refresh.
      if (data.autoTripped === true) fireInvalidation("tools:changed");
    } catch (err) {
      handleStreamError(err, handlers);
    }
  }));

  // The event-feed safety detectors' verdicts (workaround, bandaid fix,
  // skipped step, off-task work). The server publishes the report at run
  // end; each finding is rendered as an inline event in the chat with the
  // owner's pre-formatted message. Real findings only — a run whose
  // detectors were disarmed publishes no fabricated verdicts.
  // Each finding CARRIES ITS OWN LEDGER ADDRESS (the persist's return,
  // ride-along since the persist-first reorder): the live beat appends WITH
  // it, so the reveal map has its entry the moment the finding lands and
  // the ledger row reveals without a reload — the drive-18 asymmetry. A
  // finding whose persist failed (or a run bound to no chat) honestly
  // carries none.
  es.addEventListener(SSE_EVENT_TYPES.safetyFindings, measured(SSE_EVENT_TYPES.safetyFindings, (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as {
        runId: string;
        armed?: boolean;
        disarmedReason?: string | null;
        messages?: { message: string; eventId?: string }[];
      };
      assertString(data.runId, "safety_findings.runId");
      const messages = Array.isArray(data.messages) ? data.messages : [];
      for (const finding of messages) {
        if (
          finding !== null &&
          typeof finding === "object" &&
          typeof finding.message === "string" &&
          finding.message.length > 0
        ) {
          appendEventMessage(
            "safety-finding",
            finding.message,
            typeof finding.eventId === "string" ? finding.eventId : undefined,
          );
        }
      }
    } catch (err) {
      handleStreamError(err, handlers);
    }
  }));

  // Pause-and-ask: the investigation needs a user action (install/configure
  // or confirm a deviation). The run waits; the existing steer path is the
  // answer channel. Rendered as a safety-finding so refresh reconstruction
  // uses the same kind the persist path writes. The frame carries the
  // ledger address its persist wrote (the persist-first order), so the live
  // beat joins the record's row — the same reveal fix the findings frame
  // got.
  es.addEventListener(SSE_EVENT_TYPES.pauseAsk, measured(SSE_EVENT_TYPES.pauseAsk, (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as {
        runId: string;
        message?: string;
        eventId?: string;
      };
      assertString(data.runId, "pause_ask.runId");
      if (typeof data.message === "string" && data.message.length > 0) {
        appendEventMessage(
          "safety-finding",
          data.message,
          typeof data.eventId === "string" ? data.eventId : undefined,
        );
      }
    } catch (err) {
      handleStreamError(err, handlers);
    }
  }));

  // LLM control of the interface. When the LLM calls the
  // control_interface tool, the server validates the action (single owner
  // — server/ui-control.ts) and emits a `ui_control` SSE event carrying it.
  // Apply it directly through the shared stores (reuse, do not
  // rebuild) so the UI changes on demand — set_tab / toggle_panel /
  // set_theme / open_settings — then show an inline event so the user sees
  // what the LLM changed (agents act interactively, not raw text).
  // Defense-in-depth (rule: validate at the trust boundary): the action
  // arrives pre-validated, but a malformed/missing `action` must never
  // crash the client — guard before applying, then route to onError.
  es.addEventListener(SSE_EVENT_TYPES.uiControl, measured(SSE_EVENT_TYPES.uiControl, (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { runId: string; action: UiControlAction };
      assertString(data.runId, "ui_control.runId");
      if (data.action === null || typeof data.action !== "object" || typeof data.action.action !== "string") {
        throw new ClientError("ui_control", "ui_control event missing a valid action payload");
      }
      const description = applyUiControlAction(data.action);
      if (description.length > 0) {
        appendEventMessage("ui_control", description);
      }
      handlers.onUiControl?.(data.action);
    } catch (err) {
      handleStreamError(err, handlers);
    }
  }));

  // TWO different things dispatch to this one listener:
  //
  //   1. a SERVER-SENT `event: error` frame — a MessageEvent carrying
  //      `data` with the run's real taxonomy code. The server KNOWS why
  //      the run failed and says so; the client reports what it was told.
  //   2. EventSource's NATIVE error event — a bare Event with no `data`,
  //      fired when the transport itself fails (connection dropped, the
  //      server went away mid-stream). Nobody sent a reason, so there is
  //      no cause to report.
  //
  // The two used to be handled identically: the payload was ignored
  // entirely (the listener took no argument) and the "cause" was
  // synthesised from `es.readyState`. That made every mid-run failure
  // indistinguishable and the displayed reason invented rather than
  // reported — fabricated data on the error path. Case 1 now reads the
  // code the server actually sent; case 2 says only what the client can
  // truthfully observe about the transport, and names no cause.
  es.addEventListener(SSE_EVENT_TYPES.error, measured(SSE_EVENT_TYPES.error, (_e: Event, framed) => {
    if (framed !== null) {
      // A real server-reported failure ends the run — commit whatever the
      // assistant had streamed so far and stop the spinner. (The previous
      // code only did this when readyState happened to be CLOSED, so a
      // server error frame on a still-open stream left the UI spinning and
      // labelled a genuine failure "reconnecting".)
      commitStreamingTail();
      setStreaming(false);
      // A failed call's terminal copy carries the same recorder identity
      // as its model frame and saved message, even after buffer eviction.
      appendChatError(
        formatErrorMessage({ code: framed.code, message: framed.message, statusCode: undefined }),
        { runId, code: framed.code },
        framed.eventId,
      );
      appendError("stream", framed.message, framed.code);
      // NO TOOL BEAT SPINS FOREVER, AND THIS IS THE PATH THAT PROVED IT.
      //
      // The safety net had exactly one caller in the whole client — the
      // `done` listener — and `done` is precisely the frame a failed run never
      // sends. So every run that ended any way other than cleanly left its
      // in-flight tools showing "running" on screen, permanently. The two
      // failure paths are here, and they are the ones that actually fire.
      finalizeStrandedToolCalls("the run reported an error before this tool returned a result");
      // The failed run's ending carries its side-effect facts too (a gate
      // auto-trip revert rides every terminal frame — UIE-041).
      announceAutoTripRevert(framed.autoTripsReverted);
      // THE ERROR FRAME IS A TERMINAL FRAME, AND THE VIEW SETTLES ON IT
      // exactly as it does on `done` and `cancelled` — by REPORTING the
      // terminal status, never by a settle copy of the listener's own.
      // The measured gap this closes (UIE-056): this listener did
      // everything else honestly — the error beat rendered, stranded tools
      // finalized, the stream closed, the telemetry finished — but the view
      // it never settled stayed "running" forever: the clock ticked minutes
      // past the server's settle, the stop verb was a 404 dead end, and
      // every send routed to the dead run's steer door — the chat
      // unsendable until a page reload. Any run-level terminal error frame
      // reaches this listener (provider failures, run_failed throws, the
      // tool-iteration bound), so the settle belongs to the shared owner
      // the other terminal doors already report through.
      updateRunStatus("error");
      handlers.onError?.(new ClientError(framed.code, framed.message));
      // AN ERROR FRAME IS TERMINAL, AND NOT CLOSING ON IT IS A LOOP.
      //
      // The server ends the run's feed on every exit path, which closes the
      // socket — and a server-closed EventSource is, per the protocol, an
      // instruction to RECONNECT. So leaving the stream open here did not
      // merely leave a dead socket around: the browser came back, the
      // retained feed replayed the same error frame, and another error bubble
      // was appended, on the reconnect cadence, for the whole retention
      // window. `done` has always closed; this is the same fact arriving
      // through the path a FAILED run takes, which is the path that most
      // needs it.
      // The run ended by its own failure — the ingest report carries
      // whatever frames it got (a failing run's feed lag is a fact about
      // the failure, not noise beside it).
      return;
    }
    if (es.readyState === EventSource.CLOSED) {
      commitStreamingTail();
      setStreaming(false);
      const raw = "The connection to the run was lost and did not report a reason.";
      appendChatError(formatErrorMessage({ code: "stream_closed", message: raw, statusCode: undefined }));
      appendError("stream", raw, "stream_closed");
      finalizeStrandedToolCalls("the connection was lost before this tool returned a result");
      // CLOSED is terminal for this client: EventSource will not reconnect,
      // so no later frame can settle the view in this listener's place —
      // the same permanently-live face as an unsettled error frame if the
      // view is left "running" here. The settle is the shared owner's.
      updateRunStatus("error");
      handlers.onError?.(
        new ClientError("stream_closed", raw),
      );
      // The stream's refusal ended the run FOR THIS CLIENT, and this is the
      // one stream-ending door that can fire with the run's ingest report
      // still unflushed: a run parked while it was live ingested its frames
      // through THIS stream's listeners, then parked (no door — the run had
      // not ended), and the failure happened with no client attached. When
      // the user returns past the feed's retention, the re-open is refused
      // and this door is the run's first and only ending here — so its
      // siblings' flush act belongs at it too (done, cancelled, the error
      // frame and the model-error door all flush; a door that ends a run
      // without flushing strands the report for the page's lifetime).
      // `finishRunTelemetry` itself reports nothing for a run whose stream
      // never ingested a frame — the absence is the honest state, not a zero.
    } else {
      // EventSource auto-reconnects; surface transient errors
      const raw = "SSE stream error (reconnecting)";
      appendError("stream", raw, "stream_error");
      handlers.onError?.(
        new ClientError("stream_error", raw),
      );
    }
  }));

  return {
    close: () => { closed = true; es.close(); },
  };
}

/**
 * Close out any tool call still showing "running" when a run has stopped
 * producing, whatever stopped it.
 *
 * ONE FUNCTION BECAUSE THERE ARE THREE WAYS A RUN ENDS and only one of them
 * used to do this. The safety net's single caller was the `done` listener, and
 * `done` is the frame a failed run never sends — so a provider error, a lost
 * connection, or a cancelled run left its in-flight tools spinning on screen
 * forever. Three call sites reaching one function is the same fix at every
 * exit; three copies would have been three chances to update two of them.
 *
 * The recorded reason states what is known — that no result arrived — and
 * never invents an output, because a synthesised tool answer is a fabricated
 * fact wearing a real tool's name.
 *
 * AND THE LEDGER IS CONSULTED BEFORE THE OBSERVATION STANDS. The client not
 * seeing a result is a claim about the stream, not about the run: the
 * replay buffer can have evicted the result frame, the connection can have
 * dropped mid-call. So every terminal path also reads the chat's tool calls
 * back from the server (the existing bounded route — the same rows a page
 * refresh would load) and heals any stranded card whose ledger row carries
 * a recorded result. A card left unhealed then means exactly what its
 * placeholder says: no result in the ledger either. Best-effort by design —
 * a read-back that fails (the server that lost the run lost the route too)
 * leaves the honestly-labelled client observation in place.
 */
function finalizeStrandedToolCalls(reason: string): void {
  const finalized = finalizeRunningToolCalls(reason);
  if (finalized > 0) {
    clientWarn("stream", `finalized ${finalized} tool call(s) left in 'running' state`);
    void healStrandedToolCallsFromServer();
  }
}

/**
 * The run-end read-back: fetch this chat's tool-call rows and hand them to
 * the store's heal. Never throws to its caller (best-effort, warned on
 * failure) and does nothing when no chat is open.
 */
async function healStrandedToolCallsFromServer(): Promise<void> {
  const chatId = currentChatId.get();
  if (chatId === null) return;
  try {
    const rows = await fetchJson<unknown>(`/chats/${encodeURIComponent(chatId)}/tool-calls`);
    if (!Array.isArray(rows)) {
      throw new ClientError("malformed", "Expected array for chat tool calls");
    }
    const healed = healStrandedToolCallsFromLedger(rows as readonly ToolCallLedgerRow[]);
    if (healed > 0) {
      clientWarn("stream", `healed ${healed} stranded tool call card(s) from the ledger read-back`);
    }
  } catch (err: unknown) {
    clientWarn("stream", "run-end tool-call read-back failed:", err);
  }
}

/**
 * THE RELOADED PAGE'S ORPHANED WORKING BEATS (UIE-042) — the hydrate-time
 * reconcile.
 *
 * A page reloaded mid-run never re-attaches to the live run's SSE, so the
 * frames that would settle its in-flight beats never arrive; the flow it
 * rebuilt from history carries the rows as they were PERSISTED — "running"
 * — and the done-frame safety net only covers frames a reload survived.
 * Measured live: eight beats at "◍ working Ns" with climbing clocks 5+
 * minutes after the server-side run had closed.
 *
 * The hydrate door calls this once per hydrate when any hydrated beat still
 * shows "working". The ledger is the authority (the server finalises every
 * run's rows on every exit), so this reads the same bounded route the
 * run-end heal uses and settles what the rows now say — a terminal row
 * with its recorded result heals the beat; a terminal row with none
 * settles the honest incomplete; a row still "running" means the run is
 * genuinely live server-side, and the reconcile re-reads at the poll
 * cadence until the rows settle or the bound expires, so a run that ends
 * AFTER the hydrate still heals its beats without another reload.
 */
function reconcileHydratedRunningToolCalls(chatId: string): void {
  void settleHydratedToolCallsFromServer(chatId, Date.now());
}

/** One reconcile pass; reschedules itself while rows still read running. */
async function settleHydratedToolCallsFromServer(chatId: string, startedAtMs: number): Promise<void> {
  // The reader left this conversation: a reconcile that settled another
  // chat's beats would write another conversation's facts into the view.
  if (currentChatId.get() !== chatId) return;
  try {
    const rows = await fetchJson<unknown>(`/chats/${encodeURIComponent(chatId)}/tool-calls`);
    if (!Array.isArray(rows)) {
      throw new ClientError("malformed", "Expected array for chat tool calls");
    }
    const { settled, stillRunning } = settleHydratedRunningToolCalls(
      rows as readonly ToolCallLedgerRow[],
      "the run ended before this tool recorded a result",
    );
    if (settled > 0) {
      clientWarn("stream", `settled ${settled} tool call beat(s) left working by a reload, from the ledger read-back`);
    }
    if (
      stillRunning > 0 &&
      Date.now() - startedAtMs < HYDRATED_TOOL_CALL_RECONCILE_MAX_MS
    ) {
      setTimeout(() => {
        void settleHydratedToolCallsFromServer(chatId, startedAtMs);
      }, HYDRATED_TOOL_CALL_RECONCILE_POLL_MS);
    }
  } catch (err: unknown) {
    clientWarn("stream", "hydrated tool-call read-back failed:", err);
  }
}

/** Whether any hydrated tool beat still shows "working" — the reconcile's
 * precondition, checked against the store the hydrate just wrote. */
function hasWorkingToolCallBeats(): boolean {
  return messagesStore.get().some(
    (m) => m.role === "tool" && m.toolCall !== undefined && m.toolCall.status === "running",
  );
}

// ── The unanswered-turn half of the same reconcile (UIE-076) ────────────────

/**
 * THE RELOADED PAGE'S UNANSWERED TURNS — the hydrate-time reconcile's
 * text-only arm, the same door that heals the orphaned tool beats.
 *
 * THE DEFECT THIS CLOSES: a run whose server died mid-stream leaves the
 * assistant row it created at the model's start EMPTY forever — the words
 * lived in the dead process's memory (text is persisted at finish, never
 * incrementally), no error row carries the failure, and the flow hides an
 * empty turn outright (`rendersInFlow`), so the conversation reads as an
 * unanswered turn with no ending anywhere: no partial text, no error beat,
 * no incomplete sentence. The tool-card heal has no face to heal here — a
 * text-only run strands no tool row and no ◍ working beat, just the row.
 *
 * WHAT THE RECORD CAN SAY, and the reconcile never says more: the row
 * started a turn and no ending was ever recorded. A cancel and a server
 * death write the same nothing (the cancelled terminal frame is feed-only;
 * a dead process writes nothing at all), so the face states the shared
 * fact — the run ended before this answer was kept — and names no cause
 * the record cannot prove.
 *
 * THE ORDER OF THE TWO READS IS THE CORRECTNESS. Liveness is asked FIRST
 * (the run-status route, whose only authority is the registry: a run
 * leaves the registry only after its final row writes, so "not executing"
 * is a write barrier), and the rows are read SECOND (the same bounded
 * chat-scoped page the tool reconcile reads). A row confirmed still
 * unanswered by a read that postdates the "not executing" answer is final
 * — no writer exists — and is settled. A row that gained words or a
 * finish reason in the fresh read was kept after all: the hydrate missed
 * the run's ending, so the whole door re-reads (loadChatHistory, the
 * in-place heal a focus-check already rides) and the words render. A run
 * still executing settles nothing and polls at the same cadence the tool
 * reconcile uses, until the bound.
 *
 * The page's OWN live run never reaches the pass — its stream is writing
 * the row, and the reconcile owns orphans, not streams.
 */
function reconcileHydratedUnansweredTurns(chatId: string): void {
  void settleHydratedUnansweredTurnsFromServer(chatId, Date.now());
}

/** One reconcile pass; reschedules itself while a subject's run is still
 * executing. */
async function settleHydratedUnansweredTurnsFromServer(
  chatId: string,
  startedAtMs: number,
): Promise<void> {
  // The reader left this conversation: a verdict aimed at another chat's
  // rows must never settle into the view (and the by-id apply below would
  // not match anyway — the guard keeps the fetches from firing too).
  if (currentChatId.get() !== chatId) return;
  const liveRunId = isRunActive.get() ? (currentRun.get()?.runId ?? null) : null;
  const subjects = messagesStore
    .get()
    .filter(isUnansweredAssistantRow)
    .filter((m) => m.runId !== liveRunId);
  if (subjects.length === 0) return;
  try {
    // LIVENESS FIRST — the write barrier (see the block comment above).
    const runIds = [...new Set(subjects.map((m) => m.runId!))];
    const executing = new Set<string>();
    let keptFound = false;
    for (const runId of runIds) {
      const status = await fetchJson<{ executing: unknown }>(
        `/run/${encodeURIComponent(runId)}/status`,
      );
      if (status !== null && typeof status === "object" && status["executing"] === true) {
        executing.add(runId);
      }
    }
    // ROWS SECOND — one bounded fresh read of the chat's newest messages,
    // the same tail page the tool reconcile's read-back uses.
    const rows = await fetchJson<unknown>(
      `/chats/${encodeURIComponent(chatId)}/messages`,
    );
    if (!Array.isArray(rows)) {
      throw new ClientError("malformed", "Expected array for chat messages");
    }
    const updates: ChatMessage[] = [];
    for (const subject of subjects) {
      if (executing.has(subject.runId!)) continue;
      const fresh = (rows as readonly unknown[]).find(
        (r) =>
          r !== null && typeof r === "object" &&
          (r as Record<string, unknown>)["id"] === subject.id,
      ) as Record<string, unknown> | undefined;
      // The subject can sit past the tail page's bound (an old dead row a
      // scrolled-back page prepended): unverifiable, so nothing is settled
      // for it — deny-by-default, the row keeps its current face.
      if (fresh === undefined) continue;
      const freshContent = fresh["content"];
      const freshMeta = parseMessageMetadata(fresh["metadata"]);
      const kept =
        (typeof freshContent === "string" && freshContent.length > 0) ||
        freshMeta.finishReason !== undefined ||
        (typeof freshMeta.reasoning === "string" && freshMeta.reasoning.length > 0);
      if (kept) {
        // The run's ending kept words the hydrate's own read was too early
        // to see. One full re-read through the existing door renders them
        // (and any error row the ending wrote) in place — the same heal the
        // focus-time record check rides. Only requested once per pass; the
        // re-read's own door finds the row answered and stops here.
        keptFound = true;
      } else {
        updates.push({
          ...subject,
          incompleteReason: "the run ended before this answer was kept",
        });
      }
    }
    const settled = applyReconciledAssistantRows(updates);
    if (settled > 0) {
      clientWarn(
        "stream",
        `settled ${settled} turn(s) left unanswered by a run that never recorded an ending`,
      );
    }
    if (keptFound) {
      void loadChatHistory(chatId);
    }
    if (
      subjects.some((m) => executing.has(m.runId!)) &&
      Date.now() - startedAtMs < HYDRATED_TOOL_CALL_RECONCILE_MAX_MS
    ) {
      setTimeout(() => {
        void settleHydratedUnansweredTurnsFromServer(chatId, startedAtMs);
      }, HYDRATED_TOOL_CALL_RECONCILE_POLL_MS);
    }
  } catch (err: unknown) {
    clientWarn("stream", "hydrated unanswered-turn read-back failed:", err);
  }
}

/** Whether any hydrated assistant row started a turn that never ended — the
 * turn reconcile's precondition, checked against the store the hydrate just
 * wrote. */
function hasUnansweredAssistantRows(): boolean {
  return messagesStore.get().some(isUnansweredAssistantRow);
}

// ── Internal: ModelEvent → chat-messages ingestion ──

/** Timing state for the current streaming assistant message. */
let currentTurnStartedAt: number | null = null;
/** First ANSWER token (`text_delta`) — the recorded ttft clock. */
let currentTurnFirstTokenAt: number | null = null;
/** First token of ANY kind (thinking or answer) — the producing-window start. */
let currentTurnFirstOutputAt: number | null = null;
/** Finish-frame time. Kept until the next start so a late `usage` can stamp tps. */
let currentTurnFinishedAt: number | null = null;

/** Tokens per second over a measured producing window, or absent. */
function rateTps(outputTokens: number | undefined, generationMs: number | undefined): number | undefined {
  if (outputTokens === undefined || generationMs === undefined || generationMs <= 0) return undefined;
  return Math.round((outputTokens / (generationMs / 1000)) * 10) / 10;
}

function producingWindowMs(finishedAt: number): number | undefined {
  const firstOutputAt = currentTurnFirstOutputAt ?? currentTurnFirstTokenAt;
  if (firstOutputAt === null) return undefined;
  const ms = finishedAt - firstOutputAt;
  return ms > 0 ? ms : undefined;
}
/**
 * Buffered run context (system prompt, tools, history length) received via
 * the "context" SSE event. The context event arrives BEFORE the "start"
 * model event creates the assistant message, so it is buffered here and
 * attached to the new assistant message when "start" fires. This keeps the
 * context on the correct message (the assistant's, not the user's).
 */
let pendingContext: RunContext | null = null;

/**
 * Buffered dedup summary received via the "dedup" SSE event for the LLM
 * call that is about to open its turn. The event fires before the request —
 * before the "start" model event creates the assistant message — so it is
 * buffered here and attached to that message when "start" fires (the
 * pendingContext pattern). CONSUMED by the attach: a later turn whose call
 * removed nothing fires no event, finds this null, and inherits the
 * previous turn's savings never.
 */
let pendingDedup: DedupSnapshot | null = null;

/**
 * Buffered redaction notice received via the "redaction" SSE event for the
 * LLM call that is about to open its turn. The event fires before the
 * request — before the "start" model event creates the assistant message —
 * so it is buffered here and attached to that message when "start" fires
 * (the pendingContext/pendingDedup pattern). CONSUMED by the attach: a
 * later turn whose call masked nothing fires no event, finds this null,
 * and inherits the previous turn's masking never.
 */
let pendingRedaction: RedactionNoticeSnapshot | null = null;

/**
 * Ingest a timeline event as an inline chat message when it is a
 * hallucination, bias, self-healing, or error event. Steering
 * events are handled separately via the "steered" SSE event. The event
 * description (from the timeline record) becomes the inline message text.
 *
 * Uses the same event→category mapping as the Timeline tab
 * (timeline-categories.ts) so the inline events are consistent with the
 * timeline. Only user-meaningful events are ingested — the full timeline
 * still lives in the Timeline tab for forensic detail.
 */
function ingestInlineTimelineEvent(event: TimelineEventRecord): void {
  const kind = classifyInlineEvent(event.eventType, event.description ?? "");
  if (kind !== null) {
    const desc = event.description || kind;
    // Provider failures render through the same projection as their live
    // model frame and saved row. Their shared ID is the equality authority;
    // gate interventions retain their own inline-event kind.
    if (kind === "error" && event.runId !== null && event.errorCode !== null && event.errorMessage !== null) {
      // The appended face, when no beat owns this failure yet, is the SAME
      // projection every other face of the failure renders — the live beat
      // and the reloaded row must never speak two sentences for one
      // failure, and this append is one of the two faces a reader can see.
      const display = formatErrorMessage({ code: event.errorCode, message: event.errorMessage, statusCode: undefined });
      appendChatError(
        display,
        {
          runId: event.runId,
          code: event.errorCode,
        },
        event.eventId,
      );
      return;
    }
    appendEventMessage(kind, desc, event.eventId);
  }
}

/**
 * Write a model event into the transcript — for the conversation it belongs
 * to, and no other.
 *
 * `chatId` is the run's chat, latched from the server's own `connected` frame
 * (see `openRunStream`). `null` is a run bound to no chat, which cannot be
 * misattributed and is ingested as before.
 *
 * The refusal is silent by design: a run whose workspace is not on screen is
 * a normal state, not an error, and the run is executing on the SERVER, which
 * records every event as it happens. Returning to that conversation re-reads
 * the record. What is given up is live motion in a view nobody is looking at;
 * what is bought is that the view you ARE looking at is never told another
 * conversation's words are its own.
 */
function ingestModelEvent(runId: string, chatId: string | null, event: ModelEvent, timelineEventId?: string, messageId?: string, replayed = false): void {
  if (chatId !== null && currentChatId.get() !== chatId) return;
  switch (event.type) {
    case "start": {
      appendAssistantMessage("");
      setStreaming(true);
      currentTurnStartedAt = replayed ? null : Date.now();
      currentTurnFirstTokenAt = null;
      currentTurnFirstOutputAt = null;
      currentTurnFinishedAt = null;
      // THE RUN IS LIVE THE MOMENT ITS FIRST TURN OPENS. `startRun` plants
      // the view as "starting"; the first model `start` promotes it to
      // "running" — a real state on the way (idle → starting → running →
      // done/error/cancelled), never a vocabulary member that exists only
      // in the type. Every later turn of the same run (a steered drain
      // re-enters here too) re-states it, and the run-state owner cancels
      // any pending retirement a terminal-looking frame scheduled: a run
      // whose turn is opening is not settling.
      updateRunStatus("running");
      // Attach the buffered run context (system prompt + tools + history)
      // to the new assistant message. The "context" SSE event arrives
      // before "start", so it's buffered in pendingContext.
      if (pendingContext !== null) {
        const ctx = pendingContext;
        pendingContext = null;
        updateLastAssistantMessage((m) => ({ ...m, context: ctx }));
      }
      // Attach the buffered dedup summary the same way — the event for
      // THIS call arrived before "start". The consume (null before the
      // write) is what keeps the next turn honest: no event, no attach.
      if (pendingDedup !== null) {
        const dedup = pendingDedup;
        pendingDedup = null;
        updateLastAssistantMessage((m) => ({ ...m, dedupSummary: dedup }));
      }
      // Attach the buffered redaction notice the same way — the masking
      // fact for THIS call arrived before "start", and the consume is
      // what keeps the next turn honest: a call that masks nothing fires
      // no event, so no masking face is inherited.
      if (pendingRedaction !== null) {
        const redaction = pendingRedaction;
        pendingRedaction = null;
        updateLastAssistantMessage((m) => ({ ...m, redactionNotice: redaction }));
      }
      break;
    }
    case "text_delta":
      if (!replayed && currentTurnFirstOutputAt === null) currentTurnFirstOutputAt = Date.now();
      if (!replayed && currentTurnFirstTokenAt === null) {
        const now = Date.now();
        currentTurnFirstTokenAt = now;
        // Attach TTFT to the last ASSISTANT message, wherever it sits — a
        // first text token that follows a tool call was stamping the tool
        // card (the literal last message) with the turn's timing.
        if (currentTurnStartedAt !== null) {
          const startedAt = currentTurnStartedAt;
          updateLastAssistantMessage((m) => ({
            ...m,
            timingMetrics: {
              startedAt,
              firstTokenAt: now,
              ttftMs: now - startedAt,
            },
          }));
        }
      }
      ingestTextDelta(event.delta);
      break;
    case "reasoning_delta":
      if (!replayed && currentTurnFirstOutputAt === null) currentTurnFirstOutputAt = Date.now();
      ingestReasoningDelta(event.delta);
      break;
    case "tool_call_start":
      appendToolCall({
        id: event.callId,
        name: event.name,
        input: null,
        output: null,
        status: "running",
        startedAt: Date.now(),
      }, "", messageId === undefined ? undefined : { messageId, runId, event });
      break;
    case "tool_call_delta":
      // Partial arguments are not accumulated; final arguments arrive on
      // tool_call_done. Avoids mid-stream JSON noise in the UI.
      break;
    case "tool_call_done":
      ingestToolCallDone(event.callId, event.arguments, runId);
      break;
    case "usage":
      // Attach token metrics to the last ASSISTANT message, WHEREVER it
      // sits. When a turn includes tool calls the "usage" chunk arrives
      // after tool messages exist, so the literal last message is a tool
      // card — and a role guard inside updateLastMessage silently DROPPED
      // the usage the stream had delivered: the live footer said "tokens
      // not measured" while a refresh (the history path, mapping by row)
      // showed the same turn's real numbers. The walk-back updater is the
      // fix; the two paths now agree.
      updateLastAssistantMessage((m) => {
        const tokenMetrics = {
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          totalTokens: event.usage.totalTokens,
          ...(event.usage.cachedInputTokens !== undefined
            ? { cachedInputTokens: event.usage.cachedInputTokens }
            : {}),
          ...(event.usage.reasoningTokens !== undefined
            ? { reasoningTokens: event.usage.reasoningTokens }
            : {}),
        };
        // THIS PROVIDER SENDS `usage` AFTER `finish`. The finish handler
        // therefore often has no token counts yet and writes no tps. Stamp
        // it here, against the producing window already closed at finish,
        // so a refresh still has the rate the live footer showed.
        const finishedAt = currentTurnFinishedAt ?? m.timingMetrics?.finishedAt;
        const generationMs = !replayed && currentTurnStartedAt !== null && finishedAt !== undefined ? producingWindowMs(finishedAt) : undefined;
        const tps = rateTps(tokenMetrics.outputTokens, generationMs);
        const timing =
          tps !== undefined && m.timingMetrics !== undefined
            ? { ...m.timingMetrics, tps }
            : m.timingMetrics;
        return {
          ...m,
          tokenMetrics,
          ...(timing !== undefined ? { timingMetrics: timing } : {}),
        };
      });
      break;
    case "finish": {
      commitStreamingTail();
      setStreaming(false);
      if (replayed || currentTurnStartedAt === null) {
        updateLastAssistantMessage((m) => ({ ...m, finishReason: event.reason }));
        break;
      }
      const finishedAt = Date.now();
      // Compute final timing metrics (TPS, total duration) and merge onto
      // the last ASSISTANT message, wherever it sits. The old shape — a
      // role guard inside updateLastMessage — was a silent no-op whenever
      // the turn ended with tool calls (the last message is a tool card),
      // so finishReason and the timing block never landed live; same
      // dropped-frame class as the usage case above.
      currentTurnFinishedAt = finishedAt;
      updateLastAssistantMessage((m) => {
        const startedAt = currentTurnStartedAt ?? m.timestamp;
        const firstTokenAt = currentTurnFirstTokenAt ?? undefined;
        const totalMs = finishedAt - startedAt;
        const generationMs = producingWindowMs(finishedAt);
        const tps = rateTps(m.tokenMetrics?.outputTokens, generationMs);
        const ttftMs = firstTokenAt !== undefined ? firstTokenAt - startedAt : undefined;
        return {
          ...m,
          finishReason: event.reason,
          timingMetrics: {
            startedAt,
            ...(firstTokenAt !== undefined ? { firstTokenAt } : {}),
            finishedAt,
            ...(ttftMs !== undefined ? { ttftMs } : {}),
            totalMs,
            ...(tps !== undefined ? { tps } : {}),
          },
        };
      });
      // A TURN FINISHED — nothing more. A run with tool calls (or a steered
      // drain) has several per-turn finishes before the run's own terminal
      // `done` frame, so this is the turn's boundary, never the run's:
      // settling the run view here retired it mid-run (the pane said done,
      // the stop verb vanished, and a mid-run send routed fresh-start into
      // the honest 428 instead of steering). The run VIEW's terminal
      // status + retirement belong to the run-level frames — the SSE
      // `done`/`cancelled`/`error` events — the same boundary the stream's
      // own close already uses.
      // Do NOT clear the producing-window clocks here: usage often arrives
      // after finish, and that is the frame that finally has the token
      // counts tps needs. The next `start` (or an error) resets them.
      // NOTE: refreshTimeline() is NOT called here. It was called on
      // every finish event, which with tool calls means N requests per
      // run (one per turn). The timeline refresh lives in the "done"
      // event handler (fires once after ALL turns complete).
      break;
    }
    case "error":
      // The server's recorder identity joins this event with its saved row
      // and terminal copy without collapsing a later identical failure.
      appendChatError(
        formatErrorMessage({ code: event.error.code, message: event.error.message, statusCode: undefined }),
        { runId, code: event.error.code },
        timelineEventId,
      );
      appendError("model", event.error.message, event.error.code);
      commitStreamingTail();
      setStreaming(false);
      updateRunStatus("error");
      currentTurnStartedAt = null;
      currentTurnFirstTokenAt = null;
      currentTurnFirstOutputAt = null;
      currentTurnFinishedAt = null;
      break;
  }
}

function ingestTextDelta(delta: string): void {
  const list = messagesStore.get();
  const last = list[list.length - 1];
  if (last && last.role === "assistant") {
    // O(1): append to the dedicated tail atom instead of rewriting the whole
    // message array. The tail is folded back into the message when the stream
    // finishes. See `streamingTail` in state/chat-messages.ts.
    appendStreamingTail(delta);
  } else {
    // First delta of a response: create the assistant message (one array
    // write), then stream into the tail.
    appendAssistantMessage("");
    appendStreamingTail(delta);
  }
}

/**
 * Accumulate reasoning/thinking text on the last assistant message. The
 * model streams reasoning before (or alongside) the answer; the UI shows it
 * in a collapsible "Thinking" section so the user can inspect the chain of
 * thought without it cluttering the answer.
 */
function ingestReasoningDelta(delta: string): void {
  // The last ASSISTANT message, wherever it sits: reasoning that streams
  // after a tool call was being appended onto the tool card (the literal
  // last message) — the dropped/misfiled-frame class the usage fix names.
  updateLastAssistantMessage((m) => ({
    ...m,
    reasoning: (m.reasoning ?? "") + delta,
  }));
}

// The run view's settle + retirement live at the run-state owner
// (`updateRunStatus` reads the terminal-status vocabulary there and both
// settles the view and schedules its retirement). This module only REPORTS
// statuses: every terminal door — the run's `done` frame, the `cancelled`
// frame, a model `error`, a server `error` frame, a CLOSED transport, the
// stop verb — says what happened, and the owner decides the view's
// lifetime. A settle copy in any one door is how the error frame's was
// forgotten; no door holds one now.

function ingestToolCallDone(callId: string, argumentsObj: Readonly<Record<string, unknown>>, runId?: string): void {
  // FIX (exp510): tool_call_done means the LLM finished sending the tool
  // call arguments — the tool has NOT been executed yet. Keep status
  // "running" so the UI shows it as in-progress until the tool_result
  // event arrives. Update by callId (not "last message") so concurrent
  // tool calls each get their own arguments.
  updateToolCallById(callId, (tc) => tc.status !== "running" ? tc : ({
    ...tc,
    input: argumentsObj,
  }), runId);
}

/**
 * Ingest a server-side tool execution result. exp510 fix: update the
 * SPECIFIC tool call by callId (not the "last message") so concurrent
 * tool calls each receive their own result. Previously every result was
 * applied to the last tool message — tools 1..N-1 stayed "running".
 * persists the attempt count so retried calls show "attempt N".
 *
 * The frame's `arguments` are the DISPATCHED whole — the tool ran with
 * them, the row persisted them, and the live card's input must follow:
 * the beat renders the document the tool received (UIE-040 — a listener
 * that parsed the field and dropped it left the card's input at the raw
 * delta the model sent, so a gate-repaired artifact rendered its honest
 * absence over a live iframe). Absent only on a malformed frame; the
 * input then keeps whatever the model-event ingest set.
 */
function ingestToolResult(
  callId: string,
  result: string,
  success: boolean,
  attemptCount?: number,
  argumentsObj?: Readonly<Record<string, unknown>>,
  runId?: string,
): void {
  updateToolCallById(callId, (tc) => ({
    ...tc,
    output: result,
    status: success ? "done" : "error",
    endedAt: Date.now(),
    // THE DISPATCHED ARGUMENTS — the record of what the tool RAN. The frame
    // carries them on every result (blocked calls included, where they are
    // the delta the model sent and nothing was dispatched).
    ...(argumentsObj !== undefined ? { input: argumentsObj } : {}),
    // persist the attempt count so the tool card shows "attempt N"
    // for retried calls (user: "on retry, show failed X times").
    ...(attemptCount !== undefined && attemptCount > 1 ? { attemptCount } : {}),
    // A failed result is a REFUSAL RECORD the tool (or the pre-dispatch
    // safety gate that blocked the call) really returned — the typed fact
    // the artifact renderer keys its "was the document accepted" decision
    // on. The result string is non-empty by contract here (the executor's
    // failures and the gate's blocks are sentences), so a failed frame is
    // always a refusal; an in-flight card has no result yet and is left
    // alone.
    ...(success ? {} : { refused: true as const }),
  }), runId);
}

// (The per-route intelligence wrappers were removed at the cutover: every
// UI caller was the deleted IntelligencePanel, and the cockpit's plugged
// intelligence consumers read through the Broker's block transport. The
// server endpoints remain; a future consumer plugs into the wire types in
// shared/wire-types.ts.)

// ── Public API: Quality (quality indicator, recommendations) ──

export async function getQualityIndicator(path: string): Promise<unknown> {
  return fetchJson<unknown>(`/quality?path=${encodeURIComponent(path)}`);
}

// ── Public API: Awareness (codebase signals) ──

export async function getAwarenessSummary(path: string): Promise<unknown> {
  return fetchJson<unknown>(`/awareness?path=${encodeURIComponent(path)}`);
}

// ── Public API: Git operations ──


export async function getGitStatus(path: string): Promise<unknown> {
  let data: unknown;
  try {
    data = await fetchJson<unknown>(`/git/status?path=${encodeURIComponent(path)}`);
  } catch (err) {
    // A refused read is a STANDING FACT about this path, not a transient
    // failure: the pane renders the server's own sentence from the store
    // (state/git.ts owns the per-path state) while the error still
    // propagates to the caller — swallowing it here would leave a caller's
    // honest catch with nothing to catch.
    const reason = refusalReason(err);
    if (reason !== null) setGitRefusal({ path, reason });
    throw err;
  }
  // Feed the shared git store from the SAME response the caller renders
  // (state/git.ts — the seam the git readout projection reads). One fetch,
  // one fact; a second fetch path for the headline would be a summary that
  // can drift. Malformed payloads are NOT fed: a store carrying invented
  // numbers would be fabricated data on a status readout.
  const d = data as {
    repository?: unknown; branch?: unknown; dirtyFiles?: unknown; stagedFiles?: unknown;
    untrackedFiles?: unknown; entries?: unknown;
  } | null;
  if (
    d !== null && typeof d === "object" &&
    typeof d.dirtyFiles === "number" &&
    typeof d.stagedFiles === "number" &&
    typeof d.untrackedFiles === "number" &&
    Array.isArray(d.entries)
  ) {
    setGitStatus({
      path,
      // The typed not-a-repository fact. Absent reads as TRUE — an older
      // server that predates the field still spoke only about real
      // repositories for the zeroed shape to be ambiguous about, and
      // defaulting the other way would dress every live repository up as
      // "not under version control" the day a proxy dropped the field.
      repository: d.repository === false ? false : true,
      branch: typeof d.branch === "string" ? d.branch : null,
      dirtyFiles: d.dirtyFiles,
      stagedFiles: d.stagedFiles,
      untrackedFiles: d.untrackedFiles,
      entries: d.entries as readonly GitStatusEntry[],
    });
  }
  return data;
}

// ── Public API: Editor (file read/write/edit) ──

export async function readEditorFile(path: string, root?: string): Promise<unknown> {
  const rootParam = root !== undefined ? `&root=${encodeURIComponent(root)}` : "";
  return fetchJson<unknown>(`/editor/read?path=${encodeURIComponent(path)}${rootParam}`);
}

/**
 * What is at a path, WITHOUT decoding it — size, whether the bytes are text,
 * and the declared image type when there is one.
 *
 * The editor asks this BEFORE it reads, so a binary file is never decoded as
 * UTF-8 into mojibake and a large file's size is known before the read is
 * offered. See server/routes/editor.ts.
 */
export async function probeEditorFile(path: string, root?: string): Promise<unknown> {
  const rootParam = root !== undefined ? `&root=${encodeURIComponent(root)}` : "";
  return fetchJson<unknown>(`/editor/read?what=probe&path=${encodeURIComponent(path)}${rootParam}`);
}

/** An image file's bytes as a data URL (server-side allowlist by extension). */
export async function readEditorMedia(path: string, root?: string): Promise<unknown> {
  const rootParam = root !== undefined ? `&root=${encodeURIComponent(root)}` : "";
  return fetchJson<unknown>(`/editor/read?what=media&path=${encodeURIComponent(path)}${rootParam}`);
}

export async function writeEditorFile(path: string, content: string, root?: string): Promise<unknown> {
  return fetchJson<unknown>("/editor/write", {
    method: "PUT",
    body: JSON.stringify({ path, content, root }),
  });
}

export async function editEditorFile(path: string, oldContent: string, newContent: string, root?: string): Promise<unknown> {
  return fetchJson<unknown>("/editor/edit", {
    method: "PUT",
    body: JSON.stringify({ path, oldContent, newContent, root }),
  });
}

// file-tab file/folder creation + deletion (the file tab IS a file
// manager — explicit user actions, with confirmation in the UI).

export async function createEditorFile(path: string, content: string, root?: string): Promise<{ path: string; relativePath: string; type: "file" | "directory" }> {
  return fetchJson<{ path: string; relativePath: string; type: "file" | "directory" }>("/editor/create-file", {
    method: "POST",
    body: JSON.stringify({ path, content, root }),
  });
}

export async function createEditorFolder(path: string, root?: string): Promise<{ path: string; relativePath: string; type: "file" | "directory" }> {
  return fetchJson<{ path: string; relativePath: string; type: "file" | "directory" }>("/editor/create-folder", {
    method: "POST",
    body: JSON.stringify({ path, root }),
  });
}

export async function deleteEditorFile(path: string, root?: string): Promise<{ path: string; relativePath: string; removed: boolean; wasDirectory: boolean; recycleId?: string }> {
  return fetchJson<{ path: string; relativePath: string; removed: boolean; wasDirectory: boolean; recycleId?: string }>("/editor/delete", {
    method: "DELETE",
    body: JSON.stringify({ path, root }),
  });
}

export type { RecycledFile } from "../shared/wire-types";

export async function listRecycledFiles(): Promise<readonly RecycledFile[]> {
  const data = await fetchJson<unknown>("/editor/recycle");
  if (data === null || typeof data !== "object") {
    throw new ClientError("malformed", "Expected recycle list");
  }
  const files = (data as { files?: unknown }).files;
  if (!Array.isArray(files)) {
    throw new ClientError("malformed", "Expected recycle list");
  }
  return files as RecycledFile[];
}

export async function restoreRecycledFile(id: string): Promise<{ path: string; relativePath: string; wasDirectory: boolean; recycleId: string }> {
  return fetchJson<{ path: string; relativePath: string; wasDirectory: boolean; recycleId: string }>("/editor/restore", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
}

// ── Public API: MCP (server config) ──

/**
 * The configured tool servers as the settings room serves them: the
 * registration facts (never credential values) joined with the live
 * connection state. The list is NOT stored in a client store — the settings
 * section refetches after each write so the rows always answer the server's
 * own read-back.
 */
export async function listMcpServers(): Promise<readonly McpServerView[]> {
  const data = await fetchJson<{ count?: unknown; servers?: unknown }>("/mcp/servers");
  const list = data?.servers;
  if (!Array.isArray(list)) {
    throw new ClientError("malformed", "Expected MCP server list");
  }
  return list as readonly McpServerView[];
}

/** The add/edit write: upsert one registration by id through the config
 * gate. Credential fields are write-only (blank keeps the saved one). */
export async function saveMcpServer(entry: McpServerWrite): Promise<McpServerView> {
  const data = await fetchJson<{ ok?: unknown; server?: unknown }>("/mcp/servers", {
    method: "PUT",
    body: JSON.stringify(entry),
  });
  const server = (data as { server?: unknown } | null)?.server;
  if (server === null || typeof server !== "object") {
    throw new ClientError("malformed", "Expected the saved MCP server");
  }
  return server as McpServerView;
}

/** Remove one registration (the two-press delete's real door). */
export async function deleteMcpServer(id: string): Promise<void> {
  await fetchJson<unknown>(`/mcp/servers/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** One real connect + tools/list against the saved registration — find a
 * broken address or command before a run depends on it. */
export async function testMcpServer(id: string): Promise<McpServerTestResult> {
  return fetchJson<McpServerTestResult>(`/mcp/servers/${encodeURIComponent(id)}/test`, { method: "POST" });
}


// The shapes are declared once in `shared/wire-types.ts` (the wire contract
// both sides import); this side imports them rather than restating, so the
// two cannot drift.
import type { McpServerView, McpServerTestResult, McpServerWrite } from "../shared/wire-types";
export type { McpServerView, McpServerTestResult, McpServerWrite };

// ── Public API: Extensions ──

export async function listExtensions(): Promise<unknown> {
  const data = await fetchJson<unknown>("/extensions");
  // Feed the shared extension store from the SAME response the caller
  // renders (state/extensions.ts — the seam the extensions readout
  // projection reads). Malformed payloads are not fed.
  const list = (data as { extensions?: unknown } | null)?.extensions;
  if (Array.isArray(list)) {
    setExtensions(list as readonly ExtensionView[]);
  }
  return data;
}


// ── Public API: Agent types ──

export async function listAgentTypes(): Promise<unknown> {
  return fetchJson<unknown>("/agents/types");
}

export async function listAgentProfiles(): Promise<unknown> {
  return fetchJson<unknown>("/agents/profiles");
}


// ── Public API: File tree ──

export async function getFileTree(
  path: string,
  depth?: number,
  limit?: number,
  options?: { dir?: string; withLineCount?: boolean },
): Promise<unknown> {
  const depthParam = depth !== undefined ? `&depth=${depth}` : "";
  const limitParam = limit !== undefined ? `&limit=${limit}` : "";
  const dirParam = options?.dir !== undefined ? `&dir=${encodeURIComponent(options.dir)}` : "";
  const lcParam = options?.withLineCount === true ? `&withLineCount=1` : "";
  return fetchJson<unknown>(`/filesystem/tree?path=${encodeURIComponent(path)}${depthParam}${limitParam}${dirParam}${lcParam}`);
}

// ── Public API: Config update ──

// ── Public API: Per-user system-prompt preferences (configurable from web, stored in the DB) ──

/**
 * The per-user system-prompt preferences. Mirrors the server's
 * `PromptPrefs` shape (project-context.ts) — the single contract shared by
 * the DB, the settings route, the run route, and the UI so the layers
 * cannot drift. `source` tells the UI whether the values came
 * from the per-user DB override ("user") or the config-file defaults
 * ("default").
 */
export type PromptPrefsView = Readonly<{
  readonly systemPromptOverride: string;
  readonly tone: "concise" | "detailed" | "friendly";
  readonly sentenceCase: "normal" | "title" | "upper";
  readonly emoji: boolean;
  readonly icons: boolean;
}>;

export async function getPromptPrefs(): Promise<{ prefs: PromptPrefsView; source: "user" | "default" }> {
  return fetchJson<{ prefs: PromptPrefsView; source: "user" | "default" }>("/settings/prompt-prefs");
}

export async function savePromptPrefs(prefs: PromptPrefsView): Promise<{ ok: boolean; prefs: PromptPrefsView; source: "user" }> {
  return fetchJson<{ ok: boolean; prefs: PromptPrefsView; source: "user" }>("/settings/prompt-prefs", {
    method: "PUT",
    body: JSON.stringify(prefs),
  });
}

/**
 * Delete the caller's per-user prompt-prefs override so the config-file
 * defaults re-emerge (the real "reset to defaults" — SPO). After this,
 * `getPromptPrefs` returns source "default". The SettingsPanel "Reset to
 * defaults" calls this instead of PUTting hardcoded defaults (the old path
 * wrote a row with stale literals + lied about the source).
 */
export async function deletePromptPrefs(): Promise<{ ok: boolean }> {
  return fetchJson<{ ok: boolean }>("/settings/prompt-prefs", {
    method: "DELETE",
  });
}

// ── Public API: Timeline scope ──

/**
 * Scope the timeline to a specific chat. When a chat is selected, the
 * Timeline tab shows only events for that chat's runs (filtered
 * server-side via runIds). The chatId is sent to the server so the route
 * resolves the authoritative chat→runs mapping from the projection DB.
 */
export function scopeTimelineToChat(chatName: string, runIds: readonly string[], chatId: string): void {
  setTimelineScope({
    kind: "chat",
    label: chatName,
    runIds,
    chatId,
  });
}

/**
 * Scope the timeline to a project (all events for the project's chats).
 * When no chat is selected, the Timeline tab shows all events for the
 * project, labeled with the project name. The projectId is sent to the
 * server so the route resolves all run IDs across the project's chats
 * (content matches the sidebar selection).
 */
export function scopeTimelineToProject(projectName: string, projectId: string): void {
  setTimelineScope({
    kind: "project",
    label: projectName,
    runIds: [],
    projectId,
  });
}

/**
 * Scope the timeline to ONE TRACE — a single request's causal chain, the
 * read behind the run-pane trace row's filter action. The traceId is sent
 * to the sweep.spectrum block (scope=trace) and nets the streamed window
 * by trace id; the server gates ownership (the chain must contain an event
 * of one of the caller's runs, or the band's read is a 404 absence).
 *
 * The displaced scope (whatever chat/project context the user was in) is
 * remembered so `clearTimelineTraceScope` can put it back — the way back
 * from a trace is to the context the user actually had, never a invented
 * reset to global while a chat is open.
 */
export function scopeTimelineToTrace(traceId: string): void {
  const current = timelineScope.get();
  if (current.kind !== "trace") traceScopeReturn = current;
  setTimelineScope({
    kind: "trace",
    label: "one request's trace",
    runIds: [],
    traceId,
  });
}

/**
 * Clear the trace scope, restoring the displaced context (the chat or
 * project scope that was live before the trace filter) — or global when
 * the trace was filtered from no context at all.
 */
export function clearTimelineTraceScope(): void {
  const current = timelineScope.get();
  const restore =
    current.kind === "trace" ? (traceScopeReturn ?? GLOBAL_TIMELINE_SCOPE) : current;
  traceScopeReturn = null;
  setTimelineScope(restore);
}

// The displaced context a trace filter set aside (module-local — it is
// navigation state, not a store: nothing renders it, and a page reload
// honestly reverts to the ambient chat/project scope).
let traceScopeReturn: TimelineScope | null = null;

/**
 * Reset the timeline scope to global (all events from the ledger).
 */
export function resetTimelineScope(): void {
  traceScopeReturn = null;
  setTimelineScope(GLOBAL_TIMELINE_SCOPE);
}

// ── Public API: Auth (single fetch owner) ──
//
// Auth HTTP calls live HERE, not in `state/auth.ts`. The state module is a
// pure store (atom + type + initial value); the client owns the network.
// This centralizes CSRF headers, error mapping, offline detection, and the
// loading/error UX state at the fetch choke point — no caller can bypass
// the gate by reaching into the store module. The functions write to
// `authState` directly so the registration surface stays reactive without
// touching the store (the same pattern `listProjects` uses for `setProjects`).

/**
 * Query the backend for the current auth status. Sets `offline: true` on
 * the auth store when the server is unreachable (network/timeout error) so
 * App.svelte renders a dedicated offline screen instead of a blank page
 * or a misleading login form the user can never complete.
 *
 * The only auth call that DOES NOT set `loading: true` first — it runs on
 * boot before any form is shown, and the offline branch needs to overwrite
 * the WHOLE state (not merge with a stale loading:true from a prior form
 * submit). Returns the resolved status for callers that need it.
 */
export async function checkAuthStatus(): Promise<AuthStatus> {
  try {
    const data = await fetchJson<{
      setupRequired?: boolean;
      authenticated?: boolean;
      username?: string;
      isAdmin?: boolean;
    }>("/auth/status");
    const status: AuthStatus = {
      setupRequired: data.setupRequired === true,
      authenticated: data.authenticated === true,
      username: typeof data.username === "string" ? data.username : "",
      isAdmin: data.isAdmin === true,
      loading: false,
      error: "",
      offline: false,
    };
    authState.set(status);
    return status;
  } catch {
    const offline: AuthStatus = { ...initialAuth, error: "Server unreachable", offline: true };
    authState.set(offline);
    return offline;
  }
}

/** True when a ClientError is a network/timeout failure (server unreachable). */
function isOfflineError(err: unknown): boolean {
  return (
    err instanceof ClientError && (err.code === "network" || err.code === "timeout")
  );
}

/**
 * Shared auth-form submission (register + login). Both flows are identical
 * except for the endpoint + the fallback error message, so the body lives
 * in ONE helper (No Scattered Helpers: no two near-identical functions
 * differing only by a parameter). Sets `loading: true` before the call so
 * the registration form can disable its submit button; on a network failure
 * sets `offline: true` so the user sees the offline screen. Returns true
 * on success (the auth store carries the resolved user), false on failure.
 */
async function submitAuthForm(
  endpoint: string,
  fallbackMessage: string,
  username: string,
  password: string,
): Promise<boolean> {
  authState.set({ ...authState.get(), loading: true, error: "" });
  try {
    const data = await fetchJson<{
      ok?: boolean;
      authenticated?: boolean;
      username?: string;
      isAdmin?: boolean;
    }>(endpoint, {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    authState.set({
      setupRequired: false,
      authenticated: true,
      username: typeof data.username === "string" ? data.username : username,
      isAdmin: data.isAdmin === true,
      loading: false,
      error: "",
      offline: false,
    });
    return true;
  } catch (err) {
    const msg = err instanceof ClientError ? err.message : fallbackMessage;
    authState.set({
      ...authState.get(),
      loading: false,
      error: msg,
      ...(isOfflineError(err) ? { offline: true } : {}),
    });
    return false;
  }
}

/**
 * Register a new user (the FIRST becomes the admin). Auto-logs-in on
 * success (register = setup + login combined). Returns true on success,
 * false on failure (the auth store carries the precise error message).
 */
export async function submitRegister(username: string, password: string): Promise<boolean> {
  return submitAuthForm("/auth/register", "Registration failed", username, password);
}

/**
 * Submit the login form (username + password). Returns true on success,
 * false on failure (the auth store carries the precise error message;
 * the server returns an identical error for an unknown user and a wrong
 * password to avoid username enumeration).
 */
export async function submitLogin(username: string, password: string): Promise<boolean> {
  return submitAuthForm("/auth/login", "Invalid username or password", username, password);
}

/**
 * Log out (destroy the session server-side + clear ALL client stores). A
 * logout failure is non-fatal — the local state is reset regardless so
 * the UI returns to the login gate. The server cookie is cleared by the
 * route; we never need to touch document.cookie here.
 *
 * SPO (CRITICAL security fix for -B1): before this function
 * reset ONLY `authState`, leaving every other store (projects, chats,
 * messages, run-state, metrics, memory, timeline, auto-checks, tools,
 * schema-store, quality, code-index, ui-layout, config, models, errors,
 * route) holding the previous user's data. After logout + re-login as a
 * DIFFERENT user on the same tab, the new user briefly saw the previous
 * user's projects/chats — a cross-user client-state data leak. fix:
 * (1) close any active SSE stream so it stops writing events into stores
 * we are about to reset (an in-flight run for the old user would keep
 * appending messages/tool-calls AFTER the reset, re-leaking data);
 * (2) call `resetAllStores()` — the single store-reset owner — which
 * clears EVERY store through ONE canonical path (no ad-hoc per-store
 * resets scattered in the logout handler). The auth store is reset by
 * `resetAllStores` (via `resetAuth`) — same path as every other store.
 */
export async function submitLogout(): Promise<void> {
  // Close any active SSE stream FIRST so it cannot write events into the
  // stores after resetAllStores clears them (an in-flight run would keep
  // appending messages/tool-calls/agents — re-leaking the old user's data
  // into the freshly-cleared stores). The controller is a no-op close if
  // no stream is open.
  if (activeStreamController !== null) {
    activeStreamController.close();
    activeStreamController = null;
  }
  try {
    await fetchJson<{ ok?: boolean; authenticated?: boolean }>("/auth/logout", {
      method: "POST",
    });
  } catch (err) {
    clientWarn("auth", "logout request failed:", err);
  }
  resetAllStores();
}

/** Result of a change-password attempt — discriminated by `ok`. */
export type ChangePasswordResult = Readonly<{ ok: true } | { ok: false; error: string }>;

/**
 * Change the user's password (v12). Requires the current password (identity
 * gate) + a valid session (the server checks both — defense-in-depth).
 * Returns a result object so the Settings UI can show a precise message:
 * `{ ok: true }` on success, `{ ok: false, error }` on failure. On success
 * the user stays logged in; the new password takes effect on the next
 * login.
 *
 * Client-side pre-validation (length) is a UX nicety — the server ALSO
 * validates (zod min 8) so a bypass of these checks is still rejected at
 * the trust boundary. The pre-validation does NOT touch the network.
 */
export async function submitChangePassword(
  currentPassword: string,
  newPassword: string,
): Promise<ChangePasswordResult> {
  if (typeof currentPassword !== "string" || currentPassword.length === 0) {
    return { ok: false, error: "Current password is required." };
  }
  if (typeof newPassword !== "string" || newPassword.length < 8) {
    return { ok: false, error: "New password must be at least 8 characters." };
  }
  try {
    await fetchJson<{ ok?: boolean; message?: string }>("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    return { ok: true };
  } catch (err) {
    if (isOfflineError(err)) {
      return { ok: false, error: "Server unreachable." };
    }
    const msg = err instanceof ClientError ? err.message : "Failed to change password.";
    return { ok: false, error: msg };
  }
}

// ── Public API: Per-user model/provider preferences (models in DB) ──
//
// The single client-side owner of the model-prefs write. PUT /api/models/prefs
// upserts the user's encrypted DB row (replaces any prior override). The
// SettingsPanel builds the body from its form fields + calls this. After a
// successful save, the panel re-fetches the catalog so the new provider/model
// is reflected in the model picker.

/**
 * A single provider as the server expects it on the wire.
 *
 * `apiKey` travels ONE WAY. It is sent when the user types it and it is never
 * returned by any read — the catalog carries `hasApiKey` instead. Omitting it
 * on an edit keeps the key already saved, so correcting an address does not
 * silently unset the credential.
 */
export type ModelProviderPref = Readonly<{
  readonly id: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  /**
   * The models this provider serves, each with its own stored settings.
   * Every field beside the id is optional and omitted when the model
   * declares none — "let the provider decide", never a guessed number.
   */
  readonly models: readonly Readonly<{
    readonly id: string;
    readonly contextWindow?: number;
    readonly maxTokens?: number;
    readonly temperature?: number;
  }>[];
  /**
   * Extra request headers this provider's endpoint requires. Travel one way
   * like the key: sent on save, never returned — the catalog carries
   * `headerNames` instead. Omitting on an edit keeps the saved set.
   */
  readonly headers?: Readonly<Record<string, string>>;
}>;

/** The body shape for PUT /api/models/prefs. Mirrors the server's
 *  PROVIDER_STORE_SCHEMA — the single contract (no drift). */
export type ModelPrefsInput = Readonly<{
  readonly providers: readonly ModelProviderPref[];
  readonly defaultModel?: string;
  readonly defaultProvider?: string;
}>;

/** What every provider write returns: the catalog as it now stands. */
export type ModelPrefsResult = Readonly<{ ok: boolean; prefs: ModelsCatalog }>;

/**
 * Add a provider, or edit one that exists.
 *
 * The server merges by provider name: what is sent replaces the entry with
 * that name, and providers the request does not mention are preserved.
 * Returns the whole catalog as it now stands, which is fed straight into the
 * store — so what the picker shows after a save is what the server actually
 * holds, not what this client hoped it wrote.
 */
export async function saveModelPrefs(input: ModelPrefsInput): Promise<ModelPrefsResult> {
  const result = await fetchJson<ModelPrefsResult>("/models/prefs", {
    method: "PUT",
    body: JSON.stringify(input),
  });
  setModels(result.prefs);
  return result;
}

/**
 * Remove a saved provider. The server refuses a name that is not saved
 * (`provider_unknown`) rather than reporting a no-op as success, and it
 * resets its live provider clients so a deleted key cannot outlive its
 * record. The returned catalog feeds the store, so the picker shows what
 * the server now holds.
 */
export async function deleteModelProvider(providerId: string): Promise<ModelPrefsResult> {
  const result = await fetchJson<ModelPrefsResult>(
    `/models/providers/${encodeURIComponent(providerId)}`,
    { method: "DELETE" },
  );
  setModels(result.prefs);
  return result;
}

/**
 * Prove a saved provider actually answers: a REAL request through the real
 * client to the real endpoint, so a wrong key, a wrong address and an
 * unreachable host are distinguishable BEFORE a run depends on the answer.
 * The response carries the provider's own failure text; it cannot carry the
 * key — the redaction layer learned the key when the credential was minted.
 */
export async function testModelProvider(providerId: string): Promise<ProviderTestResponse> {
  return fetchJson<ProviderTestResponse>(
    `/models/providers/${encodeURIComponent(providerId)}/test`,
    { method: "POST", body: JSON.stringify({}) },
  );
}


// The shape is declared once in `shared/wire-types.ts`; this side imports
// it rather than restating it, so the two cannot drift.
import type { ProviderDiscoveryInput, ProviderDiscoveryResult, ProviderTestResponse } from "../shared/wire-types";

export function discoverModelProvider(input: ProviderDiscoveryInput, signal?: AbortSignal): Promise<ProviderDiscoveryResult> {
  return fetchJson<ProviderDiscoveryResult>("/models/discover", { method: "POST", body: JSON.stringify(input), ...(signal === undefined ? {} : { signal }) });
}
export type { ProviderTestResponse };


// ── Public API: Safety feature testing ──
//
// The single client-side owner of the safety-trigger call. POST /api/safety/trigger
// runs a REAL backend safety module (hallucination gate, dedup/compression,
// auto-heal, bias detection) — not a mock (no fake data). Returns
// the result object so the Settings panel can render it inline.

/** The feature set the user can trigger (mirrors the server's enum —
 *  the single contract; no parallel string list). */
export type SafetyFeature = "hallucination" | "dedup" | "auto-heal" | "bias";

/** The result object returned by POST /api/safety/trigger (shape varies by
 *  feature; the server adds `feature`, `message`, and feature-specific
 *  fields — kept loose here so the renderer can show the full payload). */
export type SafetyTriggerResult = Readonly<Record<string, unknown>>;

/**
 * Trigger a safety feature on the backend (verify the safety
 * features are actually wired — REAL backend calls, not mocks). Returns
 * the result object so the Settings panel can render it inline. Throws
 * ClientError on HTTP/network failure (the caller catches and surfaces
 * the error in the panel).
 *
 * `testInput` is an optional feature-specific sample (a tool name for
 * hallucination, a sample text for bias, a file path for auto-heal).
 */
export async function triggerSafety(
  feature: SafetyFeature,
  testInput?: string,
): Promise<SafetyTriggerResult> {
  return fetchJson<SafetyTriggerResult>("/safety/trigger", {
    method: "POST",
    body: JSON.stringify(
      testInput !== undefined && testInput.length > 0 ? { feature, testInput } : { feature },
    ),
  });
}
